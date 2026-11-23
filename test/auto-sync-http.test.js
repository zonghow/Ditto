import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { configuration } from '../src/config.js';
import { loadCredentials } from '../src/auth.js';
import { createApplication } from '../src/app.js';
import { SyncStore } from '../src/sync-store.js';
import { AssetCache } from '../src/assets.js';
import { ControlLease } from '../src/control.js';

test('extension demand channel authenticates privately and can only stage requested Cookies, never apply them', async t => {
  const directory = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-auto-http-'));
  const credentials = await loadCredentials(directory);
  const sync = new SyncStore(directory);
  await sync.load();
  const browser = new EventEmitter();
  let imports = 0;
  Object.assign(browser, { ready: true, control: new ControlLease(), assets: new AssetCache(),
    summary: () => ({ ready: true, importing: false, tabs: [{ url: 'https://example.com/private?token=not-shared' }] }),
    cachedRecordings: () => [], setViewer() {}, removeViewer() {},
    importSnapshot: async snapshot => { imports++; return { importedCookies: snapshot.cookies.length, importedOrigins: 1, importedStorage: 0 }; },
  });
  const app = createApplication({ config: configuration({ port: 0, dataDir: directory, authRequired: true }), credentials, browser, sync });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const uploader = { Authorization: `Bearer ${credentials.syncToken}`, Origin: extensionOrigin, 'Content-Type': 'application/json' };
  const dashboard = { Authorization: `Bearer ${credentials.dashboardToken}`, 'Content-Type': 'application/json' };
  const request = (route, options = {}) => fetch(`${base}${route}`, options);
  assert.equal((await request('/api/sync/requests')).status, 401);
  assert.equal((await request('/api/sync/requests', { headers: dashboard })).status, 401);
  const demands = await request('/api/sync/requests', { headers: uploader });
  assert.equal(demands.headers.get('access-control-allow-origin'), extensionOrigin);
  const data = await demands.json();
  assert.equal(data.requests[0].origin, 'https://example.com');
  assert.equal(JSON.stringify(data).includes('not-shared'), false);
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/sync/live`, { origin: extensionOrigin });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const firstMessage = new Promise(resolve => ws.once('message', raw => resolve(JSON.parse(raw.toString()))));
  ws.send(JSON.stringify({ type: 'authenticate', token: credentials.syncToken }));
  const first = await firstMessage;
  assert.equal(first.type, 'sync-requests');
  const snapshot = { schemaVersion: 1, cookies: [{ name: 'synthetic', value: 'test-only', domain: '.example.com', path: '/', hostOnly: false }],
    origins: [{ origin: 'https://example.com', localStorage: [] }] };
  const upload = body => request('/api/sync/auto', { method: 'POST', headers: uploader, body: JSON.stringify(body) });
  assert.equal((await upload({ requestIds: [first.requests[0].id], snapshot: { ...snapshot, origins: [{ origin: 'https://other.test' }] } })).status, 400);
  const result = await upload({ requestIds: [first.requests[0].id], snapshot });
  assert.equal(result.status, 200);
  const pending = (await result.json()).pending;
  assert.equal(imports, 1);
  assert.equal(sync.pending, null);
  assert.equal((await upload({ requestIds: [first.requests[0].id], snapshot })).status, 409);
  assert.equal((await request('/api/apply', { method: 'POST', headers: uploader, body: JSON.stringify({ id: pending.id }) })).status, 403);
  const finished = await request('/api/sync/requests', { headers: uploader }).then(response => response.json());
  assert.equal(finished.requests[0].status, 'applied');
  assert.equal((await upload({ requestIds: [first.requests[0].id], snapshot })).status, 409);
  const renewed = await request('/api/sync/request', { method: 'POST', headers: dashboard, body: JSON.stringify({ origin: 'https://example.com' }) }).then(response => response.json());
  assert.notEqual(renewed.request.id, first.requests[0].id);
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'history-search') {
      ws.send(JSON.stringify({
        type: 'history-results',
        requestId: msg.requestId,
        items: [
          { url: 'https://data.example.test/tea-next/project/1', title: '行为分析系统', visitCount: 9, lastVisited: Date.now() },
          { url: 'javascript:alert(1)', title: 'Unsafe', visitCount: 1, lastVisited: Date.now() },
        ],
      }));
    }
  });
  const historyRes = await request('/api/history?q=data&limit=8', { headers: dashboard });
  assert.equal(historyRes.status, 200);
  const historyData = await historyRes.json();
  assert.equal(historyData.items.length, 1);
  assert.equal(historyData.items[0].url, 'https://data.example.test/tea-next/project/1');
  assert.equal(historyData.items[0].source, 'chrome');
  assert.equal(historyData.items[0].removable, false);
  const closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  ws.send(JSON.stringify({ type: 'apply' }));
  assert.equal(await closed, 1008);
  assert.equal(imports, 1);
});
