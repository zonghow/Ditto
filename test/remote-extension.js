import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright';
import { projectRoot } from '../src/config.js';
import { readJson } from '../src/files.js';
import { ssh, quote } from '../scripts/process.js';

// Synthetic-only Mac-extension -> SSH -> actual devbox Chromium verification.
process.umask(0o077);
const deployment = await readJson(path.join(projectRoot, '.local', 'deployment.json'));
if (!deployment) throw new Error('Deploy Ditto and connect the SSH tunnel first.');
const credentials = JSON.parse(await ssh(deployment.remote,
  `cat ${quote(`${deployment.dataDir}/credentials.json`)}`, { capture: true }));
const base = 'http://127.0.0.1:3217';
const dashboardHeaders = { Authorization: `Bearer ${credentials.dashboardToken}`, 'Content-Type': 'application/json' };
const current = await fetch(`${base}/api/state`, { headers: dashboardHeaders }).then(response => response.json());
if (current.sync.pending) throw new Error('A user snapshot is pending. Refusing to overwrite it with synthetic test data.');
const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-remote-extension-'));
const extension = path.join(projectRoot, 'extension');
const source = await chromium.launchPersistentContext(path.join(dataDir, 'source-profile'), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
let remoteBrowser;
let remotePage;
try {
  const discovery = source.pages()[0];
  await discovery.goto('chrome://extensions/');
  const extensionId = await discovery.evaluate(async () => {
    const extensions = await new Promise(resolve => chrome.management.getAll(resolve));
    return extensions.find(extension => extension.name === 'Ditto · Browser Bridge')?.id;
  });
  assert.ok(extensionId);
  const target = await source.newPage();
  await target.goto(`${base}/demo.html`);
  await target.getByRole('button', { name: '创建本地演示登录态' }).click();
  const popup = await source.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const pending = await popup.evaluate(async ({ base, syncToken }) => {
    const { captureSnapshot, uploadSnapshot } = await import('./capture.js');
    const snapshot = await captureSnapshot([base]);
    return uploadSnapshot({ endpoint: base, syncToken }, snapshot);
  }, { base, syncToken: credentials.syncToken });
  assert.equal(pending.cookieCount, 1);
  assert.equal(pending.storageCount, 1);
  assert.equal(pending.importedCookies, 1);
  assert.equal(pending.importedStorage, 1);
  remoteBrowser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  remotePage = await remoteBrowser.contexts()[0].newPage();
  await remotePage.goto(`${base}/demo.html?verification=mac-extension`);
  assert.match(await remotePage.locator('#auth-status').textContent(), /Macbook demo · Cookie \+ localStorage 均已恢复/);
  console.log(JSON.stringify({ ok: true, checks: [
    'Mac Chromium extension collects only the synthetic demo origin',
    'extension sends authenticated Cookie and localStorage snapshot through SSH to devbox',
    'explicit apply imports into the actual persistent devbox Chromium',
    'actual remote page recognizes both Cookie and localStorage before page scripts',
  ] }, null, 2));
} finally {
  await remotePage?.close();
  await remoteBrowser?.close();
  await source.close();
}
