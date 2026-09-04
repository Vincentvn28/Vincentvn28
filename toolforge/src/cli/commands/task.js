import { makeClient } from '../client.js';
import { ago, heading, json, paint, status, table } from '../format.js';
import { humanDuration } from '../../shared/time.js';

/**
 * @param {string[]} argv
 * @param {any} flags
 * @returns {Promise<number>}
 */
export async function taskCommand(argv, flags) {
  const client = await makeClient(flags);
  const [action = 'ls', target] = argv;

  switch (action) {
    case 'ls':
    case 'list':
      return listTasks(client, flags);
    case 'show':
      return showTask(client, target, flags);
    case 'log':
      return showLog(client, target, flags);
    case 'why':
      return why(client, target, flags);
    case 'retry':
      return retry(client, target);
    case 'cancel':
      return cancel(client, target, flags);
    default:
      console.error(`Unknown "task" action: ${action}. Try: ls, show, log, why, retry, cancel`);
      return 1;
  }
}

async function listTasks(client, flags) {
  const tasks = await client.get('/api/tasks', {
    tool: flags.tool,
    status: flags.status,
    machine: flags.machine,
  });
  if (flags.json) {
    console.log(json(tasks));
    return 0;
  }
  const limit = flags.limit ? Number(flags.limit) : 40;
  console.log(heading(`Tasks (${tasks.length})`));
  console.log(
    table(
      ['ID', 'REF', 'STATUS', 'TRY', 'MACHINE', 'TOOK', 'UPDATED'],
      tasks.slice(0, limit).map((task) => [
        task.id,
        task.ref,
        status(task.status),
        `${task.attempt}/${task.maxAttempts}`,
        task.assignment?.machineName ?? task.result?.machineName ?? '-',
        task.result?.durationMs ? humanDuration(task.result.durationMs) : '-',
        ago(task.updatedAt),
      ]),
    ),
  );
  if (tasks.length > limit) console.log(paint('gray', `  … ${tasks.length - limit} more (use --limit)`));
  return 0;
}

async function showTask(client, id, flags) {
  if (!id) {
    console.error('Usage: toolforge task show <task-id>');
    return 1;
  }
  const task = await client.get(`/api/tasks/${id}`);
  if (flags.json) {
    console.log(json(task));
    return 0;
  }
  console.log(heading(`${task.ref}  ${status(task.status)}`));
  console.log(`  id          ${task.id}`);
  console.log(`  name        ${task.name}`);
  console.log(`  command     ${task.shell ? task.command[0] : task.command.join(' ')}`);
  console.log(`  attempt     ${task.attempt}/${task.maxAttempts}`);
  console.log(`  timeout     ${humanDuration(task.timeoutMs)}`);
  console.log(`  depends on  ${task.dependsOnRefs?.join(', ') || '-'}`);
  console.log(`  machine     ${task.assignment?.machineName ?? task.result?.machineName ?? '-'}`);
  if (task.avoidMachineIds?.length) {
    console.log(`  avoiding    ${task.avoidMachineIds.join(', ')} ${paint('gray', '(dropped or failed it before)')}`);
  }
  if (task.result) {
    console.log(`  result      exit ${task.result.exitCode ?? '-'} in ${humanDuration(task.result.durationMs ?? 0)}${task.result.error ? ` — ${task.result.error}` : ''}`);
  }
  console.log(heading('  History'));
  console.log(
    table(
      ['AT', 'EVENT', 'MACHINE', 'DETAIL'],
      (task.history ?? []).map((entry) => [
        entry.at,
        entry.event,
        entry.machineId ?? '-',
        entry.reason ?? (entry.exitCode != null ? `exit ${entry.exitCode}` : '-'),
      ]),
    ),
  );
  return 0;
}

async function showLog(client, id, flags) {
  if (!id) {
    console.error('Usage: toolforge task log <task-id> [--attempt 2]');
    return 1;
  }
  const result = await client.get(`/api/tasks/${id}/log`, { attempt: flags.attempt });
  process.stdout.write(result.log || paint('gray', '(no output recorded yet)\n'));
  return 0;
}

async function why(client, id, flags) {
  if (!id) {
    console.error('Usage: toolforge task why <task-id>');
    return 1;
  }
  const report = await client.get(`/api/tasks/${id}/why`);
  if (flags.json) {
    console.log(json(report));
    return 0;
  }
  console.log(heading(`${report.ref}  ${status(report.status)}`));
  console.log(`  dispatch mode  ${report.dispatch.mode}`);
  console.log(`  runnable now   ${report.runnable ? paint('green', 'yes') : paint('yellow', 'no')}`);
  if (report.blockers.length) {
    console.log(heading('  Blocked by'));
    for (const blocker of report.blockers) console.log(`   - ${blocker}`);
  }
  console.log(heading(`  Machines that could take it (${report.candidates.length})`));
  console.log(
    table(
      ['MACHINE', 'NAME', 'POOL', 'SCORE', 'FREE'],
      report.candidates.map((entry) => [
        entry.machineId,
        entry.name,
        entry.pool,
        entry.score,
        entry.freeSlots,
      ]),
    ),
  );
  if (report.rejected.length) {
    console.log(heading(`  Machines ruled out (${report.rejected.length})`));
    console.log(
      table(
        ['MACHINE', 'REASON'],
        report.rejected.map((entry) => [entry.name, entry.reason]),
      ),
    );
  }
  return 0;
}

async function retry(client, id) {
  if (!id) {
    console.error('Usage: toolforge task retry <task-id>');
    return 1;
  }
  const task = await client.post(`/api/tasks/${id}/retry`, {});
  console.log(`${task.ref} is now ${task.status}`);
  return 0;
}

async function cancel(client, id, flags) {
  if (!id) {
    console.error('Usage: toolforge task cancel <task-id> [--reason "..."]');
    return 1;
  }
  const task = await client.post(`/api/tasks/${id}/cancel`, { reason: flags.reason });
  console.log(`${task.ref} is now ${task.status}`);
  return 0;
}
