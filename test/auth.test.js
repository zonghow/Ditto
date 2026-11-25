import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Authentication, SESSION_SECONDS, allowedOrigin, constantEqual, loadCredentials, validHost } from '../src/auth.js';

const credentials = { dashboardToken: randomBytes(32).toString('hex'), syncToken: randomBytes(32).toString('hex'),
  sessionKey: randomBytes(32).toString('hex') };
const auth = new Authentication(credentials);
test('permanent and timed signed sessions validate strictly and cannot be forged', () => {
  const now = 1000000000000;
  const permanent = auth.session(now);
  assert.equal(permanent.startsWith('0.'), true);
  assert.equal(auth.validSession(permanent, now), true);
  assert.equal(auth.validSession(permanent, now + 10 * 365 * 24 * 3600 * 1000), true);
  assert.equal(auth.validSession(`${permanent}x`, now), false);
  assert.equal(auth.validSession(permanent.replace(/^0/, '999999999999'), now), false);

  const timed = auth.session(now, 3600);
  assert.equal(auth.validSession(timed, now), true);
  assert.equal(auth.validSession(timed, now + 3600 * 1000), false);
  assert.equal(auth.validSession(timed.replace(/^\d+/, '0'), now), false);
  assert.equal(SESSION_SECONDS, 400 * 24 * 60 * 60);
});
test('sync and dashboard credentials have distinct permissions', () => {
  const request = token => ({ headers: { authorization: `Bearer ${token}` } });
  assert.equal(auth.isDashboard(request(credentials.dashboardToken)), true);
  assert.equal(auth.isSync(request(credentials.dashboardToken)), false);
  assert.equal(auth.isDashboard(request(credentials.syncToken)), false);
  assert.equal(auth.isSync(request(credentials.syncToken)), true);
});
test('accepts direct IP and hostname hosts while denying malformed hosts, foreign origins and extension admin requests', () => {
  assert.equal(validHost('127.0.0.1:3217'), true);
  assert.equal(validHost('10.20.30.40:3217'), true);
  assert.equal(validHost('devbox.internal:3217'), true);
  assert.equal(validHost('localhost:3210'), true);
  assert.equal(validHost('evil.test/path'), false);
  assert.equal(validHost('user@10.0.0.1:3217'), false);
  assert.equal(validHost('10.0.0.1:99999'), false);
  const headers = { host: '10.20.30.40:3217', origin: 'https://evil.test' };
  assert.equal(allowedOrigin({ headers }), false);
  headers.origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  assert.equal(allowedOrigin({ headers }), false);
  assert.equal(allowedOrigin({ headers }, true), true);
  headers.origin = 'http://10.20.30.40:3217';
  assert.equal(allowedOrigin({ headers }), true);
  headers.origin = 'http://10.20.30.40:9999';
  assert.equal(allowedOrigin({ headers }), false);
});
test('constantEqual never accepts empty credentials', () => {
  assert.equal(constantEqual('', ''), false);
  assert.equal(constantEqual('one', 'onetwo'), false);
  assert.equal(constantEqual('one', 'one'), true);
});

test('unified token shares dashboard/sync auth and rotating token invalidates old permanent sessions', async () => {
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-auth-unified-'));
  const creds1 = await loadCredentials(dataDir, { token: 'unified-secret-v1' });
  assert.equal(creds1.unifiedToken, true);
  assert.equal(creds1.dashboardToken, 'unified-secret-v1');
  assert.equal(creds1.syncToken, 'unified-secret-v1');

  const auth1 = new Authentication(creds1);
  assert.equal(auth1.hasUnifiedToken(), true);
  const req = { headers: { authorization: 'Bearer unified-secret-v1' } };
  assert.equal(auth1.isDashboard(req), true);
  assert.equal(auth1.isSync(req), true);

  const sessionV1 = auth1.session();
  assert.equal(auth1.validSession(sessionV1), true);

  // Restart with the same token keeps permanent sessions valid.
  const creds1Again = await loadCredentials(dataDir, { token: 'unified-secret-v1' });
  const auth1Again = new Authentication(creds1Again);
  assert.equal(auth1Again.validSession(sessionV1), true);

  // Rotating token immediately invalidates all previously issued sessions.
  const creds2 = await loadCredentials(dataDir, { token: 'unified-secret-v2' });
  const auth2 = new Authentication(creds2);
  assert.equal(auth2.validSession(sessionV1), false);
});
