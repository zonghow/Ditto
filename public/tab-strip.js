export function tabDomain(url) {
  try { return new URL(url).host || url; } catch { return url; }
}

function faviconAssetId(src) {
  if (typeof src !== 'string' || !src.startsWith('/api/assets/')) return null;
  const id = src.slice('/api/assets/'.length).split(/[?#]/)[0];
  return /^[a-f0-9]{36}$/.test(id) ? id : null;
}

export function createTabStrip({
  $,
  element,
  createAgentIcon,
  getState,
  getTabs = null,
  getSelected,
  isTabLoading,
  isClosingTab,
  selectTab,
  browserAction,
  newTab,
  applyTabLayout,
}) {
  const currentTabs = () => (getTabs ? getTabs() : (getState()?.browser.tabs || []));
  const tabElements = new Map();
  const failedFavicons = new Set();
  const faviconVersions = new Map();
  let contextMenuTabId = null;

  function isVerticalTabLayout() {
    return Boolean($('.browser-shell')?.classList.contains('vertical-tabs') && window.innerWidth > 680);
  }

  function closeContextMenu() {
    const menu = $('#tab-context-menu');
    if (menu) menu.hidden = true;
    if (contextMenuTabId) {
      tabElements.get(contextMenuTabId)?.classList.remove('context-open');
      contextMenuTabId = null;
    }
  }

  function syncContextMenuState() {
    const menu = $('#tab-context-menu');
    if (!menu || menu.hidden || !contextMenuTabId) return;
    const state = getState();
    const tabs = currentTabs();
    const idx = tabs.findIndex(item => item.id === contextMenuTabId);
    if (idx < 0) {
      closeContextMenu();
      return;
    }
    const vertical = isVerticalTabLayout();
    const canToggleLayout = window.innerWidth > 680;
    const disabled = !state?.browser.ready || state?.browser.importing;
    $('#ctx-new-adjacent').textContent = vertical ? '在下方新增标签页' : '在右侧新增标签页';
    $('#ctx-toggle-layout').textContent = vertical ? '水平显示标签页' : '垂直显示标签页';
    $('#ctx-close-after').textContent = vertical ? '关闭下方标签页' : '关闭右侧标签页';
    $('#ctx-layout-divider').hidden = !canToggleLayout;
    $('#ctx-toggle-layout').hidden = !canToggleLayout;
    $('#ctx-new-adjacent').disabled = disabled;
    $('#ctx-reload').disabled = disabled;
    $('#ctx-duplicate').disabled = disabled;
    $('#ctx-close').disabled = disabled || isClosingTab(contextMenuTabId);
    $('#ctx-close-others').disabled = disabled || tabs.length <= 1;
    $('#ctx-close-after').disabled = disabled || idx >= tabs.length - 1;
  }

  function openContextMenu(tabId, clientX, clientY) {
    const menu = $('#tab-context-menu');
    if (!menu) return;
    if (contextMenuTabId && contextMenuTabId !== tabId) {
      tabElements.get(contextMenuTabId)?.classList.remove('context-open');
    }
    contextMenuTabId = tabId;
    tabElements.get(tabId)?.classList.add('context-open');
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.hidden = false;
    syncContextMenuState();
    if (menu.hidden) return;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function renderTabIcon(wrapper, tab) {
    const iconBox = wrapper?.querySelector('.tab-icon');
    if (!iconBox || !tab) return;
    const loading = isTabLoading(tab.id, tab);
    iconBox.classList.toggle('loading', loading);
    if (loading) {
      iconBox.classList.remove('has-favicon');
      delete iconBox.dataset.faviconSrc;
      iconBox.replaceChildren();
      return;
    }
    const rawFavicon = tab.favicon && !failedFavicons.has(tab.favicon) ? tab.favicon : null;
    if (rawFavicon) {
      const assetId = faviconAssetId(rawFavicon);
      const version = assetId ? faviconVersions.get(assetId) : null;
      const src = version ? `${rawFavicon}?ready=${version}` : rawFavicon;
      if (iconBox.classList.contains('has-favicon') && iconBox.dataset.faviconSrc === src) return;
      iconBox.classList.add('has-favicon');
      iconBox.dataset.faviconSrc = src;
      const img = document.createElement('img');
      img.className = 'tab-favicon';
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.addEventListener('error', () => {
        failedFavicons.add(rawFavicon);
        if (iconBox.dataset.faviconSrc === src) {
          const latest = currentTabs().find(item => item.id === tab.id) || tab;
          renderTabIcon(wrapper, latest);
        }
      }, { once: true });
      img.src = src;
      iconBox.replaceChildren(img);
      return;
    }
    iconBox.classList.remove('has-favicon');
    delete iconBox.dataset.faviconSrc;
    iconBox.replaceChildren();
    if (tab.agent) iconBox.append(createAgentIcon(tab.agent.agent));
    else iconBox.textContent = tab.url === 'about:blank' ? '◇' : (tabDomain(tab.url)?.[0] || '◫').toUpperCase();
  }

  function refreshFavicons(ids) {
    const valid = (ids || []).filter(id => /^[a-f0-9]{36}$/.test(id));
    if (!valid.length) return;
    const version = Date.now();
    const idSet = new Set(valid);
    for (const id of valid) {
      faviconVersions.set(id, version);
      failedFavicons.delete(`/api/assets/${id}`);
    }
    for (const tab of currentTabs()) {
      const id = faviconAssetId(tab.favicon);
      if (id && idSet.has(id)) {
        const wrapper = tabElements.get(tab.id);
        if (wrapper) renderTabIcon(wrapper, tab);
      }
    }
  }

  function syncSpinner(tabId) {
    const wrapper = tabElements.get(tabId);
    const tab = currentTabs().find(item => item.id === tabId);
    if (wrapper && tab) renderTabIcon(wrapper, tab);
  }

  function setSelected(id) {
    for (const [key, node] of tabElements) {
      node.classList.toggle('selected', key === id);
      node.querySelector('.tab-button')?.setAttribute('aria-selected', String(key === id));
    }
  }

  function scrollSelectedIntoView(id) {
    if ($('.browser-shell')?.classList.contains('vertical-tabs')) {
      tabElements.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function renderTabs(tabs, activeTabId, onRemoveTab) {
    const ids = new Set(tabs.map(tab => tab.id));
    const selected = getSelected();
    for (const [id, node] of tabElements) {
      if (!ids.has(id)) {
        node.remove();
        tabElements.delete(id);
        onRemoveTab?.(id);
      }
    }
    const list = $('#tab-list');
    tabs.forEach((tab, index) => {
      let wrapper = tabElements.get(tab.id);
      if (!wrapper) {
        wrapper = element('div', 'browser-tab');
        wrapper.dataset.tabId = tab.id;
        const button = element('button', 'tab-button');
        button.type = 'button';
        button.setAttribute('role', 'tab');
        button.dataset.tabId = tab.id;
        button.append(element('span', 'tab-icon'), element('span', 'tab-title'), element('span', 'tab-activity-pill'));
        button.addEventListener('click', () => selectTab(wrapper.dataset.tabId));
        const close = element('button', 'tab-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', '关闭标签页');
        close.title = '关闭标签页';
        close.addEventListener('click', event => { event.stopPropagation(); browserAction('close', { tabId: wrapper.dataset.tabId }); });
        wrapper.append(button, close);
        wrapper.addEventListener('auxclick', event => {
          if (event.button === 1) { event.preventDefault(); browserAction('close', { tabId: wrapper.dataset.tabId }); }
        });
        wrapper.addEventListener('contextmenu', event => {
          event.preventDefault();
          openContextMenu(wrapper.dataset.tabId, event.clientX, event.clientY);
        });
        tabElements.set(tab.id, wrapper);
      }
      const agent = tab.agent || null;
      wrapper.classList.toggle('has-agent', Boolean(agent));
      wrapper.classList.toggle('agent-active', Boolean(agent?.active));
      if (agent?.color) wrapper.style.setProperty('--agent-color', agent.color);
      else wrapper.style.removeProperty('--agent-color');

      renderTabIcon(wrapper, tab);

      wrapper.querySelector('.tab-title').textContent = tab.url === 'about:blank' ? '新标签页' : tab.title;
      const pill = wrapper.querySelector('.tab-activity-pill');
      if (agent?.active && agent.action) {
        pill.hidden = false;
        pill.textContent = agent.action;
      } else {
        pill.hidden = true;
        pill.textContent = '';
      }
      const agentHeader = agent
        ? `${agent.label}${agent.workspace ? ` (${agent.workspace})` : ''}${agent.active && agent.action ? ` · ${agent.action}` : ''}\n`
        : '';
      const tabTooltip = `${agentHeader}${tab.title}\n${tab.url}`;
      wrapper.title = tabTooltip;
      wrapper.querySelector('.tab-button').title = tabTooltip;
      wrapper.querySelector('.tab-button').setAttribute('aria-selected', String(tab.id === selected));
      wrapper.classList.toggle('remote-active', tab.id === activeTabId);
      const position = list.children[index];
      if (position !== wrapper) list.insertBefore(wrapper, position || null);
    });
  }

  function migrateTabId(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    if (contextMenuTabId === fromId) contextMenuTabId = toId;
    const wrapper = tabElements.get(fromId);
    if (wrapper && !tabElements.has(toId)) {
      wrapper.dataset.tabId = toId;
      const btn = wrapper.querySelector('.tab-button');
      if (btn) btn.dataset.tabId = toId;
      tabElements.delete(fromId);
      tabElements.set(toId, wrapper);
    }
  }

  function clear() {
    closeContextMenu();
    failedFavicons.clear();
    faviconVersions.clear();
    $('#tab-list')?.replaceChildren();
    tabElements.clear();
  }

  $('#ctx-new-adjacent')?.addEventListener('click', () => {
    const targetId = contextMenuTabId;
    closeContextMenu();
    if (targetId) newTab({ url: 'about:blank', afterTabId: targetId });
  });
  $('#ctx-reload')?.addEventListener('click', () => {
    const targetId = contextMenuTabId;
    closeContextMenu();
    if (targetId) browserAction('reload', { tabId: targetId });
  });
  $('#ctx-duplicate')?.addEventListener('click', () => {
    const targetId = contextMenuTabId;
    closeContextMenu();
    if (!targetId) return;
    const targetTab = getState()?.browser.tabs.find(item => item.id === targetId);
    newTab({ url: targetTab?.url || 'about:blank', afterTabId: targetId });
  });
  $('#ctx-toggle-layout')?.addEventListener('click', () => {
    closeContextMenu();
    applyTabLayout(!$('.browser-shell')?.classList.contains('vertical-tabs'), true);
  });
  $('#ctx-close')?.addEventListener('click', () => {
    const targetId = contextMenuTabId;
    closeContextMenu();
    if (targetId) browserAction('close', { tabId: targetId });
  });
  $('#ctx-close-others')?.addEventListener('click', () => {
    const targetId = contextMenuTabId;
    closeContextMenu();
    if (targetId) browserAction('close-others', { tabId: targetId });
  });
  $('#ctx-close-after')?.addEventListener('click', () => {
    const targetId = contextMenuTabId;
    closeContextMenu();
    if (targetId) browserAction('close-after', { tabId: targetId });
  });
  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('blur', closeContextMenu);

  return {
    renderTabs,
    setSelected,
    scrollSelectedIntoView,
    syncSpinner,
    refreshFavicons,
    openContextMenu,
    closeContextMenu,
    syncContextMenuState,
    migrateTabId,
    clear,
  };
}
