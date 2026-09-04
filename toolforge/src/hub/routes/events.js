import { optionalNumber } from '../../shared/validate.js';
import { overview } from './admin.js';

/**
 * Server-sent events for the dashboard and `toolforge watch`.
 * @param {import('../router.js').Router} router
 */
export function registerEventRoutes(router) {
  router.get('/api/events', ({ state, res, req, query }) => {
    const after = optionalNumber(query.after, 'after', { min: 0, fallback: 0 });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event) => {
      if (res.writableEnded) return;
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    send({ seq: 0, type: 'hello', ts: new Date().toISOString(), data: overview(state) });
    for (const event of state.events.since(after)) send(event);

    const unsubscribe = state.events.subscribe(send);
    // Proxies drop idle connections; a comment frame keeps the stream warm.
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 20_000);
    keepAlive.unref?.();

    const close = () => {
      clearInterval(keepAlive);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    req.once('close', close);
    res.once('error', close);
  });

  router.get('/api/events/recent', ({ state, query }) =>
    state.events.since(
      optionalNumber(query.after, 'after', { min: 0, fallback: 0 }),
      optionalNumber(query.limit, 'limit', { min: 1, max: 500, fallback: 100 }),
    ),
  );
}
