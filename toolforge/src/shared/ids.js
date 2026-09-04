import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijkmnpqrstuvwxyz';

/**
 * Short, URL-safe, prefixed id — e.g. `mch_7f3k9q2xd1`.
 * @param {string} prefix
 * @param {number} [size]
 * @returns {string}
 */
export function newId(prefix, size = 10) {
  const bytes = randomBytes(size);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** @returns {string} An opaque secret handed to a machine so it can authenticate. */
export function newToken() {
  return `tfa_${randomBytes(24).toString('base64url')}`;
}

/** @returns {string} */
export function newUuid() {
  return randomUUID();
}
