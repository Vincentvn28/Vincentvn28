import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HttpClient } from '../shared/http-client.js';
import { defaultDataDir } from '../shared/paths.js';

/** @returns {string} */
export function cliConfigPath() {
  return process.env.TOOLFORGE_CLI_CONFIG ?? join(defaultDataDir(), 'cli.json');
}

/** @returns {Promise<any>} */
export async function loadCliConfig() {
  try {
    return JSON.parse(await readFile(cliConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

/** @param {any} config @returns {Promise<string>} */
export async function saveCliConfig(config) {
  const file = cliConfigPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/**
 * Resolve the hub URL and admin token: flags win, then env, then the saved
 * config, then the local default.
 * @param {any} flags
 * @returns {Promise<HttpClient>}
 */
export async function makeClient(flags = {}) {
  const config = await loadCliConfig();
  const baseUrl =
    stringOrNull(flags.hub) ?? process.env.TOOLFORGE_HUB ?? config.hubUrl ?? 'http://127.0.0.1:7373';
  const token = stringOrNull(flags.token) ?? process.env.TOOLFORGE_TOKEN ?? config.token ?? null;
  return new HttpClient({ baseUrl, token, timeoutMs: 30_000 });
}

/** @param {unknown} value @returns {string | null} */
function stringOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}
