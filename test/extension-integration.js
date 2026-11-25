import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';
import { configuration, projectRoot } from '../src/config.js';
import { BrowserService } from '../src/browser.js';
import { loadCredentials } from '../src/auth.js';
import { SyncStore } from '../src/sync-store.js';
import { createApplication } from '../src/app.js';

const execFileAsync = promisify(execFile);

process.umask(0o077);
const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-extension-test-'));
const config = configuration({ dataDir, port: 0, cdpPort: 0, demo: false,
  chromiumPath: process.env.DITTO_CHROMIUM_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
const credentials = await loadCredentials(dataDir);
const browser = new BrowserService(config);
const sync = new SyncStore(dataDir);
await sync.load();
const application = createApplication({ config, credentials, browser, sync });
let source;
let demandFixture;
let stage = 'start';
let extensionId;
try {
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  await browser.start();
  const base = `http://127.0.0.1:${application.server.address().port}`;
  const extension = path.join(projectRoot, 'extension');
  // Use Playwright Chromium: branded Chrome no longer supports side-loading through launch flags.
  source = await chromium.launchPersistentContext(path.join(dataDir, 'source-profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const page = source.pages()[0] || await source.newPage();
  await page.goto('chrome://extensions/');
  extensionId = await page.evaluate(async () => {
    const extensions = await new Promise(resolve => chrome.management.getAll(resolve));
    return extensions.find(extension => extension.name === 'Ditto · Browser Bridge')?.id;
  });
  assert.ok(extensionId, 'Ditto extension was not loaded by Chromium.');
  const target = await source.newPage();
  await target.goto(`${base}/demo.html`);
  await target.getByRole('button', { name: '创建本地演示登录态' }).click();
  const popup = await source.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#pairing').fill(base);
  await popup.locator('#save-pairing').click();
  await popup.locator('#paired').filter({ hasText: '已配对' }).waitFor();
  assert.equal(await popup.locator('#automatic-sync').count(), 0, 'Auto-sync toggle switch should be removed');
  assert.equal(await popup.locator('#cookie-requests').count(), 0, 'Recent synced sites list should be removed');
  assert.equal(await popup.evaluate(() => chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] })), true);
  stage = 'automatic-connect';
  await popup.locator('#automatic-status').filter({ hasText: '已连接' }).waitFor();
  // Full-profile Cookie sync captures all valid profile cookies so agents keep working offline.
  await source.addCookies([{ url: 'https://offline-agent.test', name: 'offline_cookie', value: 'synthetic-offline-only' }]);
  await popup.locator('#sync').click();
  await popup.locator('#result').filter({ hasText: '已全量同步' }).waitFor();
  const pending = sync.summary().applied;
  assert.equal(sync.pending, null);
  assert.equal(pending.mode, 'full');
  assert.ok(pending.cookieCount >= 2, `Expected full sync to include both demo and offline cookies, got ${pending.cookieCount}`);
  assert.equal((await browser.context.cookies('https://offline-agent.test')).some(c => c.name === 'offline_cookie'), true);
  // Reopen the popup and repeat without a separate checkbox or permissions.request.
  await popup.reload();
  await popup.locator('#paired').filter({ hasText: '已配对' }).waitFor();
  await popup.locator('#sync').click();
  await popup.locator('#result').filter({ hasText: '已全量同步' }).waitFor();
  const repeated = sync.summary().applied;
  assert.notEqual(repeated.id, pending.id);
  assert.equal(repeated.cookieCount, pending.cookieCount);
  const remotePage = await browser.context.newPage();
  await remotePage.goto(`${base}/demo.html`);
  assert.match(await remotePage.locator('#auth-status').textContent(), /Cookie \+ localStorage 均已恢复/);
  // Automatic full sync stays always-on after the popup closes.
  demandFixture = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Auto Cookie fixture</title><h1>Cookie-only fixture</h1>');
  });
  await new Promise(resolve => demandFixture.listen(0, '127.0.0.1', resolve));
  const demandOrigin = `http://127.0.0.1:${demandFixture.address().port}`;
  await source.addCookies([{ url: demandOrigin, name: 'ditto_auto_request', value: 'synthetic-cookie-only' }]);
  await popup.close();
  stage = 'pending-clear';
  await eventually(() => !sync.pending);
  const demandPage = await browser.context.newPage();
  await demandPage.goto(demandOrigin);
  stage = 'demand-upload';
  await eventually(async () => (await browser.context.cookies(demandOrigin)).some(cookie => cookie.name === 'ditto_auto_request'));
  // The open page is not refreshed. Its document stays stale while the profile has the cookie.
  assert.equal(await demandPage.evaluate(() => document.body.textContent.includes('Cookie-only fixture')), true);
  const visibleToNewPage = (await browser.context.cookies(demandOrigin)).some(cookie => cookie.name === 'ditto_auto_request');
  assert.equal(visibleToNewPage, true);
  await demandPage.evaluate(() => localStorage.setItem('remote-refreshed-token', 'synthetic-new-remote-value'));
  await demandPage.reload();
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(sync.pending, null);
  assert.equal(await demandPage.evaluate(() => localStorage.getItem('remote-refreshed-token')), 'synthetic-new-remote-value');
  // Opening a new tab in source Chrome proactively pushes that tab's cookie + storage without remote demand.
  await source.addCookies([{ url: demandOrigin, name: 'new_tab_pushed', value: 'pushed-from-mac' }]);
  const macNewTab = await source.newPage();
  await macNewTab.goto(demandOrigin);
  await eventually(async () => (await browser.context.cookies(demandOrigin)).some(cookie => cookie.name === 'new_tab_pushed'));
  await macNewTab.close();
  // A newly discovered origin still triggers on-demand sync cleanly.
  await source.addCookies([{ url: 'https://unselected.test', name: 'discovered_once', value: 'synthetic-only' }]);
  browser.emit('cookie-origin', 'https://unselected.test/login?must-not-disclose=synthetic');
  await eventually(async () => (await browser.context.cookies('https://unselected.test')).some(c => c.name === 'discovered_once'));
  assert.equal(sync.pending, null);
  await demandPage.close();

  // --- Phase 2: Unified config.json token + extension auto-login + stranger login gate + CLI auto-token ---
  stage = 'unified-token-setup';
  const authDataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-auth-ext-'));
  const unifiedToken = 'synthetic-unified-token-e2e-2026';
  await writeFile(path.join(authDataDir, 'config.json'), JSON.stringify({ token: unifiedToken, demo: false }), { mode: 0o600 });
  const authConfig = configuration({ dataDir: authDataDir, port: 0, cdpPort: 0 });
  assert.equal(authConfig.authRequired, true);
  assert.equal(authConfig.token, unifiedToken);
  const authCredentials = await loadCredentials(authDataDir, { token: authConfig.token });
  const authSync = new SyncStore(authDataDir);
  await authSync.load();
  const authApp = createApplication({ config: authConfig, credentials: authCredentials, browser, sync: authSync });
  let strangerContext = null;
  try {
    await new Promise(resolve => authApp.server.listen(0, '127.0.0.1', resolve));
    const authPort = authApp.server.address().port;
    const authBase = `http://127.0.0.1:${authPort}`;

    // Verify local `ditto` CLI automatically reads config.json token without DITTO_TOKEN env var.
    stage = 'cli-auto-token';
    const { stdout: cliOut } = await execFileAsync(path.join(projectRoot, 'scripts', 'ditto'), ['status'], {
      env: { ...process.env, DITTO_DATA_DIR: authDataDir, DITTO_PORT: String(authPort), DITTO_TOKEN: '', DITTO_URL: '' },
    });
    const cliStatus = JSON.parse(cliOut);
    assert.equal(cliStatus.ok, true);

    // Pair extension with wrong token -> rejected cleanly.
    stage = 'unified-token-wrong';
    const authPopup = await source.newPage();
    await authPopup.goto(`chrome-extension://${extensionId}/popup.html`);
    await authPopup.locator('#forget').click();
    await authPopup.locator('#pairing').fill(authBase);
    await authPopup.locator('#pairing-token').fill('wrong-token');
    await authPopup.locator('#save-pairing').click();
    await authPopup.locator('#result').filter({ hasText: 'Token 无效' }).waitFor();
    assert.equal(await authPopup.locator('#connected-bar').isHidden(), true);

    // Pair extension with correct token -> connects and installs HttpOnly ditto_session cookie.
    stage = 'unified-token-connect';
    await authPopup.locator('#pairing-token').fill(unifiedToken);
    await authPopup.locator('#save-pairing').click();
    await authPopup.locator('#paired').filter({ hasText: '已配对' }).waitFor();
    await authPopup.locator('#automatic-status').filter({ hasText: '已连接' }).waitFor();

    // Same browser (with extension configured) opens viewer directly -> zero login prompt!
    stage = 'owner-viewer-auto-login';
    const ownerViewer = await source.newPage();
    await ownerViewer.goto(authBase);
    await ownerViewer.locator('#workspace').waitFor({ state: 'visible' });
    assert.equal(await ownerViewer.locator('#login').isHidden(), true);

    // Another browser / stranger (no extension) opens viewer -> MUST enter token.
    stage = 'stranger-viewer-login-gate';
    strangerContext = await chromium.launchPersistentContext(path.join(authDataDir, 'stranger-profile'), {
      channel: 'chromium', headless: true,
    });
    const strangerViewer = await strangerContext.newPage();
    await strangerViewer.goto(authBase);
    await strangerViewer.locator('#login').waitFor({ state: 'visible' });
    assert.equal(await strangerViewer.locator('#workspace').isHidden(), true);

    // Wrong token stays blocked on login screen.
    await strangerViewer.locator('#dashboard-token').fill('wrong-token');
    await strangerViewer.locator('#login-form button[type="submit"]').click();
    await strangerViewer.locator('#toast').filter({ hasText: 'Token 无效' }).waitFor();
    assert.equal(await strangerViewer.locator('#workspace').isHidden(), true);

    // Correct token unlocks full viewer workspace.
    await strangerViewer.locator('#dashboard-token').fill(unifiedToken);
    await strangerViewer.locator('#login-form button[type="submit"]').click();
    await strangerViewer.locator('#workspace').waitFor({ state: 'visible' });
    assert.equal(await strangerViewer.locator('#login').isHidden(), true);

    // Forgetting pairing in extension clears ditto_session cookie so owner reload shows login again.
    stage = 'forget-clears-viewer-session';
    await authPopup.locator('#forget').click();
    await ownerViewer.reload();
    await ownerViewer.locator('#login').waitFor({ state: 'visible' });

    await ownerViewer.close();
    await authPopup.close();
  } finally {
    await strangerContext?.close();
    await authApp.close();
  }

  console.log(JSON.stringify({ ok: true, checks: [
    'real Chromium loads Manifest V3 extension',
    'all HTTP/HTTPS site access is granted once from the manifest',
    'full-profile sync uploads all valid profile cookies including sites for offline agent use',
    'repeated popup uploads work without a permission prompt or consent checkbox',
    'extension-origin authenticated upload is accepted',
    'independent remote Chromium recognizes imported synthetic login',
    'automatic full sync stays active after closing the popup without any toggle',
    'MV3 background worker performs full sync on connect after the popup closes',
    'opening a new tab in source Chrome proactively pushes fresh cookies to devbox',
    'applied remote tokens survive reload without destructive overwrites',
    'newly discovered remote origins still sync on demand when online',
    'config.json unified token pairs extension and auto-authenticates viewer in the same browser',
    'another browser without the extension requires the token before operating the viewer',
    'local ditto CLI automatically reads token from config.json',
    'forgetting pairing in the extension clears the auto-login viewer session cookie',
  ] }, null, 2));
} catch (error) {
  let backgroundStatus = null;
  if (source && extensionId) {
    const diagnostic = await source.newPage();
    await diagnostic.goto(`chrome-extension://${extensionId}/popup.html`);
    backgroundStatus = await diagnostic.evaluate(async () => (await chrome.storage.local.get('autoSyncStatus')).autoSyncStatus);
  }
  console.error(JSON.stringify({ ok: false, stage, errorType: error.name,
    background: backgroundStatus ? { connection: backgroundStatus.connection, uploading: backgroundStatus.uploading,
      stage: backgroundStatus.stage, requestCount: backgroundStatus.requests?.length, failed: Boolean(backgroundStatus.error) } : null,
    pending: Boolean(sync.summary().pending),
    appliedOrigins: sync.summary().applied?.origins || [],
    appliedCookieCount: sync.summary().applied?.cookieCount ?? null,
    privateDetailsRedacted: true }));
  process.exitCode = 1;
} finally {
  await source?.close();
  await application.close();
  await browser.stop();
  if (demandFixture) await new Promise(resolve => demandFixture.close(resolve));
}

async function eventually(predicate) {
  const deadline = Date.now() + 12000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Synthetic background sync did not finish.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
