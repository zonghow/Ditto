import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright';
import { projectRoot } from '../src/config.js';
import { readJson, writePrivateJson } from '../src/files.js';
import { ssh, quote } from './process.js';

// Deployed smoke test against a synthetic browser profile. Pairing authorizes
// the origins the remote browser asks for. This profile has no user Cookies.
// Never change a user's pending snapshot or remote tab.
process.umask(0o077);
const deployment = await readJson(path.join(projectRoot, '.local', 'deployment.json'));
assert.ok(deployment);
const { syncToken, dashboardToken } = JSON.parse(await ssh(deployment.remote,
  `cat ${quote(`${deployment.dataDir}/credentials.json`)}`, { capture: true }));
const base = 'http://127.0.0.1:3217';
const headers = { Authorization: `Bearer ${dashboardToken}` };
const before = await fetch(`${base}/api/state`, { headers }).then(response => response.json());
const pagesBefore = await fetch('http://127.0.0.1:9222/json/list').then(response => response.json());
const root = process.env.DITTO_TEST_TEMP || '/private/var/folders/1j/rh02q2tj6fb1nkwcx1056z9r0000gn/T/opencode';
const directory = await mkdtemp(path.join(root, 'ditto-auto-extension-'));
const extension = path.join(projectRoot, 'extension');
const source = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
let stage = 'extension';
try {
  const discovery = source.pages()[0];
  await discovery.goto('chrome://extensions/');
  const id = await discovery.evaluate(async () => {
    const items = await new Promise(resolve => chrome.management.getAll(resolve));
    return items.find(item => item.name === 'Ditto · Browser Bridge')?.id;
  });
  assert.ok(id);
  const popup = await source.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('#pairing').fill(JSON.stringify({ endpoint: base, syncToken }));
  await popup.locator('#save-pairing').click();
  await popup.locator('#paired').filter({ hasText: '已配对' }).waitFor();
  stage = 'connect';
  // Leave automatic sync off. Enabling it against the live browser would upload
  // an empty snapshot for every origin that browser is currently visiting.
  await popup.locator('#sync').click();
  await popup.locator('#result').filter({ hasText: '远端还没有访问需要同步的网站' }).waitFor({ timeout: 5000 }).catch(() => {});
  const connected = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'sync-status' });
    return response?.status?.paired === true;
  });
  assert.equal(connected, true);
  await popup.close();
  const worker = source.serviceWorkers().find(item => item.url().endsWith('/background.js'));
  assert.ok(worker);
  // Wait for a normal 20s heartbeat, then inspect only public status booleans.
  await new Promise(resolve => setTimeout(resolve, 22000));
  stage = 'background';
  const background = await worker.evaluate(async () => {
    const { autoSyncStatus } = await chrome.storage.local.get('autoSyncStatus');
    return { paired: autoSyncStatus.paired === true, enabled: autoSyncStatus.enabled === true,
      captured: autoSyncStatus.uploading || Boolean(autoSyncStatus.lastUpload) };
  });
  assert.equal(background.paired, true);
  assert.equal(background.enabled, false);
  assert.equal(background.captured, false);
  const after = await fetch(`${base}/api/state`, { headers }).then(response => response.json());
  const pagesAfter = await fetch('http://127.0.0.1:9222/json/list').then(response => response.json());
  assert.equal(after.sync.pending?.id ?? null, before.sync.pending?.id ?? null);
  assert.equal(after.sync.applied?.id ?? null, before.sync.applied?.id ?? null);
  const surviving = new Set(pagesAfter.filter(item => item.type === 'page').map(item => item.id));
  assert.ok(pagesBefore.filter(item => item.type === 'page').every(item => surviving.has(item.id)));
  const evidence = { ok: true, verifiedAt: new Date().toISOString(), mode: 'paired-demand-empty-profile', checks: [
    'real MV3 background extension authenticates to the deployed demand channel through SSH',
    'origin requests remain available after closing the popup and a background heartbeat',
    'an empty synthetic profile starts no Cookie upload',
    'user pending/applied login state and original Chromium tabs are unchanged',
  ] };
  await writePrivateJson(path.join(projectRoot, 'artifacts', 'auto-sync-verification.json'), evidence);
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, stage, errorType: error.name, privateDetailsRedacted: true }));
  process.exitCode = 1;
} finally { await source.close(); }
