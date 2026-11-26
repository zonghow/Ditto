import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, stat } from 'node:fs/promises';
import { SessionTabsStore, normalizeRestorableUrl } from '../src/session-tabs.js';

test('normalizeRestorableUrl keeps http/https pages and filters blanks, credentials, internal schemes and Ditto viewer', () => {
  assert.equal(normalizeRestorableUrl('https://example.com/a?x=1#top'), 'https://example.com/a?x=1#top');
  assert.equal(normalizeRestorableUrl('about:blank'), null);
  assert.equal(normalizeRestorableUrl('chrome://settings'), null);
  assert.equal(normalizeRestorableUrl('https://user:pass@example.com/'), null);
  assert.equal(normalizeRestorableUrl('http://127.0.0.1:3217/'), null);
  assert.equal(normalizeRestorableUrl('http://127.0.0.1:3217/demo.html'), null);
  assert.equal(normalizeRestorableUrl('http://127.0.0.1:4100/app', 3217), 'http://127.0.0.1:4100/app');
});

test('SessionTabsStore persists open tabs in order with activeIndex, deduplicates unchanged writes, and restores cleanly', async () => {
  const dir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-tabs-store-'));
  const store = new SessionTabsStore(dir, { port: 3217 });
  assert.deepEqual(await store.load(), { activeIndex: 0, tabs: [] });

  const tabs = [
    { id: 't1', hidden: false, crashed: false, title: 'First Page', url: 'https://a.example.test/one', page: { isClosed: () => false, url: () => 'https://a.example.test/one' } },
    { id: 't2', hidden: false, crashed: false, title: '新标签页', url: 'about:blank', page: { isClosed: () => false, url: () => 'about:blank' } },
    { id: 't3', hidden: false, crashed: false, title: 'Second Page', url: 'https://b.example.test/two', page: { isClosed: () => false, url: () => 'https://b.example.test/two' } },
    { id: 't4', hidden: true, crashed: false, title: 'Hidden', url: 'https://hidden.example.test/', page: { isClosed: () => false, url: () => 'https://hidden.example.test/' } },
  ];
  assert.equal(store.update(tabs, 't3', { immediate: true }), true);
  // Identical state does not trigger redundant write.
  assert.equal(store.update(tabs, 't3', { immediate: true }), false);
  await store.flush();

  const fileMode = (await stat(path.join(dir, 'tabs.json'))).mode & 0o777;
  assert.equal(fileMode, 0o600);

  const reloaded = new SessionTabsStore(dir, { port: 3217 });
  assert.deepEqual(await reloaded.load(), {
    activeIndex: 1,
    tabs: [
      { url: 'https://a.example.test/one', title: 'First Page' },
      { url: 'https://b.example.test/two', title: 'Second Page' },
    ],
  });

  // Pending restore URL is retained even if Chromium hasn't left about:blank yet during rapid double-restart.
  const midRestore = [
    { id: 'r1', hidden: false, crashed: false, title: 'First Page', url: 'https://a.example.test/one', pendingRestoreUrl: 'https://a.example.test/one', page: { isClosed: () => false, url: () => 'about:blank' } },
  ];
  assert.equal(reloaded.update(midRestore, 'r1', { immediate: true }), true);
  await reloaded.flush();
  const reloaded2 = new SessionTabsStore(dir, { port: 3217 });
  assert.deepEqual(await reloaded2.load(), {
    activeIndex: 0,
    tabs: [{ url: 'https://a.example.test/one', title: 'First Page' }],
  });
});
