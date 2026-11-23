import path from 'node:path';
import { readJson, writePrivateJson } from './files.js';

const MAX_ENTRIES = 500;
const SAVE_DEBOUNCE_MS = 1500;

function normalizeHistoryUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let parsed;
  try { parsed = new URL(trimmed); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  return parsed.href;
}

function normalizeTitle(title, fallbackUrl) {
  const clean = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return clean || fallbackUrl;
}

function matchScore(entry, tokens, fullQuery) {
  const urlLower = entry.url.toLowerCase();
  const titleLower = (entry.title || '').toLowerCase();
  let hostLower = '';
  let pathLower = '';
  try {
    const parsed = new URL(entry.url);
    hostLower = parsed.host.toLowerCase();
    pathLower = `${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();
  } catch {
    hostLower = urlLower;
  }

  if (tokens.length) {
    const combined = `${hostLower} ${pathLower} ${titleLower}`;
    for (const token of tokens) {
      if (!combined.includes(token)) return -1;
    }
  }

  let score = 0;
  if (fullQuery) {
    if (hostLower.startsWith(fullQuery)) score += 120;
    else if (hostLower.includes(`.${fullQuery}`) || hostLower.includes(`-${fullQuery}`)) score += 95;
    else if (hostLower.includes(fullQuery)) score += 75;
    if (titleLower.startsWith(fullQuery)) score += 65;
    else if (titleLower.includes(fullQuery)) score += 45;
    if (pathLower.includes(fullQuery)) score += 35;
  }
  for (const token of tokens) {
    if (hostLower.startsWith(token)) score += 30;
    else if (hostLower.includes(token)) score += 18;
    if (titleLower.includes(token)) score += 14;
    if (pathLower.includes(token)) score += 10;
  }

  // Frecency tie-breaker: recent visits + visit frequency.
  const ageHours = Math.max(0, (Date.now() - (entry.lastVisited || 0)) / 3600000);
  const recency = 30 / (1 + ageHours / 24);
  const frequency = Math.min(25, Math.log2((entry.visitCount || 1) + 1) * 6);
  return score + recency + frequency;
}

export function rankHistoryItems(entries, query = '', limit = 8) {
  const cap = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const fullQuery = String(query || '').trim().toLowerCase();
  const tokens = fullQuery ? fullQuery.split(/\s+/).filter(Boolean).slice(0, 6) : [];
  const ranked = [];
  for (const entry of entries) {
    if (!entry?.url) continue;
    const score = matchScore(entry, tokens, fullQuery);
    if (score < 0) continue;
    ranked.push({ entry, score });
  }
  ranked.sort((a, b) => b.score - a.score || (b.entry.lastVisited || 0) - (a.entry.lastVisited || 0));
  return ranked.slice(0, cap).map(({ entry }) => ({
    url: entry.url,
    title: entry.title || entry.url,
    visitCount: entry.visitCount || 1,
    lastVisited: entry.lastVisited || 0,
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.removable !== undefined ? { removable: entry.removable } : {}),
  }));
}

export class HistoryStore {
  entries = new Map();
  saveTimer = null;
  saving = Promise.resolve();

  constructor(dataDir = null) {
    this.file = dataDir ? path.join(dataDir, 'history.json') : null;
  }

  async load() {
    if (!this.file) return;
    const saved = await readJson(this.file);
    if (!Array.isArray(saved)) return;
    this.entries.clear();
    for (const item of saved.slice(0, MAX_ENTRIES)) {
      const url = normalizeHistoryUrl(item?.url);
      if (!url) continue;
      this.entries.set(url, {
        url,
        title: normalizeTitle(item.title, url),
        visitCount: Number.isInteger(item.visitCount) && item.visitCount > 0 ? item.visitCount : 1,
        lastVisited: Number.isFinite(item.lastVisited) ? item.lastVisited : Date.now(),
      });
    }
  }

  record(rawUrl, rawTitle = '') {
    const url = normalizeHistoryUrl(rawUrl);
    if (!url) return false;
    const now = Date.now();
    const existing = this.entries.get(url);
    const title = normalizeTitle(rawTitle, existing?.title || url);
    if (existing) {
      const sameBurst = now - existing.lastVisited < 10000;
      const betterTitle = rawTitle && rawTitle.trim() && rawTitle.trim() !== url;
      if (betterTitle || !existing.title) existing.title = title;
      if (!sameBurst) existing.visitCount += 1;
      existing.lastVisited = now;
    } else {
      this.entries.set(url, { url, title, visitCount: 1, lastVisited: now });
      this.prune();
    }
    this.scheduleSave();
    return true;
  }

  remove(rawUrl) {
    const url = normalizeHistoryUrl(rawUrl) || (typeof rawUrl === 'string' ? rawUrl.trim() : '');
    if (!url || !this.entries.has(url)) return false;
    this.entries.delete(url);
    this.scheduleSave(true);
    return true;
  }

  search(query = '', limit = 8) {
    return rankHistoryItems(this.entries.values(), query, limit);
  }

  prune() {
    if (this.entries.size <= MAX_ENTRIES) return;
    const sorted = [...this.entries.values()].sort((a, b) => b.lastVisited - a.lastVisited);
    this.entries = new Map(sorted.slice(0, MAX_ENTRIES).map(item => [item.url, item]));
  }

  scheduleSave(immediate = false) {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
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
    if (!this.file) return this.saving;
    const snapshot = [...this.entries.values()]
      .sort((a, b) => b.lastVisited - a.lastVisited)
      .slice(0, MAX_ENTRIES);
    this.saving = this.saving
      .then(() => writePrivateJson(this.file, snapshot))
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
