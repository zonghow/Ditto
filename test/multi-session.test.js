import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { configuration } from '../src/config.js';
import { BrowserService } from '../src/browser.js';
import { loadCredentials } from '../src/auth.js';
import { SyncStore } from '../src/sync-store.js';
import { createApplication } from '../src/app.js';

const execFileAsync = promisify(execFile);

test('concurrent agent sessions isolate tabs without --tab, wait through cookie imports, and stay unobstructed during viewer takeover', async t => {
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-multisession-'));
  const chromiumPath = process.env.DITTO_CHROMIUM_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  const config = configuration({ dataDir, port: 0, cdpPort: 0, demo: false, chromiumPath });
  const credentials = await loadCredentials(dataDir);
  const browser = new BrowserService(config);
  const sync = new SyncStore(dataDir);
  await sync.load();
  const app = createApplication({ config, credentials, browser, sync });

  const site = http.createServer((req, res) => {
    const label = req.url === '/b' ? 'SiteB' : 'SiteA';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>${label}</title>
      <input id="field" placeholder="${label} input">
      <button id="save" onclick="document.getElementById('out').textContent = '${label}:' + document.getElementById('field').value">Save</button>
      <div id="out">idle</div>
      <script>
        document.getElementById('field').addEventListener('keydown', e => {
          if (e.key === 'Enter') document.getElementById('out').dataset.enter = '${label}:' + e.target.value;
        });
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

  const cli = async (session, agent, ...args) => {
    const { stdout } = await execFileAsync('./scripts/ditto', args, {
      env: { ...process.env, DITTO_URL: base, DITTO_SESSION: session, DITTO_AGENT: agent },
    });
    return JSON.parse(stdout);
  };

  // 1. Two Codex sessions and one Claude Code session open pages concurrently
  const [openA, openB, openClaude] = await Promise.all([
    cli('codex-session-a', 'codex', 'open', `${origin}/a`),
    cli('codex-session-b', 'codex', 'open', `${origin}/b`),
    cli('claude-session-1', 'claude', 'open', `${origin}/a`),
  ]);
  assert.notEqual(openA.tabId, openB.tabId);
  assert.equal(openA.title, 'SiteA');
  assert.equal(openB.title, 'SiteB');
  assert.equal(openA.agent.agent, 'codex');
  assert.equal(openB.agent.agent, 'codex');
  assert.equal(openClaude.agent.agent, 'claude');
  assert.notEqual(openA.agent.label, openB.agent.label); // Codex #1 vs Codex #2
  assert.equal(openClaude.agent.label, 'Claude #1');
  assert.notEqual(openA.agent.color, openB.agent.color);
  assert.notEqual(openA.agent.color, openClaude.agent.color);

  // Same session opening a second tab shares the exact same color & label
  const openA2 = await cli('codex-session-a', 'codex', 'open', `${origin}/a`);
  assert.equal(openA2.agent.color, openA.agent.color);
  assert.equal(openA2.agent.label, openA.agent.label);
  await cli('codex-session-a', 'codex', 'close', '--tab', openA2.shortId);
  await cli('codex-session-a', 'codex', 'activate', openA.shortId);

  // 2. Ambiguous 4th session without open or --tab is blocked instead of hijacking Session A/B
  await assert.rejects(
    execFileAsync('./scripts/ditto', ['snapshot'], {
      env: { ...process.env, DITTO_URL: base, DITTO_SESSION: 'codex-session-c' },
    }),
  );

  // 3. Concurrent snapshots, fills, Enter key presses, clicks, and screenshots during a simultaneous cookie import!
  const importTask = fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1,
      cookies: [{ name: 'shared_auth', value: 'ok', domain: '127.0.0.1', path: '/', hostOnly: true }],
      origins: [{ origin, localStorage: [{ name: 'k', value: 'v' }] }],
    }),
  });

  const [resA, resB] = await Promise.all([
    (async () => {
      const snap = await cli('codex-session-a', 'codex', 'snapshot');
      assert.equal(snap.title, 'SiteA');
      const input = snap.elements.find(e => e.tag === 'input').ref;
      const btn = snap.elements.find(e => e.tag === 'button').ref;
      await cli('codex-session-a', 'codex', 'fill', input, 'alpha-payload');
      await cli('codex-session-a', 'codex', 'press', 'Enter');
      await cli('codex-session-a', 'codex', 'click', btn);
      return cli('codex-session-a', 'codex', 'eval', "({ text: document.getElementById('out').textContent, enter: document.getElementById('out').dataset.enter })");
    })(),
    (async () => {
      const snap = await cli('codex-session-b', 'codex', 'snapshot');
      assert.equal(snap.title, 'SiteB');
      const input = snap.elements.find(e => e.tag === 'input').ref;
      const btn = snap.elements.find(e => e.tag === 'button').ref;
      await cli('codex-session-b', 'codex', 'fill', input, 'beta-payload');
      await cli('codex-session-b', 'codex', 'press', 'Enter');
      await cli('codex-session-b', 'codex', 'click', btn);
      return cli('codex-session-b', 'codex', 'eval', "({ text: document.getElementById('out').textContent, enter: document.getElementById('out').dataset.enter })");
    })(),
    importTask,
  ]);

  assert.deepEqual(resA.result, { text: 'SiteA:alpha-payload', enter: 'SiteA:alpha-payload' });
  assert.deepEqual(resB.result, { text: 'SiteB:beta-payload', enter: 'SiteB:beta-payload' });

  // Active cooldown highlight is visible immediately in /api/state
  const stateNow = await fetch(`${base}/api/state`).then(r => r.json());
  const tabASummary = stateNow.browser.tabs.find(item => item.id === openA.tabId);
  assert.equal(tabASummary.agent.active, true);
  assert.equal(stateNow.browser.agentSessions.length, 3);

  // 4. Viewer takeover on Tab A enables human interaction without blocking Agent operations on Tab A or Tab B.
  browser.setViewer('human-viewer-1', openA.tabId, false);
  browser.acquireControl('human-viewer-1');
  const stillWorksOnA = await cli('codex-session-a', 'codex', 'eval', 'document.title');
  assert.equal(stillWorksOnA.result, 'SiteA');
  const stillWorksOnB = await cli('codex-session-b', 'codex', 'eval', 'document.title');
  assert.equal(stillWorksOnB.result, 'SiteB');
  browser.control.release('human-viewer-1');
});
