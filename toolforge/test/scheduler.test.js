import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyToolSpec } from '../src/hub/core/planner.js';
import { candidatesFor, explain, reapLeases, tick } from '../src/hub/core/scheduler.js';
import { claimAssignedWork, completeTask } from '../src/hub/core/execution.js';
import { makeState, onlineMachine, sampleSpec } from './helpers.js';

/** Convenience: the task with this ref. */
const byRef = (state, ref) => state.tasks.find((task) => task.ref === ref);

/** Drive one task all the way through a machine, succeeding. */
async function runOne(state, machine, ref) {
  tick(state);
  const orders = claimAssignedWork(state, machine, 8);
  const order = orders.find((entry) => entry.ref === ref);
  assert.ok(order, `expected ${ref} to be dispatched to ${machine.name}`);
  await completeTask(state, machine, {
    taskId: order.taskId,
    leaseId: order.leaseId,
    exitCode: 0,
    durationMs: 10,
  });
}

test('auto mode dispatches ready tasks to the pool', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const machine = onlineMachine(state, { name: 'pool-1' });
  applyToolSpec(state, sampleSpec());

  const result = tick(state);
  assert.equal(result.assigned, 1);
  assert.equal(byRef(state, 'backend:scaffold').assignment.machineId, machine.id);
  assert.equal(byRef(state, 'backend:api').status, 'pending');
});

test('dependencies unlock in order across teams', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const machine = onlineMachine(state, { maxConcurrency: 4 });
  const { tool } = applyToolSpec(state, sampleSpec());

  await runOne(state, machine, 'backend:scaffold');
  await runOne(state, machine, 'backend:api');
  await runOne(state, machine, 'qa:smoke');

  assert.equal(state.tools.require(tool.id).status, 'succeeded');
});

test('pinned mode only ever uses the attached machines', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const pinned = onlineMachine(state, { name: 'pinned-1' });
  onlineMachine(state, { name: 'other-1' });
  applyToolSpec(
    state,
    sampleSpec({ dispatch: { mode: 'pinned', machines: [pinned.id], failoverToPool: false } }),
  );

  tick(state);
  assert.equal(byRef(state, 'backend:scaffold').assignment.machineId, pinned.id);
});

test('pinned mode without failover waits instead of using the pool', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const pinned = onlineMachine(state, { name: 'pinned-1' });
  onlineMachine(state, { name: 'other-1' });
  applyToolSpec(
    state,
    sampleSpec({ dispatch: { mode: 'pinned', machines: [pinned.id], failoverToPool: false } }),
  );

  // The pinned machine goes away entirely.
  state.machines.update(pinned.id, (doc) => {
    doc.status = 'offline';
  });

  assert.equal(tick(state).assigned, 0);
  const task = byRef(state, 'backend:scaffold');
  assert.equal(task.status, 'ready');

  const report = explain(state, task);
  assert.match(report.blockers.join(' '), /no pinned machine is available/);
});

test('hybrid mode prefers pinned machines but falls back to the pool', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const pinned = onlineMachine(state, { name: 'pinned-1' });
  const spare = onlineMachine(state, { name: 'spare-1' });
  applyToolSpec(state, sampleSpec({ dispatch: { mode: 'hybrid', machines: [pinned.id] } }));

  tick(state);
  assert.equal(byRef(state, 'backend:scaffold').assignment.machineId, pinned.id);

  // Pinned machine drops out mid-run; the lease reaper releases the task and
  // the next tick reroutes it to the spare.
  state.machines.update(pinned.id, (doc) => {
    doc.status = 'offline';
  });
  reapLeases(state);
  assert.equal(byRef(state, 'backend:scaffold').status, 'ready');

  tick(state);
  assert.equal(byRef(state, 'backend:scaffold').assignment.machineId, spare.id);
});

test('a machine that stops heartbeating loses its work to another machine', async (t) => {
  const { state, cleanup } = await makeState({ heartbeatTimeoutMs: 20 });
  t.after(cleanup);

  const flaky = onlineMachine(state, { name: 'flaky' });
  applyToolSpec(state, sampleSpec());
  tick(state);
  assert.equal(byRef(state, 'backend:scaffold').assignment.machineId, flaky.id);

  const rescue = onlineMachine(state, { name: 'rescue' });
  // Age the flaky machine's heartbeat past the timeout.
  state.machines.update(flaky.id, (doc) => {
    doc.lastHeartbeatAt = new Date(Date.now() - 60_000).toISOString();
  });

  const result = tick(state);
  assert.equal(result.offlined, 1);
  assert.equal(result.released, 1);

  tick(state);
  const task = byRef(state, 'backend:scaffold');
  assert.equal(task.assignment.machineId, rescue.id);
  assert.equal(task.attempt, 2);
  assert.deepEqual(task.avoidMachineIds, [flaky.id]);
});

test('requirements exclude machines that cannot run the task', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  onlineMachine(state, {
    name: 'linux-box',
    capabilities: { os: 'linux', arch: 'x64', cpus: 4, memGb: 8, tools: { node: '22' } },
  });
  const windows = onlineMachine(state, {
    name: 'windows-box',
    tags: ['windows'],
    capabilities: { os: 'win32', arch: 'x64', cpus: 8, memGb: 32, tools: { node: '22' } },
  });

  applyToolSpec(
    state,
    sampleSpec({
      teams: [
        {
          key: 'build',
          tasks: [{ key: 'exe', run: 'echo build', requires: { os: 'win32', tags: ['windows'] } }],
        },
      ],
    }),
  );

  tick(state);
  assert.equal(byRef(state, 'build:exe').assignment.machineId, windows.id);

  const report = explain(state, byRef(state, 'build:exe'));
  assert.ok(report.rejected.some((entry) => entry.reason.includes('os linux')));
});

test('a task retries on a different machine after a failure', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const first = onlineMachine(state, { name: 'first' });
  const second = onlineMachine(state, { name: 'second' });
  applyToolSpec(state, sampleSpec());

  tick(state);
  const [order] = claimAssignedWork(
    state,
    byRef(state, 'backend:scaffold').assignment.machineId === first.id ? first : second,
    1,
  );
  const ranOn = state.machines.get(byRef(state, 'backend:scaffold').assignment.machineId);
  await completeTask(state, ranOn, {
    taskId: order.taskId,
    leaseId: order.leaseId,
    exitCode: 1,
    durationMs: 5,
    logTail: 'boom',
  });

  const failed = byRef(state, 'backend:scaffold');
  assert.equal(failed.status, 'ready');
  assert.deepEqual(failed.avoidMachineIds, [ranOn.id]);

  tick(state);
  const retried = byRef(state, 'backend:scaffold');
  assert.notEqual(retried.assignment.machineId, ranOn.id);
  assert.equal(retried.attempt, 2);
});

test('a task fails for good once it runs out of attempts', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const machine = onlineMachine(state, { name: 'only' });
  applyToolSpec(
    state,
    sampleSpec({
      teams: [{ key: 'build', tasks: [{ key: 'flaky', run: 'exit 1', maxAttempts: 2 }] }],
    }),
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    tick(state);
    const [order] = claimAssignedWork(state, machine, 1);
    await completeTask(state, machine, {
      taskId: order.taskId,
      leaseId: order.leaseId,
      exitCode: 1,
      durationMs: 1,
    });
  }

  const task = byRef(state, 'build:flaky');
  assert.equal(task.status, 'failed');
  assert.equal(task.attempt, 2);
  assert.equal(state.machines.get(machine.id).stats.tasksFailed, 2);
});

test('team concurrency caps how much of one team runs at once', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  onlineMachine(state, { name: 'big', maxConcurrency: 10 });
  applyToolSpec(
    state,
    sampleSpec({
      concurrency: 10,
      teams: [
        {
          key: 'micro',
          concurrency: 2,
          tasks: Array.from({ length: 6 }, (_, index) => ({
            key: `t${index}`,
            run: `echo ${index}`,
          })),
        },
      ],
    }),
  );

  tick(state);
  assert.equal(state.tasks.count((task) => task.status === 'assigned'), 2);
  assert.equal(state.tasks.count((task) => task.status === 'ready'), 4);
});

test('machine concurrency caps how much one machine takes', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  onlineMachine(state, { name: 'small', maxConcurrency: 1 });
  applyToolSpec(
    state,
    sampleSpec({
      teams: [
        {
          key: 'micro',
          concurrency: 10,
          tasks: [
            { key: 'a', run: 'echo a' },
            { key: 'b', run: 'echo b' },
          ],
        },
      ],
    }),
  );

  tick(state);
  assert.equal(state.tasks.count((task) => task.status === 'assigned'), 1);
});

test('scoring prefers reliable, cheap, idle machines', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const good = onlineMachine(state, { name: 'good' });
  const pricey = onlineMachine(state, { name: 'pricey', rental: { pricePerMinute: 5 } });
  state.machines.update(good.id, (doc) => {
    doc.stats.tasksSucceeded = 50;
  });
  state.machines.update(pricey.id, (doc) => {
    doc.stats.tasksFailed = 20;
  });

  applyToolSpec(state, sampleSpec());
  const { eligible } = candidatesFor(state, byRef(state, 'backend:scaffold'));
  assert.equal(eligible[0].machine.id, good.id);
});

test('a paused tool stops dispatching and resumes cleanly', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  onlineMachine(state, { name: 'pool' });
  const { tool } = applyToolSpec(state, sampleSpec());
  state.tools.update(tool.id, (doc) => {
    doc.status = 'paused';
  });

  assert.equal(tick(state).assigned, 0);

  state.tools.update(tool.id, (doc) => {
    doc.status = 'running';
  });
  assert.equal(tick(state).assigned, 1);
});
