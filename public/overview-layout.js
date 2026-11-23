export function computeAdaptiveLayout(count, width, height, {
  gap = 12,
  footerHeight = 36,
  aspect = 16 / 10,
  minCardWidth = 170,
  minRowHeight = 130,
} = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const ratio = Math.min(2.2, Math.max(1.0, Number(aspect) || 16 / 10));

  if (n === 0) {
    return { rows: 1, totalCols: 1, rowCounts: [], spans: [], scrollable: false, minRowHeight };
  }
  if (n === 1) {
    return { rows: 1, totalCols: 1, rowCounts: [1], spans: [1], scrollable: false, minRowHeight };
  }

  const cardPreviewArea = (cols, rowHeight) => {
    const cw = Math.max(1, (w - gap * (cols - 1)) / cols);
    const ih = Math.max(1, rowHeight - footerHeight);
    const pw = Math.min(cw, ih * ratio);
    const ph = pw / ratio;
    return pw * ph;
  };

  let best = null;
  for (let rows = 1; rows <= n; rows++) {
    const base = Math.floor(n / rows);
    const extra = n % rows;
    const maxCols = extra ? base + 1 : base;
    // Skip layouts with more rows than needed for the same max column count (e.g. 4 items in 3 rows [2,1,1] vs 2 rows [2,2]).
    if (Math.ceil(n / maxCols) < rows) continue;

    const rowHeight = (h - gap * (rows - 1)) / rows;
    const minCardW = (w - gap * (maxCols - 1)) / maxCols;
    const fitsMin = rowHeight >= minRowHeight && minCardW >= minCardWidth;

    const denseArea = cardPreviewArea(maxCols, rowHeight);
    const sparseArea = extra ? cardPreviewArea(base, rowHeight) : denseArea;
    const avgArea = extra
      ? ((extra * (base + 1) * denseArea) + ((rows - extra) * base * sparseArea)) / n
      : denseArea;
    const score = denseArea * 0.65 + avgArea * 0.35;

    if (!best || (fitsMin && !best.fitsMin) || (fitsMin === best.fitsMin && score > best.score + 1e-6)) {
      best = { rows, base, extra, maxCols, fitsMin, score };
    }
  }

  let rows = best.rows;
  let scrollable = false;
  if (!best.fitsMin) {
    const maxFittingCols = Math.max(1, Math.min(n, Math.floor((w + gap) / (minCardWidth + gap))));
    rows = Math.ceil(n / maxFittingCols);
    scrollable = ((h - gap * (rows - 1)) / rows) < minRowHeight;
  }

  const base = Math.floor(n / rows);
  const extra = n % rows;
  const totalCols = extra ? base * (base + 1) : base;
  const rowCounts = [];
  const spans = [];
  for (let r = 0; r < rows; r++) {
    const itemsInRow = r < extra ? base + 1 : base;
    rowCounts.push(itemsInRow);
    const span = totalCols / itemsInRow;
    for (let i = 0; i < itemsInRow; i++) spans.push(span);
  }

  return {
    rows,
    totalCols,
    rowCounts,
    spans,
    scrollable,
    rowHeight: scrollable ? Math.max(minRowHeight, Math.round(((w - gap * (Math.max(...rowCounts) - 1)) / Math.max(...rowCounts)) / ratio + footerHeight)) : null,
  };
}
