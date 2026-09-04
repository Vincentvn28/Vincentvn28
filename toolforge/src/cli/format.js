import { humanDuration } from '../shared/time.js';

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = String.fromCharCode(27);

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
};

/**
 * @param {keyof typeof CODES} name
 * @param {string} text
 * @returns {string}
 */
export function paint(name, text) {
  if (!USE_COLOR) return text;
  return `${ESC}[${CODES[name]}m${text}${ESC}[${CODES.reset}m`;
}

const STATUS_COLORS = {
  online: 'green',
  succeeded: 'green',
  running: 'cyan',
  assigned: 'cyan',
  ready: 'blue',
  draft: 'gray',
  pending: 'gray',
  draining: 'yellow',
  paused: 'yellow',
  retrying: 'yellow',
  offline: 'red',
  failed: 'red',
  blocked: 'red',
  disabled: 'gray',
  cancelled: 'gray',
};

/** @param {string} status @returns {string} */
export function status(status) {
  return paint(STATUS_COLORS[status] ?? 'reset', status);
}

/**
 * Render rows as an aligned table. Column widths ignore colour codes so
 * painted cells still line up.
 * @param {string[]} headers
 * @param {(string | number | null | undefined)[][]} rows
 * @returns {string}
 */
export function table(headers, rows) {
  if (rows.length === 0) return paint('gray', '  (nothing to show)');
  const cells = rows.map((row) => row.map((cell) => (cell == null ? '-' : String(cell))));
  const widths = headers.map((header, index) =>
    Math.max(visibleLength(header), ...cells.map((row) => visibleLength(row[index] ?? ''))),
  );

  const line = (row, painter = (text) => text) =>
    row
      .map((cell, index) => painter(String(cell ?? '')) + ' '.repeat(widths[index] - visibleLength(cell ?? '')))
      .join('  ')
      .trimEnd();

  return [
    `  ${line(headers, (text) => paint('bold', text))}`,
    ...cells.map((row) => `  ${line(row)}`),
  ].join('\n');
}

/** @param {string} text @returns {number} */
function visibleLength(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').length;
}

/**
 * @param {number} percent
 * @param {number} [width]
 * @returns {string}
 */
export function bar(percent, width = 20) {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return `${'#'.repeat(filled)}${'.'.repeat(width - filled)} ${String(percent).padStart(3)}%`;
}

/** @param {string} title */
export function heading(title) {
  return `\n${paint('bold', title)}`;
}

/**
 * @param {string | null | undefined} iso
 * @returns {string} e.g. `12m ago`
 */
export function ago(iso) {
  if (!iso) return 'never';
  return `${humanDuration(Date.now() - Date.parse(iso))} ago`;
}

/**
 * @param {number} amount
 * @param {string} [currency]
 * @returns {string}
 */
export function money(amount, currency = 'USD') {
  return `${amount.toFixed(4)} ${currency}`;
}

/** @param {unknown} value */
export function json(value) {
  return JSON.stringify(value, null, 2);
}
