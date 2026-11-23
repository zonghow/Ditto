import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const RECORDER_KEY = '__dittoRecorderV1';
export const RECORDER_BINDING = '__dittoRrwebEmit';
export const replayAssetDirectory = path.dirname(require.resolve('@rrweb/replay'));

// This function is serialized into the observed page. It has no credentials and
// sends only rrweb events. Each actual document gets a fresh identity.
function bootstrap(bindingName, instanceId, port) {
  // rrweb's standard cross-origin bridge posts child DOM to the embedding page.
  // This PoC does not leak frame contents through that channel: same-origin
  // frames are recorded by the main recorder; cross-origin frames stay inert.
  if (window !== window.top) return;
  if (window.__dittoRecorderV1?.instanceId === instanceId || !['http:', 'https:', 'about:'].includes(location.protocol)) return;
  if (document.querySelector?.('meta[name="ditto-viewer"]')) return;
  if (location.protocol !== 'about:' && ['127.0.0.1', 'localhost'].includes(location.hostname) &&
    [String(port), '3217'].includes(location.port) && ['/', '/index.html'].includes(location.pathname)) return;
  const library = window.rrwebRecord;
  const record = library?.record || library?.default || library;
  if (typeof record !== 'function' || typeof window[bindingName] !== 'function') return;
  // A companion crash/restart must not leave a recorder emitting forever to a
  // dead binding. Never let a throwing stop() leave the old recorder alive while
  // its window slot is replaced: that produced two live recorders fighting over
  // the document identity, a frozen replay and "page navigated" on every click.
  try { window.__dittoRecorderV1?.stop(); } catch {}
  try { delete window.__dittoRecorderV1; } catch {}
  const state = { instanceId, documentId: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, active: true, recording: false, watched: false, mirrors: null, pending: 0 };
  Object.defineProperty(window, '__dittoRecorderV1', { value: state, configurable: true });
  let chain = Promise.resolve();
  const send = payload => {
    if (state.pending > 500) { state.dropped = true; return; }
    state.pending++;
    chain = chain.then(() => window[bindingName]({ documentId: state.documentId, ...payload }))
      .catch(() => {})
      .finally(() => {
        state.pending--;
        if (state.dropped && !state.pending && state.recording) {
          state.dropped = false;
          state.checkpoint();
        }
      });
  };
  send({ type: 'start' });
  const lastCanvasFrames = new WeakMap();
  const lastVideoFrames = new WeakMap();
  const taintedVideoSrc = new WeakMap();
  let videoScratchCanvas = null;
  const collectDocs = () => {
    const docs = [document];
    for (let d = 0; d < docs.length && docs.length < 8; d++) {
      let frames;
      try { frames = docs[d].querySelectorAll('iframe'); } catch { continue; }
      for (const frame of frames) {
        try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {}
      }
    }
    return docs;
  };
  const captureCanvases = (force = false) => {
    if (!state.recording || !state.mirrors?.nodeMirror) return;
    const docs = collectDocs();
    let scanned = 0;
    for (const doc of docs) {
      let canvases;
      try { canvases = doc.querySelectorAll('canvas'); } catch { continue; }
      for (const canvas of canvases) {
        if (++scanned > 24) return;
        if (!canvas.width || !canvas.height || canvas.width * canvas.height > 16_000_000) continue;
        const id = state.mirrors.nodeMirror.getId(canvas);
        if (!(id > 0)) continue;
        let dataUrl = '';
        try { dataUrl = canvas.toDataURL('image/webp', 0.8); } catch {}
        if (!dataUrl || !dataUrl.startsWith('data:image/')) {
          try { dataUrl = canvas.toDataURL('image/png'); } catch {}
        }
        if (dataUrl.length > 750_000) {
          try { dataUrl = canvas.toDataURL('image/webp', 0.5); } catch {}
        }
        if (!dataUrl || !dataUrl.startsWith('data:image/') || dataUrl.length > 1000_000) continue;
        if (!force && lastCanvasFrames.get(canvas) === dataUrl) continue;
        lastCanvasFrames.set(canvas, dataUrl);
        try { record.addCustomEvent('ditto-canvas', { id, width: canvas.width, height: canvas.height, dataUrl }); } catch {}
      }
    }
  };
  const viewportClipFor = (el, rect, win) => {
    let x = rect.left;
    let y = rect.top;
    let cur = win;
    while (cur && cur !== window) {
      let frameEl;
      try { frameEl = cur.frameElement; } catch { break; }
      if (!frameEl) break;
      const fRect = frameEl.getBoundingClientRect();
      x += fRect.left + (frameEl.clientLeft || 0);
      y += fRect.top + (frameEl.clientTop || 0);
      cur = frameEl.ownerDocument?.defaultView;
    }
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const right = Math.min(window.innerWidth, Math.round(x + rect.width));
    const bottom = Math.min(window.innerHeight, Math.round(y + rect.height));
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };
  const captureVideos = (force = false) => {
    if (!state.recording || !state.mirrors?.nodeMirror) return;
    const docs = collectDocs();
    let scanned = 0;
    for (const doc of docs) {
      let videos;
      try { videos = doc.querySelectorAll('video'); } catch { continue; }
      const win = doc.defaultView || window;
      for (const video of videos) {
        if (++scanned > 12) return;
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) continue;
        const rect = video.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= win.innerHeight || rect.left >= win.innerWidth) continue;
        const id = state.mirrors.nodeMirror.getId(video);
        if (!(id > 0)) continue;
        const srcTag = video.currentSrc || video.getAttribute('src') || 'video';
        const bucket = Math.floor((video.currentTime || 0) * 3);
        const stateKey = `${srcTag}|${video.videoWidth}x${video.videoHeight}|${video.paused ? 'p' : 'r'}|${bucket}`;
        const prev = lastVideoFrames.get(video);
        if (!force && prev && prev.stateKey === stateKey) continue;
        if (force && prev?.dataUrl && prev.stateKey === stateKey) {
          try { record.addCustomEvent('ditto-video', { id, width: video.videoWidth, height: video.videoHeight, dataUrl: prev.dataUrl }); } catch {}
          continue;
        }
        const scale = Math.min(1, 720 / video.videoWidth, 480 / video.videoHeight);
        const drawW = Math.max(1, Math.round(video.videoWidth * scale));
        const drawH = Math.max(1, Math.round(video.videoHeight * scale));
        if (taintedVideoSrc.get(video) === srcTag) {
          const clip = viewportClipFor(video, rect, win);
          if (clip.width >= 4 && clip.height >= 4) {
            lastVideoFrames.set(video, { stateKey, dataUrl: null });
            send({ type: 'video-tainted', id, width: video.videoWidth, height: video.videoHeight, clip });
          }
          continue;
        }
        try {
          if (!videoScratchCanvas) videoScratchCanvas = document.createElement('canvas');
          if (videoScratchCanvas.width !== drawW) videoScratchCanvas.width = drawW;
          if (videoScratchCanvas.height !== drawH) videoScratchCanvas.height = drawH;
          const ctx = videoScratchCanvas.getContext('2d');
          if (!ctx) continue;
          ctx.drawImage(video, 0, 0, drawW, drawH);
          let dataUrl = videoScratchCanvas.toDataURL('image/webp', 0.62);
          if (!dataUrl || !dataUrl.startsWith('data:image/')) {
            dataUrl = videoScratchCanvas.toDataURL('image/jpeg', 0.62);
          }
          if (dataUrl.length > 600_000) {
            dataUrl = videoScratchCanvas.toDataURL('image/webp', 0.42);
          }
          if (!dataUrl || !dataUrl.startsWith('data:image/') || dataUrl.length > 1000_000) continue;
          lastVideoFrames.set(video, { stateKey, dataUrl });
          if (!force && prev?.dataUrl === dataUrl) continue;
          record.addCustomEvent('ditto-video', { id, width: video.videoWidth, height: video.videoHeight, dataUrl });
        } catch {
          videoScratchCanvas = null;
          taintedVideoSrc.set(video, srcTag);
          const clip = viewportClipFor(video, rect, win);
          if (clip.width >= 4 && clip.height >= 4) {
            lastVideoFrames.set(video, { stateKey, dataUrl: null });
            send({ type: 'video-tainted', id, width: video.videoWidth, height: video.videoHeight, clip });
          }
        }
      }
    }
  };
  let lastXOriginKey = '';
  const captureCrossOriginFrames = (force = false) => {
    if (!state.recording || !state.watched) return;
    const viewportArea = Math.max(1, (window.innerWidth || 1280) * (window.innerHeight || 720));
    let count = 0;
    let maxCoverage = 0;
    for (const doc of collectDocs()) {
      let frames;
      try { frames = doc.querySelectorAll('iframe'); } catch { continue; }
      const win = doc.defaultView || window;
      for (const frame of frames) {
        try {
          if (frame.contentDocument) continue;
        } catch { /* Cross-origin SecurityError confirms it cannot be recorded by rrweb. */ }
        const rawSrc = frame.getAttribute('src') || '';
        if (!/^https?:\/\//i.test(rawSrc) && !rawSrc.startsWith('//')) continue;
        let style = null;
        try { style = win.getComputedStyle(frame); } catch {}
        if (style && (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0)) continue;
        const rect = frame.getBoundingClientRect();
        if (rect.width < 240 || rect.height < 140) continue;
        count++;
        const coverage = (rect.width * rect.height) / viewportArea;
        if (coverage > maxCoverage) maxCoverage = coverage;
      }
    }
    const visible = count > 0;
    const dominant = maxCoverage >= 0.4;
    const key = `${visible ? 1 : 0}:${dominant ? 1 : 0}:${count}`;
    if (!force && key === lastXOriginKey) return;
    lastXOriginKey = key;
    try { record.addCustomEvent('ditto-xorigin', { visible, dominant, count }); } catch {}
  };
  let canvasSnapshotTimer = null;
  const scheduleCanvasRefresh = () => {
    if (!state.watched || !state.recording) return;
    clearTimeout(canvasSnapshotTimer);
    canvasSnapshotTimer = setTimeout(() => {
      if (!state.watched || !state.recording) return;
      captureCanvases(true);
      captureVideos(true);
      captureCrossOriginFrames(true);
    }, 120);
  };
  let videoEventTimer = null;
  const onVideoEvent = event => {
    if (!state.recording || !state.watched || event.target?.tagName !== 'VIDEO') return;
    clearTimeout(videoEventTimer);
    videoEventTimer = setTimeout(() => { if (state.watched && state.recording) captureVideos(false); }, 60);
  };
  const baseOptions = {
    emit: event => {
      send({ type: 'event', event });
      if (event?.type === 2) scheduleCanvasRefresh();
    },
    recordCrossOriginIframes: false,
    checkoutEveryNms: 30000, checkoutEveryNth: 1000,
    // Stylesheets stay as <link> nodes rewritten to the asset cache. Inlining
    // them put the whole page CSS into every full snapshot (hundreds of KB).
    inlineStylesheet: false, inlineImages: false, collectFonts: false,
    recordCanvas: false, maskInputOptions: { password: true, hidden: true },
    blockSelector: '[data-ditto-private], input[type="file"]',
    sampling: { mousemove: 50, scroll: 16, input: 'all' },
    plugins: [{ name: 'ditto-mirrors', getMirror: mirrors => { state.mirrors = mirrors; } }],
    errorHandler: () => true,
  };
  // Defer rrweb's MutationObserver + checkout timer until a viewer actually watches
  // this tab in DOM replay mode; pause again when unwatched or in Screencast mode.
  let stopRecord = null;
  const startRecord = () => {
    if (stopRecord || !state.active) return;
    lastXOriginKey = '';
    const options = { ...baseOptions };
    // Waiting for DOMContentLoaded only makes sense during the initial load. A
    // recorder started on an already loaded page must record immediately.
    if (document.readyState === 'loading') options.recordAfter = 'DOMContentLoaded';
    state.recording = true;
    stopRecord = record(options);
  };
  const stopRecordInner = () => {
    if (stopRecord) {
      try { stopRecord(); } catch {}
      stopRecord = null;
    }
    state.recording = false;
    state.mirrors = null;
  };
  let canvasPollTimer = null;
  state.setWatched = watched => {
    const next = Boolean(watched);
    if (state.watched === next) return;
    state.watched = next;
    if (next) {
      startRecord();
      if (!canvasPollTimer) {
        canvasPollTimer = setInterval(() => {
          if (!state.watched || !state.recording) return;
          captureCanvases(false);
          captureVideos(false);
          captureCrossOriginFrames(false);
        }, 360);
      }
      scheduleCanvasRefresh();
    } else {
      clearInterval(canvasPollTimer);
      canvasPollTimer = null;
      clearTimeout(canvasSnapshotTimer);
      clearTimeout(videoEventTimer);
      stopRecordInner();
    }
  };
  state.checkpoint = () => {
    if (!state.active) return;
    // If a document initialized during login import, its first start was
    // intentionally ignored. Reannounce identity before the safe checkpoint.
    send({ type: 'start' });
    if (state.recording) {
      try { record.takeFullSnapshot(true); } catch {}
      scheduleCanvasRefresh();
    } else if (state.watched) {
      startRecord();
      scheduleCanvasRefresh();
    }
  };
  state.resolveNode = id => {
    let current = window;
    while (current) {
      const node = current.__dittoRecorderV1?.mirrors?.nodeMirror.getNode(id);
      if (node) return node;
      try { if (current.parent === current) break; current = current.parent; void current.document; }
      catch { break; }
    }
    return null;
  };
  const onFocus = event => {
    if (!state.recording) return;
    const id = state.mirrors?.nodeMirror.getId(event.composedPath()[0]);
    if (id > 0) { try { record.addCustomEvent('ditto-focus', { id }); } catch {} }
  };
  const onShow = event => { if (event.persisted) state.checkpoint(); };
  const videoEvents = ['loadeddata', 'seeked', 'play', 'pause'];
  for (const name of videoEvents) document.addEventListener(name, onVideoEvent, true);
  document.addEventListener('focusin', onFocus, true);
  window.addEventListener('pageshow', onShow);
  state.stop = () => {
    clearInterval(canvasPollTimer);
    canvasPollTimer = null;
    clearTimeout(canvasSnapshotTimer);
    clearTimeout(videoEventTimer);
    stopRecordInner();
    state.active = false;
    state.watched = false;
    for (const name of videoEvents) document.removeEventListener(name, onVideoEvent, true);
    document.removeEventListener('focusin', onFocus, true);
    window.removeEventListener('pageshow', onShow);
  };
}

export async function recorderSource(port, bindingName, instanceId) {
  const directory = path.dirname(require.resolve('@rrweb/record'));
  const library = await readFile(path.join(directory, 'record.umd.min.cjs'), 'utf8');
  return `${library}\n;(${bootstrap.toString()})(${JSON.stringify(bindingName)}, ${JSON.stringify(instanceId)}, ${JSON.stringify(port)});`;
}
