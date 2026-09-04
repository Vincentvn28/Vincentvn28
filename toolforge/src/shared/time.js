/** @returns {string} Current time as an ISO-8601 string. */
export function now() {
  return new Date().toISOString();
}

/**
 * @param {string | number | Date | null | undefined} value
 * @returns {number} Epoch milliseconds, or 0 when the value is not a usable date.
 */
export function ms(value) {
  if (value == null) return 0;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * @param {string | number | Date | null | undefined} value
 * @returns {number} Milliseconds elapsed since `value`, or Infinity when unknown.
 */
export function since(value) {
  const at = ms(value);
  return at === 0 ? Infinity : Date.now() - at;
}

/**
 * @param {number} milliseconds
 * @returns {string} ISO timestamp `milliseconds` into the future.
 */
export function fromNow(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

/**
 * @param {string | number | Date | null | undefined} value
 * @returns {boolean} True when `value` is in the past.
 */
export function isPast(value) {
  const at = ms(value);
  return at !== 0 && at <= Date.now();
}

/**
 * @param {number} milliseconds
 * @returns {string} Compact human duration, e.g. `1h 4m`.
 */
export function humanDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '-';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * @param {number} milliseconds
 * @param {AbortSignal} [signal] Resolves early (without throwing) when aborted.
 * @returns {Promise<void>}
 */
export function sleep(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
