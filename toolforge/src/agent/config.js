import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultDataDir } from '../shared/paths.js';

/** @returns {string} Path of the agent config file. */
export function agentConfigPath() {
  return process.env.TOOLFORGE_AGENT_CONFIG ?? join(defaultDataDir(), 'agent.json');
}

/**
 * @param {string} [file]
 * @returns {Promise<any | null>}
 */
export async function loadAgentConfig(file = agentConfigPath()) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {any} config
 * @param {string} [file]
 * @returns {Promise<string>} The path written.
 */
export async function saveAgentConfig(config, file = agentConfigPath()) {
  await mkdir(dirname(file), { recursive: true });
  // 0600: the file holds the machine's token.
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/**
 * @param {Partial<any>} overrides
 * @returns {any}
 */
export function defaultAgentConfig(overrides = {}) {
  return {
    hubUrl: overrides.hubUrl ?? process.env.TOOLFORGE_HUB ?? 'http://127.0.0.1:7373',
    token: overrides.token ?? process.env.TOOLFORGE_AGENT_TOKEN ?? null,
    machineId: overrides.machineId ?? null,
    name: overrides.name ?? hostname(),
    owner: overrides.owner ?? null,
    tags: overrides.tags ?? [],
    maxConcurrency: overrides.maxConcurrency ?? 2,
    workdir: overrides.workdir ?? join(defaultDataDir(), 'work'),
    pricePerMinute: overrides.pricePerMinute ?? 0,
    currency: overrides.currency ?? 'USD',
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 15_000,
    pollWaitMs: overrides.pollWaitMs ?? 25_000,
    logFlushMs: overrides.logFlushMs ?? 3_000,
  };
}
