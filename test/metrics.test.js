import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProcStatus,
  parseSmapsRollup,
  parsePsOutput,
  filterDescendantTree,
  classifyProcess,
  collectMemoryMetrics,
} from '../src/metrics.js';

test('parses Linux /proc status and smaps_rollup memory fields cleanly', () => {
  const status = parseProcStatus('Name:\tchromium\nPPid:\t57\nVmRSS:\t204800 kB\nVmSwap:\t1024 kB\n');
  assert.deepEqual(status, {
    name: 'chromium',
    ppid: 57,
    rssBytes: 204800 * 1024,
    swapBytes: 1024 * 1024,
  });
  assert.equal(parseSmapsRollup('Rss: 204800 kB\nPss: 150000 kB\n'), 150000 * 1024);
  assert.equal(parseSmapsRollup(null), null);
});

test('parses POSIX ps output and scopes metrics strictly to Ditto process tree', () => {
  const parsed = parsePsOutput([
    '  100    1  80000 /usr/local/bin/node /app/src/main.js',
    '  200  100 150000 /usr/bin/chromium --remote-debugging-port=9222',
    '  201  200 300000 /usr/bin/chromium --type=renderer',
    '  999    1 500000 /usr/bin/unrelated-app --secret=123',
  ].join('\n'));
  assert.equal(parsed.length, 4);
  const tree = filterDescendantTree(parsed, [100]);
  assert.deepEqual(tree.map(p => p.pid), [100, 200, 201]);
  assert.deepEqual(classifyProcess(tree[0], 100), { category: 'service', label: 'Ditto 服务 (Node)' });
  assert.deepEqual(classifyProcess(tree[1], 100), { category: 'browser', label: '浏览器主进程' });
  assert.deepEqual(classifyProcess(tree[2], 100), { category: 'renderer', label: '网页渲染进程' });
});

test('collectMemoryMetrics aggregates PSS totals, categories, and Ditto caches without leaking command lines', async () => {
  const fakeTabs = new Map([
    ['t1', { id: 't1', title: 'Docs', url: 'https://example.com/secret?token=abc', hidden: false, recording: { bytes: 12000 } }],
    ['t2', { id: 't2', title: 'Hidden', url: 'https://hidden.example', hidden: true, recording: { bytes: 9999 } }],
  ]);
  const fakeBrowser = {
    tabs: fakeTabs,
    assets: { bytes: 45000, entries: new Map([['a1', {}], ['a2', {}]]) },
  };
  const data = await collectMemoryMetrics({
    browser: fakeBrowser,
    pid: 10,
    readProcesses: async () => [
      { pid: 10, ppid: 1, name: 'node', rssBytes: 120_000_000, pssBytes: 100_000_000, swapBytes: 0, cmdline: 'node src/main.js' },
      { pid: 20, ppid: 10, name: 'chromium', rssBytes: 180_000_000, pssBytes: 110_000_000, swapBytes: 0, cmdline: 'chromium --user-data-dir=/data' },
      { pid: 21, ppid: 20, name: 'chromium', rssBytes: 400_000_000, pssBytes: 300_000_000, swapBytes: 5_000_000, cmdline: 'chromium --type=renderer' },
      { pid: 22, ppid: 20, name: 'chromium', rssBytes: 60_000_000, pssBytes: 30_000_000, swapBytes: 0, cmdline: 'chromium --type=utility --utility-sub-type=network.mojom.NetworkService' },
      { pid: 99, ppid: 1, name: 'other', rssBytes: 999_000_000, pssBytes: 999_000_000, swapBytes: 0, cmdline: 'unrelated' },
    ],
  });

  assert.equal(data.metric, 'pss');
  assert.equal(data.processCount, 4);
  assert.equal(data.totalBytes, 540_000_000);
  assert.equal(data.swapBytes, 5_000_000);
  assert.equal(data.node.assetCacheBytes, 45000);
  assert.equal(data.node.assetCount, 2);
  assert.equal(data.node.recordingBytes, 12000);
  assert.deepEqual(data.tabs, [{ id: 't1', title: 'Docs', host: 'example.com', recordingBytes: 12000 }]);
  assert.equal(JSON.stringify(data).includes('token=abc'), false);
  assert.equal(JSON.stringify(data).includes('cmdline'), false);
  assert.equal(data.processes[0].pid, 21);
  assert.equal(data.processes.find(p => p.pid === 22).label, '网络服务');
});
