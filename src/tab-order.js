import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

// Native position lives on Chromium "tab" targets, not "page" targets. Map
// them through non-pausing child-target notifications. No extension, navigation
// or privileged browser binding is injected into an observed website.
export class NativeTabOrder extends EventEmitter {
  pending = new Map();
  sessions = new Map();
  pageTabs = new Map();
  tabs = new Map();
  nextId = 0;

  async start(endpoint) {
    const base = new URL(endpoint);
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port) throw new Error('Tab inventory requires loopback CDP.');
    const response = await fetch(`${base.origin}/json/version`, { signal: AbortSignal.timeout(5000) });
    const { webSocketDebuggerUrl } = await response.json();
    const socketUrl = new URL(webSocketDebuggerUrl);
    if (socketUrl.hostname !== '127.0.0.1' || socketUrl.protocol !== 'ws:') throw new Error('Unexpected CDP inventory endpoint.');
    this.socket = new WebSocket(socketUrl.href);
    this.socket.on('message', raw => this.receive(raw));
    this.socket.on('error', () => {});
    this.socket.on('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP tab inventory disconnected.')); }
      this.pending.clear();
    });
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    await this.refresh();
  }

  send(method, params = {}, sessionId) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Tab inventory unavailable.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP tab inventory timed out.')); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  receive(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error('CDP tab inventory command unavailable.'));
      else pending.resolve(message.result);
    } else if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'page') {
      const tabId = [...this.sessions].find(([, session]) => session === message.sessionId)?.[0];
      if (tabId) { this.pageTabs.set(message.params.targetInfo.targetId, tabId); this.emit('change'); }
    }
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const { targetInfos } = await this.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
      const next = new Map(targetInfos.filter(info => Number.isInteger(info.embedderData?.tabStripIndex)).map(info => [info.targetId, {
        nativeTabId: info.targetId, index: info.embedderData.tabStripIndex,
        active: Boolean(info.embedderData.tabActive), pinned: Boolean(info.embedderData.tabPinned),
      }]));
      const changed = JSON.stringify([...next]) !== JSON.stringify([...this.tabs]);
      this.tabs = next;
      for (const [tabId, sessionId] of this.sessions) if (!next.has(tabId)) {
        this.sessions.delete(tabId);
        await this.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        for (const [pageId, parent] of this.pageTabs) if (parent === tabId) this.pageTabs.delete(pageId);
      }
      for (const info of targetInfos) if (!this.sessions.has(info.targetId) && next.has(info.targetId)) {
        try {
          const { sessionId } = await this.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
          this.sessions.set(info.targetId, sessionId);
          await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
        } catch { /* The UI explicitly marks older Chromium's fallback order. */ }
      }
      if (changed) this.emit('change');
    })();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }

  get(pageId) { return this.tabs.get(this.pageTabs.get(pageId)); }
  close() { this.socket?.close(); this.socket = null; }
}

export function orderedTabs(tabs, inventory) {
  return [...tabs].sort((left, right) => {
    if (Number.isFinite(left.orderRank) && Number.isFinite(right.orderRank) && left.orderRank !== right.orderRank) {
      return left.orderRank - right.orderRank;
    }
    const a = inventory?.get(left.targetId), b = inventory?.get(right.targetId);
    if (a && b) return (left.windowId || 0) - (right.windowId || 0) || a.index - b.index;
    if (a || b) return a ? -1 : 1;
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
}
