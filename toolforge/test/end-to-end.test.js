import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Agent } from '../src/agent/agent.js';
import { defaultAgentConfig } from '../src/agent/config.js';
import { makeHub, waitFor } from './helpers.js';

/**
 * Start a real agent against a real hub and let it work until stopped.
 * @param {any} hub
 * @param {string} token
 * @param {any} [overrides]
 */
function startAgent(hub, token, overrides = {}) {
  const agent = new Agent(
    defaultAgentConfig({
      hubUrl: hub.url,
      token,
      heartbeatIntervalMs: 300,
      pollWaitMs: 500,
      logFlushMs: 100,
      ...overrides,
    }),
  );
  // start() only settles when the agent stops, so it is intentionally not awaited.
  const finished = agent.start().catch(() => {});
  return { agent, finished };
}

test('a real agent builds a tool from end to end', async (t) => {
  const { hub, admin, dir, cleanup } = await makeHub();
  const { token } = await admin.post('/api/machines', { name: 'e2e-worker' });
  const { agent, finished } = startAgent(hub, token, {
    workdir: join(dir, 'work'),
    maxConcurrency: 3,
  });
  t.after(async () => {
    await agent.stop({ waitMs: 2_000 });
    await finished;
    await cleanup();
  });

  await admin.post('/api/tools', {
    key: 'hello-app',
    name: 'Hello App',
    concurrency: 4,
    dispatch: { mode: 'auto' },
    teams: [
      {
        key: 'setup',
        name: 'Setup',
        tasks: [{ key: 'mkdir', run: 'mkdir -p out && echo scaffolded > out/step1.txt' }],
      },
      {
        key: 'build',
        name: 'Build',
        concurrency: 2,
        tasks: [
          { key: 'a', run: 'echo built-a >> out/step2.txt', dependsOn: ['setup:mkdir'] },
          { key: 'b', argv: ['node', '-e', 'console.log("built-b")'], dependsOn: ['setup:mkdir'] },
        ],
      },
      {
        key: 'qa',
        name: 'QA',
        tasks: [{ key: 'verify', run: 'grep -q built-a out/step2.txt', dependsOn: ['build:a', 'build:b'] }],
      },
    ],
  });

  const tool = await waitFor(
    async () => {
      const current = await admin.get('/api/tools/hello-app');
      return current.status === 'succeeded' || current.status === 'failed' ? current : null;
    },
    { timeoutMs: 30_000, label: 'tool to finish' },
  );

  assert.equal(tool.status, 'succeeded', JSON.stringify(tool.progress));
  assert.equal(tool.progress.succeeded, 4);

  // The agent really ran the commands, in the tool's own working directory.
  const scaffolded = await readFile(join(dir, 'work', 'hello-app', 'out', 'step1.txt'), 'utf8');
  assert.match(scaffolded, /scaffolded/);

  // And the hub captured stdout for a task run through argv rather than a shell.
  const buildB = tool.teams[1].tasks.find((task) => task.key === 'b');
  const { log } = await admin.get(`/api/tasks/${buildB.id}/log`);
  assert.match(log, /built-b/);
});

test('a failing command is retried and finally reported as failed', async (t) => {
  const { hub, admin, dir, cleanup } = await makeHub();
  const { token } = await admin.post('/api/machines', { name: 'e2e-fail' });
  const { agent, finished } = startAgent(hub, token, { workdir: join(dir, 'work') });
  t.after(async () => {
    await agent.stop({ waitMs: 2_000 });
    await finished;
    await cleanup();
  });

  await admin.post('/api/tools', {
    key: 'broken-app',
    teams: [
      {
        key: 'build',
        tasks: [
          { key: 'boom', run: 'echo "this will fail" >&2; exit 3', maxAttempts: 2 },
          { key: 'after', run: 'echo never', dependsOn: ['boom'] },
        ],
      },
    ],
  });

  const tool = await waitFor(
    async () => {
      const current = await admin.get('/api/tools/broken-app');
      return current.status === 'failed' ? current : null;
    },
    { timeoutMs: 30_000, label: 'tool to fail' },
  );

  const boom = tool.teams[0].tasks.find((task) => task.key === 'boom');
  const after = tool.teams[0].tasks.find((task) => task.key === 'after');
  assert.equal(boom.status, 'failed');
  assert.equal(boom.attempt, 2, 'it should have used both attempts');
  assert.equal(boom.result.exitCode, 3);
  assert.equal(after.status, 'blocked');

  const { log } = await admin.get(`/api/tasks/${boom.id}/log`);
  assert.match(log, /this will fail/);
});

test('a task that overruns its timeout is killed and reported', async (t) => {
  const { hub, admin, dir, cleanup } = await makeHub();
  const { token } = await admin.post('/api/machines', { name: 'e2e-timeout' });
  const { agent, finished } = startAgent(hub, token, { workdir: join(dir, 'work') });
  t.after(async () => {
    await agent.stop({ waitMs: 2_000 });
    await finished;
    await cleanup();
  });

  await admin.post('/api/tools', {
    key: 'slow-app',
    teams: [
      {
        key: 'build',
        tasks: [{ key: 'sleepy', run: 'sleep 30', timeoutMs: 1_000, maxAttempts: 1 }],
      },
    ],
  });

  const tool = await waitFor(
    async () => {
      const current = await admin.get('/api/tools/slow-app');
      return current.status === 'failed' ? current : null;
    },
    { timeoutMs: 30_000, label: 'timeout to be reported' },
  );

  const task = tool.teams[0].tasks[0];
  assert.equal(task.status, 'failed');
  assert.equal(task.result.exitCode, 124);
  assert.match(task.result.error, /timed out/);
});

test('work moves to a second machine when the first one leaves mid-build', async (t) => {
  const { hub, admin, dir, cleanup } = await makeHub({ heartbeatTimeoutMs: 1_500 });
  const first = await admin.post('/api/machines', { name: 'leaver', maxConcurrency: 1 });
  const second = await admin.post('/api/machines', { name: 'stayer', maxConcurrency: 1 });

  const leaver = startAgent(hub, first.token, { workdir: join(dir, 'work-1') });
  await waitFor(async () => (await admin.get(`/api/machines/${first.machine.id}`)).status === 'online');

  await admin.post('/api/tools', {
    key: 'failover-app',
    dispatch: { mode: 'auto' },
    teams: [{ key: 'build', tasks: [{ key: 'slow', run: 'sleep 10', timeoutMs: 20_000 }] }],
  });

  // Wait until the first machine is actually running the task, then yank it.
  await waitFor(
    async () => {
      const tasks = await admin.get('/api/tasks', { machine: first.machine.id, status: 'running' });
      return tasks.length === 1;
    },
    { timeoutMs: 15_000, label: 'first machine to start the task' },
  );

  // Simulate a hard disappearance: no drain, no goodbye, just gone.
  leaver.agent.stopping = true;
  clearInterval(leaver.agent.heartbeatTimer);
  leaver.agent.lifecycle.abort();

  const stayer = startAgent(hub, second.token, { workdir: join(dir, 'work-2') });
  // Agents first, hub second: shutting the hub first would strand their polls.
  t.after(async () => {
    for (const { controller } of leaver.agent.running.values()) controller.abort();
    await stayer.agent.stop({ waitMs: 2_000 });
    await Promise.all([leaver.finished, stayer.finished]);
    await cleanup();
  });

  const rerouted = await waitFor(
    async () => {
      const tasks = await admin.get('/api/tasks', { machine: second.machine.id });
      return tasks.find((task) => task.status === 'running' || task.status === 'assigned') ?? null;
    },
    { timeoutMs: 25_000, label: 'task to be rerouted to the second machine' },
  );

  assert.equal(rerouted.ref, 'build:slow');
  assert.equal(rerouted.attempt, 2, 'the reroute counts as a second attempt');
  assert.deepEqual(rerouted.avoidMachineIds, [first.machine.id]);

  const dropped = await admin.get(`/api/machines/${first.machine.id}`);
  assert.equal(dropped.status, 'offline');
  assert.equal(dropped.stats.tasksAbandoned, 1);
});
