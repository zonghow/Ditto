import express from 'express';
import { constantEqual } from '../auth.js';
import { InputError, normalizeSnapshot, decryptCookieCloud, httpOrigin } from '../snapshot.js';

const MAX_TRACKED_ORIGINS = 500;
const MAX_APPLIED_IDS = 200;

export function registerSyncRoutes({
  app,
  config,
  credentials,
  browser,
  sync,
  cookieRequests,
  syncQueue,
  requireDashboard,
  requireSync,
  hasConnectedExtension,
  log,
}) {
  const json = express.json({ limit: '32mb', strict: true, inflate: true });
  const freshMs = Number.isFinite(config.syncFreshMs) ? config.syncFreshMs : 5 * 60 * 1000;
  const fullFreshMs = freshMs + Math.min(60_000, Math.round(freshMs * 0.25));

  const syncedOriginAt = new Map();
  const recordedAppliedIds = new Set();
  let lastFullSyncAt = 0;

  const initialApplied = sync.summary().applied;
  if (initialApplied?.id) {
    recordedAppliedIds.add(initialApplied.id);
    if (initialApplied.mode === 'full') {
      const ts = Date.parse(initialApplied.appliedAt || '');
      if (Number.isFinite(ts)) lastFullSyncAt = ts;
    }
  }

  const recordAppliedOrigins = () => {
    const applied = sync.summary().applied;
    if (applied?.id && !recordedAppliedIds.has(applied.id)) {
      recordedAppliedIds.add(applied.id);
      if (recordedAppliedIds.size > MAX_APPLIED_IDS) {
        const oldest = recordedAppliedIds.values().next().value;
        if (oldest) recordedAppliedIds.delete(oldest);
      }
      const now = Date.now();
      if (applied.mode === 'full') lastFullSyncAt = now;
      for (const origin of applied.origins || []) {
        syncedOriginAt.delete(origin);
        syncedOriginAt.set(origin, now);
      }
      while (syncedOriginAt.size > MAX_TRACKED_ORIGINS) {
        const oldest = syncedOriginAt.keys().next().value;
        if (!oldest) break;
        syncedOriginAt.delete(oldest);
      }
    }
  };

  const relatedOrigins = rawUrl => {
    const found = [];
    const add = candidate => {
      try {
        const origin = httpOrigin(candidate);
        if (!found.includes(origin)) found.push(origin);
      } catch { /* ignore non-http URLs */ }
    };
    add(rawUrl);
    try {
      const parsed = new URL(rawUrl);
      for (const key of ['redirect_uri', 'redirect', 'return_to', 'next', 'continue', 'callback', 'service', 'target']) {
        const val = parsed.searchParams.get(key);
        if (val && /^https?:\/\//i.test(val)) {
          add(val);
          if (found.length >= 2) break;
        }
      }
    } catch { /* ignore */ }
    return found;
  };

  const waitForOriginSync = (url, force = false, timeoutMs = 5000) => new Promise(resolve => {
    if (!hasConnectedExtension() || !url || url === 'about:blank') {
      resolve({ synced: false, extensionConnected: hasConnectedExtension() });
      return;
    }
    const origins = relatedOrigins(url);
    if (!origins.length) {
      resolve({ synced: false, extensionConnected: true });
      return;
    }
    const now = Date.now();
    const toRequest = origins.filter(origin => {
      if (force) return true;
      const lastSynced = syncedOriginAt.get(origin);
      return !(lastSynced && (now - lastSynced) < freshMs);
    });
    if (!toRequest.length) {
      log('sync', `origin=${origins[0]} skipped (fresh ${Math.round((now - syncedOriginAt.get(origins[0])) / 1000)}s ago)`);
      resolve({ synced: true, alreadyApplied: true, extensionConnected: true });
      return;
    }
    const demands = [];
    for (const origin of toRequest) {
      const lastSynced = syncedOriginAt.get(origin);
      const reason = force ? 'force' : lastSynced ? 'stale' : 'cold';
      const demand = cookieRequests.observe(origin, true, sync.summary());
      if (demand) {
        demands.push(demand);
        log('sync', `origin=${origin} requested reason=${reason}`);
      }
    }
    if (!demands.length) {
      resolve({ synced: false, extensionConnected: true });
      return;
    }
    const startedAt = Date.now();
    const ms = Math.min(Math.max(Number(timeoutMs) || 5000, 300), 20000);
    const finish = synced => {
      clearTimeout(timer);
      cookieRequests.off('change', check);
      sync.off('change', check);
      browser.off('change', check);
      log('sync', `origin=${demands.map(d => d.origin).join(',')} ${synced ? 'ready' : 'timeout'} (${Date.now() - startedAt}ms)`);
      resolve({ synced, extensionConnected: hasConnectedExtension() });
    };
    const check = () => {
      cookieRequests.reconcile(sync.summary());
      const reqs = cookieRequests.summary(sync.summary()).requests;
      const allDone = demands.every(demand => {
        const current = reqs.find(item => item.id === demand.id);
        return !current || current.status === 'applied';
      });
      if (allDone && !browser.importing) finish(true);
    };
    const timer = setTimeout(() => finish(false), ms);
    cookieRequests.on('change', check);
    sync.on('change', check);
    browser.on('change', check);
    check();
  });

  const observeOrigin = url => {
    try {
      const parsed = new URL(url);
      if (['localhost', '127.0.0.1'].includes(parsed.hostname) &&
        [String(config.port), '3217', '3218'].includes(parsed.port) && ['/', '/index.html'].includes(parsed.pathname)) return;
      const origin = httpOrigin(url);
      const lastOriginSynced = syncedOriginAt.get(origin) || 0;
      // Avoid spurious stale scoped re-syncs shortly after a periodic full sync.
      const freshFromFull = lastFullSyncAt > 0 && (Date.now() - lastFullSyncAt) < fullFreshMs;
      const stale = !freshFromFull && Boolean(lastOriginSynced && (Date.now() - lastOriginSynced) >= freshMs);
      cookieRequests.observe(url, stale, sync.summary());
    } catch { return; }
  };

  const receiveSnapshot = async payload => {
    if (config.syncUpstream) {
      return sync.forward('/api/sync', 'POST', payload, true);
    }
    const startedAt = Date.now();
    const snapshot = normalizeSnapshot(payload);
    let pending;
    let applied;
    if (typeof sync.applyDirect === 'function') {
      ({ pending, applied } = await sync.applyDirect(snapshot, browser));
      if (!applied) return { status: 202, data: { ok: true, pending, applied: false } };
    } else {
      pending = await sync.receive(snapshot);
      if (!browser.ready) return { status: 202, data: { ok: true, pending, applied: false } };
      applied = await sync.apply(pending.id, browser);
    }
    recordAppliedOrigins();
    const modeLabel = snapshot.mode === 'full' ? 'full' : 'scoped';
    const writtenStorage = applied?.writtenStorage ?? applied?.importedStorage ?? 0;
    log('sync', `applied mode=${modeLabel} origins=${applied?.originCount ?? 0} cookies=${applied?.importedCookies ?? 0} (written=${applied?.writtenCookies ?? applied?.importedCookies ?? 0}) storage=${applied?.importedStorage ?? 0} (written=${writtenStorage}) (${Date.now() - startedAt}ms)`);
    return { status: 200, data: { ok: true, pending, applied } };
  };

  app.get('/api/sync/requests', requireSync, (request, response) => response.json({ ok: true, ...cookieRequests.summary(sync.summary()) }));
  app.post('/api/sync/auto', requireSync, json, async (request, response) => {
    const result = await syncQueue.run(async () => {
      if (config.syncUpstream) await sync.refresh();
      const snapshot = normalizeSnapshot(request.body?.snapshot);
      cookieRequests.validateUpload(request.body?.requestIds, snapshot, sync.summary());
      if (sync.summary().pending && !config.syncUpstream) await sync.discard();
      return receiveSnapshot(request.body.snapshot);
    });
    cookieRequests.reconcile(sync.summary());
    response.status(result.status).json(result.data);
  });
  app.post('/api/sync', requireSync, json, async (request, response) => {
    const result = await syncQueue.run(() => receiveSnapshot(request.body));
    cookieRequests.reconcile(sync.summary());
    response.status(result.status).json(result.data);
  });
  app.post('/api/apply', requireDashboard, express.json({ limit: '2kb' }), async (request, response) => {
    if (config.syncUpstream) {
      browser.importing = true;
      browser.control.release();
      browser.emit('change', browser.summary());
      try {
        const result = await sync.forward('/api/apply', 'POST', request.body);
        return response.status(result.status).json(result.data);
      } finally {
        browser.importing = false;
        for (const tab of browser.tabs.values()) browser.checkpoint(tab);
        browser.emit('change', browser.summary());
      }
    }
    const applied = await sync.apply(request.body.id, browser);
    response.json({ ok: true, applied });
  });
  app.post('/api/sync/request', requireDashboard, express.json({ limit: '2kb' }), async (request, response) => {
    const origin = httpOrigin(request.body?.origin);
    if (request.body?.wait) {
      const targetUrl = typeof request.body?.url === 'string' && request.body.url ? request.body.url : origin;
      log('sync', `manual-request origin=${origin} wait=true`);
      const syncResult = await waitForOriginSync(targetUrl, true, 6000);
      if (syncResult.synced && typeof request.body?.tabId === 'string' && request.body.tabId) {
        await browser.tabAction(request.body.tabId, 'reload').catch(() => {});
      }
      return response.json({ ok: true, ...syncResult, missingStorageOrigins: sync.summary().applied?.missingStorageOrigins || [] });
    }
    const demand = cookieRequests.observe(origin, true, sync.summary());
    log('sync', `manual-request origin=${origin}`);
    response.json({ ok: true, request: demand });
  });
  app.post('/cookiecloud/update', requireSync, json, async (request, response) => {
    const result = await syncQueue.run(async () => {
      if (config.syncUpstream) return sync.forward('/cookiecloud/update', 'POST', request.body, true);
      const payload = decryptCookieCloud(request.body, credentials.cookieCloud);
      const snapshot = normalizeSnapshot(payload, 'cookiecloud');
      const pending = await sync.receive(snapshot, {
        encrypted: request.body.encrypted, crypto_type: request.body.crypto_type || 'legacy',
      });
      return { status: 200, data: { action: 'done', pending } };
    });
    cookieRequests.reconcile(sync.summary());
    response.status(result.status).json(result.data);
  });
  // UUID alone is not authorization. Never offer a password-in-query plaintext download.
  app.get('/cookiecloud/get/:uuid', requireSync, async (request, response) => {
    if (!constantEqual(request.params.uuid, credentials.cookieCloud.uuid)) throw new InputError('没有该同步数据。', 404);
    if (config.syncUpstream) {
      const result = await sync.forward(`/cookiecloud/get/${request.params.uuid}`, 'GET', undefined, true);
      return response.status(result.status).json(result.data);
    }
    const envelope = await sync.envelope();
    if (!envelope) throw new InputError('尚未接收到 CookieCloud 数据。', 404);
    response.json(envelope);
  });

  return { recordAppliedOrigins, observeOrigin, waitForOriginSync };
}
