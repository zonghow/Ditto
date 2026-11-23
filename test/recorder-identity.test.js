import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserService } from '../src/browser.js';

function harness({ live = 'new-document' } = {}) {
  const service = new BrowserService({});
  const emitted = [];
  const evaluated = [];
  const frame = { name: 'main' };
  const page = {
    isClosed: () => false,
    url: () => 'https://example.test/app',
    mainFrame: () => frame,
    evaluate: async (fn, argument) => { evaluated.push(argument); return live; },
  };
  const tab = { id: 'tab-1', page, hidden: false, crashed: false, documentId: 'old-document',
    recordingStatus: 'live' };
  service.tabs.set(tab.id, tab);
  service.track = () => {};
  service.on('recording', message => emitted.push(message));
  service.on('change', () => {});
  service.checkpoint = async target => { emitted.push({ type: 'checkpoint', tabId: target.id }); };
  return { service, tab, page, frame, emitted, evaluated };
}

const snapshotEvent = { type: 2, timestamp: 1, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } } };

test('a stale tab identity adopts the recorder that actually runs in the page', async () => {
  const { service, tab, page, frame, emitted, evaluated } = harness({ live: 'new-document' });
  service.receiveRecording({ page, frame }, { documentId: 'new-document', type: 'event', event: snapshotEvent });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tab.documentId, 'new-document');
  assert.ok(emitted.some(message => message.type === 'rrweb-reset' && message.documentId === 'new-document'));
  assert.ok(emitted.some(message => message.type === 'checkpoint'));
  assert.deepEqual(evaluated, ['__dittoRecorderV1']);
});

test('a stale emitter cannot steal identity from the live recorder', async () => {
  const { service, tab, page, frame, emitted } = harness({ live: 'old-document' });
  service.receiveRecording({ page, frame }, { documentId: 'ghost-document', type: 'event', event: snapshotEvent });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tab.documentId, 'old-document');
  assert.equal(emitted.some(message => message.type === 'rrweb-reset'), false);
  // The live recorder is still asked for a fresh, complete snapshot.
  assert.ok(emitted.some(message => message.type === 'checkpoint'));
});

test('reconciliation is throttled so a flood of stale events cannot spam the page', async () => {
  const { service, tab, page, frame, emitted } = harness({ live: 'new-document' });
  service.receiveRecording({ page, frame }, { documentId: 'new-document', type: 'event', event: snapshotEvent });
  service.receiveRecording({ page, frame }, { documentId: 'new-document', type: 'event', event: snapshotEvent });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tab.documentId, 'new-document');
  assert.equal(emitted.filter(message => message.type === 'checkpoint').length, 1);
});
