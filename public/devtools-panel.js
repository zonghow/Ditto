const MAX_ENTRIES = 200;
const MAX_HISTORY = 100;
const MIN_HEIGHT = 150;
const DEFAULT_HEIGHT = 270;

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function shortLocation(loc) {
  if (!loc?.url) return '';
  try {
    const parsed = new URL(loc.url);
    const seg = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
    return loc.line ? `${seg}:${loc.line}` : seg;
  } catch {
    return loc.line ? `${loc.url}:${loc.line}` : loc.url;
  }
}

function shortNetworkPath(rawUrl) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    const p = parsed.pathname === '/' ? parsed.host : parsed.pathname;
    return p;
  } catch {
    return rawUrl;
  }
}

function createValueNode(element, desc, { quoteStrings = true } = {}) {
  if (!desc || typeof desc !== 'object') {
    return element('span', 'dt-val dt-val-null', 'undefined');
  }
  switch (desc.t) {
    case 'undefined':
      return element('span', 'dt-val dt-val-null', 'undefined');
    case 'null':
      return element('span', 'dt-val dt-val-null', 'null');
    case 'boolean':
      return element('span', 'dt-val dt-val-bool', String(desc.v));
    case 'number':
      return element('span', 'dt-val dt-val-num', desc.s !== undefined ? desc.s : String(desc.v));
    case 'bigint':
      return element('span', 'dt-val dt-val-num', desc.s || '0n');
    case 'string': {
      const text = desc.truncated ? `${desc.v}…` : String(desc.v ?? '');
      if (!quoteStrings) return element('span', 'dt-val dt-val-plain', text);
      return element('span', 'dt-val dt-val-str', JSON.stringify(text));
    }
    case 'symbol':
      return element('span', 'dt-val dt-val-sym', desc.s || 'Symbol()');
    case 'function':
      return element('span', 'dt-val dt-val-fn', desc.s || 'ƒ ()');
    case 'date':
      return element('span', 'dt-val dt-val-date', desc.s || 'Date');
    case 'regexp':
      return element('span', 'dt-val dt-val-regexp', desc.s || '/(?:)/');
    case 'element': {
      const span = element('span', 'dt-val dt-val-el', desc.s || '<element>');
      if (desc.text) span.title = desc.text;
      return span;
    }
    case 'ref':
    case 'max':
      return element('span', 'dt-val dt-val-muted', desc.s || '…');
    case 'error': {
      const wrap = element('span', 'dt-val dt-val-err');
      const head = `${desc.name || 'Error'}: ${desc.message || ''}`.trim();
      if (!desc.stack) {
        wrap.textContent = head;
        return wrap;
      }
      const details = element('details', 'dt-tree dt-tree-error');
      const summary = element('summary', 'dt-tree-summary', head);
      const pre = element('pre', 'dt-stack', desc.stack);
      details.append(summary, pre);
      return details;
    }
    case 'array':
    case 'object':
    case 'map':
    case 'set': {
      const details = element('details', 'dt-tree');
      const summary = element('summary', 'dt-tree-summary', desc.preview || desc.cls || desc.t);
      details.append(summary);
      let populated = false;
      details.addEventListener('toggle', () => {
        if (!details.open || populated) return;
        populated = true;
        const body = element('div', 'dt-tree-children');
        if (desc.t === 'array' || desc.t === 'set') {
          const items = desc.items || [];
          for (let i = 0; i < items.length; i++) {
            const row = element('div', 'dt-tree-row');
            row.append(
              element('span', 'dt-tree-key', `${i}:`),
              createValueNode(element, items[i], { quoteStrings: true }),
            );
            body.append(row);
          }
          if (desc.more > 0) {
            body.append(element('div', 'dt-tree-more', `… 还有 ${desc.more} 项`));
          }
          if (desc.t === 'array') {
            const lenRow = element('div', 'dt-tree-row');
            lenRow.append(
              element('span', 'dt-tree-key dt-tree-key-meta', 'length:'),
              element('span', 'dt-val dt-val-num', String(desc.len ?? items.length)),
            );
            body.append(lenRow);
          }
        } else if (desc.t === 'map') {
          for (const [kDesc, vDesc] of desc.entries || []) {
            const row = element('div', 'dt-tree-row');
            row.append(
              createValueNode(element, kDesc, { quoteStrings: true }),
              element('span', 'dt-tree-arrow', ' => '),
              createValueNode(element, vDesc, { quoteStrings: true }),
            );
            body.append(row);
          }
          if (desc.more > 0) {
            body.append(element('div', 'dt-tree-more', `… 还有 ${desc.more} 项`));
          }
        } else {
          const entries = desc.entries || [];
          if (!entries.length) {
            body.append(element('div', 'dt-tree-more', '(空对象)'));
          } else {
            for (const [key, valDesc] of entries) {
              const row = element('div', 'dt-tree-row');
              row.append(
                element('span', 'dt-tree-key', `${key}:`),
                createValueNode(element, valDesc, { quoteStrings: true }),
              );
              body.append(row);
            }
          }
          if (desc.more > 0) {
            body.append(element('div', 'dt-tree-more', `… 还有 ${desc.more} 个属性`));
          }
        }
        details.append(body);
      });
      return details;
    }
    default:
      return element('span', 'dt-val', String(desc.s ?? desc.v ?? ''));
  }
}

export function createDevtoolsPanel({
  $,
  element,
  api,
  copyText,
  toast,
  getSelectedTab,
  isBrowserReady,
  onSubscribe,
  onClear,
  onLayoutChange,
}) {
  const panel = $('#devtools-panel');
  const resizer = $('#devtools-resizer');
  const toggleBtn = $('#devtools-toggle');
  const menuToggleBtn = $('#menu-devtools');
  const closeBtn = $('#devtools-close');
  const tabConsoleBtn = $('#devtools-tab-console');
  const tabNetworkBtn = $('#devtools-tab-network');
  const consoleBadge = $('#devtools-console-badge');
  const networkBadge = $('#devtools-network-badge');
  const consolePane = $('#devtools-console-pane');
  const networkPane = $('#devtools-network-pane');
  const consoleFiltersBar = $('#devtools-console-filters');
  const networkFiltersBar = $('#devtools-network-filters');
  const consoleSearch = $('#devtools-console-search');
  const networkSearch = $('#devtools-network-search');
  const networkFailedOnly = $('#devtools-network-failed');
  const networkTypeFilter = $('#devtools-network-type');
  const clearBtn = $('#devtools-clear');
  const consoleList = $('#devtools-console-list');
  const networkList = $('#devtools-network-list');
  const input = $('#devtools-input');
  const runBtn = $('#devtools-run');

  let open = false;
  let activePane = 'console';
  let subscribedTabId = null;
  let consoleLevel = 'all';
  let consoleQuery = '';
  let networkQuery = '';
  let networkFailed = false;
  let networkType = 'all';
  let consoleEntries = [];
  let networkEntries = [];
  let expandedNetworkId = null;
  let evaluating = false;
  const history = [];
  let historyIdx = -1;
  let historyDraft = '';

  const clampHeight = raw => {
    const main = panel?.parentElement;
    const max = main ? Math.max(MIN_HEIGHT + 40, Math.floor(main.clientHeight * 0.72)) : 520;
    return Math.min(max, Math.max(MIN_HEIGHT, Math.round(raw)));
  };

  const applyHeight = height => {
    if (!panel) return;
    panel.style.height = `${clampHeight(height)}px`;
  };

  let savedHeight = DEFAULT_HEIGHT;
  try {
    const stored = Number(localStorage.getItem('ditto_devtools_height'));
    if (Number.isFinite(stored) && stored >= MIN_HEIGHT) savedHeight = stored;
  } catch { /* ignore */ }
  applyHeight(savedHeight);

  const isNearBottom = el => !el || (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
  const scrollToBottom = el => { if (el) el.scrollTop = el.scrollHeight; };

  const currentValidTab = () => {
    const tab = getSelectedTab();
    if (!tab || tab.optimistic || tab.recordingStatus === 'crashed') return null;
    return tab;
  };

  const updateInputState = () => {
    const tab = currentValidTab();
    const ready = Boolean(isBrowserReady() && tab && tab.url !== 'about:blank');
    if (input) {
      input.disabled = !ready || evaluating;
      input.placeholder = !tab
        ? '请先选择远端标签页…'
        : tab.url === 'about:blank'
          ? '新标签页打开网站后可执行 JavaScript…'
          : '输入 JavaScript 表达式，Enter 执行 / Shift+Enter 换行（支持 await）';
    }
    if (runBtn) {
      runBtn.disabled = !ready || evaluating;
      runBtn.textContent = evaluating ? '执行中…' : '运行';
    }
  };

  const updateBadges = () => {
    const errorCount = consoleEntries.filter(e => e.level === 'error' || e.level === 'pageerror' || e.level === 'assert').length;
    const failedNetCount = networkEntries.filter(e => !e.ok).length;
    if (consoleBadge) {
      consoleBadge.textContent = errorCount > 99 ? '99+' : String(errorCount);
      consoleBadge.hidden = errorCount === 0;
    }
    if (networkBadge) {
      networkBadge.textContent = failedNetCount > 99 ? '99+' : String(failedNetCount);
      networkBadge.hidden = failedNetCount === 0;
    }
  };

  const matchesConsoleFilter = entry => {
    if (consoleLevel === 'error' && !['error', 'pageerror', 'assert'].includes(entry.level)) return false;
    if (consoleLevel === 'warning' && entry.level !== 'warning') return false;
    if (consoleLevel === 'log' && !['log', 'info', 'debug', 'command', 'result'].includes(entry.level)) return false;
    if (consoleQuery) {
      const needle = consoleQuery.toLowerCase();
      const hay = `${entry.text || ''} ${entry.stack || ''} ${entry.location?.url || ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  };

  const buildConsoleRow = entry => {
    const row = element('div', `dt-console-row dt-level-${entry.level || 'log'}`);
    row.dataset.entryId = String(entry.id ?? '');
    const glyphMap = {
      command: '›',
      result: '‹',
      error: '✕',
      pageerror: '✕',
      assert: '✕',
      warning: '!',
      info: 'i',
      debug: '·',
      log: '',
    };
    const glyph = element('span', 'dt-glyph', glyphMap[entry.level] ?? '');
    const time = element('span', 'dt-time', formatTime(entry.time));
    const body = element('div', 'dt-console-content');

    if (entry.level === 'command') {
      body.append(element('code', 'dt-cmd-text', entry.text || ''));
    } else if (entry.level === 'result' && entry.value) {
      body.append(createValueNode(element, entry.value, { quoteStrings: true }));
    } else if (Array.isArray(entry.args) && entry.args.length) {
      const argsWrap = element('div', 'dt-args');
      for (const arg of entry.args) {
        argsWrap.append(createValueNode(element, arg, { quoteStrings: false }));
      }
      body.append(argsWrap);
    } else {
      body.append(element('span', 'dt-text', entry.text || ''));
    }

    if (entry.stack) {
      const details = element('details', 'dt-tree dt-tree-stack');
      details.append(
        element('summary', 'dt-tree-summary', '调用栈'),
        element('pre', 'dt-stack', entry.stack),
      );
      body.append(details);
    }

    row.append(glyph, time, body);
    const locText = shortLocation(entry.location);
    if (locText) {
      const locEl = element('span', 'dt-loc', locText);
      locEl.title = entry.location?.url || locText;
      row.append(locEl);
    }
    return row;
  };

  const renderConsole = (forceScroll = false) => {
    if (!consoleList) return;
    const stick = forceScroll || isNearBottom(consoleList);
    consoleList.replaceChildren();
    const visible = consoleEntries.filter(matchesConsoleFilter);
    if (!visible.length) {
      const emptyText = consoleEntries.length
        ? '没有符合当前筛选条件的日志'
        : '暂无控制台日志；可在下方输入 JS 表达式在当前远端页面执行';
      consoleList.append(element('div', 'dt-empty', emptyText));
    } else {
      const frag = document.createDocumentFragment();
      for (const entry of visible) frag.append(buildConsoleRow(entry));
      consoleList.append(frag);
    }
    updateBadges();
    if (stick) scrollToBottom(consoleList);
  };

  const matchesNetworkFilter = entry => {
    if (networkFailed && entry.ok) return false;
    if (networkType === 'xhr' && !['fetch', 'xhr'].includes(entry.resourceType)) return false;
    if (networkType === 'document' && entry.resourceType !== 'document') return false;
    if (networkType === 'script' && !['script', 'stylesheet'].includes(entry.resourceType)) return false;
    if (networkQuery) {
      const needle = networkQuery.toLowerCase();
      const hay = `${entry.method || ''} ${entry.status || ''} ${entry.url || ''} ${entry.failure || ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  };

  const buildNetworkRow = entry => {
    const wrap = element('div', `dt-net-item${entry.ok ? '' : ' is-failed'}${expandedNetworkId === entry.id ? ' is-expanded' : ''}`);
    const row = element('button', 'dt-net-row');
    row.type = 'button';

    const statusClass = !entry.ok ? 'is-err' : entry.status >= 300 ? 'is-redir' : 'is-ok';
    const statusText = entry.status ? String(entry.status) : 'ERR';
    const statusEl = element('span', `dt-net-status ${statusClass}`, statusText);
    const methodEl = element('span', 'dt-net-method', entry.method || 'GET');
    const urlEl = element('span', 'dt-net-url', shortNetworkPath(entry.url));
    urlEl.title = entry.url || '';
    const typeEl = element('span', 'dt-net-type', entry.resourceType || 'other');
    const sizeEl = element('span', 'dt-net-size', formatSize(entry.size));
    const durEl = element('span', 'dt-net-dur', Number.isFinite(entry.durationMs) ? `${entry.durationMs} ms` : '—');
    row.append(statusEl, methodEl, urlEl, typeEl, sizeEl, durEl);
    row.addEventListener('click', () => {
      expandedNetworkId = expandedNetworkId === entry.id ? null : entry.id;
      renderNetwork(false);
    });
    wrap.append(row);

    if (expandedNetworkId === entry.id) {
      const detail = element('div', 'dt-net-detail');
      const addField = (label, value, extra = null) => {
        const line = element('div', 'dt-net-field');
        line.append(element('span', 'dt-net-field-label', label), element('span', 'dt-net-field-value', value));
        if (extra) line.append(extra);
        detail.append(line);
      };
      const copyBtn = element('button', 'button quiet dt-net-copy', '复制');
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', async event => {
        event.stopPropagation();
        try {
          await copyText(entry.url || '');
          toast('已复制请求地址。');
        } catch (err) {
          toast(err.message);
        }
      });
      addField('URL', entry.url || '—', copyBtn);
      addField('状态', entry.failure ? `${statusText} (${entry.failure})` : `${statusText} · ${entry.method || 'GET'}`);
      addField('类型', entry.contentType ? `${entry.resourceType} (${entry.contentType})` : (entry.resourceType || '—'));
      addField('耗时 / 大小', `${Number.isFinite(entry.durationMs) ? `${entry.durationMs} ms` : '—'} · ${formatSize(entry.size)} · ${formatTime(entry.time)}`);
      wrap.append(detail);
    }
    return wrap;
  };

  const renderNetwork = (forceScroll = false) => {
    if (!networkList) return;
    const stick = forceScroll || isNearBottom(networkList);
    networkList.replaceChildren();
    const visible = networkEntries.filter(matchesNetworkFilter);
    if (!visible.length) {
      const emptyText = networkEntries.length
        ? '没有符合当前筛选条件的请求'
        : '暂无网络请求记录（页面加载或发起 XHR/Fetch 后自动显示）';
      networkList.append(element('div', 'dt-empty', emptyText));
    } else {
      const frag = document.createDocumentFragment();
      for (const entry of visible) frag.append(buildNetworkRow(entry));
      networkList.append(frag);
    }
    updateBadges();
    if (stick) scrollToBottom(networkList);
  };

  const setActivePane = pane => {
    activePane = pane === 'network' ? 'network' : 'console';
    const isConsole = activePane === 'console';
    tabConsoleBtn?.classList.toggle('active', isConsole);
    tabConsoleBtn?.setAttribute('aria-selected', String(isConsole));
    tabNetworkBtn?.classList.toggle('active', !isConsole);
    tabNetworkBtn?.setAttribute('aria-selected', String(!isConsole));
    if (consolePane) consolePane.hidden = !isConsole;
    if (networkPane) networkPane.hidden = isConsole;
    if (consoleFiltersBar) consoleFiltersBar.hidden = !isConsole;
    if (networkFiltersBar) networkFiltersBar.hidden = isConsole;
    if (isConsole) {
      renderConsole(true);
      input?.focus();
    } else {
      renderNetwork(false);
    }
  };

  const syncSubscription = (force = false) => {
    const tab = currentValidTab();
    const desired = open && tab ? tab.id : null;
    if (desired !== subscribedTabId || force) {
      if (desired !== subscribedTabId) {
        consoleEntries = [];
        networkEntries = [];
        expandedNetworkId = null;
        renderConsole(true);
        renderNetwork(false);
      }
      subscribedTabId = desired;
      onSubscribe(desired);
    }
    updateInputState();
  };

  const setOpen = (nextOpen, { focusInput = true } = {}) => {
    const next = Boolean(nextOpen);
    if (open === next) {
      if (open && focusInput && activePane === 'console') input?.focus();
      return;
    }
    open = next;
    if (panel) panel.hidden = !open;
    toggleBtn?.classList.toggle('active', open);
    toggleBtn?.setAttribute('aria-pressed', String(open));
    if (menuToggleBtn) menuToggleBtn.textContent = open ? '关闭控制台' : '打开控制台';
    syncSubscription(open);
    if (open) {
      applyHeight(savedHeight);
      if (activePane === 'console' && focusInput) requestAnimationFrame(() => input?.focus());
    }
    onLayoutChange();
  };

  const upsertConsoleEntry = entry => {
    if (!entry) return;
    const idx = entry.id !== undefined ? consoleEntries.findIndex(e => e.id === entry.id) : -1;
    if (idx >= 0) {
      consoleEntries[idx] = entry;
      if (activePane === 'console' && consoleList) {
        const existingEl = consoleList.querySelector(`[data-entry-id="${entry.id}"]`);
        if (existingEl && matchesConsoleFilter(entry)) {
          existingEl.replaceWith(buildConsoleRow(entry));
          updateBadges();
          return;
        }
      }
      renderConsole(false);
      return;
    }
    consoleEntries.push(entry);
    if (consoleEntries.length > MAX_ENTRIES) consoleEntries.splice(0, consoleEntries.length - MAX_ENTRIES);
    if (activePane === 'console' && consoleList && matchesConsoleFilter(entry)) {
      const stick = isNearBottom(consoleList);
      if (consoleList.querySelector('.dt-empty')) consoleList.replaceChildren();
      consoleList.append(buildConsoleRow(entry));
      while (consoleList.children.length > MAX_ENTRIES) consoleList.firstElementChild?.remove();
      updateBadges();
      if (stick) scrollToBottom(consoleList);
    } else {
      updateBadges();
    }
  };

  const appendNetworkEntry = entry => {
    if (!entry) return;
    if (entry.id !== undefined && networkEntries.some(e => e.id === entry.id)) return;
    networkEntries.push(entry);
    if (networkEntries.length > MAX_ENTRIES) networkEntries.splice(0, networkEntries.length - MAX_ENTRIES);
    if (activePane === 'network') renderNetwork(false);
    else updateBadges();
  };

  const autoSizeInput = () => {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(110, Math.max(24, input.scrollHeight))}px`;
  };

  const submitEval = async () => {
    const tab = currentValidTab();
    if (!tab || !input || evaluating) return;
    const code = input.value.trim();
    if (!code) return;
    if (history[history.length - 1] !== code) {
      history.push(code);
      if (history.length > MAX_HISTORY) history.shift();
    }
    historyIdx = -1;
    historyDraft = '';
    input.value = '';
    autoSizeInput();
    evaluating = true;
    updateInputState();
    try {
      const res = await api(`/api/tabs/${encodeURIComponent(tab.id)}/eval`, {
        method: 'POST',
        body: JSON.stringify({ expression: code }),
      });
      if (res?.entry && subscribedTabId === tab.id) {
        upsertConsoleEntry(res.entry);
        scrollToBottom(consoleList);
      }
    } catch (error) {
      toast(error.message);
    } finally {
      evaluating = false;
      updateInputState();
      if (open && activePane === 'console') input?.focus();
    }
  };

  toggleBtn?.addEventListener('click', () => setOpen(!open));
  menuToggleBtn?.addEventListener('click', () => {
    const menu = $('.browser-menu');
    if (menu) menu.open = false;
    setOpen(!open);
  });
  closeBtn?.addEventListener('click', () => setOpen(false));
  tabConsoleBtn?.addEventListener('click', () => setActivePane('console'));
  tabNetworkBtn?.addEventListener('click', () => setActivePane('network'));

  for (const btn of document.querySelectorAll('#devtools-level-filter .dt-filter-btn')) {
    btn.addEventListener('click', () => {
      consoleLevel = btn.dataset.level || 'all';
      for (const b of document.querySelectorAll('#devtools-level-filter .dt-filter-btn')) {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      }
      renderConsole(false);
    });
  }

  consoleSearch?.addEventListener('input', () => {
    consoleQuery = consoleSearch.value.trim();
    renderConsole(false);
  });
  networkSearch?.addEventListener('input', () => {
    networkQuery = networkSearch.value.trim();
    renderNetwork(false);
  });
  networkFailedOnly?.addEventListener('change', () => {
    networkFailed = Boolean(networkFailedOnly.checked);
    renderNetwork(false);
  });
  networkTypeFilter?.addEventListener('change', () => {
    networkType = networkTypeFilter.value || 'all';
    renderNetwork(false);
  });

  clearBtn?.addEventListener('click', () => {
    if (!subscribedTabId) return;
    const target = activePane === 'network' ? 'network' : 'console';
    if (target === 'console') {
      consoleEntries = [];
      renderConsole(true);
    } else {
      networkEntries = [];
      expandedNetworkId = null;
      renderNetwork(false);
    }
    onClear(subscribedTabId, target);
  });

  runBtn?.addEventListener('click', submitEval);
  input?.addEventListener('input', autoSizeInput);
  input?.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitEval();
      return;
    }
    if ((event.metaKey && event.key.toLowerCase() === 'k') || (event.ctrlKey && event.key.toLowerCase() === 'l')) {
      event.preventDefault();
      clearBtn?.click();
      return;
    }
    if (event.key === 'ArrowUp' && history.length) {
      const beforeCaret = input.value.slice(0, input.selectionStart || 0);
      if (!beforeCaret.includes('\n')) {
        event.preventDefault();
        if (historyIdx === -1) {
          historyDraft = input.value;
          historyIdx = history.length - 1;
        } else if (historyIdx > 0) {
          historyIdx--;
        }
        input.value = history[historyIdx] || '';
        autoSizeInput();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    } else if (event.key === 'ArrowDown' && historyIdx !== -1) {
      const afterCaret = input.value.slice(input.selectionEnd || 0);
      if (!afterCaret.includes('\n')) {
        event.preventDefault();
        if (historyIdx < history.length - 1) {
          historyIdx++;
          input.value = history[historyIdx] || '';
        } else {
          historyIdx = -1;
          input.value = historyDraft;
        }
        autoSizeInput();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  });

  if (resizer && panel) {
    let dragging = false;
    let startY = 0;
    let startHeight = DEFAULT_HEIGHT;
    resizer.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      dragging = true;
      startY = event.clientY;
      startHeight = panel.getBoundingClientRect().height || savedHeight;
      resizer.classList.add('dragging');
      resizer.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    resizer.addEventListener('pointermove', event => {
      if (!dragging) return;
      const next = clampHeight(startHeight + (startY - event.clientY));
      savedHeight = next;
      panel.style.height = `${next}px`;
    });
    const finishDrag = event => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      try { resizer.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
      try { localStorage.setItem('ditto_devtools_height', String(savedHeight)); } catch { /* ignore */ }
      onLayoutChange();
    };
    resizer.addEventListener('pointerup', finishDrag);
    resizer.addEventListener('pointercancel', finishDrag);
  }

  return {
    isOpen: () => open,
    isFocused: () => Boolean(panel && !panel.hidden && panel.contains(document.activeElement)),
    setOpen,
    toggle: () => setOpen(!open),
    syncTab: (force = false) => syncSubscription(force),
    handleSnapshot(data) {
      if (!open || !data || data.tabId !== subscribedTabId) return;
      consoleEntries = Array.isArray(data.console) ? data.console.slice(-MAX_ENTRIES) : [];
      networkEntries = Array.isArray(data.network) ? data.network.slice(-MAX_ENTRIES) : [];
      expandedNetworkId = null;
      renderConsole(true);
      renderNetwork(false);
    },
    handleEvent(data) {
      if (!open || !data || data.tabId !== subscribedTabId) return;
      if (data.kind === 'console' || data.kind === 'console-update') {
        upsertConsoleEntry(data.entry);
      } else if (data.kind === 'network') {
        appendNetworkEntry(data.entry);
      }
    },
    handleCleared(data) {
      if (!data || data.tabId !== subscribedTabId) return;
      if (data.target === 'console' || data.target === 'all') {
        consoleEntries = [];
        renderConsole(true);
      }
      if (data.target === 'network' || data.target === 'all') {
        networkEntries = [];
        expandedNetworkId = null;
        renderNetwork(false);
      }
    },
    reset() {
      setOpen(false, { focusInput: false });
      subscribedTabId = null;
      consoleEntries = [];
      networkEntries = [];
      expandedNetworkId = null;
    },
  };
}
