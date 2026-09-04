import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/shared/store.js';
import { tempDir } from './helpers.js';

test('store persists collections across reopen', async () => {
  const dir = await tempDir();
  const file = join(dir, 'nested', 'state.json');

  const store = await Store.open(file, { things: {} }, { flushDelayMs: 0 });
  const things = store.collection('things', 'thing');
  things.insert({ id: 'a', label: 'first' });
  things.update('a', (doc) => {
    doc.label = 'renamed';
  });
  await store.flush();
  await store.close();

  const reopened = await Store.open(file, { things: {} });
  assert.equal(reopened.collection('things', 'thing').get('a').label, 'renamed');
  await reopened.close();
  await rm(dir, { recursive: true, force: true });
});

test('store writes valid JSON atomically and leaves no temp file', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const store = await Store.open(file, { things: {} }, { flushDelayMs: 0 });
  store.collection('things', 'thing').insert({ id: 'x', n: 1 });
  await store.flush();

  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.things.x.n, 1);
  await assert.rejects(() => readFile(`${file}.tmp`, 'utf8'));
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('store falls back to defaults when the file is corrupt', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, '{ this is not json', 'utf8');

  const store = await Store.open(file, { things: {}, version: 3 });
  assert.deepEqual(store.data.things, {});
  assert.equal(store.data.version, 3);
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test('collection.require throws a 404-shaped error', async () => {
  const dir = await tempDir();
  const store = await Store.open(join(dir, 'state.json'), { things: {} });
  const things = store.collection('things', 'thing');
  assert.throws(() => things.require('missing'), (error) => error.status === 404);
  await store.close();
  await rm(dir, { recursive: true, force: true });
});
