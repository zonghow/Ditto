import test from 'node:test';
import assert from 'node:assert/strict';
import { CookieRequests } from '../src/cookie-requests.js';

test('cookie demand discovers exact origins without paths and explicit retry creates a new request', () => {
  const requests = new CookieRequests();
  const first = requests.observe('https://example.com:8443/private?session=synthetic');
  assert.equal(first.origin, 'https://example.com:8443');
  assert.equal(requests.observe('https://example.com:8443/elsewhere').id, first.id);
  assert.notEqual(requests.observe('https://example.com:8443', true).id, first.id);
  assert.equal(requests.observe('file:///private/path'), null);
  assert.equal(requests.observe('https://username:password@example.com'), null);
  assert.equal(JSON.stringify(requests.summary({})).includes('synthetic'), false);
});

test('automatic staging refuses unrelated/stale requests and never replaces pending snapshots', () => {
  const requests = new CookieRequests();
  const first = requests.observe('https://example.com');
  const snapshot = { origins: [{ origin: first.origin }] };
  assert.deepEqual(requests.validateUpload([first.id], snapshot, { pending: null }), [first]);
  assert.throws(() => requests.validateUpload([first.id], { origins: [{ origin: 'https://unrelated.test' }] }, {}), /本次请求/);
  assert.throws(() => requests.validateUpload([first.id, first.id], snapshot, {}), /请求无效/);
  assert.deepEqual(requests.validateUpload([first.id], snapshot, { pending: { id: 'existing' } }), [first]);
  requests.reconcile({ pending: { id: 'pending', origins: [first.origin] } });
  assert.equal(first.status, 'uploaded');
  requests.reconcile({ pending: null, applied: { id: 'pending', origins: [first.origin] } });
  assert.equal(first.status, 'applied');
  assert.throws(() => requests.validateUpload([first.id], snapshot, {}), /已变化/);
});

test('replaced manual uploads make unfulfilled demands retryable and demand inventory is bounded', () => {
  const requests = new CookieRequests();
  const first = requests.observe('https://example.com');
  requests.reconcile({ pending: { id: 'pending', origins: [first.origin] } });
  requests.reconcile({ pending: { id: 'different', origins: ['https://different.test'] } });
  assert.equal(first.status, 'waiting');
  for (let index = 0; index < 120; index++) requests.observe(`https://site-${index}.test`);
  assert.equal(requests.requests.size, 100);
});

test('an immediate write marks the demand applied before another upload can replace the remote token', () => {
  const requests = new CookieRequests();
  const demand = requests.observe('https://example.com');
  requests.reconcile({ pending: null, applied: { id: 'written', origins: [demand.origin] } });
  assert.equal(demand.status, 'applied');
  assert.throws(() => requests.validateUpload([demand.id], { origins: [{ origin: demand.origin }] }, { pending: null }), /已变化/);
});

test('already imported origins do not generate another automatic upload after service discovery or restart', () => {
  const requests = new CookieRequests();
  const applied = { applied: { origins: ['https://example.com'] } };
  assert.equal(requests.observe('https://example.com/page', false, applied).status, 'applied');
  assert.equal(requests.observe('https://example.com', true, applied).status, 'waiting');
});

test('newly visited origins after a prior full sync still request fresh on-demand sync', () => {
  const requests = new CookieRequests();
  const prevFull = { applied: { id: 'full-1', mode: 'full', origins: ['https://already-open.test'] } };
  const demand = requests.observe('https://fresh-site.test/dashboard', false, prevFull);
  assert.equal(demand.status, 'waiting');
  // Reconciling against the same stale full sync must keep the request waiting.
  requests.reconcile(prevFull);
  assert.equal(demand.status, 'waiting');
  // A newer full sync (or scoped upload for the origin) marks it applied.
  requests.reconcile({ pending: null, applied: { id: 'full-2', mode: 'full', origins: [] } });
  assert.equal(demand.status, 'applied');
});
