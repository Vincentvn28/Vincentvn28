import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyToolSpec, describeTool, parseToolSpec, refreshTool } from '../src/hub/core/planner.js';
import { makeState, sampleSpec } from './helpers.js';

test('parseToolSpec resolves same-team and cross-team dependencies', () => {
  const spec = parseToolSpec(sampleSpec());
  const api = spec.teams[0].tasks[1];
  const smoke = spec.teams[1].tasks[0];
  assert.deepEqual(api.dependsOn, ['backend:scaffold']);
  assert.deepEqual(smoke.dependsOn, ['backend:api']);
});

test('parseToolSpec rejects an unknown dependency', () => {
  assert.throws(
    () =>
      parseToolSpec(
        sampleSpec({
          teams: [
            { key: 'a', tasks: [{ key: 'one', run: 'echo 1', dependsOn: ['nope'] }] },
          ],
        }),
      ),
    /depends on unknown task "nope"/,
  );
});

test('parseToolSpec rejects a dependency cycle', () => {
  assert.throws(
    () =>
      parseToolSpec(
        sampleSpec({
          teams: [
            {
              key: 'a',
              tasks: [
                { key: 'one', run: 'echo 1', dependsOn: ['two'] },
                { key: 'two', run: 'echo 2', dependsOn: ['one'] },
              ],
            },
          ],
        }),
      ),
    /Dependency cycle detected/,
  );
});

test('parseToolSpec requires a runnable command', () => {
  assert.throws(
    () => parseToolSpec(sampleSpec({ teams: [{ key: 'a', tasks: [{ key: 'one' }] }] })),
    /needs either "run"/,
  );
});

test('parseToolSpec normalises shell and argv commands', () => {
  const spec = parseToolSpec(
    sampleSpec({
      teams: [
        {
          key: 'a',
          tasks: [
            { key: 'shell', run: 'echo hi' },
            { key: 'argv', argv: ['node', '-e', 'console.log(1)'] },
          ],
        },
      ],
    }),
  );
  assert.equal(spec.teams[0].tasks[0].shell, true);
  assert.deepEqual(spec.teams[0].tasks[1].command, ['node', '-e', 'console.log(1)']);
  assert.equal(spec.teams[0].tasks[1].shell, false);
});

test('applyToolSpec creates the tool graph and marks entry tasks ready', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const { tool, created, added } = applyToolSpec(state, sampleSpec());
  assert.equal(created, true);
  assert.equal(added, 3);

  const described = describeTool(state, tool.id);
  assert.equal(described.teams.length, 2);
  assert.equal(described.progress.total, 3);

  const byRef = Object.fromEntries(
    state.tasks.list().map((task) => [task.ref, task]),
  );
  assert.equal(byRef['backend:scaffold'].status, 'ready');
  assert.equal(byRef['backend:api'].status, 'pending');
  assert.equal(byRef['qa:smoke'].status, 'pending');
});

test('re-applying a spec is idempotent and keeps task ids', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const first = applyToolSpec(state, sampleSpec());
  const idsBefore = state.tasks.list().map((task) => task.id).sort();

  const second = applyToolSpec(state, sampleSpec({ name: 'Renamed' }));
  const idsAfter = state.tasks.list().map((task) => task.id).sort();

  assert.equal(second.created, false);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 3);
  assert.equal(second.tool.id, first.tool.id);
  assert.deepEqual(idsAfter, idsBefore);
  assert.equal(second.tool.name, 'Renamed');
});

test('removing a task from the spec deletes it', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  applyToolSpec(state, sampleSpec());
  const trimmed = applyToolSpec(state, {
    key: 'demo-tool',
    teams: [{ key: 'backend', tasks: [{ key: 'scaffold', run: 'echo scaffold' }] }],
  });
  assert.equal(trimmed.removed, 2);
  assert.equal(state.tasks.count(), 1);
  assert.equal(state.teams.count(), 1);
});

test('a failed dependency blocks everything downstream', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const { tool } = applyToolSpec(state, sampleSpec());
  const scaffold = state.tasks.find((task) => task.ref === 'backend:scaffold');
  state.tasks.update(scaffold.id, (doc) => {
    doc.status = 'failed';
  });
  refreshTool(state, tool.id);

  assert.equal(state.tasks.find((task) => task.ref === 'backend:api').status, 'blocked');
  assert.equal(state.tasks.find((task) => task.ref === 'qa:smoke').status, 'blocked');
  assert.equal(state.tools.require(tool.id).status, 'failed');
});

test('a tool succeeds once every task succeeds', async (t) => {
  const { state, cleanup } = await makeState();
  t.after(cleanup);

  const { tool } = applyToolSpec(state, sampleSpec());
  for (const task of state.tasks.list()) {
    state.tasks.update(task.id, (doc) => {
      doc.status = 'succeeded';
    });
  }
  refreshTool(state, tool.id);
  assert.equal(state.tools.require(tool.id).status, 'succeeded');
  assert.equal(describeTool(state, tool.id).progress.percent, 100);
});
