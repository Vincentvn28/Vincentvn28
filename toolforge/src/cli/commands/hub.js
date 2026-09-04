import { startHub } from '../../hub/server.js';
import { setJsonLogs, setLogLevel } from '../../shared/log.js';
import { createHubState } from '../../hub/state.js';
import { defaultDataDir } from '../../shared/paths.js';
import { duration } from '../args.js';
import { heading, paint } from '../format.js';
import { saveCliConfig, loadCliConfig } from '../client.js';
import { join } from 'node:path';

/**
 * @param {string[]} argv
 * @param {any} flags
 * @returns {Promise<number>}
 */
export async function hubCommand(argv, flags) {
  const action = argv[0] ?? 'start';

  if (action === 'start') return startCommand(flags);
  if (action === 'token') return tokenCommand(flags);

  console.error(`Unknown "hub" action: ${action}. Try: start, token`);
  return 1;
}

async function startCommand(flags) {
  if (flags.verbose) setLogLevel('debug');
  if (flags.jsonLogs) setJsonLogs(true);

  const hub = await startHub({
    port: flags.port ? Number(flags.port) : undefined,
    host: typeof flags.host === 'string' ? flags.host : undefined,
    dataDir: typeof flags.dataDir === 'string' ? flags.dataDir : undefined,
    adminToken: typeof flags.adminToken === 'string' ? flags.adminToken : undefined,
    heartbeatTimeoutMs: flags.heartbeatTimeout ? duration(flags.heartbeatTimeout) : undefined,
  });

  // Point this machine's own CLI at the hub it just started.
  const config = await loadCliConfig();
  await saveCliConfig({ ...config, hubUrl: hub.url, token: hub.state.adminToken });

  console.log(heading('ToolForge hub is up'));
  console.log(`  dashboard   ${paint('cyan', hub.url)}`);
  console.log(`  api         ${hub.url}/api`);
  console.log(`  data        ${hub.state.dataDir}`);
  console.log(`  admin token ${paint('yellow', hub.state.adminToken)}`);
  console.log(`\n  Share machine capacity with:  ${paint('bold', 'toolforge invite create')}`);
  console.log(`  Press Ctrl+C to stop.\n`);

  await new Promise((resolve) => {
    const shutdown = async () => {
      console.log('\nShutting down…');
      await hub.close();
      resolve(undefined);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return 0;
}

async function tokenCommand(flags) {
  const dataDir = typeof flags.dataDir === 'string' ? flags.dataDir : join(defaultDataDir(), 'hub');
  const state = await createHubState({ dataDir });
  console.log(state.adminToken);
  await state.store.close();
  return 0;
}
