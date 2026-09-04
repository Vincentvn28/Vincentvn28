import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { fromNow, now } from '../../shared/time.js';
import { logger } from '../../shared/log.js';
import { DEFAULTS, TERMINAL_TASK_STATUS } from './model.js';
import { recordOutcome } from './registry.js';
import { refreshTool } from './planner.js';

const log = logger('execution');

/**
 * Everything an agent needs to run one micro-task, with env layered
 * tool -> team -> task and the hub's own variables injected last.
 * @param {any} state
 * @param {any} task
 * @returns {any}
 */
export function buildWorkOrder(state, task) {
  const tool = state.tools.require(task.toolId);
  const team = state.teams.get(task.teamId);
  return {
    taskId: task.id,
    ref: task.ref,
    name: task.name,
    leaseId: task.assignment?.leaseId ?? null,
    attempt: task.attempt,
    command: task.command,
    shell: task.shell,
    cwd: task.cwd ?? team?.workdir ?? tool.workdir ?? null,
    timeoutMs: task.timeoutMs,
    env: {
      ...tool.env,
      ...(team?.env ?? {}),
      ...task.env,
      TOOLFORGE_TASK_ID: task.id,
      TOOLFORGE_TASK_REF: task.ref,
      TOOLFORGE_TASK_ATTEMPT: String(task.attempt),
      TOOLFORGE_TOOL_KEY: tool.key,
      TOOLFORGE_TEAM_KEY: team?.key ?? '',
    },
    tool: { id: tool.id, key: tool.key, name: tool.name, repo: tool.repo },
    team: team ? { id: team.id, key: team.key, name: team.name, role: team.role } : null,
  };
}

/**
 * Hand a machine the work the scheduler already assigned to it, moving each
 * task from `assigned` to `running`.
 * @param {any} state
 * @param {any} machine
 * @param {number} [limit]
 * @returns {any[]} Work orders.
 */
export function claimAssignedWork(state, machine, limit) {
  // The scheduler already honoured maxConcurrency when it assigned these, so the
  // only cap left is what the agent says it can take right now.
  const capacity = Math.max(0, limit ?? machine.maxConcurrency);
  const pending = state.tasks
    .list((task) => task.status === 'assigned' && task.assignment?.machineId === machine.id)
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        Date.parse(a.assignment.assignedAt) - Date.parse(b.assignment.assignedAt),
    )
    .slice(0, capacity);

  return pending.map((task) => {
    const updated = state.tasks.update(task.id, (doc) => {
      doc.status = 'running';
      doc.startedAt = now();
      doc.updatedAt = now();
      doc.assignment.startedAt = now();
      doc.assignment.expiresAt = fromNow(doc.timeoutMs + state.config.leaseGraceMs);
      doc.history.push({ at: now(), event: 'started', machineId: machine.id, attempt: doc.attempt });
    });
    state.events.emit('task.started', {
      taskId: updated.id,
      ref: updated.ref,
      toolId: updated.toolId,
      machineId: machine.id,
      machineName: machine.name,
      attempt: updated.attempt,
    });
    return buildWorkOrder(state, updated);
  });
}

/**
 * @param {any} state
 * @param {any} machine
 * @param {string} taskId
 * @param {string} leaseId
 * @returns {any} The task, once the lease is proven valid.
 */
export function requireLease(state, machine, taskId, leaseId) {
  const task = state.tasks.get(taskId);
  if (!task) throw notFound('task', taskId);
  if (!task.assignment) {
    throw conflict(`Task ${task.ref} is no longer assigned (status ${task.status})`, {
      status: task.status,
    });
  }
  if (task.assignment.machineId !== machine.id) {
    throw forbidden(`Task ${task.ref} is assigned to another machine`);
  }
  if (task.assignment.leaseId !== leaseId) {
    throw conflict(`Stale lease for task ${task.ref}; it was rescheduled`, {
      status: task.status,
      stale: true,
    });
  }
  return task;
}

/**
 * Extend a lease and append streamed output. Returns a `cancel` flag so an
 * agent can abandon work the hub has already given up on.
 * @param {any} state
 * @param {any} machine
 * @param {{taskId: string, leaseId: string, logChunk?: string, progress?: number}} payload
 * @returns {Promise<{ok: true, expiresAt: string}>}
 */
export async function reportProgress(state, machine, payload) {
  const task = requireLease(state, machine, payload.taskId, payload.leaseId);
  const updated = state.tasks.update(task.id, (doc) => {
    doc.assignment.expiresAt = fromNow(doc.timeoutMs + state.config.leaseGraceMs);
    doc.updatedAt = now();
    if (payload.progress != null) doc.progress = Math.max(0, Math.min(100, payload.progress));
  });
  if (payload.logChunk) await appendTaskLog(state, task, payload.logChunk);
  return { ok: true, expiresAt: updated.assignment.expiresAt };
}

/**
 * Record the final result of a task run.
 * @param {any} state
 * @param {any} machine
 * @param {{taskId: string, leaseId: string, exitCode: number, durationMs: number, logTail?: string, error?: string}} payload
 * @returns {Promise<any>} The finished task.
 */
export async function completeTask(state, machine, payload) {
  const task = requireLease(state, machine, payload.taskId, payload.leaseId);
  const succeeded = payload.exitCode === 0 && !payload.error;
  const durationMs = payload.durationMs ?? (task.startedAt ? Date.now() - Date.parse(task.startedAt) : 0);

  if (payload.logTail) await appendTaskLog(state, task, payload.logTail);

  const retryable = !succeeded && task.attempt < task.maxAttempts;
  const finished = state.tasks.update(task.id, (doc) => {
    doc.assignment = null;
    doc.updatedAt = now();
    doc.result = {
      exitCode: payload.exitCode,
      durationMs,
      error: payload.error ?? null,
      machineId: machine.id,
      machineName: machine.name,
      logTail: (payload.logTail ?? '').slice(-DEFAULTS.logTailBytes),
      attempt: doc.attempt,
    };
    doc.history.push({
      at: now(),
      event: succeeded ? 'succeeded' : 'failed',
      machineId: machine.id,
      attempt: doc.attempt,
      exitCode: payload.exitCode,
    });
    if (succeeded) {
      doc.status = 'succeeded';
      doc.finishedAt = now();
    } else if (retryable) {
      // Send it back to the queue; `avoidMachineIds` steers the retry elsewhere.
      doc.status = 'ready';
      doc.startedAt = null;
      if (!doc.avoidMachineIds.includes(machine.id)) doc.avoidMachineIds.push(machine.id);
    } else {
      doc.status = 'failed';
      doc.finishedAt = now();
    }
  });

  recordOutcome(state, machine.id, {
    outcome: succeeded ? 'succeeded' : 'failed',
    durationMs,
    taskId: task.id,
    toolId: task.toolId,
  });

  state.events.emit(succeeded ? 'task.succeeded' : retryable ? 'task.retrying' : 'task.failed', {
    taskId: task.id,
    ref: task.ref,
    toolId: task.toolId,
    machineId: machine.id,
    machineName: machine.name,
    exitCode: payload.exitCode,
    durationMs,
    attempt: finished.attempt,
    maxAttempts: finished.maxAttempts,
  });

  refreshTool(state, task.toolId);
  return finished;
}

/**
 * @param {any} state
 * @param {any} task
 * @param {string} chunk
 * @returns {Promise<void>}
 */
export async function appendTaskLog(state, task, chunk) {
  try {
    const dir = join(state.dataDir, 'logs', task.toolId);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${task.id}.attempt-${task.attempt}.log`), chunk, 'utf8');
  } catch (error) {
    log.warn('could not persist task log', { taskId: task.id, error: error.message });
  }
}

/**
 * @param {any} state
 * @param {string} taskId
 * @param {number} [attempt]
 * @returns {Promise<string>} Stored log text, or '' when there is none yet.
 */
export async function readTaskLog(state, taskId, attempt) {
  const task = state.tasks.require(taskId);
  const which = attempt ?? task.attempt;
  try {
    return await readFile(
      join(state.dataDir, 'logs', task.toolId, `${task.id}.attempt-${which}.log`),
      'utf8',
    );
  } catch {
    return task.result?.logTail ?? '';
  }
}

/**
 * Put a finished or stuck task back in the queue by hand.
 * @param {any} state
 * @param {string} taskId
 * @param {{resetAttempts?: boolean}} [opts]
 * @returns {any}
 */
export function retryTask(state, taskId, opts = {}) {
  const task = state.tasks.require(taskId);
  const updated = state.tasks.update(taskId, (doc) => {
    doc.status = 'pending';
    doc.assignment = null;
    doc.result = null;
    doc.startedAt = null;
    doc.finishedAt = null;
    doc.updatedAt = now();
    if (opts.resetAttempts) {
      doc.attempt = 0;
      doc.avoidMachineIds = [];
    }
    doc.history.push({ at: now(), event: 'retry_requested' });
  });
  state.events.emit('task.retry_requested', { taskId, ref: task.ref, toolId: task.toolId });
  refreshTool(state, task.toolId);
  return updated;
}

/**
 * Cancel every unfinished task of a tool in one pass. Doing them together
 * matters: cancelling one at a time would mark each downstream task `blocked`
 * by its just-cancelled dependency before its own turn came around.
 * @param {any} state
 * @param {string} toolId
 * @param {string} [reason]
 * @returns {number} How many tasks were cancelled.
 */
export function cancelTasksForTool(state, toolId, reason = 'tool cancelled') {
  const tasks = state.tasks.list(
    (task) => task.toolId === toolId && task.status !== 'succeeded' && task.status !== 'cancelled',
  );
  for (const task of tasks) {
    const machineId = task.assignment?.machineId ?? null;
    state.tasks.update(task.id, (doc) => {
      doc.status = 'cancelled';
      doc.assignment = null;
      doc.finishedAt = now();
      doc.updatedAt = now();
      doc.result = { reason };
      doc.history.push({ at: now(), event: 'cancelled', machineId, reason });
    });
    state.events.emit('task.cancelled', { taskId: task.id, ref: task.ref, toolId, reason });
  }
  refreshTool(state, toolId);
  return tasks.length;
}

/**
 * @param {any} state
 * @param {string} taskId
 * @param {string} [reason]
 * @returns {any}
 */
export function cancelTask(state, taskId, reason = 'cancelled by operator') {
  const task = state.tasks.require(taskId);
  if (TERMINAL_TASK_STATUS.has(task.status)) return task;
  const machineId = task.assignment?.machineId ?? null;
  const updated = state.tasks.update(taskId, (doc) => {
    doc.status = 'cancelled';
    doc.assignment = null;
    doc.finishedAt = now();
    doc.updatedAt = now();
    doc.result = { reason };
    doc.history.push({ at: now(), event: 'cancelled', machineId, reason });
  });
  state.events.emit('task.cancelled', { taskId, ref: task.ref, toolId: task.toolId, reason });
  refreshTool(state, task.toolId);
  return updated;
}
