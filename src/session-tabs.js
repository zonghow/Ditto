import path from 'node:path';
import { readJson, writePrivateJson } from './files.js';

const MAX_SESSION_TABS = 30;
const SAVE_DEBOUNCE_MS = 1200;

export function normalizeRestorableUrl(raw, ownPort = 3217) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  let parsed;
  try { parsed = new URL(trimmed); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  // Never persist Ditto's own viewer shell or built-in demo page as a restored tab.
  if (['127.0.0.1', 'localhost'].includes(parsed.hostname) &&
    [String(ownPort), '3217'].includes(parsed.port || '') &&
    ['/', '/index.html', '/demo.html'].includes(parsed.pathname)) {
    return null;
  }
  return parsed.href;
}

function normalizeTitle(raw, fallbackUrl) {
  const clean = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return clean && clean !== '新标签页' ? clean : fallbackUrl;
}

export class SessionTabsStore {
  saveTimer = null;
  saving = Promise.resolve();
  lastSignature = null;
  latestSnapshot = null;

  constructor(dataDir = null, { port = 3217 } = {}) {
    this.file = dataDir ? path.join(dataDir, 'tabs.json') : null;
    this.port = port;
  }

  async load() {
    if (!this.file) return { activeIndex: 0, tabs: [] };
    const saved = await readJson(this.file);
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.tabs)) {
      return { activeIndex: 0, tabs: [] };
    }
    const tabs = [];
    for (const item of saved.tabs) {
      if (tabs.length >= MAX_SESSION_TABS) break;
      const url = normalizeRestorableUrl(item?.url, this.port);
      if (!url) continue;
      tabs.push({ url, title: normalizeTitle(item?.title, url) });
    }
    const rawActive = Number(saved.activeIndex);
    const activeIndex = Number.isInteger(rawActive) && rawActive >= 0 && rawActive < tabs.length ? rawActive : 0;
    const snapshot = { version: 1, activeIndex, tabs };
    this.latestSnapshot = snapshot;
    this.lastSignature = JSON.stringify({ activeIndex, tabs });
    return { activeIndex, tabs };
  }

  buildSnapshot(orderedVisibleTabs, activeTabId = null) {
    const tabs = [];
    let activeIndex = 0;
    for (const tab of orderedVisibleTabs || []) {
      if (tabs.length >= MAX_SESSION_TABS) break;
      if (!tab || tab.hidden || tab.crashed) continue;
      const liveUrl = (() => {
        try { return tab.page && !tab.page.isClosed?.() ? tab.page.url() : tab.url; } catch { return tab.url; }
      })();
      const candidate = (liveUrl && liveUrl !== 'about:blank') ? liveUrl : (tab.pendingRestoreUrl || tab.url);
      const url = normalizeRestorableUrl(candidate, this.port);
      if (!url) continue;
      if (activeTabId && tab.id === activeTabId) activeIndex = tabs.length;
      tabs.push({ url, title: normalizeTitle(tab.title, url) });
    }
    if (activeIndex >= tabs.length) activeIndex = 0;
    return { version: 1, activeIndex, tabs };
  }

  update(orderedVisibleTabs, activeTabId = null, { immediate = false } = {}) {
    if (!this.file) return false;
    const snapshot = this.buildSnapshot(orderedVisibleTabs, activeTabId);
    const signature = JSON.stringify({ activeIndex: snapshot.activeIndex, tabs: snapshot.tabs });
    if (signature === this.lastSignature) return false;
    this.lastSignature = signature;
    this.latestSnapshot = { ...snapshot, updatedAt: new Date().toISOString() };
    this.scheduleSave(immediate);
    return true;
  }

  scheduleSave(immediate = false) {
    if (!this.file || !this.latestSnapshot) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (immediate) {
      this.persist();
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  persist() {
    if (!this.file || !this.latestSnapshot) return this.saving;
    const payload = this.latestSnapshot;
    this.saving = this.saving
      .then(() => writePrivateJson(this.file, payload))
      .catch(() => {});
    return this.saving;
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.persist();
    } else {
      await this.saving;
    }
  }
}
