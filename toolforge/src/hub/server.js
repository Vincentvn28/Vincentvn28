import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../shared/log.js';
import { unauthorized } from '../shared/errors.js';
import { createHubState, safeEqual } from './state.js';
import { Router, createHandler, readJsonBody, sendError } from './router.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerEventRoutes } from './routes/events.js';
import { authenticateMachine } from './core/registry.js';
import { startScheduler } from './core/scheduler.js';

const log = logger('hub');
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** Routes reachable without any token at all. */
const PUBLIC_ROUTES = new Set(['/api/health', '/api/agent/join']);

/**
 * Boot the hub: state, scheduler and HTTP API.
 * @param {{port?: number, host?: string, dataDir?: string, adminToken?: string, heartbeatTimeoutMs?: number, schedulerIntervalMs?: number, state?: any}} [opts]
 * @returns {Promise<{state: any, server: import('node:http').Server, url: string, port: number, close: () => Promise<void>}>}
 */
export async function startHub(opts = {}) {
  const state = opts.state ?? (await createHubState(opts));
  const router = buildRouter();
  const scheduler = startScheduler(state);

  const dispatch = createHandler(router, async (base) => ({
    ...base,
    state,
    machine: base.req.authenticatedMachine ?? null,
    body: base.req.method === 'GET' ? {} : await readJsonBody(base.req),
  }));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (!url.pathname.startsWith('/api/')) {
        await serveStatic(url.pathname, res);
        return;
      }
      authenticate(state, req, url.pathname);
      await dispatch(req, res);
    } catch (error) {
      if (!res.writableEnded) sendError(res, error, req.url);
    }
  });

  const port = opts.port ?? Number(process.env.TOOLFORGE_PORT ?? 7373);
  const host = opts.host ?? process.env.TOOLFORGE_HOST ?? '127.0.0.1';
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(undefined);
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${boundPort}`;
  log.info('hub listening', { url, dataDir: state.dataDir });

  return {
    state,
    server,
    url,
    port: boundPort,
    async close() {
      scheduler.stop();
      // Long-polls and SSE streams hold sockets open indefinitely; without this
      // server.close() would wait for agents that are still parked on a poll.
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await state.store.close();
    },
  };
}

/**
 * Agent routes take a machine token, everything else takes the admin token.
 * @param {any} state
 * @param {import('node:http').IncomingMessage} req
 * @param {string} pathname
 */
function authenticate(state, req, pathname) {
  if (PUBLIC_ROUTES.has(pathname)) return;
  const token = bearerToken(req);
  if (pathname.startsWith('/api/agent/')) {
    const machine = authenticateMachine(state, token);
    if (!machine) throw unauthorized('Invalid machine token');
    req.authenticatedMachine = machine;
    return;
  }
  if (!token || !safeEqual(token, state.adminToken)) throw unauthorized('Invalid admin token');
}

function buildRouter() {
  const router = new Router();
  router.get('/api/health', () => ({ ok: true, service: 'toolforge-hub' }));
  registerAdminRoutes(router);
  registerAgentRoutes(router);
  registerEventRoutes(router);
  return router;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null}
 */
function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const alternate = req.headers['x-toolforge-token'];
  return typeof alternate === 'string' ? alternate.trim() : null;
}

/**
 * @param {string} pathname
 * @param {import('node:http').ServerResponse} res
 */
async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(publicDir, relative);
  if (!file.startsWith(publicDir)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    const extension = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}
