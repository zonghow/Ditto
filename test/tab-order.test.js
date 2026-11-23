import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTabOrder, orderedTabs } from '../src/tab-order.js';
import { BrowserService } from '../src/browser.js';

test('native tab order maps page targets from CDP child sessions and uses actual strip index', () => {
  const inventory = new NativeTabOrder();
  inventory.sessions.set('tab-a', 'session-a');
  inventory.sessions.set('tab-b', 'session-b');
  inventory.tabs.set('tab-a', { index: 2, active: true });
  inventory.tabs.set('tab-b', { index: 0, active: false });
  inventory.receive(Buffer.from(JSON.stringify({ method: 'Target.attachedToTarget', sessionId: 'session-a',
    params: { targetInfo: { targetId: 'page-a', type: 'page' } } })));
  inventory.receive(Buffer.from(JSON.stringify({ method: 'Target.attachedToTarget', sessionId: 'session-b',
    params: { targetInfo: { targetId: 'page-b', type: 'page' } } })));
  assert.equal(inventory.get('page-a').index, 2);
  const tabs = [
    { id: 'a', targetId: 'page-a', createdAt: '2026-01-01' },
    { id: 'b', targetId: 'page-b', createdAt: '2026-01-02' },
  ];
  assert.deepEqual(orderedTabs(tabs, inventory).map(tab => tab.id), ['b', 'a']);
  inventory.tabs.get('tab-a').index = 0;
  inventory.tabs.get('tab-b').index = 1;
  assert.deepEqual(orderedTabs(tabs, inventory).map(tab => tab.id), ['a', 'b']);
});

test('tab order falls back explicitly and does not mix unrelated browser-window indices', () => {
  const tabs = [
    { id: 'b', targetId: 'b', windowId: 2, createdAt: '2026-01-02' },
    { id: 'a', targetId: 'a', windowId: 1, createdAt: '2026-01-01' },
  ];
  assert.deepEqual(orderedTabs(tabs).map(tab => tab.id), ['a', 'b']);
  assert.deepEqual(orderedTabs(tabs, { get: () => ({ index: 0 }) }).map(tab => tab.id), ['a', 'b']);
});

test('placeTabAfter inserts new or duplicated tabs immediately after anchor tab even with native strip indices', () => {
  const service = new BrowserService({});
  service.tabOrder = {
    get: id => ({ 'p-1': { index: 0 }, 'p-2': { index: 1 }, 'p-3': { index: 2 } }[id]),
  };
  const t1 = { id: 't1', targetId: 'p-1', hidden: false, createdAt: '2026-01-01' };
  const t2 = { id: 't2', targetId: 'p-2', hidden: false, createdAt: '2026-01-02' };
  const t3 = { id: 't3', targetId: 'p-3', hidden: false, createdAt: '2026-01-03' };
  service.tabs.set('t1', t1);
  service.tabs.set('t2', t2);
  service.tabs.set('t3', t3);

  service.placeTabAfter(t3, 't1');
  assert.deepEqual(orderedTabs([...service.tabs.values()], service.tabOrder).map(t => t.id), ['t1', 't3', 't2']);
});
