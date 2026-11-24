import { stat } from 'node:fs/promises';
import path from 'node:path';
import { InputError } from './snapshot.js';
import { inspectJsHandle, descriptorToSummary } from './devtools.js';

const MAX_LOG_ENTRIES = 200;

function sanitizeLogUrl(raw) {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(raw || '').slice(0, 160);
  }
}

export function attachTabDiagnostics(tab, onEvent = null) {
  tab.consoleLogs = [];
  tab.networkLogs = [];
  tab.devtoolsSeq = tab.devtoolsSeq || 0;
  const requestStarts = new WeakMap();
  const pushBounded = (arr, item) => {
    arr.push(item);
    if (arr.length > MAX_LOG_ENTRIES) arr.splice(0, arr.length - MAX_LOG_ENTRIES);
  };
  tab.page.on('console', msg => {
    const rawLevel = msg.type();
    const levelMap = {
      error: 'error',
      warning: 'warning',
      log: 'log',
      info: 'info',
      debug: 'debug',
      assert: 'assert',
      dir: 'log',
      table: 'log',
      trace: 'log',
      count: 'log',
    };
    const level = levelMap[rawLevel];
    if (!level) return;
    const rawText = String(msg.text() || '');
    const text = rawText.replace(/\s+/g, ' ').trim().slice(0, 1500);
    const loc = msg.location?.();
    const location = loc?.url
      ? { url: sanitizeLogUrl(loc.url), line: Number.isInteger(loc.lineNumber) ? loc.lineNumber + 1 : null }
      : undefined;
    const entry = {
      id: ++tab.devtoolsSeq,
      time: new Date().toISOString(),
      level,
      text,
      ...(location ? { location } : {}),
    };
    pushBounded(tab.consoleLogs, entry);
    onEvent?.('console', entry);

    // Enrich logs that contain object/DOM/Error JSHandles so DevTools viewers
    // can expand structured properties instead of reading flat preview strings.
    const handles = typeof msg.args === 'function' ? msg.args() : [];
    const likelyRich = /[{[\(<]|JSHandle@|Map\(|Set\(|Error\b|Array\(|Object\b/.test(rawText) || level === 'error';
    if (handles.length > 0 && handles.length <= 8 && likelyRich) {
      Promise.all(handles.map(handle => inspectJsHandle(handle, 400)))
        .then(descriptors => {
          const valid = descriptors.filter(Boolean);
          if (!valid.length) return;
          const hasRich = valid.some(d => ['object', 'array', 'map', 'set', 'error', 'element', 'function', 'date', 'regexp'].includes(d.t));
          if (!hasRich) return;
          entry.args = valid;
          const summary = valid.map(descriptorToSummary).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
          if (summary && rawText.includes('JSHandle@')) entry.text = summary;
          onEvent?.('console-update', entry);
        })
        .catch(() => {});
    }
  });
  tab.page.on('pageerror', error => {
    const stack = typeof error?.stack === 'string'
      ? error.stack.split('\n').slice(0, 8).join('\n').slice(0, 1200)
      : undefined;
    const entry = {
      id: ++tab.devtoolsSeq,
      time: new Date().toISOString(),
      level: 'pageerror',
      text: String(error?.message || error || 'Uncaught error').slice(0, 1000),
      ...(stack ? { stack } : {}),
    };
    pushBounded(tab.consoleLogs, entry);
    onEvent?.('console', entry);
  });
  tab.page.on('request', req => {
    requestStarts.set(req, Date.now());
  });
  tab.page.on('response', res => {
    const req = res.request();
    const type = req.resourceType();
    if (!['fetch', 'xhr', 'document', 'script', 'stylesheet', 'other'].includes(type)) return;
    const started = requestStarts.get(req);
    const status = res.status();
    const headers = typeof res.headers === 'function' ? (res.headers() || {}) : {};
    const contentType = typeof headers['content-type'] === 'string'
      ? headers['content-type'].split(';')[0].trim().slice(0, 80)
      : null;
    const rawLen = Number(headers['content-length']);
    const size = Number.isFinite(rawLen) && rawLen >= 0 ? rawLen : null;
    const entry = {
      id: ++tab.devtoolsSeq,
      time: new Date().toISOString(),
      method: req.method(),
      url: sanitizeLogUrl(req.url()),
      resourceType: type,
      status,
      ok: status < 400,
      durationMs: started ? Date.now() - started : null,
      contentType,
      size,
      failure: null,
    };
    pushBounded(tab.networkLogs, entry);
    onEvent?.('network', entry);
  });
  tab.page.on('requestfailed', req => {
    const started = requestStarts.get(req);
    const entry = {
      id: ++tab.devtoolsSeq,
      time: new Date().toISOString(),
      method: req.method(),
      url: sanitizeLogUrl(req.url()),
      resourceType: req.resourceType(),
      status: 0,
      ok: false,
      durationMs: started ? Date.now() - started : null,
      contentType: null,
      size: null,
      failure: req.failure()?.errorText || 'failed',
    };
    pushBounded(tab.networkLogs, entry);
    onEvent?.('network', entry);
  });
}

export async function runAgentSnapshot(browser, tabId, options = {}) {
  const { limit = 150, maxChars = 8000, sessionId = null } = options;
  await browser.waitReady();
  const tab = browser.resolveTab(tabId, sessionId);
  const maxItems = Math.min(Math.max(Number(limit) || 150, 1), 500);
  const maxText = Math.min(Math.max(Number(maxChars) || 8000, 200), 50000);
  return browser.runOnTab(tab, () => browser.withAgentActivity(tab, options, 'snapshot', async () => {
    await browser.refresh(tab);
    const data = await tab.page.evaluate(({ maxItems, maxText }) => {
      const refs = new Map();
      Object.defineProperty(window, '__dittoAgentRefs', { value: refs, configurable: true, writable: true });
      const selector = 'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [contenteditable="true"]';
      const elements = [];
      const seen = new Set();
      let index = 0;

      const collectFromRoot = (root, win, frameLabel, depth) => {
        if (!root || depth > 8 || index >= maxItems) return;
        let nodes = [];
        try { nodes = root.querySelectorAll(selector); } catch { return; }
        for (const node of nodes) {
          if (index >= maxItems) break;
          if (seen.has(node)) continue;
          seen.add(node);
          const rect = node.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) continue;
          const style = win.getComputedStyle(node);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          index += 1;
          const ref = `@e${index}`;
          refs.set(ref, node);
          const tag = node.tagName.toLowerCase();
          const type = node.getAttribute('type');
          const isPassword = tag === 'input' && String(type || '').toLowerCase() === 'password';
          const label = (node.innerText || (!isPassword ? node.value : '') || node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.getAttribute('title') || '')
            .replace(/\s+/g, ' ').trim().slice(0, 120);
          const item = { ref, tag };
          const role = node.getAttribute('role');
          const name = node.getAttribute('name');
          const placeholder = node.getAttribute('placeholder');
          const href = tag === 'a' ? node.href : null;
          if (role) item.role = role;
          if (type) item.type = type;
          if (name) item.name = name;
          if (placeholder) item.placeholder = placeholder.slice(0, 80);
          if (label) item.text = label;
          if (href) item.href = href.slice(0, 200);
          if (['input', 'textarea', 'select'].includes(tag) && !isPassword && typeof node.value === 'string' && node.value) {
            item.value = node.value.slice(0, 120);
          }
          if (typeof node.checked === 'boolean' && (type === 'checkbox' || type === 'radio')) {
            item.checked = node.checked;
          } else if (node.hasAttribute('aria-checked')) {
            item.checked = node.getAttribute('aria-checked') === 'true';
          }
          if (node.disabled || node.getAttribute('aria-disabled') === 'true') item.disabled = true;
          if (node.hasAttribute('aria-expanded')) item.expanded = node.getAttribute('aria-expanded') === 'true';
          if (node.hasAttribute('aria-selected')) item.selected = node.getAttribute('aria-selected') === 'true';
          const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
          if (!inViewport) item.inViewport = false;
          if (frameLabel) item.frame = frameLabel;
          elements.push(item);
        }
        // Traverse open Shadow DOM roots and same-origin iframes
        let all = [];
        try { all = root.querySelectorAll('*'); } catch { return; }
        let scanned = 0;
        for (const el of all) {
          if (index >= maxItems || ++scanned > 4000) break;
          if (el.shadowRoot) {
            collectFromRoot(el.shadowRoot, win, frameLabel, depth + 1);
          }
          if (el.tagName === 'IFRAME') {
            try {
              const childDoc = el.contentDocument;
              const childWin = el.contentWindow;
              if (childDoc && childWin) {
                const subLabel = el.id || el.name || el.getAttribute('title') || 'iframe';
                collectFromRoot(childDoc, childWin, frameLabel ? `${frameLabel}>${subLabel}` : subLabel, depth + 1);
              }
            } catch { /* cross-origin iframe */ }
          }
        }
      };

      collectFromRoot(document, window, '', 0);
      const rawText = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      return {
        title: document.title,
        url: location.href,
        text: rawText.length > maxText ? `${rawText.slice(0, maxText)}\n...[truncated]` : rawText,
        elements,
      };
    }, { maxItems, maxText });
    return {
      ok: true,
      tabId: tab.id,
      shortId: tab.id.slice(0, 8),
      ...(tab.dialog ? { dialog: tab.dialog } : {}),
      ...data,
    };
  }));
}

async function resolveAgentTarget(tab, target, callback) {
  if (typeof target !== 'string' || !target.trim()) throw new InputError('缺少目标选择器或 @eN 引用。');
  const trimmed = target.trim();
  if (/^@e\d+$/.test(trimmed)) {
    let handle = await tab.page.evaluateHandle(ref => window.__dittoAgentRefs?.get(ref) || null, trimmed);
    try {
      let element = handle.asElement();
      if (!element || !await element.evaluate(node => node.isConnected)) {
        throw new InputError(`元素引用 ${trimmed} 已失效，请重新执行 ditto snapshot --tab ${tab.id.slice(0, 8)}。`, 409);
      }
      const ownerFrame = await element.ownerFrame();
      if (ownerFrame && ownerFrame !== tab.page.mainFrame()) {
        await handle.dispose();
        handle = await ownerFrame.evaluateHandle(ref => window.top.__dittoAgentRefs?.get(ref) || null, trimmed);
        element = handle.asElement();
        if (!element) throw new InputError(`iframe 内的元素引用 ${trimmed} 已失效，请重新 snapshot。`, 409);
      }
      return await callback(element);
    } finally {
      await handle.dispose().catch(() => {});
    }
  }
  return callback(tab.page.locator(trimmed).first());
}

export async function runAgentAct(browser, tabId, options = {}) {
  const {
    action, target, value = '', key = 'Enter', timeout = 8000, sessionId = null,
    direction, deltaX, deltaY, files, filePath, text, url, networkIdle,
  } = options;
  await browser.waitReady();
  const tab = browser.resolveTab(tabId, sessionId);
  browser.checkAgentTabAccess(tab);
  const ms = Math.min(Math.max(Number(timeout) || 8000, 500), 30000);
  return browser.runOnTab(tab, () => browser.withAgentActivity(tab, options, action, async () => {
    await browser.waitReady();
    try {
      // Operate directly on this page's CDP target without bringToFront() so concurrent sessions never steal focus.
      if (action === 'click') {
        await resolveAgentTarget(tab, target, loc => loc.click({ timeout: ms }));
      } else if (action === 'hover') {
        await resolveAgentTarget(tab, target, loc => loc.hover({ timeout: ms }));
      } else if (action === 'fill') {
        await resolveAgentTarget(tab, target, loc => loc.fill(String(value), { timeout: ms }));
      } else if (action === 'select') {
        await resolveAgentTarget(tab, target, loc => loc.selectOption(String(value), { timeout: ms }));
      } else if (action === 'type') {
        if (target) await resolveAgentTarget(tab, target, loc => loc.click({ timeout: ms }));
        await tab.page.keyboard.type(String(value));
      } else if (action === 'press') {
        if (target) await resolveAgentTarget(tab, target, loc => loc.press(String(key), { timeout: ms }));
        else await tab.page.keyboard.press(String(key));
      } else if (action === 'scroll') {
        let dx = Number.isFinite(Number(deltaX)) ? Number(deltaX) : 0;
        let dy = Number.isFinite(Number(deltaY)) ? Number(deltaY) : 0;
        const dir = String(direction || '').toLowerCase();
        if (dir === 'up') dy = -Math.abs(dy || 600);
        else if (dir === 'down') dy = Math.abs(dy || 600);
        else if (dir === 'left') dx = -Math.abs(dx || 400);
        else if (dir === 'right') dx = Math.abs(dx || 400);
        if (!dir && !dx && !dy) dy = 600;
        if (target) {
          await resolveAgentTarget(tab, target, el => el.evaluate((node, args) => {
            if (args.dir === 'top') node.scrollTo(0, 0);
            else if (args.dir === 'bottom') node.scrollTo(0, node.scrollHeight);
            else node.scrollBy(args.dx, args.dy);
          }, { dir, dx, dy }));
        } else {
          await tab.page.evaluate(({ dir, dx, dy }) => {
            if (dir === 'top') window.scrollTo(0, 0);
            else if (dir === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
            else window.scrollBy(dx, dy);
          }, { dir, dx, dy });
        }
      } else if (action === 'upload') {
        const rawFiles = Array.isArray(files) ? files : (filePath ? [filePath] : []);
        if (!rawFiles.length || rawFiles.length > 10) throw new InputError('请提供 1–10 个本地文件路径。');
        const resolved = [];
        for (const item of rawFiles) {
          if (typeof item !== 'string' || !item.trim()) throw new InputError('文件路径无效。');
          const abs = path.resolve(item.trim());
          let info;
          try { info = await stat(abs); } catch { throw new InputError(`文件不存在：${abs}`, 404); }
          if (!info.isFile()) throw new InputError(`目标不是普通文件：${abs}`);
          resolved.push(abs);
        }
        await resolveAgentTarget(tab, target, loc => loc.setInputFiles(resolved));
      } else if (action === 'wait') {
        if (networkIdle) {
          await tab.page.waitForLoadState('networkidle', { timeout: ms });
        } else if (typeof text === 'string' && text) {
          await tab.page.getByText(text).first().waitFor({ state: 'visible', timeout: ms });
        } else if (typeof url === 'string' && url) {
          await tab.page.waitForFunction(needle => location.href.includes(needle), url, { timeout: ms });
        } else if (target) {
          await tab.page.locator(String(target)).first().waitFor({ state: 'visible', timeout: ms });
        } else {
          await new Promise(resolve => setTimeout(resolve, Math.min(ms, 10000)));
        }
      } else {
        throw new InputError('不支持的页面操作。');
      }
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError(`页面操作未完成：${error.message?.split('\n')[0] || '元素不可交互或超时'}`, 409);
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!tab.pendingDialog) {
      await browser.refresh(tab);
      await browser.ensureRecorder(tab);
    }
    return {
      ok: true,
      tabId: tab.id,
      shortId: tab.id.slice(0, 8),
      title: tab.title,
      url: tab.page.url(),
      ...(tab.dialog ? { dialog: tab.dialog } : {}),
    };
  }));
}

export async function runAgentEvaluate(browser, tabId, expression, options = {}) {
  const { sessionId = null } = options;
  if (typeof expression !== 'string' || !expression.trim() || expression.length > 50000) {
    throw new InputError('请输入有效的 JavaScript 表达式。');
  }
  await browser.waitReady();
  const tab = browser.resolveTab(tabId, sessionId);
  browser.checkAgentTabAccess(tab);
  return browser.runOnTab(tab, () => browser.withAgentActivity(tab, options, 'eval', async () => {
    try {
      const result = await tab.page.evaluate(async code => {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        try {
          return await (0, eval)(code);
        } catch (err) {
          if (err instanceof SyntaxError) {
            const fn = new AsyncFunction(code);
            return await fn();
          }
          throw err;
        }
      }, expression);
      await browser.refresh(tab);
      return { ok: true, tabId: tab.id, shortId: tab.id.slice(0, 8), title: tab.title, url: tab.page.url(), result: result ?? null };
    } catch (error) {
      throw new InputError(`脚本执行失败：${error.message?.split('\n')[0] || '未知错误'}`, 400);
    }
  }));
}

export async function runAgentScreenshot(browser, tabId, options = {}) {
  const { fullPage = false, sessionId = null } = options;
  await browser.waitReady();
  const tab = browser.resolveTab(tabId, sessionId);
  return browser.runOnTab(tab, () => browser.withAgentActivity(tab, options, 'screenshot',
    () => tab.page.screenshot({ type: 'png', fullPage: Boolean(fullPage) })));
}

export async function runAgentConsole(browser, tabId, options = {}) {
  const { sessionId = null, clear = false, limit = 50 } = options;
  await browser.waitReady();
  const tab = browser.resolveTab(tabId, sessionId);
  const cap = Math.min(Math.max(Number(limit) || 50, 1), MAX_LOG_ENTRIES);
  const entries = (tab.consoleLogs || [])
    .filter(item => item.level !== 'command' && item.level !== 'result')
    .slice(-cap);
  if (clear && tab.consoleLogs) tab.consoleLogs.length = 0;
  return { ok: true, tabId: tab.id, shortId: tab.id.slice(0, 8), count: entries.length, entries };
}

export async function runAgentNetwork(browser, tabId, options = {}) {
  const { sessionId = null, failedOnly = true, clear = false, limit = 50 } = options;
  await browser.waitReady();
  const tab = browser.resolveTab(tabId, sessionId);
  const cap = Math.min(Math.max(Number(limit) || 50, 1), MAX_LOG_ENTRIES);
  const list = tab.networkLogs || [];
  const filtered = failedOnly ? list.filter(item => !item.ok) : list;
  const entries = filtered.slice(-cap);
  if (clear && tab.networkLogs) tab.networkLogs.length = 0;
  return { ok: true, tabId: tab.id, shortId: tab.id.slice(0, 8), failedOnly: Boolean(failedOnly), count: entries.length, entries };
}
