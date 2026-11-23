import { EventEmitter } from 'node:events';
import { InputError } from './snapshot.js';

const ALLOWED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Space',
]);
const ALLOWED_MODIFIERS = new Set(['Control', 'Meta', 'Alt', 'Shift']);
const ALLOWED_ACTIONS = new Set(['mousedown', 'mousemove', 'mouseup', 'click', 'wheel', 'key', 'text']);

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
  sessions = new Map(); // tabId -> { viewers: Set<string>, cdp, handler, lastFrame }

  hasViewers(tabId) {
    return (this.sessions.get(tabId)?.viewers.size || 0) > 0;
  }

  isViewerWatching(tabId, viewerId) {
    return Boolean(this.sessions.get(tabId)?.viewers.has(viewerId));
  }

  async enable(tab, viewerId, viewport) {
    if (!tab || tab.hidden || tab.page.isClosed() || tab.crashed) {
      throw new InputError('该标签页当前不可使用画面直连模式。', 409);
    }
    // Remove this viewer from any other tab's screencast first.
    for (const [otherId, session] of this.sessions) {
      if (otherId !== tab.id && session.viewers.has(viewerId)) {
        await this.disable(otherId, viewerId);
      }
    }
    let session = this.sessions.get(tab.id);
    if (session) {
      session.viewers.add(viewerId);
      if (session.lastFrame) {
        this.emit('frame', { ...session.lastFrame, targetViewerId: viewerId });
      }
      return true;
    }
    if (!tab.cdp) {
      tab.cdp = await tab.page.context().newCDPSession(tab.page);
    }
    await tab.page.bringToFront?.().catch(() => {});
    const cdp = tab.cdp;
    const vp = tab.page.viewportSize() || viewport || { width: 1280, height: 800 };
    session = { viewers: new Set([viewerId]), cdp, handler: null, lastFrame: null };
    const handler = params => {
      cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      const frame = {
        type: 'screencast-frame',
        tabId: tab.id,
        data: params.data,
        rawBuffer: Buffer.from(params.data, 'base64'),
        width: params.metadata?.deviceWidth || vp.width,
        height: params.metadata?.deviceHeight || vp.height,
        timestamp: Date.now(),
      };
      session.lastFrame = frame;
      this.emit('frame', frame);
    };
    session.handler = handler;
    this.sessions.set(tab.id, session);
    cdp.on('Page.screencastFrame', handler);
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 75,
        maxWidth: Math.min(1920, Math.max(640, vp.width)),
        maxHeight: Math.min(1080, Math.max(360, vp.height)),
        everyNthFrame: 1,
      });
    } catch {
      cdp.off('Page.screencastFrame', handler);
      this.sessions.delete(tab.id);
      throw new InputError('当前页面不支持画面直连模式。', 409);
    }
    return true;
  }

  async disable(tabId, viewerId) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.viewers.delete(viewerId);
    if (session.viewers.size > 0) return;
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

export async function dispatchScreencastInput(tab, command, fallbackViewport) {
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
    await tab.page.mouse.move(command.x * vp.width, command.y * vp.height);
    await tab.page.mouse.down({ button: command.button });
  } else if (command.action === 'mousemove') {
    await tab.page.mouse.move(command.x * vp.width, command.y * vp.height);
  } else if (command.action === 'mouseup') {
    await tab.page.mouse.move(command.x * vp.width, command.y * vp.height);
    await tab.page.mouse.up({ button: command.button });
  } else if (command.action === 'click') {
    await tab.page.mouse.click(command.x * vp.width, command.y * vp.height, {
      button: command.button,
      clickCount: command.clickCount,
    });
  } else if (command.action === 'wheel') {
    const x = command.x * vp.width;
    const y = command.y * vp.height;
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
