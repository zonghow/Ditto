import { AutoSync } from './auto-sync.js';
import { installViewerSessionCookie, originOf, syncEndpoint } from './capture.js';

// MV3 WebSocket heartbeat keeps the worker alive while Chrome is running.
// Background sync combines:
//   1. Full-profile Cookie + open-tab Storage sync on connect and every 5 minutes
//   2. Active push whenever the user opens or loads a web tab
//   3. Immediate response to explicit remote sync demands
const FULL_SYNC_ALARM = 'ditto-full-sync';
const RECONNECT_ALARM = 'ditto-sync-reconnect';
const TAB_SYNC_DEBOUNCE_MS = 2000;
const TAB_SYNC_COOLDOWN_MS = 15000;

const engine = new AutoSync({ notify: status => chrome.storage.local.set({ autoSyncStatus: status }).catch(() => {}) });
let socket = null;
let endpoint = null;
let token = null;
let heartbeat = null;
let retry = null;
let lastMessage = 0;
let loading = Promise.resolve();
let syncedOnThisConnection = false;

const pendingTabOrigins = new Set();
const recentTabSyncAt = new Map();
let tabSyncTimer = null;

function scheduleTabOriginSync(rawUrl, { force = false } = {}) {
  if (!engine.enabled || !engine.settings?.endpoint || !rawUrl) return;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
  const origin = parsed.origin;
  if (endpoint && origin === endpoint && ['/', '/index.html'].includes(parsed.pathname)) return;
  const now = Date.now();
  if (!force && now - (recentTabSyncAt.get(origin) || 0) < TAB_SYNC_COOLDOWN_MS) return;
  pendingTabOrigins.add(origin);
  clearTimeout(tabSyncTimer);
  tabSyncTimer = setTimeout(() => {
    tabSyncTimer = null;
    if (!pendingTabOrigins.size) return;
    const batch = [...pendingTabOrigins];
    pendingTabOrigins.clear();
    const ts = Date.now();
    for (const item of batch) recentTabSyncAt.set(item, ts);
    if (recentTabSyncAt.size > 200) {
      for (const [key, at] of recentTabSyncAt) {
        if (ts - at > 60000) recentTabSyncAt.delete(key);
      }
    }
    engine.syncTabOrigins(batch);
  }, TAB_SYNC_DEBOUNCE_MS);
}

function disconnect() {
  clearInterval(heartbeat);
  clearTimeout(retry);
  clearTimeout(tabSyncTimer);
  tabSyncTimer = null;
  pendingTabOrigins.clear();
  const old = socket;
  socket = null;
  old?.close();
  endpoint = null;
  token = null;
  syncedOnThisConnection = false;
  engine.resetDelta();
  engine.setConnection('offline');
}

async function searchLocalHistory(query, limit) {
  const text = typeof query === 'string' ? query.slice(0, 200) : '';
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 25);
  const merged = new Map();
  const push = (rawUrl, rawTitle, visitCount = 1, lastVisited = 0) => {
    if (typeof rawUrl !== 'string' || rawUrl.length > 2048) return;
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
    if (endpoint && parsed.origin === endpoint) return;
    const url = parsed.href;
    const title = typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    const prev = merged.get(url);
    if (!prev || lastVisited > prev.lastVisited) {
      merged.set(url, {
        url,
        title: title || prev?.title || url,
        visitCount: Math.max(Number(visitCount) || 1, prev?.visitCount || 1),
        lastVisited: Math.max(Number(lastVisited) || 0, prev?.lastVisited || 0),
      });
    }
  };
  if (chrome.history?.search) {
    try {
      const items = await chrome.history.search({ text, startTime: 0, maxResults: 40 });
      for (const item of items || []) {
        push(item.url, item.title, item.visitCount, item.lastVisitTime);
      }
    } catch { /* History permission unavailable */ }
  }
  if (chrome.tabs?.query) {
    try {
      const tokens = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs || []) {
        if (tab.incognito || !tab.url) continue;
        const hay = `${tab.url} ${tab.title || ''}`.toLowerCase();
        if (tokens.every(token => hay.includes(token))) {
          push(tab.url, tab.title, 10, Date.now());
        }
      }
    } catch { /* ignore */ }
  }
  return [...merged.values()]
    .sort((a, b) => b.lastVisited - a.lastVisited)
    .slice(0, cap);
}

function connect() {
  if (!engine.enabled || !engine.settings?.endpoint) { disconnect(); return; }
  const next = syncEndpoint(engine.settings);
  const nextToken = engine.settings.syncToken || '';
  if (socket && endpoint === next && token === nextToken) return;
  disconnect();
  endpoint = next;
  token = nextToken;
  const ws = new WebSocket(`${next.replace(/^http/, 'ws')}/api/sync/live`);
  socket = ws;
  syncedOnThisConnection = false;
  engine.setConnection('connecting');
  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    // Private token (when enabled) is in the first frame, not URLs/browser history or logs.
    ws.send(JSON.stringify(token ? { type: 'authenticate', token } : { type: 'authenticate' }));
    lastMessage = Date.now();
    heartbeat = setInterval(() => {
      if (socket !== ws) return;
      if (Date.now() - lastMessage > 60000) { ws.close(); return; }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' }));
    }, 20000);
  });
  ws.addEventListener('message', event => {
    if (socket !== ws) return;
    lastMessage = Date.now();
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'sync-requests') {
        if (typeof message.viewerSession === 'string' && message.viewerSession && endpoint) {
          installViewerSessionCookie(endpoint, message.viewerSession).catch(() => {});
        }
        engine.lastError = null;
        engine.setConnection('online');
        engine.accept(message);
        if (!syncedOnThisConnection) {
          syncedOnThisConnection = true;
          engine.fullSync();
        }
        engine.automatic();
      } else if (message.type === 'history-search' && typeof message.requestId === 'string' && message.requestId.length <= 64) {
        searchLocalHistory(message.query, message.limit).then(items => {
          if (socket === ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'history-results', requestId: message.requestId, items }));
          }
        }).catch(() => {});
      }
    } catch { /* No untrusted protocol body in diagnostics. */ }
  });
  ws.addEventListener('close', event => {
    if (socket !== ws) return;
    socket = null;
    syncedOnThisConnection = false;
    clearInterval(heartbeat);
    engine.resetDelta();
    const authRejected = event?.code === 1008;
    if (authRejected) engine.lastError = 'Token 无效或已变更，请点击「切换」重新输入 Token。';
    engine.setConnection('offline');
    retry = setTimeout(() => reload(), authRejected ? 30000 : 5000);
  });
  ws.addEventListener('error', () => {});
}

function reload() {
  const operation = loading.then(async () => {
    const saved = await chrome.storage.local.get(['settings', 'origins']);
    try {
      engine.configure(saved);
      connect();
      engine.automatic();
    } catch { engine.configure({}); disconnect(); }
  });
  loading = operation.catch(() => {});
  return operation;
}

const newTabIds = new Set();
chrome.tabs?.onCreated?.addListener(tab => {
  if (tab.incognito || tab.id === undefined) return;
  newTabIds.add(tab.id);
  const candidate = tab.url || tab.pendingUrl;
  if (candidate && tab.status === 'complete') {
    newTabIds.delete(tab.id);
    reload().then(() => scheduleTabOriginSync(candidate, { force: true }));
  }
});
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (tab?.incognito || changeInfo.status !== 'complete' || !tab?.url) return;
  const isNew = newTabIds.delete(tabId);
  reload().then(() => scheduleTabOriginSync(tab.url, { force: isNew }));
});
chrome.tabs?.onRemoved?.addListener(tabId => { newTabIds.delete(tabId); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['settings', 'origins'].some(name => name in changes)) reload();
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'sync-now') {
    reload().then(() => engine.manual()).then(pending => reply({ ok: true, pending }),
      () => reply({ ok: false, error: '同步未完成，请检查开发机服务连接后重试。' }));
    return true;
  }
  if (message?.type === 'sync-status') {
    reload().then(() => reply({ ok: true, status: engine.status() }));
    return true;
  }
  return false;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RECONNECT_ALARM) {
    reload();
  } else if (alarm.name === FULL_SYNC_ALARM) {
    reload().then(() => engine.fullSync());
  }
});

function refreshActionIcon() {
  globalThis.chrome?.action?.setIcon?.({
    path: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  })?.catch?.(() => {});
}

chrome.runtime.onStartup.addListener(() => { refreshActionIcon(); reload(); });
chrome.runtime.onInstalled.addListener(() => { refreshActionIcon(); reload(); });
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
chrome.alarms.create(FULL_SYNC_ALARM, { periodInMinutes: 5 });
refreshActionIcon();
reload();
