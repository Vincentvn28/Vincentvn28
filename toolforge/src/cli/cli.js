import { parseArgs } from './args.js';
import { paint } from './format.js';
import { AppError } from '../shared/errors.js';
import { hubCommand } from './commands/hub.js';
import { earningsCommand, inviteCommand, machineCommand } from './commands/machine.js';
import { toolCommand } from './commands/tool.js';
import { taskCommand } from './commands/task.js';
import { agentCommand } from './commands/agent.js';
import { loginCommand, statusCommand, watchCommand } from './commands/misc.js';

const BOOLEAN_FLAGS = [
  'json',
  'force',
  'verbose',
  'detail',
  'start',
  'failover',
  'jsonLogs',
  'json-logs',
  'help',
  'version',
];

const COMMANDS = {
  hub: hubCommand,
  machine: machineCommand,
  invite: inviteCommand,
  earnings: earningsCommand,
  tool: toolCommand,
  task: taskCommand,
  agent: agentCommand,
  status: statusCommand,
  watch: watchCommand,
  login: loginCommand,
};

const HELP = `
${paint('bold', 'toolforge')} — rent machines out, and build tools on them with teams of micro-tasks

${paint('bold', 'Running the hub')}
  toolforge hub start [--port 7373] [--host 127.0.0.1] [--data-dir DIR]
  toolforge hub token                          print the admin token
  toolforge login --hub URL --token TOKEN      remember a remote hub

${paint('bold', 'Renting a machine in')}
  toolforge invite create [--label L] [--max-uses N] [--price 0.01] [--tags gpu,win]
  toolforge agent join --hub URL --code CODE [--name my-pc] [--slots 2] [--price 0.01]
  toolforge agent start [--hub URL] [--token TOKEN] [--slots 4]
  toolforge agent status | capabilities

${paint('bold', 'Managing the pool')}
  toolforge machine ls | show ID | rm ID
  toolforge machine add --name NAME [--tags a,b] [--slots 2] [--price 0.01]
  toolforge machine set ID [--tags a,b] [--slots 4] [--status draining|online|disabled]
  toolforge machine token ID                   rotate that machine's token
  toolforge earnings [--detail]

${paint('bold', 'Building tools')}
  toolforge tool lint -f spec.json             validate a spec offline
  toolforge tool apply -f spec.json [--start]  create/update a tool and its teams
  toolforge tool ls | show KEY
  toolforge tool set KEY --mode pinned|auto|hybrid [--machines id1,id2] [--no-failover]
  toolforge tool start|pause|resume|cancel|retry KEY

${paint('bold', 'Tasks')}
  toolforge task ls [--tool KEY] [--status running]
  toolforge task show ID | log ID | why ID
  toolforge task retry ID | cancel ID

${paint('bold', 'Watching')}
  toolforge status                             one-screen overview
  toolforge watch                              live event stream

${paint('bold', 'Dispatch modes')}
  ${paint('cyan', 'pinned')}  run only on the machines attached to the tool or team
  ${paint('cyan', 'auto')}    run anywhere in the pool; if a machine drops, another picks the task up
  ${paint('cyan', 'hybrid')}  prefer the pinned machines, fall back to the pool when they go offline

Global flags: --hub URL  --token TOKEN  --json  --verbose
`;

/**
 * @param {string[]} argv Raw process arguments, without node and the script.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv) {
  const flags = parseArgs(argv, {
    booleans: BOOLEAN_FLAGS,
    aliases: { h: 'help', v: 'version', f: 'f' },
  });
  const [name, ...rest] = flags._;

  if (flags.version) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const pkg = JSON.parse(
      await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
    );
    console.log(pkg.version);
    return 0;
  }

  if (!name || flags.help || name === 'help') {
    console.log(HELP);
    return name && name !== 'help' ? 1 : 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    console.error(`Unknown command "${name}". Run "toolforge help" for the list.`);
    return 1;
  }

  try {
    return (await command(rest, flags)) ?? 0;
  } catch (error) {
    reportError(error);
    return 1;
  }
}

/** @param {unknown} error */
function reportError(error) {
  if (error instanceof AppError) {
    console.error(`${paint('red', 'Error')} ${error.message}`);
    if (error.details) console.error(paint('gray', JSON.stringify(error.details)));
    if (error.status === 401) {
      console.error(
        paint('gray', 'Check your token: toolforge login --hub <url> --token <admin-token>'),
      );
    }
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
    console.error(`${paint('red', 'Error')} Cannot reach the hub. Is it running? (toolforge hub start)`);
    return;
  }
  console.error(`${paint('red', 'Error')} ${message}`);
  if (process.env.TOOLFORGE_LOG_LEVEL === 'debug' && error instanceof Error) {
    console.error(error.stack);
  }
}
