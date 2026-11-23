import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BrowserService } from '../src/browser.js';

function imageResponse(body, type = 'image/png') {
  return { status: () => 200, headers: () => ({ 'content-type': type, 'content-length': String(body.length) }), body: async () => body };
}

test('a recorded image missed at record time is refilled once from the owned browser', async () => {
  const service = new BrowserService({});
  const calls = [];
  service.context = { request: { get: async (url) => { calls.push(url); return imageResponse(Buffer.from('synthetic')); } } };
  const reference = service.assets.reference('synthetic-tab', 'https://example.com/avatar.png', '', true);
  const id = reference.split('/').pop();
  assert.equal(service.assets.get(id).body, null);
  assert.equal(await service.refillAsset(id), true);
  assert.deepEqual(calls, ['https://example.com/avatar.png']);
  assert.equal(service.assets.get(id).body.toString(), 'synthetic');
  // A cached payload is never requested again.
  assert.equal(await service.refillAsset(id), false);
  assert.equal(calls.length, 1);
});

test('refill never becomes a general purpose proxy and backs off after a failure', async () => {
  const service = new BrowserService({});
  let calls = 0;
  service.context = { request: { get: async () => { calls++; return { status: () => 404, headers: () => ({}), body: async () => Buffer.alloc(0) }; } } };
  assert.equal(await service.refillAsset('0'.repeat(36)), false);
  assert.equal(calls, 0);
  const id = service.assets.reference('synthetic-tab', 'https://example.com/missing.png', '', true).split('/').pop();
  assert.equal(await service.refillAsset(id), false);
  assert.equal(calls, 1);
  // The same miss is not retried on every replay refresh.
  assert.equal(await service.refillAsset(id), false);
  assert.equal(calls, 1);
});

test('refill refuses a payload whose type the replay would never render', async () => {
  const service = new BrowserService({});
  service.context = { request: { get: async () => imageResponse(Buffer.from('<html></html>'), 'text/html') } };
  const id = service.assets.reference('synthetic-tab', 'https://example.com/page', '', true).split('/').pop();
  assert.equal(await service.refillAsset(id), false);
  assert.equal(service.assets.get(id).body, null);
});
