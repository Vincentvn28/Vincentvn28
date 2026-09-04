import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from '../shared/store.js';
import { EventBus } from '../shared/events.js';
import { defaultDataDir } from '../shared/paths.js';
import { DEFAULTS } from './core/model.js';

const STATE_SHAPE = {
  version: 1,
  machines: {},
  enrollCodes: {},
  tools: {},
  teams: {},
  tasks: {},
  usage: {},
  meta: {},
};

/** @param {string} token @returns {string} */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison so a token cannot be recovered by timing the check.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * @param {{dataDir?: string, adminToken?: string, heartbeatTimeoutMs?: number, leaseGraceMs?: number, schedulerIntervalMs?: number}} [opts]
 * @returns {Promise<any>}
 */
export async function createHubState(opts = {}) {
  const dataDir = opts.dataDir ?? join(defaultDataDir(), 'hub');
  const store = await Store.open(join(dataDir, 'state.json'), STATE_SHAPE);

  if (!store.data.meta.adminToken) {
    store.data.meta.adminToken =
      opts.adminToken ?? process.env.TOOLFORGE_ADMIN_TOKEN ?? `tfk_${randomBytes(24).toString('base64url')}`;
    store.data.meta.createdAt = new Date().toISOString();
    store.save();
  } else if (opts.adminToken) {
    store.data.meta.adminToken = opts.adminToken;
    store.save();
  }

  return {
    dataDir,
    store,
    events: new EventBus(),
    config: {
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs,
      leaseGraceMs: opts.leaseGraceMs ?? DEFAULTS.leaseGraceMs,
      schedulerIntervalMs: opts.schedulerIntervalMs ?? 1_000,
    },
    machines: store.collection('machines', 'machine'),
    enrollCodes: store.collection('enrollCodes', 'enrollment code'),
    tools: store.collection('tools', 'tool'),
    teams: store.collection('teams', 'team'),
    tasks: store.collection('tasks', 'task'),
    usage: store.collection('usage', 'usage record'),
    get adminToken() {
      return store.data.meta.adminToken;
    },
  };
}
