import { reopenUrl } from './tab-url.js';
import { LiveReplay, RecordingStore } from './replay.js';
import { RemoteControl } from './remote-control.js';
import { createAgentIcon, createThemeIcon } from './icons.js';
import { createMemoryPanel, formatBytes } from './memory-panel.js';
import { createAddressBar } from './address-bar.js';
import { ScreencastView } from './screencast-view.js';
import { createTabStrip } from './tab-strip.js';
import { createOverview } from './overview.js';
import { createDevtoolsPanel } from './devtools-panel.js';

const $ = selector => document.querySelector(selector);
const binaryTextDecoder = new TextDecoder();
let state = null;
let selected = null;
let socket = null;
let reconnect = null;
let authenticated = false;
let toastTimer;
let reopening = false;
let navSeqCounter = 0;
let creatingCount = 0;
let activating = null;
const pendingNavSeq = new Map();
const pendingNavUrl = new Map();
const closingTabs = new Set();
const optimisticClosedTabs = new Set();
const optimisticNewTabs = new Map();
let optimisticTabSeq = 0;
let remoteActive = null;
let pinnedSessionId = null;
let lastFollowedActivityAt = 0;
let viewMode = 'browser';
let viewportMode = 'adaptive';
let screencastMode = false;
let screencastTabId = null;
let screencastQuality = 'balanced';
let screencastRetina = false;
let screencastQualityOverride = false;
let screencastRetinaOverride = false;
let screencastRetinaCapable = true;
let drawerOpen = false;
let operationTimer;
const pendingControls = new Map();
const pendingWheelControls = new Set();
const pendingControlTargets = new Map();
const recordings = new RecordingStore();
const autoScreencastHandledDocs = new Set();
const dismissedXOriginDocs = new Set();
const dismissedLimitedDocs = new Set();
let bannerReason = null;
let mainPlayer = null;
let viewerId = null;
let controlRequestId = 0;
let lastResync = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}

function operation(message, status = 'ready') {
  clearTimeout(operationTimer);
  $('#operation-status').textContent = message;
  $('#operation-status').dataset.state = status;
  if (status !== 'pending') operationTimer = setTimeout(() => { $('#operation-status').textContent = ''; }, 3500);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || '请求失败');
    error.status = response.status;
    throw error;
  }
  return result;
}

function getEffectiveTabs(rawTabs = state?.browser.tabs || []) {
  const list = rawTabs.filter(item => !optimisticClosedTabs.has(item.id));
  for (const opt of optimisticNewTabs.values()) {
    if (optimisticClosedTabs.has(opt.id)) continue;
    if (opt.afterTabId) {
      const idx = list.findIndex(item => item.id === opt.afterTabId);
      if (idx >= 0) { list.splice(idx + 1, 0, opt); continue; }
    }
    list.push(opt);
  }
  return list;
}

function findTab(tabId) {
  if (!tabId) return null;
  return getEffectiveTabs().find(item => item.id === tabId) || null;
}

function isTabLoading(tabId, tab = null) {
  const current = tab || findTab(tabId);
  return Boolean(current?.loading || (tabId && pendingNavSeq.has(tabId)));
}

function renderOptimisticTabs() {
  if (!state) return;
  const tabs = getEffectiveTabs();
  if ($('#overview-count')) $('#overview-count').textContent = tabs.length;
  updateDocumentTitle();
  tabStrip.renderTabs(tabs, state.browser.activeTabId, removedId => {
    if (!optimisticClosedTabs.has(removedId) && !optimisticNewTabs.has(removedId)) {
      recordings.delete(removedId);
    }
  });
  overview.renderThumbnails(tabs);
  tabStrip.setSelected(selected);
  overview.setSelected(selected);
  if (viewMode === 'overview') overview.updateLayout(true);
  updateReopenButton();
  updateControl();
}

const memoryPanel = createMemoryPanel({ api, element, isAuthenticated: () => authenticated });

const addressBar = createAddressBar({
  api,
  element,
  onNavigate: url => browserAction('navigate', { url }),
  onOpenNewTab: url => newTab({ url, afterTabId: selected || undefined }),
  onError: toast,
  getSelectedTab: () => findTab(selected),
  getPendingUrl: tabId => pendingNavUrl.get(tabId) || null,
});

const screencastView = new ScreencastView({
  container: $('#screencast-stage'),
  canvas: $('#screencast-canvas'),
  onCopy: opts => copyRemoteSelection(opts),
  send: data => {
    if (socket?.readyState === WebSocket.OPEN) {
      const requestId = ++controlRequestId;
      if (data.action !== 'mousemove' && data.action !== 'wheel') pendingControls.set(requestId, Date.now());
      socket.send(JSON.stringify({ ...data, requestId }));
    }
  },
});

const controller = new RemoteControl({
  surface: $('#control-surface'),
  editor: $('#remote-editor'),
  select: $('#remote-select'),
  notify: toast,
  onCopy: opts => copyRemoteSelection(opts),
  blocked: () => {
    const tab = findTab(selected);
    if (state?.browser.importing) toast('正在同步登录态，请稍候。');
    else if (tab?.recordingStatus === 'limited') toast('当前页面 DOM 体积超过回放上限，请切换画面直连模式。');
    else if (!mainPlayer?.isReady || tab?.recordingStatus !== 'live') toast('正在准备最新回放，请稍候。');
  },
  send: data => {
    if (socket?.readyState === WebSocket.OPEN) {
      const requestId = ++controlRequestId;
      if (data.action === 'wheel') {
        pendingWheelControls.add(requestId);
      } else if (data.action !== 'move') {
        pendingControls.set(requestId, Date.now());
        if (Number.isInteger(data.nodeId)) pendingControlTargets.set(requestId, data.nodeId);
      }
      socket.send(JSON.stringify({ ...data, tabId: selected, requestId }));
    }
  },
});

const tabStrip = createTabStrip({
  $,
  element,
  createAgentIcon,
  getState: () => state,
  getTabs: () => getEffectiveTabs(),
  getSelected: () => selected,
  isTabLoading,
  isClosingTab: id => closingTabs.has(id),
  selectTab: id => selectTab(id),
  browserAction: (action, opts) => browserAction(action, opts),
  newTab: opts => newTab(opts),
  applyTabLayout: (vertical, persist) => applyTabLayout(vertical, persist),
});

const overview = createOverview({
  $,
  element,
  createAgentIcon,
  LiveReplay,
  recordings,
  getMainPlayer: () => mainPlayer,
  selectTab: id => selectTab(id),
  setViewMode: mode => setViewMode(mode),
  browserAction: (action, opts) => browserAction(action, opts),
});

const devtoolsPanel = createDevtoolsPanel({
  $,
  element,
  api,
  copyText,
  toast,
  getSelectedTab: () => findTab(selected),
  isBrowserReady: () => Boolean(state?.browser.ready && !state?.browser.importing),
  onSubscribe: tabId => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(tabId ? { type: 'devtools', enabled: true, tabId } : { type: 'devtools', enabled: false }));
  },
  onClear: (tabId, target) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'devtools-clear', tabId, target }));
    } else {
      api(`/api/tabs/${encodeURIComponent(tabId)}/devtools/clear`, {
        method: 'POST',
        body: JSON.stringify({ target }),
      }).catch(() => {});
    }
  },
  onLayoutChange: () => {
    requestAnimationFrame(() => {
      mainPlayer?.fit();
      screencastView.fit();
      controller.repositionEditor();
      sendViewport(false);
    });
  },
});

function updateDrawerIndicators() {
  const caption = $('#browser-caption');
  const ext = $('#extension-badge');
  const conn = $('#connection');
  const hasAlert = Boolean((ext && !ext.hidden) || (conn && !conn.hidden));
  const hasNotice = hasAlert || Boolean(caption && !caption.hidden);
  const alerts = $('#drawer-alerts');
  if (alerts) alerts.hidden = !hasNotice;
  const label = hasAlert ? '打开 Ditto 设置（有连接异常）' : '打开 Ditto 设置';
  for (const trigger of document.querySelectorAll('[data-drawer-trigger]')) {
    trigger.classList.toggle('has-alert', hasAlert);
    trigger.title = label;
  }
}

function setDrawerOpen(open) {
  drawerOpen = Boolean(open);
  const drawer = $('#control-drawer');
  const backdrop = $('#drawer-backdrop');
  if (drawer) {
    drawer.classList.toggle('open', drawerOpen);
    drawer.setAttribute('aria-hidden', String(!drawerOpen));
  }
  if (backdrop) backdrop.hidden = !drawerOpen;
  for (const trigger of document.querySelectorAll('[data-drawer-trigger]')) {
    trigger.setAttribute('aria-expanded', String(drawerOpen));
  }
  if (drawerOpen && authenticated) memoryPanel.start();
  else memoryPanel.stop();
}

function connection(connected, text = '') {
  const badge = $('#connection');
  if (!badge) return;
  const showError = !connected && authenticated && Boolean(text);
  badge.hidden = !showError;
  if (showError) badge.lastChild.textContent = text;
  updateDrawerIndicators();
}

function extensionBadge(connected) {
  const badge = $('#extension-badge');
  if (!badge) return;
  const showError = authenticated && !connected;
  badge.hidden = !showError;
  if (showError) badge.lastChild.textContent = '扩展未连接';
  updateDrawerIndicators();
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Fall back on plain HTTP origins. */ }
  }
  const prevFocus = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (prevFocus && prevFocus !== document.body && prevFocus.isConnected) {
    try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  if (!ok) throw new Error('浏览器拒绝自动复制，请直接复制页面显示的地址。');
}

async function copyRemoteSelection({ localText = '', fallback = null } = {}) {
  if (localText) {
    try {
      await copyText(localText);
      operation(`已复制 ${localText.length} 个字符到剪贴板`);
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const tabId = selected;
  if (!tabId) { fallback?.(); return; }
  try {
    const { text } = await api(`/api/tabs/${encodeURIComponent(tabId)}/selection`, { method: 'POST' });
    if (!text) {
      fallback?.();
      return;
    }
    await copyText(text);
    operation(`已复制 ${text.length} 个字符到剪贴板`);
  } catch (error) {
    toast(error.message);
  }
}

function sendWatch(resync = false, resyncTabId = null) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const watchTabId = selected && optimisticNewTabs.has(selected) ? null : selected;
  socket.send(JSON.stringify({
    type: 'watch',
    tabId: watchTabId,
    paused: false,
    viewMode,
    resync,
    ...(resyncTabId ? { resyncTabId } : {}),
  }));
}

function hideXOriginBanner(reason = null) {
  if (reason && bannerReason && bannerReason !== reason) return;
  const banner = $('#xorigin-banner');
  if (banner) banner.hidden = true;
  bannerReason = null;
}

function syncLimitedBanner() {
  const tab = findTab(selected);
  const limited = Boolean(tab && !tab.optimistic && tab.recordingStatus === 'limited' && !screencastMode && !screencastTabId && viewMode !== 'overview');
  if (!limited) {
    hideXOriginBanner('limited');
    return;
  }
  const docId = tab.documentId || tab.id;
  if (docId && dismissedLimitedDocs.has(docId)) {
    hideXOriginBanner('limited');
    return;
  }
  const banner = $('#xorigin-banner');
  const text = $('#xorigin-banner-text');
  if (text) text.textContent = '当前页面 DOM 体积超过回放上限，画面已暂停更新';
  if (banner) banner.hidden = false;
  bannerReason = 'limited';
}

function handleCrossOriginFrame(info, replay) {
  if (mainPlayer !== replay || screencastMode || screencastTabId) { hideXOriginBanner('xorigin'); return; }
  if (!info?.visible) { hideXOriginBanner('xorigin'); return; }
  const docId = replay.documentId;
  const canScreencast = Boolean(selected && state?.browser.ready && !state?.browser.importing && socket?.readyState === WebSocket.OPEN);
  if (info.dominant && canScreencast && docId && !autoScreencastHandledDocs.has(docId)) {
    autoScreencastHandledDocs.add(docId);
    if (autoScreencastHandledDocs.size > 100) autoScreencastHandledDocs.delete(autoScreencastHandledDocs.values().next().value);
    hideXOriginBanner();
    applyScreencastMode(true, false);
    operation('检测到跨域页面，已自动切换画面直连模式');
    return;
  }
  if (bannerReason === 'limited') return;
  if (docId && dismissedXOriginDocs.has(docId)) { hideXOriginBanner('xorigin'); return; }
  const banner = $('#xorigin-banner');
  const text = $('#xorigin-banner-text');
  if (text) {
    text.textContent = info.dominant
      ? '当前页面主体为跨域内嵌内容，DOM 回放模式无法显示'
      : '当前页面包含跨域内嵌框，DOM 回放模式无法显示该区域';
  }
  if (banner) banner.hidden = false;
  bannerReason = 'xorigin';
}

function desiredScreencastTabId() {
  if (!authenticated || !screencastMode || viewMode === 'overview') return null;
  if (!selected || optimisticNewTabs.has(selected)) return null;
  if (!state?.browser.ready || state?.browser.importing) return null;
  const tab = findTab(selected);
  if (!tab || tab.optimistic || tab.recordingStatus === 'crashed') return null;
  if (tab.url === 'about:blank' && !pendingNavUrl.has(tab.id)) return null;
  return selected;
}

function syncScreencast(forceSend = false) {
  const next = desiredScreencastTabId();
  const changed = screencastTabId !== next;
  const prev = screencastTabId;
  screencastTabId = next;
  if (screencastTabId) {
    hideXOriginBanner();
    controller.hideEditor();
    if (mainPlayer) {
      mainPlayer.destroy();
      mainPlayer = null;
      controller.bind(null);
    }
    $('.replay-viewport').hidden = true;
    $('#empty-frame').hidden = true;
    screencastView.show(screencastTabId);
    if ((changed || forceSend) && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'screencast',
        enabled: true,
        tabId: screencastTabId,
        quality: screencastQuality,
        retina: screencastRetina && screencastRetinaCapable,
      }));
    }
  } else {
    screencastView.hide();
    $('.replay-viewport').hidden = false;
    if (changed && prev && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'screencast', enabled: false }));
    }
    if (changed) renderMain();
  }
  updateControl();
}

function updateScreencastSubrows() {
  if ($('#screencast-quality-row')) $('#screencast-quality-row').hidden = !screencastMode;
  if ($('#screencast-retina-row')) $('#screencast-retina-row').hidden = !screencastMode || !screencastRetinaCapable;
}

function applyScreencastQuality(quality, persist = false) {
  const valid = ['smooth', 'balanced', 'high', 'lossless'];
  screencastQuality = valid.includes(quality) ? quality : 'balanced';
  for (const button of document.querySelectorAll('#screencast-quality-switcher .seg-option')) {
    const active = button.dataset.scQuality === screencastQuality;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (persist) {
    screencastQualityOverride = true;
    try { localStorage.setItem('ditto_screencast_quality', screencastQuality); } catch { /* ignore */ }
  }
  if (authenticated && screencastTabId) syncScreencast(true);
}

function applyScreencastRetina(enabled, persist = false) {
  screencastRetina = Boolean(enabled);
  const toggle = $('#screencast-retina-toggle');
  if (toggle) {
    toggle.checked = screencastRetina;
    toggle.setAttribute('aria-checked', String(screencastRetina));
  }
  if (persist) {
    screencastRetinaOverride = true;
    try { localStorage.setItem('ditto_screencast_retina', screencastRetina ? '1' : '0'); } catch { /* ignore */ }
  }
  if (authenticated && screencastTabId) syncScreencast(true);
}

function applyScreencastMode(enabled, persist = false) {
  screencastMode = Boolean(enabled);
  const toggle = $('#screencast-toggle');
  if (toggle) {
    toggle.checked = screencastMode;
    toggle.setAttribute('aria-checked', String(screencastMode));
  }
  updateScreencastSubrows();
  if (persist) {
    try { localStorage.setItem('ditto_screencast_mode', screencastMode ? '1' : '0'); } catch { /* ignore */ }
  }
  if (authenticated) syncScreencast();
}

let lastSentViewport = null;
let viewportTimer = null;
function sendViewport(immediate = false) {
  if (socket?.readyState !== WebSocket.OPEN || !authenticated) return;
  if (viewportMode === 'fixed') {
    const fixed = { width: 1920, height: 1080 };
    if (!immediate && lastSentViewport?.width === fixed.width && lastSentViewport?.height === fixed.height) return;
    clearTimeout(viewportTimer);
    lastSentViewport = fixed;
    socket.send(JSON.stringify({ type: 'viewport', ...fixed }));
    return;
  }
  const stage = $('.stage');
  if (!stage) return;
  const width = Math.floor(stage.clientWidth);
  const height = Math.floor(stage.clientHeight);
  if (width < 640 || height < 360) return;
  if (!immediate && lastSentViewport && Math.abs(lastSentViewport.width - width) < 4 && Math.abs(lastSentViewport.height - height) < 4) return;
  clearTimeout(viewportTimer);
  const emit = () => {
    if (socket?.readyState !== WebSocket.OPEN || !authenticated || viewportMode !== 'adaptive') return;
    const w = Math.floor(stage.clientWidth);
    const h = Math.floor(stage.clientHeight);
    if (w < 640 || h < 360) return;
    lastSentViewport = { width: w, height: h };
    socket.send(JSON.stringify({ type: 'viewport', width: w, height: h }));
  };
  if (immediate) emit();
  else viewportTimer = setTimeout(emit, 180);
}
if ($('.stage')) new ResizeObserver(() => sendViewport(false)).observe($('.stage'));

function selectTab(id, activate = true, { preserveAddressBar = false } = {}) {
  const changed = selected !== id;
  selected = id;
  if (changed) pendingWheelControls.clear();
  if (activate) {
    for (const tab of state?.browser.tabs || []) {
      if (tab.agent?.updatedAt) lastFollowedActivityAt = Math.max(lastFollowedActivityAt, tab.agent.updatedAt);
    }
  }
  tabStrip.setSelected(id);
  overview.setSelected(id);
  addressBar.update(!preserveAddressBar);
  syncScreencast();
  devtoolsPanel.syncTab();
  if (!screencastTabId && (changed || !mainPlayer)) renderMain();
  updateReopenButton();
  updateControl();
  sendWatch();
  if (activate && id && !optimisticNewTabs.has(id) && state?.browser.ready && (changed || remoteActive !== id)) {
    activating = id;
    api(`/api/tabs/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ action: 'activate', viewerId }) })
      .catch(error => toast(error.message)).finally(() => {
        if (activating === id) {
          activating = null;
          if (state) followAgentIfNeeded(state);
        }
      });
  }
  tabStrip.scrollSelectedIntoView(id);
}

function renderMain() {
  if (screencastTabId) return;
  hideXOriginBanner();
  mainPlayer?.destroy();
  mainPlayer = null;
  controller.bind(null);
  const recording = recordings.get(selected);
  const tab = findTab(selected);
  const blank = tab?.url === 'about:blank';
  const crashed = tab?.recordingStatus === 'crashed';
  const limited = tab?.recordingStatus === 'limited';
  $('#main-replay').hidden = !recording || blank || crashed;
  $('#empty-frame').hidden = Boolean(recording) && !blank && !crashed;
  $('#empty-title').textContent = blank ? '新标签页' : crashed ? '远端标签页已崩溃' : limited ? '页面超出 DOM 回放上限' : tab ? '正在连接网页' : '没有打开的标签页';
  $('#empty-description').textContent = blank ? '在上方地址栏输入 URL，按 Enter 在 devbox 打开。'
    : crashed ? '页面渲染进程崩溃（通常是内存不足），点击上方 ↻ 刷新即可重建恢复。'
    : limited ? '当前页面 DOM 快照过大，请切换画面直连模式查看实时画面。'
    : tab?.recordingStatus === 'unsupported' ? '此页面无法录制 DOM；可切换到画面直连模式或访问其他网站。'
    : '点击 ＋ 新建标签页，或等待最新 rrweb 快照。';
  syncLimitedBanner();
  if (!recording || blank || crashed) return;
  mainPlayer = new LiveReplay($('#main-replay'), recording, {
    ready: replay => { if (mainPlayer === replay) { controller.bind(replay); updateControl(); } },
    focus: (id, replay) => { if (mainPlayer === replay) controller.focus(id); },
    inputSelection: (payload, replay) => { if (mainPlayer === replay) controller.syncInputSelection(payload); },
    crossOriginFrame: (info, replay) => handleCrossOriginFrame(info, replay),
    hasInFlightWheels: () => pendingWheelControls.size > 0,
    hasPendingControls: () => pendingControls.size > 0,
    cast: (event, replay) => {
      if (mainPlayer !== replay) return;
      if (event.type === 3 && event.data?.source === 3) controller.hideEditor();
      else if (event.type === 3 && (event.data?.source === 0 || event.data?.source === 4) && controller.isEditing()) {
        requestAnimationFrame(() => {
          if (mainPlayer === replay) controller.repositionEditor();
        });
      }
    },
  });
}

function updateControl() {
  const tab = findTab(selected);
  const inScreencast = Boolean(screencastTabId);
  controller.setAvailable(!inScreencast && Boolean(mainPlayer));
  controller.setEnabled(!inScreencast && Boolean(mainPlayer?.isReady) && Boolean(state?.browser.ready) &&
    !state?.browser.importing && socket?.readyState === WebSocket.OPEN && tab?.recordingStatus === 'live');
  syncLimitedBanner();
  updateDrawerIndicators();
  updateNavigation();
}

function updateReopenButton() {
  const tab = findTab(selected);
  const ready = Boolean(state?.browser.ready) && !state?.browser.importing;
  const hasTab = Boolean(tab) && !tab?.optimistic && tab?.recordingStatus !== 'crashed';
  $('#reopen-tab').disabled = reopening || !ready || !reopenUrl(tab?.url);
  $('#request-cookies').disabled = !state?.browser.ready || !reopenUrl(tab?.url) || Boolean(state?.sync.pending);
  if ($('#copy-selection')) $('#copy-selection').disabled = !ready || !hasTab;
  if ($('#upload-file')) $('#upload-file').disabled = !ready || !hasTab;
}

function updateNavigation() {
  const tabs = getEffectiveTabs();
  const selectedIndex = tabs.findIndex(item => item.id === selected);
  const tab = selectedIndex >= 0 ? tabs[selectedIndex] : null;
  const browserBusy = !state?.browser.ready || state?.browser.importing;
  const loading = isTabLoading(selected, tab);

  $('#address-bar').disabled = browserBusy || !tab;
  $('#new-tab').disabled = browserBusy;
  if ($('#overview-new-tab')) $('#overview-new-tab').disabled = browserBusy;

  const reloadBtn = $('#reload-tab');
  reloadBtn.disabled = browserBusy || !tab || Boolean(tab?.optimistic);
  reloadBtn.classList.toggle('stopping', loading);
  reloadBtn.textContent = loading ? '×' : '↻';
  reloadBtn.title = loading ? '停止加载 (Esc)' : '刷新网页';
  reloadBtn.setAttribute('aria-label', loading ? '停止加载' : '刷新网页');
  $('#tab-progress')?.classList.toggle('loading', loading);

  $('#back-tab').disabled = browserBusy || !tab?.canGoBack;
  $('#forward-tab').disabled = browserBusy || !tab?.canGoForward;

  const overviewCloseOthers = $('#overview-close-others');
  if (overviewCloseOthers) overviewCloseOthers.disabled = browserBusy || !tab || tabs.length <= 1;
  tabStrip.syncContextMenuState();
}

async function browserAction(action, { url, tabId = selected, promptText } = {}) {
  if (!tabId) return;
  if (optimisticNewTabs.has(tabId)) {
    const opt = optimisticNewTabs.get(tabId);
    if (action === 'navigate' && typeof url === 'string') {
      opt.pendingAction = { action: 'navigate', url };
      opt.url = url;
      opt.title = url;
      opt.loading = true;
      pendingNavUrl.set(tabId, url);
      addressBar.clearDraft(tabId);
      renderOptimisticTabs();
      if (tabId === selected) {
        addressBar.update();
        operation('正在加载远端网页…', 'pending');
      }
      return;
    }
    if (action === 'close') {
      opt.pendingClose = true;
      const visible = getEffectiveTabs();
      const idx = visible.findIndex(item => item.id === tabId);
      const fallback = idx >= 0 ? (visible[idx + 1]?.id || visible[idx - 1]?.id || null) : null;
      optimisticClosedTabs.add(tabId);
      if (tabId === selected) selectTab(fallback, Boolean(fallback));
      renderOptimisticTabs();
      return;
    }
    return;
  }

  const isNav = ['navigate', 'reload', 'back', 'forward'].includes(action);
  const isClose = action === 'close';
  const isBatchClose = action === 'close-others' || action === 'close-after' || action === 'close-all';
  if (isClose && closingTabs.has(tabId)) return;

  let navSeq = null;
  let fallbackTabId = null;
  let batchOptimisticIds = [];
  if (isClose) {
    closingTabs.add(tabId);
    const visible = getEffectiveTabs();
    const idx = visible.findIndex(item => item.id === tabId);
    if (idx >= 0) {
      fallbackTabId = visible[idx + 1]?.id || visible[idx - 1]?.id || null;
    }
    optimisticClosedTabs.add(tabId);
    if (tabId === selected) selectTab(fallbackTabId, Boolean(fallbackTabId));
    renderOptimisticTabs();
  } else if (isBatchClose) {
    const visible = getEffectiveTabs();
    const idx = visible.findIndex(item => item.id === tabId);
    if (action === 'close-others') {
      batchOptimisticIds = visible.filter(t => t.id !== tabId && !optimisticNewTabs.has(t.id)).map(t => t.id);
    } else if (action === 'close-after' && idx >= 0) {
      batchOptimisticIds = visible.slice(idx + 1).filter(t => !optimisticNewTabs.has(t.id)).map(t => t.id);
    } else if (action === 'close-all') {
      batchOptimisticIds = visible.filter(t => !optimisticNewTabs.has(t.id)).map(t => t.id);
    }
    for (const id of batchOptimisticIds) optimisticClosedTabs.add(id);
    if (action === 'close-all') selectTab(null, false);
    else if (batchOptimisticIds.includes(selected)) selectTab(tabId, true);
    renderOptimisticTabs();
  } else if (action === 'stop') {
    pendingNavSeq.delete(tabId);
    pendingNavUrl.delete(tabId);
    tabStrip.syncSpinner(tabId);
  } else if (isNav) {
    navSeq = ++navSeqCounter;
    pendingNavSeq.set(tabId, navSeq);
    if (action === 'navigate' && typeof url === 'string') {
      pendingNavUrl.set(tabId, url);
      addressBar.clearDraft(tabId);
    }
    tabStrip.syncSpinner(tabId);
    if (tabId === selected) {
      addressBar.update();
      syncScreencast();
    }
  }

  if (tabId === selected) controller.hideEditor();
  if (action === 'stop') {
    operation('正在停止加载…', 'pending');
  } else if (isClose || isBatchClose) {
    operation('正在关闭远端标签页…', 'pending');
  } else if (isNav && tabId === selected) {
    operation('正在加载远端网页…', 'pending');
  }
  updateNavigation();

  try {
    const result = await api(`/api/tabs/${encodeURIComponent(tabId)}`, {
      method: 'POST',
      body: JSON.stringify({ action, url, viewerId, ...(promptText !== undefined ? { promptText } : {}) }),
    });
    if (isNav && pendingNavSeq.get(tabId) !== navSeq) return;
    if (isNav) {
      pendingNavSeq.delete(tabId);
      pendingNavUrl.delete(tabId);
      tabStrip.syncSpinner(tabId);
    }
    if (isClose) optimisticClosedTabs.delete(tabId);
    for (const id of batchOptimisticIds) optimisticClosedTabs.delete(id);
    updateState(await api('/api/state'));
    if (result.replacementId) selectTab(result.replacementId);
    else if (isClose && !result.closed && state?.browser.tabs.some(item => item.id === tabId)) {
      // Closing was blocked (e.g. beforeunload dialog): restore and focus that tab.
      selectTab(tabId, false);
    } else if (isClose && result.closed && fallbackTabId && selected !== fallbackTabId && !getEffectiveTabs().some(item => item.id === selected) && getEffectiveTabs().some(item => item.id === fallbackTabId)) {
      selectTab(fallbackTabId);
    } else if (action === 'close-others' && state?.browser.tabs.some(item => item.id === tabId)) {
      selectTab(tabId);
    }
    if (result.superseded) return;
    if (isBatchClose) {
      const closed = result.closedCount || 0;
      const skipped = result.skippedCount || 0;
      operation(skipped ? `已关闭 ${closed} 个标签页（${skipped} 个待确认）` : closed ? `已关闭 ${closed} 个标签页` : '没有可关闭的标签页');
    } else if (action === 'stop') {
      operation('已停止加载');
    } else {
      operation(result.recovered ? '标签页已重建并恢复' : result.closed ? '远端标签页已关闭' : action === 'close' ? '等待页面关闭确认' : '远端操作已完成');
    }
  } catch (error) {
    if (isClose) optimisticClosedTabs.delete(tabId);
    for (const id of batchOptimisticIds) optimisticClosedTabs.delete(id);
    if (isClose || isBatchClose) {
      renderOptimisticTabs();
      if (isClose && (!selected || !getEffectiveTabs().some(item => item.id === selected)) && state?.browser.tabs.some(item => item.id === tabId)) {
        selectTab(tabId, false);
      }
    }
    if (!isNav || pendingNavSeq.get(tabId) === navSeq) {
      toast(error.message);
      operation(error.message, 'error');
    }
  } finally {
    if (isClose) { closingTabs.delete(tabId); optimisticClosedTabs.delete(tabId); }
    for (const id of batchOptimisticIds) optimisticClosedTabs.delete(id);
    if (isNav && pendingNavSeq.get(tabId) === navSeq) {
      pendingNavSeq.delete(tabId);
      pendingNavUrl.delete(tabId);
      tabStrip.syncSpinner(tabId);
    }
    updateNavigation();
  }
}

async function newTab(options) {
  const opts = options && typeof options === 'object' && !(options instanceof Event) ? options : {};
  const targetUrl = typeof opts.url === 'string' && opts.url ? opts.url : 'about:blank';
  const rawAfterTabId = typeof opts.afterTabId === 'string' && opts.afterTabId ? opts.afterTabId : undefined;
  const serverAfterTabId = rawAfterTabId && !optimisticNewTabs.has(rawAfterTabId) ? rawAfterTabId : undefined;
  if (!state?.browser.ready || state?.browser.importing) return;

  const tempId = `opt-tab-${++optimisticTabSeq}`;
  const opt = {
    id: tempId,
    url: targetUrl,
    title: targetUrl === 'about:blank' ? '新标签页' : targetUrl,
    afterTabId: rawAfterTabId,
    loading: targetUrl !== 'about:blank',
    recordingStatus: 'starting',
    canGoBack: false,
    canGoForward: false,
    optimistic: true,
    pendingAction: null,
    pendingClose: false,
  };
  optimisticNewTabs.set(tempId, opt);
  creatingCount++;
  if (viewMode === 'overview') setViewMode('browser');
  renderOptimisticTabs();
  selectTab(tempId, false);
  if (targetUrl === 'about:blank') $('#address-bar').focus();

  try {
    const result = await api('/api/tabs', { method: 'POST', body: JSON.stringify({ url: targetUrl, afterTabId: serverAfterTabId, viewerId }) });
    const realTabId = result.tabId;
    optimisticNewTabs.delete(tempId);
    if (opt.pendingClose) {
      optimisticClosedTabs.delete(tempId);
      optimisticClosedTabs.add(realTabId);
      updateState(await api('/api/state'));
      browserAction('close', { tabId: realTabId });
      return;
    }
    addressBar.migrateDraft(tempId, realTabId);
    tabStrip.migrateTabId(tempId, realTabId);
    if (pendingNavUrl.has(tempId)) {
      pendingNavUrl.set(realTabId, pendingNavUrl.get(tempId));
      pendingNavUrl.delete(tempId);
    }
    const wasSelected = selected === tempId;
    const wasTyping = document.activeElement === $('#address-bar');
    if (wasSelected) selected = realTabId;
    updateState(await api('/api/state'));
    if (wasSelected) {
      selectTab(realTabId, true, { preserveAddressBar: wasTyping });
      if (targetUrl === 'about:blank' && !opt.pendingAction && !wasTyping && document.activeElement !== $('#address-bar')) {
        $('#address-bar').focus();
      }
    }
    if (opt.pendingAction?.action === 'navigate') {
      browserAction('navigate', { url: opt.pendingAction.url, tabId: realTabId });
    }
  } catch (error) {
    optimisticNewTabs.delete(tempId);
    optimisticClosedTabs.delete(tempId);
    addressBar.clearDraft(tempId);
    pendingNavUrl.delete(tempId);
    if (selected === tempId) {
      const nextTab = getEffectiveTabs()[0]?.id || null;
      selectTab(nextTab, Boolean(nextTab));
    }
    renderOptimisticTabs();
    toast(error.message);
  } finally {
    creatingCount = Math.max(0, creatingCount - 1);
    updateNavigation();
  }
}

function renderAgentSessions(sessions = []) {
  const container = $('#agent-sessions');
  if (!container) return;
  const section = $('#agent-sessions-section');
  if (section) section.hidden = !sessions.length;
  if (pinnedSessionId && !sessions.some(item => item.sessionId === pinnedSessionId)) {
    pinnedSessionId = null;
  }
  container.classList.toggle('has-pinned', Boolean(pinnedSessionId));
  container.replaceChildren();
  for (const item of sessions) {
    const pinned = pinnedSessionId === item.sessionId;
    const chip = element('button', `session-chip${item.active ? ' is-active' : ''}${pinned ? ' is-pinned' : ''}`);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(pinned));
    chip.style.setProperty('--chip-color', item.color);
    chip.title = pinned
      ? `${item.label}${item.workspace ? ` (${item.workspace})` : ''} · 仅跟随此 Agent — 再次点击恢复跟随全部`
      : `${item.label}${item.workspace ? ` (${item.workspace})` : ''} · ${item.tabCount} 个标签页 — 点击仅跟随此 Agent`;
    chip.append(createAgentIcon(item.agent), element('span', '', item.label));
    if (item.workspace) chip.append(element('span', 'session-chip-ws', item.workspace));
    if (item.active && item.action) chip.append(element('span', 'session-chip-action', item.action));
    chip.addEventListener('click', () => {
      if (pinnedSessionId === item.sessionId) {
        pinnedSessionId = null;
        renderAgentSessions(state?.browser.agentSessions || []);
        toast('已恢复跟随全部 Agent');
      } else {
        pinnedSessionId = item.sessionId;
        renderAgentSessions(state?.browser.agentSessions || []);
        if (viewMode === 'overview') setViewMode('browser');
        if (item.primaryTabId) selectTab(item.primaryTabId);
        setDrawerOpen(false);
        toast(`仅跟随 ${item.label}（再次点击取消）`);
      }
    });
    container.append(chip);
  }
}

function renderDownloads(downloads = []) {
  const section = $('#downloads-section');
  const list = $('#downloads-list');
  if (!section || !list) return;
  section.hidden = !downloads.length;
  list.replaceChildren();
  for (const item of downloads) {
    const row = element('div', 'download-row');
    const name = element('span', 'download-name', item.filename);
    name.title = item.filename;
    row.append(name);
    if (item.status === 'downloading') {
      row.append(element('span', 'download-meta', '下载中…'));
    } else {
      row.append(element('span', 'download-meta', formatBytes(item.size)));
      const link = element('a', 'download-link', '保存');
      link.href = `/api/downloads/${encodeURIComponent(item.id)}`;
      link.download = item.filename;
      row.append(link);
    }
    list.append(row);
  }
}

const TITLE_SPINNER = ['◐', '◓', '◑', '◒'];
let titleSpinnerIndex = 0;
let titleSpinnerTimer = null;

function stopTitleSpinner() {
  if (titleSpinnerTimer) {
    clearInterval(titleSpinnerTimer);
    titleSpinnerTimer = null;
  }
  titleSpinnerIndex = 0;
}

function updateDocumentTitle(disconnected = false) {
  if (!authenticated || !state) {
    stopTitleSpinner();
    document.title = 'Ditto';
    return;
  }
  const tabs = getEffectiveTabs();
  const base = tabs.length ? `Ditto · ${tabs.length}` : 'Ditto';
  const agentOperating = !disconnected && (
    (state.browser.agentSessions || []).some(item => item.active || item.busy)
    || tabs.some(tab => tab.agent?.active || tab.agent?.busy)
  );
  if (agentOperating) {
    document.title = `${TITLE_SPINNER[titleSpinnerIndex]} ${base}`;
    if (!titleSpinnerTimer) {
      titleSpinnerTimer = setInterval(() => {
        titleSpinnerIndex = (titleSpinnerIndex + 1) % TITLE_SPINNER.length;
        updateDocumentTitle();
      }, 500);
    }
  } else {
    stopTitleSpinner();
    document.title = base;
  }
}

function renderDialogBanner(tabs) {
  const notice = $('#notice');
  const dialogTab = tabs.find(tab => tab.dialog);
  notice.hidden = !dialogTab;
  notice.replaceChildren();
  if (!dialogTab) return;
  const dlg = dialogTab.dialog;
  if (dlg.closing && dlg.type === 'beforeunload') {
    notice.append(element('span', '', '页面可能有未保存更改，确认关闭？'));
    const confirm = element('button', 'button secondary', '关闭');
    const cancel = element('button', 'button quiet', '保留');
    confirm.addEventListener('click', () => browserAction('confirm-close', { tabId: dialogTab.id }));
    cancel.addEventListener('click', () => browserAction('cancel-close', { tabId: dialogTab.id }));
    notice.append(confirm, cancel);
    return;
  }
  const labelMap = { alert: '页面弹出提示框 (alert)', confirm: '页面请求确认 (confirm)', prompt: '页面请求输入 (prompt)', beforeunload: '页面请求离开确认' };
  notice.append(element('span', '', labelMap[dlg.type] || '页面存在原生弹窗'));
  let promptInput = null;
  if (dlg.hasPrompt || dlg.type === 'prompt') {
    promptInput = document.createElement('input');
    promptInput.type = 'text';
    promptInput.className = 'dialog-prompt-input';
    promptInput.placeholder = '输入内容后按 Enter 或点击确定';
    promptInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        browserAction('accept-dialog', { tabId: dialogTab.id, promptText: promptInput.value });
      }
    });
    notice.append(promptInput);
  }
  const acceptBtn = element('button', 'button secondary', '确定');
  acceptBtn.addEventListener('click', () => browserAction('accept-dialog', {
    tabId: dialogTab.id,
    promptText: promptInput ? promptInput.value : undefined,
  }));
  notice.append(acceptBtn);
  if (dlg.type !== 'alert') {
    const dismissBtn = element('button', 'button quiet', '取消');
    dismissBtn.addEventListener('click', () => browserAction('dismiss-dialog', { tabId: dialogTab.id }));
    notice.append(dismissBtn);
  }
}

function followAgentIfNeeded(next) {
  const tabs = getEffectiveTabs(next.browser.tabs);
  const followCandidates = tabs.filter(t => (t.agent?.busy || t.agent?.active) && (!pinnedSessionId || t.agent?.sessionId === pinnedSessionId));
  const busiestAgentTab = followCandidates.sort((a, b) => (b.agent?.updatedAt || 0) - (a.agent?.updatedAt || 0))[0] || null;
  const hasNewAgentActivity = Boolean(busiestAgentTab && (busiestAgentTab.agent?.updatedAt || 0) > lastFollowedActivityAt);
  const screencastInteracting = Boolean(screencastTabId && (screencastView.dragging || Date.now() - screencastView.lastInputAt < 1500));
  const activelyEditing = controller.isEditing() || document.activeElement === $('#address-bar') || devtoolsPanel.isFocused() || screencastInteracting;
  const canAutoFollow = !activating && !creatingCount && !pendingControls.size && !optimisticClosedTabs.size && !optimisticNewTabs.size && !activelyEditing;
  if (hasNewAgentActivity && canAutoFollow) {
    lastFollowedActivityAt = busiestAgentTab.agent?.updatedAt || Date.now();
    if (busiestAgentTab.id !== selected) {
      selectTab(busiestAgentTab.id, false);
      return true;
    }
  }
  return false;
}

function updateState(next) {
  state = next;
  extensionBadge(next.extensionConnected);
  const scCfg = next.browser.screencast;
  if (scCfg) {
    screencastRetinaCapable = scCfg.retinaCapable !== false;
    if (!screencastQualityOverride && scCfg.quality) applyScreencastQuality(scCfg.quality);
    if (!screencastRetinaOverride && scCfg.retina !== undefined) applyScreencastRetina(scCfg.retina);
    updateScreencastSubrows();
  }
  const rawTabs = next.browser.tabs;
  const rawIds = new Set(rawTabs.map(tab => tab.id));
  for (const id of pendingNavSeq.keys()) if (!rawIds.has(id) && !optimisticNewTabs.has(id)) { pendingNavSeq.delete(id); pendingNavUrl.delete(id); }
  for (const id of closingTabs) if (!rawIds.has(id)) closingTabs.delete(id);
  for (const id of optimisticClosedTabs) if (!rawIds.has(id) && !optimisticNewTabs.has(id)) optimisticClosedTabs.delete(id);
  const tabs = getEffectiveTabs(rawTabs);
  const ids = new Set(tabs.map(tab => tab.id));
  if ($('#overview-count')) $('#overview-count').textContent = tabs.length;
  updateDocumentTitle();
  if ($('#browser-caption')) {
    $('#browser-caption').hidden = next.browser.ready;
    $('#browser-caption').textContent = next.browser.ready ? '' : 'Chromium 启动中…';
  }
  updateDrawerIndicators();
  renderAgentSessions(next.browser.agentSessions || []);
  renderDownloads(next.browser.downloads || []);
  renderDialogBanner(rawTabs);

  addressBar.pruneDrafts(new Set([...rawIds, ...optimisticNewTabs.keys()]));

  tabStrip.renderTabs(tabs, next.browser.activeTabId, removedId => {
    if (!optimisticClosedTabs.has(removedId) && !optimisticNewTabs.has(removedId)) {
      recordings.delete(removedId);
    }
  });
  overview.renderThumbnails(tabs);

  const activeChanged = remoteActive !== next.browser.activeTabId;
  remoteActive = next.browser.activeTabId;
  const followCandidates = tabs.filter(t => (t.agent?.busy || t.agent?.active) && (!pinnedSessionId || t.agent?.sessionId === pinnedSessionId));
  const busiestAgentTab = followCandidates.sort((a, b) => (b.agent?.updatedAt || 0) - (a.agent?.updatedAt || 0))[0] || null;
  const hasNewAgentActivity = Boolean(busiestAgentTab && (busiestAgentTab.agent?.updatedAt || 0) > lastFollowedActivityAt);
  const screencastInteracting = Boolean(screencastTabId && (screencastView.dragging || Date.now() - screencastView.lastInputAt < 1500));
  const activelyEditing = controller.isEditing() || document.activeElement === $('#address-bar') || devtoolsPanel.isFocused() || screencastInteracting;
  const canAutoFollow = !activating && !creatingCount && !pendingControls.size && !optimisticClosedTabs.size && !optimisticNewTabs.size && !activelyEditing;
  const activeTabInfo = next.browser.activeTabId ? tabs.find(t => t.id === next.browser.activeTabId) : null;
  const allowActiveFollow = !pinnedSessionId || activeTabInfo?.agent?.sessionId === pinnedSessionId;

  if (!selected || !ids.has(selected)) {
    const preferredActive = next.browser.activeTabId && ids.has(next.browser.activeTabId) ? next.browser.activeTabId : null;
    selectTab(preferredActive || tabs[0]?.id || null, false);
  } else if (hasNewAgentActivity && canAutoFollow) {
    lastFollowedActivityAt = busiestAgentTab.agent?.updatedAt || Date.now();
    if (busiestAgentTab.id !== selected) selectTab(busiestAgentTab.id, false);
    else addressBar.update();
  } else if (activeChanged && next.browser.activeTabId && ids.has(next.browser.activeTabId) && allowActiveFollow && canAutoFollow) selectTab(next.browser.activeTabId, false);
  else addressBar.update();

  syncScreencast();
  devtoolsPanel.syncTab();
  tabStrip.setSelected(selected);
  overview.setSelected(selected);
  if (viewMode === 'overview') overview.updateLayout(true);
  updateSync(next.sync);
  updateReopenButton();
  updateControl();
}

function updateSync(sync) {
  const pending = sync.pending;
  const applied = sync.applied;
  $('#sync-status').replaceChildren();
  const append = text => $('#sync-status').append(element('p', '', text));
  if (pending) {
    append(`正在同步：${pending.cookieCount} Cookie · ${pending.originCount} 个站点`);
  } else if (!applied) append('尚未接收登录态');
  if (applied) {
    const modeTag = applied.mode === 'full' ? '全量' : '按需';
    append(`最近${modeTag}同步：${new Date(applied.appliedAt).toLocaleTimeString()} · ${applied.importedCookies} Cookie / ${applied.importedStorage} Storage`);
  }
  const waiting = state.cookieSync?.requests?.filter(request => request.status === 'waiting') || [];
  if (waiting.length) append(`等待主力机同步：${waiting.length} 个站点`);
  $('#sync-warnings').replaceChildren(...[...(pending?.warnings || []), ...(applied?.importWarnings || [])].map(text => element('li', '', text)));
}

function updateRecording(data) {
  if (!state?.browser.tabs.some(tab => tab.id === data.tabId)) return;
  const kind = recordings.accept(data);
  if (kind === 'ignore') return;
  if (kind === 'resync') {
    if (Date.now() - lastResync > 1500) { lastResync = Date.now(); sendWatch(true, data.tabId); }
    return;
  }
  overview.handleRecording(kind, data);
  if (kind === 'reset') {
    if (selected === data.tabId) { renderMain(); updateControl(); }
    return;
  }
  if (kind === 'snapshot') {
    if (selected === data.tabId && !screencastTabId) {
      const recording = recordings.get(data.tabId);
      if (mainPlayer?.documentId === recording.documentId) mainPlayer.checkpoint(recording);
      else renderMain();
    }
  } else {
    if (selected === data.tabId && !screencastTabId) mainPlayer?.add(data);
  }
  updateControl();
}

function handleBinaryMessage(buffer) {
  if (buffer.byteLength < 5) return;
  const view = new DataView(buffer);
  const headerLen = view.getUint32(0, false);
  if (4 + headerLen > buffer.byteLength) return;
  const header = JSON.parse(binaryTextDecoder.decode(new Uint8Array(buffer, 4, headerLen)));
  if (header.type === 'screencast-frame') {
    screencastView.renderBinaryFrame(header, new Uint8Array(buffer, 4 + headerLen));
  }
}

function connectLive() {
  if (!authenticated) return;
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    connection(true);
    syncScreencast(true);
    devtoolsPanel.syncTab(true);
    sendWatch();
    sendViewport(true);
    updateReopenButton();
    updateControl();
  });
  socket.addEventListener('message', event => {
    try {
      if (event.data instanceof ArrayBuffer) {
        handleBinaryMessage(event.data);
        return;
      }
      const data = JSON.parse(event.data);
      if (data.type === 'hello') { viewerId = data.viewerId; updateControl(); }
      if (data.type === 'state') updateState(data);
      if (data.type === 'asset-ready') {
        mainPlayer?.refreshAsset(data.id);
        overview.refreshAsset(data.id);
        tabStrip.refreshFavicons([data.id]);
      }
      if (data.type === 'assets-ready' && Array.isArray(data.ids)) {
        mainPlayer?.refreshAssets(data.ids);
        overview.refreshAssets(data.ids);
        tabStrip.refreshFavicons(data.ids);
      }
      if (data.type === 'screencast-frame') screencastView.renderFrame(data);
      if (data.type === 'devtools-snapshot') devtoolsPanel.handleSnapshot(data);
      if (data.type === 'devtools-event') devtoolsPanel.handleEvent(data);
      if (data.type === 'devtools-cleared') devtoolsPanel.handleCleared(data);
      if (data.type.startsWith('rrweb-')) updateRecording(data);
      if (data.type === 'control-result' || data.type === 'control-error') {
        pendingWheelControls.delete(data.requestId);
        pendingControls.delete(data.requestId);
        const failedNodeId = pendingControlTargets.get(data.requestId);
        pendingControlTargets.delete(data.requestId);
        if (!pendingControls.size && $('#operation-status')?.textContent === '远端仍在处理，请不要重复点击') {
          operation('');
        }
        if (data.type === 'control-error') {
          if (Number.isInteger(failedNodeId)) mainPlayer?.rollbackOptimisticInput?.(failedNodeId);
          if (/不允许从回放操作|不支持画面直连/.test(data.error || '')) toast(data.error);
          updateControl();
        }
      }
    } catch { toast('回放事件不完整，正在请求最新快照。'); sendWatch(true); }
  });
  socket.addEventListener('close', () => {
    connection(false, authenticated ? '连接中断，重连中' : '未连接');
    viewerId = null;
    pendingControls.clear();
    pendingWheelControls.clear();
    pendingControlTargets.clear();
    controller.setEnabled(false);
    updateReopenButton();
    updateControl();
    updateDocumentTitle(true);
    if (authenticated) reconnect = setTimeout(async () => {
      try { updateState(await api('/api/state')); connectLive(); }
      catch (error) { if (error.status === 401) showLogin(); else connectLive(); }
    }, 2000);
  });
}

function showLogin() {
  authenticated = false;
  updateDocumentTitle();
  clearTimeout(reconnect);
  socket?.close();
  syncScreencast();
  devtoolsPanel.reset();
  setDrawerOpen(false);
  $('#login').hidden = false;
  $('#workspace').hidden = true;
  if ($('#drawer-footer')) $('#drawer-footer').hidden = true;
  if ($('#browser-caption')) $('#browser-caption').hidden = true;
  mainPlayer?.destroy();
  mainPlayer = null;
  controller.bind(null);
  controller.setEnabled(false);
  overview.clear();
  tabStrip.clear();
  recordings.clear();
  pendingNavSeq.clear();
  pendingNavUrl.clear();
  closingTabs.clear();
  optimisticClosedTabs.clear();
  optimisticNewTabs.clear();
  pendingWheelControls.clear();
  pendingControlTargets.clear();
  creatingCount = 0;
  addressBar.clearDraft();
  autoScreencastHandledDocs.clear();
  dismissedXOriginDocs.clear();
  hideXOriginBanner();
  selected = null;
  pinnedSessionId = null;
  lastFollowedActivityAt = 0;
  setViewMode('browser');
  lastSentViewport = null;
  clearTimeout(viewportTimer);
  viewerId = null;
  remoteActive = null;
  controller.setAvailable(false);
  extensionBadge(true);
  connection(true);
  updateDrawerIndicators();
}

async function showWorkspace() {
  const next = await api('/api/state');
  authenticated = true;
  $('#login').hidden = true;
  $('#workspace').hidden = false;
  if ($('#drawer-footer')) $('#drawer-footer').hidden = !next.authRequired;
  if ($('#service-endpoint')) $('#service-endpoint').textContent = location.origin;
  updateState(next);
  connectLive();
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/session', { method: 'POST', body: JSON.stringify({ token: $('#dashboard-token').value }) });
    $('#dashboard-token').value = '';
    await showWorkspace();
  } catch (error) { toast(error.message); }
});
for (const trigger of document.querySelectorAll('[data-drawer-trigger]')) {
  trigger.addEventListener('click', () => { if (authenticated) setDrawerOpen(!drawerOpen); });
}
for (const trigger of document.querySelectorAll('[data-view-toggle]')) {
  trigger.addEventListener('click', () => {
    if (!authenticated) return;
    setViewMode(viewMode === 'overview' ? 'browser' : 'overview');
  });
}
$('#drawer-close')?.addEventListener('click', () => setDrawerOpen(false));
$('#drawer-backdrop')?.addEventListener('click', () => setDrawerOpen(false));
$('#logout').addEventListener('click', async () => {
  try { await api('/api/session', { method: 'DELETE' }); } catch { /* Clear local replay even when disconnected. */ }
  $('#cookiecloud-config').textContent = '';
  $('#cookiecloud-config').hidden = true;
  showLogin();
});

function applyTabLayout(vertical, persist = false) {
  const shell = $('.browser-shell');
  if (!shell) return;
  shell.classList.toggle('vertical-tabs', vertical);
  $('#overview')?.classList.toggle('vertical-tabs', vertical);
  $('#tab-list')?.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
  const mode = vertical ? 'vertical' : 'horizontal';
  for (const button of document.querySelectorAll('#tab-layout-switcher .seg-option')) {
    const active = button.dataset.layout === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (persist) {
    try { localStorage.setItem('ditto_tab_layout', mode); } catch { /* ignore */ }
  }
  updateNavigation();
  requestAnimationFrame(() => { mainPlayer?.fit(); screencastView.fit(); });
}
if ($('#tab-layout-switcher')) {
  let savedVertical = false;
  try { savedVertical = localStorage.getItem('ditto_tab_layout') === 'vertical'; } catch { /* ignore */ }
  applyTabLayout(savedVertical);
  for (const button of document.querySelectorAll('#tab-layout-switcher .seg-option')) {
    button.addEventListener('click', () => applyTabLayout(button.dataset.layout === 'vertical', true));
  }
}

function applyTheme(mode, persist = false) {
  const normalized = ['system', 'light', 'dark'].includes(mode) ? mode : 'dark';
  document.documentElement.dataset.theme = normalized;
  for (const button of document.querySelectorAll('#theme-switcher .theme-option')) {
    const active = button.dataset.themeValue === normalized;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (persist) {
    try { localStorage.setItem('ditto_theme', normalized); } catch { /* ignore */ }
  }
}
if ($('#theme-switcher')) {
  for (const button of document.querySelectorAll('#theme-switcher .theme-option')) {
    button.replaceChildren(createThemeIcon(button.dataset.themeValue));
    button.addEventListener('click', () => applyTheme(button.dataset.themeValue, true));
  }
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem('ditto_theme') || 'dark'; } catch { /* ignore */ }
  applyTheme(savedTheme);
}

function applyViewportMode(mode, persist = false) {
  viewportMode = mode === 'fixed' ? 'fixed' : 'adaptive';
  for (const button of document.querySelectorAll('#viewport-mode-switcher .seg-option')) {
    const active = button.dataset.viewportMode === viewportMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (persist) {
    try { localStorage.setItem('ditto_viewport_mode', viewportMode); } catch { /* ignore */ }
  }
  sendViewport(true);
}
if ($('#viewport-mode-switcher')) {
  let savedViewport = 'adaptive';
  try { savedViewport = localStorage.getItem('ditto_viewport_mode') === 'fixed' ? 'fixed' : 'adaptive'; } catch { /* ignore */ }
  applyViewportMode(savedViewport);
  for (const button of document.querySelectorAll('#viewport-mode-switcher .seg-option')) {
    button.addEventListener('click', () => applyViewportMode(button.dataset.viewportMode, true));
  }
}

if ($('#screencast-toggle')) {
  let savedScreencast = false;
  try { savedScreencast = localStorage.getItem('ditto_screencast_mode') === '1'; } catch { /* ignore */ }
  applyScreencastMode(savedScreencast);
  $('#screencast-toggle').addEventListener('change', event => {
    const enabled = Boolean(event.target.checked);
    if (!enabled && selected) {
      const docId = recordings.get(selected)?.documentId || mainPlayer?.documentId;
      if (docId) autoScreencastHandledDocs.add(docId);
    }
    applyScreencastMode(enabled, true);
    operation(enabled ? '已全局开启画面直连模式' : '已切换回轻量 DOM 回放模式');
  });
}
if ($('#screencast-quality-switcher')) {
  let savedQuality = null;
  try { savedQuality = localStorage.getItem('ditto_screencast_quality'); } catch { /* ignore */ }
  if (savedQuality) {
    screencastQualityOverride = true;
    applyScreencastQuality(savedQuality);
  } else {
    applyScreencastQuality(screencastQuality);
  }
  const labels = { smooth: '流畅', balanced: '均衡', high: '高清', lossless: '无损 PNG' };
  for (const button of document.querySelectorAll('#screencast-quality-switcher .seg-option')) {
    button.addEventListener('click', () => {
      const next = button.dataset.scQuality;
      applyScreencastQuality(next, true);
      operation(`画面清晰度已切换为${labels[next] || next}`);
    });
  }
}
if ($('#screencast-retina-toggle')) {
  let savedRetina = null;
  try { savedRetina = localStorage.getItem('ditto_screencast_retina'); } catch { /* ignore */ }
  if (savedRetina !== null) {
    screencastRetinaOverride = true;
    applyScreencastRetina(savedRetina === '1');
  } else {
    applyScreencastRetina(screencastRetina);
  }
  $('#screencast-retina-toggle').addEventListener('change', event => {
    const enabled = Boolean(event.target.checked);
    applyScreencastRetina(enabled, true);
    operation(enabled ? '已开启 Retina 2x 高分屏推流' : '已切换回 1x 标准分辨率推流');
  });
}

$('#new-tab').addEventListener('click', newTab);
$('.tab-strip')?.addEventListener('dblclick', event => {
  if (event.target === $('.tab-strip') || event.target === $('#tab-list')) newTab();
});
$('#overview-new-tab')?.addEventListener('click', newTab);
$('#overview-close-others')?.addEventListener('click', () => browserAction('close-others'));
$('#xorigin-switch-screencast')?.addEventListener('click', () => {
  applyScreencastMode(true, true);
  operation('已全局开启画面直连模式');
});
$('#xorigin-dismiss')?.addEventListener('click', () => {
  if (bannerReason === 'limited') {
    const tab = findTab(selected);
    const docId = tab?.documentId || tab?.id;
    if (docId) {
      dismissedLimitedDocs.add(docId);
      if (dismissedLimitedDocs.size > 100) dismissedLimitedDocs.delete(dismissedLimitedDocs.values().next().value);
    }
  } else if (mainPlayer?.documentId) {
    dismissedXOriginDocs.add(mainPlayer.documentId);
    if (dismissedXOriginDocs.size > 100) dismissedXOriginDocs.delete(dismissedXOriginDocs.values().next().value);
  }
  hideXOriginBanner();
});
document.addEventListener('pointerdown', event => {
  const menu = $('#tab-context-menu');
  if (menu && !menu.hidden && !menu.contains(event.target)) tabStrip.closeContextMenu();
  const browserMenu = $('.browser-menu');
  if (browserMenu.open && !browserMenu.contains(event.target)) browserMenu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    tabStrip.closeContextMenu();
    const menu = $('.browser-menu');
    if (menu.open) { menu.open = false; return; }
    if (drawerOpen) { setDrawerOpen(false); return; }
    if (viewMode === 'overview') { setViewMode('browser'); return; }
    if (authenticated && selected && document.activeElement !== $('#address-bar') && !devtoolsPanel.isFocused() && isTabLoading(selected)) {
      event.preventDefault();
      browserAction('stop');
    }
    return;
  }
  if (!authenticated) return;
  const devtoolsShortcut = event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'i';
  if (devtoolsShortcut && viewMode !== 'overview') {
    event.preventDefault();
    devtoolsPanel.toggle();
    return;
  }
  if (controller.isEditing() || document.activeElement === $('#address-bar') || devtoolsPanel.isFocused()) return;
  const backShortcut = (event.altKey && !event.ctrlKey && !event.metaKey && event.key === 'ArrowLeft')
    || (event.metaKey && !event.ctrlKey && !event.altKey && event.key === '[');
  const forwardShortcut = (event.altKey && !event.ctrlKey && !event.metaKey && event.key === 'ArrowRight')
    || (event.metaKey && !event.ctrlKey && !event.altKey && event.key === ']');
  if (backShortcut && !$('#back-tab').disabled) { event.preventDefault(); browserAction('back'); }
  else if (forwardShortcut && !$('#forward-tab').disabled) { event.preventDefault(); browserAction('forward'); }
});
$('#reload-tab').addEventListener('click', () => {
  if (!selected) return;
  browserAction(isTabLoading(selected) ? 'stop' : 'reload');
});
$('#back-tab').addEventListener('click', () => browserAction('back'));
$('#forward-tab').addEventListener('click', () => browserAction('forward'));

function setViewMode(mode) {
  viewMode = mode === 'overview' ? 'overview' : 'browser';
  const isOverview = viewMode === 'overview';
  $('#overview').hidden = !isOverview;
  const shell = $('.browser-shell');
  if (shell) shell.hidden = isOverview;
  for (const button of document.querySelectorAll('#view-switcher .seg-option')) {
    const active = button.dataset.view === viewMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  for (const trigger of document.querySelectorAll('[data-view-toggle]')) {
    trigger.setAttribute('aria-pressed', String(isOverview));
    const label = isOverview ? '返回浏览器视图' : '全部标签页总览';
    trigger.title = label;
    trigger.setAttribute('aria-label', label);
  }
  syncScreencast();
  sendWatch();
  if (isOverview) {
    addressBar.closeSuggestions();
    overview.enterOverview();
  } else {
    overview.leaveOverview();
    requestAnimationFrame(() => {
      if (screencastTabId) screencastView.fit();
      else if (!mainPlayer) renderMain();
      else mainPlayer.fit();
      sendViewport(false);
    });
  }
}
for (const button of document.querySelectorAll('#view-switcher .seg-option')) {
  button.addEventListener('click', () => {
    setViewMode(button.dataset.view);
    setDrawerOpen(false);
  });
}

$('#reopen-tab').addEventListener('click', async () => {
  $('.browser-menu').open = false;
  const tab = state?.browser.tabs.find(item => item.id === selected);
  const url = reopenUrl(tab?.url);
  if (!url || reopening) return;
  reopening = true;
  updateReopenButton();
  try {
    const result = await api('/api/tabs', { method: 'POST', body: JSON.stringify({ url, viewerId }) });
    updateState(await api('/api/state'));
    selectTab(result.tabId);
    toast('已在新标签页重新打开远端网页，旧页面保留。');
  } catch (error) { toast(error.message); }
  finally { reopening = false; updateReopenButton(); }
});
$('#request-cookies').addEventListener('click', async () => {
  $('.browser-menu').open = false;
  const tab = state?.browser.tabs.find(item => item.id === selected);
  if (!tab?.url) return;
  try {
    const origin = new URL(tab.url).origin;
    operation('正在从主力机同步登录态…', 'pending');
    const result = await api('/api/sync/request', {
      method: 'POST',
      body: JSON.stringify({ origin, url: tab.url, tabId: selected, wait: true }),
    });
    updateState(await api('/api/state'));
    if (result.synced) {
      operation('已同步登录态并刷新页面');
      const missing = result.missingStorageOrigins?.length
        ? `（提示：主力机未打开 ${result.missingStorageOrigins[0]}，仅同步了 Cookie）`
        : '';
      toast(`已从主力机重新同步登录态并刷新当前页面。${missing}`);
    } else {
      operation('');
      toast('已向主力机扩展请求同步；请确认主力机扩展在线。');
    }
  } catch (error) {
    operation(error.message, 'error');
    toast(error.message);
  }
});
$('#copy-selection')?.addEventListener('click', async () => {
  $('.browser-menu').open = false;
  if (!selected) return;
  try {
    const { text } = await api(`/api/tabs/${encodeURIComponent(selected)}/selection`, { method: 'POST' });
    if (!text) { toast('远端页面当前没有选中文本。'); return; }
    await copyText(text);
    toast(`已复制 ${text.length} 个字符到本机剪贴板。`);
  } catch (error) { toast(error.message); }
});
$('#upload-file')?.addEventListener('click', () => {
  $('.browser-menu').open = false;
  if (!selected) return;
  $('#remote-file-upload').value = '';
  $('#remote-file-upload').click();
});
$('#remote-file-upload')?.addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file || !selected) return;
  if (file.size > 20 * 1024 * 1024) { toast('单文件上传不能超过 20MB。'); return; }
  try {
    operation(`正在上传 ${file.name}…`, 'pending');
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const contentBase64 = btoa(binary);
    await api(`/api/tabs/${encodeURIComponent(selected)}/upload`, {
      method: 'POST',
      body: JSON.stringify({ name: file.name, mimeType: file.type || 'application/octet-stream', contentBase64 }),
    });
    operation(`已上传 ${file.name}`);
    toast(`已将 ${file.name} 填入当前页面文件控件。`);
  } catch (error) {
    operation(error.message, 'error');
    toast(error.message);
  }
});

setInterval(() => {
  if (pendingControls.size && Date.now() - Math.min(...pendingControls.values()) > 5000) operation('远端仍在处理，请不要重复点击', 'pending');
}, 1000);
$('#copy-pairing').addEventListener('click', async () => {
  try {
    const pairing = await api('/api/pairing');
    const text = pairing.authRequired
      ? JSON.stringify({ endpoint: pairing.endpoint, syncToken: pairing.syncToken })
      : pairing.endpoint;
    await copyText(text);
    toast(pairing.authRequired ? '连接配置已复制，请粘贴到 Ditto 浏览器扩展。' : `已复制服务地址 ${pairing.endpoint}，填入 Ditto 浏览器扩展即可连接。`);
  } catch (error) { toast(error.message); }
});
$('#show-cookiecloud').addEventListener('click', async () => {
  if (!$('#cookiecloud-config').hidden) {
    $('#cookiecloud-config').hidden = true;
    $('#cookiecloud-config').textContent = '';
    return;
  }
  try {
    const pairing = await api('/api/pairing');
    $('#cookiecloud-config').textContent = [
      `工作模式：上传`, `服务器地址：${pairing.endpoint}/cookiecloud`,
      `UUID：${pairing.cookieCloud.uuid}`, `密码：${pairing.cookieCloud.password}`,
      `额外 Header：Authorization:Bearer ${pairing.syncToken}`,
      '加密算法：legacy 或 aes-128-cbc-fixed', '域名名单：CookieCloud 仍只上传你在它自己的配置里填写的网站', 'localStorage：开启',
    ].join('\n');
    $('#cookiecloud-config').hidden = false;
  } catch (error) { toast(error.message); }
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.getRegistrations()
    .then(registrations => Promise.all(registrations.map(reg => reg.unregister())))
    .catch(() => {});
}
if ('caches' in window && window.isSecureContext) {
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('ditto-shell-')).map(key => caches.delete(key))))
    .catch(() => {});
}

let loginRecheckAt = 0;
let loginRechecking = false;
async function recheckLoginSession() {
  if (authenticated || $('#login').hidden || loginRechecking) return;
  const now = Date.now();
  if (now - loginRecheckAt < 1500) return;
  loginRecheckAt = now;
  loginRechecking = true;
  try {
    await showWorkspace();
  } catch { /* Still unauthenticated; stay quietly on login panel. */ }
  finally { loginRechecking = false; }
}
window.addEventListener('focus', () => { recheckLoginSession(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recheckLoginSession();
});

async function bootstrap() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('token');
  if (token) history.replaceState(null, '', `${location.pathname}${location.search}`);
  try {
    if (token) await api('/api/session', { method: 'POST', body: JSON.stringify({ token }) });
    await showWorkspace();
  } catch (error) { showLogin(); if (token) toast(error.message); }
}
bootstrap();
