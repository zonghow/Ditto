import { computeAdaptiveLayout } from './overview-layout.js';
import { tabDomain } from './tab-strip.js';

export function createOverview({
  $,
  element,
  createAgentIcon,
  LiveReplay,
  recordings,
  getMainPlayer,
  selectTab,
  setViewMode,
  browserAction,
}) {
  const thumbnails = new Map();
  const thumbnailPlayers = new Map();
  const tabStates = new Map();
  const visibleIds = new Set();
  let overviewAdaptive = true;
  let lastOverviewLayout = null;
  let active = false;

  const grid = $('#tab-overview');

  function isNonRenderableTab(tab) {
    return Boolean(tab && (tab.url === 'about:blank' || tab.recordingStatus === 'crashed'));
  }

  function syncPlaceholder(thumbnail, tab) {
    const placeholder = thumbnail?.querySelector('.thumbnail-placeholder');
    if (!placeholder) return;
    const isBlank = tab?.url === 'about:blank';
    const isCrashed = tab?.recordingStatus === 'crashed';
    const mode = isBlank ? 'blank' : isCrashed ? 'crashed' : 'loading';
    if (placeholder.dataset.mode === mode) return;
    placeholder.dataset.mode = mode;
    if (isBlank) {
      placeholder.replaceChildren(
        element('span', 'thumbnail-placeholder-icon', '◇'),
        element('span', 'thumbnail-placeholder-text', '新标签页'),
      );
    } else if (isCrashed) {
      placeholder.replaceChildren(
        element('span', 'thumbnail-placeholder-icon', '⚠'),
        element('span', 'thumbnail-placeholder-text', '标签页已崩溃'),
      );
    } else {
      placeholder.replaceChildren(element('span', 'thumbnail-placeholder-icon', '◫'));
    }
  }

  function mountPlayer(tabId) {
    if (!active) return;
    const thumbnail = thumbnails.get(tabId);
    const tab = tabStates.get(tabId);
    if (!thumbnail) return;
    if (isNonRenderableTab(tab)) {
      unmountPlayer(tabId);
      return;
    }
    const recording = recordings.get(tabId);
    if (!recording) return;
    const existing = thumbnailPlayers.get(tabId);
    if (existing) {
      if (existing.documentId === recording.documentId) existing.checkpoint(recording);
      else {
        existing.destroy();
        thumbnailPlayers.set(tabId, new LiveReplay(thumbnail.querySelector('.thumbnail-replay'), recording, { thumbnail: true }));
      }
    } else {
      thumbnailPlayers.set(tabId, new LiveReplay(thumbnail.querySelector('.thumbnail-replay'), recording, { thumbnail: true }));
    }
    const placeholder = thumbnail.querySelector('.thumbnail-placeholder');
    if (placeholder) placeholder.hidden = true;
  }

  function unmountPlayer(tabId) {
    const player = thumbnailPlayers.get(tabId);
    if (player) {
      player.destroy();
      thumbnailPlayers.delete(tabId);
    }
    const placeholder = thumbnails.get(tabId)?.querySelector('.thumbnail-placeholder');
    if (placeholder) placeholder.hidden = false;
  }

  const observer = typeof IntersectionObserver === 'function' && grid
    ? new IntersectionObserver(entries => {
      if (!active) return;
      for (const entry of entries) {
        const tabId = entry.target?.dataset?.tabId;
        if (!tabId) continue;
        if (entry.isIntersecting) {
          visibleIds.add(tabId);
          if (!thumbnailPlayers.has(tabId)) mountPlayer(tabId);
        } else {
          visibleIds.delete(tabId);
          unmountPlayer(tabId);
        }
      }
    }, { root: grid, rootMargin: '120px 0px', threshold: 0.01 })
    : null;

  function updateLayout(force = false) {
    if (!grid) return;
    const cards = [...grid.children];
    if (!overviewAdaptive) {
      grid.classList.remove('adaptive', 'adaptive-scroll');
      grid.style.gridTemplateColumns = '';
      grid.style.gridTemplateRows = '';
      grid.style.gridAutoRows = '';
      for (const card of cards) card.style.gridColumn = '';
      lastOverviewLayout = null;
      requestAnimationFrame(() => { for (const player of thumbnailPlayers.values()) player.fit(); });
      return;
    }
    grid.classList.add('adaptive');
    if ($('#overview')?.hidden) return;
    const width = grid.clientWidth;
    const height = grid.clientHeight;
    if (!width || !height) return;
    if (!force && lastOverviewLayout && lastOverviewLayout.adaptive === overviewAdaptive &&
      lastOverviewLayout.count === cards.length &&
      Math.abs(lastOverviewLayout.width - width) <= 2 &&
      Math.abs(lastOverviewLayout.height - height) <= 2) {
      return;
    }
    lastOverviewLayout = { count: cards.length, width, height, adaptive: overviewAdaptive };
    const compact = window.innerWidth <= 520;
    let aspect = 16 / 10;
    for (const player of thumbnailPlayers.values()) {
      if (player.width && player.height) { aspect = player.width / player.height; break; }
    }
    const mainPlayer = getMainPlayer();
    if (aspect === 16 / 10 && mainPlayer?.width && mainPlayer?.height) {
      aspect = mainPlayer.width / mainPlayer.height;
    }
    const layout = computeAdaptiveLayout(cards.length, width, height, {
      gap: compact ? 8 : 10,
      footerHeight: 34,
      aspect,
      minCardWidth: compact ? 145 : 185,
      minRowHeight: compact ? 120 : 135,
    });
    grid.style.gridTemplateColumns = `repeat(${layout.totalCols}, minmax(0, 1fr))`;
    if (layout.scrollable) {
      grid.classList.add('adaptive-scroll');
      grid.style.gridTemplateRows = '';
      grid.style.gridAutoRows = `${layout.rowHeight}px`;
    } else {
      grid.classList.remove('adaptive-scroll');
      grid.style.gridTemplateRows = `repeat(${layout.rows}, minmax(0, 1fr))`;
      grid.style.gridAutoRows = '';
    }
    cards.forEach((card, index) => {
      const span = layout.spans[index] || 1;
      card.style.gridColumn = span > 1 ? `span ${span}` : '';
    });
    requestAnimationFrame(() => { for (const player of thumbnailPlayers.values()) player.fit(); });
  }

  function applyAdaptive(enabled, persist = false) {
    overviewAdaptive = Boolean(enabled);
    const toggle = $('#overview-adaptive');
    if (toggle) toggle.checked = overviewAdaptive;
    if (persist) {
      try { localStorage.setItem('ditto_overview_adaptive', overviewAdaptive ? '1' : '0'); } catch { /* ignore */ }
    }
    updateLayout(true);
  }

  if ($('#overview-adaptive')) {
    let savedAdaptive = true;
    try { savedAdaptive = localStorage.getItem('ditto_overview_adaptive') !== '0'; } catch { /* ignore */ }
    applyAdaptive(savedAdaptive);
    $('#overview-adaptive').addEventListener('change', event => applyAdaptive(event.target.checked, true));
  }
  if (grid) {
    new ResizeObserver(() => {
      if (!$('#overview')?.hidden && overviewAdaptive) updateLayout(false);
    }).observe(grid);
  }

  function renderThumbnails(tabs) {
    const ids = new Set(tabs.map(tab => tab.id));
    for (const [id, node] of thumbnails) {
      if (!ids.has(id)) {
        observer?.unobserve(node);
        node.remove();
        thumbnails.delete(id);
        tabStates.delete(id);
        visibleIds.delete(id);
        thumbnailPlayers.get(id)?.destroy();
        thumbnailPlayers.delete(id);
      }
    }
    tabs.forEach((tab, index) => {
      tabStates.set(tab.id, tab);
      let thumbnail = thumbnails.get(tab.id);
      if (!thumbnail) {
        thumbnail = element('div', 'thumbnail');
        thumbnail.dataset.tabId = tab.id;
        const card = element('button', 'thumbnail-main');
        card.type = 'button';
        const imageBox = element('div', 'thumbnail-image');
        const replay = element('div', 'thumbnail-replay');
        const badge = element('span', 'thumbnail-badge');
        badge.hidden = true;
        imageBox.append(replay, element('span', 'thumbnail-placeholder'), badge);
        const info = element('div', 'thumbnail-info');
        info.append(element('span', 'tab-title'), element('span', 'tab-domain'));
        card.append(imageBox, info);
        card.addEventListener('click', () => {
          selectTab(tab.id);
          setViewMode('browser');
        });
        const closeBtn = element('button', 'thumbnail-close', '×');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', '关闭标签页');
        closeBtn.title = '关闭标签页';
        closeBtn.addEventListener('click', event => {
          event.stopPropagation();
          browserAction('close', { tabId: tab.id });
        });
        thumbnail.append(card, closeBtn);
        thumbnails.set(tab.id, thumbnail);
        grid.append(thumbnail);
        if (active) {
          if (observer) observer.observe(thumbnail);
          else { visibleIds.add(tab.id); mountPlayer(tab.id); }
        }
      }
      const agent = tab.agent || null;
      const blank = tab.url === 'about:blank';
      thumbnail.classList.toggle('is-blank', blank);
      thumbnail.classList.toggle('is-crashed', tab.recordingStatus === 'crashed');
      thumbnail.classList.toggle('has-agent', Boolean(agent));
      thumbnail.classList.toggle('agent-active', Boolean(agent?.active));
      if (agent?.color) thumbnail.style.setProperty('--agent-color', agent.color);
      else thumbnail.style.removeProperty('--agent-color');
      syncPlaceholder(thumbnail, tab);
      if (isNonRenderableTab(tab)) {
        if (thumbnailPlayers.has(tab.id)) unmountPlayer(tab.id);
      } else if (active && (!observer || visibleIds.has(tab.id)) && !thumbnailPlayers.has(tab.id) && recordings.get(tab.id)) {
        mountPlayer(tab.id);
      }
      const thumbBadge = thumbnail.querySelector('.thumbnail-badge');
      if (agent) {
        thumbBadge.hidden = false;
        thumbBadge.replaceChildren(createAgentIcon(agent.agent));
        thumbBadge.append(element('span', '', `${agent.label}${agent.active && agent.action ? ` · ${agent.action}` : ''}`));
      } else {
        thumbBadge.hidden = true;
        thumbBadge.replaceChildren();
      }
      thumbnail.querySelector('.tab-title').textContent = blank ? '新标签页' : tab.title;
      thumbnail.querySelector('.tab-domain').textContent = blank ? 'about:blank' : tabDomain(tab.url);
      const previewPosition = grid.children[index];
      if (previewPosition !== thumbnail) grid.insertBefore(thumbnail, previewPosition || null);
    });
  }

  function setSelected(id) {
    for (const [key, item] of thumbnails) item.classList.toggle('selected', key === id);
  }

  function enterOverview() {
    active = true;
    visibleIds.clear();
    updateLayout(true);
    if (observer) {
      observer.disconnect();
      for (const node of thumbnails.values()) observer.observe(node);
    } else {
      for (const id of thumbnails.keys()) {
        visibleIds.add(id);
        mountPlayer(id);
      }
    }
  }

  function leaveOverview() {
    active = false;
    observer?.disconnect();
    visibleIds.clear();
    for (const id of [...thumbnailPlayers.keys()]) unmountPlayer(id);
  }

  function handleRecording(kind, data) {
    if (kind === 'reset') {
      unmountPlayer(data.tabId);
      return;
    }
    if (!active) return;
    if (kind === 'snapshot') {
      if (!observer || visibleIds.has(data.tabId)) mountPlayer(data.tabId);
    } else {
      thumbnailPlayers.get(data.tabId)?.add(data);
    }
  }

  function refreshAsset(id) {
    for (const player of thumbnailPlayers.values()) player.refreshAsset(id);
  }

  function refreshAssets(ids) {
    for (const player of thumbnailPlayers.values()) player.refreshAssets(ids);
  }

  function clear() {
    leaveOverview();
    grid?.replaceChildren();
    thumbnails.clear();
    tabStates.clear();
    lastOverviewLayout = null;
  }

  return {
    renderThumbnails,
    setSelected,
    updateLayout,
    enterOverview,
    leaveOverview,
    handleRecording,
    refreshAsset,
    refreshAssets,
    clear,
  };
}
