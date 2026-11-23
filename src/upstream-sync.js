import { EventEmitter } from 'node:events';

// During a non-disruptive viewer upgrade, the original Browser Service remains
// the ONLY writer of login snapshots. Never let two SyncStores race on the same
// pending.json/profile. The companion forwards these explicit routes to it.
export class UpstreamSync extends EventEmitter {
  state = { pending: null, applied: null };

  constructor(endpoint, credentials) {
    super();
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/') throw new Error('Sync upstream must be a literal loopback endpoint.');
    this.endpoint = url.origin;
    this.credentials = credentials;
  }

  async load() {
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => {}), 2000);
    this.timer.unref();
  }

  summary() { return this.state; }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const response = await fetch(`${this.endpoint}/api/state`, {
        headers: { Authorization: `Bearer ${this.credentials.dashboardToken}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Original Browser Service is unavailable.');
      const result = await response.json();
      if (JSON.stringify(this.state) !== JSON.stringify(result.sync)) {
        this.state = result.sync;
        this.emit('change', this.state);
      }
      this.emit('browser-state', { importing: Boolean(result.browser.importing), ready: Boolean(result.browser.ready) });
    })();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }

  async forward(route, method, body, uploader = false) {
    if (!['/api/sync', '/api/apply', '/cookiecloud/update'].includes(route) && !/^\/cookiecloud\/get\/[\w-]+$/.test(route)) throw new Error('Unsupported sync upstream route.');
    const response = await fetch(`${this.endpoint}${route}`, {
      method, headers: { Authorization: `Bearer ${uploader ? this.credentials.syncToken : this.credentials.dashboardToken}`,
        'Content-Type': 'application/json', Origin: this.endpoint },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
    const data = await response.json();
    await this.refresh().catch(() => {});
    return { status: response.status, data };
  }

  close() { clearInterval(this.timer); }
}
