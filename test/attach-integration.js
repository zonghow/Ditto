import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright';
import { configuration } from '../src/config.js';
import { BrowserService } from '../src/browser.js';
import { loadCredentials } from '../src/auth.js';
import { SyncStore } from '../src/sync-store.js';
import { UpstreamSync } from '../src/upstream-sync.js';
import { createApplication } from '../src/app.js';

process.umask(0o077);
const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-attach-test-'));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const cdpPort = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const chromiumPath = process.env.DITTO_CHROMIUM_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const owner = await chromium.launchPersistentContext(path.join(dataDir, 'profile'), {
  executablePath: chromiumPath, channel: 'chromium', headless: true,
  args: [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1'],
});
const page = owner.pages()[0];
const fixture = http.createServer((request, response) => response.end('<!doctype html><title>Attached fixture</title><h1 id="result">Before attach</h1>'));
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
await page.goto(`http://127.0.0.1:${fixture.address().port}`);
const credentials = await loadCredentials(dataDir);
const ownerSync = new SyncStore(dataDir);
await ownerSync.load();
const ownerService = { ready: true, summary: () => ({ ready: true, importing: false, tabs: [] }), setViewer() {}, removeViewer() {}, cachedRecordings: () => [],
  on() {}, off() {}, importSnapshot: async snapshot => ({ importedCookies: snapshot.cookies.length, importedOrigins: 0, importedStorage: 0 }) };
const original = createApplication({ config: configuration({ port: 0, dataDir }), credentials, browser: ownerService, sync: ownerSync });
await new Promise(resolve => original.server.listen(0, '127.0.0.1', resolve));
const upstreamEndpoint = `http://127.0.0.1:${original.server.address().port}`;
const sync = new UpstreamSync(upstreamEndpoint, credentials);
const config = configuration({ port: 0, dataDir, demo: false, attachCDP: `http://127.0.0.1:${cdpPort}`, syncUpstream: upstreamEndpoint });
const browser = new BrowserService(config);
const companion = createApplication({ config, credentials, browser, sync });
try {
  await sync.load();
  await new Promise(resolve => companion.server.listen(0, '127.0.0.1', resolve));
  await browser.start();
  await page.waitForFunction(() => Boolean(window.__dittoRecorderV1));
  await eventually(() => browser.summary().tabOrder === 'chromium');
  assert.equal(browser.summary().tabs[0].index, 0);
  assert.equal(owner.pages().length, 1);
  assert.equal(await page.locator('#result').textContent(), 'Before attach');
  // Unwatched attached tabs keep rrweb idle until a viewer connects.
  assert.equal(await page.evaluate(() => window.__dittoRecorderV1.recording), false);
  browser.setViewer('attach-viewer', null, false, 'browser');
  await page.waitForFunction(() => window.__dittoRecorderV1?.recording === true);
  await page.evaluate(() => { document.querySelector('#result').textContent = 'Still same document'; });
  await eventually(() => browser.cachedRecordings().some(recording => JSON.stringify(recording).includes('Still same document')));
  const base = `http://127.0.0.1:${companion.server.address().port}`;
  const response = await fetch(`${base}/api/sync`, { method: 'POST', headers: {
    Authorization: `Bearer ${credentials.syncToken}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ schemaVersion: 1, cookies: [], origins: [{ origin: 'https://example.com', localStorage: [] }] }) });
  assert.equal(response.status, 200);
  const { pending, applied } = await response.json();
  assert.equal(ownerSync.summary().pending, null);
  assert.equal(ownerSync.summary().applied.id, pending.id);
  assert.equal(applied.id, pending.id);
  assert.equal(sync.summary().applied.id, pending.id);
  // New automatic routes live on the companion, while the old single writer
  // receives a normal validated snapshot and still owns applying it.
  browser.emit('cookie-origin', 'https://auto-companion.test/login?private=not-shared');
  const demands = await fetch(`${base}/api/sync/requests`, { headers: { Authorization: `Bearer ${credentials.syncToken}` } }).then(response => response.json());
  const demand = demands.requests.find(request => request.origin === 'https://auto-companion.test');
  assert.ok(demand);
  const automaticUpload = await fetch(`${base}/api/sync/auto`, { method: 'POST', headers: {
    Authorization: `Bearer ${credentials.syncToken}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ requestIds: [demand.id], snapshot: { schemaVersion: 1, cookies: [],
    origins: [{ origin: 'https://auto-companion.test', localStorage: [] }] } }) });
  assert.equal(automaticUpload.status, 200);
  const automaticPending = (await automaticUpload.json()).pending;
  assert.equal(ownerSync.summary().pending, null);
  assert.equal(ownerSync.summary().applied.id, automaticPending.id);
  assert.equal(sync.summary().applied.id, automaticPending.id);
  const duplicateUpload = await fetch(`${base}/api/sync/auto`, { method: 'POST', headers: {
    Authorization: `Bearer ${credentials.syncToken}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ requestIds: [demand.id], snapshot: { schemaVersion: 1, cookies: [],
    origins: [{ origin: 'https://auto-companion.test', localStorage: [] }] } }) });
  assert.equal(duplicateUpload.status, 409);
  await browser.stop();
  assert.equal(page.isClosed(), false);
  assert.equal(await page.locator('#result').textContent(), 'Still same document');
  assert.equal((await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).status, 200);
  await browser.start();
  await page.waitForFunction(() => Boolean(window.__dittoRecorderV1));
  await page.evaluate(() => { document.querySelector('#result').textContent = 'After companion restart'; });
  await eventually(() => browser.cachedRecordings().some(recording => JSON.stringify(recording).includes('After companion restart')));
  await page.reload();
  await page.waitForFunction(instanceId => window.__dittoRecorderV1?.instanceId === instanceId, browser.recordingInstance);
  await page.evaluate(() => { document.querySelector('#result').textContent = 'Navigation after restart'; });
  await eventually(() => browser.cachedRecordings().some(recording => JSON.stringify(recording).includes('Navigation after restart')));
  const firstIndex = browser.summary().tabs.find(tab => tab.url === page.url()).index;
  const newId = await browser.open('about:blank');
  await eventually(() => browser.summary().tabOrder === 'chromium' && browser.summary().tabs.length === 2);
  assert.deepEqual(browser.summary().tabs.map(tab => tab.index), [firstIndex, firstIndex + 1]);
  await browser.tabAction(newId, 'close');
  await eventually(() => browser.summary().tabs.length === 1);
  assert.equal(page.isClosed(), false);
  const lastTab = [...browser.tabs.values()].find(tab => tab.page.url() === page.url());
  const lastResult = await browser.tabAction(lastTab.id, 'close');
  assert.ok(lastResult.replacementId);
  await eventually(() => browser.summary().tabs.length === 1 && browser.summary().tabs[0].url === 'about:blank');
  assert.equal((await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).status, 200);
  await browser.stop();
  console.log(JSON.stringify({ ok: true, checks: [
    'attached recorder observes the existing persistent context without opening, reloading or closing a tab',
    'companion forwards upload/apply to the original single-writer SyncStore',
    'on-demand automatic upload writes through the original browser owner without refreshing its open page',
    'stopping the attached observer disconnects CDP without closing the owned Chromium',
    'attached observer can restart and record the existing document without stale binding conflicts',
    'native Chromium tabStripIndex maps to real page order and tracks new/closed tabs',
    'closing the last tab keeps persistent Chromium alive with a replacement blank tab',
  ] }, null, 2));
} finally {
  sync.close();
  await companion.close();
  await original.close();
  await browser.stop();
  await owner.close();
  await new Promise(resolve => fixture.close(resolve));
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Attached rrweb recorder did not observe the existing document.');
}
