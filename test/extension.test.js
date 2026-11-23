import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captureSnapshot, parseOrigins, parsePairingInput, permissionPatterns, cookieMatches, parentOrigins, uploadSnapshot } from '../extension/capture.js';

test('extension origin selection remains explicit and exact', () => {
  assert.deepEqual(parseOrigins('https://example.com/a\nhttps://example.com\nhttp://example.com:8080'),
    ['https://example.com', 'http://example.com:8080']);
  assert.deepEqual(permissionPatterns(['https://example.com:8443']), ['https://example.com/*']);
  assert.throws(() => parseOrigins('chrome://settings'), /HTTP/);
  assert.throws(() => parseOrigins(''), /1–100/);
});
test('all HTTP/HTTPS host permissions are required once, with no per-upload request or checkbox', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://*/*', 'http://*/*']);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.ok(manifest.permissions.includes('cookies'));
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  assert.equal(popup.includes('permissions.request'), false);
  assert.equal(popup.includes("$('confirm')"), false);
});
test('Cookie selection respects parent/host-only domain boundaries', () => {
  assert.equal(cookieMatches({ domain: '.example.com', hostOnly: false }, 'https://app.example.com'), true);
  assert.equal(cookieMatches({ domain: '.example.com', hostOnly: false }, 'https://example.com.evil.test'), false);
  assert.equal(cookieMatches({ domain: 'example.com', hostOnly: true }, 'https://app.example.com'), false);
  assert.deepEqual(parentOrigins('https://sso.example.com'), ['https://example.com']);
  assert.deepEqual(parentOrigins('https://cloud.example.net'), ['https://example.net']);
  assert.deepEqual(parentOrigins('http://127.0.0.1:3217'), []);
});
test('capture is restricted to current cookie store and matching tab origin', async () => {
  const cookie = { domain: '.example.com', path: '/', name: 'session', value: 'synthetic-only', hostOnly: false, storeId: '0' };
  const calls = [];
  const api = {
    cookies: {
      getAllCookieStores: async () => [{ id: '0', tabIds: [1, 2] }, { id: '1', tabIds: [3] }],
      getAll: async filter => { calls.push(filter.storeId); return [cookie, { ...cookie, name: 'too-broad', domain: '.com' }, { ...cookie, domain: '.unrelated.test' }]; },
    },
    tabs: { query: async () => [
      { id: 1, active: true, url: 'https://example.com/home' },
      { id: 2, url: 'https://example.com:8443/home' },
      { id: 3, incognito: true, url: 'https://example.com/home' },
    ] },
    scripting: { executeScript: async options => {
      assert.equal(options.target.tabId, 2);
      assert.deepEqual(options.args, ['https://example.com:8443']);
      return [{ result: [{ name: 'token', value: 'synthetic-only' }] }];
    } },
  };
  const snapshot = await captureSnapshot(['https://example.com:8443'], api);
  assert.deepEqual(calls, ['0', '0']);
  assert.deepEqual(snapshot.cookies.map(item => item.name), ['session']);
  assert.equal(snapshot.origins[0].localStorage.length, 1);
});
test('missing tab reports partial storage instead of pretending collection succeeded', async () => {
  const api = { cookies: { getAllCookieStores: async () => [{ id: '0', tabIds: [] }], getAll: async () => [] },
    tabs: { query: async () => [] } };
  const result = await captureSnapshot(['https://example.com'], api);
  assert.deepEqual(result.warnings, ['storage-unavailable']);
});
test('withheld host access fails clearly without prompting or silently uploading partial state', async () => {
  const api = {
    permissions: { contains: async request => {
      assert.deepEqual(request.origins, ['https://example.com/*']);
      return false;
    } },
    cookies: { getAllCookieStores: async () => { assert.fail('Must not collect Cookies without host access.'); } },
  };
  await assert.rejects(captureSnapshot(['https://example.com'], api), /在所有网站上/);
});
test('extension parses direct devbox URLs with or without scheme and uploads without requiring SSH or token', async () => {
  assert.deepEqual(parsePairingInput('10.20.30.40:3217'), { endpoint: 'http://10.20.30.40:3217' });
  assert.deepEqual(parsePairingInput('http://10.20.30.40:3217/'), { endpoint: 'http://10.20.30.40:3217' });
  assert.deepEqual(parsePairingInput('{"endpoint":"http://10.20.30.40:3217","syncToken":"tok123"}'),
    { endpoint: 'http://10.20.30.40:3217', syncToken: 'tok123' });
  assert.throws(() => parsePairingInput('chrome://extensions'), /HTTP/);
  assert.throws(() => parsePairingInput('http://user:pass@10.20.30.40:3217'), /HTTP/);
  let sentHeaders = null;
  let sentUrl = null;
  const result = await uploadSnapshot({ endpoint: 'http://10.20.30.40:3217' }, { schemaVersion: 1 }, async (url, options) => {
    sentUrl = url;
    sentHeaders = options.headers;
    return { ok: true, json: async () => ({ applied: { importedCookies: 2 } }) };
  });
  assert.equal(sentUrl, 'http://10.20.30.40:3217/api/sync');
  assert.equal(sentHeaders.Authorization, undefined);
  assert.equal(result.importedCookies, 2);
});
