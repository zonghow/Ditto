import { InputError } from './snapshot.js';
import { validateControl } from './control.js';
import { RECORDER_KEY } from './recorder.js';
import { validateScreencastInput, dispatchScreencastInput } from './screencast.js';

export function performScreencastInput(browser, id, input) {
  const command = validateScreencastInput(input);
  browser.screencast?.noteActivity?.(command.tabId);
  if (command.action === 'mousemove' && browser.queuedScreencastMove &&
    browser.queuedScreencastMove.tabId === command.tabId) {
    browser.queuedScreencastMove.x = command.x;
    browser.queuedScreencastMove.y = command.y;
    browser.queuedScreencastMove.frameWidth = command.frameWidth;
    browser.queuedScreencastMove.frameHeight = command.frameHeight;
    return Promise.resolve({ ok: true, coalesced: true });
  }
  if (command.action === 'wheel' && browser.queuedWheel &&
    browser.queuedWheel.screencast && browser.queuedWheel.tabId === command.tabId) {
    browser.queuedWheel.x = command.x;
    browser.queuedWheel.y = command.y;
    browser.queuedWheel.frameWidth = command.frameWidth;
    browser.queuedWheel.frameHeight = command.frameHeight;
    browser.queuedWheel.deltaX = Math.max(-4000, Math.min(4000, browser.queuedWheel.deltaX + command.deltaX));
    browser.queuedWheel.deltaY = Math.max(-4000, Math.min(4000, browser.queuedWheel.deltaY + command.deltaY));
    return Promise.resolve({ ok: true, coalesced: true });
  }
  if (browser.controlBacklog >= 32) {
    if (command.action === 'wheel' || command.action === 'mousemove') return Promise.resolve({ ok: true, skipped: true });
    throw new InputError('远端操作正在处理中，请稍后重试。', 429);
  }
  browser.controlBacklog++;
  if (command.action === 'mousemove') {
    browser.queuedScreencastMove = command;
  } else {
    browser.queuedScreencastMove = null;
  }
  if (command.action === 'wheel') { command.screencast = true; browser.queuedWheel = command; }
  const operation = browser.controlQueue.then(() => {
    if (browser.queuedWheel === command) browser.queuedWheel = null;
    if (browser.queuedScreencastMove === command) browser.queuedScreencastMove = null;
    return dispatchScreencastInput(
      browser.tabs.get(command.tabId),
      command,
      browser.viewport,
      browser.screencast?.getFrameMetrics?.(command.tabId) || null,
    );
  }).finally(() => {
    if (browser.queuedWheel === command) browser.queuedWheel = null;
    if (browser.queuedScreencastMove === command) browser.queuedScreencastMove = null;
    browser.controlBacklog--;
  });
  browser.controlQueue = operation.catch(() => {});
  return operation;
}

export function performControl(browser, id, input) {
  const command = validateControl(input);
  // Hover and trackpad momentum wheel ticks must never backlog ahead of clicks
  // or trigger noisy 429 errors during smooth scrolling.
  if (command.action === 'move' && browser.controlBacklog) return Promise.resolve({ ok: true, skipped: true });
  if (command.action === 'wheel' && browser.queuedWheel &&
    !browser.queuedWheel.screencast &&
    browser.queuedWheel.tabId === command.tabId && browser.queuedWheel.documentId === command.documentId) {
    browser.queuedWheel.deltaX = Math.max(-4000, Math.min(4000, browser.queuedWheel.deltaX + command.deltaX));
    browser.queuedWheel.deltaY = Math.max(-4000, Math.min(4000, browser.queuedWheel.deltaY + command.deltaY));
    browser.queuedWheel.nodeId = command.nodeId;
    browser.queuedWheel.offsetX = command.offsetX;
    browser.queuedWheel.offsetY = command.offsetY;
    if (command.viewportX !== undefined && command.viewportY !== undefined) {
      browser.queuedWheel.viewportX = command.viewportX;
      browser.queuedWheel.viewportY = command.viewportY;
    }
    return Promise.resolve({ ok: true, coalesced: true });
  }
  if (browser.controlBacklog >= 32) {
    if (command.action === 'wheel' || command.action === 'move') return Promise.resolve({ ok: true, skipped: true });
    throw new InputError('远端操作正在处理中，请稍后重试。', 429);
  }
  browser.controlBacklog++;
  if (command.action === 'wheel') browser.queuedWheel = command;
  const operation = browser.controlQueue.then(() => {
    if (browser.queuedWheel === command) browser.queuedWheel = null;
    return browser.dispatchControl(id, 0, command);
  }).finally(() => {
    if (browser.queuedWheel === command) browser.queuedWheel = null;
    browser.controlBacklog--;
  });
  browser.controlQueue = operation.catch(() => {});
  return operation;
}

export async function dispatchControl(browser, id, _revision, command) {
  if (!browser.ready || browser.importing) throw new InputError('浏览器正在启动或导入登录态。', 409);
  const tab = browser.tabs.get(command.tabId);
  const viewer = browser.viewers.get(id);
  if (viewer && viewer.selected && viewer.selected !== command.tabId) throw new InputError('已切换标签页，旧标签页的排队操作已丢弃。', 409);
  if (!tab || tab.hidden || tab.page.isClosed() || tab.documentId !== command.documentId || tab.dialog || tab.crashed || tab.recordingStatus !== 'live') throw new InputError('网页已变化、已关闭或有弹窗，请等待回放更新。', 409);

  // Direct viewport wheel fast-path: optimistic local scrolling moves elements in
  // the replay DOM before the remote catches up, so resolving wheel coordinates
  // from a node's remote bounding box causes false out-of-viewport rejections
  // and end-of-scroll snapback. Dispatch directly at the cursor viewport point.
  if (command.action === 'wheel' && command.viewportX !== undefined && command.viewportY !== undefined) {
    try {
      const vp = tab.page.viewportSize() || browser.viewport;
      const x = Math.min(Math.max(0, vp.width - 1), Math.max(0, command.viewportX * vp.width));
      const y = Math.min(Math.max(0, vp.height - 1), Math.max(0, command.viewportY * vp.height));
      if (!browser.ready || browser.importing) throw new InputError('浏览器正在启动或导入登录态。', 409);
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
      return { ok: true };
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError('页面变化导致操作未完成，请等待最新回放再重试。', 409);
    }
  }

  // Fast path for main-frame pointer actions: collapse 6+ Playwright IPC
  // round-trips into a single page.evaluate for low-latency hover/scroll/click.
  if (command.framePath.length === 0 && ['click', 'move', 'wheel'].includes(command.action)) {
    try {
      const vp = tab.page.viewportSize() || browser.viewport;
      const resolved = await tab.page.evaluate(({ key, docId, nodeId, offsetX, offsetY, checkHit, vpW, vpH }) => {
        const rec = window[key];
        if (!rec || rec.documentId !== docId) return { err: '网页已导航，已丢弃旧页面的操作。' };
        const node = rec.resolveNode(nodeId);
        if (!node || !node.isConnected || node.nodeType !== 1) return { err: '目标节点已经变化，请等待回放更新。' };
        if (node.ownerDocument !== document) return { err: '目标 frame 与回放不一致。' };
        if (node.tagName === 'IFRAME' || (node.tagName === 'CANVAS' && !rec.isRecordedCanvas?.(node)) || node.closest('[data-ditto-private]')) {
          return { err: '未录制的 Canvas/frame 或私有遮罩区域不支持回放操作。' };
        }
        const rect = node.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return { err: '目标节点不可见。' };
        const x = rect.left + offsetX * rect.width;
        const y = rect.top + offsetY * rect.height;
        if (x < 0 || y < 0 || x >= vpW || y >= vpH) return { err: '目标不在远端视口中。' };
        if (checkHit) {
          let hit = document.elementFromPoint(x, y);
          while (hit?.shadowRoot?.elementFromPoint) {
            const child = hit.shadowRoot.elementFromPoint(x, y);
            if (!child || child === hit) break;
            hit = child;
          }
          if (!(node === hit || node.contains(hit))) return { err: '目标已被其他内容遮挡，已丢弃这次点击。' };
        }
        return { ok: true, x, y };
      }, {
        key: RECORDER_KEY,
        docId: command.documentId,
        nodeId: command.nodeId,
        offsetX: command.offsetX,
        offsetY: command.offsetY,
        checkHit: command.action === 'click',
        vpW: vp.width,
        vpH: vp.height,
      });
      if (!resolved?.ok) throw new InputError(resolved?.err || '目标节点已经变化，请等待回放更新。', 409);
      if (!browser.ready || browser.importing) throw new InputError('浏览器正在启动或导入登录态。', 409);
      if (command.action === 'click') {
        await tab.page.bringToFront();
        await tab.page.mouse.click(resolved.x, resolved.y, { button: command.button, clickCount: command.clickCount });
      } else if (command.action === 'move') {
        await tab.page.mouse.move(resolved.x, resolved.y);
      } else if (tab.cdp) {
        await tab.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: resolved.x,
          y: resolved.y,
          deltaX: command.deltaX,
          deltaY: command.deltaY,
        });
      } else {
        await tab.page.mouse.move(resolved.x, resolved.y);
        await tab.page.mouse.wheel(command.deltaX, command.deltaY);
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError('页面变化导致操作未完成，请等待最新回放再重试。', 409);
    }
  }

  let handle;
  try {
    const documentId = await tab.page.evaluate(key => window[key]?.documentId, RECORDER_KEY);
    if (documentId !== command.documentId) throw new InputError('网页已导航，已丢弃旧页面的操作。', 409);
    handle = await tab.page.evaluateHandle(({ key, id }) => window[key]?.resolveNode(id), { key: RECORDER_KEY, id: command.nodeId });
    let element = handle.asElement();
    if (!element || !await element.evaluate(node => node.isConnected)) throw new InputError('目标节点已经变化，请等待回放更新。', 409);
    if (await element.evaluate((node, key) => node.tagName === 'IFRAME'
      || (node.tagName === 'CANVAS' && !window.top?.[key]?.isRecordedCanvas?.(node))
      || Boolean(node.closest('[data-ditto-private]')), RECORDER_KEY)) {
      throw new InputError('未录制的 Canvas/frame 或私有遮罩区域不支持回放操作。', 409);
    }
    let frame = tab.page.mainFrame();
    for (const frameId of command.framePath) {
      const frameHandle = await tab.page.evaluateHandle(({ key, id }) => window[key]?.resolveNode(id), { key: RECORDER_KEY, id: frameId });
      try {
        const frameElement = frameHandle.asElement();
        if (!frameElement || await frameElement.ownerFrame() !== frame) throw new InputError('回放 frame 已变化。', 409);
        frame = await frameElement.contentFrame();
        if (!frame) throw new InputError('当前 frame 无法操作。', 409);
      } finally { await frameHandle.dispose(); }
    }
    if (await element.ownerFrame() !== frame) throw new InputError('目标 frame 与回放不一致。', 409);
    if (frame !== tab.page.mainFrame()) {
      await handle.dispose();
      handle = await frame.evaluateHandle(({ key, id }) => window.top[key]?.resolveNode(id),
        { key: RECORDER_KEY, id: command.nodeId });
      element = handle.asElement();
      if (!element || await element.ownerFrame() !== frame) throw new InputError('目标 frame 已变化。', 409);
    }
    if (['click', 'input', 'select', 'text', 'key'].includes(command.action)) await tab.page.bringToFront();
    if (['click', 'move', 'wheel'].includes(command.action)) {
      const box = await element.boundingBox();
      if (!box || box.width < 1 || box.height < 1) throw new InputError('目标节点不可见。', 409);
      const point = { x: box.x + command.offsetX * box.width, y: box.y + command.offsetY * box.height };
      const viewport = tab.page.viewportSize() || browser.viewport;
      if (point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height) throw new InputError('目标不在远端视口中。', 409);
      if (!browser.ready || browser.importing) throw new InputError('浏览器正在启动或导入登录态。', 409);
      if (command.action === 'click') {
        const hitMatches = await element.evaluate((node, offset) => {
          const rect = node.getBoundingClientRect();
          let hit = node.ownerDocument.elementFromPoint(rect.left + rect.width * offset.x, rect.top + rect.height * offset.y);
          while (hit?.shadowRoot?.elementFromPoint) {
            const child = hit.shadowRoot.elementFromPoint(rect.left + rect.width * offset.x, rect.top + rect.height * offset.y);
            if (!child || child === hit) break;
            hit = child;
          }
          return node === hit || node.contains(hit);
        }, { x: command.offsetX, y: command.offsetY });
        if (!hitMatches) throw new InputError('目标已被其他内容遮挡，已丢弃这次点击。', 409);
      }
      if (command.action === 'click') await tab.page.mouse.click(point.x, point.y, { button: command.button, clickCount: command.clickCount });
      else if (command.action === 'move') await tab.page.mouse.move(point.x, point.y);
      else if (tab.cdp) {
        await tab.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: point.x,
          y: point.y,
          deltaX: command.deltaX,
          deltaY: command.deltaY,
        });
      } else { await tab.page.mouse.move(point.x, point.y); await tab.page.mouse.wheel(command.deltaX, command.deltaY); }
    } else if (command.action === 'select') {
      if (!await element.evaluate(node => node.tagName === 'SELECT')) throw new InputError('目标不是下拉选项。');
      await element.selectOption(command.value, { timeout: 2500 });
    } else if (command.action === 'input' || command.action === 'text') {
      const editable = await element.evaluate(node => node.isContentEditable ||
        (['INPUT', 'TEXTAREA'].includes(node.tagName) && !['file', 'hidden', 'checkbox', 'radio', 'submit', 'button'].includes(node.type) && !node.disabled && !node.readOnly));
      if (!editable) throw new InputError('目标不是可输入字段；文件和隐藏字段不允许从回放操作。');
      if (command.action === 'input') await element.fill(command.value, { timeout: 2500 });
      else {
        const alreadyFocused = await element.evaluate(node => {
          const matches = cur => Boolean(cur && (cur === node || cur.contains?.(node) || node.contains?.(cur)));
          return matches(node.ownerDocument.activeElement) || matches(node.getRootNode?.()?.activeElement);
        });
        if (!alreadyFocused) throw new InputError('输入焦点已变化，先点击目标字段再输入。', 409);
        if (command.appendToPassword) await element.evaluate(node => {
          if (node.type === 'password') node.setSelectionRange(node.value.length, node.value.length);
        });
        await tab.page.keyboard.insertText(command.value);
      }
      if (command.selectionStart !== undefined) await element.evaluate((node, selection) => {
        try { node.setSelectionRange(selection.start, selection.end); } catch {}
      }, { start: command.selectionStart, end: command.selectionEnd });
    } else {
      await element.evaluate(node => {
        const matches = cur => Boolean(cur && (cur === node || cur.contains?.(node) || node.contains?.(cur)));
        if (!matches(node.ownerDocument.activeElement) && !matches(node.getRootNode?.()?.activeElement)) {
          node.focus?.();
        }
      }).catch(() => {});
      await tab.page.keyboard.press([...command.modifiers, command.key].join('+'));
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('页面变化导致操作未完成，请等待最新回放再重试。', 409);
  } finally { await handle?.dispose().catch(() => {}); }
}

export async function getSelectionText(browser, tabId) {
  const tab = browser.tabs.get(tabId);
  if (!tab || tab.hidden || tab.page.isClosed() || tab.crashed) throw new InputError('这个远端标签页已关闭。', 404);
  const text = await tab.page.evaluate(() => {
    const active = document.activeElement;
    if (active && ['INPUT', 'TEXTAREA'].includes(active.tagName) && active.type !== 'password') {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? 0;
      if (end > start) return active.value.slice(start, end).slice(0, 32768);
    }
    return String(window.getSelection?.()?.toString() || '').slice(0, 32768);
  }).catch(() => '');
  return { text };
}

export async function uploadFileToTab(browser, tabId, { name, mimeType, buffer }) {
  const tab = browser.tabs.get(tabId);
  if (!tab || tab.hidden || tab.page.isClosed() || tab.crashed) throw new InputError('这个远端标签页已关闭。', 404);
  const fileInput = tab.page.locator('input[type="file"]').first();
  if (await fileInput.count() === 0) {
    throw new InputError('当前网页未找到文件上传控件 (input[type="file"])。', 404);
  }
  await fileInput.setInputFiles({ name, mimeType: mimeType || 'application/octet-stream', buffer });
  return { ok: true, filename: name, size: buffer.length };
}
