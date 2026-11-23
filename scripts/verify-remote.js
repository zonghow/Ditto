import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { projectRoot } from '../src/config.js';
import { readJson, writePrivateJson } from '../src/files.js';
import { ssh, quote } from './process.js';

// Only synthetic demo tabs are operated or closed. No real Cookie/storage or
// private DOM is printed or saved by this verification script.
process.umask(0o077);
const deployment = await readJson(path.join(projectRoot, '.local', 'deployment.json'));
if (!deployment) throw new Error('Deploy Ditto and connect its SSH tunnel first.');
const raw = await ssh(deployment.remote, `cat ${quote(`${deployment.dataDir}/credentials.json`)}`, { capture: true });
const credentials = JSON.parse(raw);
const base = 'http://127.0.0.1:3217';
const remoteBase = `http://127.0.0.1:${deployment.viewerPort || 3217}`;
const headers = { Authorization: `Bearer ${credentials.dashboardToken}` };
const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
assert.equal((await health.json()).browserReady, true);
const checks = ['devbox Chromium and rrweb observation service are ready through SSH'];
const agent = await chromium.connectOverCDP('http://127.0.0.1:9222');
let ws;
let observerBrowser;
let page;
let second;
const messages = [];
const syntheticIds = new Set();
try {
  const context = agent.contexts()[0];
  assert.ok(context);
  const version = agent.version();
  const originalPages = [...context.pages()];
  const query = `rrweb-verification-${Date.now()}`;
  page = await context.newPage();
  await page.goto(`${remoteBase}/demo.html?${query}`);
  await page.getByLabel('你的名字').fill('AI on devbox');
  await page.getByRole('button', { name: '更新页面' }).click();
  assert.match(await page.locator('#greeting').textContent(), /AI on devbox/);
  checks.push('AI CDP client operates the same persistent Chromium that rrweb records');
  second = await context.newPage();
  await second.goto(`${remoteBase}/demo.html?${query}-second`);
  let state;
  await eventually(async () => {
    state = await fetch(`${base}/api/state`, { headers }).then(response => response.json());
    return state.browser.tabs.filter(tab => tab.url.includes(query) && tab.recordingStatus === 'live').length === 2;
  });
  const target = state.browser.tabs.find(tab => tab.url.includes(query) && !tab.url.includes('-second'));
  const secondTab = state.browser.tabs.find(tab => tab.url.includes(`${query}-second`));
  assert.ok(target && secondTab);
  assert.equal(state.browser.tabOrder, 'chromium');
  const inventory = await agent.newBrowserCDPSession();
  try {
    const { targetInfos } = await inventory.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    const native = new Map(targetInfos.map(info => [info.targetId, info.embedderData.tabStripIndex]));
    assert.equal(native.size, state.browser.tabs.length);
    assert.ok(state.browser.tabs.every(tab => native.get(tab.nativeTabId) === tab.index));
    assert.ok(state.browser.tabs.every((tab, index, tabs) => !index || tabs[index - 1].index <= tab.index));
  } finally { await inventory.detach(); }
  checks.push('viewer order matches each real Chromium tab target and tabStripIndex, not URL or discovery order');
  syntheticIds.add(target.id);
  syntheticIds.add(secondTab.id);
  ws = new WebSocket('ws://127.0.0.1:3217/api/live', { headers: { ...headers, Origin: base } });
  ws.on('message', raw => {
    const data = JSON.parse(raw.toString());
    if (syntheticIds.has(data.tabId)) messages.push(data);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await eventually(() => [...syntheticIds].every(id => messages.some(item => item.type === 'rrweb-snapshot' && item.tabId === id)));
  await page.evaluate(() => { document.querySelector('#greeting').textContent = 'rrweb incremental update'; });
  await eventually(() => messages.some(item => item.type === 'rrweb-events' && JSON.stringify(item.events).includes('rrweb incremental update')));
  assert.equal(messages.some(item => item.type === 'frame' || item.image), false);
  checks.push('WebSocket carries real per-tab rrweb full snapshots and incremental DOM events, with no JPEG transport');
  observerBrowser = await chromium.launch({ channel: 'chromium', headless: true,
    executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined });
  const viewerContext = await observerBrowser.newContext({ viewport: { width: 1440, height: 1100 } });
  const observer = await viewerContext.newPage();
  const pageErrors = [];
  observer.on('pageerror', error => { pageErrors.push(error.name); });
  await observer.goto(`${base}/#token=${credentials.dashboardToken}`);
  await observer.locator('#workspace').waitFor({ state: 'visible' });
  await observer.locator(`.tab-button[data-tab-id="${target.id}"]`).click();
  const replay = () => observer.frameLocator('#main-replay iframe');
  await replay().locator('#greeting').filter({ hasText: 'rrweb incremental update' }).waitFor();
  assert.equal(await observer.locator('#main-replay iframe').getAttribute('sandbox'), 'allow-same-origin');
  checks.push('Mac viewer reconstructs remote DOM in a script-disabled rrweb iframe');
  await observer.locator('#take-control').click();
  await observer.locator('#take-control').filter({ hasText: '释放操作' }).waitFor();
  await observer.waitForFunction(() => document.querySelector('#control-surface')?.dataset.mode === 'control');
  const clickReplay = async selector => {
    const box = await replay().locator(selector).boundingBox();
    assert.ok(box);
    await observer.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  await clickReplay('#demo-name');
  await observer.locator('#remote-editor').waitFor({ state: 'visible' });
  await observer.locator('#remote-editor').fill('Mac 接管 rrweb');
  await eventually(async () => await page.locator('#demo-name').inputValue() === 'Mac 接管 rrweb');
  await clickReplay('#hello');
  await page.locator('#greeting').filter({ hasText: 'Mac 接管 rrweb' }).waitFor();
  await replay().locator('#greeting').filter({ hasText: 'Mac 接管 rrweb' }).waitFor();
  checks.push('Mac observation-page input and click reach the actual devbox page and return as rrweb mutations');
  const shellPageCreated = context.waitForEvent('page');
  await observer.locator('#new-tab').click();
  const shellPage = await shellPageCreated;
  try {
    await observer.waitForFunction(() => document.querySelector('#address-bar') && !document.querySelector('#address-bar').disabled && document.querySelector('.browser-tab.selected .tab-title')?.textContent === '新标签页');
    await observer.locator('#address-bar').fill(`${remoteBase}/demo.html?${query}-address`);
    await observer.locator('#address-bar').press('Enter');
    await shellPage.waitForURL(`${remoteBase}/demo.html?${query}-address`);
    await observer.frameLocator('#main-replay iframe').locator('#greeting').waitFor();
    const beforeReload = await shellPage.evaluate(() => window.__dittoRecorderV1.documentId);
    await observer.locator('#reload-tab').click();
    await shellPage.waitForFunction(id => window.__dittoRecorderV1?.documentId && window.__dittoRecorderV1.documentId !== id, beforeReload);
    await observer.waitForFunction(() => !document.querySelector('#reload-tab').disabled);
    await observer.locator('#address-bar').fill(`${remoteBase}/demo.html?${query}-history`);
    await observer.locator('#address-bar').press('Enter');
    await shellPage.waitForURL(`${remoteBase}/demo.html?${query}-history`);
    await observer.waitForFunction(() => !document.querySelector('#back-tab').disabled);
    await observer.locator('#back-tab').click();
    await shellPage.waitForURL(`${remoteBase}/demo.html?${query}-address`);
    await observer.waitForFunction(() => !document.querySelector('#forward-tab').disabled);
    await observer.locator('#forward-tab').click();
    await shellPage.waitForURL(`${remoteBase}/demo.html?${query}-history`);
    await observer.waitForFunction(() => !document.querySelector('#reload-tab').disabled);
    const shellState = await fetch(`${base}/api/state`, { headers }).then(response => response.json());
    const shellTab = shellState.browser.tabs.find(tab => tab.url.includes(`${query}-history`));
    await observer.locator(`.browser-tab[data-tab-id="${shellTab.id}"] .tab-close`).click();
    await eventually(() => shellPage.isClosed());
    checks.push('browser shell creates/closes real remote tabs and performs address navigation, reload and back/forward in Chromium');
  } finally { await shellPage.close().catch(() => {}); }
  await observer.locator(`.tab-button[data-tab-id="${target.id}"]`).click();
  await replay().locator('#greeting').filter({ hasText: 'Mac 接管 rrweb' }).waitFor();
  const surfaceBox = await observer.locator('#control-surface').boundingBox();
  await observer.mouse.move(surfaceBox.x + 30, surfaceBox.y + 30);
  await observer.mouse.wheel(0, 450);
  await page.waitForFunction(() => scrollY > 100);
  await observer.waitForFunction(() => document.querySelector('#main-replay iframe')?.contentWindow.scrollY > 100);
  checks.push('viewer scrolling operates remote Chromium and live replay follows remote scroll');
  const competing = await viewerContext.newPage();
  await competing.goto(base);
  await competing.locator('#workspace').waitFor({ state: 'visible' });
  await competing.locator('#take-control').filter({ hasText: '其他窗口接管中' }).waitFor();
  assert.equal(await competing.locator('#take-control').isEnabled(), false);
  await competing.close();
  await observer.reload();
  await observer.locator('#workspace').waitFor({ state: 'visible' });
  await observer.locator(`.tab-button[data-tab-id="${target.id}"]`).click();
  await replay().locator('#greeting').filter({ hasText: 'Mac 接管 rrweb' }).waitFor();
  await eventually(async () => (await fetch(`${base}/api/state`, { headers }).then(response => response.json())).browser.control.owner === null);
  assert.equal(await observer.evaluate(() => location.hash), '');
  checks.push('takeover is exclusive, disconnect releases it, and reload restores the latest rrweb checkpoint');
  await page.evaluate(() => scrollTo(0, 0));
  await observer.waitForFunction(() => document.querySelector('#main-replay iframe')?.contentWindow.scrollY === 0);
  // Hide real tab titles/URLs/previews only in this local screenshot to avoid
  // putting private account content into verification artifacts.
  await observer.evaluate(ids => {
    for (const node of document.querySelectorAll('.tab-button,.thumbnail')) if (!ids.includes(node.dataset.tabId)) node.hidden = true;
    for (const node of document.querySelectorAll('.browser-tab')) if (!ids.includes(node.dataset.tabId)) node.hidden = true;
    document.querySelector('#settings').hidden = true;
    document.querySelector('#address-bar').value = '合成验证页 · 真实账号页面未截图';
  }, [...syntheticIds]);
  await mkdir(path.join(projectRoot, 'artifacts'), { recursive: true });
  await observer.locator('#pause').click();
  await observer.screenshot({ path: path.join(projectRoot, 'artifacts', 'devbox-rrweb-viewer.png'), fullPage: true });
  await observer.setViewportSize({ width: 390, height: 844 });
  assert.equal(await observer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await observer.screenshot({ path: path.join(projectRoot, 'artifacts', 'devbox-rrweb-viewer-mobile.png'), fullPage: false });
  assert.equal(pageErrors.length, 0);
  assert.ok(originalPages.every(original => !original.isClosed()));
  checks.push('desktop/mobile fit and original user tabs are preserved; only synthetic content appears in screenshots');
  const evidence = { ok: true, verifiedAt: new Date().toISOString(), chromiumVersion: version, transport: 'rrweb', checks };
  await writePrivateJson(path.join(projectRoot, 'artifacts', 'remote-rrweb-verification.json'), evidence);
  console.log(JSON.stringify(evidence, null, 2));
} catch {
  console.error(`Remote rrweb verification failed after ${checks.length} checks (private details intentionally redacted).`);
  process.exitCode = 1;
} finally {
  ws?.terminate();
  await observerBrowser?.close();
  await second?.close().catch(() => {});
  await page?.close().catch(() => {});
  // Disconnect this CDP client; the Browser Service still owns Chromium.
  await agent.close();
}

async function eventually(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for remote rrweb events.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
