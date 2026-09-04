import { now } from './time.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const COLORS = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const RESET = '\u001b[0m';

let threshold = LEVELS[process.env.TOOLFORGE_LOG_LEVEL] ?? LEVELS.info;
let asJson = process.env.TOOLFORGE_LOG_FORMAT === 'json';

/** @param {keyof typeof LEVELS} level */
export function setLogLevel(level) {
  if (LEVELS[level] != null) threshold = LEVELS[level];
}

/** @param {boolean} value */
export function setJsonLogs(value) {
  asJson = value;
}

function write(level, scope, message, fields) {
  if (LEVELS[level] < threshold) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  if (asJson) {
    stream.write(`${JSON.stringify({ ts: now(), level, scope, message, ...fields })}\n`);
    return;
  }
  const color = stream.isTTY ? COLORS[level] : '';
  const reset = stream.isTTY ? RESET : '';
  const extras = fields && Object.keys(fields).length
    ? ` ${Object.entries(fields).map(([key, value]) => `${key}=${format(value)}`).join(' ')}`
    : '';
  stream.write(`${color}${now()} ${level.toUpperCase().padEnd(5)} [${scope}]${reset} ${message}${extras}\n`);
}

function format(value) {
  if (value == null) return String(value);
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * @param {string} scope
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, child: (sub: string) => any}}
 */
export function logger(scope) {
  return {
    debug: (message, fields) => write('debug', scope, message, fields),
    info: (message, fields) => write('info', scope, message, fields),
    warn: (message, fields) => write('warn', scope, message, fields),
    error: (message, fields) => write('error', scope, message, fields),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}
