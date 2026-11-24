import { Replayer } from '/vendor/rrweb/replay.js';
import { replayBaseline } from './replay-clock.js';

const MAX_EVENTS = 2000;
const MAX_BYTES = 12 * 1024 * 1024;
const INTERACTIVE_PSEUDO_RE = /(?<!\\):(hover|active)(?![a-zA-Z0-9_-])/g;
const SAFE_CURSORS = new Set([
  'auto', 'default', 'pointer', 'text', 'move', 'grab', 'grabbing', 'not-allowed',
  'col-resize', 'row-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize',
  'n-resize', 's-resize', 'e-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize',
  'zoom-in', 'zoom-out', 'crosshair', 'help', 'progress', 'wait', 'copy', 'cell', 'vertical-text', 'all-scroll',
]);
const adaptedSheets = new WeakSet();

function splitSelectorList(text) {
  const parts = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === ',' && paren === 0 && bracket === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function adaptInteractivePseudoRules(rules) {
  for (const rule of rules) {
    if (rule.selectorText) {
      INTERACTIVE_PSEUDO_RE.lastIndex = 0;
      if (INTERACTIVE_PSEUDO_RE.test(rule.selectorText)) {
        const extra = [];
        for (const part of splitSelectorList(rule.selectorText)) {
          INTERACTIVE_PSEUDO_RE.lastIndex = 0;
          if (INTERACTIVE_PSEUDO_RE.test(part) && !part.includes('.\\:hover') && !part.includes('.\\:active')) {
            INTERACTIVE_PSEUDO_RE.lastIndex = 0;
            const adapted = part.replace(INTERACTIVE_PSEUDO_RE, '.\\:$1');
            if (adapted !== part) extra.push(adapted);
          }
        }
        if (extra.length) {
          try { rule.selectorText = `${rule.selectorText}, ${extra.join(', ')}`; } catch { /* ignore */ }
        }
      }
    }
    if (rule.cssRules?.length) adaptInteractivePseudoRules(rule.cssRules);
    if (rule.styleSheet) adaptStyleSheet(rule.styleSheet);
  }
}

function adaptStyleSheet(sheet) {
  if (!sheet || adaptedSheets.has(sheet)) return;
  try {
    if (sheet.cssRules?.length) {
      adaptInteractivePseudoRules(sheet.cssRules);
      adaptedSheets.add(sheet);
    }
  } catch { /* cross-origin or pending sheet */ }
}

function scrollKey(node) {
  if (!node) return null;
  if (node.nodeType === 9) return node;
  const doc = node.ownerDocument;
  if (doc && (node === doc.documentElement || node === doc.body)) return doc;
  return node;
}

function scrollTargetFor(key) {
  if (!key) return null;
  return key.nodeType === 9 ? (key.scrollingElement || key.documentElement) : key;
}

function setScrollInstant(target, left, top) {
  if (!target) return;
  try {
    if (typeof target.scrollTo === 'function') {
      target.scrollTo({
        left: Number.isFinite(left) ? left : target.scrollLeft,
        top: Number.isFinite(top) ? top : target.scrollTop,
        behavior: 'instant',
      });
      return;
    }
  } catch { /* fall back to property assignment */ }
  if (Number.isFinite(left)) target.scrollLeft = left;
  if (Number.isFinite(top)) target.scrollTop = top;
}

function resolveClickableNativeControl(node) {
  let cur = node?.nodeType === 1 ? node : node?.parentElement || null;
  for (let depth = 0; cur && depth < 16; depth++) {
    const tag = cur.tagName;
    if (tag === 'INPUT') {
      if ((cur.type === 'checkbox' || cur.type === 'radio') && !cur.disabled) {
        return { kind: cur.type, el: cur };
      }
      return null;
    }
    if (tag === 'SUMMARY' && cur.parentElement?.tagName === 'DETAILS') {
      return { kind: 'details', el: cur.parentElement };
    }
    if (tag === 'LABEL') {
      const ctrl = cur.control;
      if (ctrl?.tagName === 'INPUT' && (ctrl.type === 'checkbox' || ctrl.type === 'radio') && !ctrl.disabled) {
        return { kind: ctrl.type, el: ctrl };
      }
      return null;
    }
    if (tag === 'A' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return null;
    cur = cur.parentElement;
  }
  return null;
}

const VIDEO_SHIM_CSS = `
video::-webkit-media-controls,
video::-webkit-media-controls-enclosure,
video::-webkit-media-controls-panel,
video::-webkit-media-controls-overlay-enclosure,
video::-webkit-media-controls-start-playback-button {
  display: none !important;
  opacity: 0 !important;
}`;

function ensureReplayMediaStyles(doc) {
  if (!doc) return;
  try {
    const mediaProto = doc.defaultView?.HTMLMediaElement?.prototype;
    if (mediaProto && !mediaProto.__dittoInert) {
      mediaProto.play = () => Promise.resolve();
      mediaProto.pause = () => {};
      mediaProto.load = () => {};
      Object.defineProperty(mediaProto, '__dittoInert', { value: true });
    }
  } catch { /* ignore */ }
  if (doc.querySelector?.('style[data-ditto-media]')) return;
  try {
    const style = doc.createElement('style');
    style.setAttribute('data-ditto-media', '1');
    style.textContent = VIDEO_SHIM_CSS;
    (doc.head || doc.documentElement)?.appendChild(style);
  } catch { /* ignore */ }
}

function adaptDocumentHoverStyles(doc) {
  if (!doc) return;
  ensureReplayMediaStyles(doc);
  for (const sheet of doc.styleSheets || []) adaptStyleSheet(sheet);
  for (const frame of doc.querySelectorAll?.('iframe') || []) {
    try { adaptDocumentHoverStyles(frame.contentDocument); } catch { /* ignore */ }
  }
}

// rrweb receives remote-clock timestamps. startLive uses the server's clock,
// not the Mac's; a small buffer absorbs transport jitter without a video stream.
export class LiveReplay {
  constructor(root, recording, {
    ready = () => {},
    cast = () => {},
    focus = () => {},
    crossOriginFrame = () => {},
    hasInFlightWheels = () => false,
    hasPendingControls = () => false,
    thumbnail = false,
  } = {}) {
    this.root = root;
    this.thumbnail = thumbnail;
    this.cast = cast;
    this.focus = focus;
    this.ready = ready;
    this.crossOriginFrame = crossOriginFrame;
    this.hasInFlightWheels = hasInFlightWheels;
    this.hasPendingControls = hasPendingControls;
    this.canvasFrames = new Map();
    this.videoFrames = new Map();
    this.optimisticScrolls = new Map();
    this.optimisticInputs = new Map();
    this.hoveredNodes = [];
    this.activeNodes = [];
    this.lastHoveredNode = null;
    this.lastCrossOrigin = null;
    this.xoriginTimer = null;
    this.bounds = thumbnail ? (root.closest('.thumbnail-image') || root) : (root.closest('.stage') || root);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.bounds);
    this.reset(recording);
  }

  clearOptimisticScrolls() {
    for (const entry of this.optimisticScrolls.values()) clearTimeout(entry.timer);
    this.optimisticScrolls.clear();
  }

  clearOptimisticInputs() {
    for (const entry of this.optimisticInputs.values()) clearTimeout(entry.timer);
    this.optimisticInputs.clear();
  }

  reset(recording) {
    this.isReady = false;
    this.canvasFrames.clear();
    this.videoFrames.clear();
    this.clearOptimisticScrolls();
    this.clearOptimisticInputs();
    this.hoveredNodes = [];
    this.activeNodes = [];
    this.lastHoveredNode = null;
    this.lastCrossOrigin = null;
    clearTimeout(this.xoriginTimer);
    this.xoriginTimer = null;
    this.revealToken = (this.revealToken || 0) + 1;
    const token = this.revealToken;
    this.player?.timer.clear();
    this.player?.service.stop();
    this.player?.speedService.stop();
    this.player?.destroy();
    this.root.replaceChildren();
    this.documentId = recording.documentId;
    this.sequence = recording.lastSequence;
    this.activeNodeId = null;
    const meta = recording.events.find(event => event.type === 4);
    let width = meta?.data.width || 1920;
    let height = meta?.data.height || 1080;
    for (const event of recording.events) {
      if (event.type === 3 && event.data?.source === 4 && event.data.width && event.data.height) {
        width = event.data.width;
        height = event.data.height;
      }
    }
    this.width = width;
    this.height = height;
    this.player = new Replayer([], { root: this.root, liveMode: true,
      // @rrweb/replay adds html.rrweb-paused whenever state !== "playing", including "live".
      // Leaving pauseAnimation enabled freezes every CSS @keyframes entrance animation at 0% (opacity: 0).
      pauseAnimation: false,
      mouseTail: false, showWarning: false, showDebug: false,
      triggerFocus: false, UNSAFE_replayCanvas: false, useVirtualDom: false, loadTimeout: 0,
      // The default logger can dump untrusted event contents. Do not log page data.
      logger: { log() {}, warn() {} },
    });
    // Keep the rebuilt iframe hidden until external /api/assets CSS links finish
    // loading so switching tabs never flashes an unstyled frame (FOUC).
    this.player.iframe.style.visibility = 'hidden';
    this.player.on('resize', ({ width, height }) => { this.width = width; this.height = height; this.fit(); this.scheduleCrossOriginCheck(); });
    this.player.on('fullsnapshot-rebuilded', () => {
      this.hoveredNodes = [];
      this.activeNodes = [];
      this.lastHoveredNode = null;
      this.clearOptimisticInputs();
      this.fit();
      adaptDocumentHoverStyles(this.player.iframe.contentDocument);
      for (const frame of this.canvasFrames.values()) this.paintCanvas(frame);
      for (const frame of this.videoFrames.values()) this.paintVideo(frame);
      this.isReady = true;
      this.ready(this);
      this.revealWhenStyled(token);
    });
    this.player.on('event-cast', event => {
      if (event.type === 5 && event.data?.tag === 'ditto-focus') {
        this.activeNodeId = event.data.payload.id;
        this.focus(this.activeNodeId, this);
      }
      if (event.type === 5 && event.data?.tag === 'ditto-canvas') {
        this.paintCanvas(event.data.payload);
      }
      if (event.type === 5 && event.data?.tag === 'ditto-video') {
        this.paintVideo(event.data.payload);
      }
      if (event.type === 5 && event.data?.tag === 'ditto-xorigin') {
        this.reportCrossOrigin(event.data.payload);
      }
      if (event.type === 3 && event.data?.source === 0) {
        if (Array.isArray(event.data.adds)) {
          for (const add of event.data.adds) {
            if (add?.node?.tagName?.toLowerCase() === 'link' && typeof add.node.attributes?.href === 'string' && add.node.attributes.href.startsWith('/api/assets/')) {
              const link = this.node(add.node.id);
              if (link?.tagName === 'LINK') {
                if (link.sheet) adaptStyleSheet(link.sheet);
                else link.addEventListener('load', () => adaptDocumentHoverStyles(link.ownerDocument), { once: true });
              }
            }
          }
        }
        if (Array.isArray(event.data.attributes)) {
          for (const item of event.data.attributes) {
            const cached = this.videoFrames.get(item.id);
            if (cached) this.paintVideo(cached);
            if (item.attributes && typeof item.attributes.href === 'string' && item.attributes.href.startsWith('/api/assets/')) {
              const link = this.node(item.id);
              if (link?.tagName === 'LINK') {
                link.addEventListener('load', () => adaptDocumentHoverStyles(link.ownerDocument), { once: true });
              }
            }
            if (this.optimisticInputs.size) {
              const target = this.node(item.id);
              const opt = target ? this.optimisticInputs.get(target) : null;
              if (opt && item.attributes && (opt.kind === 'details' ? 'open' in item.attributes : 'checked' in item.attributes || 'value' in item.attributes)) {
                clearTimeout(opt.timer);
                this.optimisticInputs.delete(target);
              }
            }
          }
        }
        this.scheduleCrossOriginCheck();
      }
      if (event.type === 3 && event.data?.source === 5 && this.optimisticInputs.size) {
        this.confirmOptimisticInput(event.data);
      }
      if (event.type === 3 && event.data?.source === 2 && event.data.type === 6) {
        this.activeNodeId = event.data.id;
        this.focus(this.activeNodeId, this);
      }
      this.cast(event, this);
    });
    this.player.startLive(replayBaseline(recording, this.thumbnail ? 200 : 8));
    for (const event of recording.events) this.player.addEvent(event);
    this.player.iframe.title = this.thumbnail ? '标签页 rrweb 实时缩略图' : '远端网页的 rrweb 实时回放';
    this.player.disableInteract();
    this.fit();
  }

  paintCanvas(payload) {
    const { id, width, height, dataUrl } = payload || {};
    if (!Number.isInteger(id) || typeof dataUrl !== 'string' || !/^data:image\/(?:webp|png|jpeg);base64,/.test(dataUrl)) return;
    this.canvasFrames.set(id, { id, width, height, dataUrl });
    const canvas = this.node(id);
    if (!canvas || canvas.tagName !== 'CANVAS') return;
    const img = new Image();
    img.onload = () => {
      const current = this.node(id);
      if (!current || current.tagName !== 'CANVAS') return;
      if (width && current.width !== width) current.width = width;
      if (height && current.height !== height) current.height = height;
      const ctx = current.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, current.width, current.height);
      ctx.drawImage(img, 0, 0, current.width, current.height);
    };
    img.src = dataUrl;
  }

  paintVideo(payload) {
    const { id, width, height, dataUrl } = payload || {};
    if (!Number.isInteger(id) || typeof dataUrl !== 'string' || !/^data:image\/(?:webp|png|jpeg);base64,/.test(dataUrl)) return;
    this.videoFrames.set(id, { id, width, height, dataUrl });
    const video = this.node(id);
    if (!video || video.tagName !== 'VIDEO') return;
    const apply = () => {
      const current = this.node(id);
      if (!current || current.tagName !== 'VIDEO') return;
      if (this.videoFrames.get(id)?.dataUrl !== dataUrl) return;
      if (width && (!current.hasAttribute('width') || current.dataset.dittoAutoSize === '1')) {
        current.setAttribute('width', String(width));
        current.dataset.dittoAutoSize = '1';
      }
      if (height && (!current.hasAttribute('height') || current.dataset.dittoAutoSize === '1')) {
        current.setAttribute('height', String(height));
        current.dataset.dittoAutoSize = '1';
      }
      current.poster = dataUrl;
    };
    const img = new Image();
    img.src = dataUrl;
    if (typeof img.decode === 'function') img.decode().then(apply, apply);
    else img.onload = img.onerror = apply;
  }

  hover(node) {
    if (node === this.lastHoveredNode) return;
    for (const prev of this.hoveredNodes) prev.classList?.remove(':hover');
    this.hoveredNodes = [];
    this.lastHoveredNode = node || null;
    let current = node?.nodeType === 1 ? node : node?.parentElement || null;
    while (current) {
      if (current.classList) {
        current.classList.add(':hover');
        this.hoveredNodes.push(current);
      }
      current = current.parentElement;
    }
  }

  press(node) {
    for (const prev of this.activeNodes) prev.classList?.remove(':active');
    this.activeNodes = [];
    let current = node?.nodeType === 1 ? node : node?.parentElement || null;
    while (current) {
      if (current.classList) {
        current.classList.add(':active');
        this.activeNodes.push(current);
      }
      current = current.parentElement;
    }
  }

  cursorFor(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return '';
    try {
      const cursor = element.ownerDocument?.defaultView?.getComputedStyle(element)?.cursor || '';
      return SAFE_CURSORS.has(cursor) ? cursor : '';
    } catch {
      return '';
    }
  }

  revealWhenStyled(token) {
    const iframe = this.player?.iframe;
    if (!iframe) return;
    const pending = [];
    const collect = doc => {
      if (!doc) return;
      for (const link of doc.querySelectorAll('link[rel~="stylesheet" i][href^="/api/assets/"]')) {
        if (link.sheet || link.disabled) continue;
        if (link.media && link.media.trim().toLowerCase() === 'print') continue;
        pending.push(new Promise(resolve => {
          const done = () => {
            link.removeEventListener('load', done);
            link.removeEventListener('error', done);
            adaptDocumentHoverStyles(doc);
            resolve();
          };
          link.addEventListener('load', done, { once: true });
          link.addEventListener('error', done, { once: true });
        }));
      }
      for (const frame of doc.querySelectorAll('iframe')) collect(frame.contentDocument);
    };
    collect(iframe.contentDocument);
    const show = () => {
      if (this.revealToken !== token || !this.player?.iframe) return;
      requestAnimationFrame(() => {
        if (this.revealToken !== token || !this.player?.iframe) return;
        adaptDocumentHoverStyles(this.player.iframe.contentDocument);
        this.player.iframe.style.visibility = '';
        this.fit();
        this.inspectCrossOriginIframes();
      });
    };
    if (!pending.length) { show(); return; }
    Promise.race([
      Promise.all(pending),
      new Promise(resolve => setTimeout(resolve, 600)),
    ]).then(show);
  }

  findScrollableTarget(node, dx, dy) {
    const canScrollAxis = (el, delta, vertical) => {
      if (!delta) return false;
      const scrollSize = vertical ? el.scrollHeight : el.scrollWidth;
      const clientSize = vertical ? el.clientHeight : el.clientWidth;
      if (scrollSize <= clientSize + 1) return false;
      const pos = vertical ? el.scrollTop : el.scrollLeft;
      return delta > 0 ? pos < scrollSize - clientSize - 0.5 : pos > 0.5;
    };
    const rootWin = this.player?.iframe?.contentWindow;
    let cur = node?.nodeType === 1 ? node : node?.parentElement || null;
    for (let depth = 0; cur && depth < 64; depth++) {
      const doc = cur.ownerDocument;
      const win = doc?.defaultView;
      if (!doc || !win) break;
      if (cur === doc.documentElement || cur === doc.body) {
        const se = doc.scrollingElement || doc.documentElement;
        if (se && (canScrollAxis(se, dy, true) || canScrollAxis(se, dx, false))) {
          return { key: doc, target: se };
        }
        if (win === rootWin) break;
        try { cur = win.frameElement?.parentElement || null; } catch { break; }
        continue;
      }
      let cs = null;
      try { cs = win.getComputedStyle(cur); } catch {}
      if (cs) {
        const oy = cs.overflowY;
        const ox = cs.overflowX;
        const okY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && canScrollAxis(cur, dy, true);
        const okX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && canScrollAxis(cur, dx, false);
        if (okY || okX) return { key: cur, target: cur };
      }
      cur = cur.parentElement;
    }
    const topDoc = this.player?.iframe?.contentDocument;
    const se = topDoc?.scrollingElement || topDoc?.documentElement;
    if (se && (canScrollAxis(se, dy, true) || canScrollAxis(se, dx, false))) {
      return { key: topDoc, target: se };
    }
    return null;
  }

  optimisticScroll(node, dx, dy) {
    if (!this.isReady || this.thumbnail || !node) return false;
    const found = this.findScrollableTarget(node, dx, dy);
    if (!found) return false;
    const key = scrollKey(found.key);
    const target = found.target;
    setScrollInstant(target, target.scrollLeft + dx, target.scrollTop + dy);
    const now = performance.now();
    let entry = this.optimisticScrolls.get(key);
    if (!entry) {
      entry = { lastLocalAt: now, lastRemoteAt: 0, pendingRemote: null, timer: null };
      this.optimisticScrolls.set(key, entry);
    } else {
      entry.lastLocalAt = now;
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.reconcileScroll(key), 300);
    return true;
  }

  reconcileScroll(key) {
    const entry = this.optimisticScrolls.get(key);
    if (!entry) return;
    const now = performance.now();
    const sinceLocal = now - entry.lastLocalAt;
    const sinceRemote = entry.lastRemoteAt ? now - entry.lastRemoteAt : Infinity;
    // Wait for local wheel idle, in-flight wheel ACKs, and Linux Chromium's
    // smooth-scroll deceleration to settle before ever adjusting scrollTop.
    if (sinceLocal < 1400) {
      if (sinceLocal < 280) {
        entry.timer = setTimeout(() => this.reconcileScroll(key), Math.max(24, Math.ceil(280 - sinceLocal) + 10));
        return;
      }
      if (this.hasInFlightWheels()) {
        entry.timer = setTimeout(() => this.reconcileScroll(key), 110);
        return;
      }
      if (sinceRemote < 200) {
        entry.timer = setTimeout(() => this.reconcileScroll(key), Math.max(24, Math.ceil(200 - sinceRemote) + 10));
        return;
      }
    }
    this.optimisticScrolls.delete(key);
    const pending = entry.pendingRemote;
    if (!pending) return;
    const target = scrollTargetFor(key);
    if (!target) return;
    const diffX = Number.isFinite(pending.x) ? Math.abs(pending.x - target.scrollLeft) : 0;
    const diffY = Number.isFinite(pending.y) ? Math.abs(pending.y - target.scrollTop) : 0;
    // Absorb tiny <= 4px subpixel/rounding variance without a visible snap.
    if (diffX <= 4 && diffY <= 4) return;
    setScrollInstant(target, pending.x, pending.y);
  }

  applyRemoteScroll(data) {
    if (!data || !Number.isInteger(data.id)) return;
    const node = this.node(data.id);
    if (!node) return;
    const key = scrollKey(node);
    const target = scrollTargetFor(key);
    if (!target) return;
    const x = Number.isFinite(data.x) ? data.x : 0;
    const y = Number.isFinite(data.y) ? data.y : 0;
    const entry = this.optimisticScrolls.get(key);
    if (entry) {
      const now = performance.now();
      const diffX = Math.abs(x - target.scrollLeft);
      const diffY = Math.abs(y - target.scrollTop);
      // Remote has caught up right where local already is: clear silently with zero jump.
      if (!this.hasInFlightWheels() && now - entry.lastLocalAt >= 80 && diffX <= 3 && diffY <= 3) {
        clearTimeout(entry.timer);
        this.optimisticScrolls.delete(key);
        return;
      }
      const moved = !entry.pendingRemote || Math.abs(entry.pendingRemote.x - x) > 0.5 || Math.abs(entry.pendingRemote.y - y) > 0.5;
      entry.pendingRemote = { x, y };
      if (moved) {
        entry.lastRemoteAt = now;
        if (now - entry.lastLocalAt < 1400) {
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => this.reconcileScroll(key), 220);
        }
      }
      return;
    }
    setScrollInstant(target, x, y);
  }

  scheduleOptimisticInputReconcile(el) {
    const entry = this.optimisticInputs.get(el);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const current = this.optimisticInputs.get(el);
      if (!current) return;
      if (this.hasPendingControls() && performance.now() - current.at < 2000) {
        this.scheduleOptimisticInputReconcile(el);
        return;
      }
      this.optimisticInputs.delete(el);
      if (!el.isConnected) return;
      if (current.pendingRemote) {
        try {
          if (typeof current.pendingRemote.isChecked === 'boolean') el.checked = current.pendingRemote.isChecked;
          if (typeof current.pendingRemote.text === 'string') el.value = current.pendingRemote.text;
        } catch { /* ignore */ }
        return;
      }
      // No authoritative remote echo arrived (e.g. remote JS called preventDefault): roll back cleanly.
      try {
        if (current.kind === 'checkbox') el.checked = current.prevChecked;
        else if (current.kind === 'radio') {
          el.checked = current.prevChecked;
          if (current.prevSibling?.isConnected) current.prevSibling.checked = true;
        } else if (current.kind === 'select') el.value = current.prevValue;
        else if (current.kind === 'details') el.open = current.prevOpen;
      } catch { /* ignore */ }
    }, 650);
  }

  optimisticToggle(node) {
    if (!this.isReady || this.thumbnail || !node) return false;
    const found = resolveClickableNativeControl(node);
    if (!found) return false;
    const { kind, el } = found;
    const existing = this.optimisticInputs.get(el);
    if (existing) clearTimeout(existing.timer);
    const now = performance.now();
    if (kind === 'checkbox') {
      const prevChecked = existing ? existing.prevChecked : Boolean(el.checked);
      const nextChecked = !el.checked;
      el.checked = nextChecked;
      this.optimisticInputs.set(el, { kind, el, prevChecked, expectedChecked: nextChecked, pendingRemote: null, at: now, timer: null });
      this.scheduleOptimisticInputReconcile(el);
      return true;
    }
    if (kind === 'radio') {
      if (el.checked) return false;
      let prevSibling = null;
      if (el.name) {
        const scope = el.form || el.getRootNode?.() || el.ownerDocument;
        for (const candidate of scope?.querySelectorAll?.('input[type="radio"]') || []) {
          if (candidate !== el && candidate.name === el.name && candidate.checked) {
            prevSibling = candidate;
            candidate.checked = false;
            break;
          }
        }
      }
      el.checked = true;
      this.optimisticInputs.set(el, { kind, el, prevChecked: false, prevSibling, expectedChecked: true, pendingRemote: null, at: now, timer: null });
      this.scheduleOptimisticInputReconcile(el);
      return true;
    }
    if (kind === 'details') {
      const prevOpen = existing ? existing.prevOpen : Boolean(el.open);
      const nextOpen = !el.open;
      el.open = nextOpen;
      this.optimisticInputs.set(el, { kind, el, prevOpen, expectedOpen: nextOpen, pendingRemote: null, at: now, timer: null });
      this.scheduleOptimisticInputReconcile(el);
      return true;
    }
    return false;
  }

  optimisticSelect(nodeId, value) {
    if (!this.isReady || this.thumbnail || !Number.isInteger(nodeId)) return false;
    const el = this.node(nodeId);
    if (!el || el.tagName !== 'SELECT' || el.disabled) return false;
    const existing = this.optimisticInputs.get(el);
    if (existing) clearTimeout(existing.timer);
    const prevValue = existing ? existing.prevValue : el.value;
    el.value = value;
    this.optimisticInputs.set(el, { kind: 'select', el, prevValue, expectedValue: value, pendingRemote: null, at: performance.now(), timer: null });
    this.scheduleOptimisticInputReconcile(el);
    return true;
  }

  rollbackOptimisticInput(nodeId) {
    if (!Number.isInteger(nodeId)) return;
    const raw = this.node(nodeId);
    const el = (raw && this.optimisticInputs.has(raw)) ? raw : resolveClickableNativeControl(raw)?.el;
    if (!el) return;
    const entry = this.optimisticInputs.get(el);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.optimisticInputs.delete(el);
    if (!el.isConnected) return;
    try {
      if (entry.kind === 'checkbox') el.checked = entry.prevChecked;
      else if (entry.kind === 'radio') {
        el.checked = entry.prevChecked;
        if (entry.prevSibling?.isConnected) entry.prevSibling.checked = true;
      } else if (entry.kind === 'select') el.value = entry.prevValue;
      else if (entry.kind === 'details') el.open = entry.prevOpen;
    } catch { /* ignore */ }
  }

  confirmOptimisticInput(data) {
    if (!data || !Number.isInteger(data.id)) return;
    const el = this.node(data.id);
    if (!el) return;
    const entry = this.optimisticInputs.get(el);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.optimisticInputs.delete(el);
  }

  applyRemoteInput(data) {
    if (!data || !Number.isInteger(data.id)) return false;
    const target = this.node(data.id);
    if (!target) return false;
    if (target.tagName === 'SELECT' && typeof data.text === 'string' && target.options?.length) {
      if (![...target.options].some(opt => opt.value === data.text)) return false;
    }
    const entry = this.optimisticInputs.get(target);
    if (entry) {
      // Avoid flickering back to an earlier click's echo while a newer rapid toggle is still in flight.
      const mismatch = (entry.kind === 'checkbox' || entry.kind === 'radio')
        ? data.isChecked !== entry.expectedChecked
        : entry.kind === 'select' ? data.text !== entry.expectedValue : false;
      if (mismatch && this.hasPendingControls() && performance.now() - entry.at < 350) {
        entry.pendingRemote = data;
        return true;
      }
      clearTimeout(entry.timer);
      this.optimisticInputs.delete(target);
    }
    try {
      if (typeof data.isChecked === 'boolean') target.checked = data.isChecked;
      if (typeof data.text === 'string') target.value = data.text;
    } catch { /* ignore */ }
    return true;
  }

  add(message) {
    if (message.documentId !== this.documentId || message.firstSequence !== this.sequence + 1) return false;
    this.sequence = message.lastSequence;
    let sawMutation = false;
    for (const event of message.events) {
      if (this.isReady && event.type === 5 && event.data?.tag === 'ditto-focus') {
        this.activeNodeId = event.data.payload.id;
        this.focus(this.activeNodeId, this);
        continue;
      }
      if (this.isReady && event.type === 5 && event.data?.tag === 'ditto-video') {
        this.paintVideo(event.data.payload);
        continue;
      }
      if (this.isReady && event.type === 5 && event.data?.tag === 'ditto-canvas') {
        this.paintCanvas(event.data.payload);
        continue;
      }
      if (this.isReady && event.type === 5 && event.data?.tag === 'ditto-xorigin') {
        this.reportCrossOrigin(event.data.payload);
        continue;
      }
      if (this.isReady && event.type === 3 && event.data?.source === 3) {
        this.applyRemoteScroll(event.data);
        this.cast(event, this);
        continue;
      }
      if (event.type === 3 && event.data?.source === 0) {
        sawMutation = true;
      }
      if (this.isReady && !sawMutation && event.type === 3 && event.data?.source === 5 && this.applyRemoteInput(event.data)) {
        this.cast(event, this);
        continue;
      }
      this.player.addEvent(event);
    }
    return true;
  }

  checkpoint(recording) {
    if (recording.documentId !== this.documentId || !this.player.timer.isActive()) { this.reset(recording); return; }
    this.sequence = recording.lastSequence;
    // Keep the iframe/overlay alive across periodic checkouts. Destroying it
    // between pointerdown and click used to swallow an otherwise valid click.
    // Live replay never rewinds; retain only this new checkpoint in rrweb too.
    const events = this.player.service.state.context.events;
    events.splice(0, events.length);
    for (const event of recording.events) this.player.addEvent(event);
  }

  node(id) { return this.player.getMirror().getNode(id); }

  refreshAsset(id) {
    this.refreshAssets([id]);
  }

  refreshAssets(ids) {
    const valid = (ids || []).filter(id => /^[a-f0-9]{36}$/.test(id));
    if (!valid.length) return;
    const version = Date.now();
    const patterns = valid.map(id => {
      const p = `/api/assets/${id}`;
      return { path: p, pattern: new RegExp(`${p}(?:\\?ready=\\d+)?`, 'g'), replacement: `${p}?ready=${version}` };
    });
    const replaceAll = value => {
      let next = value;
      for (const item of patterns) {
        if (next.includes(item.path)) next = next.replace(item.pattern, item.replacement);
      }
      return next;
    };
    const matchesAny = value => Boolean(value) && patterns.some(item => value.includes(item.path));
    const visit = doc => {
      if (!doc) return;
      for (const node of doc.querySelectorAll('[src],[href],[xlink\\:href],[background],[poster],[style],style')) {
        for (const name of ['src', 'href', 'xlink:href', 'background', 'poster', 'style']) {
          const value = node.getAttribute(name);
          if (matchesAny(value)) {
            if (node.tagName === 'LINK' && name === 'href') {
              node.addEventListener('load', () => adaptDocumentHoverStyles(doc), { once: true });
            }
            node.setAttribute(name, replaceAll(value));
          }
        }
        if (node.tagName.toLowerCase() === 'style' && matchesAny(node.textContent)) {
          node.textContent = replaceAll(node.textContent);
        }
      }
      for (const sheet of [...(doc.styleSheets || []), ...(doc.adoptedStyleSheets || [])]) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (let i = 0; i < rules.length; i++) {
          const cssText = rules[i].cssText;
          if (!matchesAny(cssText)) continue;
          try {
            const updated = replaceAll(cssText);
            sheet.deleteRule(i);
            sheet.insertRule(updated, i);
          } catch { /* Ignore read-only or unsupported rule types. */ }
        }
      }
      for (const frame of doc.querySelectorAll('iframe')) visit(frame.contentDocument);
    };
    visit(this.player.iframe.contentDocument);
  }

  target(node) {
    let element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return null;
    const mirror = this.player.getMirror();
    const nodeId = mirror.getId(element);
    if (nodeId < 1 || nodeId >= 1_000_000_000) return null;
    const framePath = [];
    let win = element.ownerDocument.defaultView;
    try {
      while (win && win !== this.player.iframe.contentWindow) {
        const frame = win.frameElement;
        const id = mirror.getId(frame);
        if (id < 1) return null;
        framePath.unshift(id);
        win = frame.ownerDocument.defaultView;
      }
    } catch { return null; }
    return { nodeId, framePath };
  }

  // Hit testing stays in inert replay DOM. Coordinates sent back are relative
  // to a recorded node, not an arbitrary page point from a stale document.
  hit(clientX, clientY) {
    const iframe = this.player.iframe;
    const box = iframe.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const viewportX = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    const viewportY = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
    let x = (clientX - box.left) * this.width / box.width;
    let y = (clientY - box.top) * this.height / box.height;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    let doc = iframe.contentDocument;
    let node;
    for (let depth = 0; doc && depth < 12; depth++) {
      node = doc.elementFromPoint(x, y);
      while (node?.shadowRoot?.elementFromPoint) {
        const child = node.shadowRoot.elementFromPoint(x, y);
        if (!child || child === node) break;
        node = child;
      }
      if (!node) return null;
      if (node.tagName !== 'IFRAME') break;
      const rect = node.getBoundingClientRect();
      const child = node.contentDocument;
      if (!child?.documentElement || this.player.getMirror().getId(child.documentElement) < 1) return null;
      x = (x - rect.left - node.clientLeft) * node.clientWidth / Math.max(1, rect.width);
      y = (y - rect.top - node.clientTop) * node.clientHeight / Math.max(1, rect.height);
      doc = child;
    }
    const target = this.target(node);
    const rect = node?.getBoundingClientRect();
    if (!target || !rect?.width || !rect.height) return null;
    // rrweb can insert bookkeeping nodes into the replay DOM. Retain only
    // recorded targets and meaningful clickable ancestors; glyph/path nodes
    // inside a button should not become the control identity.
    const actionable = node.closest?.('button,a,input,textarea,select,[role="button"],[role="tab"],[role="checkbox"],[role="combobox"]');
    if (actionable && actionable.ownerDocument === node.ownerDocument) {
      const actionTarget = this.target(actionable);
      const actionRect = actionable.getBoundingClientRect();
      if (actionTarget && actionRect.width && actionRect.height) return { ...actionTarget, node: actionable,
        viewportX, viewportY,
        offsetX: Math.min(1, Math.max(0, (x - actionRect.left) / actionRect.width)),
        offsetY: Math.min(1, Math.max(0, (y - actionRect.top) / actionRect.height)) };
    }
    return { ...target, node, viewportX, viewportY, offsetX: Math.min(1, Math.max(0, (x - rect.left) / rect.width)),
      offsetY: Math.min(1, Math.max(0, (y - rect.top) / rect.height)) };
  }

  fit() {
    if (!this.player || !this.width || !this.height) return;
    let scale;
    const contain = !this.thumbnail || Boolean(this.bounds?.closest('.thumbnail-grid.adaptive'));
    if (contain && this.bounds && this.bounds !== this.root) {
      const availWidth = this.bounds.clientWidth;
      const availHeight = this.bounds.clientHeight;
      if (!availWidth || !availHeight) return;
      scale = Math.min(availWidth / this.width, availHeight / this.height);
      this.root.style.width = `${Math.floor(this.width * scale)}px`;
      this.root.style.height = `${Math.floor(this.height * scale)}px`;
    } else {
      this.root.style.width = '';
      if (!this.root.clientWidth) return;
      scale = this.root.clientWidth / this.width;
      this.root.style.height = `${this.height * scale}px`;
    }
    this.player.wrapper.style.width = `${this.width}px`;
    this.player.wrapper.style.height = `${this.height}px`;
    this.player.wrapper.style.transformOrigin = 'top left';
    this.player.wrapper.style.transform = `scale(${scale})`;
  }

  scheduleCrossOriginCheck() {
    if (this.thumbnail || !this.isReady) return;
    clearTimeout(this.xoriginTimer);
    this.xoriginTimer = setTimeout(() => {
      this.xoriginTimer = null;
      this.inspectCrossOriginIframes();
    }, 220);
  }

  reportCrossOrigin(payload) {
    if (this.thumbnail || !payload || typeof payload !== 'object') return;
    const next = {
      visible: Boolean(payload.visible),
      dominant: Boolean(payload.dominant),
      count: Number.isFinite(payload.count) ? Math.max(0, Math.round(payload.count)) : 0,
    };
    if (next.visible !== this.lastCrossOrigin?.visible || next.dominant !== this.lastCrossOrigin?.dominant) {
      this.lastCrossOrigin = next;
      this.crossOriginFrame(next, this);
    }
  }

  inspectCrossOriginIframes() {
    if (this.thumbnail || !this.player?.iframe?.contentDocument) return;
    const doc = this.player.iframe.contentDocument;
    const mirror = this.player.getMirror();
    const viewportArea = Math.max(1, (this.width || 1280) * (this.height || 720));
    let maxCoverage = 0;
    let count = 0;
    for (const frame of doc.querySelectorAll('iframe[data-ditto-xorigin="1"]')) {
      try {
        if (frame.contentDocument?.documentElement && mirror.getId(frame.contentDocument.documentElement) > 0) continue;
        const style = doc.defaultView?.getComputedStyle(frame);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0)) continue;
        const rect = frame.getBoundingClientRect();
        if (rect.width < 240 || rect.height < 140) continue;
        count++;
        const coverage = (rect.width * rect.height) / viewportArea;
        if (coverage > maxCoverage) maxCoverage = coverage;
      } catch { /* ignore */ }
    }
    if (count > 0) this.reportCrossOrigin({ visible: true, count, dominant: maxCoverage >= 0.4 });
  }

  destroy() {
    this.isReady = false;
    this.clearOptimisticScrolls();
    this.clearOptimisticInputs();
    this.activeNodes = [];
    clearTimeout(this.xoriginTimer);
    this.xoriginTimer = null;
    this.revealToken = (this.revealToken || 0) + 1;
    this.resizeObserver.disconnect();
    // rrweb 2.2.0 pause()/destroy() do not stop the live-state timer. Explicitly
    // stop it so every navigation/checkpoint cannot leave a hidden replay alive.
    this.player?.timer.clear();
    this.player?.service.stop();
    this.player?.speedService.stop();
    this.player?.destroy();
    this.root.style.width = '';
    this.root.style.height = '';
    this.root.replaceChildren();
  }
}

export class RecordingStore {
  recordings = new Map();

  accept(message) {
    if (message.type === 'rrweb-reset') { this.recordings.delete(message.tabId); return 'reset'; }
    if (!Array.isArray(message.events) || message.events.length > MAX_EVENTS || !Number.isInteger(message.lastSequence)) return 'resync';
    if (message.type === 'rrweb-snapshot') {
      if (!message.events.some(event => event.type === 2) || !message.events.some(event => event.type === 4)) return 'resync';
      const eventSizes = message.events.map(event => JSON.stringify(event).length);
      const bytes = eventSizes.reduce((total, n) => total + n, 0);
      this.recordings.set(message.tabId, { ...message, eventSizes, receivedAt: performance.now(), bytes });
      return 'snapshot';
    }
    const recording = this.recordings.get(message.tabId);
    if (recording?.documentId === message.documentId && message.lastSequence <= recording.lastSequence) return 'ignore';
    if (!recording || recording.documentId !== message.documentId || message.firstSequence !== recording.lastSequence + 1) return 'resync';
    const incomingSizes = message.events.map(event => JSON.stringify(event).length);
    const bytes = incomingSizes.reduce((total, n) => total + n, 0);
    for (const incoming of message.events) {
      if (incoming.type === 5 && (incoming.data?.tag === 'ditto-canvas' || incoming.data?.tag === 'ditto-video' || incoming.data?.tag === 'ditto-xorigin')) {
        const targetTag = incoming.data.tag;
        const targetId = incoming.data.payload?.id;
        for (let i = recording.events.length - 1; i >= 0; i--) {
          const existing = recording.events[i];
          if (existing.type === 5 && existing.data?.tag === targetTag && (targetTag === 'ditto-xorigin' || existing.data.payload?.id === targetId)) {
            recording.bytes = Math.max(0, recording.bytes - (recording.eventSizes?.[i] || 0));
            recording.events.splice(i, 1);
            recording.eventSizes?.splice(i, 1);
          }
        }
      }
    }
    if (recording.events.length + message.events.length > MAX_EVENTS || recording.bytes + bytes > MAX_BYTES) return 'resync';
    recording.events.push(...message.events);
    recording.eventSizes?.push(...incomingSizes);
    recording.lastSequence = message.lastSequence;
    recording.serverTime = message.serverTime;
    recording.receivedAt = performance.now();
    recording.bytes += bytes;
    return 'events';
  }

  get(id) { return this.recordings.get(id); }
  delete(id) { this.recordings.delete(id); }
  clear() { this.recordings.clear(); }
}
