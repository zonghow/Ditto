import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { InputError, httpOrigin } from './snapshot.js';
import { orderedTabs } from './tab-order.js';

const MAX_DOWNLOADS = 20;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export async function handleDownload(browser, tab, download) {
  if (!browser.downloadsDir) return;
  const id = randomUUID();
  const suggested = path.basename(download.suggestedFilename() || 'download.bin').slice(0, 160);
  const filePath = path.join(browser.downloadsDir, `${id}-${suggested.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_')}`);
  const entry = {
    id,
    tabId: tab.id,
    filename: suggested,
    path: filePath,
    size: 0,
    status: 'downloading',
    createdAt: new Date().toISOString(),
  };
  browser.downloads.set(id, entry);
  browser.emit('change', browser.summary());
  try {
    await mkdir(browser.downloadsDir, { recursive: true, mode: 0o700 });
    await download.saveAs(filePath);
    const info = await stat(filePath);
    if (info.size > MAX_DOWNLOAD_BYTES) {
      await rm(filePath, { force: true }).catch(() => {});
      entry.status = 'too-large';
    } else {
      entry.size = info.size;
      entry.status = 'ready';
    }
  } catch {
    await rm(filePath, { force: true }).catch(() => {});
    entry.status = 'failed';
  }
  while (browser.downloads.size > MAX_DOWNLOADS) {
    const oldestKey = browser.downloads.keys().next().value;
    const oldest = browser.downloads.get(oldestKey);
    browser.downloads.delete(oldestKey);
    if (oldest?.path) rm(oldest.path, { force: true }).catch(() => {});
  }
  browser.emit('change', browser.summary());
}

export async function readPageFavicon(tab) {
  if (!tab || tab.page.isClosed() || tab.hidden || tab.crashed || tab.pendingDialog) return null;
  if (typeof tab.page.evaluate !== 'function') return null;
  return tab.page.evaluate(() => {
    const links = [...document.querySelectorAll('link[rel][href]')];
    const candidates = [];
    for (const link of links) {
      const rels = String(link.getAttribute('rel') || '').toLowerCase().trim().split(/\s+/);
      const isIcon = rels.includes('icon');
      const isTouch = rels.includes('apple-touch-icon') || rels.includes('apple-touch-icon-precomposed');
      if (!isIcon && !isTouch) continue;
      const href = (link.getAttribute('href') || '').trim();
      if (!href) continue;
      let resolved = href;
      if (!href.startsWith('data:')) {
        try { resolved = new URL(href, document.baseURI).href; } catch { continue; }
      }
      const type = String(link.getAttribute('type') || '').toLowerCase();
      const sizes = String(link.getAttribute('sizes') || '').toLowerCase();
      const sizeMatch = /(\d+)x\d+/.exec(sizes);
      const size = sizeMatch ? Number(sizeMatch[1]) : 0;
      let score = isIcon ? 100 : 40;
      if (type.includes('svg') || /\.svg(?:[?#]|$)/i.test(resolved)) score += 30;
      else if (type.includes('png') || /\.png(?:[?#]|$)/i.test(resolved)) score += 20;
      else if (type.includes('webp') || /\.webp(?:[?#]|$)/i.test(resolved)) score += 18;
      if (size >= 32 && size <= 64) score += 15;
      else if (size === 16 || (size > 64 && size <= 192)) score += 8;
      candidates.push({ url: resolved, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length) return candidates[0].url;
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      return `${location.origin}/favicon.ico`;
    }
    return null;
  }).catch(() => null);
}

export function refreshTab(browser, tab, { refreshFavicon = false, fromTick = false } = {}) {
  if (!tab || tab.page.isClosed() || tab.hidden || tab.pendingDialog) return Promise.resolve();
  if (tab.refreshPromise) {
    if (!fromTick) {
      tab.refreshQueued = {
        refreshFavicon: Boolean(tab.refreshQueued?.refreshFavicon || refreshFavicon),
      };
    }
    return tab.refreshPromise;
  }
  tab.refreshing = true;
  tab.refreshPromise = (async () => {
    let nextOpts = { refreshFavicon };
    while (nextOpts) {
      const currentRefreshFavicon = Boolean(nextOpts.refreshFavicon);
      tab.refreshQueued = null;
      if (tab.page.isClosed() || tab.hidden || tab.pendingDialog) break;
      try {
        const nextUrl = tab.page.url();
        const nextTitle = await tab.page.title();
        let nextFavicon = tab.favicon || null;
        if (!/^https?:\/\//i.test(nextUrl)) {
          nextFavicon = null;
          tab.faviconUrlFor = nextUrl;
        } else if (currentRefreshFavicon || tab.faviconUrlFor !== nextUrl) {
          const rawFavicon = await browser.readPageFavicon(tab);
          tab.faviconUrlFor = nextUrl;
          const ref = rawFavicon ? browser.assets.reference(tab.id, rawFavicon, nextUrl, true) : null;
          nextFavicon = ref && (ref.startsWith('/api/assets/') || (ref.startsWith('data:image/') && !ref.startsWith('data:image/gif;base64,R0lGODlhAQABAAD/')))
            ? ref : null;
        }
        const urlChanged = tab.url !== nextUrl;
        const changed = urlChanged || tab.title !== nextTitle || (tab.favicon || null) !== nextFavicon;
        if (urlChanged) browser.refreshHistory(tab);
        tab.url = nextUrl;
        tab.title = nextTitle;
        tab.favicon = nextFavicon;
        if (!browser.importing && (urlChanged || !tab.originObserved)) {
          tab.originObserved = true;
          browser.emit('cookie-origin', nextUrl);
        }
        if (!browser.importing && tab.recordingStatus !== 'excluded' && /^https?:\/\//i.test(nextUrl) && (changed || !tab.historyRecorded)) {
          tab.historyRecorded = true;
          browser.emit('visit', { url: nextUrl, title: nextTitle });
        }
        if (changed) browser.emit('change', browser.summary());
      } catch { /* A navigation can destroy its execution context. Next tick retries. */ }
      nextOpts = tab.refreshQueued;
    }
  })().finally(() => {
    tab.refreshing = false;
    tab.refreshPromise = null;
    tab.refreshQueued = null;
  });
  return tab.refreshPromise;
}

export async function refreshHistory(browser, tab) {
  if (!tab?.cdp || tab.historyBusy || tab.page.isClosed()) return;
  tab.historyBusy = true;
  try {
    const history = await tab.cdp.send('Page.getNavigationHistory');
    tab.canGoBack = history.currentIndex > 0;
    tab.canGoForward = history.currentIndex < history.entries.length - 1;
    browser.emit('change', browser.summary());
  } catch { /* Navigation/crashed target. */ }
  finally { tab.historyBusy = false; }
}

export function placeTabAfter(browser, tab, afterTabId) {
  if (!tab || !afterTabId || tab.id === afterTabId) return;
  const anchor = browser.tabs.get(afterTabId);
  if (!anchor || anchor.hidden) return;
  const others = orderedTabs(
    [...browser.tabs.values()].filter(item => !item.hidden && item.id !== tab.id),
    browser.tabOrder,
  );
  const idx = others.findIndex(item => item.id === afterTabId);
  if (idx < 0) return;
  others.splice(idx + 1, 0, tab);
  others.forEach((item, position) => { item.orderRank = (position + 1) * 1000; });
}

export async function openTab(browser, url = 'about:blank', { afterTabId = null } = {}) {
  if (!browser.ready || browser.importing) throw new InputError('浏览器尚未就绪或正在应用登录态。', 409);
  if (url !== 'about:blank') httpOrigin(url);
  const page = await browser.context.newPage();
  browser.track(page);
  const tab = [...browser.tabs.values()].find(item => item.page === page);
  if (afterTabId) browser.placeTabAfter(tab, afterTabId);
  if (url !== 'about:blank') {
    const navSeq = (tab.navSeq || 0) + 1;
    tab.navSeq = navSeq;
    tab.loading = true;
    tab.url = url;
    browser.emit('change', browser.summary());
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {
        // Leave navigation errors visible in Chromium rather than claiming the page succeeded.
      });
    } finally {
      if (tab.navSeq === navSeq) tab.loading = false;
    }
  }
  await browser.refresh(tab);
  await page.bringToFront();
  await browser.tabOrder?.refresh().catch(() => {});
  browser.emit('change', browser.summary());
  return tab.id;
}

export async function recoverCrashedTab(browser, tab, targetUrl, { bringToFront = true } = {}) {
  const safeTarget = targetUrl && targetUrl !== 'about:blank' ? targetUrl : 'about:blank';
  if (safeTarget !== 'about:blank') httpOrigin(safeTarget);
  const page = await browser.context.newPage();
  browser.track(page);
  const fresh = [...browser.tabs.values()].find(item => item.page === page);
  if (fresh) {
    if (Number.isFinite(tab.orderRank)) fresh.orderRank = tab.orderRank;
    if (tab.ownerSession) {
      fresh.ownerSession = tab.ownerSession;
      if (browser.sessionTabs.get(tab.ownerSession) === tab.id) browser.sessionTabs.set(tab.ownerSession, fresh.id);
    }
    if (tab.agentMeta) fresh.agentMeta = tab.agentMeta;
  }
  if (safeTarget !== 'about:blank') {
    await page.goto(safeTarget, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  }
  if (fresh) {
    await browser.refresh(fresh);
    await browser.ensureRecorder(fresh);
    await browser.checkpoint(fresh, true);
    await browser.refreshHistory(fresh);
  }
  if (bringToFront) await page.bringToFront().catch(() => {});
  await tab.page.close().catch(() => {});
  if (browser.tabs.has(tab.id)) {
    browser.tabs.delete(tab.id);
    browser.assets.removeScope(tab.id);
  }
  await browser.tabOrder?.refresh().catch(() => {});
  browser.emit('change', browser.summary());
  return fresh?.id || null;
}

export async function executeTabAction(browser, tab, action, { url, bringToFront = true, promptText } = {}) {
  if (action === 'activate') {
    await tab.page.bringToFront();
  } else if (action === 'close') {
    if (tab.pendingDialog) throw new InputError('先处理这个标签页的原生弹窗。', 409);
    if ([...browser.tabs.values()].filter(item => !item.hidden && !item.page.isClosed()).length === 1) {
      tab.replacementId = await browser.open();
    }
    tab.closing = true;
    await tab.page.close({ runBeforeUnload: true });
    if (!tab.page.isClosed()) {
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); tab.page.off('close', done); resolve(); };
        const timer = setTimeout(done, 400);
        tab.page.once('close', done);
      });
    }
    return { tabId: tab.id, replacementId: tab.replacementId || null, closed: tab.page.isClosed() };
  } else if (action === 'close-others' || action === 'close-after' || action === 'close-all') {
    const visible = orderedTabs([...browser.tabs.values()].filter(item => !item.hidden && !item.page.isClosed()), browser.tabOrder);
    let targets = [];
    if (action === 'close-others') {
      targets = visible.filter(item => item.id !== tab.id);
    } else if (action === 'close-after') {
      const idx = visible.findIndex(item => item.id === tab.id);
      targets = idx >= 0 ? visible.slice(idx + 1) : [];
    } else {
      targets = visible;
    }
    if (!targets.length) return { tabId: tab.id, closedCount: 0, skippedCount: 0, replacementId: null };
    let replacementId = null;
    if (targets.length >= visible.length) {
      replacementId = await browser.open('about:blank');
    }
    let closedCount = 0;
    let skippedCount = 0;
    for (const target of targets) {
      if (target.page.isClosed()) continue;
      if (target.pendingDialog) { skippedCount++; continue; }
      target.closing = true;
      await target.page.close({ runBeforeUnload: true }).catch(() => {});
      if (!target.page.isClosed()) {
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); target.page.off('close', done); resolve(); };
          const timer = setTimeout(done, 250);
          target.page.once('close', done);
        });
      }
      if (target.page.isClosed()) closedCount++;
      else {
        if (!target.pendingDialog) target.closing = false;
        skippedCount++;
      }
    }
    await browser.tabOrder?.refresh().catch(() => {});
    browser.emit('change', browser.summary());
    return { tabId: tab.id, closedCount, skippedCount, replacementId };
  } else if (action === 'confirm-close' || action === 'cancel-close') {
    if (!tab.closing || tab.pendingDialog?.type() !== 'beforeunload') throw new InputError('没有待确认的关闭操作。', 409);
    if (action === 'confirm-close') await tab.pendingDialog.accept();
    else { await tab.pendingDialog.dismiss(); tab.closing = false; }
    tab.pendingDialog = null;
    tab.dialog = null;
  } else if (action === 'accept-dialog' || action === 'dismiss-dialog') {
    if (!tab.pendingDialog) throw new InputError('当前没有待处理的原生弹窗。', 409);
    if (action === 'accept-dialog') {
      const text = typeof promptText === 'string' ? promptText.slice(0, 4096) : undefined;
      await tab.pendingDialog.accept(tab.pendingDialog.type() === 'prompt' ? text : undefined);
    } else {
      await tab.pendingDialog.dismiss();
      if (tab.closing) tab.closing = false;
    }
    tab.pendingDialog = null;
    tab.dialog = null;
  } else if (action === 'stop') {
    tab.navSeq = (tab.navSeq || 0) + 1;
    try {
      if (tab.cdp) await tab.cdp.send('Page.stopLoading');
      else await tab.page.evaluate(() => window.stop());
    } catch { /* Ignore if page already settled or detached. */ }
    tab.loading = false;
    if (!tab.crashed && !tab.page.isClosed()) {
      await browser.refresh(tab);
      await browser.ensureRecorder(tab);
      await browser.checkpoint(tab, true);
      await browser.refreshHistory(tab);
    }
  } else {
    if (tab.pendingDialog) throw new InputError('先处理当前页面的原生弹窗。', 409);
    if (action === 'navigate' && url !== 'about:blank') httpOrigin(url);
    if ((action === 'back' && !tab.canGoBack) || (action === 'forward' && !tab.canGoForward)) {
      throw new InputError('没有可以访问的历史记录。', 409);
    }
    if (tab.crashed && (action === 'reload' || action === 'navigate')) {
      const targetUrl = action === 'navigate' ? url : tab.url;
      const replacementId = await browser.recoverCrashedTab(tab, targetUrl, { bringToFront });
      return { tabId: bringToFront ? tab.id : (replacementId || tab.id), replacementId, closed: false, recovered: true };
    }
    const navSeq = (tab.navSeq || 0) + 1;
    tab.navSeq = navSeq;
    tab.loading = true;
    if (action === 'navigate' && url) tab.url = url;
    tab.documentId = null;
    tab.recording = null;
    tab.sanitizer = null;
    tab.recordingStatus = 'starting';
    browser.emit('change', browser.summary());
    browser.emit('recording', { type: 'rrweb-reset', tabId: tab.id, documentId: null });
    let crashedDuringNav = false;
    try {
      if (bringToFront) await tab.page.bringToFront();
      const options = { waitUntil: 'domcontentloaded', timeout: 20000 };
      if (action === 'navigate') await tab.page.goto(url, options);
      else if (action === 'reload') await tab.page.reload(options);
      else if (action === 'back') await tab.page.goBack(options);
      else await tab.page.goForward(options);
    } catch (error) {
      if (tab.navSeq === navSeq && /Target crashed|Page crashed/i.test(error?.message || '')) {
        tab.crashed = true;
        tab.recordingStatus = 'crashed';
        crashedDuringNav = true;
      }
      /* Leave Chromium's navigation error visible in the actual tab. */
    } finally {
      if (tab.navSeq === navSeq) {
        tab.loading = false;
        if (!tab.crashed && !tab.page.isClosed()) {
          await browser.refresh(tab);
          await browser.ensureRecorder(tab);
          await browser.checkpoint(tab, true);
          await browser.refreshHistory(tab);
        } else if (tab.crashed) {
          tab.recordingStatus = 'crashed';
        }
      }
    }
    if (tab.navSeq !== navSeq) {
      return { tabId: tab.id, closed: tab.page.isClosed(), superseded: true };
    }
    if (crashedDuringNav && (action === 'reload' || action === 'navigate')) {
      const targetUrl = action === 'navigate' ? url : tab.url;
      const replacementId = await browser.recoverCrashedTab(tab, targetUrl, { bringToFront });
      return { tabId: bringToFront ? tab.id : (replacementId || tab.id), replacementId, closed: false, recovered: true };
    }
  }
  await browser.tabOrder?.refresh().catch(() => {});
  browser.emit('change', browser.summary());
  return { tabId: tab.id, closed: tab.page.isClosed() };
}

export async function dispatchTabAction(browser, tabId, action, { url, promptText } = {}) {
  if (!browser.ready || browser.importing) throw new InputError('浏览器正在启动或应用登录态。', 409);
  const tab = browser.tabs.get(tabId);
  if (!tab || tab.hidden || tab.page.isClosed()) throw new InputError('这个远端标签页已关闭。', 404);
  const allowed = ['activate', 'navigate', 'reload', 'stop', 'back', 'forward', 'close',
    'close-others', 'close-after', 'close-all', 'confirm-close', 'cancel-close',
    'accept-dialog', 'dismiss-dialog'];
  if (!allowed.includes(action)) throw new InputError('不支持的标签页操作。');
  return browser._executeTabAction(tab, action, { url, promptText, bringToFront: true });
}
