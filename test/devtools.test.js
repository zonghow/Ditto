import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import WebSocket from 'ws';
import { configuration } from '../src/config.js';
import { BrowserService } from '../src/browser.js';
import { loadCredentials } from '../src/auth.js';
import { SyncStore } from '../src/sync-store.js';
import { createApplication } from '../src/app.js';

test('viewer DevTools streams Console/Network logs, evaluates JS with REPL/await/object trees, and enforces security boundaries', async t => {
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-devtools-'));
  const chromiumPath = process.env.DITTO_CHROMIUM_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  const config = configuration({ dataDir, port: 0, cdpPort: 0, demo: false, chromiumPath });
  const credentials = await loadCredentials(dataDir);
  const browser = new BrowserService(config);
  const sync = new SyncStore(dataDir);
  await sync.load();
  const app = createApplication({ config, credentials, browser, sync });

  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/api/data')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rows: [10, 20, 30] }));
      return;
    }
    if (req.url.startsWith('/api/fail')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>DevTools Test</title>
      <div id="box" class="card active">Hello</div>
      <script>
        console.log('boot-log', { user: 'alice', tags: ['a', 'b'] });
        console.warn('boot-warn');
        fetch('/api/data?secret=strip-me').catch(() => {});
        fetch('/api/fail?token=hidden').catch(() => {});
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
  const tabId = await browser.open(`${origin}/`);
  // Wait briefly for initial fetches & async JSHandle inspection to finish
  await new Promise(resolve => setTimeout(resolve, 600));

  // Connect viewer WebSocket and subscribe to DevTools for this tab
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/live`, { headers: { Origin: base } });
  const received = [];
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', raw => {
    if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
      try { received.push(JSON.parse(raw.toString())); } catch {}
    }
  });
  t.after(() => ws.close());

  ws.send(JSON.stringify({ type: 'devtools', enabled: true, tabId }));
  const waitFor = async (pred, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const found = received.find(pred);
      if (found) return found;
      await new Promise(r => setTimeout(r, 30));
    }
    return null;
  };

  const snap = await waitFor(m => m.type === 'devtools-snapshot' && m.tabId === tabId);
  assert.ok(snap, 'received devtools-snapshot');
  assert.ok(snap.console.some(e => e.level === 'warning' && e.text.includes('boot-warn')));
  const bootLog = snap.console.find(e => e.level === 'log' && (e.text.includes('boot-log') || e.args?.some(a => a.v === 'boot-log')));
  assert.ok(bootLog, 'captured initial console.log');
  const objArg = bootLog.args?.find(a => a.t === 'object');
  assert.ok(objArg && objArg.entries.some(([k, v]) => k === 'user' && v.v === 'alice'), 'object argument serialized cleanly');

  const okReq = snap.network.find(e => e.url.endsWith('/api/data') && e.status === 200);
  const failReq = snap.network.find(e => e.url.endsWith('/api/fail') && e.status === 500);
  assert.ok(okReq && !okReq.url.includes('strip-me'), '200 fetch captured with query stripped');
  assert.ok(failReq && !failReq.ok && !failReq.url.includes('hidden'), '500 fetch captured with query stripped');

  // Evaluate expressions via /api/tabs/:tabId/eval (including top-level await, circular objects, DOM element, and error)
  const postEval = async expression => fetch(`${base}/api/tabs/${encodeURIComponent(tabId)}/eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expression }),
  }).then(r => r.json());

  const evalObj = await postEval('const x = { n: 42, arr: [1, 2], el: document.getElementById("box") }; x.self = x; x');
  assert.equal(evalObj.ok, true);
  assert.equal(evalObj.entry.value.t, 'object');
  assert.ok(evalObj.entry.value.entries.some(([k, v]) => k === 'n' && v.t === 'number' && v.v === 42));
  assert.ok(evalObj.entry.value.entries.some(([k, v]) => k === 'self' && v.t === 'ref' && v.s === '[Circular]'));
  assert.ok(evalObj.entry.value.entries.some(([k, v]) => k === 'el' && v.t === 'element' && v.s.includes('div#box')));

  // Top-level await + REPL re-declaration works
  const evalAwait = await postEval('const x = await fetch("/api/data").then(r => r.json()); x.rows');
  assert.equal(evalAwait.ok, true);
  assert.equal(evalAwait.entry.value.t, 'array');
  assert.equal(evalAwait.entry.value.len, 3);

  // Runtime error returns ok:false cleanly with stack instead of crashing server
  const evalErr = await postEval('nonExistentSymbol123.boom()');
  assert.equal(evalErr.ok, false);
  assert.match(evalErr.error, /ReferenceError|nonExistentSymbol123/);

  // Realtime WS received devtools-event for evaluated result
  const streamedResult = await waitFor(m => m.type === 'devtools-event' && m.kind === 'console' && m.entry?.id === evalAwait.entry.id);
  assert.ok(streamedResult, 'eval result streamed over WS to subscribed DevTools viewer');

  // Agent console endpoint stays clean (excludes viewer REPL command/result rows)
  const agentConsole = await browser.agentConsole(tabId, { limit: 50 });
  assert.equal(agentConsole.entries.some(e => e.level === 'command' || e.level === 'result'), false);

  // Extension origin is blocked from calling /api/tabs/:tabId/eval
  const extBlocked = await fetch(`${base}/api/tabs/${encodeURIComponent(tabId)}/eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abcdefghijklmnop' },
    body: JSON.stringify({ expression: '1+1' }),
  });
  assert.equal(extBlocked.status, 403);

  // Clear console over WS broadcasts devtools-cleared and empties tab consoleLogs
  ws.send(JSON.stringify({ type: 'devtools-clear', tabId, target: 'console' }));
  const cleared = await waitFor(m => m.type === 'devtools-cleared' && m.tabId === tabId && m.target === 'console');
  assert.ok(cleared);
  assert.equal(browser.devtoolsSnapshot(tabId).console.length, 0);
  assert.ok(browser.devtoolsSnapshot(tabId).network.length >= 2);
});
