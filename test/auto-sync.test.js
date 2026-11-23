import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoSync } from '../extension/auto-sync.js';

function harness({ paired = true, origins = 'https://example.com:8443' } = {}) {
  const saved = {
    settings: paired ? { endpoint: 'http://127.0.0.1:3217', syncToken: 'synthetic-token-only-'.repeat(3) } : null,
    origins,
  };
  const uploads = [];
  const cookies = [
    { name: 'synthetic', value: 'test-cookie', domain: '.example.com', path: '/', hostOnly: false, storeId: '0' },
    { name: 'parent-session', value: 'test-cookie', domain: '.example.test', path: '/', hostOnly: false, storeId: '0' },
    { name: 'unrelated', value: 'never-upload', domain: '.unrelated.test', path: '/', hostOnly: false, storeId: '0' },
  ];
  const api = {
    storage: { local: { get: async () => structuredClone(saved) } },
    cookies: { getAllCookieStores: async () => [{ id: '0', tabIds: [1] }], getAll: async () => cookies },
    tabs: { query: async () => [{ id: 1, active: true, url: 'https://example.com:8443/home' }] },
    scripting: { executeScript: async () => [{ result: [{ name: 'synthetic', value: 'test-storage' }] }] },
  };
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    uploads.push({ url, body });
    const snapshot = body.snapshot || body;
    const pending = { id: `upload-${uploads.length}`, cookieCount: snapshot.cookies.length,
      storageCount: snapshot.origins.reduce((count, item) => count + item.localStorage.length, 0),
      origins: snapshot.origins.map(item => item.origin), warnings: [] };
    return { ok: true, json: async () => ({ pending, applied: { ...pending, importedCookies: pending.cookieCount, importedStorage: pending.storageCount } }) };
  };
  const engine = new AutoSync({ api, fetcher });
  engine.configure(saved);
  return { engine, api, saved, uploads };
}

test('automatic Cookie capture follows every remote origin demand without a local allowlist', async () => {
  const { engine, uploads, saved } = harness();
  engine.accept({ requests: [
    { id: 'allowed', origin: 'https://example.com:8443', status: 'waiting' },
    { id: 'sso', origin: 'https://sso.example.test', status: 'waiting' },
  ], pending: null });
  await engine.automatic();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].url, `${saved.settings.endpoint}/api/sync/auto`);
  assert.deepEqual(uploads[0].body.requestIds, ['allowed', 'sso']);
  assert.deepEqual(uploads[0].body.snapshot.origins.map(item => item.origin), ['https://example.com:8443', 'https://sso.example.test']);
  assert.deepEqual(uploads[0].body.snapshot.cookies.map(cookie => cookie.name).sort(), ['parent-session', 'synthetic']);
  assert.equal(JSON.stringify(engine.status()).includes(saved.settings.syncToken), false);
});

test('automatic sync is always enabled once paired and does not re-upload already applied demands', async () => {
  const { engine, uploads, saved } = harness({ paired: false });
  const request = { id: 'request', origin: 'https://example.com:8443', status: 'waiting' };
  engine.accept({ requests: [request] });
  assert.equal(engine.enabled, false);
  await engine.automatic();
  assert.equal(uploads.length, 0);
  saved.settings = { endpoint: 'http://127.0.0.1:3217', syncToken: 'synthetic-token-only-'.repeat(3) };
  engine.configure(saved);
  assert.equal(engine.enabled, true);
  engine.accept({ requests: [request], pending: { id: 'manual', origins: ['https://other.test'] } });
  await engine.automatic();
  assert.equal(uploads.length, 1);
  engine.accept({ requests: [request], pending: null });
  await Promise.all([engine.automatic(), engine.automatic()]);
  assert.equal(uploads.length, 1);
  engine.accept({ requests: [{ ...request, status: 'applied' }], pending: null });
  await engine.automatic();
  assert.equal(uploads.length, 1);
  engine.accept({ requests: [{ ...request, id: 'explicit-new-request' }], pending: null });
  await engine.automatic();
  assert.equal(uploads.length, 2);
});

test('clearing pairing during background capture cancels the upload', async () => {
  const { engine, api, saved, uploads } = harness();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  api.cookies.getAll = async () => { entered(); await gate; return []; };
  engine.accept({ requests: [{ id: 'request', origin: 'https://example.com:8443', status: 'waiting' }] });
  const capture = engine.automatic();
  await started;
  saved.settings = null;
  engine.configure(saved);
  release();
  await capture;
  assert.equal(uploads.length, 0);
});

test('background manual uploads perform full sync and diagnostics do not retain raw failures', async () => {
  const { engine, uploads } = harness();
  engine.accept({ requests: [{ id: 'manual', origin: 'https://example.com:8443', status: 'waiting' }] });
  await engine.manual();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].url, 'http://127.0.0.1:3217/api/sync');
  assert.equal(uploads[0].body.mode, 'full');
  engine.pending = null;
  engine.accept({ requests: [{ id: 'retry', origin: 'https://example.com:8443', status: 'waiting' }] });
  engine.fetcher = async () => { throw new Error('private-cookie-value-must-not-be-saved'); };
  await engine.automatic();
  assert.equal(JSON.stringify(engine.status()).includes('private-cookie-value'), false);
});

test('background automatic uploads invoke native fetch without the engine as its receiver', async () => {
  const { engine } = harness();
  engine.accept({ requests: [{ id: 'request', origin: 'https://example.com:8443', status: 'waiting' }] });
  let called = false;
  engine.fetcher = async function () {
    assert.equal(this, undefined);
    called = true;
    return { ok: true, json: async () => ({ pending: { id: 'upload', cookieCount: 1, storageCount: 0, origins: ['https://example.com:8443'] } }) };
  };
  await engine.automatic();
  assert.equal(called, true);
  assert.equal(engine.lastError, null);
});
