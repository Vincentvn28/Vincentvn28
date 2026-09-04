import { newId } from '../../shared/ids.js';
import { fromNow, isPast, now } from '../../shared/time.js';
import { logger } from '../../shared/log.js';
import { ACTIVE_TASK_STATUS, resolveDispatch } from './model.js';
import {
  acceptsWork,
  freeSlots,
  meetsRequirements,
  recordOutcome,
  reliabilityOf,
  sweepStaleMachines,
} from './registry.js';
import { refreshTool } from './planner.js';

const log = logger('scheduler');

/** Relative weights used to rank machines in the shared pool. */
const WEIGHTS = {
  reliability: 0.5,
  capacity: 0.25,
  speed: 0.15,
  price: 0.1,
};

/**
 * Which machines may run this task, best first, plus a human-readable reason
 * for every machine that was excluded. The reasons are what `toolforge task why`
 * prints, so routing is never a black box.
 *
 * @param {any} state
 * @param {any} task
 * @returns {{mode: string, pinned: string[], eligible: any[], rejected: {machineId: string, name: string, reason: string}[]}}
 */
export function candidatesFor(state, task) {
  const tool = state.tools.require(task.toolId);
  const team = state.teams.get(task.teamId);
  const dispatch = resolveDispatch(tool, team, task);
  const rejected = [];

  const consider = (machines, poolLabel) => {
    const eligible = [];
    for (const machine of machines) {
      const verdict = screen(state, machine, dispatch.requires);
      if (!verdict.ok) {
        rejected.push({ machineId: machine.id, name: machine.name, reason: verdict.reason });
        continue;
      }
      eligible.push({ machine, score: scoreMachine(state, machine, task), pool: poolLabel });
    }
    return eligible.sort((a, b) => b.score - a.score);
  };

  const pinnedIds = dispatch.machineIds ?? [];
  const pinnedMachines = pinnedIds
    .map((id) => state.machines.get(id))
    .filter((machine) => {
      if (machine) return true;
      rejected.push({ machineId: '?', name: '?', reason: 'pinned machine no longer registered' });
      return false;
    });

  if (dispatch.mode === 'pinned') {
    return { mode: 'pinned', pinned: pinnedIds, eligible: consider(pinnedMachines, 'pinned'), rejected };
  }

  if (dispatch.mode === 'hybrid' && pinnedMachines.length > 0) {
    const pinnedEligible = consider(pinnedMachines, 'pinned');
    if (pinnedEligible.length > 0) {
      return { mode: 'hybrid', pinned: pinnedIds, eligible: pinnedEligible, rejected };
    }
    if (!dispatch.failoverToPool) {
      return { mode: 'hybrid', pinned: pinnedIds, eligible: [], rejected };
    }
    // Every pinned machine is gone or busy — spill into the shared pool.
  }

  // In `auto` every registered machine is fair game. In a `hybrid` fallback the
  // pinned machines were just tried and rejected, so skip them here.
  const pool =
    dispatch.mode === 'auto'
      ? state.machines.list()
      : state.machines.list((machine) => !pinnedIds.includes(machine.id));
  return { mode: dispatch.mode, pinned: pinnedIds, eligible: consider(pool, 'pool'), rejected };
}

/**
 * @param {any} state
 * @param {any} machine
 * @param {any} requires
 * @returns {{ok: boolean, reason?: string}}
 */
function screen(state, machine, requires) {
  if (!acceptsWork(machine)) return { ok: false, reason: `machine is ${machine.status}` };
  if (freeSlots(state, machine) <= 0) return { ok: false, reason: 'no free slots' };
  return meetsRequirements(machine, requires);
}

/**
 * @param {any} state
 * @param {any} machine
 * @param {any} task
 * @returns {number} Higher is better.
 */
export function scoreMachine(state, machine, task) {
  const capacity = machine.maxConcurrency > 0
    ? freeSlots(state, machine) / machine.maxConcurrency
    : 0;
  const average = machine.stats.avgDurationMs || 0;
  // Machines with no history sit mid-pack rather than winning or losing outright.
  const speed = average === 0 ? 0.5 : 1 / (1 + average / 60_000);
  const price = machine.rental.pricePerMinute > 0
    ? 1 / (1 + machine.rental.pricePerMinute)
    : 1;

  let score =
    WEIGHTS.reliability * reliabilityOf(machine) +
    WEIGHTS.capacity * capacity +
    WEIGHTS.speed * speed +
    WEIGHTS.price * price;

  // A machine that already dropped this task goes to the back of the line, but
  // stays usable — otherwise a two-machine pool could deadlock after one blip.
  if (task?.avoidMachineIds?.includes(machine.id)) score -= 1;
  return Number(score.toFixed(6));
}

/**
 * @param {any} state
 * @param {any} task
 * @returns {number} Remaining concurrency headroom for the task's tool and team.
 */
function headroom(state, task) {
  const tool = state.tools.require(task.toolId);
  const team = state.teams.get(task.teamId);
  const active = state.tasks.list(
    (candidate) => ACTIVE_TASK_STATUS.has(candidate.status) && candidate.toolId === task.toolId,
  );
  const toolRoom = tool.concurrency - active.length;
  const teamRoom = team
    ? team.concurrency - active.filter((candidate) => candidate.teamId === task.teamId).length
    : Infinity;
  return Math.min(toolRoom, teamRoom);
}

/**
 * Lease a task to a machine.
 * @param {any} state
 * @param {any} task
 * @param {any} machine
 * @returns {any} The updated task.
 */
export function assign(state, task, machine) {
  const leaseId = newId('lse', 8);
  const updated = state.tasks.update(task.id, (doc) => {
    doc.status = 'assigned';
    doc.attempt += 1;
    doc.assignment = {
      machineId: machine.id,
      machineName: machine.name,
      leaseId,
      assignedAt: now(),
      // The lease outlives the task timeout by a grace period so a slow-but-alive
      // agent is not stripped of work it is still doing.
      expiresAt: fromNow(doc.timeoutMs + state.config.leaseGraceMs),
    };
    doc.updatedAt = now();
    doc.history.push({ at: now(), event: 'assigned', machineId: machine.id, attempt: doc.attempt });
  });
  state.events.emit('task.assigned', {
    taskId: task.id,
    ref: task.ref,
    toolId: task.toolId,
    machineId: machine.id,
    machineName: machine.name,
    attempt: updated.attempt,
  });
  return updated;
}

/**
 * Hand a task back to the queue after a machine failed, dropped or timed out on
 * it — the mechanism behind "if a machine drops, switch to another one".
 * @param {any} state
 * @param {any} task
 * @param {{reason: string, machineId?: string, countAttempt?: boolean}} opts
 * @returns {any} The updated task.
 */
export function requeue(state, task, opts) {
  const machineId = opts.machineId ?? task.assignment?.machineId ?? null;
  const startedAt = task.startedAt ? Date.parse(task.startedAt) : null;

  if (machineId) {
    recordOutcome(state, machineId, {
      outcome: 'abandoned',
      durationMs: startedAt ? Date.now() - startedAt : 0,
      taskId: task.id,
      toolId: task.toolId,
    });
  }

  const exhausted = task.attempt >= task.maxAttempts;
  const updated = state.tasks.update(task.id, (doc) => {
    if (machineId && !doc.avoidMachineIds.includes(machineId)) doc.avoidMachineIds.push(machineId);
    doc.assignment = null;
    doc.startedAt = null;
    doc.updatedAt = now();
    doc.history.push({ at: now(), event: 'requeued', machineId, reason: opts.reason });
    if (exhausted) {
      doc.status = 'failed';
      doc.finishedAt = now();
      doc.result = { reason: opts.reason, exhausted: true, attempts: doc.attempt };
    } else {
      doc.status = 'ready';
    }
  });

  state.events.emit(exhausted ? 'task.failed' : 'task.rescheduled', {
    taskId: task.id,
    ref: task.ref,
    toolId: task.toolId,
    machineId,
    reason: opts.reason,
    attempt: updated.attempt,
    maxAttempts: updated.maxAttempts,
  });
  refreshTool(state, task.toolId);
  return updated;
}

/**
 * Release leases whose machine went offline or whose deadline passed.
 * @param {any} state
 * @returns {number} How many tasks were released.
 */
export function reapLeases(state) {
  let released = 0;
  for (const task of state.tasks.list((doc) => ACTIVE_TASK_STATUS.has(doc.status))) {
    const assignment = task.assignment;
    if (!assignment) {
      requeue(state, task, { reason: 'lost assignment' });
      released++;
      continue;
    }
    const machine = state.machines.get(assignment.machineId);
    if (!machine) {
      requeue(state, task, { reason: 'machine removed', machineId: assignment.machineId });
      released++;
      continue;
    }
    if (machine.status === 'offline' || machine.status === 'disabled') {
      requeue(state, task, {
        reason: `machine went ${machine.status}`,
        machineId: machine.id,
      });
      released++;
      continue;
    }
    if (isPast(assignment.expiresAt)) {
      requeue(state, task, { reason: 'lease expired', machineId: machine.id });
      released++;
    }
  }
  return released;
}

/**
 * One scheduling pass: drop stale machines, release their work, then fill every
 * free slot with the highest-priority runnable task.
 * @param {any} state
 * @returns {{offlined: number, released: number, assigned: number}}
 */
export function tick(state) {
  const offlined = sweepStaleMachines(state).length;
  const released = reapLeases(state);

  for (const tool of state.tools.list((doc) => doc.status === 'running' || doc.status === 'draft')) {
    refreshTool(state, tool.id);
  }

  const ready = state.tasks
    .list((task) => task.status === 'ready')
    .filter((task) => {
      const tool = state.tools.get(task.toolId);
      return tool && tool.status !== 'paused' && tool.status !== 'cancelled';
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.attempt - b.attempt ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );

  let assigned = 0;
  for (const task of ready) {
    if (headroom(state, task) <= 0) continue;
    const { eligible } = candidatesFor(state, task);
    const best = eligible[0];
    if (!best) continue;
    assign(state, task, best.machine);
    assigned++;
  }

  if (offlined || released || assigned) {
    log.debug('tick', { offlined, released, assigned });
  }
  return { offlined, released, assigned };
}

/**
 * Explain why a task is or is not running right now.
 * @param {any} state
 * @param {any} task
 * @returns {any}
 */
export function explain(state, task) {
  const tool = state.tools.require(task.toolId);
  const team = state.teams.get(task.teamId);
  const dispatch = resolveDispatch(tool, team, task);
  const blockers = [];

  if (task.status === 'pending') {
    const unmet = task.dependsOn
      .map((id) => state.tasks.get(id))
      .filter((dep) => dep && dep.status !== 'succeeded')
      .map((dep) => `${dep.ref} is ${dep.status}`);
    blockers.push(...unmet);
  }
  if (tool.status === 'paused') blockers.push('tool is paused');
  if (task.status === 'ready' && headroom(state, task) <= 0) {
    blockers.push('tool or team concurrency limit reached');
  }

  const { eligible, rejected } = candidatesFor(state, task);
  if (task.status === 'ready' && eligible.length === 0) {
    blockers.push(
      dispatch.mode === 'pinned'
        ? 'no pinned machine is available (mode "pinned" never falls back to the pool)'
        : 'no machine in the pool satisfies this task',
    );
  }

  return {
    taskId: task.id,
    ref: task.ref,
    status: task.status,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    dispatch,
    runnable: blockers.length === 0,
    blockers,
    candidates: eligible.map((entry) => ({
      machineId: entry.machine.id,
      name: entry.machine.name,
      pool: entry.pool,
      score: entry.score,
      freeSlots: freeSlots(state, entry.machine),
    })),
    rejected,
  };
}

/**
 * Start the periodic scheduler loop.
 * @param {any} state
 * @returns {{stop: () => void}}
 */
export function startScheduler(state) {
  const timer = setInterval(() => {
    try {
      tick(state);
    } catch (error) {
      log.error('scheduler tick failed', { error: error.message });
    }
  }, state.config.schedulerIntervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
