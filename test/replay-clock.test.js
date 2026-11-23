import test from 'node:test';
import assert from 'node:assert/strict';
import { replayBaseline } from '../public/replay-clock.js';

test('selecting an idle cached tab starts live replay at remote now, not its old last event time', () => {
  const recording = { serverTime: 1_800_000_000_000, receivedAt: 1000 };
  assert.equal(replayBaseline(recording, 80, 21000), recording.serverTime + 20000 - 80);
  assert.equal(replayBaseline(recording, 200, 21000), recording.serverTime + 20000 - 200);
  assert.deepEqual(recording, { serverTime: 1_800_000_000_000, receivedAt: 1000 });
});

test('replay baseline uses elapsed monotonic time and tolerates legacy cached records', () => {
  assert.equal(replayBaseline({ serverTime: 500, receivedAt: 2000 }, 80, 1000), 420);
  assert.equal(replayBaseline({ serverTime: 500 }, 80, 900000), 420);
});
