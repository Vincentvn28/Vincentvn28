import { newId } from '../../shared/ids.js';
import { now } from '../../shared/time.js';

/** Lifecycle of a rented machine as the hub sees it. */
export const MACHINE_STATUS = /** @type {const} */ ([
  'online',
  'draining',
  'offline',
  'disabled',
]);

/** Lifecycle of a single micro-task. */
export const TASK_STATUS = /** @type {const} */ ([
  'pending',
  'ready',
  'assigned',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
]);

export const TERMINAL_TASK_STATUS = new Set(['succeeded', 'failed', 'blocked', 'cancelled']);
export const ACTIVE_TASK_STATUS = new Set(['assigned', 'running']);

/** Lifecycle of a tool (one app being built by its teams). */
export const TOOL_STATUS = /** @type {const} */ ([
  'draft',
  'running',
  'succeeded',
  'failed',
  'paused',
  'cancelled',
]);

/**
 * How work is routed to machines.
 * - `pinned`: only the machines explicitly attached to the tool/team.
 * - `auto`:   any eligible machine in the shared pool, best-ranked first.
 * - `hybrid`: prefer the pinned machines, fall back to the pool when they drop out.
 */
export const DISPATCH_MODE = /** @type {const} */ (['pinned', 'auto', 'hybrid']);

/** A team may follow its tool's routing, or override it. */
export const TEAM_DISPATCH = /** @type {const} */ (['inherit', 'pinned', 'auto', 'hybrid']);

export const DEFAULTS = {
  taskTimeoutMs: 15 * 60_000,
  taskMaxAttempts: 3,
  leaseGraceMs: 60_000,
  heartbeatTimeoutMs: 45_000,
  teamConcurrency: 4,
  machineConcurrency: 2,
  logTailBytes: 16_000,
};

/**
 * @param {object} input
 * @returns {any}
 */
export function makeMachine(input) {
  return {
    id: input.id ?? newId('mch'),
    name: input.name,
    owner: input.owner ?? 'unknown',
    tokenHash: input.tokenHash,
    status: 'offline',
    tags: input.tags ?? [],
    capabilities: input.capabilities ?? {},
    maxConcurrency: input.maxConcurrency ?? DEFAULTS.machineConcurrency,
    workdir: input.workdir ?? null,
    rental: {
      pricePerMinute: input.rental?.pricePerMinute ?? 0,
      currency: input.rental?.currency ?? 'USD',
      note: input.rental?.note ?? null,
    },
    stats: {
      tasksSucceeded: 0,
      tasksFailed: 0,
      tasksAbandoned: 0,
      busyMs: 0,
      earnings: 0,
      avgDurationMs: 0,
      lastTaskAt: null,
    },
    lastHeartbeatAt: null,
    lastSeenAt: null,
    registeredAt: now(),
    agentVersion: input.agentVersion ?? null,
  };
}

/**
 * @param {object} input
 * @returns {any}
 */
export function makeTool(input) {
  return {
    id: input.id ?? newId('tol'),
    key: input.key,
    name: input.name,
    description: input.description ?? '',
    repo: input.repo ?? null,
    status: 'draft',
    dispatch: {
      mode: input.dispatch?.mode ?? 'auto',
      machineIds: input.dispatch?.machineIds ?? [],
      requires: normalizeRequires(input.dispatch?.requires),
      // When a pinned machine drops mid-run, `auto` and `hybrid` reroute to the
      // pool. `pinned` waits for the machine to come back instead.
      failoverToPool: input.dispatch?.failoverToPool ?? true,
    },
    env: input.env ?? {},
    workdir: input.workdir ?? null,
    concurrency: input.concurrency ?? 8,
    createdAt: now(),
    updatedAt: now(),
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * @param {object} input
 * @returns {any}
 */
export function makeTeam(input) {
  return {
    id: input.id ?? newId('tem'),
    toolId: input.toolId,
    key: input.key,
    name: input.name,
    role: input.role ?? 'general',
    description: input.description ?? '',
    dispatch: {
      mode: input.dispatch?.mode ?? 'inherit',
      machineIds: input.dispatch?.machineIds ?? [],
      requires: normalizeRequires(input.dispatch?.requires),
      failoverToPool: input.dispatch?.failoverToPool ?? null,
    },
    concurrency: input.concurrency ?? DEFAULTS.teamConcurrency,
    env: input.env ?? {},
    order: input.order ?? 0,
    createdAt: now(),
    updatedAt: now(),
  };
}

/**
 * @param {object} input
 * @returns {any}
 */
export function makeTask(input) {
  return {
    id: input.id ?? newId('tsk'),
    toolId: input.toolId,
    teamId: input.teamId,
    key: input.key,
    /** Fully-qualified `team:task` reference, unique within a tool. */
    ref: input.ref ?? input.key,
    name: input.name,
    command: input.command,
    shell: input.shell ?? false,
    cwd: input.cwd ?? null,
    env: input.env ?? {},
    dependsOn: input.dependsOn ?? [],
    dependsOnRefs: input.dependsOnRefs ?? [],
    priority: input.priority ?? 0,
    timeoutMs: input.timeoutMs ?? DEFAULTS.taskTimeoutMs,
    maxAttempts: input.maxAttempts ?? DEFAULTS.taskMaxAttempts,
    requires: normalizeRequires(input.requires),
    machineIds: input.machineIds ?? [],
    status: 'pending',
    attempt: 0,
    /** Machines that already failed or dropped this task; deprioritised on retry. */
    avoidMachineIds: [],
    assignment: null,
    result: null,
    history: [],
    createdAt: now(),
    updatedAt: now(),
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * @param {any} requires
 * @returns {{os: string | null, arch: string | null, tags: string[], tools: string[], minMemGb: number, minCpus: number}}
 */
export function normalizeRequires(requires) {
  return {
    os: requires?.os ?? null,
    arch: requires?.arch ?? null,
    tags: requires?.tags ?? [],
    tools: requires?.tools ?? [],
    minMemGb: requires?.minMemGb ?? 0,
    minCpus: requires?.minCpus ?? 0,
  };
}

/**
 * Merge a team's routing over its tool's. A team set to `inherit` takes the
 * tool's mode and machines wholesale; otherwise it overrides them, and its
 * requirements stack on top of the tool's.
 * @param {any} tool
 * @param {any} team
 * @param {any} [task]
 * @returns {{mode: string, machineIds: string[], requires: any, failoverToPool: boolean}}
 */
export function resolveDispatch(tool, team, task) {
  const teamDispatch = team?.dispatch ?? {};
  const inherits = !teamDispatch.mode || teamDispatch.mode === 'inherit';
  const mode = inherits ? tool.dispatch.mode : teamDispatch.mode;
  const machineIds = inherits || teamDispatch.machineIds?.length === 0
    ? tool.dispatch.machineIds ?? []
    : teamDispatch.machineIds;

  return {
    mode,
    // A task may pin itself to specific machines, overriding both levels above.
    machineIds: task?.machineIds?.length ? task.machineIds : machineIds,
    requires: mergeRequires(tool.dispatch.requires, teamDispatch.requires, task?.requires),
    failoverToPool: teamDispatch.failoverToPool ?? tool.dispatch.failoverToPool ?? true,
  };
}

/**
 * @param {...any} layers
 * @returns {any}
 */
export function mergeRequires(...layers) {
  const merged = normalizeRequires(null);
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.os) merged.os = layer.os;
    if (layer.arch) merged.arch = layer.arch;
    if (layer.tags?.length) merged.tags = [...new Set([...merged.tags, ...layer.tags])];
    if (layer.tools?.length) merged.tools = [...new Set([...merged.tools, ...layer.tools])];
    if (layer.minMemGb) merged.minMemGb = Math.max(merged.minMemGb, layer.minMemGb);
    if (layer.minCpus) merged.minCpus = Math.max(merged.minCpus, layer.minCpus);
  }
  return merged;
}

/**
 * Roll a set of task statuses up into the status of their tool.
 * @param {{status: string}[]} tasks
 * @returns {'draft' | 'running' | 'succeeded' | 'failed'}
 */
export function rollupStatus(tasks) {
  if (tasks.length === 0) return 'draft';
  const counts = tasks.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));
  const done = tasks.every((task) => TERMINAL_TASK_STATUS.has(task.status));
  if (!done) return 'running';
  if (counts.failed || counts.blocked) return 'failed';
  if (counts.succeeded) return 'succeeded';
  return 'failed';
}

/**
 * @param {{status: string}[]} tasks
 * @returns {Record<string, number> & {total: number, done: number, percent: number}}
 */
export function progressOf(tasks) {
  /** @type {any} */
  const counts = { total: tasks.length, done: 0, percent: 0 };
  for (const status of TASK_STATUS) counts[status] = 0;
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    if (TERMINAL_TASK_STATUS.has(task.status)) counts.done++;
  }
  counts.percent = tasks.length === 0 ? 0 : Math.round((counts.done / tasks.length) * 100);
  return counts;
}
