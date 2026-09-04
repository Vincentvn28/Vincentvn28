import { badRequest } from './errors.js';

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{max?: number, pattern?: RegExp}} [opts]
 * @returns {string}
 */
export function requireString(value, field, opts = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`"${field}" is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (opts.max && trimmed.length > opts.max) {
    throw badRequest(`"${field}" must be at most ${opts.max} characters`);
  }
  if (opts.pattern && !opts.pattern.test(trimmed)) {
    throw badRequest(`"${field}" has an invalid format`);
  }
  return trimmed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} [fallback]
 * @returns {string | undefined}
 */
export function optionalString(value, field, fallback = undefined) {
  if (value == null || value === '') return fallback;
  return requireString(value, field);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{min?: number, max?: number, fallback?: number}} [opts]
 * @returns {number}
 */
export function optionalNumber(value, field, opts = {}) {
  if (value == null || value === '') return opts.fallback ?? 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`"${field}" must be a number`);
  if (opts.min != null && parsed < opts.min) throw badRequest(`"${field}" must be >= ${opts.min}`);
  if (opts.max != null && parsed > opts.max) throw badRequest(`"${field}" must be <= ${opts.max}`);
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
export function stringArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw badRequest(`"${field}" must be an array of strings`);
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
}

/**
 * @template {string} T
 * @param {unknown} value
 * @param {string} field
 * @param {readonly T[]} allowed
 * @param {T} fallback
 * @returns {T}
 */
export function oneOf(value, field, allowed, fallback) {
  if (value == null || value === '') return fallback;
  if (!allowed.includes(/** @type {T} */ (value))) {
    throw badRequest(`"${field}" must be one of: ${allowed.join(', ')}`);
  }
  return /** @type {T} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {Record<string, string>}
 */
export function stringMap(value, field) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`"${field}" must be an object of string values`);
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw badRequest(`"${field}.${key}" must be a string`);
    out[key] = entry;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function optionalBoolean(value, field, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequest(`"${field}" must be a boolean`);
}
