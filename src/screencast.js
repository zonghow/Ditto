import { EventEmitter } from 'node:events';
import { InputError } from './snapshot.js';

const ALLOWED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Space',
]);
const ALLOWED_MODIFIERS = new Set(['Control', 'Meta', 'Alt', 'Shift']);
const ALLOWED_ACTIONS = new Set(['mousedown', 'mousemove', 'mouseup', 'click', 'wheel', 'key', 'text']);

export const SCREENCAST_PRESETS = {
  smooth: { format: 'jpeg', quality: 60 },
  balanced: { format: 'jpeg', quality: 80 },
  high: { format: 'jpeg', quality: 92 },
  lossless: { format: 'png' },
};

const QUALITY_RANK = { smooth: 0, balanced: 1, high: 2, lossless: 3 };

export function normalizeScreencastQuality(value, fallback = 'balanced') {
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (Object.hasOwn(SCREENCAST_PRESETS, key)) return key;
  }
  return Object.hasOwn(SCREENCAST_PRESETS, fallback) ? fallback : 'balanced';
}

export function computeScreencastFrameGeometry(frame, fallbackViewport) {
  const vpW = Math.max(1, Number(frame?.viewportWidth || fallbackViewport?.width) || 1280);
  const vpH = Math.max(1, Number(frame?.viewportHeight || fallbackViewport?.height) || 800);
  const deviceWidth = Math.max(1, Number(frame?.width || frame?.deviceWidth) || vpW);
  const deviceHeight = Math.max(1, Number(frame?.height || frame?.deviceHeight) || vpH);
  const rawOffsetTop = Number(frame?.offsetTop);
  const offsetTop = Number.isFinite(rawOffsetTop) && rawOffsetTop > 0 && rawOffsetTop < deviceHeight ? rawOffsetTop : 0;
  const rawScale = Number(frame?.pageScaleFactor);
  const pageScaleFactor = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const capturedWidth = deviceWidth / pageScaleFactor;
  const capturedHeight = Math.max(1, (deviceHeight - offsetTop) / pageScaleFactor);
  const coordWidth = Math.min(capturedWidth, vpW);
  const coordHeight = Math.min(capturedHeight, vpH);
  return {
    deviceWidth,
    deviceHeight,
    offsetTop,
    pageScaleFactor,
    viewportWidth: vpW,
    viewportHeight: vpH,
    capturedWidth,
    capturedHeight,
    coordWidth,
    coordHeight,
  };
}

export function validateScreencastInput(input) {
  if (!input || typeof input !== 'object' || !ALLOWED_ACTIONS.has(input.action)) {
    throw new InputError('不支持的画面模式操作。');
  }
  if (typeof input.tabId !== 'string' || !input.tabId || input.tabId.length > 100) {
    throw new InputError('缺少标签页 ID。');
  }
  const clean = { action: input.action, tabId: input.tabId };
  if (['mousedown', 'mousemove', 'mouseup', 'click', 'wheel'].includes(input.action)) {
    if (![input.x, input.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) {
      throw new InputError('坐标超出画面范围。');
    }
    clean.x = input.x;
    clean.y = input.y;
    if (input.frameWidth !== undefined || input.frameHeight !== undefined) {
      if (![input.frameWidth, input.frameHeight].every(v => Number.isFinite(v) && v >= 1 && v <= 7680)) {
        throw new InputError('画面尺寸参数无效。');
      }
      clean.frameWidth = input.frameWidth;
      clean.frameHeight = input.frameHeight;
    }
  }
  if (['mousedown', 'mouseup', 'click'].includes(input.action)) {
    clean.button = input.button ?? 'left';
    if (!['left', 'middle', 'right'].includes(clean.button)) throw new InputError('鼠标按键无效。');
  }
  if (input.action === 'click') {
    clean.clickCount = input.clickCount ?? 1;
    if (![1, 2].includes(clean.clickCount)) throw new InputError('点击次数无效。');
  }
  if (input.action === 'wheel') {
    if (![input.deltaX, input.deltaY].every(v => Number.isFinite(v) && Math.abs(v) <= 4000)) {
      throw new InputError('滚动量无效。');
    }
    clean.deltaX = input.deltaX;
    clean.deltaY = input.deltaY;
  }
  if (input.action === 'text') {
    if (typeof input.value !== 'string' || input.value.length > 16384) {
      throw new InputError('输入过长或格式无效。');
    }
    clean.value = input.value;
  }
  if (input.action === 'key') {
    if (typeof input.key !== 'string' || !(ALLOWED_KEYS.has(input.key) || /^[a-z0-9]$/i.test(input.key))) {
      throw new InputError('不支持这个按键。');
    }
    if (!Array.isArray(input.modifiers) || input.modifiers.length > 4 || input.modifiers.some(m => !ALLOWED_MODIFIERS.has(m))) {
      throw new InputError('组合键无效。');
    }
    if (input.modifiers.some(m => ['Control', 'Meta'].includes(m)) &&
      !/^[acvxyz]$/i.test(input.key) && !['Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(input.key)) {
      throw new InputError('浏览器级快捷键不在网页操作范围内。');
    }
    clean.key = input.key;
    clean.modifiers = [...new Set(input.modifiers)];
  }
  return clean;
}

export class ScreencastManager extends EventEmitter {
  sessions = new Map(); // tabId -> { tab, viewers: Set<string>, viewerPrefs: Map<string, { quality, retina }>, cdp, handler, lastFrame, syncedBoundsKey, syncingBounds, getBrowserCdp, fallbackVp, activeUntil, ackTimer, pendingAckSessionId, dedupedFrames, quality, retina }

  constructor({ activeWindowMs = 1500, idleAckDelayMs = 180, defaultQuality = 'balanced', defaultRetina = false } = {}) {
    super();
    this.activeWindowMs = activeWindowMs;
    this.idleAckDelayMs = idleAckDelayMs;
    this.defaultQuality = normalizeScreencastQuality(defaultQuality, 'balanced');
    this.defaultRetina = Boolean(defaultRetina);
  }

  hasViewers(tabId) {
    return (this.sessions.get(tabId)?.viewers.size || 0) > 0;
  }

  isViewerWatching(tabId, viewerId) {
    return Boolean(this.sessions.get(tabId)?.viewers.has(viewerId));
  }

  getFrameMetrics(tabId) {
    const frame = this.sessions.get(tabId)?.lastFrame;
    if (!frame) return null;
    return {
      width: frame.width,
      height: frame.height,
      viewportWidth: frame.viewportWidth,
      viewportHeight: frame.viewportHeight,
      offsetTop: frame.offsetTop,
      pageScaleFactor: frame.pageScaleFactor,
    };
  }

  clearPendingAck(session) {
    if (!session) return;
    clearTimeout(session.ackTimer);
    session.ackTimer = null;
    session.pendingAckSessionId = null;
  }

  flushPendingAck(session) {
    if (!session || session.pendingAckSessionId === null) return;
    const sessionId = session.pendingAckSessionId;
    this.clearPendingAck(session);
    session.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  }

  scheduleAck(session, sessionId) {
    if (!session || sessionId === undefined || sessionId === null) return;
    // Flush any prior un-acked sessionId first so Chromium's compositor queue never stalls.
    if (session.pendingAckSessionId !== null) {
      this.flushPendingAck(session);
    }
    const isActive = Date.now() < session.activeUntil;
    if (isActive || this.idleAckDelayMs <= 0) {
      session.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      return;
    }
    session.pendingAckSessionId = sessionId;
    session.ackTimer = setTimeout(() => {
      session.ackTimer = null;
      const pending = session.pendingAckSessionId;
      session.pendingAckSessionId = null;
      if (pending !== null && this.sessions.get(session.tab.id) === session) {
        session.cdp.send('Page.screencastFrameAck', { sessionId: pending }).catch(() => {});
      }
    }, this.idleAckDelayMs);
    session.ackTimer.unref?.();
  }

  noteActivity(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.activeUntil = Date.now() + this.activeWindowMs;
    this.flushPendingAck(session);
  }

  effectivePrefs(session) {
    let quality = this.defaultQuality;
    let retina = this.defaultRetina;
    if (session?.viewerPrefs?.size) {
      let bestRank = -1;
      let anyRetina = false;
      for (const pref of session.viewerPrefs.values()) {
        const rank = QUALITY_RANK[pref.quality] ?? 1;
        if (rank > bestRank) { bestRank = rank; quality = pref.quality; }
        if (pref.retina) anyRetina = true;
      }
      retina = anyRetina;
    }
    return { quality, retina };
  }

  startParams(vp, { quality = this.defaultQuality, retina = this.defaultRetina } = {}) {
    const preset = SCREENCAST_PRESETS[normalizeScreencastQuality(quality, this.defaultQuality)];
    const scale = retina ? 2 : 1;
    const maxWCap = retina ? 3840 : 2560;
    const maxHCap = retina ? 2160 : 1440;
    const params = {
      format: preset.format,
      maxWidth: Math.min(maxWCap, Math.max(640, Math.round(vp.width * scale))),
      maxHeight: Math.min(maxHCap, Math.max(360, Math.round(vp.height * scale))),
      everyNthFrame: 1,
    };
    if (preset.format === 'jpeg') params.quality = preset.quality;
    return params;
  }

  async restartSession(tabId, session, viewport) {
    if (!session || session.tab?.page?.isClosed?.()) return;
    const vp = viewport || session.tab.page.viewportSize() || session.fallbackVp || { width: 1280, height: 800 };
    const { quality, retina } = this.effectivePrefs(session);
    session.quality = quality;
    session.retina = retina;
    session.lastFrame = null;
    session.activeUntil = Date.now() + this.activeWindowMs;
    this.clearPendingAck(session);
    try {
      await session.cdp.send('Page.stopScreencast').catch(() => {});
      if (this.sessions.get(tabId) !== session) return;
      await session.cdp.send('Page.startScreencast', this.startParams(vp, { quality, retina }));
    } catch { /* ignore transient restart errors */ }
  }

  async syncWindowBounds(session, vp, metadata) {
    if (!session || session.syncingBounds || !vp?.width || !vp?.height) return;
    const deviceWidth = metadata?.deviceWidth;
    const deviceHeight = metadata?.deviceHeight;
    if (!deviceWidth || !deviceHeight) return;
    if (Math.abs(deviceWidth - vp.width) <= 1 && Math.abs(deviceHeight - vp.height) <= 1) return;
    const key = `${vp.width}x${vp.height}`;
    if (session.syncedBoundsKey === key) return;
    const bcdp = typeof session.getBrowserCdp === 'function' ? session.getBrowserCdp() : null;
    if (!bcdp) return;
    session.syncingBounds = true;
    session.syncedBoundsKey = key;
    try {
      const targetId = session.tab?.targetId
        || (await session.cdp.send('Target.getTargetInfo').catch(() => null))?.targetInfo?.targetId;
      if (!targetId) return;
      const win = await bcdp.send('Browser.getWindowForTarget', { targetId }).catch(() => null);
      if (!win?.windowId) return;
      const current = await bcdp.send('Browser.getWindowBounds', { windowId: win.windowId }).catch(() => null);
      const curW = current?.bounds?.width || 0;
      const curH = current?.bounds?.height || 0;
      const insetW = curW >= deviceWidth && curW - deviceWidth <= 64 ? curW - deviceWidth : 0;
      const insetH = curH >= deviceHeight && curH - deviceHeight <= 200 ? curH - deviceHeight : 0;
      await bcdp.send('Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds: {
          width: vp.width + insetW,
          height: vp.height + insetH,
        },
      }).catch(() => {});
    } finally {
      session.syncingBounds = false;
    }
  }

  async enable(tab, viewerId, viewport, { getBrowserCdp, quality, retina } = {}) {
    if (!tab || tab.hidden || tab.page.isClosed() || tab.crashed) {
      throw new InputError('该标签页当前不可使用画面直连模式。', 409);
    }
    const viewerPref = {
      quality: quality !== undefined ? normalizeScreencastQuality(quality, this.defaultQuality) : this.defaultQuality,
      retina: retina !== undefined ? Boolean(retina) : this.defaultRetina,
    };
    // Remove this viewer from any other tab's screencast first.
    for (const [otherId, session] of this.sessions) {
      if (otherId !== tab.id && session.viewers.has(viewerId)) {
        await this.disable(otherId, viewerId);
      }
    }
    let session = this.sessions.get(tab.id);
    if (session) {
      session.viewers.add(viewerId);
      session.viewerPrefs.set(viewerId, viewerPref);
      const nextPrefs = this.effectivePrefs(session);
      this.noteActivity(tab.id);
      if (nextPrefs.quality !== session.quality || nextPrefs.retina !== session.retina) {
        await this.restartSession(tab.id, session);
      } else if (session.lastFrame) {
        this.emit('frame', { ...session.lastFrame, targetViewerId: viewerId });
      }
      return true;
    }
    if (!tab.cdp) {
      tab.cdp = await tab.page.context().newCDPSession(tab.page);
    }
    await tab.page.bringToFront?.().catch(() => {});
    const cdp = tab.cdp;
    const fallbackVp = viewport || { width: 1280, height: 800 };
    const vp = tab.page.viewportSize() || fallbackVp;
    const viewerPrefs = new Map([[viewerId, viewerPref]]);
    session = {
      tab,
      viewers: new Set([viewerId]),
      viewerPrefs,
      cdp,
      handler: null,
      lastFrame: null,
      syncedBoundsKey: null,
      syncingBounds: false,
      getBrowserCdp,
      fallbackVp,
      activeUntil: Date.now() + this.activeWindowMs,
      ackTimer: null,
      pendingAckSessionId: null,
      dedupedFrames: 0,
      quality: viewerPref.quality,
      retina: viewerPref.retina,
    };
    const handler = params => {
      this.scheduleAck(session, params.sessionId);
      const curVp = tab.page.viewportSize() || session.fallbackVp || { width: 1280, height: 800 };
      const rawOffsetTop = Number(params.metadata?.offsetTop);
      const rawScale = Number(params.metadata?.pageScaleFactor);
      const rawBuffer = Buffer.from(params.data, 'base64');
      const format = SCREENCAST_PRESETS[session.quality]?.format || 'jpeg';
      const width = params.metadata?.deviceWidth || curVp.width;
      const height = params.metadata?.deviceHeight || curVp.height;
      const offsetTop = Number.isFinite(rawOffsetTop) && rawOffsetTop > 0 ? rawOffsetTop : 0;
      const pageScaleFactor = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
      const prev = session.lastFrame;
      const unchanged = Boolean(
        prev
        && prev.format === format
        && prev.rawBuffer.length === rawBuffer.length
        && prev.width === width
        && prev.height === height
        && prev.viewportWidth === curVp.width
        && prev.viewportHeight === curVp.height
        && prev.offsetTop === offsetTop
        && prev.pageScaleFactor === pageScaleFactor
        && prev.rawBuffer.equals(rawBuffer),
      );
      if (unchanged) {
        session.dedupedFrames++;
        this.syncWindowBounds(session, curVp, params.metadata).catch(() => {});
        return;
      }
      const frame = {
        type: 'screencast-frame',
        tabId: tab.id,
        format,
        data: params.data,
        rawBuffer,
        width,
        height,
        viewportWidth: curVp.width,
        viewportHeight: curVp.height,
        offsetTop,
        pageScaleFactor,
        timestamp: Date.now(),
      };
      session.lastFrame = frame;
      this.emit('frame', frame);
      this.syncWindowBounds(session, curVp, params.metadata).catch(() => {});
    };
    session.handler = handler;
    this.sessions.set(tab.id, session);
    cdp.on('Page.screencastFrame', handler);
    try {
      await cdp.send('Page.startScreencast', this.startParams(vp, { quality: session.quality, retina: session.retina }));
    } catch {
      this.clearPendingAck(session);
      cdp.off('Page.screencastFrame', handler);
      this.sessions.delete(tab.id);
      throw new InputError('当前页面不支持画面直连模式。', 409);
    }
    return true;
  }

  async updateViewport(tabId, viewport) {
    const session = this.sessions.get(tabId);
    if (!session || !viewport?.width || !viewport?.height) return;
    session.fallbackVp = viewport;
    session.syncedBoundsKey = null;
    await this.restartSession(tabId, session, viewport);
  }

  resyncBounds() {
    for (const session of this.sessions.values()) {
      session.syncedBoundsKey = null;
      if (session.lastFrame) {
        const curVp = session.tab?.page?.viewportSize?.() || session.fallbackVp;
        this.syncWindowBounds(session, curVp, {
          deviceWidth: session.lastFrame.width,
          deviceHeight: session.lastFrame.height,
        }).catch(() => {});
      }
    }
  }

  async disable(tabId, viewerId) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.viewers.delete(viewerId);
    session.viewerPrefs?.delete(viewerId);
    if (session.viewers.size > 0) {
      const nextPrefs = this.effectivePrefs(session);
      if (nextPrefs.quality !== session.quality || nextPrefs.retina !== session.retina) {
        await this.restartSession(tabId, session);
      }
      return;
    }
    this.clearPendingAck(session);
    this.sessions.delete(tabId);
    session.cdp.off('Page.screencastFrame', session.handler);
    await session.cdp.send('Page.stopScreencast').catch(() => {});
  }

  async removeViewer(viewerId) {
    const tabIds = [...this.sessions.keys()];
    for (const tabId of tabIds) {
      if (this.sessions.get(tabId)?.viewers.has(viewerId)) {
        await this.disable(tabId, viewerId);
      }
    }
  }

  async removeTab(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.clearPendingAck(session);
    this.sessions.delete(tabId);
    session.cdp.off('Page.screencastFrame', session.handler);
    await session.cdp.send('Page.stopScreencast').catch(() => {});
  }

  async stopAll() {
    for (const tabId of [...this.sessions.keys()]) {
      await this.removeTab(tabId);
    }
  }
}

export function resolveScreencastPoint(command, viewport, frameMetrics) {
  const vpW = Math.max(1, Number(viewport?.width) || 1280);
  const vpH = Math.max(1, Number(viewport?.height) || 800);
  const geometry = frameMetrics ? computeScreencastFrameGeometry(frameMetrics, { width: vpW, height: vpH }) : null;
  const maxW = Math.max(vpW, geometry?.capturedWidth || vpW);
  const maxH = Math.max(vpH, geometry?.capturedHeight || vpH);
  const coordW = Number.isFinite(command.frameWidth)
    ? Math.min(maxW, Math.max(1, command.frameWidth))
    : (geometry?.coordWidth || vpW);
  const coordH = Number.isFinite(command.frameHeight)
    ? Math.min(maxH, Math.max(1, command.frameHeight))
    : (geometry?.coordHeight || vpH);
  const x = Math.min(Math.max(0, vpW - 0.5), Math.max(0, command.x * coordW));
  const y = Math.min(Math.max(0, vpH - 0.5), Math.max(0, command.y * coordH));
  return { x, y };
}

export async function dispatchScreencastInput(tab, command, fallbackViewport, frameMetrics = null) {
  if (!tab || tab.hidden || tab.page.isClosed() || tab.crashed) {
    throw new InputError('标签页已关闭或崩溃。', 409);
  }
  if (tab.dialog) {
    throw new InputError('请先处理当前页面的原生弹窗。', 409);
  }
  const vp = tab.page.viewportSize() || fallbackViewport || { width: 1280, height: 800 };
  if (['mousedown', 'click', 'text', 'key'].includes(command.action)) {
    await tab.page.bringToFront();
  }
  if (command.action === 'mousedown') {
    const { x, y } = resolveScreencastPoint(command, vp, frameMetrics);
    await tab.page.mouse.move(x, y);
    await tab.page.mouse.down({ button: command.button });
  } else if (command.action === 'mousemove') {
    const { x, y } = resolveScreencastPoint(command, vp, frameMetrics);
    await tab.page.mouse.move(x, y);
  } else if (command.action === 'mouseup') {
    const { x, y } = resolveScreencastPoint(command, vp, frameMetrics);
    await tab.page.mouse.move(x, y);
    await tab.page.mouse.up({ button: command.button });
  } else if (command.action === 'click') {
    const { x, y } = resolveScreencastPoint(command, vp, frameMetrics);
    await tab.page.mouse.click(x, y, {
      button: command.button,
      clickCount: command.clickCount,
    });
  } else if (command.action === 'wheel') {
    const { x, y } = resolveScreencastPoint(command, vp, frameMetrics);
    if (tab.cdp) {
      await tab.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: command.deltaX,
        deltaY: command.deltaY,
      });
    } else {
      await tab.page.mouse.move(x, y);
      await tab.page.mouse.wheel(command.deltaX, command.deltaY);
    }
  } else if (command.action === 'text') {
    await tab.page.keyboard.insertText(command.value);
  } else if (command.action === 'key') {
    await tab.page.keyboard.press([...command.modifiers, command.key].join('+'));
  }
  return { ok: true };
}
