import { makeClient } from '../client.js';
import { list } from '../args.js';
import { ago, heading, json, money, paint, status, table } from '../format.js';
import { humanDuration } from '../../shared/time.js';

/**
 * @param {string[]} argv
 * @param {any} flags
 * @returns {Promise<number>}
 */
export async function machineCommand(argv, flags) {
  const client = await makeClient(flags);
  const [action = 'ls', target] = argv;

  switch (action) {
    case 'ls':
    case 'list':
      return listMachines(client, flags);
    case 'add':
      return addMachine(client, flags);
    case 'show':
      return showMachine(client, target, flags);
    case 'set':
      return setMachine(client, target, flags);
    case 'token':
      return rotateToken(client, target);
    case 'rm':
    case 'remove':
      return removeMachine(client, target);
    default:
      console.error(`Unknown "machine" action: ${action}. Try: ls, add, show, set, token, rm`);
      return 1;
  }
}

async function listMachines(client, flags) {
  const machines = await client.get('/api/machines');
  if (flags.json) {
    console.log(json(machines));
    return 0;
  }
  console.log(heading(`Machines (${machines.length})`));
  console.log(
    table(
      ['ID', 'NAME', 'STATUS', 'SLOTS', 'TAGS', 'OS/CPU', 'RELIABILITY', 'PRICE/MIN', 'HEARTBEAT'],
      machines.map((machine) => [
        machine.id,
        machine.name,
        status(machine.status),
        `${machine.activeTasks}/${machine.maxConcurrency}`,
        machine.tags.join(',') || '-',
        `${machine.capabilities?.os ?? '?'}/${machine.capabilities?.cpus ?? '?'}c`,
        machine.reliability,
        machine.rental.pricePerMinute || 0,
        ago(machine.lastHeartbeatAt),
      ]),
    ),
  );
  return 0;
}

async function addMachine(client, flags) {
  if (!flags.name) {
    console.error('Usage: toolforge machine add --name <name> [--tags a,b] [--slots 2] [--price 0.01]');
    return 1;
  }
  const result = await client.post('/api/machines', {
    name: flags.name,
    owner: flags.owner,
    tags: list(flags.tags),
    maxConcurrency: flags.slots ? Number(flags.slots) : undefined,
    pricePerMinute: flags.price ? Number(flags.price) : undefined,
    currency: flags.currency,
    workdir: flags.workdir,
  });
  if (flags.json) {
    console.log(json(result));
    return 0;
  }
  console.log(heading(`Registered "${result.machine.name}"`));
  console.log(`  machine id  ${result.machine.id}`);
  console.log(`  token       ${paint('yellow', result.token)}  ${paint('gray', '(shown once)')}`);
  console.log(
    paint('gray', '\n  --slots is the starting value; once its agent connects, the machine reports its own.'),
  );
  console.log(`\n  On that machine, run:`);
  console.log(
    paint('cyan', `    toolforge agent start --hub ${client.baseUrl} --token ${result.token}\n`),
  );
  return 0;
}

async function showMachine(client, id, flags) {
  if (!id) {
    console.error('Usage: toolforge machine show <machine-id>');
    return 1;
  }
  const machine = await client.get(`/api/machines/${id}`);
  if (flags.json) {
    console.log(json(machine));
    return 0;
  }
  console.log(heading(`${machine.name}  ${status(machine.status)}`));
  console.log(`  id            ${machine.id}`);
  console.log(`  owner         ${machine.owner}`);
  console.log(`  tags          ${machine.tags.join(', ') || '-'}`);
  console.log(`  slots         ${machine.activeTasks} running / ${machine.maxConcurrency} max`);
  console.log(`  hardware      ${machine.capabilities?.cpuModel ?? '?'} · ${machine.capabilities?.cpus ?? '?'} cpus · ${machine.capabilities?.memGb ?? '?'} GB`);
  console.log(`  toolchains    ${Object.keys(machine.capabilities?.tools ?? {}).join(', ') || '-'}`);
  console.log(`  reliability   ${machine.reliability}`);
  console.log(`  heartbeat     ${ago(machine.lastHeartbeatAt)}`);
  console.log(`  rental        ${money(machine.rental.pricePerMinute, machine.rental.currency)}/min`);
  console.log(
    `  lifetime      ${machine.stats.tasksSucceeded} ok · ${machine.stats.tasksFailed} failed · ${machine.stats.tasksAbandoned} dropped · ${humanDuration(machine.stats.busyMs)} busy · earned ${money(machine.stats.earnings, machine.rental.currency)}`,
  );
  if (machine.running?.length) {
    console.log(heading('  Running now'));
    console.log(
      table(
        ['TASK', 'REF', 'STATUS', 'STARTED'],
        machine.running.map((task) => [task.taskId, task.ref, status(task.status), ago(task.startedAt)]),
      ),
    );
  }
  return 0;
}

async function setMachine(client, id, flags) {
  if (!id) {
    console.error('Usage: toolforge machine set <machine-id> [--tags a,b] [--slots 4] [--price 0.02] [--status online|draining|disabled]');
    return 1;
  }
  const patch = {};
  if (flags.tags != null) patch.tags = list(flags.tags);
  if (flags.slots != null) patch.maxConcurrency = Number(flags.slots);
  if (flags.price != null) patch.pricePerMinute = Number(flags.price);
  if (flags.currency != null) patch.currency = flags.currency;
  if (flags.status != null) patch.status = flags.status;
  if (flags.name != null) patch.name = flags.name;
  if (flags.owner != null) patch.owner = flags.owner;
  if (Object.keys(patch).length === 0) {
    console.error('Nothing to change. Pass at least one of --tags --slots --price --status --name --owner');
    return 1;
  }
  const machine = await client.patch(`/api/machines/${id}`, patch);
  console.log(`Updated ${machine.name} (${machine.id})`);
  return 0;
}

async function rotateToken(client, id) {
  if (!id) {
    console.error('Usage: toolforge machine token <machine-id>');
    return 1;
  }
  const { token } = await client.post(`/api/machines/${id}/token`);
  console.log(paint('yellow', token));
  console.log(paint('gray', 'The old token stopped working. Restart that agent with the new one.'));
  return 0;
}

async function removeMachine(client, id) {
  if (!id) {
    console.error('Usage: toolforge machine rm <machine-id>');
    return 1;
  }
  const result = await client.delete(`/api/machines/${id}`);
  console.log(`Removed. ${result.releasedTasks} task(s) went back to the queue.`);
  return 0;
}

/**
 * `toolforge invite` — enrollment codes, so somebody can rent their machine in
 * without an operator minting a token for them.
 * @param {string[]} argv
 * @param {any} flags
 * @returns {Promise<number>}
 */
export async function inviteCommand(argv, flags) {
  const client = await makeClient(flags);
  const [action = 'create', target] = argv;

  if (action === 'create') {
    const code = await client.post('/api/enroll-codes', {
      label: flags.label,
      maxUses: flags.maxUses ? Number(flags.maxUses) : 0,
      ttlMs: flags.ttl ? Number(flags.ttl) : undefined,
      tags: list(flags.tags),
      maxConcurrency: flags.slots ? Number(flags.slots) : undefined,
      pricePerMinute: flags.price ? Number(flags.price) : undefined,
      currency: flags.currency,
    });
    if (flags.json) {
      console.log(json(code));
      return 0;
    }
    console.log(heading('Enrollment code created'));
    console.log(`  code    ${paint('yellow', code.code)}`);
    console.log(`  uses    ${code.maxUses === 0 ? 'unlimited' : code.maxUses}`);
    console.log(`  expires ${code.expiresAt ?? 'never'}`);
    console.log(`\n  Anyone who wants to rent their machine out runs:`);
    console.log(paint('cyan', `    toolforge agent join --hub ${client.baseUrl} --code ${code.code}\n`));
    return 0;
  }

  if (action === 'ls' || action === 'list') {
    const codes = await client.get('/api/enroll-codes');
    if (flags.json) {
      console.log(json(codes));
      return 0;
    }
    console.log(heading(`Enrollment codes (${codes.length})`));
    console.log(
      table(
        ['ID', 'CODE', 'LABEL', 'USES', 'EXPIRES', 'STATE'],
        codes.map((code) => [
          code.id,
          code.code,
          code.label,
          `${code.uses}/${code.maxUses || '∞'}`,
          code.expiresAt ?? 'never',
          code.revokedAt ? paint('red', 'revoked') : paint('green', 'active'),
        ]),
      ),
    );
    return 0;
  }

  if (action === 'revoke') {
    if (!target) {
      console.error('Usage: toolforge invite revoke <code-id>');
      return 1;
    }
    await client.delete(`/api/enroll-codes/${target}`);
    console.log('Revoked.');
    return 0;
  }

  console.error(`Unknown "invite" action: ${action}. Try: create, ls, revoke`);
  return 1;
}

/**
 * `toolforge earnings` — what each rented machine has billed.
 * @param {string[]} argv
 * @param {any} flags
 * @returns {Promise<number>}
 */
export async function earningsCommand(argv, flags) {
  const client = await makeClient(flags);
  const [machines, usage] = await Promise.all([
    client.get('/api/machines'),
    client.get('/api/usage', { machine: flags.machine, tool: flags.tool }),
  ]);
  if (flags.json) {
    console.log(json({ totals: usage.totals, machines }));
    return 0;
  }
  console.log(heading('Rental ledger'));
  console.log(
    table(
      ['MACHINE', 'OWNER', 'OK', 'FAIL', 'DROP', 'BUSY', 'PRICE/MIN', 'EARNED'],
      machines.map((machine) => [
        machine.name,
        machine.owner,
        machine.stats.tasksSucceeded,
        machine.stats.tasksFailed,
        machine.stats.tasksAbandoned,
        humanDuration(machine.stats.busyMs),
        machine.rental.pricePerMinute,
        money(machine.stats.earnings, machine.rental.currency),
      ]),
    ),
  );
  console.log(
    `\n  total billed time ${humanDuration(usage.totals.durationMs)} · total ${money(usage.totals.amount)}`,
  );
  if (flags.detail) {
    console.log(heading('Recent charges'));
    console.log(
      table(
        ['AT', 'MACHINE', 'TASK', 'OUTCOME', 'DURATION', 'AMOUNT'],
        usage.records.slice(0, 30).map((record) => [
          record.at,
          record.machineId,
          record.taskId,
          status(record.outcome),
          humanDuration(record.durationMs),
          money(record.amount, record.currency),
        ]),
      ),
    );
  }
  return 0;
}
