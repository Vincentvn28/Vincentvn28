import { optionalNumber, optionalString, requireString, stringArray } from '../../shared/validate.js';
import { unauthorized } from '../../shared/errors.js';
import { heartbeat } from '../core/registry.js';
import { claimAssignedWork, completeTask, reportProgress } from '../core/execution.js';
import { redeemEnrollCode } from '../core/enrollment.js';
import { tick } from '../core/scheduler.js';
import { machineView } from './admin.js';
import { respond } from '../router.js';

const MAX_LONG_POLL_MS = 60_000;

/**
 * Routes used by the agent installed on a rented machine.
 * @param {import('../router.js').Router} router
 */
export function registerAgentRoutes(router) {
  // The one agent route that does not need a machine token: it mints one.
  router.post('/api/agent/join', ({ state, body }) => {
    const { machine, token } = redeemEnrollCode(state, {
      code: requireString(body.code, 'code'),
      name: requireString(body.name, 'name', { max: 80 }),
      owner: optionalString(body.owner, 'owner'),
      capabilities: body.capabilities ?? {},
      tags: stringArray(body.tags, 'tags'),
      maxConcurrency: optionalNumber(body.maxConcurrency, 'maxConcurrency', {
        min: 1,
        max: 64,
        fallback: undefined,
      }) || undefined,
      pricePerMinute: body.pricePerMinute == null
        ? undefined
        : optionalNumber(body.pricePerMinute, 'pricePerMinute', { min: 0, fallback: 0 }),
      currency: optionalString(body.currency, 'currency'),
      agentVersion: optionalString(body.agentVersion, 'agentVersion'),
      workdir: optionalString(body.workdir, 'workdir'),
    });
    return respond(201, { machineId: machine.id, name: machine.name, token });
  });

  router.post('/api/agent/heartbeat', ({ state, machine, body }) => {
    requireMachine(machine);
    const updated = heartbeat(state, machine, {
      status: body.status,
      capabilities: body.capabilities,
      agentVersion: body.agentVersion,
      maxConcurrency: body.maxConcurrency,
    });
    return {
      machine: machineView(state, updated),
      config: {
        heartbeatIntervalMs: Math.floor(state.config.heartbeatTimeoutMs / 3),
        maxLongPollMs: MAX_LONG_POLL_MS,
      },
    };
  });

  /**
   * Long-polled work pickup. The agent asks for work and the hub holds the
   * request open until the scheduler assigns it something (or the poll times
   * out), which keeps latency low without a websocket.
   */
  router.post('/api/agent/work', async (ctx) => {
    const { state, machine, body, res } = ctx;
    requireMachine(machine);
    heartbeat(state, machine, { capabilities: body.capabilities, status: body.status });

    const limit = optionalNumber(body.limit, 'limit', { min: 1, max: 64, fallback: 1 });
    const waitMs = Math.min(
      optionalNumber(body.waitMs, 'waitMs', { min: 0, max: MAX_LONG_POLL_MS, fallback: 0 }),
      MAX_LONG_POLL_MS,
    );

    tick(state);
    let work = claimAssignedWork(state, machine, limit);
    if (work.length > 0 || waitMs === 0) return { tasks: work };

    work = await waitForWork(ctx, machine, limit, waitMs);
    return { tasks: work };
  });

  router.post('/api/agent/progress', async ({ state, machine, body }) => {
    requireMachine(machine);
    return reportProgress(state, machine, {
      taskId: requireString(body.taskId, 'taskId'),
      leaseId: requireString(body.leaseId, 'leaseId'),
      logChunk: optionalString(body.logChunk, 'logChunk'),
      progress: body.progress == null ? undefined : Number(body.progress),
    });
  });

  router.post('/api/agent/complete', async ({ state, machine, body }) => {
    requireMachine(machine);
    const task = await completeTask(state, machine, {
      taskId: requireString(body.taskId, 'taskId'),
      leaseId: requireString(body.leaseId, 'leaseId'),
      exitCode: optionalNumber(body.exitCode, 'exitCode', { fallback: 1 }),
      durationMs: optionalNumber(body.durationMs, 'durationMs', { min: 0, fallback: 0 }),
      logTail: optionalString(body.logTail, 'logTail'),
      error: optionalString(body.error, 'error'),
    });
    tick(state);
    return { taskId: task.id, status: task.status, attempt: task.attempt };
  });

  // Graceful shutdown: stop taking new work, let running tasks finish.
  router.post('/api/agent/leaving', ({ state, machine, body }) => {
    requireMachine(machine);
    const status = body.drain === false ? 'offline' : 'draining';
    const updated = state.machines.update(machine.id, (doc) => {
      if (doc.status !== 'disabled') doc.status = status;
    });
    state.events.emit(`machine.${status}`, { machineId: machine.id, name: machine.name });
    return machineView(state, updated);
  });
}

/**
 * @param {any} ctx
 * @param {any} machine
 * @param {number} limit
 * @param {number} waitMs
 * @returns {Promise<any[]>}
 */
function waitForWork(ctx, machine, limit, waitMs) {
  const { state, req } = ctx;
  return new Promise((resolve) => {
    let settled = false;

    const finish = (work) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      req.off('close', onClose);
      resolve(work);
    };

    // Claiming moves tasks to `running`, so it must never happen once this poll
    // has settled — whatever it claimed would have nobody to run it.
    const claim = () => {
      if (settled) return;
      finish(claimAssignedWork(state, machine, limit));
    };

    const timer = setTimeout(claim, waitMs);
    const unsubscribe = state.events.subscribe((event) => {
      if (event.type !== 'task.assigned' || event.data.machineId !== machine.id) return;
      // One scheduler pass can assign several tasks; let them all land first so
      // a single claim picks up the whole batch.
      queueMicrotask(claim);
    });
    const onClose = () => finish([]);
    req.once('close', onClose);
  });
}

function requireMachine(machine) {
  if (!machine) throw unauthorized('This endpoint requires a machine token');
}
