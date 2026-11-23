export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 10 * 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.max(0, Math.round(n))} B`;
}

export function createMemoryPanel({ api, element, isAuthenticated }) {
  const $ = selector => document.querySelector(selector);
  let pollTimer = null;
  let fetching = false;

  function render(data) {
    const totalEl = $('#memory-total');
    const barEl = $('#memory-bar');
    const metaEl = $('#memory-meta');
    const catsEl = $('#memory-categories');
    const nodeEl = $('#memory-node-stats');
    const procsEl = $('#memory-processes');
    if (!totalEl || !data) return;

    const total = Math.max(0, Number(data.totalBytes) || 0);
    totalEl.textContent = formatBytes(total);

    if (barEl) {
      barEl.replaceChildren();
      if (total > 0) {
        for (const item of data.summary || []) {
          if (!item.bytes) continue;
          const seg = element('span', `memory-bar-seg memory-seg-${item.category}`);
          seg.style.width = `${Math.max(2, (item.bytes / total) * 100)}%`;
          seg.title = `${item.label}: ${formatBytes(item.bytes)}`;
          barEl.append(seg);
        }
      }
    }

    if (metaEl) {
      const parts = [`${data.processCount || 0} 个进程`, data.metric === 'pss' ? '实际物理内存 (PSS)' : '常驻内存 (RSS)'];
      if (data.swapBytes > 0) parts.push(`Swap ${formatBytes(data.swapBytes)}`);
      if (data.limitBytes) parts.push(`限额 ${formatBytes(data.limitBytes)}`);
      metaEl.textContent = parts.join(' · ');
    }

    if (catsEl) {
      catsEl.replaceChildren();
      for (const item of data.summary || []) {
        const row = element('div', 'memory-cat-row');
        const left = element('span', 'memory-cat-left');
        left.append(
          element('span', `memory-dot memory-seg-${item.category}`),
          element('span', '', item.label),
          element('span', 'memory-cat-count', `(${item.count})`),
        );
        const pct = total > 0 ? Math.round((item.bytes / total) * 100) : 0;
        const right = element('span', 'memory-cat-val', formatBytes(item.bytes));
        right.append(element('span', 'memory-cat-pct', `${pct}%`));
        row.append(left, right);
        catsEl.append(row);
      }
    }

    if (nodeEl && data.node) {
      nodeEl.replaceChildren(
        element('span', 'memory-chip', `V8 堆 ${formatBytes(data.node.heapUsed)}`),
        element('span', 'memory-chip', `回放缓存 ${formatBytes(data.node.recordingBytes)}`),
        element('span', 'memory-chip', `资源缓存 ${formatBytes(data.node.assetCacheBytes)}`),
      );
    }

    if (procsEl) {
      procsEl.replaceChildren();
      const maxProc = Math.max(1, ...(data.processes || []).map(p => p.bytes || 0));
      for (const proc of data.processes || []) {
        const row = element('div', 'memory-proc-row');
        const top = element('div', 'memory-proc-top');
        const name = element('span', 'memory-proc-name');
        name.append(
          element('span', `memory-dot memory-seg-${proc.category}`),
          element('span', '', proc.label),
          element('span', 'memory-proc-pid', `#${proc.pid}`),
        );
        const mem = element('span', 'memory-proc-mem', formatBytes(proc.bytes));
        if (proc.swapBytes > 0) mem.append(element('span', 'memory-proc-swap', `+${formatBytes(proc.swapBytes)} swap`));
        top.append(name, mem);
        const track = element('div', 'memory-proc-track');
        const fill = element('div', `memory-proc-fill memory-seg-${proc.category}`);
        fill.style.width = `${Math.max(2, Math.round((proc.bytes / maxProc) * 100))}%`;
        track.append(fill);
        row.append(top, track);
        procsEl.append(row);
      }
    }
  }

  async function refresh(force = false) {
    if (!isAuthenticated() || fetching) return;
    fetching = true;
    const btn = $('#memory-refresh');
    btn?.classList.add('loading');
    try {
      render(await api(force ? '/api/memory?force=1' : '/api/memory'));
    } catch { /* ignore transient offline errors */ }
    finally {
      fetching = false;
      btn?.classList.remove('loading');
    }
  }

  function start() {
    refresh(false);
    if (!pollTimer) pollTimer = setInterval(() => refresh(false), 5000);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  $('#memory-toggle')?.addEventListener('click', () => {
    const details = $('#memory-details');
    const toggle = $('#memory-toggle');
    if (!details || !toggle) return;
    const willOpen = details.hidden;
    details.hidden = !willOpen;
    toggle.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) refresh(false);
  });
  $('#memory-refresh')?.addEventListener('click', () => refresh(true));

  return { refresh, start, stop };
}
