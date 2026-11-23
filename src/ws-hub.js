import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { constantEqual, validHost, allowedOrigin } from './auth.js';
import { InputError } from './snapshot.js';
import { PRE_SERIALIZED_EVENTS, attachPreSerialized, serializeRecordingMessage } from './recording.js';

const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
export const MAX_SCREENCAST_BUFFERED_BYTES = 512 * 1024;

// Binary screencast wire format:
//   [4-byte uint32BE headerLength][UTF-8 JSON metadata header][raw JPEG bytes]
export function encodeBinaryScreencastFrame(frame) {
  const headerJson = JSON.stringify({
    type: 'screencast-frame',
    tabId: frame.tabId,
    width: frame.width,
    height: frame.height,
    timestamp: frame.timestamp,
  });
  const headerBuf = Buffer.from(headerJson, 'utf8');
  const jpegBuf = Buffer.isBuffer(frame.rawBuffer)
    ? frame.rawBuffer
    : Buffer.from(typeof frame.data === 'string' ? frame.data : '', 'base64');
  const packet = Buffer.allocUnsafe(4 + headerBuf.length + jpegBuf.length);
  packet.writeUInt32BE(headerBuf.length, 0);
  headerBuf.copy(packet, 4);
  jpegBuf.copy(packet, 4 + headerBuf.length);
  return packet;
}

export function createWsHub({
  server,
  credentials,
  authRequired,
  isDashboardAllowed,
  browser,
  sync,
  cookieRequests,
  historyStore,
  log,
  safeUrl,
}) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: {
      threshold: 1024,
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      zlibDeflateOptions: { level: 6, memLevel: 7 },
    },
  });
  const syncWss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });

  const hasConnectedExtension = () => [...syncWss.clients].some(ws => ws.readyState === WebSocket.OPEN && ws.authenticated);
  const connectedExtensionCount = () => [...syncWss.clients].filter(ws => ws.readyState === WebSocket.OPEN && ws.authenticated).length;

  const pendingHistorySearches = new Map();
  const sanitizeHistoryItems = items => {
    if (!Array.isArray(items)) return [];
    const clean = [];
    for (const item of items.slice(0, 25)) {
      if (typeof item?.url !== 'string' || item.url.length > 2048) continue;
      let parsed;
      try { parsed = new URL(item.url); } catch { continue; }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      const title = typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      clean.push({
        url: parsed.href,
        title: title || parsed.href,
        visitCount: Number.isFinite(item.visitCount) && item.visitCount > 0 ? Math.min(Math.round(item.visitCount), 100000) : 1,
        lastVisited: Number.isFinite(item.lastVisited) && item.lastVisited > 0 ? item.lastVisited : 0,
      });
    }
    return clean;
  };

  const sendRaw = (ws, serialized) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount >= MAX_BUFFERED_BYTES) {
      // Dropping DOM mutations silently corrupts replay. Reconnect instead so
      // the viewer receives a complete checkpoint and discards old input.
      ws.close(1013, 'Replay resynchronization required');
      return;
    }
    ws.send(serialized);
  };
  const send = (ws, data) => sendRaw(ws, JSON.stringify(data));
  const broadcast = data => {
    if (!wss.clients.size) return;
    const serialized = JSON.stringify(data);
    for (const ws of wss.clients) sendRaw(ws, serialized);
  };

  const queryExtensionHistory = (query, limit = 20, timeoutMs = 800) => new Promise(resolve => {
    const client = [...syncWss.clients].find(ws => ws.readyState === WebSocket.OPEN && ws.authenticated);
    if (!client || pendingHistorySearches.size >= 24) { resolve([]); return; }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pendingHistorySearches.delete(requestId);
      resolve([]);
    }, timeoutMs);
    timer.unref?.();
    pendingHistorySearches.set(requestId, { client, timer, resolve });
    send(client, { type: 'history-search', requestId, query: String(query || '').slice(0, 200), limit });
  });

  const viewerWantsTab = (ws, tabId) => {
    if (ws.paused) return false;
    if (ws.screencastTabId === tabId) return false;
    if (ws.viewMode === 'overview') return true;
    return !ws.watchedTabId || ws.watchedTabId === tabId;
  };

  const sendRecordingToViewer = (ws, item) => {
    if (!item) return;
    sendRaw(ws, serializeRecordingMessage(item));
    if (item.type === 'rrweb-snapshot') {
      ws.sentSnapshots.set(item.tabId, item.documentId);
    }
  };

  const statePayload = () => ({
    type: 'state',
    browser: browser.summary(),
    sync: sync.summary(),
    cookieSync: cookieRequests.summary(sync.summary()),
    authRequired,
    extensionConnected: hasConnectedExtension(),
  });
  const state = () => broadcast(statePayload());

  const syncState = () => {
    if (!syncWss.clients.size) return;
    const serialized = JSON.stringify({ type: 'sync-requests', ...cookieRequests.summary(sync.summary()) });
    for (const ws of syncWss.clients) if (ws.authenticated) sendRaw(ws, serialized);
  };

  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/api/sync/live') {
      if (!validHost(request.headers.host) || !allowedOrigin(request, true) || !request.headers.origin?.startsWith('chrome-extension://')) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      syncWss.handleUpgrade(request, socket, head, ws => syncWss.emit('connection', ws, request));
      return;
    }
    if (request.url !== '/api/live' || !validHost(request.headers.host)
      || !allowedOrigin(request) || !isDashboardAllowed(request)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });

  syncWss.on('connection', ws => {
    ws.authenticated = false;
    const timeout = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!ws.authenticated) {
          if (message.type !== 'authenticate' || (authRequired && !constantEqual(message.token, credentials.syncToken))) {
            ws.close(1008, 'Authentication required');
            return;
          }
          ws.authenticated = true;
          clearTimeout(timeout);
          log('ext', `connected (clients=${connectedExtensionCount()})`);
          send(ws, { type: 'sync-requests', ...cookieRequests.summary(sync.summary()) });
          state();
        } else if (message.type === 'heartbeat') {
          send(ws, { type: 'sync-requests', ...cookieRequests.summary(sync.summary()) });
        } else if (message.type === 'history-results' && typeof message.requestId === 'string') {
          const pending = pendingHistorySearches.get(message.requestId);
          if (pending && pending.client === ws) {
            pendingHistorySearches.delete(message.requestId);
            clearTimeout(pending.timer);
            pending.resolve(sanitizeHistoryItems(message.items));
          }
        } else ws.close(1008, 'Unsupported sync message');
      } catch { ws.close(1008, 'Invalid sync message'); }
    });
    ws.on('close', () => {
      clearTimeout(timeout);
      for (const [reqId, pending] of pendingHistorySearches) {
        if (pending.client !== ws) continue;
        pendingHistorySearches.delete(reqId);
        clearTimeout(pending.timer);
        pending.resolve([]);
      }
      if (ws.authenticated) log('ext', `disconnected (clients=${connectedExtensionCount()})`);
      state();
    });
    ws.on('error', () => {});
  });

  const pendingEvents = new Map();
  const lastControlAtByTab = new Map();
  let eventTimer;
  const flushEvents = () => {
    clearTimeout(eventTimer);
    eventTimer = null;
    if (!wss.clients.size) { pendingEvents.clear(); return; }
    for (const data of pendingEvents.values()) {
      let serialized = null;
      for (const ws of wss.clients) {
        if (!viewerWantsTab(ws, data.tabId)) continue;
        if (serialized === null) serialized = serializeRecordingMessage(data);
        sendRaw(ws, serialized);
      }
    }
    pendingEvents.clear();
  };

  const recording = data => {
    if (data.type === 'rrweb-events') {
      const incomingJsons = data[PRE_SERIALIZED_EVENTS];
      const previous = pendingEvents.get(data.tabId);
      if (previous && previous.documentId === data.documentId && previous.lastSequence + 1 === data.firstSequence) {
        previous.events.push(...data.events);
        previous.lastSequence = data.lastSequence;
        previous.serverTime = data.serverTime;
        const prevJsons = previous[PRE_SERIALIZED_EVENTS];
        if (Array.isArray(prevJsons) && Array.isArray(incomingJsons)) {
          prevJsons.push(...incomingJsons);
        } else if (prevJsons) {
          delete previous[PRE_SERIALIZED_EVENTS];
        }
      } else {
        const batch = { ...data, events: [...data.events] };
        if (Array.isArray(incomingJsons)) attachPreSerialized(batch, [...incomingJsons]);
        pendingEvents.set(data.tabId, batch);
      }
      // Flush interactive frames (scroll, input, mouse interaction, or any DOM
      // mutation within 500ms of a user control command) immediately instead of
      // adding a 16ms batching stall.
      const hasInteractiveEvent = data.events?.some(e => e.type === 3 && (e.data?.source === 3 || e.data?.source === 5 || e.data?.source === 2));
      const recentlyControlled = (Date.now() - (lastControlAtByTab.get(data.tabId) || 0)) < 500;
      if (hasInteractiveEvent || recentlyControlled) flushEvents();
      else eventTimer ||= setTimeout(flushEvents, 16);
      return;
    }
    // A full checkpoint supersedes prior mutations; never send the stale batch
    // after it. A document reset invalidates both input and the old replay.
    pendingEvents.delete(data.tabId);
    if (data.type === 'rrweb-reset') lastControlAtByTab.delete(data.tabId);
    if (!wss.clients.size) return;
    let serialized = null;
    for (const ws of wss.clients) {
      if (!viewerWantsTab(ws, data.tabId)) {
        if (data.type === 'rrweb-reset') ws.sentSnapshots.delete(data.tabId);
        continue;
      }
      if (serialized === null) serialized = serializeRecordingMessage(data);
      sendRaw(ws, serialized);
      if (data.type === 'rrweb-snapshot') ws.sentSnapshots.set(data.tabId, data.documentId);
      else if (data.type === 'rrweb-reset') ws.sentSnapshots.delete(data.tabId);
    }
  };

  const pendingAssetIds = new Set();
  let assetTimer = null;
  const flushAssets = () => {
    clearTimeout(assetTimer);
    assetTimer = null;
    if (!pendingAssetIds.size || !wss.clients.size) { pendingAssetIds.clear(); return; }
    const ids = [...pendingAssetIds];
    pendingAssetIds.clear();
    broadcast(ids.length === 1 ? { type: 'asset-ready', id: ids[0] } : { type: 'assets-ready', ids });
  };
  const onAssetReady = event => {
    if (!event?.id) return;
    pendingAssetIds.add(event.id);
    assetTimer ||= setTimeout(flushAssets, 50);
  };

  const onScreencastFrame = frame => {
    if (!wss.clients.size) return;
    let binaryPacket = null;
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.paused || ws.screencastTabId !== frame.tabId) continue;
      if (frame.targetViewerId && ws.viewerId !== frame.targetViewerId) continue;
      // Backpressure for live video frames: silently drop excess JPEG frames
      // instead of disconnecting the viewer WebSocket.
      if (ws.bufferedAmount > MAX_SCREENCAST_BUFFERED_BYTES) continue;
      if (binaryPacket === null) binaryPacket = encodeBinaryScreencastFrame(frame);
      // JPEG bytes are already compressed; skip perMessageDeflate zlib work.
      ws.send(binaryPacket, { binary: true, compress: false });
    }
  };

  const onTabCrashed = ({ tabId, url }) => log('browser', `tab crashed tab=${String(tabId || '').slice(0, 8)} url=${safeUrl(url)}`);
  const onVisit = ({ url, title } = {}) => { if (url) historyStore.record(url, title); };

  cookieRequests.on('change', syncState);
  cookieRequests.on('change', state);
  browser.on('change', state);
  browser.on('recording', recording);
  browser.on('asset', onAssetReady);
  browser.on('screencast-frame', onScreencastFrame);
  browser.on('tab-crashed', onTabCrashed);
  browser.on('visit', onVisit);
  sync.on('change', state);

  let observeOriginHandler = null;
  let syncChangedHandler = null;

  const attachSyncHooks = ({ recordAppliedOrigins, observeOrigin }) => {
    observeOriginHandler = observeOrigin;
    syncChangedHandler = () => { recordAppliedOrigins(); cookieRequests.reconcile(sync.summary()); syncState(); };
    browser.on('cookie-origin', observeOriginHandler);
    sync.on('change', syncChangedHandler);
    for (const tab of browser.summary().tabs) observeOriginHandler(tab.url);
    cookieRequests.reconcile(sync.summary());
  };

  wss.on('connection', (ws, request) => {
    const id = randomUUID();
    ws.alive = true;
    ws.paused = false;
    ws.request = request;
    ws.queuedControls = 0;
    ws.viewerId = id;
    ws.watchedTabId = null;
    ws.viewMode = 'browser';
    ws.screencastTabId = null;
    ws.sentSnapshots = new Map();
    ws.rateWindow = Date.now();
    ws.rateCount = 0;
    browser.setViewer(id, null, false, 'browser');
    send(ws, { type: 'hello', viewerId: id });
    const initial = statePayload();
    send(ws, initial);
    const initialTabId = initial.browser.activeTabId || initial.browser.tabs[0]?.id || null;
    if (initialTabId && browser.cachedRecording) {
      const snap = browser.cachedRecording(initialTabId);
      if (snap) sendRecordingToViewer(ws, snap);
      else {
        const first = browser.cachedRecordings()[0];
        if (first) sendRecordingToViewer(ws, first);
      }
    } else {
      for (const data of browser.cachedRecordings()) sendRecordingToViewer(ws, data);
    }
    ws.on('message', async raw => {
      try {
        if (!isDashboardAllowed(request)) { ws.close(1008, 'Session expired'); return; }
        const data = JSON.parse(raw.toString());
        if (Date.now() - ws.rateWindow >= 1000) { ws.rateWindow = Date.now(); ws.rateCount = 0; }
        if (++ws.rateCount > 300) {
          if ((data.type === 'control' && (data.action === 'move' || data.action === 'wheel'))
            || (data.type === 'screencast-input' && (data.action === 'mousemove' || data.action === 'wheel'))) return;
          throw new InputError('操作过快，请稍后重试。', 429);
        }
        if (data.type === 'watch') {
          if ((data.tabId !== null && (typeof data.tabId !== 'string' || data.tabId.length > 100)) || typeof data.paused !== 'boolean') throw new InputError('观测请求无效。');
          const wasPaused = ws.paused;
          const prevTabId = ws.watchedTabId;
          const prevMode = ws.viewMode;
          ws.paused = data.paused;
          ws.watchedTabId = data.tabId;
          ws.viewMode = data.viewMode === 'overview' ? 'overview' : 'browser';
          browser.setViewer(id, ws.watchedTabId, ws.paused, ws.viewMode);
          if (!ws.paused) {
            const getOne = tid => browser.cachedRecording ? browser.cachedRecording(tid) : browser.cachedRecordings().find(r => r.tabId === tid);
            if (typeof data.resyncTabId === 'string' && data.resyncTabId) {
              sendRecordingToViewer(ws, getOne(data.resyncTabId));
            } else if (ws.viewMode === 'overview') {
              if (wasPaused || data.resync === true || prevMode !== 'overview') {
                for (const item of browser.cachedRecordings()) sendRecordingToViewer(ws, item);
              }
            } else if (wasPaused || data.resync === true || prevTabId !== ws.watchedTabId) {
              if (ws.watchedTabId) sendRecordingToViewer(ws, getOne(ws.watchedTabId));
              else for (const item of browser.cachedRecordings()) sendRecordingToViewer(ws, item);
            }
          }
        } else if (data.type === 'screencast') {
          if (data.enabled) {
            if (typeof data.tabId !== 'string' || !data.tabId || data.tabId.length > 100) throw new InputError('缺少标签页 ID。');
            ws.screencastTabId = data.tabId;
            try {
              await browser.enableScreencast?.(id, data.tabId);
            } catch (error) {
              if (ws.screencastTabId === data.tabId) ws.screencastTabId = null;
              throw error;
            }
            send(ws, { type: 'screencast-state', enabled: true, tabId: data.tabId });
          } else {
            const prev = ws.screencastTabId;
            ws.screencastTabId = null;
            await browser.disableScreencast?.(id, data.tabId || prev);
            send(ws, { type: 'screencast-state', enabled: false, tabId: prev });
            if (ws.watchedTabId && browser.cachedRecording) {
              sendRecordingToViewer(ws, browser.cachedRecording(ws.watchedTabId));
            }
          }
        } else if (data.type === 'screencast-input') {
          if (ws.paused) return;
          if (ws.queuedControls >= 48) {
            if (data.action === 'mousemove' || data.action === 'wheel') return;
            throw new InputError('远端操作正在处理中，请稍后重试。', 409);
          }
          ws.queuedControls++;
          try {
            await browser.performScreencastInput?.(id, data);
            send(ws, { type: 'control-result', requestId: Number.isInteger(data.requestId) ? data.requestId : null, ok: true });
          } finally { ws.queuedControls--; }
        } else if (data.type === 'viewport') {
          if (ws.paused) return;
          const width = Math.round(Number(data.width));
          const height = Math.round(Number(data.height));
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 640 || width > 3840 || height < 360 || height > 2160) return;
          await browser.setViewport?.({ width, height });
        } else if (data.type === 'acquire-control' || data.type === 'release-control' || data.type === 'control-heartbeat') {
          // Viewer is always interactive; legacy lease messages are harmless no-ops.
        } else if (data.type === 'control') {
          if (ws.paused) return;
          if (ws.queuedControls >= 48) {
            if (data.action === 'move' || data.action === 'wheel') return;
            throw new InputError('远端操作正在处理中，请稍后重试。', 409);
          }
          if (data.action !== 'move' && typeof data.tabId === 'string' && data.tabId) {
            lastControlAtByTab.set(data.tabId, Date.now());
            if (lastControlAtByTab.size > 200) lastControlAtByTab.delete(lastControlAtByTab.keys().next().value);
          }
          ws.queuedControls++;
          try {
            await browser.performControl(id, data);
            if (data.action !== 'move' && typeof data.tabId === 'string' && data.tabId) {
              lastControlAtByTab.set(data.tabId, Date.now());
            }
            send(ws, { type: 'control-result', requestId: Number.isInteger(data.requestId) ? data.requestId : null, ok: true });
          } finally { ws.queuedControls--; }
        } else throw new InputError('不支持的观测消息。');
      } catch (error) {
        let requestId = null;
        try { const input = JSON.parse(raw.toString()); if (Number.isInteger(input.requestId)) requestId = input.requestId; } catch {}
        send(ws, { type: 'control-error', requestId, error: error instanceof InputError ? error.message : '操作消息无效；没有执行任意网页代码。' });
      }
    });
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => browser.removeViewer(id));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!isDashboardAllowed(ws.request)) { ws.close(1008, 'Session expired'); continue; }
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  const closeSessionsByCookie = cookieHeader => {
    for (const ws of wss.clients) {
      if (ws.request.headers.cookie === cookieHeader) ws.close(1008, 'Session ended');
    }
  };

  const close = async () => {
    clearInterval(heartbeat);
    clearTimeout(eventTimer);
    clearTimeout(assetTimer);
    pendingEvents.clear();
    lastControlAtByTab.clear();
    pendingAssetIds.clear();
    for (const [reqId, pending] of pendingHistorySearches) {
      pendingHistorySearches.delete(reqId);
      clearTimeout(pending.timer);
      pending.resolve([]);
    }
    browser.off('change', state);
    browser.off('recording', recording);
    browser.off('asset', onAssetReady);
    browser.off('screencast-frame', onScreencastFrame);
    browser.off('tab-crashed', onTabCrashed);
    browser.off('visit', onVisit);
    if (observeOriginHandler) browser.off('cookie-origin', observeOriginHandler);
    sync.off('change', state);
    if (syncChangedHandler) sync.off('change', syncChangedHandler);
    cookieRequests.off('change', syncState);
    cookieRequests.off('change', state);
    for (const ws of syncWss.clients) ws.terminate();
    await new Promise(resolve => syncWss.close(resolve));
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
  };

  return {
    wss,
    syncWss,
    hasConnectedExtension,
    queryExtensionHistory,
    closeSessionsByCookie,
    attachSyncHooks,
    close,
  };
}
