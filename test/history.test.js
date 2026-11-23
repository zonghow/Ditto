import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../src/history.js';

test('HistoryStore records, ranks host prefix ahead of path, persists, and deletes entries', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ditto-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new HistoryStore(dir);
  await store.load();
  assert.equal(store.record('about:blank', 'New Tab'), false);
  assert.equal(store.record('javascript:alert(1)', 'Bad'), false);
  assert.equal(store.record('https://user:pass@secret.test/', 'Creds'), false);

  assert.equal(store.record('https://cloud.example.test/services/data-analytics', 'Cloud Service'), true);
  assert.equal(store.record('https://data.example.test/tea-next/project/1', '行为分析系统'), true);
  assert.equal(store.record('https://data.example.test/dorado/node/42?project=cn_1868', '任务开发 - Dorado'), true);

  const matched = store.search('data', 8);
  assert.equal(matched.length, 3);
  assert.match(matched[0].url, /^https:\/\/data\.example\.test\//);
  assert.match(matched[1].url, /^https:\/\/data\.example\.test\//);

  const multiToken = store.search('data dorado', 8);
  assert.equal(multiToken.length, 1);
  assert.equal(multiToken[0].url, 'https://data.example.test/dorado/node/42?project=cn_1868');

  const chineseTitle = store.search('行为分析', 8);
  assert.equal(chineseTitle.length, 1);
  assert.equal(chineseTitle[0].title, '行为分析系统');

  await store.flush();

  const reloaded = new HistoryStore(dir);
  await reloaded.load();
  assert.equal(reloaded.search('data', 8).length, 3);

  assert.equal(reloaded.remove('https://data.example.test/tea-next/project/1'), true);
  await reloaded.flush();
  assert.equal(reloaded.search('行为分析', 8).length, 0);
});
