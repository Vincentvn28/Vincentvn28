import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/shared/http-client.js';
import { makeHub, sampleSpec, waitFor } from './helpers.js';

test('health is public but everything else needs the admin token', async (t) => {
  const { hub, cleanup } = await makeHub();
  t.after(cleanup);

  const anonymous = new HttpClient({ baseUrl: hub.url, retries: 0 });
  assert.deepEqual(await anonymous.get('/api/health'), { ok: true, service: 'toolforge-hub' });
  await assert.rejects(() => anonymous.get('/api/machines'), (error) => error.status === 401);

  const wrong = new HttpClient({ baseUrl: hub.url, token: 'nope', retries: 0 });
  await assert.rejects(() => wrong.get('/api/machines'), (error) => error.status === 401);
});

test('registering a machine returns a token exactly once', async (t) => {
  const { admin, cleanup } = await makeHub();
  t.after(cleanup);

  const created = await admin.post('/api/machines', { name: 'laptop', tags: ['fast'] });
  assert.match(created.token, /^tfa_/);
  assert.equal(created.machine.name, 'laptop');
  assert.equal(created.machine.tokenHash, undefined, 'the hash must never leave the hub');

  const fetched = await admin.get(`/api/machines/${created.machine.id}`);
  assert.equal(fetched.token, undefined);

  await assert.rejects(
    () => admin.post('/api/machines', { name: 'laptop' }),
    (error) => error.status === 409,
  );
});

test('an agent token authenticates only the agent API', async (t) => {
  const { hub, admin, cleanup } = await makeHub();
  t.after(cleanup);

  const { token } = await admin.post('/api/machines', { name: 'worker' });
  const agent = new HttpClient({ baseUrl: hub.url, token, retries: 0 });

  const beat = await agent.post('/api/agent/heartbeat', { capabilities: { os: 'linux' } });
  assert.equal(beat.machine.status, 'online');
  await assert.rejects(() => agent.get('/api/machines'), (error) => error.status === 401);
});

test('enrollment codes let a machine join by itself', async (t) => {
  const { hub, admin, cleanup } = await makeHub();
  t.after(cleanup);

  const code = await admin.post('/api/enroll-codes', { label: 'friends', maxUses: 1, tags: ['home'] });
  const anonymous = new HttpClient({ baseUrl: hub.url, retries: 0 });

  const joined = await anonymous.post('/api/agent/join', {
    code: code.code,
    name: 'vincent-pc',
    capabilities: { os: 'linux', cpus: 8, memGb: 16, tools: { node: '22' } },
  });
  assert.match(joined.token, /^tfa_/);

  const machine = await admin.get(`/api/machines/${joined.machineId}`);
  assert.deepEqual(machine.tags, ['home']);

  // The code was single-use.
  await assert.rejects(
    () => anonymous.post('/api/agent/join', { code: code.code, name: 'another-pc' }),
    (error) => error.status === 403,
  );
});

test('a revoked enrollment code stops working', async (t) => {
  const { hub, admin, cleanup } = await makeHub();
  t.after(cleanup);

  const code = await admin.post('/api/enroll-codes', { label: 'temporary' });
  await admin.delete(`/api/enroll-codes/${code.id}`);

  const anonymous = new HttpClient({ baseUrl: hub.url, retries: 0 });
  await assert.rejects(
    () => anonymous.post('/api/agent/join', { code: code.code, name: 'late-pc' }),
    (error) => error.status === 403,
  );
});

test('a tool runs end to end over the agent HTTP protocol', async (t) => {
  const { hub, admin, cleanup } = await makeHub();
  t.after(cleanup);

  const { token } = await admin.post('/api/machines', { name: 'worker', maxConcurrency: 4 });
  const agent = new HttpClient({ baseUrl: hub.url, token, retries: 0 });
  await agent.post('/api/agent/heartbeat', {
    capabilities: { os: 'linux', arch: 'x64', cpus: 4, memGb: 8, tools: { node: '22' } },
  });

  const applied = await admin.post('/api/tools', sampleSpec());
  assert.equal(applied.added, 3);
  await admin.post(`/api/tools/demo-tool/start`);

  // Drive the whole graph the way a real agent would.
  for (let step = 0; step < 3; step++) {
    const { tasks } = await waitFor(
      async () => {
        const response = await agent.post('/api/agent/work', { limit: 4, waitMs: 0 });
        return response.tasks.length > 0 ? response : null;
      },
      { label: `work for step ${step}` },
    );
    for (const order of tasks) {
      await agent.post('/api/agent/progress', {
        taskId: order.taskId,
        leaseId: order.leaseId,
        logChunk: `running ${order.ref}\n`,
      });
      await agent.post('/api/agent/complete', {
        taskId: order.taskId,
        leaseId: order.leaseId,
        exitCode: 0,
        durationMs: 12,
        logTail: `done ${order.ref}\n`,
      });
    }
  }

  const tool = await admin.get('/api/tools/demo-tool');
  assert.equal(tool.status, 'succeeded');
  assert.equal(tool.progress.percent, 100);

  const scaffold = tool.teams[0].tasks[0];
  const { log } = await admin.get(`/api/tasks/${scaffold.id}/log`);
  assert.match(log, /running backend:scaffold/);
  assert.match(log, /done backend:scaffold/);
});

test('the hub rejects a stale lease so two machines cannot own one task', async (t) => {
  const { hub, admin, cleanup } = await makeHub();
  t.after(cleanup);

  const { token } = await admin.post('/api/machines', { name: 'worker' });
  const agent = new HttpClient({ baseUrl: hub.url, token, retries: 0 });
  await agent.post('/api/agent/heartbeat', { capabilities: { os: 'linux' } });
  await admin.post('/api/tools', sampleSpec());

  const { tasks } = await waitFor(async () => {
    const response = await agent.post('/api/agent/work', { limit: 1, waitMs: 0 });
    return response.tasks.length ? response : null;
  });
  const [order] = tasks;

  await admin.post(`/api/tasks/${order.taskId}/retry`, {});
  await assert.rejects(
    () =>
      agent.post('/api/agent/complete', {
        taskId: order.taskId,
        leaseId: order.leaseId,
        exitCode: 0,
      }),
    (error) => error.status === 409,
  );
});

test('long-polling returns as soon as work appears', async (t) => {
  const { hub, admin, cleanup } = await makeHub();
  t.after(cleanup);

  const { token } = await admin.post('/api/machines', { name: 'poller' });
  const agent = new HttpClient({ baseUrl: hub.url, token, retries: 0 });
  await agent.post('/api/agent/heartbeat', { capabilities: { os: 'linux' } });

  const startedAt = Date.now();
  const pending = agent.post('/api/agent/work', { limit: 1, waitMs: 5_000 }, { timeoutMs: 20_000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await admin.post('/api/tools', sampleSpec());

  const { tasks } = await pending;
  assert.equal(tasks.length, 1);
  assert.ok(Date.now() - startedAt < 4_000, 'the poll should return early, not wait the full 5s');
});

test('cancelling a tool cancels its unfinished tasks', async (t) => {
  const { admin, cleanup } = await makeHub();
  t.after(cleanup);

  await admin.post('/api/tools', sampleSpec());
  const cancelled = await admin.post('/api/tools/demo-tool/cancel');
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.teams.every((team) => team.tasks.every((task) => task.status === 'cancelled')));
});

test('the rental ledger bills busy time at the machine price', async (t) => {
  const { hub, admin, cleanup } = await makeHub();
  t.after(cleanup);

  const { token, machine } = await admin.post('/api/machines', {
    name: 'rental',
    pricePerMinute: 0.6,
    maxConcurrency: 2,
  });
  const agent = new HttpClient({ baseUrl: hub.url, token, retries: 0 });
  await agent.post('/api/agent/heartbeat', { capabilities: { os: 'linux' } });
  await admin.post('/api/tools', sampleSpec());

  const { tasks } = await waitFor(async () => {
    const response = await agent.post('/api/agent/work', { limit: 1, waitMs: 0 });
    return response.tasks.length ? response : null;
  });
  await agent.post('/api/agent/complete', {
    taskId: tasks[0].taskId,
    leaseId: tasks[0].leaseId,
    exitCode: 0,
    durationMs: 60_000,
  });

  const usage = await admin.get('/api/usage', { machine: machine.id });
  assert.equal(usage.records.length, 1);
  assert.equal(usage.totals.amount, 0.6, 'one minute at 0.6/min');
});

test('the event stream reports what the scheduler did', async (t) => {
  const { hub, admin, cleanup } = await makeHub();
  t.after(cleanup);

  const { token } = await admin.post('/api/machines', { name: 'worker' });
  const agent = new HttpClient({ baseUrl: hub.url, token, retries: 0 });
  await agent.post('/api/agent/heartbeat', { capabilities: { os: 'linux' } });
  await admin.post('/api/tools', sampleSpec());
  await agent.post('/api/agent/work', { limit: 1, waitMs: 0 });

  const events = await admin.get('/api/events/recent');
  const types = events.map((event) => event.type);
  assert.ok(types.includes('machine.registered'));
  assert.ok(types.includes('tool.created'));
  assert.ok(types.includes('task.assigned'));
  assert.ok(types.includes('task.started'));
});

test('the dashboard is served at the root', async (t) => {
  const { hub, cleanup } = await makeHub();
  t.after(cleanup);

  const response = await fetch(hub.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /ToolForge/);
});

test('a settled long poll never strands a task in "running"', async (t) => {
  const { hub, admin, cleanup } = await makeHub();
  t.after(cleanup);

  const { token } = await admin.post('/api/machines', { name: 'wide' });
  const agent = new HttpClient({ baseUrl: hub.url, token, retries: 0 });
  // The machine has four slots, so the scheduler will assign both tasks at once…
  await agent.post('/api/agent/heartbeat', { capabilities: { os: 'linux' }, maxConcurrency: 4 });

  // …but this poll only has room for one, which is the case that used to leave
  // the second task marked `running` with nobody executing it.
  const pending = agent.post('/api/agent/work', { limit: 1, waitMs: 5_000 }, { timeoutMs: 20_000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await admin.post('/api/tools', {
    key: 'parallel-app',
    teams: [
      {
        key: 'build',
        concurrency: 4,
        tasks: [
          { key: 'a', run: 'echo a' },
          { key: 'b', run: 'echo b' },
        ],
      },
    ],
  });

  const { tasks } = await pending;
  assert.equal(tasks.length, 1);

  const delivered = new Set(tasks.map((order) => order.taskId));
  const running = await admin.get('/api/tasks', { status: 'running' });
  assert.deepEqual(
    running.filter((task) => !delivered.has(task.id)).map((task) => task.ref),
    [],
    'no task may be running that the agent never received',
  );

  // The task the poll could not take is still queued for the next one.
  const assigned = await admin.get('/api/tasks', { status: 'assigned' });
  assert.equal(assigned.length + running.length, 2);
});

test('an invalid machine patch changes nothing', async (t) => {
  const { admin, cleanup } = await makeHub();
  t.after(cleanup);

  const { machine } = await admin.post('/api/machines', { name: 'picky', tags: ['keep'] });
  await assert.rejects(
    () => admin.patch(`/api/machines/${machine.id}`, { tags: ['ok'], status: 'not-a-status' }),
    (error) => error.status === 400,
  );

  const after = await admin.get(`/api/machines/${machine.id}`);
  assert.deepEqual(after.tags, ['keep'], 'the valid field must not be applied either');
  assert.equal(after.status, 'offline');
});
