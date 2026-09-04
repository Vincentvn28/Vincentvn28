import { randomBytes } from 'node:crypto';
import { newId } from '../../shared/ids.js';
import { fromNow, isPast, now } from '../../shared/time.js';
import { badRequest, forbidden } from '../../shared/errors.js';
import { registerMachine } from './registry.js';

/**
 * Enrollment codes are how somebody rents their machine out without an operator
 * minting a token by hand: share a code, they run `toolforge agent join`.
 *
 * @param {any} state
 * @param {{label?: string, maxUses?: number, ttlMs?: number, tags?: string[], maxConcurrency?: number, pricePerMinute?: number, currency?: string}} [input]
 * @returns {any}
 */
export function createEnrollCode(state, input = {}) {
  const code = `join_${randomBytes(6).toString('hex')}`;
  const record = {
    id: newId('enr', 8),
    code,
    label: input.label ?? 'shared enrollment code',
    maxUses: input.maxUses ?? 0, // 0 = unlimited
    uses: 0,
    expiresAt: input.ttlMs ? fromNow(input.ttlMs) : null,
    defaults: {
      tags: input.tags ?? [],
      maxConcurrency: input.maxConcurrency ?? 2,
      pricePerMinute: input.pricePerMinute ?? 0,
      currency: input.currency ?? 'USD',
    },
    createdAt: now(),
    revokedAt: null,
  };
  state.enrollCodes.insert(record);
  state.events.emit('enroll_code.created', { id: record.id, label: record.label });
  return record;
}

/**
 * @param {any} state
 * @param {string} id
 * @returns {any}
 */
export function revokeEnrollCode(state, id) {
  return state.enrollCodes.update(id, (doc) => {
    doc.revokedAt = now();
  });
}

/**
 * Redeem a code and register the caller's machine into the rental pool.
 * @param {any} state
 * @param {{code: string, name: string, owner?: string, capabilities?: any, tags?: string[], maxConcurrency?: number, pricePerMinute?: number, currency?: string, agentVersion?: string, workdir?: string}} input
 * @returns {{machine: any, token: string}}
 */
export function redeemEnrollCode(state, input) {
  const record = state.enrollCodes.find((doc) => doc.code === input.code);
  if (!record) throw forbidden('Unknown enrollment code');
  if (record.revokedAt) throw forbidden('This enrollment code was revoked');
  if (record.expiresAt && isPast(record.expiresAt)) throw forbidden('This enrollment code expired');
  if (record.maxUses > 0 && record.uses >= record.maxUses) {
    throw forbidden('This enrollment code has no uses left');
  }
  if (!input.name) throw badRequest('"name" is required to enroll a machine');

  const existing = state.machines.find((machine) => machine.name === input.name);
  if (existing) {
    throw badRequest(
      `A machine named "${input.name}" already exists — pick another name or reuse its token`,
    );
  }

  const result = registerMachine(state, {
    name: input.name,
    owner: input.owner ?? 'self-enrolled',
    tags: [...new Set([...record.defaults.tags, ...(input.tags ?? [])])],
    capabilities: input.capabilities ?? {},
    maxConcurrency: input.maxConcurrency ?? record.defaults.maxConcurrency,
    workdir: input.workdir ?? null,
    agentVersion: input.agentVersion ?? null,
    rental: {
      pricePerMinute: input.pricePerMinute ?? record.defaults.pricePerMinute,
      currency: input.currency ?? record.defaults.currency,
      note: `enrolled with ${record.label}`,
    },
  });

  state.enrollCodes.update(record.id, (doc) => {
    doc.uses += 1;
    doc.lastUsedAt = now();
  });
  state.events.emit('machine.enrolled', {
    machineId: result.machine.id,
    name: result.machine.name,
    code: record.id,
  });
  return result;
}
