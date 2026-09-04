import { newId, newToken } from '../../shared/ids.js';
import { now, since } from '../../shared/time.js';
import { conflict } from '../../shared/errors.js';
import { hashToken, safeEqual } from '../state.js';
import { ACTIVE_TASK_STATUS, makeMachine } from './model.js';

/**
 * Register a machine into the rental pool and mint its agent token. The token
 * is returned once and only its hash is stored.
 * @param {any} state
 * @param {any} input
 * @returns {{machine: any, token: string}}
 */
export function registerMachine(state, input) {
  if (state.machines.find((machine) => machine.name === input.name)) {
    throw conflict(`A machine named "${input.name}" is already registered`, { name: input.name });
  }
  const token = newToken();
  const machine = makeMachine({ ...input, tokenHash: hashToken(token) });
  state.machines.insert(machine);
  state.events.emit('machine.registered', { machineId: machine.id, name: machine.name });
  return { machine, token };
}

/**
 * @param {any} state
 * @param {string} machineId
 * @returns {string} The new token.
 */
export function rotateMachineToken(state, machineId) {
  const token = newToken();
  state.machines.update(machineId, (machine) => {
    machine.tokenHash = hashToken(token);
  });
  state.events.emit('machine.token_rotated', { machineId });
  return token;
}

/**
 * @param {any} state
 * @param {string} token
 * @returns {any | null}
 */
export function authenticateMachine(state, token) {
  if (!token) return null;
  const hash = hashToken(token);
  return state.machines.find((machine) => safeEqual(machine.tokenHash, hash)) ?? null;
}

/**
 * Record a heartbeat and bring the machine back online if it had gone stale.
 * @param {any} state
 * @param {any} machine
 * @param {{status?: string, capabilities?: any, agentVersion?: string, maxConcurrency?: number}} [payload]
 * @returns {any}
 */
export function heartbeat(state, machine, payload = {}) {
  return state.machines.update(machine.id, (doc) => {
    const wasOffline = doc.status === 'offline';
    doc.lastHeartbeatAt = now();
    doc.lastSeenAt = now();
    if (payload.capabilities) doc.capabilities = payload.capabilities;
    if (payload.agentVersion) doc.agentVersion = payload.agentVersion;
    // The machine's owner decides how much of their computer to lend, so the
    // agent's reported slot count wins over the value set at registration.
    if (payload.maxConcurrency != null) doc.maxConcurrency = payload.maxConcurrency;
    // A disabled machine stays disabled no matter what its agent reports.
    if (doc.status !== 'disabled') {
      doc.status = payload.status === 'draining' ? 'draining' : 'online';
    }
    if (wasOffline && doc.status === 'online') {
      state.events.emit('machine.online', { machineId: doc.id, name: doc.name });
    }
  });
}

/**
 * @param {any} state
 * @param {string} machineId
 * @returns {any[]} Tasks currently leased to or running on the machine.
 */
export function activeTasksFor(state, machineId) {
  return state.tasks.list(
    (task) => ACTIVE_TASK_STATUS.has(task.status) && task.assignment?.machineId === machineId,
  );
}

/**
 * @param {any} state
 * @param {any} machine
 * @returns {number} Free execution slots, never negative.
 */
export function freeSlots(state, machine) {
  return Math.max(0, machine.maxConcurrency - activeTasksFor(state, machine.id).length);
}

/**
 * @param {any} machine
 * @returns {boolean} True when the machine may be handed new work.
 */
export function acceptsWork(machine) {
  return machine.status === 'online';
}

/**
 * Does this machine satisfy a task's hardware/software requirements?
 * @param {any} machine
 * @param {any} requires
 * @returns {{ok: boolean, reason?: string}}
 */
export function meetsRequirements(machine, requires) {
  const capabilities = machine.capabilities ?? {};
  if (requires.os && capabilities.os !== requires.os) {
    return { ok: false, reason: `os ${capabilities.os ?? '?'} != ${requires.os}` };
  }
  if (requires.arch && capabilities.arch !== requires.arch) {
    return { ok: false, reason: `arch ${capabilities.arch ?? '?'} != ${requires.arch}` };
  }
  if (requires.minCpus && (capabilities.cpus ?? 0) < requires.minCpus) {
    return { ok: false, reason: `needs ${requires.minCpus} cpus` };
  }
  if (requires.minMemGb && (capabilities.memGb ?? 0) < requires.minMemGb) {
    return { ok: false, reason: `needs ${requires.minMemGb}GB memory` };
  }
  const tags = new Set(machine.tags ?? []);
  const missingTag = requires.tags.find((tag) => !tags.has(tag));
  if (missingTag) return { ok: false, reason: `missing tag "${missingTag}"` };

  const installed = new Set(Object.keys(capabilities.tools ?? {}));
  const missingTool = requires.tools.find((tool) => !installed.has(tool));
  if (missingTool) return { ok: false, reason: `missing tool "${missingTool}"` };

  return { ok: true };
}

/**
 * Mark machines that stopped heartbeating as offline. Their in-flight tasks are
 * released separately by the lease reaper, which is what makes auto-failover
 * work: the task goes back to the queue and another machine picks it up.
 * @param {any} state
 * @returns {any[]} The machines that just went offline.
 */
export function sweepStaleMachines(state) {
  const timeout = state.config.heartbeatTimeoutMs;
  const dropped = [];
  for (const machine of state.machines.list()) {
    if (machine.status === 'offline' || machine.status === 'disabled') continue;
    if (since(machine.lastHeartbeatAt) <= timeout) continue;
    state.machines.update(machine.id, (doc) => {
      doc.status = 'offline';
    });
    state.events.emit('machine.offline', {
      machineId: machine.id,
      name: machine.name,
      reason: 'heartbeat_timeout',
      lastHeartbeatAt: machine.lastHeartbeatAt,
    });
    dropped.push(machine);
  }
  return dropped;
}

/**
 * Update a machine's reliability stats and rental ledger after it finishes a task.
 * @param {any} state
 * @param {string} machineId
 * @param {{outcome: 'succeeded' | 'failed' | 'abandoned', durationMs: number, taskId: string, toolId?: string}} result
 */
export function recordOutcome(state, machineId, result) {
  const machine = state.machines.get(machineId);
  if (!machine) return;
  const billableMs = Math.max(0, result.durationMs);
  const cost = (billableMs / 60_000) * (machine.rental.pricePerMinute ?? 0);

  state.machines.update(machineId, (doc) => {
    const stats = doc.stats;
    if (result.outcome === 'succeeded') stats.tasksSucceeded++;
    else if (result.outcome === 'failed') stats.tasksFailed++;
    else stats.tasksAbandoned++;

    const completed = stats.tasksSucceeded + stats.tasksFailed;
    stats.busyMs += billableMs;
    stats.earnings = Number((stats.earnings + cost).toFixed(6));
    stats.avgDurationMs = completed === 0 ? 0 : Math.round(stats.busyMs / completed);
    stats.lastTaskAt = now();
  });

  if (billableMs > 0) {
    state.usage.insert({
      id: newId('usg'),
      machineId,
      taskId: result.taskId,
      toolId: result.toolId ?? null,
      outcome: result.outcome,
      durationMs: billableMs,
      pricePerMinute: machine.rental.pricePerMinute ?? 0,
      currency: machine.rental.currency ?? 'USD',
      amount: Number(cost.toFixed(6)),
      at: now(),
    });
  }
}

/**
 * @param {any} machine
 * @returns {number} 0..1 reliability estimate, optimistic for new machines.
 */
export function reliabilityOf(machine) {
  const { tasksSucceeded, tasksFailed, tasksAbandoned } = machine.stats;
  const total = tasksSucceeded + tasksFailed + tasksAbandoned;
  // Laplace smoothing: a brand-new machine starts at 0.75 rather than 0 or 1.
  return (tasksSucceeded + 3) / (total + 4);
}
