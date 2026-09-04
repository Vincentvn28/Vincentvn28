import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../shared/log.js';

const log = logger('runner');
const KILL_GRACE_MS = 5_000;

/**
 * Run one micro-task in a child process, streaming its output back through
 * `onOutput` so the hub sees progress while the task is still running.
 *
 * @param {any} order Work order from the hub.
 * @param {{workdir: string, onOutput?: (chunk: string) => void, signal?: AbortSignal, maxOutputBytes?: number}} opts
 * @returns {Promise<{exitCode: number, durationMs: number, output: string, error: string | null, timedOut: boolean}>}
 */
export async function runWorkOrder(order, opts) {
  const startedAt = Date.now();
  const cwd = await resolveCwd(order, opts.workdir);
  const maxOutputBytes = opts.maxOutputBytes ?? 512 * 1024;

  /** @type {string[]} */
  const collected = [];
  let collectedBytes = 0;
  let truncated = false;

  const append = (chunk) => {
    const text = chunk.toString('utf8');
    opts.onOutput?.(text);
    if (collectedBytes >= maxOutputBytes) {
      truncated = true;
      return;
    }
    collectedBytes += Buffer.byteLength(text);
    collected.push(text);
  };

  const options = {
    cwd,
    env: { ...process.env, ...order.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so a timeout or cancel kills the grandchildren too
    // (`sh -c "sleep 30"` would otherwise outlive the shell we signalled).
    detached: process.platform !== 'win32',
  };
  const child = order.shell
    ? spawn(order.command[0], { ...options, shell: true })
    : spawn(order.command[0], order.command.slice(1), options);

  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  let timedOut = false;
  let killTimer = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    append(`\n[toolforge] timeout after ${order.timeoutMs}ms — terminating\n`);
    stop(child);
    killTimer = setTimeout(() => stop(child, 'SIGKILL'), KILL_GRACE_MS);
    killTimer.unref?.();
  }, order.timeoutMs);
  timeout.unref?.();

  const onAbort = () => {
    append('\n[toolforge] cancelled by hub — terminating\n');
    stop(child);
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const result = await new Promise((resolve) => {
    child.once('error', (error) => {
      resolve({ exitCode: 127, error: error.message });
    });
    child.once('close', (code, signal) => {
      resolve({
        exitCode: code ?? (signal ? 143 : 1),
        error: signal ? `terminated by ${signal}` : null,
      });
    });
  });

  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  opts.signal?.removeEventListener('abort', onAbort);

  const output = collected.join('') + (truncated ? '\n[toolforge] output truncated\n' : '');
  const durationMs = Date.now() - startedAt;
  log.debug('task finished', { ref: order.ref, exitCode: result.exitCode, durationMs });

  return {
    exitCode: timedOut ? 124 : result.exitCode,
    durationMs,
    output,
    error: timedOut ? `timed out after ${order.timeoutMs}ms` : result.error,
    timedOut,
  };
}

/**
 * Signal the child's whole process group where the platform supports it, so no
 * grandchild is left holding the task's stdio open.
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The group is already gone, or we lost the race with a natural exit.
    try {
      child.kill(signal);
    } catch {
      // Nothing left to signal.
    }
  }
}

/**
 * Each tool gets its own directory under the agent's workdir, so tasks from
 * different tools never trample each other's files.
 * @param {any} order
 * @param {string} workdir
 * @returns {Promise<string>}
 */
async function resolveCwd(order, workdir) {
  if (order.cwd) {
    await mkdir(order.cwd, { recursive: true }).catch(() => {});
    return order.cwd;
  }
  const dir = join(workdir, order.tool.key);
  await mkdir(dir, { recursive: true });
  return dir;
}
