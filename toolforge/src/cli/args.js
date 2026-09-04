/**
 * Parse `--flag value`, `--flag=value`, `-f value`, `--no-flag` and positionals.
 * Deliberately tiny: the CLI has no dependencies.
 *
 * @param {string[]} argv
 * @param {{booleans?: string[], aliases?: Record<string, string>}} [schema]
 * @returns {{_: string[], [key: string]: any}}
 */
export function parseArgs(argv, schema = {}) {
  const booleans = new Set(schema.booleans ?? []);
  const aliases = schema.aliases ?? {};
  /** @type {any} */
  const out = { _: [] };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];

    if (token === '--') {
      out._.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      out._.push(token);
      continue;
    }

    const isLong = token.startsWith('--');
    let name = token.replace(/^--?/, '');
    let value;

    const equals = name.indexOf('=');
    if (equals !== -1) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
    if (isLong && name.startsWith('no-') && value === undefined) {
      out[camel(name.slice(3))] = false;
      continue;
    }
    name = aliases[name] ?? name;

    if (value === undefined) {
      if (booleans.has(name) || booleans.has(camel(name))) {
        value = true;
      } else {
        const next = argv[index + 1];
        if (next === undefined || (next.startsWith('-') && next !== '-' && Number.isNaN(Number(next)))) {
          value = true;
        } else {
          value = next;
          index++;
        }
      }
    }
    out[camel(name)] = value;
  }
  return out;
}

/** @param {string} name @returns {string} */
function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

/**
 * @param {unknown} value
 * @returns {string[]} A comma- or repeat-separated flag turned into a list.
 */
export function list(value) {
  if (value == null || value === true) return [];
  if (Array.isArray(value)) return value.flatMap(list);
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Parse a duration like `30s`, `15m`, `2h`, or a bare millisecond count.
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function duration(value, fallback = 0) {
  if (value == null || value === true) return fallback;
  const text = String(value).trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(text);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Math.round(amount * scale);
}
