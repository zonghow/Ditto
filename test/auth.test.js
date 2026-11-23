import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Authentication, SESSION_SECONDS, allowedOrigin, constantEqual, validHost } from '../src/auth.js';

const credentials = { dashboardToken: randomBytes(32).toString('hex'), syncToken: randomBytes(32).toString('hex'),
  sessionKey: randomBytes(32).toString('hex') };
const auth = new Authentication(credentials);
test('signed sessions expire and cannot be forged', () => {
  const now = 1000000000000;
  const session = auth.session(now);
  assert.equal(auth.validSession(session, now), true);
  assert.equal(auth.validSession(`${session}x`, now), false);
  assert.equal(auth.validSession(session, now + SESSION_SECONDS * 1000), false);
  assert.equal(auth.validSession(session.replace(/^\d+/, '999999999999'), now), false);
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
