import { badRequest, conflict } from '../../shared/errors.js';
import { now } from '../../shared/time.js';
import {
  ACTIVE_TASK_STATUS,
  DISPATCH_MODE,
  TEAM_DISPATCH,
  TERMINAL_TASK_STATUS,
  makeTask,
  makeTeam,
  makeTool,
  normalizeRequires,
  progressOf,
  rollupStatus,
} from './model.js';
import {
  oneOf,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  stringArray,
  stringMap,
} from '../../shared/validate.js';

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Parse and validate a tool spec: one app, its teams, and the micro-tasks each
 * team owns. Pure — it touches no state, so the CLI can lint a file offline.
 * @param {any} raw
 * @returns {any}
 */
export function parseToolSpec(raw) {
  if (!raw || typeof raw !== 'object') throw badRequest('Tool spec must be an object');

  const spec = {
    key: requireString(raw.key, 'key', { pattern: KEY_PATTERN }),
    name: optionalString(raw.name, 'name') ?? raw.key,
    description: optionalString(raw.description, 'description') ?? '',
    repo: optionalString(raw.repo, 'repo') ?? null,
    workdir: optionalString(raw.workdir, 'workdir') ?? null,
    concurrency: optionalNumber(raw.concurrency, 'concurrency', { min: 1, max: 512, fallback: 8 }),
    env: stringMap(raw.env, 'env'),
    dispatch: parseDispatch(raw.dispatch, 'dispatch', DISPATCH_MODE, 'auto'),
    teams: [],
  };

  if (!Array.isArray(raw.teams) || raw.teams.length === 0) {
    throw badRequest('A tool spec needs at least one team in "teams"');
  }

  const teamKeys = new Set();
  const taskRefs = new Set();

  spec.teams = raw.teams.map((rawTeam, teamIndex) => {
    const label = `teams[${teamIndex}]`;
    const key = requireString(rawTeam.key, `${label}.key`, { pattern: KEY_PATTERN });
    if (teamKeys.has(key)) throw badRequest(`Duplicate team key "${key}"`);
    teamKeys.add(key);

    const team = {
      key,
      name: optionalString(rawTeam.name, `${label}.name`) ?? key,
      role: optionalString(rawTeam.role, `${label}.role`) ?? 'general',
      description: optionalString(rawTeam.description, `${label}.description`) ?? '',
      concurrency: optionalNumber(rawTeam.concurrency, `${label}.concurrency`, {
        min: 1,
        max: 256,
        fallback: 4,
      }),
      env: stringMap(rawTeam.env, `${label}.env`),
      order: teamIndex,
      dispatch: parseDispatch(rawTeam.dispatch, `${label}.dispatch`, TEAM_DISPATCH, 'inherit'),
      tasks: [],
    };

    if (!Array.isArray(rawTeam.tasks) || rawTeam.tasks.length === 0) {
      throw badRequest(`Team "${key}" needs at least one task`);
    }

    const taskKeys = new Set();
    team.tasks = rawTeam.tasks.map((rawTask, taskIndex) => {
      const taskLabel = `${label}.tasks[${taskIndex}]`;
      const taskKey = requireString(rawTask.key, `${taskLabel}.key`, { pattern: KEY_PATTERN });
      if (taskKeys.has(taskKey)) {
        throw badRequest(`Duplicate task key "${taskKey}" in team "${key}"`);
      }
      taskKeys.add(taskKey);
      taskRefs.add(`${key}:${taskKey}`);

      const { command, shell } = parseCommand(rawTask, taskLabel);
      return {
        key: taskKey,
        ref: `${key}:${taskKey}`,
        name: optionalString(rawTask.name, `${taskLabel}.name`) ?? taskKey,
        command,
        shell,
        cwd: optionalString(rawTask.cwd, `${taskLabel}.cwd`) ?? null,
        env: stringMap(rawTask.env, `${taskLabel}.env`),
        dependsOn: stringArray(rawTask.dependsOn, `${taskLabel}.dependsOn`),
        priority: optionalNumber(rawTask.priority, `${taskLabel}.priority`, {
          min: -100,
          max: 100,
          fallback: 0,
        }),
        timeoutMs: optionalNumber(rawTask.timeoutMs, `${taskLabel}.timeoutMs`, {
          min: 1_000,
          fallback: 15 * 60_000,
        }),
        maxAttempts: optionalNumber(rawTask.maxAttempts, `${taskLabel}.maxAttempts`, {
          min: 1,
          max: 20,
          fallback: 3,
        }),
        requires: normalizeRequires(parseRequires(rawTask.requires, `${taskLabel}.requires`)),
        machineIds: stringArray(rawTask.machines, `${taskLabel}.machines`),
      };
    });

    return team;
  });

  resolveDependencies(spec, taskRefs);
  return spec;
}

function parseCommand(rawTask, label) {
  if (typeof rawTask.run === 'string' && rawTask.run.trim() !== '') {
    return { command: [rawTask.run.trim()], shell: true };
  }
  if (Array.isArray(rawTask.argv)) {
    const argv = stringArray(rawTask.argv, `${label}.argv`);
    if (argv.length === 0) throw badRequest(`"${label}.argv" must not be empty`);
    return { command: argv, shell: false };
  }
  throw badRequest(`"${label}" needs either "run" (shell string) or "argv" (array)`);
}

function parseRequires(raw, label) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest(`"${label}" must be an object`);
  return {
    os: optionalString(raw.os, `${label}.os`) ?? null,
    arch: optionalString(raw.arch, `${label}.arch`) ?? null,
    tags: stringArray(raw.tags, `${label}.tags`),
    tools: stringArray(raw.tools, `${label}.tools`),
    minMemGb: optionalNumber(raw.minMemGb, `${label}.minMemGb`, { min: 0, fallback: 0 }),
    minCpus: optionalNumber(raw.minCpus, `${label}.minCpus`, { min: 0, fallback: 0 }),
  };
}

function parseDispatch(raw, label, allowedModes, fallbackMode) {
  const dispatch = raw ?? {};
  if (typeof dispatch !== 'object' || Array.isArray(dispatch)) {
    throw badRequest(`"${label}" must be an object`);
  }
  return {
    mode: oneOf(dispatch.mode, `${label}.mode`, allowedModes, fallbackMode),
    machineIds: stringArray(dispatch.machines ?? dispatch.machineIds, `${label}.machines`),
    requires: normalizeRequires(parseRequires(dispatch.requires, `${label}.requires`)),
    failoverToPool:
      dispatch.failoverToPool == null
        ? fallbackMode === 'inherit'
          ? null
          : true
        : optionalBoolean(dispatch.failoverToPool, `${label}.failoverToPool`, true),
  };
}

/**
 * Turn `dependsOn` entries into fully-qualified `team:task` refs and reject
 * anything unresolvable or cyclic before a single task is ever queued.
 * @param {any} spec
 * @param {Set<string>} taskRefs
 */
function resolveDependencies(spec, taskRefs) {
  for (const team of spec.teams) {
    for (const task of team.tasks) {
      task.dependsOn = task.dependsOn.map((entry) => {
        const ref = entry.includes(':') ? entry : `${team.key}:${entry}`;
        if (!taskRefs.has(ref)) {
          throw badRequest(`Task "${task.ref}" depends on unknown task "${entry}"`);
        }
        if (ref === task.ref) throw badRequest(`Task "${task.ref}" cannot depend on itself`);
        return ref;
      });
    }
  }
  assertAcyclic(spec);
}

/** @param {any} spec */
function assertAcyclic(spec) {
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  for (const team of spec.teams) {
    for (const task of team.tasks) graph.set(task.ref, task.dependsOn);
  }
  const state = new Map();
  /** @type {string[]} */
  const stack = [];

  const visit = (ref) => {
    const mark = state.get(ref);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(ref)), ref].join(' -> ');
      throw badRequest(`Dependency cycle detected: ${cycle}`);
    }
    state.set(ref, 'visiting');
    stack.push(ref);
    for (const dep of graph.get(ref) ?? []) visit(dep);
    stack.pop();
    state.set(ref, 'done');
  };

  for (const ref of graph.keys()) visit(ref);
}

/**
 * Create or update a tool, its teams and its tasks from a spec. Keyed upserts
 * keep ids (and therefore history) stable across repeated applies.
 * @param {any} state
 * @param {any} rawSpec
 * @param {{force?: boolean}} [opts] `force` cancels in-flight tasks that the new spec drops.
 * @returns {{tool: any, created: boolean, added: number, updated: number, removed: number}}
 */
export function applyToolSpec(state, rawSpec, opts = {}) {
  const spec = parseToolSpec(rawSpec);
  const existing = state.tools.find((tool) => tool.key === spec.key);
  const created = !existing;

  const tool = existing
    ? state.tools.update(existing.id, (doc) => {
        doc.name = spec.name;
        doc.description = spec.description;
        doc.repo = spec.repo;
        doc.workdir = spec.workdir;
        doc.concurrency = spec.concurrency;
        doc.env = spec.env;
        doc.dispatch = {
          mode: spec.dispatch.mode,
          machineIds: spec.dispatch.machineIds,
          requires: spec.dispatch.requires,
          failoverToPool: spec.dispatch.failoverToPool ?? true,
        };
        doc.updatedAt = now();
      })
    : state.tools.insert(makeTool(spec));

  const previousTeams = state.teams.list((team) => team.toolId === tool.id);
  const previousTasks = state.tasks.list((task) => task.toolId === tool.id);
  const teamByKey = new Map(previousTeams.map((team) => [team.key, team]));
  const taskByRef = new Map(previousTasks.map((task) => [task.ref, task]));

  const keptTeamIds = new Set();
  const keptTaskIds = new Set();
  /** @type {Map<string, string>} */
  const idByRef = new Map();
  let added = 0;
  let updated = 0;

  for (const specTeam of spec.teams) {
    const priorTeam = teamByKey.get(specTeam.key);
    const team = priorTeam
      ? state.teams.update(priorTeam.id, (doc) => {
          doc.name = specTeam.name;
          doc.role = specTeam.role;
          doc.description = specTeam.description;
          doc.concurrency = specTeam.concurrency;
          doc.env = specTeam.env;
          doc.order = specTeam.order;
          doc.dispatch = specTeam.dispatch;
          doc.updatedAt = now();
        })
      : state.teams.insert(makeTeam({ ...specTeam, toolId: tool.id }));
    keptTeamIds.add(team.id);

    for (const specTask of specTeam.tasks) {
      const priorTask = taskByRef.get(specTask.ref);
      const task = priorTask
        ? state.tasks.update(priorTask.id, (doc) => {
            if (ACTIVE_TASK_STATUS.has(doc.status)) return; // never rewrite work in flight
            doc.name = specTask.name;
            doc.command = specTask.command;
            doc.shell = specTask.shell;
            doc.cwd = specTask.cwd;
            doc.env = specTask.env;
            doc.priority = specTask.priority;
            doc.timeoutMs = specTask.timeoutMs;
            doc.maxAttempts = specTask.maxAttempts;
            doc.requires = specTask.requires;
            doc.machineIds = specTask.machineIds;
            doc.teamId = team.id;
            doc.updatedAt = now();
          })
        : state.tasks.insert(
            makeTask({ ...specTask, toolId: tool.id, teamId: team.id, ref: specTask.ref }),
          );
      if (priorTask) updated++;
      else added++;
      keptTaskIds.add(task.id);
      idByRef.set(specTask.ref, task.id);
    }
  }

  // Second pass: refs are only resolvable to ids once every task exists.
  for (const specTeam of spec.teams) {
    for (const specTask of specTeam.tasks) {
      const id = idByRef.get(specTask.ref);
      state.tasks.update(id, (doc) => {
        doc.dependsOnRefs = specTask.dependsOn;
        doc.dependsOn = specTask.dependsOn.map((ref) => idByRef.get(ref)).filter(Boolean);
      });
    }
  }

  const staleTasks = previousTasks.filter((task) => !keptTaskIds.has(task.id));
  const activeStale = staleTasks.filter((task) => ACTIVE_TASK_STATUS.has(task.status));
  if (activeStale.length > 0 && !opts.force) {
    throw conflict(
      `${activeStale.length} task(s) removed by this spec are still running; re-apply with force to cancel them`,
      { tasks: activeStale.map((task) => task.ref) },
    );
  }
  for (const task of staleTasks) state.tasks.remove(task.id);
  for (const team of previousTeams) {
    if (!keptTeamIds.has(team.id)) state.teams.remove(team.id);
  }

  refreshTool(state, tool.id);
  state.events.emit(created ? 'tool.created' : 'tool.updated', {
    toolId: tool.id,
    key: tool.key,
    added,
    updated,
    removed: staleTasks.length,
  });

  return { tool: state.tools.require(tool.id), created, added, updated, removed: staleTasks.length };
}

/**
 * Recompute which tasks of a tool are runnable, then roll the result up into
 * the tool's own status. Called after every state transition.
 * @param {any} state
 * @param {string} toolId
 * @returns {any} The refreshed tool.
 */
export function refreshTool(state, toolId) {
  const tool = state.tools.require(toolId);
  const tasks = state.tasks.list((task) => task.toolId === toolId);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const paused = tool.status === 'paused' || tool.status === 'cancelled';

  for (const task of tasks) {
    if (TERMINAL_TASK_STATUS.has(task.status) || ACTIVE_TASK_STATUS.has(task.status)) continue;

    const deps = task.dependsOn.map((id) => byId.get(id)).filter(Boolean);
    const failedDep = deps.find(
      (dep) => dep.status === 'failed' || dep.status === 'blocked' || dep.status === 'cancelled',
    );
    if (failedDep) {
      if (task.status !== 'blocked') {
        state.tasks.update(task.id, (doc) => {
          doc.status = 'blocked';
          doc.updatedAt = now();
          doc.result = { reason: `blocked by ${failedDep.ref}` };
        });
        state.events.emit('task.blocked', { taskId: task.id, ref: task.ref, by: failedDep.ref });
      }
      continue;
    }

    const ready = !paused && deps.every((dep) => dep.status === 'succeeded');
    const target = ready ? 'ready' : 'pending';
    if (task.status !== target) {
      state.tasks.update(task.id, (doc) => {
        doc.status = target;
        doc.updatedAt = now();
      });
    }
  }

  const fresh = state.tasks.list((task) => task.toolId === toolId);
  const rolled = rollupStatus(fresh);
  return state.tools.update(toolId, (doc) => {
    if (doc.status === 'paused' || doc.status === 'cancelled') return;
    const next = doc.status === 'draft' && rolled === 'running' ? 'running' : rolled;
    if (next !== doc.status) {
      if (next === 'running' && !doc.startedAt) doc.startedAt = now();
      if (next === 'succeeded' || next === 'failed') doc.finishedAt = now();
      doc.status = next;
      doc.updatedAt = now();
      state.events.emit(`tool.${next}`, { toolId, key: doc.key });
    }
  });
}

/**
 * @param {any} state
 * @param {string} toolId
 * @returns {any} Tool with its teams, tasks and progress counters attached.
 */
export function describeTool(state, toolId) {
  const tool = state.tools.require(toolId);
  const tasks = state.tasks.list((task) => task.toolId === toolId);
  const teams = state.teams
    .list((team) => team.toolId === toolId)
    .sort((a, b) => a.order - b.order)
    .map((team) => {
      const teamTasks = tasks.filter((task) => task.teamId === team.id);
      return { ...team, progress: progressOf(teamTasks), tasks: teamTasks };
    });
  return { ...tool, progress: progressOf(tasks), teams };
}
