import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlLease, validateControl } from '../src/control.js';
import { BrowserService } from '../src/browser.js';

const command = { tabId: 'tab', documentId: 'doc', nodeId: 3, framePath: [], action: 'click', offsetX: .5, offsetY: .5 };

test('remote control is exclusive, releases and expires without a pause confirmation', () => {
  let now = 0;
  const lease = new ControlLease(() => {}, () => now);
  assert.throws(() => lease.require('viewer'), /接管/);
  lease.acquire('viewer');
  assert.throws(() => lease.acquire('other'), /另一个/);
  lease.release('other');
  assert.equal(lease.owner, 'viewer');
  lease.require('viewer');
  now = 46000;
  assert.throws(() => lease.require('viewer'), /接管/);
  lease.acquire('other');
  lease.release('other');
  assert.equal(lease.owner, null);
});

test('control schema validates document/node identities, finite points, text and allowed keys only', () => {
  assert.equal(validateControl(command).clickCount, 1);
  for (const input of [
    { ...command, action: 'evaluate', expression: 'process.exit()' },
    { ...command, offsetX: Infinity }, { ...command, offsetY: -1 },
    { ...command, nodeId: -1 }, { ...command, framePath: [null] },
    { ...command, action: 'wheel', deltaX: 0, deltaY: 999999 },
    { ...command, action: 'text', value: 'x'.repeat(20000) },
    { ...command, action: 'key', key: 'F12', modifiers: [] },
    { ...command, action: 'key', key: 'w', modifiers: ['Control'] },
  ]) assert.throws(() => validateControl(input));
  assert.equal(validateControl({ ...command, action: 'key', key: 'Enter', modifiers: [] }).key, 'Enter');
  assert.equal(validateControl({ ...command, action: 'input', value: '中文', selectionStart: 2, selectionEnd: 2 }).value, '中文');
  assert.equal(validateControl({ ...command, action: 'click', clickCount: 3 }).clickCount, 3);
  assert.throws(() => validateControl({ ...command, action: 'click', clickCount: 4 }));
  assert.deepEqual(validateControl({ ...command, action: 'mousedown', button: 'left', clickCount: 2, viewportX: 0.2, viewportY: 0.3 }), {
    action: 'mousedown', tabId: 'tab', documentId: 'doc', nodeId: 3, framePath: [],
    offsetX: 0.5, offsetY: 0.5, viewportX: 0.2, viewportY: 0.3, button: 'left', clickCount: 2,
  });
  assert.equal(validateControl({ ...command, action: 'move', dragging: true, viewportX: 0.6, viewportY: 0.4 }).dragging, true);
  assert.equal(validateControl({ ...command, action: 'mouseup', button: 'left', viewportX: 0.6, viewportY: 0.4 }).action, 'mouseup');
});

test('triple-click and drag-select dispatch cleanly with coalesced drag moves', async () => {
  const browser = new BrowserService({ viewport: { width: 1000, height: 800 } });
  browser.ready = true;
  const events = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  browser.tabs.set('tab', {
    id: 'tab',
    documentId: 'doc',
    hidden: false,
    crashed: false,
    dialog: null,
    recordingStatus: 'live',
    page: {
      isClosed: () => false,
      viewportSize: () => ({ width: 1000, height: 800 }),
      bringToFront: async () => {},
      evaluate: async () => ({ ok: true, x: 100, y: 200 }),
      mouse: {
        click: async (x, y, opts) => { events.push({ type: 'click', x, y, ...opts }); },
        move: async (x, y) => {
          events.push({ type: 'move', x: Math.round(x), y: Math.round(y) });
          if (events.length === 1) await firstGate;
        },
        down: async opts => { events.push({ type: 'down', ...opts }); },
        up: async opts => { events.push({ type: 'up', ...opts }); },
      },
    },
  });

  // Drag sequence: mousedown -> coalesced drag moves -> mouseup
  const pDown = browser.performControl('v1', { ...command, action: 'mousedown', button: 'left', clickCount: 1, viewportX: 0.1, viewportY: 0.25 });
  await Promise.resolve();
  const pMove1 = browser.performControl('v1', { ...command, action: 'move', dragging: true, viewportX: 0.2, viewportY: 0.25 });
  const pMove2 = browser.performControl('v1', { ...command, action: 'move', dragging: true, viewportX: 0.5, viewportY: 0.25 });
  const pUp = browser.performControl('v1', { ...command, action: 'mouseup', button: 'left', clickCount: 1, viewportX: 0.6, viewportY: 0.25 });
  releaseFirst();
  await Promise.all([pDown, pMove1, pMove2, pUp]);
  assert.deepEqual(events, [
    { type: 'move', x: 100, y: 200 },
    { type: 'down', button: 'left', clickCount: 1 },
    { type: 'move', x: 500, y: 200 },
    { type: 'move', x: 600, y: 200 },
    { type: 'up', button: 'left', clickCount: 1 },
  ]);

  // Triple click dispatches a single down/up with clickCount: 3 (not 3 duplicate clicks)
  events.length = 0;
  await browser.performControl('v1', { ...command, action: 'click', button: 'left', clickCount: 3 });
  assert.deepEqual(events, [
    { type: 'move', x: 100, y: 200 },
    { type: 'down', button: 'left', clickCount: 3 },
    { type: 'up', button: 'left', clickCount: 3 },
  ]);

  // getSelectionText strips Chromium's triple-click trailing newlines while preserving internal newlines
  browser.tabs.get('tab').page.evaluate = async fn => {
    const prevDoc = globalThis.document;
    globalThis.document = {
      activeElement: null,
      defaultView: { getSelection: () => ({ toString: () => 'Line 1\n\nLine 2\n\n' }) },
      querySelectorAll: () => [],
    };
    try { return fn(); } finally { globalThis.document = prevDoc; }
  };
  assert.deepEqual(await browser.getSelectionText('tab'), { text: 'Line 1\n\nLine 2' });
});

test('hover events do not backlog ahead of clicks on a busy remote page', async () => {
  const browser = new BrowserService({ viewport: { width: 1280, height: 800 } });
  browser.acquireControl = () => browser.control.acquire('viewer');
  browser.acquireControl();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const executed = [];
  browser.dispatchControl = async (id, revision, command) => { executed.push(command.action); if (executed.length === 1) await gate; return { ok: true }; };
  const click = browser.performControl('viewer', command);
  await Promise.resolve();
  const hover = await browser.performControl('viewer', { ...command, action: 'move' });
  assert.equal(hover.skipped, true);
  release();
  await click;
  assert.deepEqual(executed, ['click']);
});

test('rapid trackpad wheel ticks coalesce into one accumulated scroll without throwing 429', async () => {
  const browser = new BrowserService({ viewport: { width: 1280, height: 800 } });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const deltas = [];
  browser.dispatchControl = async (_id, _rev, cmd) => {
    if (cmd.action === 'click') { await gate; return { ok: true }; }
    deltas.push(cmd.deltaY);
    return { ok: true };
  };
  const first = browser.performControl('viewer', command);
  await Promise.resolve();
  const wheels = [];
  for (let i = 0; i < 60; i++) {
    wheels.push(browser.performControl('viewer', { ...command, action: 'wheel', deltaX: 0, deltaY: 15 }));
  }
  release();
  await Promise.all([first, ...wheels]);
  assert.deepEqual(deltas, [900]);
});

test('tab activation is serialized behind input rather than racing remote focus', async () => {
  const browser = new BrowserService({ viewport: { width: 1280, height: 800 } });
  browser.control.acquire('viewer');
  const executed = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  browser.dispatchControl = async () => { executed.push('input-start'); await gate; executed.push('input-end'); };
  browser.dispatchTabAction = async () => { executed.push('activate'); };
  const input = browser.performControl('viewer', command);
  const activate = browser.tabAction('next', 'activate');
  await Promise.resolve();
  assert.deepEqual(executed, ['input-start']);
  release();
  await Promise.all([input, activate]);
  assert.deepEqual(executed, ['input-start', 'input-end', 'activate']);
});

test('reloading a crashed tab recovers it into a fresh tab instead of getting stuck in starting', async () => {
  const browser = new BrowserService({ viewport: { width: 1280, height: 800 } });
  browser.ready = true;
  const deadTab = {
    id: 'dead-tab',
    url: 'https://example.test/heavy-dashboard',
    crashed: true,
    recordingStatus: 'crashed',
    hidden: false,
    page: { isClosed: () => false },
  };
  browser.tabs.set(deadTab.id, deadTab);
  const recoveredCalls = [];
  browser.recoverCrashedTab = async (tab, targetUrl, opts) => {
    recoveredCalls.push({ id: tab.id, targetUrl, opts });
    return 'fresh-tab';
  };
  const result = await browser.dispatchTabAction('dead-tab', 'reload');
  assert.equal(result.recovered, true);
  assert.equal(result.replacementId, 'fresh-tab');
  assert.deepEqual(recoveredCalls, [{
    id: 'dead-tab',
    targetUrl: 'https://example.test/heavy-dashboard',
    opts: { bringToFront: true },
  }]);
});

test('batch close actions close tabs after current, close others, and replace all with a blank tab', async () => {
  const browser = new BrowserService({ viewport: { width: 1280, height: 800 } });
  browser.ready = true;
  const closed = [];
  const makeTab = (id, createdAt) => {
    let isClosed = false;
    return {
      id,
      url: `https://example.test/${id}`,
      createdAt,
      hidden: false,
      page: {
        isClosed: () => isClosed,
        close: async () => { isClosed = true; closed.push(id); browser.tabs.delete(id); },
        once: () => {},
        off: () => {},
      },
    };
  };
  browser.tabs.set('t1', makeTab('t1', '2026-01-01T00:00:01.000Z'));
  browser.tabs.set('t2', makeTab('t2', '2026-01-01T00:00:02.000Z'));
  browser.tabs.set('t3', makeTab('t3', '2026-01-01T00:00:03.000Z'));
  browser.tabs.set('t4', makeTab('t4', '2026-01-01T00:00:04.000Z'));

  const afterRes = await browser.dispatchTabAction('t2', 'close-after');
  assert.equal(afterRes.closedCount, 2);
  assert.deepEqual(closed, ['t3', 't4']);
  assert.deepEqual([...browser.tabs.keys()], ['t1', 't2']);

  const othersRes = await browser.dispatchTabAction('t2', 'close-others');
  assert.equal(othersRes.closedCount, 1);
  assert.deepEqual([...browser.tabs.keys()], ['t2']);

  browser.open = async () => {
    browser.tabs.set('blank', makeTab('blank', '2026-01-01T00:00:05.000Z'));
    return 'blank';
  };
  const allRes = await browser.dispatchTabAction('t2', 'close-all');
  assert.equal(allRes.closedCount, 1);
  assert.equal(allRes.replacementId, 'blank');
  assert.deepEqual([...browser.tabs.keys()], ['blank']);
});

test('navigations run concurrently across tabs, can supersede an in-flight load, and support stop', async () => {
  const browser = new BrowserService({ viewport: { width: 1280, height: 800 } });
  browser.ready = true;
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const events = [];
  const makeTab = (id, createdAt) => ({
    id,
    url: 'about:blank',
    title: '新标签页',
    createdAt,
    hidden: false,
    loading: false,
    page: {
      isClosed: () => false,
      url: () => 'https://example.test/final',
      title: async () => 'Final',
      bringToFront: async () => {},
      goto: async url => {
        events.push(`goto:${id}:${url}`);
        if (url === 'https://slow.test') await firstGate;
      },
      evaluate: async () => {},
    },
    cdp: {
      send: async method => { events.push(`cdp:${id}:${method}`); },
    },
  });
  const tabA = makeTab('a', '2026-01-01T00:00:01.000Z');
  const tabB = makeTab('b', '2026-01-01T00:00:02.000Z');
  browser.tabs.set('a', tabA);
  browser.tabs.set('b', tabB);
  browser.refresh = async () => {};
  browser.ensureRecorder = async () => {};
  browser.checkpoint = async () => {};
  browser.refreshHistory = async () => {};

  // Start a slow navigation on tab A; tab B must navigate immediately without waiting.
  const slowNav = browser.tabAction('a', 'navigate', { url: 'https://slow.test' });
  await Promise.resolve();
  assert.equal(tabA.loading, true);
  await browser.tabAction('b', 'navigate', { url: 'https://fast.test' });
  assert.equal(tabB.loading, false);
  assert.equal(events.includes('goto:b:https://fast.test'), true);

  // Overriding tab A with a new URL supersedes the in-flight slow navigation cleanly.
  const overrideNav = browser.tabAction('a', 'navigate', { url: 'https://override.test' });
  await overrideNav;
  assert.equal(tabA.loading, false);
  releaseFirst();
  const slowResult = await slowNav;
  assert.equal(slowResult.superseded, true);

  // Stop action halts loading via CDP Page.stopLoading and clears loading state.
  tabA.loading = true;
  await browser.tabAction('a', 'stop');
  assert.equal(tabA.loading, false);
  assert.equal(events.includes('cdp:a:Page.stopLoading'), true);
});

test('wheel viewport coordinates validate, coalesce across changing nodes, and dispatch directly via CDP', async () => {
  const valid = validateControl({ ...command, action: 'wheel', deltaX: 0, deltaY: 120, viewportX: 0.5, viewportY: 0.25 });
  assert.equal(valid.viewportX, 0.5);
  assert.equal(valid.viewportY, 0.25);
  for (const bad of [
    { ...command, action: 'wheel', deltaX: 0, deltaY: 10, viewportX: -0.1, viewportY: 0.5 },
    { ...command, action: 'wheel', deltaX: 0, deltaY: 10, viewportX: 0.5, viewportY: 1.2 },
    { ...command, action: 'wheel', deltaX: 0, deltaY: 10, viewportX: 0.5 },
  ]) assert.throws(() => validateControl(bad));

  const browser = new BrowserService({ viewport: { width: 1200, height: 800 } });
  browser.ready = true;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const dispatched = [];
  browser.dispatchControl = async (_id, _rev, cmd) => {
    if (cmd.action === 'click') { await gate; return { ok: true }; }
    dispatched.push({ nodeId: cmd.nodeId, deltaY: cmd.deltaY, viewportX: cmd.viewportX, viewportY: cmd.viewportY });
    return { ok: true };
  };
  const hold = browser.performControl('viewer', command);
  await Promise.resolve();
  const w1 = browser.performControl('viewer', { ...command, nodeId: 10, action: 'wheel', deltaX: 0, deltaY: 40, viewportX: 0.4, viewportY: 0.5 });
  const w2 = browser.performControl('viewer', { ...command, nodeId: 25, action: 'wheel', deltaX: 0, deltaY: 60, viewportX: 0.45, viewportY: 0.5 });
  release();
  await Promise.all([hold, w1, w2]);
  assert.deepEqual(dispatched, [{ nodeId: 25, deltaY: 100, viewportX: 0.45, viewportY: 0.5 }]);

  // Verify direct CDP mouseWheel fast-path bypasses page.evaluate entirely.
  const cdpBrowser = new BrowserService({ viewport: { width: 1000, height: 800 } });
  cdpBrowser.ready = true;
  let evaluateCalled = false;
  const cdpCalls = [];
  cdpBrowser.tabs.set('tab', {
    id: 'tab',
    documentId: 'doc',
    hidden: false,
    crashed: false,
    dialog: null,
    recordingStatus: 'live',
    page: {
      isClosed: () => false,
      viewportSize: () => ({ width: 1000, height: 800 }),
      evaluate: async () => { evaluateCalled = true; return { ok: true, x: 0, y: 0 }; },
    },
    cdp: {
      send: async (method, params) => { cdpCalls.push({ method, params }); },
    },
  });
  await cdpBrowser.dispatchControl('viewer', 0, valid);
  assert.equal(evaluateCalled, false);
  assert.deepEqual(cdpCalls, [{
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseWheel', x: 500, y: 200, deltaX: 0, deltaY: 120 },
  }]);
});
