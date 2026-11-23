import express from 'express';
import { httpOrigin } from '../snapshot.js';

function agentContext(request) {
  const rawSession = request.headers['x-ditto-session'] || request.body?.sessionId;
  const rawAgent = request.headers['x-ditto-agent'] || request.body?.agent;
  const rawWorkspace = request.headers['x-ditto-workspace'] || request.body?.workspace;
  let workspace = null;
  if (typeof rawWorkspace === 'string' && rawWorkspace.trim()) {
    try { workspace = decodeURIComponent(rawWorkspace.trim()).slice(0, 48); }
    catch { workspace = rawWorkspace.trim().slice(0, 48); }
  }
  return {
    sessionId: typeof rawSession === 'string' && rawSession.trim() ? rawSession.trim().slice(0, 200) : null,
    agent: typeof rawAgent === 'string' && rawAgent.trim() ? rawAgent.trim().toLowerCase().slice(0, 32) : null,
    workspace,
  };
}

function normalizeAgentUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed || trimmed === 'about:blank') return 'about:blank';
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function registerAgentRoutes({
  app,
  browser,
  sync,
  requireAgent,
  waitForOriginSync,
  hasConnectedExtension,
  log,
  safeUrl,
}) {
  app.get('/api/agent/status', requireAgent, (request, response) => {
    const { sessionId } = agentContext(request);
    const summary = browser.summary();
    const sessionTabId = browser.sessionTabId?.(sessionId) || null;
    response.json({
      ok: true,
      browserReady: browser.ready,
      extensionConnected: hasConnectedExtension(),
      activeTabId: summary.activeTabId,
      sessionTabId,
      agentSessions: summary.agentSessions || [],
      tabs: summary.tabs.map(tab => ({
        ...tab,
        shortId: tab.id.slice(0, 8),
        mine: Boolean(sessionId && (sessionTabId === tab.id || browser.tabs?.get(tab.id)?.ownerSession === sessionId)),
      })),
      sync: sync.summary(),
    });
  });

  app.post('/api/agent/open', requireAgent, express.json({ limit: '8kb' }), async (request, response) => {
    const startedAt = Date.now();
    const ctx = agentContext(request);
    const url = normalizeAgentUrl(request.body?.url);
    const waitSync = request.body?.waitSync !== false;
    const syncTimeout = request.body?.syncTimeout ?? 5000;
    if (waitSync && url !== 'about:blank') await waitForOriginSync(url, false, syncTimeout);
    const tabId = browser.agentOpen ? await browser.agentOpen(url, ctx) : await browser.open(url);
    const tab = browser.summary().tabs.find(item => item.id === tabId) || null;
    log('agent', `${tab?.agent?.label || ctx.agent || 'cli'} open ${safeUrl(url)} -> tab=${tabId.slice(0, 8)} landed=${safeUrl(tab?.url || url)} (${Date.now() - startedAt}ms)`);
    response.json({
      ok: true,
      tabId,
      shortId: tabId.slice(0, 8),
      title: tab?.title || '',
      url: tab?.url || url,
      agent: tab?.agent || null,
      extensionConnected: hasConnectedExtension(),
    });
  });

  app.post('/api/agent/sync', requireAgent, express.json({ limit: '4kb' }), async (request, response) => {
    const startedAt = Date.now();
    const ctx = agentContext(request);
    const hasExplicitUrl = typeof request.body?.url === 'string' && request.body.url.trim().length > 0;
    const hasExplicitTab = request.body?.tabId !== undefined && request.body?.tabId !== null && String(request.body.tabId).trim().length > 0;
    const tab = hasExplicitTab
      ? browser.resolveTab(request.body.tabId, ctx.sessionId)
      : hasExplicitUrl ? null : browser.resolveTab(null, ctx.sessionId);
    const targetUrl = hasExplicitUrl ? normalizeAgentUrl(request.body.url) : tab?.page?.url();
    const origin = httpOrigin(targetUrl);
    const syncResult = await waitForOriginSync(origin, true, request.body?.timeout ?? 8000);
    if (syncResult.synced && tab && request.body?.reload !== false) {
      const action = hasExplicitUrl ? 'navigate' : 'reload';
      const actionOptions = hasExplicitUrl ? { url: targetUrl, ...ctx } : ctx;
      if (browser.agentTabAction) await browser.agentTabAction(tab.id, action, actionOptions).catch(() => {});
      else await browser.tabAction(tab.id, action, hasExplicitUrl ? { url: targetUrl } : {}).catch(() => {});
    }
    const current = tab ? browser.summary().tabs.find(item => item.id === tab.id) || null : null;
    log('agent', `${current?.agent?.label || ctx.agent || 'cli'} sync origin=${origin} tab=${tab ? tab.id.slice(0, 8) : 'none'} synced=${syncResult.synced} (${Date.now() - startedAt}ms)`);
    response.json({
      ok: true,
      origin,
      ...syncResult,
      missingStorageOrigins: sync.summary().applied?.missingStorageOrigins || [],
      tabId: tab?.id || null,
      shortId: tab ? tab.id.slice(0, 8) : null,
      title: current?.title || '',
      url: current?.url || targetUrl || '',
    });
  });

  app.post('/api/agent/snapshot', requireAgent, express.json({ limit: '4kb' }), async (request, response) => {
    const startedAt = Date.now();
    const ctx = agentContext(request);
    const result = await browser.agentSnapshot(request.body?.tabId, {
      limit: request.body?.limit,
      maxChars: request.body?.maxChars,
      ...ctx,
    });
    log('agent', `${ctx.agent || 'cli'} snapshot tab=${result.tabId?.slice(0, 8)} url=${safeUrl(result.url)} elements=${result.elements?.length ?? 0} (${Date.now() - startedAt}ms)`);
    response.json(result);
  });

  app.post('/api/agent/act', requireAgent, express.json({ limit: '32kb' }), async (request, response) => {
    const startedAt = Date.now();
    const ctx = agentContext(request);
    const action = request.body?.action;
    if (['activate', 'navigate', 'reload', 'back', 'forward', 'close', 'confirm-close', 'cancel-close', 'accept-dialog', 'dismiss-dialog'].includes(action)) {
      let targetUrl = request.body?.url;
      if (action === 'navigate' && typeof targetUrl === 'string' && targetUrl.trim() && targetUrl !== 'about:blank') {
        targetUrl = normalizeAgentUrl(targetUrl);
        if (request.body?.waitSync !== false) await waitForOriginSync(targetUrl, false, request.body?.timeout ?? 5000);
      }
      const result = browser.agentTabAction
        ? await browser.agentTabAction(request.body?.tabId, action, { url: targetUrl, promptText: request.body?.promptText, ...ctx })
        : await browser.tabAction(browser.resolveTab(request.body?.tabId, ctx.sessionId).id, action, { url: targetUrl, promptText: request.body?.promptText });
      const current = browser.summary().tabs.find(item => item.id === result.tabId) || null;
      log('agent', `${current?.agent?.label || ctx.agent || 'cli'} ${action} tab=${result.tabId.slice(0, 8)}${targetUrl ? ` url=${safeUrl(targetUrl)}` : ''} (${Date.now() - startedAt}ms)`);
      response.json({ ok: true, ...result, shortId: result.tabId.slice(0, 8), title: current?.title || '', url: current?.url || targetUrl || '' });
      return;
    }
    const result = await browser.agentAct(request.body?.tabId, { ...(request.body || {}), ...ctx });
    log('agent', `${ctx.agent || 'cli'} ${action} tab=${result.tabId?.slice(0, 8)} (${Date.now() - startedAt}ms)`);
    response.json(result);
  });

  app.post('/api/agent/eval', requireAgent, express.json({ limit: '128kb' }), async (request, response) => {
    const startedAt = Date.now();
    const ctx = agentContext(request);
    const result = await browser.agentEvaluate(request.body?.tabId, request.body?.expression, ctx);
    log('agent', `${ctx.agent || 'cli'} eval tab=${result.tabId?.slice(0, 8)} (${Date.now() - startedAt}ms)`);
    response.json(result);
  });

  app.post('/api/agent/console', requireAgent, express.json({ limit: '4kb' }), async (request, response) => {
    const ctx = agentContext(request);
    const result = await browser.agentConsole(request.body?.tabId, {
      clear: Boolean(request.body?.clear),
      limit: request.body?.limit,
      ...ctx,
    });
    response.json(result);
  });

  app.post('/api/agent/network', requireAgent, express.json({ limit: '4kb' }), async (request, response) => {
    const ctx = agentContext(request);
    const result = await browser.agentNetwork(request.body?.tabId, {
      failedOnly: request.body?.failedOnly !== false,
      clear: Boolean(request.body?.clear),
      limit: request.body?.limit,
      ...ctx,
    });
    response.json(result);
  });

  app.post('/api/agent/screenshot', requireAgent, express.json({ limit: '4kb' }), async (request, response) => {
    const startedAt = Date.now();
    const ctx = agentContext(request);
    const png = await browser.agentScreenshot(request.body?.tabId, { fullPage: request.body?.fullPage, ...ctx });
    log('agent', `${ctx.agent || 'cli'} screenshot bytes=${png.length} (${Date.now() - startedAt}ms)`);
    if (request.headers.accept?.includes('image/png')) {
      response.set('Content-Type', 'image/png');
      response.send(png);
      return;
    }
    response.json({ ok: true, pngBase64: png.toString('base64') });
  });
}
