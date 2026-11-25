import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

const execFileAsync = promisify(execFile);
import { normalizeSnapshot, snapshotSummary } from '../src/snapshot.js';
import { CookieRequests } from '../src/cookie-requests.js';
import { AssetCache } from '../src/assets.js';
import {
  ScreencastManager,
  computeScreencastFrameGeometry,
  resolveScreencastPoint,
  validateScreencastInput,
} from '../src/screencast.js';
import { BrowserService, ensureThirdPartyStoragePrefs } from '../src/browser.js';
import { importSnapshotToBrowser } from '../src/import-snapshot.js';
import { RecordingBuffer, serializeRecordingMessage } from '../src/recording.js';
import { encodeBinaryScreencastFrame, MAX_SCREENCAST_BUFFERED_BYTES } from '../src/ws-hub.js';
import { configuration } from '../src/config.js';
import { loadCredentials } from '../src/auth.js';
import { SyncStore } from '../src/sync-store.js';
import { createApplication } from '../src/app.js';
import { captureFullSnapshot } from '../extension/capture.js';
import { AutoSync } from '../extension/auto-sync.js';

test('full-mode snapshot accepts all profile cookies, skips malformed/TLD/ditto_session, and retains sessionStorage & diagnostics', () => {
  const snapshot = normalizeSnapshot({
    schemaVersion: 1,
    mode: 'full',
    cookies: [
      { name: 'auth', value: 'v1', domain: '.alpha.test', path: '/', secure: true, hostOnly: false },
      { name: 'beta_sid', value: 'v2', domain: 'beta.test', path: '/', secure: false, hostOnly: true },
      { name: 'too_broad', value: 'x', domain: '.com', path: '/', secure: true, hostOnly: false },
      { name: 'ditto_session', value: 'admin-secret', domain: 'devbox.local', path: '/api', secure: false, hostOnly: true },
      { name: 'bad_same_site', value: 'x', domain: 'bad.test', path: '/', sameSite: 'none', secure: false },
    ],
    origins: [
      {
        origin: 'https://alpha.test',
        localStorage: [{ name: 'theme', value: 'dark' }],
        sessionStorage: [{ name: 'tab_token', value: 's1' }],
      },
    ],
    missingStorageOrigins: ['https://beta.test'],
    warnings: ['storage-unavailable'],
  });
  assert.equal(snapshot.mode, 'full');
  assert.deepEqual(snapshot.cookies.map(c => c.name).sort(), ['auth', 'beta_sid']);
  assert.equal(snapshot.origins[0].sessionStorage.length, 1);
  assert.deepEqual(snapshot.missingStorageOrigins, ['https://beta.test']);
  assert.ok(snapshot.warnings.some(w => w.includes('https://beta.test')));
  const summary = snapshotSummary(snapshot);
  assert.equal(summary.mode, 'full');
  assert.equal(summary.storageCount, 2);
});

test('CookieRequests evicts oldest applied entries past 100 origins instead of silently dropping new sites', () => {
  const requests = new CookieRequests();
  for (let i = 0; i < 100; i++) {
    const req = requests.observe(`https://site-${i}.test`);
    assert.ok(req);
    if (i < 5) req.status = 'applied';
  }
  assert.equal(requests.requests.size, 100);
  const fresh = requests.observe('https://brand-new-101.test');
  assert.ok(fresh, '101st origin must not be silently dropped');
  assert.equal(requests.requests.size, 100);
  assert.equal(requests.requests.has('https://site-0.test'), false);
  assert.equal(requests.requests.has('https://brand-new-101.test'), true);
});

test('AssetCache uses LRU eviction, prunes old generations on advanceScope, and only notifies missing assets', () => {
  const ready = [];
  const cache = new AssetCache(id => ready.push(id));
  // Pre-captured resource (never referenced yet) should not fire noisy asset-ready
  assert.equal(cache.put('tab1', 'https://cdn.test/preloaded.png', 'image/png', Buffer.from('a')), true);
  assert.equal(ready.length, 0);
  // Referenced before arrival SHOULD fire asset-ready once bytes arrive
  const ref = cache.reference('tab1', 'https://cdn.test/late.png', '', true);
  const lateId = ref.split('/').pop();
  assert.equal(cache.put('tab1', 'https://cdn.test/late.png', 'image/png', Buffer.from('b')), true);
  assert.deepEqual(ready, [lateId]);

  // Generation pruning keeps current & previous generation, drops older ones
  const gen0Ref = cache.reference('tab1', 'https://cdn.test/gen0.png', '', true);
  const gen0Id = gen0Ref.split('/').pop();
  cache.advanceScope('tab1'); // gen 1
  const gen1Ref = cache.reference('tab1', 'https://cdn.test/gen1.png', '', true);
  const gen1Id = gen1Ref.split('/').pop();
  cache.advanceScope('tab1'); // gen 2 -> gen0 pruned, gen1 kept
  assert.equal(cache.get(gen0Id), undefined);
  assert.ok(cache.get(gen1Id));
});

test('captureFullSnapshot & AutoSync perform deduplicated periodic full sync and proactive new-tab sync', async () => {
  const cookies = [
    { name: 'a', value: '1', domain: '.site-a.test', path: '/', hostOnly: false, storeId: '0' },
    { name: 'b', value: '2', domain: 'site-b.test', path: '/', hostOnly: true, storeId: '0' },
    { name: 'ditto_session', value: 'secret', domain: '127.0.0.1', path: '/api', hostOnly: true, storeId: '0' },
  ];
  const saved = { settings: { endpoint: 'http://127.0.0.1:3217' } };
  const api = {
    storage: { local: { get: async () => structuredClone(saved) } },
    cookies: { getAllCookieStores: async () => [{ id: '0', tabIds: [1] }], getAll: async () => cookies },
    tabs: { query: async () => [
      { id: 1, active: true, url: 'https://site-a.test/home' },
      { id: 2, active: false, url: 'http://127.0.0.1:3217/' },
    ] },
    scripting: { executeScript: async () => [{ result: {
      localStorage: [{ name: 'ls', value: 'ok' }],
      sessionStorage: [{ name: 'ss', value: 'ok' }],
    } }] },
  };
  const snap = await captureFullSnapshot(api, () => {}, { excludeOrigin: 'http://127.0.0.1:3217' });
  assert.equal(snap.mode, 'full');
  assert.deepEqual(snap.cookies.map(c => c.name).sort(), ['a', 'b']);
  assert.deepEqual(snap.origins.map(o => o.origin), ['https://site-a.test']);
  assert.equal(snap.origins[0].sessionStorage.length, 1);

  const uploads = [];
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    uploads.push({ url, body });
    return {
      ok: true,
      json: async () => ({
        applied: {
          id: `up-${uploads.length}`,
          cookieCount: body.cookies.length,
          storageCount: body.origins.reduce((n, o) => n + o.localStorage.length + (o.sessionStorage?.length || 0), 0),
          origins: body.origins.map(o => o.origin),
        },
      }),
    };
  };
  const engine = new AutoSync({ api, fetcher });
  engine.configure(saved);

  // First periodic fullSync uploads
  await engine.fullSync();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.mode, 'full');
  // Second periodic fullSync with unchanged cookies/storage skips upload
  const skipped = await engine.fullSync();
  assert.equal(skipped.skipped, true);
  assert.equal(uploads.length, 1);
  // Cookie changes -> next periodic fullSync uploads ONLY the changed cookie (delta upload)
  cookies[0].value = 'updated';
  await engine.fullSync();
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].body.mode, 'full');
  assert.deepEqual(uploads[1].body.cookies.map(c => c.name), ['a']);
  assert.equal(uploads[1].body.origins.length, 0);
  // After reconnect resetDelta(), fullSync uploads complete baseline again
  engine.resetDelta();
  await engine.fullSync();
  assert.equal(uploads.length, 3);
  assert.equal(uploads[2].body.cookies.length, 2);
  assert.equal(uploads[2].body.origins.length, 1);
  // New-tab proactive sync uploads just that origin immediately
  await engine.syncTabOrigins(['https://site-a.test']);
  assert.equal(uploads.length, 4);
  assert.equal(uploads[3].body.mode, 'scoped');
});

test('validateScreencastInput accepts drag/scroll/text/key and blocks browser shortcuts and invalid coordinates', () => {
  assert.deepEqual(validateScreencastInput({ tabId: 't1', action: 'mousedown', x: 0.25, y: 0.5 }), {
    action: 'mousedown', tabId: 't1', x: 0.25, y: 0.5, button: 'left',
  });
  assert.deepEqual(validateScreencastInput({ tabId: 't1', action: 'mousemove', x: 0.8, y: 0.5 }), {
    action: 'mousemove', tabId: 't1', x: 0.8, y: 0.5,
  });
  assert.deepEqual(validateScreencastInput({ tabId: 't1', action: 'mousemove', x: 0.5, y: 0.5, frameWidth: 1400, frameHeight: 763 }), {
    action: 'mousemove', tabId: 't1', x: 0.5, y: 0.5, frameWidth: 1400, frameHeight: 763,
  });
  assert.throws(() => validateScreencastInput({ tabId: 't1', action: 'click', x: 1.5, y: 0.2 }));
  assert.throws(() => validateScreencastInput({ tabId: 't1', action: 'click', x: 0.5, y: 0.5, frameWidth: 0, frameHeight: 500 }));
  assert.throws(() => validateScreencastInput({ tabId: 't1', action: 'key', key: 'w', modifiers: ['Control'] }));
  assert.throws(() => validateScreencastInput({ tabId: 't1', action: 'eval', value: '1+1' }));
});

test('screencast coordinate mapping stays exact when compositor surface differs from emulated viewport', () => {
  // Case 1: Chromium headless=new crops bottom 87px (deviceHeight 713 vs viewport 800)
  const cropped = computeScreencastFrameGeometry(
    { width: 1000, height: 713, viewportWidth: 1000, viewportHeight: 800, offsetTop: 0, pageScaleFactor: 1 },
    { width: 1000, height: 800 },
  );
  assert.equal(cropped.coordWidth, 1000);
  assert.equal(cropped.coordHeight, 713);
  const hitCropped = resolveScreencastPoint(
    { x: 0.5, y: 390 / 713 },
    { width: 1000, height: 800 },
    { width: 1000, height: 713, viewportWidth: 1000, viewportHeight: 800 },
  );
  assert.equal(Math.round(hitCropped.x), 500);
  assert.equal(Math.round(hitCropped.y), 390);

  // Case 2: Browser window bounds (1920x993) exceed emulated viewport (1711x898);
  // client crops dead padding so canvas spans exact viewport (1711x898).
  const padded = computeScreencastFrameGeometry(
    { width: 1920, height: 993, viewportWidth: 1711, viewportHeight: 898, offsetTop: 0, pageScaleFactor: 1 },
    { width: 1711, height: 898 },
  );
  assert.equal(padded.coordWidth, 1711);
  assert.equal(padded.coordHeight, 898);
  const hitPadded = resolveScreencastPoint(
    { x: 855 / 1711, y: 449 / 898, frameWidth: 1711, frameHeight: 898 },
    { width: 1711, height: 898 },
    { width: 1920, height: 993, viewportWidth: 1711, viewportHeight: 898 },
  );
  assert.equal(Math.round(hitPadded.x), 855);
  assert.equal(Math.round(hitPadded.y), 449);

  // Binary frame header preserves optional viewport geometry when present.
  const pkt = encodeBinaryScreencastFrame({
    tabId: 't2', width: 1920, height: 993, viewportWidth: 1711, viewportHeight: 898, timestamp: 123, rawBuffer: Buffer.from([1, 2]),
  });
  const hdrLen = pkt.readUInt32BE(0);
  const hdr = JSON.parse(pkt.subarray(4, 4 + hdrLen).toString('utf8'));
  assert.deepEqual(hdr, {
    type: 'screencast-frame', tabId: 't2', width: 1920, height: 993, viewportWidth: 1711, viewportHeight: 898, timestamp: 123,
  });
});

test('performScreencastInput coalesces mousemove without dropping final position or reordering around mousedown', async () => {
  const browser = new BrowserService({ viewport: { width: 1000, height: 800 } });
  browser.ready = true;
  const events = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const tab = {
    id: 'sc-tab',
    hidden: false,
    crashed: false,
    page: {
      isClosed: () => false,
      viewportSize: () => ({ width: 1000, height: 800 }),
      bringToFront: async () => {},
      mouse: {
        move: async (x, y) => {
          events.push({ type: 'move', x: Math.round(x), y: Math.round(y) });
          if (events.length === 1) await firstGate;
        },
        down: async () => { events.push({ type: 'down' }); },
      },
    },
  };
  browser.tabs.set('sc-tab', tab);
  const p1 = browser.performScreencastInput('v1', { tabId: 'sc-tab', action: 'mousemove', x: 0.1, y: 0.1 });
  await Promise.resolve();
  const p2 = browser.performScreencastInput('v1', { tabId: 'sc-tab', action: 'mousemove', x: 0.2, y: 0.2 });
  const p3 = browser.performScreencastInput('v1', { tabId: 'sc-tab', action: 'mousemove', x: 0.3, y: 0.3 });
  const p4 = browser.performScreencastInput('v1', { tabId: 'sc-tab', action: 'mousedown', x: 0.4, y: 0.4 });
  const p5 = browser.performScreencastInput('v1', { tabId: 'sc-tab', action: 'mousemove', x: 0.5, y: 0.5 });
  releaseFirst();
  await Promise.all([p1, p2, p3, p4, p5]);
  // p2 was coalesced into p3 (300,300), mousedown runs at (400,400), then p5 runs AFTER mousedown at (500,500)
  assert.deepEqual(events, [
    { type: 'move', x: 100, y: 80 },
    { type: 'move', x: 300, y: 240 },
    { type: 'move', x: 400, y: 320 },
    { type: 'down' },
    { type: 'move', x: 500, y: 400 },
  ]);
});

test('accept-dialog and dismiss-dialog handle alert, confirm, and prompt dialogs cleanly', async () => {
  const browser = new BrowserService({ viewport: { width: 1280, height: 800 } });
  browser.ready = true;
  const actions = [];
  const makeDialog = type => ({
    type: () => type,
    accept: async text => { actions.push({ op: 'accept', type, text }); },
    dismiss: async () => { actions.push({ op: 'dismiss', type }); },
  });
  const tab = {
    id: 'dlg-tab',
    hidden: false,
    url: 'https://example.test',
    page: { isClosed: () => false },
    pendingDialog: makeDialog('prompt'),
    dialog: { type: 'prompt', closing: false, hasPrompt: true },
  };
  browser.tabs.set(tab.id, tab);

  await browser.dispatchTabAction(tab.id, 'accept-dialog', { promptText: 'hello' });
  assert.equal(tab.dialog, null);
  assert.deepEqual(actions.at(-1), { op: 'accept', type: 'prompt', text: 'hello' });

  tab.pendingDialog = makeDialog('confirm');
  tab.dialog = { type: 'confirm', closing: false, hasPrompt: false };
  await browser.dispatchTabAction(tab.id, 'dismiss-dialog');
  assert.equal(tab.dialog, null);
  assert.deepEqual(actions.at(-1), { op: 'dismiss', type: 'confirm' });
});

test('grantLocalNetworkAccess keeps browser-level CDP session open so Chromium retains LNA overrides', async () => {
  const browser = new BrowserService({ viewport: { width: 1280, height: 800 } });
  const sent = [];
  let detached = false;
  const mockCdp = {
    send: async (method, params) => { sent.push({ method, params }); },
    detach: async () => { detached = true; },
  };
  browser.context = {
    browser: () => ({ newBrowserCDPSession: async () => mockCdp }),
    close: async () => {},
  };
  await browser.grantLocalNetworkAccess();
  assert.deepEqual(
    sent.map(item => `${item.method}:${item.params.permission.name}:${item.params.setting}`),
    [
      'Browser.setPermission:local-network-access:granted',
      'Browser.setPermission:local-network:granted',
      'Browser.setPermission:loopback-network:granted',
    ],
  );
  // Session MUST stay attached while running; detaching resets Chromium DevTools permission overrides.
  assert.equal(detached, false);
  assert.equal(browser.lnaCdp, mockCdp);
  await browser.stop();
  assert.equal(detached, true);
  assert.equal(browser.lnaCdp, null);
});

test('ensureThirdPartyStoragePrefs merges 3P cookie/storage allowance without discarding existing preferences', async t => {
  const dir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-prefs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await ensureThirdPartyStoragePrefs(dir);
  const { readFile } = await import('node:fs/promises');
  const first = JSON.parse(await readFile(path.join(dir, 'Default', 'Preferences'), 'utf8'));
  assert.equal(first.profile.cookie_controls_mode, 0);
  assert.equal(first.profile.block_third_party_cookies, false);
  // Existing sibling keys stay preserved.
  await writeFile(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ profile: { name: 'Ditto', cookie_controls_mode: 1 }, custom: 42 }));
  await ensureThirdPartyStoragePrefs(dir);
  const second = JSON.parse(await readFile(path.join(dir, 'Default', 'Preferences'), 'utf8'));
  assert.equal(second.profile.name, 'Ditto');
  assert.equal(second.profile.cookie_controls_mode, 0);
  assert.equal(second.profile.block_third_party_cookies, false);
  assert.equal(second.custom, 42);
});

test('AssetCache sniffs ICO/SVG favicons and BrowserService.refresh resolves opaque tab favicon refs', async () => {
  const ready = [];
  const cache = new AssetCache(id => ready.push(id));
  const icoHeader = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
  assert.equal(cache.put('t1', 'https://app.test/favicon.ico', 'application/octet-stream', icoHeader), true);
  const icoRef = cache.reference('t1', 'https://app.test/favicon.ico', 'https://app.test/', true);
  assert.equal(cache.get(icoRef.split('/').pop()).contentType, 'image/x-icon');

  const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>');
  assert.equal(cache.put('t1', 'https://app.test/icon.svg', '', svgBytes), true);
  const svgRef = cache.reference('t1', 'https://app.test/icon.svg', 'https://app.test/', true);
  assert.equal(cache.get(svgRef.split('/').pop()).contentType, 'image/svg+xml');

  const browser = new BrowserService({ viewport: { width: 1280, height: 800 } });
  browser.assets = cache;
  const refilled = [];
  browser.refillAsset = async id => { refilled.push(id); return true; };
  browser.refreshHistory = async () => {};
  const tab = {
    id: 't2',
    hidden: false,
    url: 'about:blank',
    title: '',
    favicon: null,
    faviconUrlFor: null,
    page: {
      isClosed: () => false,
      url: () => 'https://portal.test/home',
      title: async () => 'Portal',
      evaluate: async () => 'https://cdn.portal.test/brand.png',
    },
  };
  await browser.refresh(tab, { refreshFavicon: true });
  assert.match(tab.favicon, /^\/api\/assets\/[a-f0-9]{36}$/);
  // Favicon bytes are refilled lazily when a viewer requests /api/assets/:id, never proactively during refresh.
  assert.equal(refilled.length, 0);
  const faviconId = tab.favicon.split('/').pop();
  assert.deepEqual(cache.source(faviconId), { scope: 't2', url: 'https://cdn.portal.test/brand.png' });

  // Navigating back to about:blank clears the tab favicon cleanly.
  tab.page.url = () => 'about:blank';
  await browser.refresh(tab, { refreshFavicon: true });
  assert.equal(tab.favicon, null);
});

test('viewer WebSocket filters rrweb events per watched tab and streams all tabs only in overview mode', async t => {
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-ws-sub-'));
  const credentials = await loadCredentials(dataDir);
  const sync = new SyncStore(dataDir);
  await sync.load();
  const snapA = { type: 'rrweb-snapshot', tabId: 'tab-a', documentId: 'doc-a', firstSequence: 1, lastSequence: 2, serverTime: Date.now(), events: [{ type: 4, timestamp: 1, data: { width: 800, height: 600 } }, { type: 2, timestamp: 2, data: { node: { type: 0, id: 1, childNodes: [] } } }] };
  const snapB = { type: 'rrweb-snapshot', tabId: 'tab-b', documentId: 'doc-b', firstSequence: 1, lastSequence: 2, serverTime: Date.now(), events: [{ type: 4, timestamp: 1, data: { width: 800, height: 600 } }, { type: 2, timestamp: 2, data: { node: { type: 0, id: 1, childNodes: [] } } }] };
  const browser = new EventEmitter();
  Object.assign(browser, {
    ready: true,
    assets: new AssetCache(),
    summary: () => ({ ready: true, importing: false, activeTabId: 'tab-a', tabs: [{ id: 'tab-a', url: 'https://a.test' }, { id: 'tab-b', url: 'https://b.test' }] }),
    cachedRecording: id => (id === 'tab-a' ? snapA : id === 'tab-b' ? snapB : null),
    cachedRecordings: () => [snapA, snapB],
    setViewer() {},
    removeViewer() {},
  });
  const app = createApplication({ config: configuration({ port: 0, dataDir }), credentials, browser, sync });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/live`, { origin: base });
  const received = [];
  ws.on('message', raw => received.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await new Promise(resolve => setTimeout(resolve, 40));

  // Watch tab-a in browser mode
  ws.send(JSON.stringify({ type: 'watch', tabId: 'tab-a', paused: false, viewMode: 'browser' }));
  await new Promise(resolve => setTimeout(resolve, 30));
  received.length = 0;

  browser.emit('recording', { type: 'rrweb-events', tabId: 'tab-b', documentId: 'doc-b', firstSequence: 3, lastSequence: 3, serverTime: Date.now(), events: [{ type: 3, timestamp: 3, data: { source: 0 } }] });
  browser.emit('recording', { type: 'rrweb-events', tabId: 'tab-a', documentId: 'doc-a', firstSequence: 3, lastSequence: 3, serverTime: Date.now(), events: [{ type: 3, timestamp: 3, data: { source: 0 } }] });
  await new Promise(resolve => setTimeout(resolve, 60));

  const rrEvents = received.filter(m => m.type === 'rrweb-events');
  assert.deepEqual(rrEvents.map(m => m.tabId), ['tab-a']);

  // Switching to overview mode receives snapshots for both tabs and streams both
  received.length = 0;
  ws.send(JSON.stringify({ type: 'watch', tabId: 'tab-a', paused: false, viewMode: 'overview' }));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(received.filter(m => m.type === 'rrweb-snapshot').map(m => m.tabId).sort(), ['tab-a', 'tab-b']);
  ws.close();
});

test('enhanced CLI supports Shadow DOM/iframe snapshots, scroll, upload, console/network diagnostics, dialog handling, and CDP screencast', async t => {
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-opt-e2e-'));
  const chromiumPath = process.env.DITTO_CHROMIUM_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  const config = configuration({ dataDir, port: 0, cdpPort: 0, demo: false, chromiumPath });
  const credentials = await loadCredentials(dataDir);
  const browser = new BrowserService(config);
  const sync = new SyncStore(dataDir);
  await sync.load();
  const app = createApplication({ config, credentials, browser, sync });

  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/missing-api')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    if (req.url === '/child') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><button id="in-frame" onclick="this.textContent=\'IframeClicked\'">ClickFrame</button>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Enhanced CLI Test</title>
      <style>body{height:2400px;margin:0;padding:16px}</style>
      <input id="chk" type="checkbox" checked>
      <input id="val" value="prefilled">
      <button id="dis" disabled>DisabledBtn</button>
      <input id="uploader" type="file">
      <div id="upload-name"></div>
      <div id="host"></div>
      <iframe id="sub" src="/child" width="200" height="60"></iframe>
      <button id="ask" onclick="setTimeout(()=>{ window.__ans = prompt('Name?'); }, 10)">AskPrompt</button>
      <button id="delayed" onclick="setTimeout(()=>{ const d=document.createElement('div'); d.textContent='AsyncReadyText'; document.body.appendChild(d); }, 80)">Delay</button>
      <script>
        const root = document.getElementById('host').attachShadow({ mode: 'open' });
        const sb = document.createElement('button');
        sb.textContent = 'ShadowBtn';
        sb.onclick = () => { sb.textContent = 'ShadowClicked'; };
        root.appendChild(sb);
        document.getElementById('uploader').addEventListener('change', e => {
          document.getElementById('upload-name').textContent = e.target.files[0]?.name || '';
        });
        console.error('synthetic-console-err');
        fetch('/missing-api?token=secret-should-strip').catch(() => {});
      </script>`);
  });

  t.after(async () => {
    await app.close().catch(() => {});
    await browser.stop().catch(() => {});
    if (site.listening) await new Promise(resolve => site.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  await browser.start();

  const base = `http://127.0.0.1:${app.server.address().port}`;
  const origin = `http://127.0.0.1:${site.address().port}`;
  const cli = async (...args) => {
    const { stdout } = await execFileAsync('./scripts/ditto', args, {
      env: { ...process.env, DITTO_URL: base, DITTO_SESSION: 'opt-test', DITTO_AGENT: 'codex' },
    });
    return JSON.parse(stdout);
  };

  const opened = await cli('open', `${origin}/`);
  const tid = opened.shortId;

  // Wait for iframe & fetch to finish
  await cli('wait', '--networkidle', '--tab', tid);

  // 1. Snapshot includes states, Shadow DOM button, and same-origin iframe button
  const snap = await cli('snapshot', '--tab', tid);
  const chk = snap.elements.find(e => e.type === 'checkbox');
  assert.equal(chk?.checked, true);
  const valInput = snap.elements.find(e => e.value === 'prefilled');
  assert.ok(valInput);
  const disBtn = snap.elements.find(e => e.text === 'DisabledBtn');
  assert.equal(disBtn?.disabled, true);
  const shadowBtn = snap.elements.find(e => e.text === 'ShadowBtn');
  assert.ok(shadowBtn, 'Shadow DOM button should be discovered in snapshot');
  const frameBtn = snap.elements.find(e => e.text === 'ClickFrame');
  assert.ok(frameBtn && frameBtn.frame === 'sub', 'Same-origin iframe button should be discovered');

  await cli('click', shadowBtn.ref, '--tab', tid);
  await cli('click', frameBtn.ref, '--tab', tid);
  const snapAfter = await cli('snapshot', '--tab', tid);
  assert.ok(snapAfter.elements.some(e => e.text === 'ShadowClicked'));
  assert.ok(snapAfter.elements.some(e => e.text === 'IframeClicked'));

  // 2. Scroll command
  await cli('scroll', 'down', '500', '--tab', tid);
  const scrollY = (await cli('eval', 'window.scrollY', '--tab', tid)).result;
  assert.ok(scrollY >= 400);

  // 3. Upload local file via CLI
  const sampleFile = path.join(dataDir, 'hello-upload.txt');
  await writeFile(sampleFile, 'hello-ditto');
  const uploaderEl = snapAfter.elements.find(e => e.type === 'file');
  assert.ok(uploaderEl);
  await cli('upload', uploaderEl.ref, sampleFile, '--tab', tid);
  assert.equal((await cli('eval', "document.getElementById('upload-name').textContent", '--tab', tid)).result, 'hello-upload.txt');

  // 4. Console & Network diagnostics (with query string stripped from URL)
  const cons = await cli('console', '--tab', tid);
  assert.ok(cons.entries.some(e => e.level === 'error' && e.text.includes('synthetic-console-err')));
  const net = await cli('network', '--tab', tid);
  const missingReq = net.entries.find(e => e.status === 404);
  assert.ok(missingReq);
  assert.equal(missingReq.url.includes('secret-should-strip'), false);

  // 5. Wait --text
  const delayBtn = snapAfter.elements.find(e => e.text === 'Delay');
  await cli('click', delayBtn.ref, '--tab', tid);
  await cli('wait', '--text', 'AsyncReadyText', '--tab', tid);

  // 6. Native prompt dialog accept via CLI
  const askBtn = snapAfter.elements.find(e => e.text === 'AskPrompt');
  await cli('click', askBtn.ref, '--tab', tid);
  await new Promise(resolve => setTimeout(resolve, 100));
  await cli('dialog', 'accept', 'DittoUser', '--tab', tid);
  assert.equal((await cli('eval', 'window.__ans', '--tab', tid)).result, 'DittoUser');

  // 7. CDP Screencast streams real JPEG frames and stops cleanly
  const frames = [];
  browser.on('screencast-frame', f => frames.push(f));
  await browser.enableScreencast('sc-viewer', opened.tabId);
  await cli('scroll', 'top', '--tab', tid);
  const deadline = Date.now() + 4000;
  while (!frames.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(frames.length >= 1 && frames[0].data.length > 100 && Buffer.isBuffer(frames[0].rawBuffer));
  await browser.disableScreencast('sc-viewer', opened.tabId);
  assert.equal(browser.screencast.hasViewers(opened.tabId), false);
});

test('importSnapshotToBrowser skips unchanged localStorage in full mode without spawning a seed page or locking browser', async () => {
  let newPageCalls = 0;
  let importingLocked = false;
  const mockSeedPage = {
    route: async () => {},
    unroute: async () => {},
    goto: async () => {},
    evaluate: async () => {},
    close: async () => {},
  };
  const mockCdp = {
    send: async () => ({ success: true }),
    detach: async () => {},
  };
  const browser = new BrowserService({ viewport: { width: 1280, height: 800 } });
  browser.ready = true;
  browser.on('change', s => { if (s.importing) importingLocked = true; });
  browser.context = {
    newPage: async () => { newPageCalls++; return mockSeedPage; },
    newCDPSession: async () => mockCdp,
  };
  browser.tabs.set('existing', {
    id: 'existing',
    hidden: false,
    crashed: false,
    page: { isClosed: () => false, url: () => 'https://other.test/' },
    cdp: mockCdp,
  });

  const snap = {
    mode: 'full',
    cookies: [{ name: 'sid', value: 'v1', url: 'https://app.test/', path: '/', secure: true, httpOnly: true }],
    origins: [{ origin: 'https://app.test', localStorage: [{ name: 'k', value: 'v1' }], sessionStorage: [] }],
  };
  const first = await importSnapshotToBrowser(browser, snap);
  assert.equal(first.writtenStorage, 1);
  assert.equal(first.skippedUnchangedStorage, 0);
  assert.equal(newPageCalls, 1);
  assert.equal(importingLocked, true);

  // Second full import with identical localStorage + updated cookie must NOT open seedPage or lock browser.importing.
  newPageCalls = 0;
  importingLocked = false;
  const second = await importSnapshotToBrowser(browser, {
    ...snap,
    cookies: [{ name: 'sid', value: 'v2', url: 'https://app.test/', path: '/', secure: true, httpOnly: true }],
  });
  assert.equal(second.writtenCookies, 1);
  assert.equal(second.writtenStorage, 0);
  assert.equal(second.skippedUnchangedStorage, 1);
  assert.equal(newPageCalls, 0);
  assert.equal(importingLocked, false);

  // Changing localStorage triggers seedPage again cleanly.
  const third = await importSnapshotToBrowser(browser, {
    ...snap,
    origins: [{ origin: 'https://app.test', localStorage: [{ name: 'k', value: 'v2' }], sessionStorage: [] }],
  });
  assert.equal(third.writtenStorage, 1);
  assert.equal(newPageCalls, 1);
});

test('SyncStore.applyDirect skips pending.json when Chromium is ready and falls back to pending.json on error or unready state', async t => {
  const dir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-direct-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { access } = await import('node:fs/promises');
  const store = new SyncStore(dir);
  await store.load();
  const snap = {
    schemaVersion: 1,
    source: 'extension',
    mode: 'full',
    collectedAt: new Date().toISOString(),
    cookies: [{ name: 'c', value: '1', url: 'https://a.test/', path: '/' }],
    origins: [],
    warnings: [],
  };

  // Ready browser applies directly without creating pending.json
  const okRes = await store.applyDirect(snap, {
    ready: true,
    importSnapshot: async () => ({ importedCookies: 1, importedOrigins: 0, importedStorage: 0, importWarnings: [] }),
  });
  assert.ok(okRes.applied);
  assert.equal(store.pending, null);
  await assert.rejects(access(path.join(dir, 'pending.json')));

  // Failed import writes pending.json for durable retry
  await assert.rejects(store.applyDirect(snap, {
    ready: true,
    importSnapshot: async () => { throw new Error('boom'); },
  }));
  assert.ok(store.pending);
  await access(path.join(dir, 'pending.json'));

  // Subsequent direct success clears the old pending.json
  const recovered = await store.applyDirect(snap, {
    ready: true,
    importSnapshot: async () => ({ importedCookies: 1, importedOrigins: 0, importedStorage: 0, importWarnings: [] }),
  });
  assert.ok(recovered.applied);
  assert.equal(store.pending, null);
  await assert.rejects(access(path.join(dir, 'pending.json')));
});

test('RecordingBuffer serializeRecordingMessage matches JSON.stringify and binary screencast frames stream with backpressure', async t => {
  const buf = new RecordingBuffer('tab-1', 'doc-1');
  buf.append({ type: 4, timestamp: 10, data: { width: 1280, height: 800, href: 'about:blank' } });
  const snap = buf.append({ type: 2, timestamp: 11, data: { node: { type: 0, id: 1, childNodes: [] } } });
  assert.deepEqual(JSON.parse(serializeRecordingMessage(snap)), JSON.parse(JSON.stringify(snap)));
  const evt = buf.append({ type: 3, timestamp: 12, data: { source: 0, adds: [] } });
  assert.deepEqual(JSON.parse(serializeRecordingMessage(evt)), JSON.parse(JSON.stringify(evt)));

  // Binary screencast encoding
  const rawJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const packet = encodeBinaryScreencastFrame({
    tabId: 'tab-1', width: 1280, height: 720, timestamp: 12345, rawBuffer: rawJpeg,
  });
  const headerLen = packet.readUInt32BE(0);
  const header = JSON.parse(packet.subarray(4, 4 + headerLen).toString('utf8'));
  assert.deepEqual(header, { type: 'screencast-frame', tabId: 'tab-1', width: 1280, height: 720, timestamp: 12345 });
  assert.deepEqual(packet.subarray(4 + headerLen), rawJpeg);

  // Live WS receives binary screencast frame and does not disconnect under backpressure
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-bin-sc-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const credentials = await loadCredentials(dataDir);
  const sync = new SyncStore(dataDir);
  await sync.load();
  const browser = new EventEmitter();
  Object.assign(browser, {
    ready: true,
    assets: new AssetCache(),
    summary: () => ({ ready: true, importing: false, activeTabId: 't1', tabs: [{ id: 't1', url: 'https://sc.test' }] }),
    cachedRecording: () => null,
    cachedRecordings: () => [],
    setViewer() {},
    removeViewer() {},
    enableScreencast: async () => true,
    disableScreencast: async () => {},
  });
  const app = createApplication({ config: configuration({ port: 0, dataDir }), credentials, browser, sync });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/live`, { origin: base });
  const binaryMessages = [];
  ws.on('message', (data, isBinary) => { if (isBinary) binaryMessages.push(Buffer.from(data)); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'screencast', enabled: true, tabId: 't1' }));
  await new Promise(resolve => setTimeout(resolve, 40));
  browser.emit('screencast-frame', { tabId: 't1', width: 800, height: 600, timestamp: 99, rawBuffer: rawJpeg });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(binaryMessages.length, 1);
  const hLen = binaryMessages[0].readUInt32BE(0);
  assert.deepEqual(binaryMessages[0].subarray(4 + hLen), rawJpeg);
  assert.equal(MAX_SCREENCAST_BUFFERED_BYTES, 512 * 1024);
  ws.close();
});

test('BrowserService.refresh guards re-entrancy, avoids per-tick favicon/origin spam, and pauses rrweb during screencast', async () => {
  const browser = new BrowserService({ viewport: { width: 1280, height: 800 } });
  browser.ready = true;
  browser.refreshHistory = async () => {};
  let faviconReads = 0;
  const originEmits = [];
  browser.on('cookie-origin', u => originEmits.push(u));
  let releaseTitle;
  const titleGate = new Promise(resolve => { releaseTitle = resolve; });
  let titleCalls = 0;
  const tab = {
    id: 't-opt',
    hidden: false,
    crashed: false,
    url: 'https://nofavicon.test/a',
    title: 'Initial',
    favicon: null,
    faviconUrlFor: null,
    originObserved: false,
    refreshing: false,
    page: {
      isClosed: () => false,
      url: () => 'https://nofavicon.test/a',
      title: async () => {
        titleCalls++;
        if (titleCalls === 1) await titleGate;
        return 'Page A';
      },
      evaluate: async () => { faviconReads++; return null; },
    },
  };
  browser.tabs.set(tab.id, tab);

  // Concurrent tick refresh calls coalesce via tab.refreshPromise guard
  const r1 = browser.refresh(tab, { fromTick: true });
  const r2 = browser.refresh(tab, { fromTick: true });
  releaseTitle();
  await Promise.all([r1, r2]);
  assert.equal(titleCalls, 1);
  assert.equal(faviconReads, 1);
  assert.equal(originEmits.length, 1);

  // Subsequent refresh on the same URL does NOT re-poll favicon or re-emit cookie-origin
  await browser.refresh(tab, { fromTick: true });
  assert.equal(faviconReads, 1);
  assert.equal(originEmits.length, 1);

  // isTabWatched returns false while the sole viewer is in screencast mode for that tab
  browser.setViewer('v1', 't-opt', false, 'browser');
  assert.equal(browser.isTabWatched('t-opt'), true);
  browser.screencast = new ScreencastManager();
  browser.screencast.sessions.set('t-opt', { viewers: new Set(['v1']) });
  assert.equal(browser.isTabWatched('t-opt'), false);
  browser.setViewer('v2', 't-opt', false, 'browser');
  assert.equal(browser.isTabWatched('t-opt'), true);
});
