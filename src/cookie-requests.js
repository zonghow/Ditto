import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { httpOrigin, InputError } from './snapshot.js';

const MAX_REQUESTS = 100;

// Only origin metadata travels to the Mac extension. Pairing already authorizes
// every HTTP/HTTPS origin the remote browser asks for.
export class CookieRequests extends EventEmitter {
  requests = new Map();

  evictOldest() {
    let victim = null;
    for (const [origin, request] of this.requests) {
      if (request.status === 'applied') { victim = origin; break; }
    }
    if (!victim) victim = this.requests.keys().next().value;
    if (victim) this.requests.delete(victim);
  }

  observe(url, force = false, sync = {}) {
    let origin;
    try { origin = httpOrigin(url); } catch { return null; }
    const previous = this.requests.get(origin);
    if (previous && !force) {
      // Refresh recency order for LRU eviction.
      this.requests.delete(origin);
      this.requests.set(origin, previous);
      return previous;
    }
    if (!previous && this.requests.size >= MAX_REQUESTS) {
      this.evictOldest();
    }
    const staged = !force && sync.pending?.origins.includes(origin);
    const applied = !force && Boolean(sync.applied?.origins.includes(origin));
    const status = staged ? 'uploaded' : applied ? 'applied' : 'waiting';
    const request = { id: randomUUID(), origin, requestedAt: new Date().toISOString(),
      status,
      ...(status === 'waiting' && sync.applied?.id ? { baselineAppliedId: sync.applied.id } : {}),
      ...(staged ? { pendingId: sync.pending.id } : {}) };
    this.requests.delete(origin);
    this.requests.set(origin, request);
    this.emit('change');
    return request;
  }

  reconcile(sync) {
    let changed = false;
    const appliedIsFull = sync.applied?.mode === 'full';
    for (const request of this.requests.values()) {
      const originApplied = appliedIsFull || Boolean(sync.applied?.origins.includes(request.origin));
      const freshApplied = Boolean(originApplied
        && (!request.baselineAppliedId || sync.applied?.id !== request.baselineAppliedId));
      if (sync.pending?.origins.includes(request.origin) || sync.pending?.mode === 'full') {
        if (request.status !== 'uploaded' || request.pendingId !== sync.pending.id) {
          request.status = 'uploaded';
          request.pendingId = sync.pending.id;
          changed = true;
        }
      } else if (request.status !== 'applied' && freshApplied) {
        request.status = 'applied';
        delete request.pendingId;
        delete request.baselineAppliedId;
        changed = true;
      } else if (request.status === 'uploaded') {
        request.status = 'waiting';
        delete request.pendingId;
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  validateUpload(ids, snapshot, sync) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_REQUESTS || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || id.length > 100)) throw new InputError('按需同步请求无效。');
    const requested = ids.map(id => [...this.requests.values()].find(request => request.id === id && request.status === 'waiting'));
    if (requested.some(request => !request)) throw new InputError('按需同步请求已变化，请重新连接后重试。', 409);
    const origins = new Set(requested.map(request => request.origin));
    if (snapshot.mode !== 'full' && (snapshot.origins.length !== origins.size || snapshot.origins.some(item => !origins.has(item.origin)))) {
      throw new InputError('自动上传只能包含远端本次请求的网站。');
    }
    return requested;
  }

  summary(sync) {
    return { requests: [...this.requests.values()].map(({ id, origin, requestedAt, status }) => ({ id, origin, requestedAt, status })),
      pending: sync.pending ? { id: sync.pending.id, origins: sync.pending.origins, mode: sync.pending.mode || 'scoped' } : null };
  }
}
