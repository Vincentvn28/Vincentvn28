import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient } from '../shared/http-client.js';
import { logger } from '../shared/log.js';
import { sleep } from '../shared/time.js';
import { detectCapabilities } from './capabilities.js';
import { runWorkOrder } from './runner.js';

const log = logger('agent');

/** @returns {Promise<string>} The agent's own version, for the hub's records. */
async function agentVersion() {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return JSON.parse(await readFile(pkgPath, 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

/**
 * The worker that turns a personal computer into rentable build capacity:
 * it heartbeats, long-polls the hub for micro-tasks, runs them, and streams
 * output back.
 */
export class Agent {
  /** @param {any} config */
  constructor(config) {
    this.config = config;
    this.client = new HttpClient({ baseUrl: config.hubUrl, token: config.token, timeoutMs: 70_000 });
    /** @type {Map<string, {controller: AbortController, order: any}>} */
    this.running = new Map();
    this.stopping = false;
    this.capabilities = null;
    /** @type {AbortController} */
    this.lifecycle = new AbortController();
  }

  /** @returns {number} Free execution slots on this machine. */
  get freeSlots() {
    return Math.max(0, this.config.maxConcurrency - this.running.size);
  }

  /** Run until {@link stop} is called. @returns {Promise<void>} */
  async start() {
    this.capabilities = await detectCapabilities();
    this.version = await agentVersion();

    const hello = await this.client.post('/api/agent/heartbeat', this.heartbeatPayload());
    log.info('connected to hub', {
      hub: this.config.hubUrl,
      machine: hello.machine.name,
      machineId: hello.machine.id,
      slots: this.config.maxConcurrency,
    });

    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((error) => log.warn('heartbeat failed', { error: error.message }));
    }, this.config.heartbeatIntervalMs);

    await this.pollLoop();
  }

  heartbeatPayload() {
    return {
      capabilities: this.capabilities,
      agentVersion: this.version,
      maxConcurrency: this.config.maxConcurrency,
      status: this.stopping ? 'draining' : 'online',
    };
  }

  async heartbeat() {
    await this.client.post('/api/agent/heartbeat', this.heartbeatPayload(), { retries: 1 });
  }

  /** Ask the hub for work forever, running whatever it hands back. */
  async pollLoop() {
    while (!this.stopping) {
      if (this.freeSlots === 0) {
        await sleep(500, this.lifecycle.signal);
        continue;
      }
      try {
        const response = await this.client.post(
          '/api/agent/work',
          {
            limit: this.freeSlots,
            waitMs: this.config.pollWaitMs,
            capabilities: this.capabilities,
          },
          { retries: 0, timeoutMs: this.config.pollWaitMs + 15_000, signal: this.lifecycle.signal },
        );
        for (const order of response.tasks ?? []) {
          // Deliberately not awaited: tasks run concurrently up to maxConcurrency.
          void this.execute(order);
        }
      } catch (error) {
        if (this.stopping) break;
        log.warn('work poll failed', { error: error.message });
        await sleep(2_000, this.lifecycle.signal);
      }
    }
  }

  /**
   * @param {any} order
   * @returns {Promise<void>}
   */
  async execute(order) {
    const controller = new AbortController();
    this.running.set(order.taskId, { controller, order });
    log.info('task started', { ref: order.ref, task: order.taskId, attempt: order.attempt });

    /** @type {string[]} */
    let buffer = [];
    const flush = async () => {
      if (buffer.length === 0) return;
      const chunk = buffer.join('');
      buffer = [];
      try {
        await this.client.post(
          '/api/agent/progress',
          { taskId: order.taskId, leaseId: order.leaseId, logChunk: chunk },
          { retries: 0 },
        );
      } catch (error) {
        // A rescheduled task reports 409; stop working on it rather than racing
        // the machine that now owns it.
        if (error.status === 409 || error.status === 403) {
          log.warn('lease lost, abandoning task', { ref: order.ref, reason: error.message });
          controller.abort();
        }
      }
    };
    const flushTimer = setInterval(() => void flush(), this.config.logFlushMs);

    try {
      const result = await runWorkOrder(order, {
        workdir: this.config.workdir,
        signal: controller.signal,
        onOutput: (chunk) => buffer.push(chunk),
      });
      clearInterval(flushTimer);
      await flush();

      await this.client.post('/api/agent/complete', {
        taskId: order.taskId,
        leaseId: order.leaseId,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logTail: result.output.slice(-16_000),
        error: result.error,
      });
      log.info(result.exitCode === 0 ? 'task succeeded' : 'task failed', {
        ref: order.ref,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
    } catch (error) {
      clearInterval(flushTimer);
      log.error('task run failed', { ref: order.ref, error: error.message });
      // Best effort: if this fails too, the hub's lease reaper reschedules it.
      await this.client
        .post('/api/agent/complete', {
          taskId: order.taskId,
          leaseId: order.leaseId,
          exitCode: 1,
          error: error.message,
        })
        .catch(() => {});
    } finally {
      this.running.delete(order.taskId);
    }
  }

  /**
   * Drain: stop taking work, let in-flight tasks finish, then say goodbye.
   * @param {{waitMs?: number}} [opts]
   * @returns {Promise<void>}
   */
  async stop(opts = {}) {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.heartbeatTimer);
    this.lifecycle.abort();

    await this.client.post('/api/agent/leaving', { drain: true }, { retries: 1 }).catch(() => {});

    const deadline = Date.now() + (opts.waitMs ?? 30_000);
    while (this.running.size > 0 && Date.now() < deadline) {
      log.info('waiting for tasks to finish', { running: this.running.size });
      await sleep(1_000);
    }
    for (const { controller } of this.running.values()) controller.abort();
    await this.client.post('/api/agent/leaving', { drain: false }, { retries: 1 }).catch(() => {});
    log.info('agent stopped');
  }
}

/**
 * Start an agent and wire it to SIGINT/SIGTERM so a rented machine leaves the
 * pool cleanly instead of stranding its tasks until the lease expires.
 * @param {any} config
 * @returns {Promise<Agent>}
 */
export async function runAgent(config) {
  const agent = new Agent(config);
  const shutdown = () => {
    agent.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await agent.start();
  return agent;
}
