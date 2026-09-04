import { notFound } from '../../shared/errors.js';
import { now } from '../../shared/time.js';
import {
  oneOf,
  optionalNumber,
  optionalString,
  requireString,
  stringArray,
} from '../../shared/validate.js';
import { MACHINE_STATUS, progressOf } from '../core/model.js';
import {
  activeTasksFor,
  freeSlots,
  registerMachine,
  reliabilityOf,
  rotateMachineToken,
} from '../core/registry.js';
import { applyToolSpec, describeTool, refreshTool } from '../core/planner.js';
import { candidatesFor, explain, tick } from '../core/scheduler.js';
import { cancelTask, cancelTasksForTool, readTaskLog, retryTask } from '../core/execution.js';
import { createEnrollCode, revokeEnrollCode } from '../core/enrollment.js';
import { respond } from '../router.js';

/**
 * Register every operator-facing route.
 * @param {import('../router.js').Router} router
 */
export function registerAdminRoutes(router) {
  router.get('/api/overview', ({ state }) => overview(state));

  // ---- machines -----------------------------------------------------------
  router.get('/api/machines', ({ state }) =>
    state.machines.list().map((machine) => machineView(state, machine)),
  );

  router.post('/api/machines', ({ state, body }) => {
    const { machine, token } = registerMachine(state, {
      name: requireString(body.name, 'name', { max: 80 }),
      owner: optionalString(body.owner, 'owner') ?? 'operator',
      tags: stringArray(body.tags, 'tags'),
      maxConcurrency: optionalNumber(body.maxConcurrency, 'maxConcurrency', {
        min: 1,
        max: 64,
        fallback: 2,
      }),
      workdir: optionalString(body.workdir, 'workdir') ?? null,
      rental: {
        pricePerMinute: optionalNumber(body.pricePerMinute, 'pricePerMinute', {
          min: 0,
          fallback: 0,
        }),
        currency: optionalString(body.currency, 'currency') ?? 'USD',
        note: optionalString(body.note, 'note') ?? null,
      },
    });
    // The token is shown exactly once; only its hash is kept.
    return respond(201, { machine: machineView(state, machine), token });
  });

  router.get('/api/machines/:id', ({ state, params }) =>
    machineView(state, state.machines.require(params.id), { detailed: true }),
  );

  router.patch('/api/machines/:id', ({ state, params, body }) => {
    const machine = state.machines.require(params.id);
    // Validate everything first: a rejected field must not leave the machine
    // half-updated.
    const patch = {};
    if (body.tags != null) patch.tags = stringArray(body.tags, 'tags');
    if (body.name != null) patch.name = requireString(body.name, 'name', { max: 80 });
    if (body.owner != null) patch.owner = requireString(body.owner, 'owner');
    if (body.maxConcurrency != null) {
      patch.maxConcurrency = optionalNumber(body.maxConcurrency, 'maxConcurrency', {
        min: 1,
        max: 64,
        fallback: machine.maxConcurrency,
      });
    }
    if (body.pricePerMinute != null) {
      patch.pricePerMinute = optionalNumber(body.pricePerMinute, 'pricePerMinute', {
        min: 0,
        fallback: 0,
      });
    }
    if (body.currency != null) patch.currency = requireString(body.currency, 'currency');
    if (body.status != null) patch.status = oneOf(body.status, 'status', MACHINE_STATUS, machine.status);

    const updated = state.machines.update(machine.id, (doc) => {
      if (patch.tags) doc.tags = patch.tags;
      if (patch.name) doc.name = patch.name;
      if (patch.owner) doc.owner = patch.owner;
      if (patch.maxConcurrency != null) doc.maxConcurrency = patch.maxConcurrency;
      if (patch.pricePerMinute != null) doc.rental.pricePerMinute = patch.pricePerMinute;
      if (patch.currency) doc.rental.currency = patch.currency;
      if (patch.status) doc.status = patch.status;
    });
    state.events.emit('machine.updated', { machineId: machine.id, name: updated.name });
    return machineView(state, updated, { detailed: true });
  });

  router.post('/api/machines/:id/token', ({ state, params }) => {
    state.machines.require(params.id);
    return { token: rotateMachineToken(state, params.id) };
  });

  router.delete('/api/machines/:id', ({ state, params }) => {
    const machine = state.machines.require(params.id);
    // Release the leases first, so in-flight work moves to another machine
    // instead of disappearing with this one.
    const running = activeTasksFor(state, machine.id);
    for (const task of running) {
      state.tasks.update(task.id, (doc) => {
        doc.status = 'ready';
        doc.assignment = null;
        doc.history.push({ at: now(), event: 'requeued', machineId: machine.id, reason: 'machine removed' });
      });
    }
    state.machines.remove(machine.id);
    state.events.emit('machine.removed', { machineId: machine.id, name: machine.name });
    return { removed: true, releasedTasks: running.length };
  });

  // ---- enrollment codes ---------------------------------------------------
  router.get('/api/enroll-codes', ({ state }) => state.enrollCodes.list());

  router.post('/api/enroll-codes', ({ state, body }) =>
    respond(
      201,
      createEnrollCode(state, {
        label: optionalString(body.label, 'label'),
        maxUses: optionalNumber(body.maxUses, 'maxUses', { min: 0, fallback: 0 }),
        ttlMs: optionalNumber(body.ttlMs, 'ttlMs', { min: 0, fallback: 0 }) || undefined,
        tags: stringArray(body.tags, 'tags'),
        maxConcurrency: optionalNumber(body.maxConcurrency, 'maxConcurrency', {
          min: 1,
          max: 64,
          fallback: 2,
        }),
        pricePerMinute: optionalNumber(body.pricePerMinute, 'pricePerMinute', {
          min: 0,
          fallback: 0,
        }),
        currency: optionalString(body.currency, 'currency'),
      }),
    ),
  );

  router.delete('/api/enroll-codes/:id', ({ state, params }) => {
    state.enrollCodes.require(params.id);
    return revokeEnrollCode(state, params.id);
  });

  // ---- tools --------------------------------------------------------------
  router.get('/api/tools', ({ state }) =>
    state.tools.list().map((tool) => toolSummary(state, tool)),
  );

  router.post('/api/tools', ({ state, body, query }) => {
    const result = applyToolSpec(state, body, { force: query.force === 'true' });
    tick(state);
    return respond(result.created ? 201 : 200, {
      ...result,
      tool: describeTool(state, result.tool.id),
    });
  });

  router.get('/api/tools/:id', ({ state, params }) =>
    describeTool(state, resolveToolId(state, params.id)),
  );

  router.patch('/api/tools/:id', ({ state, params, body }) => {
    const id = resolveToolId(state, params.id);
    state.tools.update(id, (doc) => {
      if (body.name != null) doc.name = requireString(body.name, 'name');
      if (body.description != null) doc.description = String(body.description);
      if (body.concurrency != null) {
        doc.concurrency = optionalNumber(body.concurrency, 'concurrency', {
          min: 1,
          max: 512,
          fallback: doc.concurrency,
        });
      }
      if (body.mode != null) {
        doc.dispatch.mode = oneOf(body.mode, 'mode', ['pinned', 'auto', 'hybrid'], doc.dispatch.mode);
      }
      if (body.machines != null) doc.dispatch.machineIds = stringArray(body.machines, 'machines');
      if (body.failoverToPool != null) doc.dispatch.failoverToPool = Boolean(body.failoverToPool);
      doc.updatedAt = now();
    });
    state.events.emit('tool.updated', { toolId: id });
    tick(state);
    return describeTool(state, id);
  });

  for (const [action, status] of [
    ['start', 'running'],
    ['pause', 'paused'],
    ['resume', 'running'],
    ['cancel', 'cancelled'],
  ]) {
    router.post(`/api/tools/:id/${action}`, ({ state, params }) => {
      const id = resolveToolId(state, params.id);
      state.tools.update(id, (doc) => {
        doc.status = status;
        doc.updatedAt = now();
        if (status === 'running' && !doc.startedAt) doc.startedAt = now();
      });
      if (status === 'cancelled') cancelTasksForTool(state, id, 'tool cancelled');
      state.events.emit(`tool.${action}ed`, { toolId: id });
      refreshTool(state, id);
      tick(state);
      return describeTool(state, id);
    });
  }

  router.post('/api/tools/:id/retry-failed', ({ state, params, body }) => {
    const id = resolveToolId(state, params.id);
    const failed = state.tasks.list(
      (task) => task.toolId === id && (task.status === 'failed' || task.status === 'blocked'),
    );
    for (const task of failed) retryTask(state, task.id, { resetAttempts: body.resetAttempts !== false });
    state.tools.update(id, (doc) => {
      if (doc.status === 'failed') doc.status = 'running';
      doc.finishedAt = null;
    });
    refreshTool(state, id);
    tick(state);
    return { retried: failed.length, tool: describeTool(state, id) };
  });

  router.delete('/api/tools/:id', ({ state, params }) => {
    const id = resolveToolId(state, params.id);
    for (const task of state.tasks.list((task) => task.toolId === id)) state.tasks.remove(task.id);
    for (const team of state.teams.list((team) => team.toolId === id)) state.teams.remove(team.id);
    state.tools.remove(id);
    state.events.emit('tool.removed', { toolId: id });
    return { removed: true };
  });

  // ---- tasks --------------------------------------------------------------
  router.get('/api/tasks', ({ state, query }) => {
    let tasks = state.tasks.list();
    if (query.tool) {
      const toolId = resolveToolId(state, query.tool);
      tasks = tasks.filter((task) => task.toolId === toolId);
    }
    if (query.status) tasks = tasks.filter((task) => task.status === query.status);
    if (query.machine) {
      tasks = tasks.filter((task) => task.assignment?.machineId === query.machine);
    }
    return tasks.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  });

  router.get('/api/tasks/:id', ({ state, params }) => state.tasks.require(params.id));

  router.get('/api/tasks/:id/why', ({ state, params }) =>
    explain(state, state.tasks.require(params.id)),
  );

  router.get('/api/tasks/:id/log', async ({ state, params, query }) => ({
    taskId: params.id,
    attempt: query.attempt ? Number(query.attempt) : undefined,
    log: await readTaskLog(state, params.id, query.attempt ? Number(query.attempt) : undefined),
  }));

  router.post('/api/tasks/:id/retry', ({ state, params, body }) => {
    const task = retryTask(state, params.id, { resetAttempts: body.resetAttempts !== false });
    tick(state);
    return task;
  });

  router.post('/api/tasks/:id/cancel', ({ state, params, body }) =>
    cancelTask(state, params.id, optionalString(body.reason, 'reason')),
  );

  router.get('/api/tasks/:id/candidates', ({ state, params }) => {
    const task = state.tasks.require(params.id);
    const { mode, eligible, rejected } = candidatesFor(state, task);
    return {
      mode,
      eligible: eligible.map((entry) => ({
        machineId: entry.machine.id,
        name: entry.machine.name,
        pool: entry.pool,
        score: entry.score,
      })),
      rejected,
    };
  });

  // ---- rental ledger ------------------------------------------------------
  router.get('/api/usage', ({ state, query }) => {
    let records = state.usage.list();
    if (query.machine) records = records.filter((entry) => entry.machineId === query.machine);
    if (query.tool) {
      const toolId = resolveToolId(state, query.tool);
      records = records.filter((entry) => entry.toolId === toolId);
    }
    const totals = records.reduce(
      (acc, entry) => {
        acc.durationMs += entry.durationMs;
        acc.amount = Number((acc.amount + entry.amount).toFixed(6));
        return acc;
      },
      { durationMs: 0, amount: 0 },
    );
    return { totals, records: records.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) };
  });

  router.post('/api/scheduler/tick', ({ state }) => tick(state));
}

/**
 * Accept either a tool id or its human key wherever `:id` appears.
 * @param {any} state
 * @param {string} idOrKey
 * @returns {string}
 */
export function resolveToolId(state, idOrKey) {
  if (state.tools.get(idOrKey)) return idOrKey;
  const byKey = state.tools.find((tool) => tool.key === idOrKey);
  if (!byKey) throw notFound('tool', idOrKey);
  return byKey.id;
}

/**
 * @param {any} state
 * @param {any} machine
 * @param {{detailed?: boolean}} [opts]
 * @returns {any}
 */
export function machineView(state, machine, opts = {}) {
  const active = activeTasksFor(state, machine.id);
  const { tokenHash, ...safe } = machine;
  const view = {
    ...safe,
    freeSlots: freeSlots(state, machine),
    activeTasks: active.length,
    reliability: Number(reliabilityOf(machine).toFixed(3)),
  };
  if (opts.detailed) {
    view.running = active.map((task) => ({
      taskId: task.id,
      ref: task.ref,
      toolId: task.toolId,
      status: task.status,
      startedAt: task.startedAt,
    }));
  }
  return view;
}

/**
 * @param {any} state
 * @param {any} tool
 * @returns {any}
 */
export function toolSummary(state, tool) {
  const tasks = state.tasks.list((task) => task.toolId === tool.id);
  return {
    ...tool,
    teamCount: state.teams.count((team) => team.toolId === tool.id),
    progress: progressOf(tasks),
  };
}

/**
 * @param {any} state
 * @returns {any}
 */
export function overview(state) {
  const machines = state.machines.list();
  const tasks = state.tasks.list();
  const online = machines.filter((machine) => machine.status === 'online');
  return {
    at: now(),
    machines: {
      total: machines.length,
      online: online.length,
      draining: machines.filter((machine) => machine.status === 'draining').length,
      offline: machines.filter((machine) => machine.status === 'offline').length,
      capacity: online.reduce((sum, machine) => sum + machine.maxConcurrency, 0),
      freeSlots: online.reduce((sum, machine) => sum + freeSlots(state, machine), 0),
    },
    tools: {
      total: state.tools.count(),
      running: state.tools.count((tool) => tool.status === 'running'),
      succeeded: state.tools.count((tool) => tool.status === 'succeeded'),
      failed: state.tools.count((tool) => tool.status === 'failed'),
    },
    teams: { total: state.teams.count() },
    tasks: progressOf(tasks),
    earnings: machines.reduce((sum, machine) => sum + machine.stats.earnings, 0),
  };
}
