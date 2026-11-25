import http from 'node:http';
import express from 'express';
import path from 'node:path';
import { Authentication, constantEqual, validHost, allowedOrigin } from './auth.js';
import { InputError } from './snapshot.js';
import { replayAssetDirectory } from './recorder.js';
import { CookieRequests } from './cookie-requests.js';
import { SerialQueue } from './files.js';
import { createLogger } from './logger.js';
import { HistoryStore, rankHistoryItems } from './history.js';
import { createMemoryCollector } from './metrics.js';
import { createWsHub } from './ws-hub.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerAgentRoutes } from './routes/agent.js';

const MAX_LOGIN_ATTEMPT_IPS = 1000;

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function createApplication({ config, credentials, browser, sync, logger, history }) {
  const app = express();
  const authentication = new Authentication(credentials);
  const cookieRequests = new CookieRequests();
  const syncQueue = new SerialQueue();
  const historyStore = history || new HistoryStore(null);
  const getMemoryMetrics = createMemoryCollector({ browser, ttlMs: 2000 });

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    if (!validHost(request.headers.host)) return response.status(403).json({ error: '不允许的 Host。' });
    const extensionRoute = ['/api/sync', '/api/sync/auto', '/api/sync/requests', '/api/sync/verify', '/cookiecloud/update'].includes(request.path);
    if (!allowedOrigin(request, extensionRoute)) return response.status(403).json({ error: '不允许的请求来源。' });
    const extensionOrigin = request.headers.origin?.startsWith('chrome-extension://');
    if (extensionRoute && extensionOrigin) {
      response.set({
        'Access-Control-Allow-Origin': request.headers.origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Content-Encoding',
        'Vary': 'Origin',
      });
    }
    if (request.method === 'OPTIONS') return response.sendStatus(204);
    next();
  });

  const authRequired = Boolean(config.authRequired);
  const agentAllowRemote = Boolean(config.agentAllowRemote);
  const isDashboardAllowed = request => !authRequired || authentication.isDashboard(request);
  const isSyncAllowed = request => !authRequired || authentication.isSync(request);

  const requireDashboard = (request, response, next) => {
    if (request.headers.origin?.startsWith('chrome-extension://')) {
      return response.status(403).json({ error: '扩展只允许上传，不允许读取或控制观测服务。' });
    }
    if (!isDashboardAllowed(request)) return response.status(401).json({ error: '请先连接观测页。' });
    next();
  };
  const requireAgent = (request, response, next) => {
    if (request.headers.origin?.startsWith('chrome-extension://')) {
      return response.status(403).json({ error: '扩展不允许调用 Agent 接口。' });
    }
    if (!authRequired && !agentAllowRemote && !isLoopbackAddress(request.socket?.remoteAddress)) {
      return response.status(403).json({ error: '未开启鉴权时，Agent 控制接口仅允许本机 (127.0.0.1) 访问。' });
    }
    if (!isDashboardAllowed(request)) return response.status(401).json({ error: '请先连接观测页。' });
    next();
  };
  const requireSync = (request, response, next) => {
    if (!isSyncAllowed(request)) return response.status(401).json({ error: '同步配对凭据无效。' });
    next();
  };

  const safeUrl = raw => {
    try {
      const parsed = new URL(raw);
      return `${parsed.origin}${parsed.pathname}`;
    } catch { return String(raw || '').slice(0, 80); }
  };
  const appLogger = logger || createLogger({
    enabled: config.logging !== false,
    file: config.logFile,
    fallbackFile: config.logFile && config.dataDir ? path.join(config.dataDir, 'logs', 'ditto.log') : null,
  });
  const log = (scope, message) => appLogger.log(scope, message);

  const server = http.createServer(app);
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;

  const createViewerSession = authRequired && authentication.hasUnifiedToken()
    ? () => authentication.session()
    : null;

  const wsHub = createWsHub({
    server,
    credentials,
    authRequired,
    isDashboardAllowed,
    createViewerSession,
    browser,
    sync,
    cookieRequests,
    historyStore,
    log,
    safeUrl,
  });

  const loginAttempts = new Map();
  const verifyFailures = new Map();
  const recordAttempt = (bucket, address, maxPerMinute) => {
    const now = Date.now();
    if (bucket.size > MAX_LOGIN_ATTEMPT_IPS) {
      for (const [ip, times] of bucket) {
        if (!times.some(time => time > now - 60000)) bucket.delete(ip);
      }
    }
    const recent = (bucket.get(address) || []).filter(time => time > now - 60000);
    if (recent.length >= maxPerMinute) {
      bucket.set(address, recent);
      return false;
    }
    recent.push(now);
    bucket.set(address, recent);
    return true;
  };
  const isRateLimited = (bucket, address, maxPerMinute) => {
    const now = Date.now();
    const recent = (bucket.get(address) || []).filter(time => time > now - 60000);
    if (recent.length) bucket.set(address, recent);
    else bucket.delete(address);
    return recent.length >= maxPerMinute;
  };
  app.get('/health', (request, response) => response.json({
    ok: true, browserReady: browser.ready, authRequired, extensionConnected: wsHub.hasConnectedExtension(),
  }));
  app.post('/api/sync/verify', (request, response) => {
    if (!authRequired) return response.json({ ok: true, authRequired: false });
    const address = request.socket.remoteAddress || 'unknown';
    if (isRateLimited(verifyFailures, address, 10)) {
      return response.status(429).json({ error: '尝试过多，请一分钟后重试。' });
    }
    if (!authentication.isSync(request)) {
      recordAttempt(verifyFailures, address, 10);
      return response.status(401).json({ error: 'Token 无效，请检查服务配置。' });
    }
    const payload = { ok: true, authRequired: true };
    if (createViewerSession) payload.viewerSession = createViewerSession();
    response.json(payload);
  });
  app.post('/api/session', express.json({ limit: '2kb' }), (request, response) => {
    if (!authRequired) return response.json({ ok: true });
    const address = request.socket.remoteAddress || 'unknown';
    if (!recordAttempt(loginAttempts, address, 10)) {
      return response.status(429).json({ error: '尝试过多，请一分钟后重试。' });
    }
    if (!constantEqual(request.body?.token, credentials.dashboardToken)) {
      return response.status(401).json({ error: 'Token 无效，请检查后重试。' });
    }
    response.set('Set-Cookie', authentication.cookie(authentication.session()));
    response.json({ ok: true });
  });
  app.delete('/api/session', requireDashboard, (request, response) => {
    wsHub.closeSessionsByCookie(request.headers.cookie);
    response.set('Set-Cookie', authentication.cookie('', true));
    response.json({ ok: true });
  });
  app.get('/api/state', requireDashboard, (request, response) => {
    if (authRequired) {
      const existing = authentication.sessionFromCookie(request);
      if (existing) response.set('Set-Cookie', authentication.cookie(existing));
    }
    response.json({
      browser: browser.summary(), sync: sync.summary(), cookieSync: cookieRequests.summary(sync.summary()),
      authRequired, extensionConnected: wsHub.hasConnectedExtension(), version: '0.3.0',
    });
  });
  app.get('/api/memory', requireDashboard, async (request, response) => {
    const force = request.query.force === '1';
    response.json(await getMemoryMetrics({ force }));
  });
  app.get('/api/pairing', requireDashboard, (request, response) => response.json({
    endpoint: `http://${request.headers.host}`,
    authRequired,
    syncToken: credentials.syncToken,
    cookieCloud: credentials.cookieCloud,
  }));

  const syncRoutes = registerSyncRoutes({
    app,
    config,
    credentials,
    browser,
    sync,
    cookieRequests,
    syncQueue,
    requireDashboard,
    requireSync,
    hasConnectedExtension: wsHub.hasConnectedExtension,
    log,
  });
  wsHub.attachSyncHooks(syncRoutes);

  app.post('/api/tabs', requireDashboard, express.json({ limit: '4kb' }), async (request, response) => {
    if (request.body?.url !== undefined && typeof request.body.url !== 'string') throw new InputError('网站地址无效。');
    if (request.body?.afterTabId !== undefined && typeof request.body.afterTabId !== 'string') throw new InputError('参考标签页无效。');
    const targetUrl = request.body?.url || 'about:blank';
    const afterTabId = request.body?.afterTabId || null;
    if (targetUrl !== 'about:blank') await syncRoutes.waitForOriginSync(targetUrl, true, 4000);
    const tabId = afterTabId ? await browser.open(targetUrl, { afterTabId }) : await browser.open(targetUrl);
    response.json({ ok: true, tabId });
  });
  app.post('/api/tabs/:tabId', requireDashboard, express.json({ limit: '8kb' }), async (request, response) => {
    if (typeof request.body?.action !== 'string') throw new InputError('缺少标签页操作。');
    const action = request.body.action;
    if (action === 'navigate' && typeof request.body.url === 'string' && request.body.url !== 'about:blank') {
      await syncRoutes.waitForOriginSync(request.body.url, true, 4000);
    } else if (action === 'reload') {
      const currentUrl = browser.tabs?.get?.(request.params.tabId)?.page?.url?.()
        || browser.summary().tabs.find(item => item.id === request.params.tabId)?.url;
      if (currentUrl && currentUrl !== 'about:blank') await syncRoutes.waitForOriginSync(currentUrl, true, 4000);
    }
    const result = await browser.tabAction(request.params.tabId, action, {
      url: request.body.url,
      viewerId: request.body.viewerId,
      promptText: request.body.promptText,
    });
    response.json({ ok: true, ...result });
  });
  app.post('/api/tabs/:tabId/selection', requireDashboard, async (request, response) => {
    const result = await browser.getSelectionText(request.params.tabId);
    response.json({ ok: true, ...result });
  });
  app.post('/api/tabs/:tabId/eval', requireDashboard, express.json({ limit: '64kb' }), async (request, response) => {
    if (typeof browser.devtoolsEvaluate !== 'function') throw new InputError('当前模式不支持控制台求值。', 501);
    const result = await browser.devtoolsEvaluate(request.params.tabId, request.body?.expression);
    response.json(result);
  });
  app.post('/api/tabs/:tabId/devtools/clear', requireDashboard, express.json({ limit: '2kb' }), (request, response) => {
    const target = ['console', 'network', 'all'].includes(request.body?.target) ? request.body.target : 'all';
    browser.devtoolsClear?.(request.params.tabId, target);
    response.json({ ok: true });
  });
  app.post('/api/tabs/:tabId/upload', requireDashboard, express.json({ limit: '25mb' }), async (request, response) => {
    const name = typeof request.body?.name === 'string' && request.body.name.trim() ? path.basename(request.body.name.trim()).slice(0, 160) : 'upload.bin';
    const mimeType = typeof request.body?.mimeType === 'string' ? request.body.mimeType.slice(0, 120) : 'application/octet-stream';
    const contentBase64 = request.body?.contentBase64;
    if (typeof contentBase64 !== 'string' || !contentBase64) throw new InputError('缺少上传文件内容。');
    const buffer = Buffer.from(contentBase64, 'base64');
    if (buffer.length > 20 * 1024 * 1024) throw new InputError('单文件上传上限为 20MB。', 413);
    const result = await browser.uploadFileToTab(request.params.tabId, { name, mimeType, buffer });
    response.json(result);
  });
  app.get('/api/downloads', requireDashboard, (request, response) => {
    response.json({ ok: true, downloads: browser.downloadsSummary?.() || [] });
  });
  app.get('/api/downloads/:id', requireDashboard, (request, response) => {
    const item = browser.getDownload?.(request.params.id);
    if (!item) return response.status(404).json({ error: '下载文件不存在或已过期。' });
    response.download(item.path, item.filename);
  });
  app.get('/api/history', requireDashboard, async (request, response) => {
    const query = typeof request.query?.q === 'string' ? request.query.q.slice(0, 200) : '';
    const limit = Math.min(Math.max(Number(request.query?.limit) || 8, 1), 20);
    const [localItems, chromeItems] = await Promise.all([
      Promise.resolve(historyStore.search(query, 20)),
      wsHub.queryExtensionHistory(query, 20, 800),
    ]);
    const merged = new Map();
    for (const item of chromeItems) {
      merged.set(item.url, { ...item, source: 'chrome', removable: false });
    }
    for (const item of localItems) {
      const prev = merged.get(item.url);
      merged.set(item.url, {
        url: item.url,
        title: (item.title && item.title !== item.url ? item.title : prev?.title) || item.url,
        visitCount: Math.max(item.visitCount || 1, prev?.visitCount || 1),
        lastVisited: Math.max(item.lastVisited || 0, prev?.lastVisited || 0),
        source: prev ? 'both' : 'ditto',
        removable: true,
      });
    }
    response.json({ items: rankHistoryItems(merged.values(), query, limit) });
  });
  app.delete('/api/history', requireDashboard, express.json({ limit: '8kb' }), (request, response) => {
    const url = typeof request.body?.url === 'string' ? request.body.url : '';
    if (!url) throw new InputError('缺少要删除的历史地址。');
    response.json({ ok: true, removed: historyStore.remove(url) });
  });

  registerAgentRoutes({
    app,
    browser,
    sync,
    requireAgent,
    waitForOriginSync: syncRoutes.waitForOriginSync,
    hasConnectedExtension: wsHub.hasConnectedExtension,
    log,
    safeUrl,
  });

  app.get('/vendor/rrweb/replay.js', (request, response) => {
    response.set('Cache-Control', 'private, max-age=3600');
    response.sendFile(path.join(replayAssetDirectory, 'replay.js'));
  });
  app.get('/vendor/rrweb/style.css', (request, response) => {
    response.set('Cache-Control', 'private, max-age=3600');
    response.sendFile(path.join(replayAssetDirectory, 'style.css'));
  });
  app.get('/api/assets/:id', requireDashboard, async (request, response) => {
    if (!/^[a-f0-9]{36}$/.test(request.params.id)) throw new InputError('没有这个回放资源。', 404);
    const asset = browser.assets.get(request.params.id);
    if (!asset?.body) {
      browser.assets.markMissing?.(request.params.id);
      // Missing bytes never block the replay: answer empty now, backfill from the
      // owned browser, then let the asset-ready message refresh that element.
      browser.refillAsset(request.params.id).catch(() => {});
      return response.status(204).end();
    }
    response.set({
      'Cache-Control': 'private, max-age=300',
      'Content-Type': asset.contentType,
      // Especially important for SVG if opened directly, outside the Replayer.
      'Content-Security-Policy': "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    response.send(asset.body);
  });

  app.use(express.static(config.publicDir, {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders: response => {
      response.set('Cache-Control', 'no-cache');
    },
  }));
  app.use((request, response) => response.status(404).json({ error: '没有这个接口。' }));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = error instanceof InputError ? error.status
      : error.type === 'entity.too.large' ? 413
      : error instanceof SyntaxError ? 400 : 500;
    response.status(status).json({ error: error instanceof InputError ? error.message
      : status === 413 ? '上传数据超过大小限制。'
      : status === 400 ? '请求 JSON 格式错误。' : '操作失败，请检查服务状态后重试。' });
    // No raw error: protocol/JSON exceptions can contain login-state values.
    if (status === 500) console.error('Ditto request failed (details intentionally redacted).');
  });

  return {
    app,
    server,
    async close() {
      await wsHub.close();
      await new Promise(resolve => server.close(resolve));
      await historyStore.flush();
      await appLogger.flush();
    },
  };
}
