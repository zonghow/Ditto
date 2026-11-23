import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { SyncStore } from '../src/sync-store.js';

function snapshot(label) {
  return { schemaVersion: 1, source: 'extension', collectedAt: new Date().toISOString(),
    cookies: [{ name: 'test', value: label, url: 'https://example.com/', path: '/' }],
    origins: [], warnings: [] };
}

test('pending snapshot revision prevents applying a stale upload', async () => {
  const dir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-sync-'));
  const store = new SyncStore(dir);
  await store.load();
  const first = await store.receive(snapshot('first'));
  const second = await store.receive(snapshot('second'));
  let called = false;
  const browser = { ready: true, importSnapshot: async () => { called = true; } };
  await assert.rejects(store.apply(first.id, browser), error => error.status === 409);
  assert.equal(called, false);
  assert.equal(store.pending.id, second.id);
});

test('upload and apply serialize, so new pending data is not accidentally deleted', async () => {
  const dir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-sync-'));
  const store = new SyncStore(dir);
  const first = await store.receive(snapshot('first'));
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const browser = { ready: true, importSnapshot: async data => {
    assert.equal(data.cookies[0].value, 'first');
    await waiting;
    return { importedCookies: 1, importedStorage: 0, importedOrigins: 0, importWarnings: [] };
  } };
  const apply = store.apply(first.id, browser);
  const upload = store.receive(snapshot('second'));
  release();
  await apply;
  const second = await upload;
  assert.equal(store.pending.id, second.id);
  const reloaded = new SyncStore(dir);
  await reloaded.load();
  assert.equal(reloaded.pending.id, second.id);
  assert.equal(reloaded.applied.id, first.id);
});

test('an unfinished upload is written automatically once Chromium is ready', async () => {
  const dir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-sync-'));
  const store = new SyncStore(dir);
  await store.receive(snapshot('synthetic'));
  await assert.rejects(store.apply(undefined, { ready: false, importSnapshot: async () => { throw new Error('not ready'); } }), error => error.status === 503);
  assert.ok(store.pending);
  const applied = await store.apply(undefined, { ready: true, importSnapshot: async () => ({ importedCookies: 1, importedStorage: 0, importedOrigins: 0, importWarnings: [] }) });
  assert.equal(applied.importedCookies, 1);
  assert.equal(store.pending, null);
});

test('failed Chromium import retains pending data for an explicit retry', async () => {
  const dir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-sync-'));
  const store = new SyncStore(dir);
  const pending = await store.receive(snapshot('synthetic'));
  await assert.rejects(store.apply(pending.id, { ready: true, importSnapshot: async () => { throw new Error('Synthetic failure'); } }));
  assert.equal(store.pending.id, pending.id);
  assert.equal(store.applied, null);
});
