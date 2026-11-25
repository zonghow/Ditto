import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { configuration } from '../src/config.js';
import { createApplication } from '../src/app.js';
import { loadCredentials } from '../src/auth.js';
import { SyncStore } from '../src/sync-store.js';
import { gzipSync } from 'node:zlib';
import CryptoJS from 'crypto-js';
import http from 'node:http';
import { WebSocket } from 'ws';
import { AssetCache } from '../src/assets.js';
import { ControlLease } from '../src/control.js';

test('HTTP interface protects state, pairing, upload and login-state application', async t => {
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-http-test-'));
  const credentials = await loadCredentials(dataDir);
  const sync = new SyncStore(dataDir);
  await sync.load();
  const browser = new EventEmitter();
  browser.ready = true;
  browser.summary = () => ({ ready: true, importing: false, tabs: [] });
  browser.cachedRecordings = () => [];
  browser.setViewer = () => {};
  browser.removeViewer = () => {};
  browser.control = new ControlLease();
  browser.assets = new AssetCache();
  browser.refillAsset = async () => false;
  browser.open = async url => url === 'about:blank' ? 'blank-tab' : 'url-tab';
  browser.tabAction = async (id, action) => ({ tabId: id, closed: action === 'close' });
  browser.importSnapshot = async snapshot => ({ importedCookies: snapshot.cookies.length, importedStorage: 0, importedOrigins: 0 });
  const application = createApplication({ config: configuration({ port: 0, dataDir, authRequired: true }), credentials, sync, browser });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => application.close());
  const base = `http://127.0.0.1:${application.server.address().port}`;
  const request = (url, options = {}) => fetch(base + url, options);
  const dashboard = { Authorization: `Bearer ${credentials.dashboardToken}` };
  const uploader = { Authorization: `Bearer ${credentials.syncToken}`, 'Content-Type': 'application/json' };
  assert.equal((await request('/health')).status, 200);
  const privateAsset = browser.assets.reference('synthetic-tab', 'https://example.com/private.png', '');
  browser.assets.put('synthetic-tab', 'https://example.com/private.png', 'image/png', Buffer.from('synthetic-image'));
  assert.equal((await request(privateAsset)).status, 401);
  const protectedAsset = await request(privateAsset, { headers: dashboard });
  assert.equal(protectedAsset.status, 200);
  assert.equal(await protectedAsset.text(), 'synthetic-image');
  assert.equal(protectedAsset.headers.get('cache-control'), 'private, max-age=300');
  assert.match(protectedAsset.headers.get('content-security-policy'), /sandbox; default-src 'none'/);
  const missingAssetRef = browser.assets.reference('synthetic-tab', 'https://example.com/missing.css', '');
  const missingAsset = await request(missingAssetRef, { headers: dashboard });
  assert.equal(missingAsset.status, 204);
  assert.equal(missingAsset.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/api/assets/https%3A%2F%2Fexample.com', { headers: dashboard })).status, 404);
  assert.equal((await request('/vendor/rrweb/replay.js')).status, 200);
  assert.equal((await request('/api/tabs/blank-tab', { method: 'POST', headers: uploader, body: '{"action":"close"}' })).status, 401);
  const browserHeaders = { ...dashboard, 'Content-Type': 'application/json' };
  const blank = await request('/api/tabs', { method: 'POST', headers: browserHeaders, body: '{}' });
  assert.equal((await blank.json()).tabId, 'blank-tab');
  assert.equal((await request('/api/tabs/blank-tab', { method: 'POST', headers: browserHeaders, body: '{"action":"reload"}' })).status, 200);
  assert.equal((await request('/api/tabs/blank-tab', { method: 'POST', headers: browserHeaders, body: '{"action":"close"}' })).status, 200);
  assert.equal((await request('/api/tabs/blank-tab', { method: 'POST', headers: { ...browserHeaders, Origin: 'https://evil.test' }, body: '{"action":"close"}' })).status, 403);
  assert.equal((await request('/api/state')).status, 401);
  const unauthorizedSocket = new WebSocket(`${base.replace('http:', 'ws:')}/api/live`, { origin: base });
  const deniedUpgrade = await new Promise(resolve => {
    unauthorizedSocket.on('unexpected-response', (request, response) => { response.resume(); resolve(response.statusCode); });
    unauthorizedSocket.on('error', () => {});
  });
  assert.equal(deniedUpgrade, 401);
  unauthorizedSocket.terminate();
  assert.equal((await request('/api/pairing', { headers: uploader })).status, 401);
  assert.equal((await request('/api/state', { headers: { ...dashboard, Origin: 'https://evil.test' } })).status, 403);
  // Fetch intentionally controls Host; use a raw HTTP client to test DNS-rebinding protection.
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/state`, { headers: { ...dashboard, Host: 'evil.test/bad' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(invalidHostStatus, 403);
  const login = await request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: credentials.dashboardToken }) });
  assert.equal(login.status, 200);
  const loginCookie = login.headers.get('set-cookie');
  assert.match(loginCookie, /ditto_session=0\..*; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=34560000/);
  const state = await request('/api/state', { headers: { Cookie: loginCookie.split(';')[0] } });
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('set-cookie'), loginCookie);
  assert.equal((await state.json()).browser.ready, true);
  const secret = randomBytes(16).toString('hex');
  const body = { schemaVersion: 1, cookies: [{ name: 'synthetic', value: secret, domain: 'example.com', path: '/', hostOnly: true }],
    origins: [{ origin: 'https://example.com', localStorage: [] }] };
  assert.equal((await request('/api/sync', { method: 'POST', headers: dashboard, body: JSON.stringify(body) })).status, 401);
  const uploaded = await request('/api/sync', { method: 'POST', headers: uploader, body: JSON.stringify(body) });
  assert.equal(uploaded.status, 200);
  const uploadResponse = await uploaded.text();
  assert.equal(uploadResponse.includes(secret), false);
  const uploadedBody = JSON.parse(uploadResponse);
  assert.equal(uploadedBody.applied.importedCookies, 1);
  assert.equal(sync.pending, null);
  assert.equal((await stat(path.join(dataDir, 'applied.json'))).mode & 0o777, 0o600);
  await assert.rejects(stat(path.join(dataDir, 'pending.json')), { code: 'ENOENT' });
  const ccPayload = { cookie_data: {}, local_storage_data: {} };
  const key = CryptoJS.MD5(`${credentials.cookieCloud.uuid}-${credentials.cookieCloud.password}`).toString().slice(0, 16);
  const ccBody = { uuid: credentials.cookieCloud.uuid, encrypted: CryptoJS.AES.encrypt(JSON.stringify(ccPayload), key).toString() };
  const gzip = await request('/cookiecloud/update', { method: 'POST', headers: { ...uploader, 'Content-Encoding': 'gzip' },
    body: gzipSync(JSON.stringify(ccBody)) });
  assert.equal(gzip.status, 200);
  assert.equal((await gzip.json()).action, 'done');
  assert.equal((await request(`/cookiecloud/get/${credentials.cookieCloud.uuid}`)).status, 401);
  const adminFromExtension = await request('/api/pairing', { headers: {
    ...dashboard, Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  } });
  assert.equal(adminFromExtension.status, 403);
});

test('default direct-IP mode allows zero-token viewer, extension sync and agent endpoints', async t => {
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-open-test-'));
  const credentials = await loadCredentials(dataDir);
  const sync = new SyncStore(dataDir);
  await sync.load();
  const browser = new EventEmitter();
  browser.ready = true;
  browser.summary = () => ({ ready: true, importing: false, activeTabId: 'tab-1', tabs: [{ id: 'tab-1', title: 'Demo', url: 'https://example.com' }] });
  browser.cachedRecordings = () => [];
  browser.setViewer = () => {};
  browser.removeViewer = () => {};
  browser.control = new ControlLease();
  browser.assets = new AssetCache();
  browser.refillAsset = async () => false;
  browser.open = async () => 'tab-1';
  browser.tabAction = async id => ({ tabId: id, closed: false });
  browser.importSnapshot = async snapshot => ({ importedCookies: snapshot.cookies.length, importedStorage: 0, importedOrigins: 1 });
  browser.agentSnapshot = async () => ({ ok: true, tabId: 'tab-1', title: 'Demo', url: 'https://example.com', text: 'Hello', elements: [{ ref: '@e1', tag: 'button', text: 'OK' }] });
  browser.agentEvaluate = async (_tabId, expr) => ({ ok: true, tabId: 'tab-1', result: `eval:${expr}` });
  const application = createApplication({ config: configuration({ port: 0, dataDir }), credentials, sync, browser });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => application.close());
  const base = `http://127.0.0.1:${application.server.address().port}`;
  const state = await fetch(`${base}/api/state`).then(r => r.json());
  assert.equal(state.authRequired, false);
  assert.equal(state.extensionConnected, false);

  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const extWs = new WebSocket(`${base.replace('http:', 'ws:')}/api/sync/live`, { origin: extensionOrigin });
  await new Promise((resolve, reject) => { extWs.once('open', resolve); extWs.once('error', reject); });
  const firstMsg = new Promise(resolve => extWs.once('message', raw => resolve(JSON.parse(raw.toString()))));
  extWs.send(JSON.stringify({ type: 'authenticate' }));
  const syncDemands = await firstMsg;
  assert.equal(syncDemands.type, 'sync-requests');

  const agentStatus = await fetch(`${base}/api/agent/status`).then(r => r.json());
  assert.equal(agentStatus.extensionConnected, true);
  const snap = await fetch(`${base}/api/agent/snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
  assert.equal(snap.elements[0].ref, '@e1');
  const evaluated = await fetch(`${base}/api/agent/eval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expression: '1+1' }) }).then(r => r.json());
  assert.equal(evaluated.result, 'eval:1+1');
  extWs.close();
});

test('agent open refreshes stale persisted origins and agent sync navigates target tab when both url and tabId are provided', async t => {
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-sync-fix-'));
  const credentials = await loadCredentials(dataDir);
  const sync = new SyncStore(dataDir);
  await sync.load();
  const navigated = [];
  const browser = new EventEmitter();
  browser.ready = true;
  browser.importing = false;
  browser.tabs = new Map([['tab-existing', { id: 'tab-existing', page: { url: () => 'https://login.example.test' } }]]);
  browser.summary = () => ({
    ready: true, importing: false, activeTabId: 'tab-existing',
    tabs: [{ id: 'tab-existing', title: 'Target', url: navigated.at(-1)?.url || 'https://login.example.test' }],
  });
  browser.cachedRecordings = () => [];
  browser.setViewer = () => {};
  browser.removeViewer = () => {};
  browser.control = new ControlLease();
  browser.assets = new AssetCache();
  browser.refillAsset = async () => false;
  browser.resolveTab = id => browser.tabs.get(id || 'tab-existing');
  browser.agentOpen = async url => { navigated.push({ action: 'open', url }); return 'tab-existing'; };
  browser.agentTabAction = async (id, action, opts) => {
    navigated.push({ id, action, url: opts?.url });
    return { tabId: id, closed: false };
  };
  browser.importSnapshot = async snapshot => ({ importedCookies: snapshot.cookies.length, importedStorage: 0, importedOrigins: snapshot.origins.length });

  // Simulate persisted applied.json from a previous container run (before this server booted)
  const oldPending = await sync.receive({
    schemaVersion: 1, cookies: [], origins: [{ origin: 'https://app.example.test', localStorage: [] }],
  });
  await sync.apply(oldPending.id, browser);

  const application = createApplication({ config: configuration({ port: 0, dataDir }), credentials, sync, browser });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => application.close());
  const base = `http://127.0.0.1:${application.server.address().port}`;
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const extWs = new WebSocket(`${base.replace('http:', 'ws:')}/api/sync/live`, { origin: extensionOrigin });
  await new Promise((resolve, reject) => { extWs.once('open', resolve); extWs.once('error', reject); });
  const handledIds = new Set();
  const uploadedOrigins = [];
  extWs.on('message', async raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'sync-requests') return;
    const waiting = (msg.requests || []).filter(r => r.status === 'waiting' && !handledIds.has(r.id));
    if (!waiting.length) return;
    for (const r of waiting) handledIds.add(r.id);
    uploadedOrigins.push(...waiting.map(r => r.origin));
    await fetch(`${base}/api/sync/auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: extensionOrigin },
      body: JSON.stringify({
        requestIds: waiting.map(r => r.id),
        snapshot: {
          schemaVersion: 1,
          cookies: [{ name: 'fresh', value: 'v', domain: 'app.example.test', path: '/', hostOnly: true }],
          origins: waiting.map(r => ({ origin: r.origin, localStorage: [] })),
        },
      }),
    }).catch(() => {});
  });
  extWs.send(JSON.stringify({ type: 'authenticate' }));
  await new Promise(resolve => setTimeout(resolve, 60));

  // 1. Cold open after restart must pull fresh cookies even though applied.json had app.example.test
  const opened = await fetch(`${base}/api/agent/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://app.example.test/home' }),
  }).then(r => r.json());
  assert.equal(opened.ok, true);
  assert.equal(uploadedOrigins.filter(o => o === 'https://app.example.test').length, 1);

  // 2. Second open right away uses fresh cache without redundant re-pull
  await fetch(`${base}/api/agent/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://app.example.test/settings' }),
  }).then(r => r.json());
  assert.equal(uploadedOrigins.filter(o => o === 'https://app.example.test').length, 1);

  // 3. Explicit ditto sync with BOTH url and tabId syncs and navigates that tab back to url
  const synced = await fetch(`${base}/api/agent/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://app.example.test/commits', tabId: 'tab-existing' }),
  }).then(r => r.json());
  assert.equal(synced.ok, true);
  assert.equal(synced.synced, true);
  assert.equal(synced.tabId, 'tab-existing');
  assert.equal(uploadedOrigins.filter(o => o === 'https://app.example.test').length, 2);
  assert.deepEqual(navigated.at(-1), { id: 'tab-existing', action: 'navigate', url: 'https://app.example.test/commits' });
  extWs.close();
});

test('viewer reload, navigate and new-tab open re-sync fresh login state after signing in on Mac', async t => {
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-viewer-resync-'));
  const credentials = await loadCredentials(dataDir);
  const sync = new SyncStore(dataDir);
  await sync.load();
  const events = [];
  let macSignedIn = false;
  let currentUrl = 'https://byte.example.test/';
  const browser = new EventEmitter();
  browser.ready = true;
  browser.importing = false;
  browser.tabs = new Map([['tab-1', { id: 'tab-1', page: { url: () => currentUrl } }]]);
  browser.summary = () => ({
    ready: true, importing: false, activeTabId: 'tab-1',
    tabs: [{ id: 'tab-1', title: 'Byte', url: currentUrl }],
  });
  browser.cachedRecordings = () => [];
  browser.setViewer = () => {};
  browser.removeViewer = () => {};
  browser.control = new ControlLease();
  browser.assets = new AssetCache();
  browser.refillAsset = async () => false;
  browser.open = async url => {
    currentUrl = url;
    events.push({ type: 'open', url });
    return 'tab-2';
  };
  browser.tabAction = async (id, action, opts) => {
    if (opts?.url) currentUrl = opts.url;
    events.push({ type: action, id, url: currentUrl });
    return { tabId: id, closed: false };
  };
  browser.importSnapshot = async snapshot => {
    events.push({
      type: 'import',
      cookies: snapshot.cookies.map(c => `${c.name}=${c.value}`),
      storageCount: snapshot.origins.reduce((n, o) => n + o.localStorage.length, 0),
    });
    return { importedCookies: snapshot.cookies.length, importedStorage: 1, importedOrigins: snapshot.origins.length };
  };

  const application = createApplication({ config: configuration({ port: 0, dataDir }), credentials, sync, browser });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => application.close());
  const base = `http://127.0.0.1:${application.server.address().port}`;
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const extWs = new WebSocket(`${base.replace('http:', 'ws:')}/api/sync/live`, { origin: extensionOrigin });
  await new Promise((resolve, reject) => { extWs.once('open', resolve); extWs.once('error', reject); });
  const handled = new Set();
  extWs.on('message', async raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'sync-requests') return;
    const waiting = (msg.requests || []).filter(r => r.status === 'waiting' && !handled.has(r.id));
    if (!waiting.length) return;
    for (const r of waiting) handled.add(r.id);
    await fetch(`${base}/api/sync/auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: extensionOrigin },
      body: JSON.stringify({
        requestIds: waiting.map(r => r.id),
        snapshot: {
          schemaVersion: 1,
          cookies: macSignedIn
            ? [{ name: 'sid', value: 'signed-in', domain: 'byte.example.test', path: '/', hostOnly: true }]
            : [],
          origins: waiting.map(r => ({
            origin: r.origin,
            localStorage: macSignedIn ? [{ name: 'user', value: 'ok' }] : [],
          })),
        },
      }),
    }).catch(() => {});
  });
  extWs.send(JSON.stringify({ type: 'authenticate' }));
  await new Promise(resolve => setTimeout(resolve, 50));

  // 1. Navigate in viewer BEFORE signing in on Mac -> syncs empty state first
  await fetch(`${base}/api/tabs/tab-1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'navigate', url: 'https://byte.example.test/' }),
  });
  assert.deepEqual(events.slice(-2), [
    { type: 'import', cookies: [], storageCount: 0 },
    { type: 'navigate', id: 'tab-1', url: 'https://byte.example.test/' },
  ]);

  // 2. Sign in on Mac, then click Reload in viewer -> must import fresh cookies + localStorage BEFORE reload
  macSignedIn = true;
  await fetch(`${base}/api/tabs/tab-1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reload' }),
  });
  assert.deepEqual(events.slice(-2), [
    { type: 'import', cookies: ['sid=signed-in'], storageCount: 1 },
    { type: 'reload', id: 'tab-1', url: 'https://byte.example.test/' },
  ]);

  // 3. Opening a new tab with that URL also pulls fresh state before opening
  await fetch(`${base}/api/tabs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://byte.example.test/dashboard' }),
  });
  assert.deepEqual(events.slice(-2), [
    { type: 'import', cookies: ['sid=signed-in'], storageCount: 1 },
    { type: 'open', url: 'https://byte.example.test/dashboard' },
  ]);
  extWs.close();
});
