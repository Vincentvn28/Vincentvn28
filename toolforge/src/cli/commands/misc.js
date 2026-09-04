import { makeClient, loadCliConfig, saveCliConfig } from '../client.js';
import { ago, bar, heading, json, money, paint, status, table } from '../format.js';

/**
 * `toolforge status` — one screen showing the pool, the tools, and the queue.
 * @param {string[]} argv
 * @param {any} flags
 * @returns {Promise<number>}
 */
export async function statusCommand(argv, flags) {
  const client = await makeClient(flags);
  const [overview, machines, tools] = await Promise.all([
    client.get('/api/overview'),
    client.get('/api/machines'),
    client.get('/api/tools'),
  ]);
  if (flags.json) {
    console.log(json({ overview, machines, tools }));
    return 0;
  }

  console.log(heading('Pool'));
  console.log(
    `  ${overview.machines.online} online · ${overview.machines.draining} draining · ${overview.machines.offline} offline` +
      ` · ${overview.machines.freeSlots}/${overview.machines.capacity} slots free · earned ${money(overview.earnings)}`,
  );
  console.log(
    table(
      ['MACHINE', 'STATUS', 'SLOTS', 'TAGS', 'HEARTBEAT'],
      machines.map((machine) => [
        machine.name,
        status(machine.status),
        `${machine.activeTasks}/${machine.maxConcurrency}`,
        machine.tags.join(',') || '-',
        ago(machine.lastHeartbeatAt),
      ]),
    ),
  );

  console.log(heading('Tools'));
  console.log(
    table(
      ['KEY', 'STATUS', 'MODE', 'TASKS', 'PROGRESS'],
      tools.map((tool) => [
        tool.key,
        status(tool.status),
        tool.dispatch.mode,
        `${tool.progress.done}/${tool.progress.total}`,
        bar(tool.progress.percent, 16),
      ]),
    ),
  );

  const queue = overview.tasks;
  console.log(heading('Queue'));
  console.log(
    `  ${queue.ready ?? 0} ready · ${queue.assigned ?? 0} assigned · ${queue.running ?? 0} running · ` +
      `${queue.pending ?? 0} waiting on deps · ${paint('red', String(queue.failed ?? 0))} failed · ${queue.succeeded ?? 0} done`,
  );
  return 0;
}

/**
 * `toolforge watch` — tail the hub's live event stream.
 * @param {string[]} argv
 * @param {any} flags
 * @returns {Promise<number>}
 */
export async function watchCommand(argv, flags) {
  const client = await makeClient(flags);
  const response = await fetch(`${client.baseUrl}/api/events`, {
    headers: { authorization: `Bearer ${client.token}`, accept: 'text/event-stream' },
  });
  if (!response.ok || !response.body) {
    console.error(`Could not open the event stream: ${response.status} ${response.statusText}`);
    return 1;
  }

  console.log(paint('gray', `Watching ${client.baseUrl} — Ctrl+C to stop\n`));
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(6));
      if (flags.json) {
        console.log(JSON.stringify(event));
      } else if (event.type !== 'hello') {
        console.log(`${paint('gray', event.ts.slice(11, 19))}  ${eventColor(event.type)}  ${describe(event)}`);
      }
    }
  }
  return 0;
}

function eventColor(type) {
  if (type.endsWith('.failed') || type.endsWith('.offline') || type.endsWith('.blocked')) {
    return paint('red', type.padEnd(22));
  }
  if (type.endsWith('.succeeded') || type.endsWith('.online')) return paint('green', type.padEnd(22));
  if (type.endsWith('.rescheduled') || type.endsWith('.retrying')) return paint('yellow', type.padEnd(22));
  return paint('cyan', type.padEnd(22));
}

function describe(event) {
  const data = event.data ?? {};
  const parts = [];
  if (data.ref) parts.push(data.ref);
  if (data.name) parts.push(data.name);
  if (data.key) parts.push(data.key);
  if (data.machineName) parts.push(`on ${data.machineName}`);
  if (data.reason) parts.push(`(${data.reason})`);
  if (data.attempt) parts.push(`try ${data.attempt}/${data.maxAttempts ?? '?'}`);
  if (data.exitCode != null) parts.push(`exit ${data.exitCode}`);
  return parts.join(' ');
}

/**
 * `toolforge login` — remember a hub URL and admin token for later commands.
 * @param {string[]} argv
 * @param {any} flags
 * @returns {Promise<number>}
 */
export async function loginCommand(argv, flags) {
  const hubUrl = flags.hub ?? argv[0];
  const token = flags.token ?? argv[1];
  if (!hubUrl || !token) {
    console.error('Usage: toolforge login --hub <url> --token <admin-token>');
    return 1;
  }
  const existing = await loadCliConfig();
  const client = await makeClient({ hub: hubUrl, token });
  await client.get('/api/overview');
  const file = await saveCliConfig({ ...existing, hubUrl, token });
  console.log(`Saved hub credentials to ${file}`);
  return 0;
}
