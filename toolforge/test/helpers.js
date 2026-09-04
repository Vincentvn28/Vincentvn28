import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubState } from '../src/hub/state.js';
import { startHub } from '../src/hub/server.js';
import { HttpClient } from '../src/shared/http-client.js';
import { setLogLevel } from '../src/shared/log.js';
import { heartbeat, registerMachine } from '../src/hub/core/registry.js';

setLogLevel('silent');

/** @returns {Promise<string>} A fresh temp directory. */
export async function tempDir() {
  return mkdtemp(join(tmpdir(), 'toolforge-test-'));
}

/**
 * An in-process hub state with a fast heartbeat timeout, for unit tests that
 * drive the scheduler directly.
 * @param {{heartbeatTimeoutMs?: number, leaseGraceMs?: number}} [opts]
 * @returns {Promise<{state: any, cleanup: () => Promise<void>}>}
 */
export async function makeState(opts = {}) {
  const dir = await tempDir();
  const state = await createHubState({
    dataDir: dir,
    adminToken: 'test-admin-token',
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 1_000,
    leaseGraceMs: opts.leaseGraceMs ?? 500,
    schedulerIntervalMs: 60_000,
  });
  return {
    state,
    cleanup: async () => {
      await state.store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A hub listening on an ephemeral port, plus an admin client.
 * @param {any} [opts]
 * @returns {Promise<{hub: any, admin: HttpClient, dir: string, cleanup: () => Promise<void>}>}
 */
export async function makeHub(opts = {}) {
  const dir = await tempDir();
  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    adminToken: 'test-admin-token',
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 2_000,
    leaseGraceMs: opts.leaseGraceMs ?? 1_000,
    schedulerIntervalMs: opts.schedulerIntervalMs ?? 200,
  });
  return {
    hub,
    admin: new HttpClient({ baseUrl: hub.url, token: 'test-admin-token', retries: 0 }),
    dir,
    cleanup: async () => {
      await hub.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Register a machine and pretend its agent just heartbeated in.
 * @param {any} state
 * @param {any} [overrides]
 * @returns {any}
 */
export function onlineMachine(state, overrides = {}) {
  const { machine } = registerMachine(state, {
    name: overrides.name ?? `machine-${Math.random().toString(36).slice(2, 8)}`,
    tags: overrides.tags ?? [],
    maxConcurrency: overrides.maxConcurrency ?? 2,
    capabilities: overrides.capabilities ?? { os: 'linux', arch: 'x64', cpus: 8, memGb: 16, tools: { node: '22' } },
    rental: overrides.rental,
  });
  return heartbeat(state, machine, {});
}

/**
 * A minimal but complete tool spec.
 * @param {any} [overrides]
 * @returns {any}
 */
export function sampleSpec(overrides = {}) {
  return {
    key: 'demo-tool',
    name: 'Demo Tool',
    concurrency: 8,
    dispatch: { mode: 'auto' },
    teams: [
      {
        key: 'backend',
        name: 'Backend',
        role: 'backend',
        concurrency: 4,
        tasks: [
          { key: 'scaffold', name: 'Scaffold', run: 'echo scaffold' },
          { key: 'api', name: 'API', run: 'echo api', dependsOn: ['scaffold'] },
        ],
      },
      {
        key: 'qa',
        name: 'QA',
        role: 'qa',
        tasks: [{ key: 'smoke', name: 'Smoke test', run: 'echo smoke', dependsOn: ['backend:api'] }],
      },
    ],
    ...overrides,
  };
}

/**
 * Poll until `check` returns truthy, or fail after `timeoutMs`.
 * @param {() => any} check
 * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [opts]
 * @returns {Promise<any>}
 */
export async function waitFor(check, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out: ${opts.label ?? 'condition never became true'}`);
}
