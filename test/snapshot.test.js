import test from 'node:test';
import assert from 'node:assert/strict';
import CryptoJS from 'crypto-js';
import { normalizeCookie, normalizeSnapshot, decryptCookieCloud, matchesDomain, httpOrigin } from '../src/snapshot.js';

const cookie = {
  name: 'session', value: 'synthetic-test-only', domain: '.example.com', path: '/',
  httpOnly: true, secure: true, sameSite: 'no_restriction', hostOnly: false, expirationDate: 2000000000,
};
function snapshot(extra = {}) {
  return { schemaVersion: 1, collectedAt: '2026-01-01T00:00:00Z', cookies: [cookie],
    origins: [{ origin: 'https://app.example.com:8443', localStorage: [{ name: 'token', value: 'synthetic-only' }] }], ...extra };
}

test('preserves Cookie security, expiration and parent-domain scope', () => {
  const normalized = normalizeCookie(cookie, 1800000000);
  assert.deepEqual(normalized.cookie, { name: cookie.name, value: cookie.value, domain: '.example.com', path: '/',
    httpOnly: true, secure: true, sameSite: 'None', expires: 2000000000 });
});
test('preserves host-only Cookie using CDP URL and unspecified SameSite', () => {
  const normalized = normalizeCookie({ ...cookie, domain: 'app.example.com', hostOnly: true, sameSite: 'unspecified', session: true });
  assert.equal(normalized.cookie.url, 'https://app.example.com/');
  assert.equal(normalized.cookie.domain, undefined);
  assert.equal(normalized.cookie.expires, undefined);
  assert.equal(normalized.cookie.sameSite, undefined);
});
test('expired Cookies are skipped, not extended', () => {
  assert.equal(normalizeCookie({ ...cookie, expirationDate: 100 }, 101), null);
  const normalized = normalizeSnapshot(snapshot({ cookies: [{ ...cookie, expirationDate: 100 }] }), 'extension', 101);
  assert.equal(normalized.cookies.length, 0);
  assert.equal(normalized.warnings.length, 1);
});
test('full origin including scheme/port is preserved', () => {
  assert.equal(normalizeSnapshot(snapshot()).origins[0].origin, 'https://app.example.com:8443');
  assert.equal(httpOrigin('http://example.com:8080/path'), 'http://example.com:8080');
});
test('accepts a parent-domain Cookie for a requested origin and rejects a deceptive suffix', () => {
  const parent = normalizeSnapshot(snapshot({
    cookies: [{ name: 'session', value: 'synthetic', domain: '.example.com', path: '/', secure: true, hostOnly: false }],
    origins: [{ origin: 'https://sso.example.com', localStorage: [] }],
  }));
  assert.equal(parent.cookies.length, 1);
  assert.throws(() => normalizeSnapshot(snapshot({
    cookies: [{ name: 'too-broad', value: 'synthetic', domain: '.com', path: '/', secure: true, hostOnly: false }],
    origins: [{ origin: 'https://sso.example.com', localStorage: [] }],
  })), /父域/);
  assert.throws(() => normalizeSnapshot(snapshot({ origins: [{ origin: 'https://notexample.com', localStorage: [] }] })), /不属于/);
  assert.equal(matchesDomain('example.com.evil.test', '.example.com'), false);
  assert.equal(matchesDomain('notexample.com', '.example.com'), false);
  assert.equal(matchesDomain('sub.example.com', '.example.com'), true);
  assert.equal(matchesDomain('sub.example.com', 'example.com', true), false);
});
test('partition keys are retained and missing ancestry is rejected', () => {
  const normalized = normalizeCookie({ ...cookie, partitionKey: { topLevelSite: 'https://portal.test', hasCrossSiteAncestor: false } });
  assert.deepEqual(normalized.cookie.partitionKey, { topLevelSite: 'https://portal.test', hasCrossSiteAncestor: false });
  assert.throws(() => normalizeCookie({ ...cookie, partitionKey: { topLevelSite: 'https://portal.test' } }), /hasCrossSiteAncestor/);
});
test('rejects security downgrade and invalid storage', () => {
  assert.throws(() => normalizeCookie({ ...cookie, secure: false }), /Secure/);
  assert.throws(() => normalizeCookie({ ...cookie, secure: 'false' }), /布尔/);
  assert.throws(() => normalizeSnapshot(snapshot({ origins: [{ origin: 'file:///secret', localStorage: [] }] })), /HTTP/);
  assert.throws(() => normalizeSnapshot(snapshot({ origins: [{ origin: 'https://example.com/path', localStorage: [] }] })), /路径/);
  assert.throws(() => normalizeSnapshot(snapshot({ origins: [{ origin: 'https://example.com', localStorage: [{ name: 'x', value: {} }] }] })), /字符串/);
});
test('CookieCloud deduplicates groups and warns about hostname-only storage', () => {
  const normalized = normalizeSnapshot({ cookie_data: { example: [cookie], '.example.com': [cookie] },
    local_storage_data: { 'app.example.com': { token: 'synthetic-only' } } }, 'cookiecloud');
  assert.equal(normalized.cookies.length, 1);
  assert.equal(normalized.origins[0].origin, 'https://app.example.com');
  assert.match(normalized.warnings[0], /HTTPS/);
});
test('CookieCloud supports both actual upstream encryption formats', () => {
  const credentials = { uuid: 'synthetic-uuid', password: 'synthetic-password' };
  const payload = { cookie_data: { '.example.com': [cookie] }, local_storage_data: {} };
  const key = CryptoJS.MD5(`${credentials.uuid}-${credentials.password}`).toString().slice(0, 16);
  for (const type of ['legacy', 'aes-128-cbc-fixed']) {
    const encrypted = type === 'legacy'
      ? CryptoJS.AES.encrypt(JSON.stringify(payload), key).toString()
      : CryptoJS.AES.encrypt(JSON.stringify(payload), CryptoJS.enc.Utf8.parse(key), {
        iv: CryptoJS.enc.Hex.parse('00000000000000000000000000000000'), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7,
      }).ciphertext.toString(CryptoJS.enc.Base64);
    assert.deepEqual(decryptCookieCloud({ uuid: credentials.uuid, encrypted, crypto_type: type }, credentials), payload);
  }
  assert.throws(() => decryptCookieCloud({ uuid: 'wrong', encrypted: '' }, credentials), /UUID/);
  assert.throws(() => decryptCookieCloud({ uuid: credentials.uuid, encrypted: 'nonsense' }, credentials), /解密/);
});
