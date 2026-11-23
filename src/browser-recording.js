import { MAX_ASSET_BYTES } from './assets.js';
import { RecordingBuffer, RecordingSanitizer } from './recording.js';
import { RECORDER_KEY } from './recorder.js';

export function isTabWatched(browser, tabId) {
  if (!browser.viewers.size) return false;
  for (const [viewerId, viewer] of browser.viewers.entries()) {
    if (viewer.paused) continue;
    // A viewer streaming JPEG screencast frames for this tab does not need rrweb DOM replay.
    if (browser.screencast?.isViewerWatching?.(tabId, viewerId)) continue;
    if (viewer.viewMode === 'overview' || !viewer.selected || viewer.selected === tabId) return true;
  }
  return false;
}

export function syncTabWatched(browser, tab) {
  if (!tab || tab.hidden || tab.crashed || tab.page?.isClosed?.() || typeof tab.page?.evaluate !== 'function') return;
  const watched = browser.isTabWatched(tab.id);
  if (Boolean(tab.lastWatched) === watched) return;
  tab.lastWatched = watched;
  tab.page.evaluate(({ key, active }) => {
    const rec = window[key];
    if (!rec?.setWatched) return false;
    rec.setWatched(active);
    return true;
  }, {
    key: RECORDER_KEY,
    active: watched,
  }).then(applied => {
    if (applied === false && tab.lastWatched === watched) tab.lastWatched = !watched;
  }).catch(() => {
    if (tab.lastWatched === watched) tab.lastWatched = !watched;
  });
}

export function syncAllRecorderWatchState(browser) {
  for (const tab of browser.tabs.values()) browser.syncTabWatched(tab);
}

export async function ensureRecorder(browser, tab) {
  if (!tab || tab.busy || tab.page.isClosed() || tab.hidden || browser.importing || tab.crashed || tab.pendingDialog) return;
  try {
    const url = new URL(tab.page.url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname) && [String(browser.config.port), '3217'].includes(url.port) && ['/', '/index.html'].includes(url.pathname)) {
      tab.recordingStatus = 'excluded'; // Never record the viewer's pairing panel into itself.
      return;
    }
  } catch {}
  tab.busy = true;
  try {
    const isViewer = await tab.page.evaluate(() => Boolean(document.querySelector?.('meta[name="ditto-viewer"]'))).catch(() => false);
    if (isViewer) {
      tab.recordingStatus = 'excluded';
      return;
    }
    const current = await tab.page.evaluate(({ key, instanceId }) => window[key]?.instanceId === instanceId ? window[key].documentId : null,
      { key: RECORDER_KEY, instanceId: browser.recordingInstance });
    if (current) {
      browser.syncTabWatched(tab);
      return;
    }
    const url = tab.page.url();
    if (!/^https?:|^about:blank$/.test(url)) {
      tab.recordingStatus = 'unsupported';
      return;
    }
    await tab.page.evaluate(browser.source);
    // An injection that never started would leave the tab silent while the
    // server keeps a stale identity. Verify, then retry once.
    const started = await tab.page.evaluate(({ key, instanceId }) =>
      window[key]?.instanceId === instanceId && window[key].active === true,
    { key: RECORDER_KEY, instanceId: browser.recordingInstance }).catch(() => false);
    if (!started) {
      await new Promise(resolve => setTimeout(resolve, 250));
      await tab.page.evaluate(browser.source);
    }
    tab.lastWatched = false;
    browser.syncTabWatched(tab);
  } catch { /* Navigation/CSP/restricted pages may not expose a DOM to record. */ }
  finally { tab.busy = false; }
}

export function startDocument(browser, tab, page, documentId) {
  if (tab.documentId === documentId) return false;
  tab.documentId = documentId;
  tab.recording = new RecordingBuffer(tab.id, documentId);
  tab.sanitizer = new RecordingSanitizer(browser.assets, tab.id, page.url());
  tab.recordedAt = null;
  tab.recordingStatus = 'starting';
  tab.crashed = false;
  tab.lastWatched = false;
  browser.assets.advanceScope(tab.id);
  browser.syncTabWatched(tab);
  browser.emit('change', browser.summary());
  browser.emit('recording', { type: 'rrweb-reset', tabId: tab.id, documentId });
  return true;
}

// A companion restart re-injects the recorder into an already open page, so the
// page can hold a newer identity than the tab. Its mutations would otherwise be
// dropped forever (stale replay, "page navigated" on every control command).
// Ask the page which recorder is live instead of trusting whichever event wins.
export async function reconcileRecorder(browser, tab, page) {
  if (tab.reconciling || Date.now() - (tab.reconciledAt || 0) < 2000) return;
  tab.reconciling = true;
  tab.reconciledAt = Date.now();
  try {
    const current = await page.evaluate(key => window[key]?.documentId ?? null, RECORDER_KEY).catch(() => null);
    if (typeof current !== 'string' || !current || current.length > 100) return;
    if (current !== tab.documentId) browser.startDocument(tab, page, current);
    // Either way the live recorder must resend identity plus a full snapshot.
    browser.checkpoint(tab);
  } finally { tab.reconciling = false; }
}

export function receiveRecording(browser, { page, frame }, message) {
  if (!page || browser.importing || browser.hiddenPages.has(page) || page.isClosed() || !message || typeof message.documentId !== 'string' || message.documentId.length > 100) return;
  browser.track(page);
  const tab = [...browser.tabs.values()].find(item => item.page === page);
  if (!tab || tab.hidden) return;
  if (message.type === 'start') {
    browser.frameDocuments.set(frame, message.documentId);
    if (frame !== page.mainFrame()) return;
    browser.startDocument(tab, page, message.documentId);
    return;
  }
  if (frame !== page.mainFrame()) return;
  if (message.documentId !== tab.documentId) {
    browser.reconcileRecorder(tab, page).catch(() => {});
    return;
  }
  if (message.type === 'video-tainted') {
    browser.captureTaintedVideo(tab, message).catch(() => {});
    return;
  }
  if (message.type !== 'event') return;
  try {
    const event = tab.sanitizer.event(message.event);
    const update = tab.recording.append(event);
    if (!update) {
      if (tab.recording.needsCheckpoint) {
        if (event?.type === 2) {
          tab.recordingStatus = 'limited';
          tab.largeSnapshot = true;
          browser.emit('change', browser.summary());
        } else browser.checkpoint(tab);
      }
      return;
    }
    tab.recordedAt = new Date().toISOString();
    tab.recordingStatus = 'live';
    tab.largeSnapshot = false;
    if (update.type === 'rrweb-snapshot') browser.emit('change', browser.summary());
    browser.emit('recording', update);
  } catch {
    tab.recordingStatus = 'limited';
    tab.recording.needsCheckpoint = true;
    browser.emit('change', browser.summary());
    // Never include raw recording/protocol errors in logs or model context.
  }
}

export async function captureTaintedVideo(browser, tab, message) {
  if (browser.importing || tab.hidden || tab.page.isClosed() || !tab.cdp || tab.videoCaptureBusy || !browser.tabs.has(tab.id)) return;
  if (!browser.isTabWatched(tab.id)) return;
  const id = message?.id;
  const clip = message?.clip;
  if (!Number.isInteger(id) || id < 1 || !clip || typeof clip !== 'object') return;
  if (Date.now() - (tab.lastVideoCaptureAt || 0) < 400) return;
  const x = Math.max(0, Math.min(16384, Number(clip.x) || 0));
  const y = Math.max(0, Math.min(16384, Number(clip.y) || 0));
  const width = Math.max(0, Math.min(16384, Number(clip.width) || 0));
  const height = Math.max(0, Math.min(16384, Number(clip.height) || 0));
  if (width < 4 || height < 4) return;
  const scale = Math.min(1, 720 / width, 480 / height);
  const docId = tab.documentId;
  tab.videoCaptureBusy = true;
  tab.lastVideoCaptureAt = Date.now();
  let timer = null;
  try {
    const shot = await Promise.race([
      tab.cdp.send('Page.captureScreenshot', { format: 'webp', quality: 58, clip: { x, y, width, height, scale } }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 1500); }),
    ]);
    if (!shot?.data || tab.hidden || tab.documentId !== docId || !browser.tabs.has(tab.id)) return;
    const dataUrl = `data:image/webp;base64,${shot.data}`;
    if (dataUrl.length > 1024 * 1024) return;
    const naturalWidth = Number.isFinite(message.width) ? message.width : Math.round(width);
    const naturalHeight = Number.isFinite(message.height) ? message.height : Math.round(height);
    const event = tab.sanitizer?.event({
      type: 5,
      timestamp: Date.now(),
      data: { tag: 'ditto-video', payload: { id, width: naturalWidth, height: naturalHeight, dataUrl } },
    });
    const update = tab.recording?.append(event);
    if (update) browser.emit('recording', update);
  } catch { /* Occluded/detached target or navigation during screenshot. */ }
  finally {
    clearTimeout(timer);
    tab.videoCaptureBusy = false;
  }
}

export async function checkpoint(browser, tab, force = false) {
  if (tab.checkpointPending || tab.hidden || tab.page.isClosed() || browser.importing) return;
  if (!browser.isTabWatched(tab.id)) return;
  if (!force && tab.largeSnapshot && Date.now() - (tab.lastCheckpoint || 0) < 30000) return;
  if (!force && Date.now() - (tab.lastCheckpoint || 0) < 1000) return;
  tab.lastCheckpoint = Date.now();
  tab.checkpointPending = true;
  try { await tab.page.evaluate(key => window[key]?.checkpoint(), RECORDER_KEY); }
  catch { /* Retry at the next metadata tick after a navigation. */ }
  finally { tab.checkpointPending = false; }
}

export function captureResource(browser, tab, response) {
  if (browser.importing || tab.hidden || tab.resourceTasks.size >= 64 || !browser.tabs.has(tab.id)) return;
  if (response.status() !== 200) return;
  const rtype = response.request().resourceType();
  const isFaviconHint = rtype === 'other' && (/favicon|apple-touch-icon|\.ico(?:[?#]|$)/i.test(response.url())
    || /^image\//i.test(response.headers()['content-type'] || ''));
  if (!['image', 'font', 'stylesheet'].includes(rtype) && !isFaviconHint) return;
  const task = (async () => {
    const headers = await response.allHeaders();
    if (Number(headers['content-length'] || 0) > MAX_ASSET_BYTES) return;
    const body = await response.body();
    if (tab.hidden || !browser.tabs.has(tab.id)) return;
    browser.assets.put(tab.id, response.url(), headers['content-type'] || '', body);
  })().catch(() => {});
  tab.resourceTasks.add(task);
  task.finally(() => tab.resourceTasks.delete(task));
}

export async function captureCachedResources(browser, tab) {
  if (tab.hidden || tab.page.isClosed()) return;
  try {
    tab.cdp = await browser.context.newCDPSession(tab.page);
    const { targetInfo } = await tab.cdp.send('Target.getTargetInfo');
    tab.targetId = targetInfo.targetId;
    const window = await tab.cdp.send('Browser.getWindowForTarget').catch(() => null);
    tab.windowId = window?.windowId;
    await browser.refreshHistory(tab);
    browser.tabOrder?.refresh().catch(() => {});
    browser.emit('change', browser.summary());
    const { frameTree } = await tab.cdp.send('Page.getResourceTree');
    const visit = async tree => {
      for (const resource of (tree.resources || []).slice(0, 200)) {
        if (!['Image', 'Font', 'Stylesheet'].includes(resource.type) || !browser.tabs.has(tab.id)) continue;
        try {
          const result = await tab.cdp.send('Page.getResourceContent', { frameId: tree.frame.id, url: resource.url });
          browser.assets.put(tab.id, resource.url, resource.mimeType,
            Buffer.from(result.content, result.base64Encoded ? 'base64' : 'utf8'));
        } catch { /* Resource was evicted from the Chromium cache. No re-fetch. */ }
      }
      for (const child of tree.childFrames || []) await visit(child);
    };
    await visit(frameTree);
  } catch { /* A new or crashed document may not yet have a resource tree. */ }
}

// A recorded page can reference an image whose bytes were never cached, for
// example when it painted during login-state import. Re-fetch that exact
// recorded URL from the owned browser so the replay can show it. Only URLs the
// observed page itself put in its DOM are eligible, and never a viewer-supplied one.
export function refillAsset(browser, id) {
  const source = browser.assets.source(id);
  if (!source || !browser.context || browser.assets.get(id)?.body) return Promise.resolve(false);
  const running = browser.assetRefills.get(id);
  if (running) return running;
  const missed = browser.assetMisses.get(id);
  if (missed && Date.now() - missed < 60000) return Promise.resolve(false);
  const task = (async () => {
    try {
      const response = await browser.context.request.get(source.url, {
        timeout: 15000, failOnStatusCode: false, maxRedirects: 5,
      });
      if (response.status() !== 200 && response.status() !== 304) return false;
      const headers = response.headers();
      if (Number(headers['content-length'] || 0) > MAX_ASSET_BYTES) return false;
      const body = await response.body();
      if (body.length > MAX_ASSET_BYTES) return false;
      return browser.assets.put(source.scope, source.url, headers['content-type'] || '', body);
    } catch { return false; }
  })().then(stored => {
    if (!stored) browser.assetMisses.set(id, Date.now());
    return stored;
  }).finally(() => { browser.assetRefills.delete(id); if (browser.assetMisses.size > 500) browser.assetMisses.clear(); });
  browser.assetRefills.set(id, task);
  return task;
}
