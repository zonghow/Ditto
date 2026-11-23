import { reopenUrl } from './tab-url.js';
import { createHistoryIcon } from './icons.js';

function displaySuggestionUrl(rawUrl) {
  return String(rawUrl || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function defaultSchemeFor(value) {
  const host = value.split(/[/?#]/)[0].toLowerCase();
  if (/^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])(?::\d+)?$/.test(host)) {
    return 'http://';
  }
  return 'https://';
}

function normalizeAddressInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[\w.-]+:\d/.test(value)) return value;
  return `${defaultSchemeFor(value)}${value}`;
}

export function createAddressBar({
  api,
  element,
  onNavigate,
  onOpenNewTab = () => {},
  onError,
  getSelectedTab,
  getPendingUrl = () => null,
}) {
  const $ = selector => document.querySelector(selector);
  const drafts = new Map();
  let suggestionItems = [];
  let suggestionActive = -1;
  let suggestionTyped = '';
  let suggestionTimer = null;
  let suggestionSeq = 0;
  let preserveSelectionOnMouseUp = false;
  let openInNewTabSubmit = false;

  function appendHighlightedText(container, text, tokens) {
    const value = String(text || '');
    if (!tokens.length || !value) {
      container.textContent = value;
      return;
    }
    const lower = value.toLowerCase();
    const ranges = [];
    for (const token of tokens) {
      if (!token) continue;
      let pos = 0;
      while ((pos = lower.indexOf(token, pos)) !== -1) {
        ranges.push([pos, pos + token.length]);
        pos += token.length;
      }
    }
    if (!ranges.length) {
      container.textContent = value;
      return;
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const [start, end] of ranges) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) container.append(document.createTextNode(value.slice(cursor, start)));
      container.append(element('strong', 'suggestion-match', value.slice(start, end)));
      cursor = end;
    }
    if (cursor < value.length) container.append(document.createTextNode(value.slice(cursor)));
  }

  function closeSuggestions() {
    clearTimeout(suggestionTimer);
    suggestionSeq++;
    suggestionItems = [];
    suggestionActive = -1;
    const box = $('#address-suggestions');
    if (box) {
      box.hidden = true;
      box.replaceChildren();
    }
    $('#address-bar')?.setAttribute('aria-expanded', 'false');
  }

  function highlightSuggestion(index) {
    const box = $('#address-suggestions');
    if (!box || box.hidden) return;
    const rows = box.querySelectorAll('.suggestion-item');
    if (!rows.length) { suggestionActive = -1; return; }
    if (index < -1) index = rows.length - 1;
    if (index >= rows.length) index = -1;
    suggestionActive = index;
    rows.forEach((row, i) => {
      const active = i === suggestionActive;
      row.classList.toggle('active', active);
      row.setAttribute('aria-selected', String(active));
      if (active) row.scrollIntoView({ block: 'nearest' });
    });
    $('#address-bar').value = suggestionActive >= 0 ? suggestionItems[suggestionActive].url : suggestionTyped;
  }

  function renderSuggestions(items, query) {
    const box = $('#address-suggestions');
    if (!box) return;
    suggestionItems = items;
    suggestionActive = -1;
    box.replaceChildren();
    if (!items.length || document.activeElement !== $('#address-bar')) {
      box.hidden = true;
      $('#address-bar')?.setAttribute('aria-expanded', 'false');
      return;
    }
    const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    items.forEach(item => {
      const row = element('div', 'suggestion-item');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.dataset.url = item.url;
      row.title = `${item.title}\n${item.url}`;

      const icon = element('span', 'suggestion-icon');
      icon.append(createHistoryIcon());
      const line = element('span', 'suggestion-line');
      const cleanUrl = displaySuggestionUrl(item.url);
      const hasDistinctTitle = item.title && item.title !== item.url && item.title !== cleanUrl;
      if (hasDistinctTitle) {
        const titleNode = element('span', 'suggestion-title');
        appendHighlightedText(titleNode, item.title, tokens);
        line.append(titleNode, element('span', 'suggestion-sep', '-'));
      }
      const urlNode = element('span', 'suggestion-url');
      appendHighlightedText(urlNode, cleanUrl, tokens);
      line.append(urlNode);

      row.append(icon, line);
      if (item.removable !== false) {
        const remove = element('button', 'suggestion-remove', '×');
        remove.type = 'button';
        remove.title = '从历史记录中移除';
        remove.setAttribute('aria-label', '从历史记录中移除');
        remove.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
        remove.addEventListener('click', async event => {
          event.preventDefault();
          event.stopPropagation();
          try {
            await api('/api/history', { method: 'DELETE', body: JSON.stringify({ url: item.url }) });
          } catch { /* ignore */ }
          renderSuggestions(suggestionItems.filter(entry => entry.url !== item.url), suggestionTyped);
        });
        row.append(remove);
      }

      row.addEventListener('pointerdown', event => event.preventDefault());
      const pick = inNewTab => {
        closeSuggestions();
        const tab = getSelectedTab();
        if (tab) drafts.delete(tab.id);
        $('#address-bar').blur();
        if (inNewTab) {
          onOpenNewTab(item.url);
        } else {
          $('#address-bar').value = item.url;
          onNavigate(item.url);
        }
      };
      row.addEventListener('click', event => pick(event.metaKey || event.ctrlKey || event.altKey));
      row.addEventListener('auxclick', event => {
        if (event.button === 1) { event.preventDefault(); pick(true); }
      });
      box.append(row);
    });
    box.hidden = false;
    $('#address-bar')?.setAttribute('aria-expanded', 'true');
  }

  function requestSuggestions(query, immediate = false) {
    clearTimeout(suggestionTimer);
    const trimmed = String(query || '');
    suggestionTyped = trimmed;
    const seq = ++suggestionSeq;
    const run = async () => {
      try {
        const result = await api(`/api/history?q=${encodeURIComponent(trimmed.trim())}&limit=8`);
        if (seq !== suggestionSeq || document.activeElement !== $('#address-bar')) return;
        renderSuggestions(result.items || [], trimmed);
      } catch {
        if (seq === suggestionSeq) closeSuggestions();
      }
    };
    if (immediate) run();
    else suggestionTimer = setTimeout(run, 60);
  }

  function clearDraft(tabId) {
    if (tabId) drafts.delete(tabId);
    else drafts.clear();
  }

  function migrateDraft(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    if (drafts.has(fromId)) {
      drafts.set(toId, drafts.get(fromId));
      drafts.delete(fromId);
    }
  }

  function pruneDrafts(validIds) {
    for (const id of drafts.keys()) {
      if (!validIds.has(id)) drafts.delete(id);
    }
  }

  function update(force = false) {
    const tab = getSelectedTab();
    const pendingUrl = tab ? getPendingUrl(tab.id) : null;
    const displayUrl = pendingUrl || (tab?.url === 'about:blank' ? '' : tab?.url || '');
    if (force || document.activeElement !== $('#address-bar')) {
      const draft = tab && drafts.has(tab.id) ? drafts.get(tab.id) : null;
      $('#address-bar').value = draft !== null ? draft : displayUrl;
    }
    const effective = pendingUrl || tab?.url || '';
    $('#address-icon').textContent = effective.startsWith('https:') ? '◇' : '◉';
  }

  $('#address-bar').addEventListener('focus', event => {
    preserveSelectionOnMouseUp = true;
    event.target.select();
    if (!event.target.value.trim()) requestSuggestions('', true);
  });
  $('#address-bar').addEventListener('mouseup', event => {
    if (preserveSelectionOnMouseUp) {
      preserveSelectionOnMouseUp = false;
      event.preventDefault();
    }
  });
  $('#address-bar').addEventListener('input', event => {
    preserveSelectionOnMouseUp = false;
    const tab = getSelectedTab();
    if (tab) drafts.set(tab.id, event.target.value);
    requestSuggestions(event.target.value);
  });
  $('#address-bar').addEventListener('blur', () => {
    preserveSelectionOnMouseUp = false;
    closeSuggestions();
  });
  $('#address-bar').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if ($('#address-suggestions')?.hidden) requestSuggestions($('#address-bar').value, true);
      else highlightSuggestion(suggestionActive + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      if (!$('#address-suggestions')?.hidden && suggestionItems.length) {
        event.preventDefault();
        highlightSuggestion(suggestionActive - 1);
      }
      return;
    }
    if (event.key === 'Enter' && (event.altKey || event.metaKey || event.ctrlKey)) {
      openInNewTabSubmit = true;
      return;
    }
    if (event.key === 'Escape') {
      if (!$('#address-suggestions')?.hidden) {
        event.preventDefault();
        $('#address-bar').value = suggestionTyped;
        closeSuggestions();
        return;
      }
      const tab = getSelectedTab();
      if (tab) drafts.delete(tab.id);
      update(true);
      event.target.blur();
    }
  });
  $('#address-form').addEventListener('submit', async event => {
    event.preventDefault();
    const inNewTab = openInNewTabSubmit;
    openInNewTabSubmit = false;
    try {
      const picked = suggestionActive >= 0 ? suggestionItems[suggestionActive]?.url : null;
      const value = (picked || $('#address-bar').value).trim();
      closeSuggestions();
      if (!value) return;
      const url = normalizeAddressInput(value);
      if (url !== 'about:blank' && !reopenUrl(url)) throw new Error('请输入 HTTP/HTTPS 地址；不允许 javascript:、文件或浏览器内部地址。');
      const tab = getSelectedTab();
      if (tab) drafts.delete(tab.id);
      $('#address-bar').blur();
      if (inNewTab) {
        update(true);
        await onOpenNewTab(url);
      } else {
        $('#address-bar').value = url === 'about:blank' ? '' : url;
        await onNavigate(url);
      }
    } catch (error) { onError(error.message); }
  });

  return { update, closeSuggestions, clearDraft, migrateDraft, pruneDrafts };
}
