import { AppError } from './errors.js';
import { sleep } from './time.js';

/**
 * Minimal JSON client over `fetch` with bearer auth, timeouts and retries.
 * Used by both the agent and the CLI so their error handling stays identical.
 */
export class HttpClient {
  /**
   * @param {{baseUrl: string, token?: string, timeoutMs?: number, retries?: number}} opts
   */
  constructor({ baseUrl, token, timeoutMs = 30_000, retries = 3 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{body?: unknown, query?: Record<string, unknown>, timeoutMs?: number, retries?: number, signal?: AbortSignal}} [opts]
   * @returns {Promise<any>}
   */
  async request(method, path, opts = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    const retries = opts.retries ?? this.retries;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const abortOnCallerSignal = () => controller.abort();
      opts.signal?.addEventListener('abort', abortOnCallerSignal, { once: true });
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
      try {
        const response = await fetch(url, {
          method,
          headers: {
            accept: 'application/json',
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        });
        const text = await response.text();
        const payload = text ? safeParse(text) : null;
        if (!response.ok) {
          const error = new AppError(
            response.status,
            payload?.error?.code ?? 'http_error',
            payload?.error?.message ?? `${method} ${path} failed with ${response.status}`,
            payload?.error?.details,
          );
          // 4xx responses are the server's final answer; only retry 5xx.
          if (response.status < 500 || attempt === retries) throw error;
          lastError = error;
        } else {
          return payload;
        }
      } catch (error) {
        if (opts.signal?.aborted) throw error;
        lastError = error;
        if (error instanceof AppError && error.status < 500) throw error;
        if (attempt === retries) break;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', abortOnCallerSignal);
      }
      await sleep(Math.min(2 ** attempt * 500, 8_000), opts.signal);
    }
    throw lastError ?? new Error(`${method} ${path} failed`);
  }

  /** @param {string} path @param {Record<string, unknown>} [query] */
  get(path, query, opts = {}) {
    return this.request('GET', path, { ...opts, query });
  }

  /** @param {string} path @param {unknown} [body] */
  post(path, body, opts = {}) {
    return this.request('POST', path, { ...opts, body: body ?? {} });
  }

  /** @param {string} path @param {unknown} [body] */
  patch(path, body, opts = {}) {
    return this.request('PATCH', path, { ...opts, body: body ?? {} });
  }

  /** @param {string} path */
  delete(path, opts = {}) {
    return this.request('DELETE', path, opts);
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'bad_response', message: text.slice(0, 500) } };
  }
}
