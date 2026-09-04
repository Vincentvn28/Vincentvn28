import { AppError, badRequest, notFound } from '../shared/errors.js';
import { logger } from '../shared/log.js';

const log = logger('http');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** A tiny pattern router: `/api/tools/:id` style paths, no dependencies. */
export class Router {
  constructor() {
    /** @type {{method: string, segments: string[], handler: Function}[]} */
    this.routes = [];
  }

  /**
   * @param {string} method
   * @param {string} pattern
   * @param {(ctx: any) => any} handler
   * @returns {Router}
   */
  add(method, pattern, handler) {
    this.routes.push({
      method,
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern, handler) { return this.add('GET', pattern, handler); }
  post(pattern, handler) { return this.add('POST', pattern, handler); }
  patch(pattern, handler) { return this.add('PATCH', pattern, handler); }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler); }

  /**
   * @param {string} method
   * @param {string} pathname
   * @returns {{handler: Function, params: Record<string, string>} | null}
   */
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      /** @type {Record<string, string>} */
      const params = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index++) {
        const segment = route.segments[index];
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[index]);
        else if (segment !== parts[index]) { matched = false; break; }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>} Parsed JSON body, or `{}` for an empty request.
 */
export async function readJsonBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw badRequest('Request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Request body is not valid JSON');
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 * @param {string} [where]
 */
export function sendError(res, error, where = '') {
  const appError =
    error instanceof AppError
      ? error
      : new AppError(500, 'internal_error', error?.message ?? 'Unexpected error');
  if (appError.status >= 500) {
    log.error('request failed', { where, error: appError.message, stack: error?.stack });
  }
  sendJson(res, appError.status, {
    error: { code: appError.code, message: appError.message, details: appError.details },
  });
}

/**
 * @param {Router} router
 * @param {(ctx: any) => Promise<any>} buildContext
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createHandler(router, buildContext) {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const match = router.match(req.method, url.pathname);
    if (!match) {
      sendError(res, notFound('route', `${req.method} ${url.pathname}`));
      return;
    }
    try {
      const ctx = await buildContext({
        req,
        res,
        url,
        params: match.params,
        query: Object.fromEntries(url.searchParams),
      });
      const result = await match.handler(ctx);
      // A handler that already wrote to the socket (SSE, long-poll) returns undefined.
      if (result !== undefined && !res.writableEnded) {
        sendJson(res, result?.$status ?? 200, result?.$body ?? result);
      }
    } catch (error) {
      if (!res.writableEnded) sendError(res, error, `${req.method} ${url.pathname}`);
    }
  };
}

/** @param {number} status @param {unknown} body */
export const respond = (status, body) => ({ $status: status, $body: body });
