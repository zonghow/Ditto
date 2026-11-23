import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAdaptiveLayout } from '../public/overview-layout.js';

test('adaptive overview fills screen for 1 tab, splits 2 tabs evenly, and packs 3-9 tabs without dead corners', () => {
  const one = computeAdaptiveLayout(1, 1400, 760);
  assert.deepEqual(one.rowCounts, [1]);
  assert.deepEqual(one.spans, [1]);
  assert.equal(one.totalCols, 1);
  assert.equal(one.scrollable, false);

  const two = computeAdaptiveLayout(2, 1400, 760);
  assert.deepEqual(two.rowCounts, [2]);
  assert.deepEqual(two.spans, [1, 1]);
  assert.equal(two.totalCols, 2);

  const three = computeAdaptiveLayout(3, 1400, 760);
  assert.deepEqual(three.rowCounts, [2, 1]);
  assert.equal(three.totalCols, 2);
  assert.deepEqual(three.spans, [1, 1, 2]);

  const four = computeAdaptiveLayout(4, 1400, 760);
  assert.deepEqual(four.rowCounts, [2, 2]);
  assert.equal(four.totalCols, 2);
  assert.deepEqual(four.spans, [1, 1, 1, 1]);

  const five = computeAdaptiveLayout(5, 1400, 760);
  assert.deepEqual(five.rowCounts, [3, 2]);
  assert.equal(five.totalCols, 6);
  assert.deepEqual(five.spans, [2, 2, 2, 3, 3]);

  const six = computeAdaptiveLayout(6, 1400, 760);
  assert.deepEqual(six.rowCounts, [3, 3]);
  assert.equal(six.totalCols, 3);

  const nine = computeAdaptiveLayout(9, 1400, 760);
  assert.deepEqual(nine.rowCounts, [3, 3, 3]);
  assert.equal(nine.totalCols, 3);
});

test('adaptive overview adapts row/column orientation to ultrawide and portrait viewports', () => {
  const ultrawide3 = computeAdaptiveLayout(3, 2400, 720);
  assert.deepEqual(ultrawide3.rowCounts, [3]);
  assert.equal(ultrawide3.totalCols, 3);

  const portrait2 = computeAdaptiveLayout(2, 360, 700);
  assert.deepEqual(portrait2.rowCounts, [1, 1]);
  assert.equal(portrait2.totalCols, 1);
});

test('every row spans 100% of totalCols and large tab counts degrade gracefully to scrolling', () => {
  for (let n = 1; n <= 24; n++) {
    const layout = computeAdaptiveLayout(n, 1280, 720);
    assert.equal(layout.spans.length, n);
    let offset = 0;
    for (const count of layout.rowCounts) {
      const rowSum = layout.spans.slice(offset, offset + count).reduce((a, b) => a + b, 0);
      assert.equal(rowSum, layout.totalCols, `Row width mismatch for n=${n}`);
      offset += count;
    }
    assert.equal(offset, n);
  }
  const many = computeAdaptiveLayout(36, 1280, 720);
  assert.equal(many.scrollable, true);
  assert.ok(many.rowHeight >= 130);
});
