import { readFile } from 'node:fs/promises';
import { makeClient } from '../client.js';
import { list } from '../args.js';
import { bar, heading, json, paint, status, table } from '../format.js';
import { humanDuration } from '../../shared/time.js';
import { parseToolSpec } from '../../hub/core/planner.js';

/**
 * @param {string[]} argv
 * @param {any} flags
 * @returns {Promise<number>}
 */
export async function toolCommand(argv, flags) {
  const [action = 'ls', target] = argv;

  // `lint` is deliberately offline — you can check a spec with no hub running.
  if (action === 'lint') return lintSpec(flags);

  const client = await makeClient(flags);
  switch (action) {
    case 'ls':
    case 'list':
      return listTools(client, flags);
    case 'apply':
      return applySpec(client, flags);
    case 'show':
      return showTool(client, target, flags);
    case 'set':
      return setTool(client, target, flags);
    case 'start':
    case 'pause':
    case 'resume':
    case 'cancel':
      return lifecycle(client, action, target);
    case 'retry':
      return retryFailed(client, target);
    case 'rm':
    case 'remove':
      return removeTool(client, target);
    default:
      console.error(
        `Unknown "tool" action: ${action}. Try: ls, apply, lint, show, set, start, pause, resume, cancel, retry, rm`,
      );
      return 1;
  }
}

async function readSpec(flags) {
  const file = typeof flags.f === 'string' ? flags.f : flags.file;
  if (typeof file !== 'string') {
    console.error('Usage: toolforge tool apply -f <spec.json>');
    return null;
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

async function lintSpec(flags) {
  const raw = await readSpec(flags);
  if (!raw) return 1;
  const spec = parseToolSpec(raw);
  const taskCount = spec.teams.reduce((sum, team) => sum + team.tasks.length, 0);
  console.log(
    `${paint('green', 'OK')} "${spec.key}" — ${spec.teams.length} team(s), ${taskCount} task(s), dispatch "${spec.dispatch.mode}"`,
  );
  for (const team of spec.teams) {
    console.log(`  ${team.key.padEnd(16)} ${team.tasks.length} task(s), concurrency ${team.concurrency}`);
  }
  return 0;
}

async function applySpec(client, flags) {
  const raw = await readSpec(flags);
  if (!raw) return 1;
  const result = await client.post(`/api/tools?force=${flags.force ? 'true' : 'false'}`, raw);
  if (flags.json) {
    console.log(json(result));
    return 0;
  }
  console.log(
    `${result.created ? 'Created' : 'Updated'} tool ${paint('bold', result.tool.key)} — ` +
      `${result.added} task(s) added, ${result.updated} updated, ${result.removed} removed`,
  );
  if (flags.start) {
    await client.post(`/api/tools/${result.tool.id}/start`);
    console.log('Started. Watch it with: toolforge watch');
  } else {
    console.log(paint('gray', `Start it with: toolforge tool start ${result.tool.key}`));
  }
  return 0;
}

async function listTools(client, flags) {
  const tools = await client.get('/api/tools');
  if (flags.json) {
    console.log(json(tools));
    return 0;
  }
  console.log(heading(`Tools (${tools.length})`));
  console.log(
    table(
      ['KEY', 'NAME', 'STATUS', 'MODE', 'TEAMS', 'TASKS', 'PROGRESS'],
      tools.map((tool) => [
        tool.key,
        tool.name,
        status(tool.status),
        tool.dispatch.mode,
        tool.teamCount,
        tool.progress.total,
        bar(tool.progress.percent, 16),
      ]),
    ),
  );
  return 0;
}

async function showTool(client, key, flags) {
  if (!key) {
    console.error('Usage: toolforge tool show <key>');
    return 1;
  }
  const tool = await client.get(`/api/tools/${key}`);
  if (flags.json) {
    console.log(json(tool));
    return 0;
  }
  console.log(heading(`${tool.name}  ${status(tool.status)}`));
  console.log(`  key         ${tool.key}`);
  console.log(`  dispatch    ${tool.dispatch.mode}${tool.dispatch.machineIds.length ? ` -> ${tool.dispatch.machineIds.join(', ')}` : ''}`);
  console.log(`  failover    ${tool.dispatch.failoverToPool ? 'to shared pool' : 'off (waits for its machines)'}`);
  console.log(`  concurrency ${tool.concurrency}`);
  console.log(`  progress    ${bar(tool.progress.percent)}  (${tool.progress.done}/${tool.progress.total} done, ${tool.progress.failed} failed)`);

  for (const team of tool.teams) {
    console.log(
      heading(`  Team ${paint('bold', team.key)} · ${team.role} · concurrency ${team.concurrency} · ${bar(team.progress.percent, 12)}`),
    );
    console.log(
      table(
        ['TASK', 'NAME', 'STATUS', 'TRY', 'MACHINE', 'TOOK'],
        team.tasks.map((task) => [
          task.key,
          task.name,
          status(task.status),
          `${task.attempt}/${task.maxAttempts}`,
          task.assignment?.machineName ?? task.result?.machineName ?? '-',
          task.result?.durationMs ? humanDuration(task.result.durationMs) : '-',
        ]),
      ),
    );
  }
  return 0;
}

async function setTool(client, key, flags) {
  if (!key) {
    console.error('Usage: toolforge tool set <key> [--mode pinned|auto|hybrid] [--machines id1,id2] [--concurrency 8] [--no-failover]');
    return 1;
  }
  const patch = {};
  if (flags.mode != null) patch.mode = flags.mode;
  if (flags.machines != null) patch.machines = list(flags.machines);
  if (flags.concurrency != null) patch.concurrency = Number(flags.concurrency);
  if (flags.failover != null) patch.failoverToPool = flags.failover !== false;
  if (flags.name != null) patch.name = flags.name;
  if (Object.keys(patch).length === 0) {
    console.error('Nothing to change. Pass --mode, --machines, --concurrency, --failover/--no-failover or --name');
    return 1;
  }
  const tool = await client.patch(`/api/tools/${key}`, patch);
  console.log(
    `Updated ${tool.key}: mode "${tool.dispatch.mode}", ${tool.dispatch.machineIds.length} pinned machine(s), failover ${tool.dispatch.failoverToPool ? 'on' : 'off'}`,
  );
  return 0;
}

async function lifecycle(client, action, key) {
  if (!key) {
    console.error(`Usage: toolforge tool ${action} <key>`);
    return 1;
  }
  const tool = await client.post(`/api/tools/${key}/${action}`);
  console.log(`${tool.key} is now ${tool.status}`);
  return 0;
}

async function retryFailed(client, key) {
  if (!key) {
    console.error('Usage: toolforge tool retry <key>');
    return 1;
  }
  const result = await client.post(`/api/tools/${key}/retry-failed`, {});
  console.log(`Requeued ${result.retried} failed task(s) for ${result.tool.key}`);
  return 0;
}

async function removeTool(client, key) {
  if (!key) {
    console.error('Usage: toolforge tool rm <key>');
    return 1;
  }
  await client.delete(`/api/tools/${key}`);
  console.log('Removed.');
  return 0;
}
