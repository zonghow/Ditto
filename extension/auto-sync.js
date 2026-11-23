import { captureSnapshot, captureFullSnapshot, originOf, syncEndpoint, uploadSnapshot, prepareUploadBody } from './capture.js';

function fnv1a(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function snapshotDigest(snapshot) {
  const cookieParts = (snapshot.cookies || [])
    .map(c => `${c.domain}|${c.path}|${c.name}|${c.value}|${c.expirationDate ?? ''}|${c.secure ? 1 : 0}|${c.httpOnly ? 1 : 0}|${c.sameSite ?? ''}|${c.partitionKey?.topLevelSite ?? ''}`)
    .sort();
  const storageParts = (snapshot.origins || [])
    .map(o => `${o.origin}|${JSON.stringify(o.localStorage || [])}|${JSON.stringify(o.sessionStorage || [])}`)
    .sort();
  return `${cookieParts.length}:${storageParts.length}:${fnv1a(cookieParts.join('\n'))}:${fnv1a(storageParts.join('\n'))}`;
}

function cookieDeltaKey(c) {
  return `${c.domain}|${c.path}|${c.name}|${c.partitionKey?.topLevelSite ?? ''}|${c.partitionKey?.hasCrossSiteAncestor ?? ''}`;
}

function cookieDeltaValue(c) {
  return `${c.value}|${c.expirationDate ?? ''}|${c.secure ? 1 : 0}|${c.httpOnly ? 1 : 0}|${c.sameSite ?? ''}`;
}

function storageDeltaValue(o) {
  const ls = (o.localStorage || []).map(i => `${i.name}=${i.value}`).sort().join('\0');
  const ss = (o.sessionStorage || []).map(i => `${i.name}=${i.value}`).sort().join('\0');
  return `${(o.localStorage || []).length}:${(o.sessionStorage || []).length}:${fnv1a(ls)}:${fnv1a(ss)}`;
}

// Background orchestration has no durable Cookie cache. Pairing authorizes
// full-profile background sync (periodic + new-tab active sync) plus immediate
// response to explicit remote demands.
export class AutoSync {
  queue = Promise.resolve();
  requests = [];
  pending = null;
  completed = new Set();
  revision = 0;
  connection = 'offline';
  lastUpload = null;
  lastFullSyncAt = null;
  lastFullDigest = null;
  lastSyncedCookies = new Map();
  lastSyncedStorage = new Map();
  hasBaseline = false;
  lastError = null;

  constructor({ api = chrome, fetcher = fetch, notify = () => {} } = {}) {
    this.api = api;
    this.fetcher = fetcher;
    this.notify = notify;
  }

  resetDelta() {
    this.lastFullDigest = null;
    this.lastSyncedCookies.clear();
    this.lastSyncedStorage.clear();
    this.hasBaseline = false;
  }

  configure(saved = {}) {
    const settings = saved.settings || null;
    if (settings) syncEndpoint(settings);
    const pairingChanged = this.settings?.endpoint !== settings?.endpoint || this.settings?.syncToken !== settings?.syncToken;
    if (pairingChanged) {
      this.revision++;
      this.completed.clear();
      this.requests = [];
      this.pending = null;
      this.resetDelta();
      this.lastFullSyncAt = null;
    }
    this.settings = settings;
    // Automatic full Cookie sync is always enabled whenever paired.
    this.enabled = Boolean(settings);
    if (!settings) { this.lastUpload = null; this.lastError = null; }
    this.publish();
  }

  accept(message) {
    if (!Array.isArray(message.requests)) return;
    const requests = message.requests.slice(0, 100).filter(request => {
      try {
        return typeof request.id === 'string' && request.id.length <= 100 && originOf(request.origin) === request.origin &&
          ['waiting', 'uploaded', 'applied'].includes(request.status);
      } catch { return false; }
    }).map(({ id, origin, status }) => ({ id, origin, status }));
    for (const request of requests) {
      const previous = this.requests.find(item => item.id === request.id);
      if (previous && previous.status !== 'waiting' && request.status === 'waiting') this.completed.delete(request.id);
    }
    this.requests = requests;
    this.pending = message.pending ? { id: message.pending.id, origins: message.pending.origins || [] } : null;
    const ids = new Set(requests.map(request => request.id));
    for (const id of this.completed) if (!ids.has(id)) this.completed.delete(id);
    this.publish();
  }

  status() {
    return {
      enabled: Boolean(this.enabled),
      paired: Boolean(this.settings),
      connection: this.connection,
      uploading: Boolean(this.uploading),
      lastUpload: this.lastUpload,
      lastFullSyncAt: this.lastFullSyncAt,
      error: this.lastError,
      stage: this.stage || null,
      requests: this.requests.map(request => ({ ...request, authorized: true })),
      pending: this.pending,
    };
  }

  publish() { this.notify(this.status()); }
  setConnection(state) { this.connection = state; this.publish(); }

  run(operation) {
    const promise = this.queue.then(operation);
    this.queue = promise.catch(() => {});
    return promise;
  }

  async current(savedRevision) {
    const saved = await this.api.storage.local.get(['settings', 'origins']);
    this.configure(saved);
    return this.revision === savedRevision;
  }

  progress(stage) { this.stage = stage; this.publish(); }

  // Periodic & on-connect full Cookie + open-tab Storage synchronization so
  // devbox keeps complete login state even after the user's laptop closes.
  fullSync({ force = false } = {}) {
    return this.run(async () => {
      if (!this.settings) {
        if (force) throw new Error('请先配对。');
        return null;
      }
      if (!force && !this.enabled) return null;
      const revision = this.revision;
      this.uploading = true;
      this.lastError = null;
      this.publish();
      try {
        const excludeOrigin = syncEndpoint(this.settings);
        const snapshot = await captureFullSnapshot(this.api, stage => this.progress(stage), { excludeOrigin });
        this.progress('authorization-check');
        if (!await this.current(revision) || (!force && !this.enabled)) return null;
        const digest = snapshotDigest(snapshot);
        if (!force && digest === this.lastFullDigest) {
          this.lastFullSyncAt = new Date().toISOString();
          return { skipped: true, cookieCount: snapshot.cookies.length };
        }
        const nextCookies = new Map();
        const deltaCookies = [];
        for (const cookie of snapshot.cookies || []) {
          const key = cookieDeltaKey(cookie);
          const val = cookieDeltaValue(cookie);
          nextCookies.set(key, val);
          if (force || !this.hasBaseline || this.lastSyncedCookies.get(key) !== val) {
            deltaCookies.push(cookie);
          }
        }
        const nextStorage = new Map();
        const deltaOrigins = [];
        for (const item of snapshot.origins || []) {
          const val = storageDeltaValue(item);
          nextStorage.set(item.origin, val);
          if (force || !this.hasBaseline || this.lastSyncedStorage.get(item.origin) !== val) {
            deltaOrigins.push(item);
          }
        }
        if (!force && this.hasBaseline && !deltaCookies.length && !deltaOrigins.length) {
          this.lastFullDigest = digest;
          this.lastSyncedCookies = nextCookies;
          this.lastSyncedStorage = nextStorage;
          this.lastFullSyncAt = new Date().toISOString();
          return { skipped: true, cookieCount: snapshot.cookies.length };
        }
        const uploadBody = (!force && this.hasBaseline)
          ? { ...snapshot, cookies: deltaCookies, origins: deltaOrigins }
          : snapshot;
        this.progress('upload');
        const pending = await uploadSnapshot(this.settings, uploadBody, this.fetcher);
        this.lastFullDigest = digest;
        this.lastSyncedCookies = nextCookies;
        this.lastSyncedStorage = nextStorage;
        this.hasBaseline = true;
        this.lastFullSyncAt = new Date().toISOString();
        this.pending = pending?.id ? { id: pending.id, origins: pending.origins || [] } : null;
        this.lastUpload = {
          at: this.lastFullSyncAt,
          mode: 'full',
          cookieCount: pending.cookieCount ?? pending.importedCookies ?? uploadBody.cookies.length,
          storageCount: pending.storageCount ?? pending.importedStorage ?? 0,
          origins: pending.origins || [],
        };
        return pending;
      } catch (error) {
        this.lastError = '全量同步暂未完成，请检查开发机服务连接与网站访问权限。';
        if (force) throw error;
        return null;
      } finally { this.uploading = false; this.stage = null; this.publish(); }
    });
  }

  // Active push when the user opens or loads new tabs in Chrome.
  syncTabOrigins(rawOrigins) {
    return this.run(async () => {
      if (!this.enabled || !this.settings) return null;
      const origins = [...new Set((rawOrigins || []).map(item => {
        try { return originOf(item); } catch { return null; }
      }).filter(Boolean))].slice(0, 20);
      if (!origins.length) return null;
      const revision = this.revision;
      this.uploading = true;
      this.lastError = null;
      this.publish();
      try {
        const snapshot = await captureSnapshot(origins, this.api, stage => this.progress(stage));
        this.progress('authorization-check');
        if (!await this.current(revision) || !this.enabled) return null;
        this.progress('upload');
        const pending = await uploadSnapshot(this.settings, snapshot, this.fetcher);
        this.lastFullDigest = null; // Next periodic tick reconciles full profile digest.
        this.pending = pending?.id ? { id: pending.id, origins: pending.origins || [] } : null;
        this.lastUpload = {
          at: new Date().toISOString(),
          mode: 'tab',
          cookieCount: pending.cookieCount ?? pending.importedCookies ?? snapshot.cookies.length,
          storageCount: pending.storageCount ?? pending.importedStorage ?? 0,
          origins: pending.origins || origins,
        };
        return pending;
      } catch {
        this.lastError = '新标签页主动同步暂未完成，请检查开发机服务连接。';
        return null;
      } finally { this.uploading = false; this.stage = null; this.publish(); }
    });
  }

  automatic() {
    return this.run(async () => {
      if (!this.enabled || !this.settings) return null;
      const eligible = this.requests.filter(request => request.status === 'waiting' && !this.completed.has(request.id));
      if (!eligible.length) return null;
      const revision = this.revision;
      this.uploading = true;
      this.lastError = null;
      this.publish();
      try {
        const snapshot = await captureSnapshot(eligible.map(request => request.origin), this.api, stage => this.progress(stage));
        // Removing consent/clearing pairing while capture runs cancels upload.
        this.progress('authorization-check');
        if (!await this.current(revision) || !this.enabled) return null;
        const settings = this.settings;
        this.progress('upload');
        // Native worker fetch is receiver-sensitive. Keep unbound to application objects.
        const fetcher = this.fetcher;
        const payload = { requestIds: eligible.map(request => request.id), snapshot };
        const { body, headers: extraHeaders } = await prepareUploadBody(payload, { allowGzip: fetcher === fetch });
        const headers = { 'Content-Type': 'application/json', ...extraHeaders };
        if (settings.syncToken) headers.Authorization = `Bearer ${settings.syncToken}`;
        const response = await fetcher(`${syncEndpoint(settings)}/api/sync/auto`, {
          method: 'POST', headers, body, signal: AbortSignal.timeout(20000),
        });
        const result = await response.json();
        if (!response.ok) throw new Error('按需上传未完成；会在连接恢复或请求更新后重试。');
        this.pending = { id: result.pending.id, origins: result.pending.origins };
        for (const request of eligible) this.completed.add(request.id);
        this.lastUpload = {
          at: new Date().toISOString(),
          mode: 'demand',
          cookieCount: result.pending.cookieCount,
          storageCount: result.pending.storageCount,
          origins: result.pending.origins,
        };
        return result.pending;
      } catch {
        // Protocol failures can contain login-state values; never persist/log
        // their raw message, response body or stack in extension diagnostics.
        this.lastError = '自动上传暂未完成，请检查开发机服务连接与网站访问权限。';
        return null;
      } finally { this.uploading = false; this.stage = null; this.publish(); }
    });
  }

  manual() {
    return this.fullSync({ force: true });
  }
}
