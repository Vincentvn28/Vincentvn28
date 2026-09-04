import { hostname } from 'node:os';
import { HttpClient } from '../../shared/http-client.js';
import { runAgent } from '../../agent/agent.js';
import { detectCapabilities } from '../../agent/capabilities.js';
import {
  agentConfigPath,
  defaultAgentConfig,
  loadAgentConfig,
  saveAgentConfig,
} from '../../agent/config.js';
import { list } from '../args.js';
import { heading, json, paint, table } from '../format.js';
import { setLogLevel } from '../../shared/log.js';

/**
 * @param {string[]} argv
 * @param {any} flags
 * @returns {Promise<number>}
 */
export async function agentCommand(argv, flags) {
  const action = argv[0] ?? 'start';

  switch (action) {
    case 'join':
      return join(flags);
    case 'start':
    case 'run':
      return start(flags);
    case 'status':
      return statusCommand(flags);
    case 'capabilities':
      return capabilities(flags);
    default:
      console.error(`Unknown "agent" action: ${action}. Try: join, start, status, capabilities`);
      return 1;
  }
}

/**
 * Rent this computer out: redeem an enrollment code, store the token locally,
 * and (unless told otherwise) start working immediately.
 */
async function join(flags) {
  if (!flags.code) {
    console.error('Usage: toolforge agent join --hub <url> --code <join-code> [--name my-pc] [--slots 2] [--price 0.01]');
    return 1;
  }
  const hubUrl = flags.hub ?? process.env.TOOLFORGE_HUB ?? 'http://127.0.0.1:7373';
  const name = flags.name ?? hostname();

  console.log('Detecting what this machine can do…');
  const detected = await detectCapabilities();

  const client = new HttpClient({ baseUrl: hubUrl });
  const result = await client.post('/api/agent/join', {
    code: flags.code,
    name,
    owner: flags.owner,
    capabilities: detected,
    tags: list(flags.tags),
    maxConcurrency: flags.slots ? Number(flags.slots) : undefined,
    pricePerMinute: flags.price ? Number(flags.price) : undefined,
    currency: flags.currency,
    workdir: flags.workdir,
  });

  const config = defaultAgentConfig({
    hubUrl,
    token: result.token,
    machineId: result.machineId,
    name: result.name,
    owner: flags.owner ?? undefined,
    tags: list(flags.tags),
    maxConcurrency: flags.slots ? Number(flags.slots) : undefined,
    workdir: flags.workdir,
    pricePerMinute: flags.price ? Number(flags.price) : undefined,
    currency: flags.currency,
  });
  const file = await saveAgentConfig(config);

  console.log(heading(`This machine joined the pool as "${result.name}"`));
  console.log(`  hub     ${hubUrl}`);
  console.log(`  machine ${result.machineId}`);
  console.log(`  slots   ${config.maxConcurrency}`);
  console.log(`  config  ${file}`);
  console.log(
    `  detected ${detected.cpus} cpus · ${detected.memGb} GB · ${Object.keys(detected.tools).join(', ') || 'no toolchains found'}`,
  );

  if (flags.start === false) {
    console.log(paint('gray', '\nStart working with: toolforge agent start'));
    return 0;
  }
  console.log(paint('cyan', '\nStarting agent — press Ctrl+C to stop renting this machine out.\n'));
  return start({ ...flags, _joined: config });
}

async function start(flags) {
  if (flags.verbose) setLogLevel('debug');

  const stored = flags._joined ?? (await loadAgentConfig());
  const config = defaultAgentConfig({
    ...(stored ?? {}),
    hubUrl: flags.hub ?? stored?.hubUrl,
    token: flags.token ?? stored?.token,
    name: flags.name ?? stored?.name,
    maxConcurrency: flags.slots ? Number(flags.slots) : stored?.maxConcurrency,
    workdir: flags.workdir ?? stored?.workdir,
    tags: flags.tags ? list(flags.tags) : stored?.tags,
  });

  if (!config.token) {
    console.error(
      'No agent token. Either:\n' +
        '  toolforge agent join --hub <url> --code <join-code>     (self-service)\n' +
        '  toolforge agent start --hub <url> --token <token>       (token from an operator)',
    );
    return 1;
  }

  await runAgent(config);
  return 0;
}

async function statusCommand(flags) {
  const config = await loadAgentConfig();
  if (!config) {
    console.log(`No agent configured on this machine (looked in ${agentConfigPath()})`);
    return 1;
  }
  const client = new HttpClient({ baseUrl: config.hubUrl, token: config.token });
  const { machine } = await client.post('/api/agent/heartbeat', {});
  if (flags.json) {
    console.log(json(machine));
    return 0;
  }
  console.log(heading(`${machine.name}`));
  console.log(`  hub          ${config.hubUrl}`);
  console.log(`  machine id   ${machine.id}`);
  console.log(`  status       ${machine.status}`);
  console.log(`  slots        ${machine.activeTasks}/${machine.maxConcurrency} in use`);
  console.log(`  reliability  ${machine.reliability}`);
  console.log(`  earned       ${machine.stats.earnings.toFixed(4)} ${machine.rental.currency}`);
  return 0;
}

async function capabilities(flags) {
  const detected = await detectCapabilities();
  if (flags.json) {
    console.log(json(detected));
    return 0;
  }
  console.log(heading('This machine'));
  console.log(`  os      ${detected.os} ${detected.osRelease} (${detected.arch})`);
  console.log(`  cpu     ${detected.cpuModel} · ${detected.cpus} cores`);
  console.log(`  memory  ${detected.memGb} GB (${detected.freeMemGb} GB free)`);
  console.log(heading('  Toolchains'));
  console.log(
    table(
      ['TOOL', 'VERSION'],
      Object.entries(detected.tools).map(([name, version]) => [name, version]),
    ),
  );
  return 0;
}
