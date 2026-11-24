import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { configuration } from '../src/config.js';
import { BrowserService } from '../src/browser.js';
import { loadCredentials } from '../src/auth.js';
import { createApplication } from '../src/app.js';
import { SyncStore } from '../src/sync-store.js';

process.umask(0o077);
const checks = [];
const chromiumPath = process.env.DITTO_CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-integration-'));
const credentials = await loadCredentials(dataDir);
const config = configuration({ port: 0, cdpPort: 0, dataDir, chromiumPath, demo: false });
const browser = new BrowserService(config);
const sync = new SyncStore(dataDir);
await sync.load();
const application = createApplication({ config, credentials, browser, sync });
const targetRequests = [];
const target = http.createServer((request, response) => {
  targetRequests.push(request.url);
  if (request.url === '/private.png') {
    response.setHeader('Content-Type', 'image/png');
    response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
    return;
  }
  if (request.url === '/style.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end('@keyframes ditto-fade-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}body{border-top:4px solid rgb(12, 34, 56)}.fade-row{animation:ditto-fade-in 80ms ease forwards}#change{cursor:pointer}#change:hover{background-color:rgb(30, 64, 175)}');
    return;
  }
  if (request.url === '/frame') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Same-origin frame</title><button id="frame-button">Frame click</button><span id="frame-result">Not clicked</span><script>document.querySelector("#frame-button").onclick=()=>document.querySelector("#frame-result").textContent="Frame clicked remotely";</script>');
    return;
  }
  const cookieOK = request.headers.cookie?.includes('http_only_test=synthetic-login');
  const syntheticSvgIcon = `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24" viewBox="0 0 32 24"><path d="${'M0 0h32v24H0z '.repeat(1400)}" fill="#2563eb"/></svg>`).toString('base64')}`;
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><title>Ditto synthetic login</title><link rel="stylesheet" href="/style.css"><style>body{font:20px sans-serif;background:#edf3fb;padding:35px}button,input,select{padding:8px;margin:8px 0}#scroller{width:180px;height:80px;overflow:auto;background:white}#long{height:900px}img{width:24px;height:24px}#live-video{width:64px;height:36px;display:block}</style><h1>${cookieOK ? 'Cookie restored' : 'No cookie'}</h1><div id="boot" class="fade-row"></div><button id="change">Change token</button><div><input id="text" aria-label="Synthetic input"><span id="typed"></span></div><div><select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select><span id="chosen"></span></div><div id="scroller"><div id="long">Scroll target</div></div><img id="private-image" src="/private.png"><img id="svg-icon" src="${syntheticSvgIcon}"><svg id="inline-logo" width="16" height="16"><defs><linearGradient id="SVGID_1_"><stop offset="0%" stop-color="rgb(16, 185, 129)"/></linearGradient></defs><style>.logo-fill{fill:url(#SVGID_1_)}</style><rect id="logo-rect" class="logo-fill" width="16" height="16"/></svg><canvas id="chart" width="60" height="30"></canvas><video id="live-video" muted playsinline></video><a id="next" href="/next">Next page</a><script>const cctx=document.querySelector('#chart').getContext('2d');cctx.fillStyle='rgb(220, 38, 38)';cctx.fillRect(0,0,60,30);const vsrc=document.createElement('canvas');vsrc.width=64;vsrc.height=36;const vctx=vsrc.getContext('2d');window.__setVideoColor=c=>{vctx.fillStyle=c;vctx.fillRect(0,0,64,36);};window.__setVideoColor('rgb(22, 163, 74)');const vid=document.querySelector('#live-video');if(vsrc.captureStream){const st=vsrc.captureStream(15);vid.srcObject=st;setInterval(()=>{vctx.fillRect(0,0,64,36);},120);vid.play().catch(()=>{});}document.querySelector('#boot').textContent=localStorage.getItem('synthetic_token')||'missing';document.querySelector('#change').onclick=()=>{localStorage.setItem('synthetic_token','remote-refreshed');document.querySelector('#boot').textContent='remote-refreshed';};document.querySelector('#text').oninput=e=>{document.querySelector('#typed').textContent=e.target.value;};document.querySelector('#text').onkeydown=e=>{if(e.key==='Enter')document.querySelector('#typed').textContent='Enter remote';};document.querySelector('#choice').onchange=e=>{document.querySelector('#chosen').textContent=e.target.value;};</script>`);
});
let ws;
try {
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  await browser.start();
  const origin = `http://127.0.0.1:${target.address().port}`;
  const base = `http://127.0.0.1:${application.server.address().port}`;
  const stalePage = await browser.context.newPage();
  await stalePage.goto(origin);
  assert.equal(await stalePage.locator('#boot').textContent(), 'missing');
  const requestsBeforeImport = targetRequests.length;
  const response = await fetch(`${base}/api/sync`, { method: 'POST',
    headers: { Authorization: `Bearer ${credentials.syncToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1,
      cookies: [{ name: 'http_only_test', value: 'synthetic-login', domain: '127.0.0.1', path: '/', hostOnly: true,
        httpOnly: true, secure: false, sameSite: 'lax' }],
      origins: [{ origin, localStorage: [{ name: 'synthetic_token', value: 'mac-snapshot' }] }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await browser.context.cookies(origin)).some(cookie => cookie.name === 'http_only_test'), true);
  checks.push('upload writes login state immediately without refreshing the open page');
  const importResult = await response.json();
  assert.equal(importResult.applied.importedCookies, 1);
  assert.equal(importResult.applied.importedStorage, 1);
  assert.equal(targetRequests.length, requestsBeforeImport);
  checks.push('localStorage seeded at exact origin without making a target request');
  assert.equal(await stalePage.evaluate(() => localStorage.getItem('synthetic_token')), 'mac-snapshot');
  assert.equal(await stalePage.locator('#boot').textContent(), 'missing');
  checks.push('storage import does not implicitly restart scripts in pre-existing tabs');
  const page = await browser.context.newPage();
  await page.goto(origin);
  assert.equal(await page.locator('h1').textContent(), 'Cookie restored');
  assert.equal(await page.locator('#boot').textContent(), 'mac-snapshot');
  assert.equal(await page.evaluate(() => document.cookie.includes('http_only_test')), false);
  checks.push('HttpOnly Cookie and localStorage restored before target scripts');
  await page.locator('#change').click();
  await page.reload();
  assert.equal(await page.locator('#boot').textContent(), 'remote-refreshed');
  checks.push('remote token refresh survives reload; no repeated init-script overwrite');
  const recordings = [];
  const states = [];
  ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/live`, {
    headers: { Authorization: `Bearer ${credentials.dashboardToken}`, Origin: base },
  });
  ws.on('message', data => {
    const item = JSON.parse(data.toString());
    if (item.type.startsWith('rrweb-')) recordings.push(item);
    if (item.type === 'state') states.push(item);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await assertEventually(() => recordings.some(item => item.type === 'rrweb-snapshot'));
  const firstSnapshot = recordings.find(item => item.type === 'rrweb-snapshot');
  assert.ok(firstSnapshot.events.some(event => event.type === 2));
  assert.equal(JSON.stringify(firstSnapshot).includes('http_only_test'), false);
  const second = await browser.context.newPage();
  await second.goto(`${origin}/second`);
  await assertEventually(() => states.some(item => item.browser.tabs.some(tab => tab.url === `${origin}/second`)));
  checks.push('live WebSocket carries ordered rrweb DOM snapshots and new Tab events, not JPEG frames');
  ws.close();
  const observerContext = await chromium.launch({ executablePath: chromiumPath, channel: 'chromium', headless: true });
  try {
    const viewerContext = await observerContext.newContext();
    const observer = await viewerContext.newPage();
    const openDrawer = async targetPage => {
      if (!(await targetPage.locator('#control-drawer').evaluate(node => node.classList.contains('open')))) {
        await targetPage.locator('[data-drawer-trigger]:visible').first().click();
        await targetPage.locator('#control-drawer.open').waitFor({ state: 'visible' });
      }
    };
    const closeDrawer = async targetPage => {
      if (await targetPage.locator('#control-drawer').evaluate(node => node.classList.contains('open'))) {
        await targetPage.locator('#drawer-close').click();
        await targetPage.locator('#control-drawer').waitFor({ state: 'hidden' });
      }
    };
    const pageErrors = [];
    observer.on('pageerror', error => pageErrors.push(error.message));
    await observer.goto(`${base}/#token=${credentials.dashboardToken}`);
    await observer.locator('#workspace').waitFor({ state: 'visible' });
    const observedTab = [...browser.tabs.values()].find(tab => tab.page === page);
    await observer.locator(`.tab-button[data-tab-id="${observedTab.id}"]`).click();
    await observer.locator('#main-replay iframe').waitFor({ state: 'visible' });
    assert.equal(await observer.evaluate(() => {
      const doc = document.querySelector('#main-replay iframe')?.contentDocument;
      return doc ? getComputedStyle(doc.body).borderTopColor : null;
    }), 'rgb(12, 34, 56)', 'External stylesheet should be applied before replay iframe becomes visible');
    await observer.waitForFunction(() => {
      const doc = document.querySelector('#main-replay iframe')?.contentDocument;
      const boot = doc?.querySelector('#boot');
      return boot && getComputedStyle(boot).opacity === '1';
    }, { timeout: 2000 });
    assert.equal(await observer.evaluate(() => location.hash), '');
    await observer.reload();
    await observer.locator('#workspace').waitFor({ state: 'visible' });
    await observer.locator(`.tab-button[data-tab-id="${observedTab.id}"]`).click();
    await observer.locator('#main-replay iframe').waitFor({ state: 'visible' });
    assert.equal(await observer.evaluate(() => {
      const doc = document.querySelector('#main-replay iframe')?.contentDocument;
      return doc ? getComputedStyle(doc.body).borderTopColor : null;
    }), 'rgb(12, 34, 56)', 'External stylesheet should be applied before replay iframe becomes visible');
    await observer.waitForFunction(() => {
      const doc = document.querySelector('#main-replay iframe')?.contentDocument;
      const boot = doc?.querySelector('#boot');
      return boot && getComputedStyle(boot).opacity === '1';
    }, { timeout: 2000 });
    const staleTab = [...browser.tabs.values()].find(tab => tab.page === stalePage);
    await observer.locator(`.tab-button[data-tab-id="${staleTab.id}"]`).click();
    await observer.frameLocator('#main-replay iframe').locator('#boot').filter({ hasText: 'missing' }).waitFor();
    const reopenedByViewer = browser.context.waitForEvent('page');
    await observer.locator('.browser-menu summary').click();
    await observer.locator('#reopen-tab').click();
    const freshPage = await reopenedByViewer;
    await freshPage.waitForLoadState('domcontentloaded');
    assert.equal(await freshPage.locator('#boot').textContent(), 'remote-refreshed');
    assert.equal(stalePage.isClosed(), false);
    assert.equal(await stalePage.locator('#boot').textContent(), 'missing');
    checks.push('viewer reopens a fresh remote page with imported login state while preserving the stale tab');
    const freshTab = [...browser.tabs.values()].find(tab => tab.page === freshPage);
    await observer.locator('#toast').filter({ hasText: '已在新标签页重新打开远端网页' }).waitFor();
    const toastBox = await observer.locator('#toast').boundingBox();
    const viewport = observer.viewportSize();
    assert.equal(Math.abs((toastBox.y + toastBox.height / 2) - viewport.height / 2) <= 20, true,
      `Toast should appear vertically centered in the viewport (y=${toastBox.y}, vh=${viewport.height})`);
    await observer.locator(`.tab-button[data-tab-id="${freshTab.id}"]`).click();
    await observer.frameLocator('#main-replay iframe').locator('#boot').filter({ hasText: 'remote-refreshed' }).waitFor();
    const replay = () => observer.frameLocator('#main-replay iframe');
    assert.equal(await observer.locator('#take-control').count(), 0, 'Takeover toggle button should be removed');
    await observer.locator('#control-surface[data-mode="control"]').waitFor();
    assert.equal(await observer.title(), `Ditto · ${browser.tabs.size}`);
    // Even while always-on interactive control is active, new Agent activity on another tab still auto-follows!
    await browser.withAgentActivity(observedTab, { sessionId: 'title-spinner-test', agent: 'claude' }, 'click', async () => {
      const expectedSuffix = ` Ditto · ${browser.tabs.size}`;
      await observer.waitForFunction(suffix => /^[◐◓◑◒]/.test(document.title) && document.title.endsWith(suffix), expectedSuffix);
      const firstSpin = await observer.title();
      await observer.waitForFunction(prev => document.title !== prev && /^[◐◓◑◒]/.test(document.title), firstSpin, { timeout: 2000 });
      await observer.locator(`.browser-tab.selected[data-tab-id="${observedTab.id}"]`).waitFor();
    });
    await observer.locator(`.tab-button[data-tab-id="${freshTab.id}"]`).click();
    await replay().locator('#boot').filter({ hasText: 'remote-refreshed' }).waitFor();
    checks.push('viewer is always in interactive control mode without blocking automatic Agent tab follow');
    assert.equal(await replay().locator('meta[http-equiv="content-security-policy"]').getAttribute('content'),
      "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    // Untrusted scripts are not executed in the sandboxed local reconstruction.
    assert.equal(await replay().locator('script').count(), 0);
    assert.equal(await observer.locator('#main-replay iframe').getAttribute('sandbox'), 'allow-same-origin');
    await observer.waitForFunction(() => document.querySelector('#main-replay iframe')?.contentDocument?.querySelector('#private-image')?.naturalWidth > 0);
    await observer.waitForFunction(() => {
      const doc = document.querySelector('#main-replay iframe')?.contentDocument;
      const svgImg = doc?.querySelector('#svg-icon');
      const logoStyle = doc?.querySelector('#inline-logo style')?.textContent || '';
      return svgImg?.complete && svgImg.naturalWidth === 32 && logoStyle.includes('url("#SVGID_1_")');
    });
    await observer.waitForFunction(() => {
      const canvas = document.querySelector('#main-replay iframe')?.contentDocument?.querySelector('#chart');
      const px = canvas?.getContext('2d')?.getImageData(15, 15, 1, 1)?.data;
      return Boolean(px && px[0] > 180 && px[1] < 80 && px[2] < 80 && px[3] > 200);
    }, { timeout: 5000 });
    await observer.waitForFunction(() => {
      const video = document.querySelector('#main-replay iframe')?.contentDocument?.querySelector('#live-video');
      return Boolean(video?.poster?.startsWith('data:image/'));
    }, { timeout: 5000 });
    const firstVideoPoster = await observer.evaluate(() =>
      document.querySelector('#main-replay iframe')?.contentDocument?.querySelector('#live-video')?.poster || '');
    await freshPage.evaluate(() => window.__setVideoColor?.('rgb(37, 99, 235)'));
    await observer.waitForFunction(prev => {
      const video = document.querySelector('#main-replay iframe')?.contentDocument?.querySelector('#live-video');
      return Boolean(video?.poster?.startsWith('data:image/') && video.poster !== prev);
    }, firstVideoPoster, { timeout: 5000 });
    await freshPage.evaluate(() => { document.querySelector('#typed').textContent = 'Remote DOM mutation'; });
    await replay().locator('#typed').filter({ hasText: 'Remote DOM mutation' }).waitFor();
    checks.push('live rrweb replay renders actual remote mutations, canvas bitmaps and private images with scripts disabled');
    await observer.locator(`.tab-button[data-tab-id="${observedTab.id}"]`).click();
    await replay().locator('#boot').waitFor();
    await observer.waitForTimeout(1600);
    await observer.locator(`.tab-button[data-tab-id="${freshTab.id}"]`).click();
    await replay().locator('#typed').filter({ hasText: 'Remote DOM mutation' }).waitFor();
    await freshPage.evaluate(() => { document.querySelector('#typed').textContent = 'Idle tab updated immediately'; });
    await replay().locator('#typed').filter({ hasText: 'Idle tab updated immediately' }).waitFor({ timeout: 1200 });
    checks.push('switching to an idle cached tab rebases live time so new remote changes are not delayed by its time in the background');
    await observer.locator('#control-surface[data-mode="control"]').waitFor();
    const hoverBox = await replay().locator('#change').boundingBox();
    await observer.mouse.move(hoverBox.x + hoverBox.width / 2, hoverBox.y + hoverBox.height / 2);
    await observer.waitForFunction(() => {
      const btn = document.querySelector('#main-replay iframe')?.contentDocument?.querySelector('#change');
      const surface = document.querySelector('#control-surface');
      return btn && getComputedStyle(btn).backgroundColor === 'rgb(30, 64, 175)' && surface?.style.cursor === 'pointer';
    }, { timeout: 2500 });
    const clickReplay = async selector => {
      const box = await replay().locator(selector).boundingBox();
      assert.ok(box, `Missing replay box for ${selector}`);
      await observer.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    await clickReplay('#text');
    await observer.locator('#remote-editor').waitFor({ state: 'visible' });
    const editorStyle = await observer.evaluate(() => {
      const el = document.querySelector('#remote-editor');
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, borderWidth: cs.borderTopWidth, ghost: el.dataset.ghost };
    });
    assert.equal(editorStyle.bg, 'rgba(0, 0, 0, 0)');
    assert.equal(editorStyle.borderWidth, '0px');
    assert.equal(editorStyle.ghost, 'false');
    await observer.locator('#remote-editor').fill('中文 through viewer');
    await freshPage.locator('#typed').filter({ hasText: '中文 through viewer' }).waitFor();
    await replay().locator('#typed').filter({ hasText: '中文 through viewer' }).waitFor();
    await observer.locator('#remote-editor').press('Enter');
    await freshPage.locator('#typed').filter({ hasText: 'Enter remote' }).waitFor();
    await clickReplay('#choice');
    await observer.locator('#remote-select').waitFor({ state: 'visible' });
    await observer.locator('#remote-select').selectOption('b');
    await freshPage.locator('#chosen').filter({ hasText: 'b' }).waitFor();
    await clickReplay('#change');
    assert.equal(await freshPage.locator('#boot').textContent(), 'remote-refreshed');
    const stableFrame = await observer.locator('#main-replay iframe').elementHandle();
    await freshPage.evaluate(() => { document.querySelector('#boot').textContent = 'before-checkpoint-click'; });
    const checkpointButton = await replay().locator('#change').boundingBox();
    await observer.mouse.move(checkpointButton.x + checkpointButton.width / 2, checkpointButton.y + checkpointButton.height / 2);
    await observer.mouse.down();
    await browser.checkpoint(freshTab, true);
    await observer.waitForTimeout(150);
    assert.equal(await stableFrame.evaluate(node => node.isConnected), true);
    await observer.mouse.up();
    await freshPage.locator('#boot').filter({ hasText: 'remote-refreshed' }).waitFor();
    await stableFrame.dispose();
    checks.push('rrweb full checkpoints preserve the replay iframe and cannot swallow in-flight mouse clicks');
    const scrollBox = await replay().locator('#scroller').boundingBox();
    await observer.mouse.move(scrollBox.x + 30, scrollBox.y + 30);
    await observer.mouse.wheel(0, 250);
    await freshPage.waitForFunction(() => document.querySelector('#scroller').scrollTop > 0);
    await observer.waitForFunction(() => document.querySelector('#main-replay iframe')?.contentDocument?.querySelector('#scroller')?.scrollTop > 0);
    checks.push('observer takeover forwards trusted click, IME-capable input, select, keyboard and nested scroll to actual remote Chromium');
    await freshPage.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'animated-button';
      button.textContent = 'Animated React-style target';
      button.style.cssText = 'position:fixed;left:420px;top:15px;animation:ditto-pulse .12s infinite alternate';
      const style = document.createElement('style');
      style.textContent = '@keyframes ditto-pulse { from { transform:translateY(0) } to { transform:translateY(2px) } }';
      document.head.append(style);
      button.onclick = () => { document.querySelector('#typed').textContent = 'Animated clicked'; };
      document.body.append(button);
    });
    await replay().locator('#animated-button').waitFor();
    const animationBox = await replay().locator('#animated-button').boundingBox();
    await observer.mouse.click(animationBox.x + animationBox.width / 2, animationBox.y + animationBox.height / 2);
    await freshPage.locator('#typed').filter({ hasText: 'Animated clicked' }).waitFor();
    await replay().locator('#typed').filter({ hasText: 'Animated clicked' }).waitFor();
    await freshPage.evaluate(() => document.querySelector('#animated-button').remove());
    checks.push('on-screen animated buttons do not block real clicks behind Playwright stability/retry waits');
    await freshPage.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'same-frame';
      frame.src = '/frame';
      frame.style.cssText = 'position:fixed;right:0;top:0;width:220px;height:100px;background:white';
      document.body.append(frame);
    });
    await replay().frameLocator('#same-frame').locator('#frame-button').waitFor();
    const frameBox = await replay().frameLocator('#same-frame').locator('#frame-button').boundingBox();
    await observer.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
    await freshPage.frameLocator('#same-frame').locator('#frame-result').filter({ hasText: 'Frame clicked remotely' }).waitFor().catch(async error => {
      throw new Error(`${error.message}\nSynthetic frame-control notice: ${await observer.locator('#toast').textContent()}`);
    });
    await replay().frameLocator('#same-frame').locator('#frame-result').filter({ hasText: 'Frame clicked remotely' }).waitFor();
    await freshPage.evaluate(() => document.querySelector('#same-frame').remove());
    checks.push('same-origin iframe DOM recording and frame-path-validated control operate the real remote frame');
    const secondViewer = await viewerContext.newPage();
    await secondViewer.goto(base);
    await secondViewer.locator('#workspace').waitFor({ state: 'visible' });
    await secondViewer.locator(`.tab-button[data-tab-id="${freshTab.id}"]`).click();
    await secondViewer.locator('#control-surface[data-mode="control"]').waitFor();
    await secondViewer.close();
    const oldDocument = freshTab.documentId;
    await clickReplay('#next');
    await freshPage.waitForURL(`${origin}/next`);
    await assertEventually(() => freshTab.documentId && freshTab.documentId !== oldDocument);
    await replay().locator('#next').waitFor();
    await assert.rejects(browser.performControl('any-viewer', { action: 'click', tabId: freshTab.id,
      documentId: oldDocument, nodeId: 1, framePath: [], offsetX: .5, offsetY: .5 }), /网页已变化|已导航/);
    checks.push('multiple viewer windows stay concurrently interactive and navigation discards stale-document commands');
    assert.equal(await observer.locator('#pause').count(), 0, 'Pause screen button should be removed');
    await freshPage.evaluate(() => { document.querySelector('#typed').textContent = 'Changed before reconnect'; });
    await replay().locator('#typed').filter({ hasText: 'Changed before reconnect' }).waitFor();
    await observer.locator('#control-surface[data-mode="control"]').waitFor();
    await freshPage.evaluate(() => {
      const password = document.createElement('input');
      password.id = 'password';
      password.type = 'password';
      password.value = 'existing-synthetic';
      document.querySelector('#text').after(password);
    });
    await replay().locator('#password').waitFor();
    assert.notEqual(await replay().locator('#password').inputValue(), 'existing-synthetic');
    await clickReplay('#password');
    await observer.locator('#remote-editor').waitFor({ state: 'visible' });
    await observer.locator('#remote-editor').fill('追加');
    await freshPage.waitForFunction(() => document.querySelector('#password').value === 'existing-synthetic追加').catch(async error => {
      throw new Error(`${error.message}\nSynthetic password notice: ${await observer.locator('#toast').textContent()}`);
    });
    await observer.locator('#remote-editor').press('Backspace');
    await freshPage.waitForFunction(() => document.querySelector('#password').value === 'existing-synthetic追');
    await observer.locator('#remote-editor').press('Escape');
    checks.push('masked passwords accept real remote text/backspace without overwriting the field with replay asterisks');
    await observer.reload();
    await observer.locator('#workspace').waitFor({ state: 'visible' });
    await observer.locator(`.tab-button[data-tab-id="${freshTab.id}"]`).click();
    await replay().locator('#typed').filter({ hasText: 'Changed before reconnect' }).waitFor();
    checks.push('reconnect replays a complete latest checkpoint without retaining stale input');
        const createdByViewer = browser.context.waitForEvent('page');
    await observer.locator('#new-tab').click();
    const addressPage = await createdByViewer;
    await assertEventually(() => [...browser.tabs.values()].some(tab => tab.page === addressPage));
    const addressTab = [...browser.tabs.values()].find(tab => tab.page === addressPage);
    await observer.locator(`.browser-tab.selected[data-tab-id="${addressTab.id}"]`).waitFor();
    await observer.locator('#address-bar').waitFor({ state: 'visible' });
    assert.equal(addressPage.url(), 'about:blank');
    await observer.locator('#address-bar').fill(`${origin}/browser-shell`);
    await observer.locator('#address-bar').press('Enter');
    await addressPage.waitForURL(`${origin}/browser-shell`).catch(async error => {
      throw new Error(`${error.message}\nAddress navigation notice: ${await observer.locator('#toast').textContent()}`);
    });
    await replay().locator('#boot').filter({ hasText: 'remote-refreshed' }).waitFor();
    const firstDocument = addressTab.documentId;
    await addressPage.evaluate(() => document.querySelector('#typed').textContent = 'Reload me');
    await replay().locator('#typed').filter({ hasText: 'Reload me' }).waitFor();
    await observer.locator('#reload-tab').click();
    await assertEventually(() => addressTab.documentId && addressTab.documentId !== firstDocument);
    await replay().locator('#typed').waitFor({ state: 'attached' });
    assert.equal(await addressPage.locator('#typed').textContent(), '');
    await observer.locator('#address-bar').fill(`${origin}/browser-shell-next`);
    await observer.locator('#address-bar').press('Enter');
    await addressPage.waitForURL(`${origin}/browser-shell-next`);
    await observer.locator('#back-tab').waitFor({ state: 'visible' });
    await assertEventually(() => addressTab.canGoBack);
    await observer.locator('#back-tab').click();
    await addressPage.waitForURL(`${origin}/browser-shell`);
    await observer.locator('#forward-tab').click();
    await addressPage.waitForURL(`${origin}/browser-shell-next`);
    await observer.locator('#address-bar').click();
    await observer.locator('#address-bar').fill('browser-shell');
    await observer.locator('#address-suggestions .suggestion-item').first().waitFor({ state: 'visible' });
    const firstSuggestionUrl = await observer.locator('#address-suggestions .suggestion-item').first().getAttribute('data-url');
    assert.match(firstSuggestionUrl, /\/browser-shell/);
    await observer.locator('#address-bar').press('Escape');
    await observer.locator('#address-suggestions').waitFor({ state: 'hidden' });
    await observer.locator(`.browser-tab[data-tab-id="${addressTab.id}"] .tab-close`).click();
    await assertEventually(() => addressPage.isClosed());
    assert.equal(addressPage.isClosed(), true);
    await observer.locator(`.browser-tab[data-tab-id="${addressTab.id}"]`).waitFor({ state: 'detached' });
    checks.push('Chrome-style horizontal tabs create/close real tabs; address navigation, reload and back/forward operate real Chromium');
    const unloadPage = await browser.context.newPage();
    await unloadPage.goto(`${origin}/unsaved-form`);
    await unloadPage.locator('#text').click();
    await unloadPage.evaluate(() => window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; });
    const unloadTab = [...browser.tabs.values()].find(tab => tab.page === unloadPage);
    const closeResult = await browser.tabAction(unloadTab.id, 'close');
    assert.equal(closeResult.closed, false);
    assert.equal(unloadTab.dialog?.type, 'beforeunload');
    await browser.tabAction(unloadTab.id, 'cancel-close');
    assert.equal(unloadPage.isClosed(), false);
    await browser.tabAction(unloadTab.id, 'close');
    await browser.tabAction(unloadTab.id, 'confirm-close');
    await assertEventually(() => unloadPage.isClosed());
    checks.push('closing an unsaved real page requires explicit beforeunload confirmation and supports cancellation');
    const horizontalBox = await observer.evaluate(() => ({
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      hasTopbar: Boolean(document.querySelector('.topbar')),
      shell: document.querySelector('.browser-shell').getBoundingClientRect().toJSON(),
      logo: document.querySelector('#logo-toggle').getBoundingClientRect().toJSON(),
      gear: document.querySelector('#drawer-toggle').getBoundingClientRect().toJSON(),
      strip: document.querySelector('.tab-strip').getBoundingClientRect().toJSON(),
      main: document.querySelector('.browser-main').getBoundingClientRect().toJSON(),
      lastTab: [...document.querySelectorAll('.browser-tab')].at(-1).getBoundingClientRect().toJSON(),
      newTab: document.querySelector('#new-tab').getBoundingClientRect().toJSON(),
    }));
    assert.equal(horizontalBox.hasTopbar, false, 'Topbar should be removed');
    assert.equal(horizontalBox.shell.top >= 6 && horizontalBox.shell.top <= 16, true, 'Browser shell should start near viewport top with breathing margin');
    assert.equal(horizontalBox.logo.left >= horizontalBox.shell.left && horizontalBox.logo.left <= horizontalBox.shell.left + 20, true, 'Logo trigger should sit in top-left of browser header');
    assert.equal(horizontalBox.logo.top >= horizontalBox.shell.top && horizontalBox.logo.top <= horizontalBox.shell.top + 20, true, 'Logo trigger should sit in top-left of browser header');
    assert.equal(horizontalBox.gear.right >= horizontalBox.strip.right - 20 && horizontalBox.gear.right <= horizontalBox.strip.right + 1, true, 'Settings gear should sit at the far right of the tab strip');
    assert.equal(horizontalBox.strip.bottom <= horizontalBox.main.top + 1, true, 'Default tab strip should sit above main area');
    assert.equal(horizontalBox.newTab.left >= horizontalBox.lastTab.right - 1 && horizontalBox.newTab.left <= horizontalBox.lastTab.right + 16, true, 'Horizontal + button should sit immediately after the last tab');
    assert.equal(horizontalBox.shell.bottom >= horizontalBox.viewportHeight - 16, true, 'Browser shell should fill full viewport height');
    assert.equal(horizontalBox.scrollHeight <= horizontalBox.viewportHeight + 2, true, 'Browser shell should fit viewport without outer vertical overflow');
    await openDrawer(observer);
    const drawerBox = await observer.locator('#control-drawer').boundingBox();
    assert.equal(drawerBox.x + drawerBox.width >= horizontalBox.viewportWidth - 20, true, 'Drawer should slide out from the right edge');
    await observer.waitForFunction(() => /(?:MB|GB|KB)$/.test(document.querySelector('#memory-total')?.textContent || ''));
    await observer.locator('#memory-toggle').click();
    await observer.locator('#memory-details').waitFor({ state: 'visible' });
    assert.ok(await observer.locator('#memory-processes .memory-proc-row').count() >= 1);
    await observer.locator('#memory-toggle').click();
    await observer.locator('#memory-details').waitFor({ state: 'hidden' });
    await observer.locator('#tab-layout-switcher [data-layout="vertical"]').click();
    await observer.locator('#drawer-backdrop').click({ position: { x: 200, y: 200 } });
    await observer.locator('#control-drawer').waitFor({ state: 'hidden' });
    const verticalBox = await observer.evaluate(() => ({
      vertical: document.querySelector('.browser-shell').classList.contains('vertical-tabs'),
      shell: document.querySelector('.browser-shell').getBoundingClientRect().toJSON(),
      logo: document.querySelector('#logo-toggle').getBoundingClientRect().toJSON(),
      gear: document.querySelector('#drawer-toggle').getBoundingClientRect().toJSON(),
      strip: document.querySelector('.tab-strip').getBoundingClientRect().toJSON(),
      main: document.querySelector('.browser-main').getBoundingClientRect().toJSON(),
      lastTab: [...document.querySelectorAll('.browser-tab')].at(-1).getBoundingClientRect().toJSON(),
      newTab: document.querySelector('#new-tab').getBoundingClientRect().toJSON(),
    }));
    assert.equal(verticalBox.vertical, true);
    assert.equal(verticalBox.logo.left >= verticalBox.shell.left && verticalBox.logo.left <= verticalBox.shell.left + 20, true, 'Logo trigger should remain top-left in vertical mode');
    assert.equal(verticalBox.gear.right >= verticalBox.strip.right - 20 && verticalBox.gear.right <= verticalBox.strip.right + 1, true, 'Settings gear should sit at the right of vertical sidebar header');
    assert.equal(verticalBox.strip.right <= verticalBox.main.left + 1, true, 'Vertical tab strip should sit to the left of main area');
    assert.equal(Math.abs(verticalBox.strip.height - verticalBox.main.height) <= 2, true, 'Vertical sidebar should match browser height');
    assert.equal(verticalBox.newTab.top >= verticalBox.lastTab.bottom - 1 && verticalBox.newTab.top <= verticalBox.lastTab.bottom + 16, true, 'Vertical new-tab button should sit immediately below the last tab');
    const stageSize = await observer.evaluate(() => ({
      width: Math.floor(document.querySelector('.stage').clientWidth),
      height: Math.floor(document.querySelector('.stage').clientHeight),
    }));
    await assertEventually(() => {
      const vp = page.viewportSize();
      return vp && Math.abs(vp.width - stageSize.width) <= 4 && Math.abs(vp.height - stageSize.height) <= 4;
    }, 4000);
    await observer.reload();
    await observer.locator('#workspace').waitFor({ state: 'visible' });
    assert.equal(await observer.evaluate(() => document.querySelector('.browser-shell').classList.contains('vertical-tabs')), true);
    await openDrawer(observer);
    await observer.locator('#tab-layout-switcher [data-layout="horizontal"]').click();
    assert.equal(await observer.evaluate(() => document.querySelector('.browser-shell').classList.contains('vertical-tabs')), false);
    assert.equal(await observer.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await observer.locator('#theme-switcher [data-theme-value="light"]').click();
    assert.equal(await observer.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.equal(await observer.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(244, 244, 246)');
    await observer.reload();
    await observer.locator('#workspace').waitFor({ state: 'visible' });
    assert.equal(await observer.evaluate(() => document.documentElement.dataset.theme), 'light');
    await openDrawer(observer);
    await observer.locator('#theme-switcher [data-theme-value="dark"]').click();
    assert.equal(await observer.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(20, 21, 24)');
    await observer.locator('#theme-switcher [data-theme-value="system"]').click();
    assert.equal(await observer.evaluate(() => document.documentElement.dataset.theme), 'system');
    assert.equal((await observer.locator('#view-switcher [data-view="browser"]').textContent()).trim(), '普通');
    assert.equal((await observer.locator('#view-switcher [data-view="overview"]').textContent()).trim(), '总览');
    await observer.locator('#view-switcher [data-view="overview"]').click();
    await observer.locator('#control-drawer').waitFor({ state: 'hidden' });
    await observer.locator('#overview').waitFor({ state: 'visible' });
    assert.equal(await observer.locator('.browser-shell').isHidden(), true);
    assert.equal(await observer.locator('#overview-adaptive').isVisible(), true);
    assert.equal(await observer.locator('#overview-adaptive').isChecked(), true);
    const adaptiveOverview = await observer.evaluate(() => {
      const grid = document.querySelector('#tab-overview');
      const cards = [...grid.querySelectorAll('.thumbnail')].map(node => node.getBoundingClientRect().toJSON());
      return {
        adaptive: grid.classList.contains('adaptive'),
        grid: grid.getBoundingClientRect().toJSON(),
        cards,
      };
    });
    assert.equal(adaptiveOverview.adaptive, true);
    assert.ok(adaptiveOverview.cards.length >= 3);
    assert.equal(Math.max(...adaptiveOverview.cards.map(c => c.bottom)) >= adaptiveOverview.grid.bottom - 2, true,
      'Adaptive overview should fill full vertical space');
    assert.equal(adaptiveOverview.cards.at(-1).right >= adaptiveOverview.grid.right - 2, true,
      'Adaptive overview last card should extend to the right edge with no dead corner');
    await observer.locator('#overview-adaptive').click();
    assert.equal(await observer.locator('#overview-adaptive').isChecked(), false);
    assert.equal(await observer.evaluate(() => document.querySelector('#tab-overview').classList.contains('adaptive')), false);
    await observer.locator('#overview-adaptive').click();
    assert.equal(await observer.locator('#overview-adaptive').isChecked(), true);
    assert.equal(await observer.evaluate(() => document.querySelector('#tab-overview').classList.contains('adaptive')), true);
    await openDrawer(observer);
    await observer.keyboard.press('Escape');
    await observer.locator('#control-drawer').waitFor({ state: 'hidden' });
    await observer.locator('#tab-overview .thumbnail-main').first().click();
    await observer.locator('.browser-shell').waitFor({ state: 'visible' });
    assert.equal(await observer.locator('#overview').isHidden(), true);
    const browserLogoBox = await observer.locator('#logo-toggle').boundingBox();
    const browserGearBox = await observer.locator('#drawer-toggle').boundingBox();
    await observer.locator('#logo-toggle').click();
    await observer.locator('#overview').waitFor({ state: 'visible' });
    const overviewLogoBox = await observer.locator('#overview-logo-toggle').boundingBox();
    const overviewGearBox = await observer.locator('#overview-drawer-toggle').boundingBox();
    assert.equal(Math.abs(browserLogoBox.x - overviewLogoBox.x) <= 0.5 && Math.abs(browserLogoBox.y - overviewLogoBox.y) <= 0.5, true,
      `Logo position should stay identical when switching to overview (${JSON.stringify(browserLogoBox)} vs ${JSON.stringify(overviewLogoBox)})`);
    assert.equal(Math.abs(browserGearBox.x - overviewGearBox.x) <= 0.5 && Math.abs(browserGearBox.y - overviewGearBox.y) <= 0.5, true,
      `Gear position should stay identical when switching to overview (${JSON.stringify(browserGearBox)} vs ${JSON.stringify(overviewGearBox)})`);
    await observer.locator('#overview-logo-toggle').click();
    await observer.locator('.browser-shell').waitFor({ state: 'visible' });
    assert.equal(await observer.locator('#tab-count-menu').count(), 0, 'Old tab count dropdown should be removed');
    const firstStripTab = observer.locator('#tab-list .browser-tab').first();
    const firstStripId = await firstStripTab.getAttribute('data-tab-id');
    await firstStripTab.click({ button: 'right' });
    await observer.locator('#tab-context-menu').waitFor({ state: 'visible' });
    const horizLabels = await observer.evaluate(() =>
      [...document.querySelectorAll('#tab-context-menu .ctx-item:not([hidden])')].map(el => el.textContent.trim()));
    assert.deepEqual(horizLabels, [
      '在右侧新增标签页',
      '重新加载',
      '复制',
      '垂直显示标签页',
      '关闭',
      '关闭其他标签页',
      '关闭右侧标签页',
    ]);
    await observer.locator('#ctx-toggle-layout').click();
    await observer.waitForFunction(() => document.querySelector('.browser-shell')?.classList.contains('vertical-tabs'));
    await firstStripTab.click({ button: 'right' });
    await observer.locator('#tab-context-menu').waitFor({ state: 'visible' });
    const vertLabels = await observer.evaluate(() =>
      [...document.querySelectorAll('#tab-context-menu .ctx-item:not([hidden])')].map(el => el.textContent.trim()));
    assert.deepEqual(vertLabels, [
      '在下方新增标签页',
      '重新加载',
      '复制',
      '水平显示标签页',
      '关闭',
      '关闭其他标签页',
      '关闭下方标签页',
    ]);
    await observer.locator('#ctx-new-adjacent').click();
    await observer.waitForFunction(anchorId => {
      const ids = [...document.querySelectorAll('#tab-list .browser-tab')].map(el => el.dataset.tabId);
      return ids[0] === anchorId && document.querySelectorAll('#tab-list .browser-tab')[1]?.classList.contains('selected');
    }, firstStripId);
    const secondStripTab = observer.locator('#tab-list .browser-tab').nth(1);
    await secondStripTab.click({ button: 'right' });
    await observer.locator('#ctx-close').click();
    await firstStripTab.click({ button: 'right' });
    await observer.locator('#ctx-toggle-layout').click();
    await observer.waitForFunction(() => !document.querySelector('.browser-shell')?.classList.contains('vertical-tabs'));
    checks.push('full-screen browser opens right slide-over drawer from settings gear, toggles overview via top-left logo, supports adaptive overview toggle and persists preferences');
    const pwaRemoved = await observer.evaluate(async () => ({
      hasManifestLink: Boolean(document.querySelector('link[rel="manifest"]')),
      hasInstallButton: Boolean(document.querySelector('#install-app')),
      manifestStatus: (await fetch('/manifest.webmanifest')).status,
      swStatus: (await fetch('/sw.js')).status,
      swCount: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
    }));
    assert.equal(pwaRemoved.hasManifestLink, false);
    assert.equal(pwaRemoved.hasInstallButton, false);
    assert.equal(pwaRemoved.manifestStatus, 404);
    assert.equal(pwaRemoved.swStatus, 404);
    assert.equal(pwaRemoved.swCount, 0);
    checks.push('viewer does not expose PWA manifest, install action, or service worker');
    // Built-in Console + JS REPL + Network DevTools panel check
    await observer.locator('#devtools-toggle').click();
    await observer.locator('#devtools-panel').waitFor({ state: 'visible' });
    await observer.locator('#devtools-input').fill('({ answer: 21 + 21, nested: [1, 2] })');
    await observer.locator('#devtools-input').press('Enter');
    await observer.waitForFunction(() => [...document.querySelectorAll('#devtools-console-list .dt-level-result')]
      .some(row => row.textContent.includes('answer: 42')));
    await observer.locator('#devtools-console-list .dt-level-result details.dt-tree summary').last().click();
    await observer.waitForFunction(() => [...document.querySelectorAll('#devtools-console-list .dt-tree-children')]
      .some(el => el.textContent.includes('nested:')));
    await observer.locator('#devtools-tab-network').click();
    await observer.locator('#devtools-network-pane').waitFor({ state: 'visible' });
    await observer.waitForFunction(() => document.querySelectorAll('#devtools-network-list .dt-net-row').length > 0);
    await observer.locator('#devtools-close').click();
    await observer.locator('#devtools-panel').waitFor({ state: 'hidden' });
    checks.push('built-in viewer DevTools streams Console/Network logs and evaluates JS expressions with expandable object trees');
    assert.deepEqual(pageErrors, []);
    await observer.setViewportSize({ width: 390, height: 844 });
    const overflow = await observer.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 8).map(node => ({ tag: node.tagName, id: node.id, className: node.className,
          right: Math.round(node.getBoundingClientRect().right) })),
    }));
    assert.equal(overflow.document <= overflow.viewport, true, `Mobile layout overflow: ${JSON.stringify(overflow)}`);
    checks.push('viewer authenticates, removes URL secret, reconnects on refresh and fits mobile');
  } finally { await observerContext.close(); }
  await second.close();
  await page.close();
  await stalePage.close();
  await browser.stop();
  await browser.start();
  const reopened = await browser.context.newPage();
  await reopened.goto(origin);
  assert.equal(await reopened.locator('#boot').textContent(), 'remote-refreshed');
  checks.push('localStorage persists across Chromium restart');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} catch (error) {
  console.error(`Integration failed after: ${checks.join('; ')}\n${error.message}`);
  process.exitCode = 1;
} finally {
  ws?.terminate();
  await application.close();
  await browser.stop();
  await new Promise(resolve => target.close(resolve));
}

async function assertEventually(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for live browser event.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
