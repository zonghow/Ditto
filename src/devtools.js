import { InputError } from './snapshot.js';

const MAX_EVAL_EXPRESSION = 50000;
const EVAL_TIMEOUT_MS = 10000;

// Serialized into the observed Chromium page via CDP Runtime.callFunctionOn
// (or Playwright handle.evaluate) to convert any live JS value into a safe,
// bounded, cycle-free tree descriptor without using page eval() (CSP-safe) or
// leaking remote handles.
function serializeRemoteValueInPage(target) {
  const rootVal = arguments.length > 0 ? target : this;
  const MAX_DEPTH = 4;
  const MAX_PROPS = 40;
  const MAX_ARRAY = 50;
  const MAX_STRING = 1000;
  const MAX_NODES = 400;
  let nodes = 0;
  const ancestors = new Set();

  const clip = (str, limit = MAX_STRING) => {
    const s = String(str);
    return s.length > limit ? { v: s.slice(0, limit), truncated: true } : { v: s };
  };

  const describeElement = el => {
    try {
      const tag = String(el.tagName || el.nodeName || 'node').toLowerCase();
      const id = el.id ? `#${String(el.id).slice(0, 40)}` : '';
      let cls = '';
      if (typeof el.className === 'string' && el.className.trim()) {
        cls = '.' + el.className.trim().split(/\s+/).slice(0, 3).map(c => c.slice(0, 28)).join('.');
      }
      return `<${tag}${id}${cls}>`;
    } catch {
      return '<element>';
    }
  };

  const shortVal = val => {
    if (val === undefined) return 'undefined';
    if (val === null) return 'null';
    const ty = typeof val;
    if (ty === 'string') return JSON.stringify(val.length > 36 ? `${val.slice(0, 36)}…` : val);
    if (ty === 'number' || ty === 'boolean') return String(val);
    if (ty === 'bigint') return `${val}n`;
    if (ty === 'symbol') return String(val);
    if (ty === 'function') return `ƒ ${val.name || ''}()`;
    if (Array.isArray(val)) return `Array(${val.length})`;
    if (val instanceof Date) return Number.isNaN(val.getTime()) ? 'Invalid Date' : val.toISOString();
    if (val instanceof RegExp) return String(val);
    if (val instanceof Error) return `${val.name || 'Error'}: ${val.message || ''}`.slice(0, 60);
    if (val instanceof Map) return `Map(${val.size})`;
    if (val instanceof Set) return `Set(${val.size})`;
    if (typeof Element !== 'undefined' && val instanceof Element) return describeElement(val);
    try {
      const name = val.constructor?.name;
      return name && name !== 'Object' ? name : '{…}';
    } catch {
      return '{…}';
    }
  };

  const walk = (val, depth) => {
    if (++nodes > MAX_NODES) return { t: 'max', s: '…' };
    if (val === undefined) return { t: 'undefined' };
    if (val === null) return { t: 'null' };
    const ty = typeof val;
    if (ty === 'boolean') return { t: 'boolean', v: val };
    if (ty === 'number') {
      if (Number.isNaN(val)) return { t: 'number', s: 'NaN' };
      if (!Number.isFinite(val)) return { t: 'number', s: val > 0 ? 'Infinity' : '-Infinity' };
      if (Object.is(val, -0)) return { t: 'number', s: '-0' };
      return { t: 'number', v: val };
    }
    if (ty === 'bigint') return { t: 'bigint', s: `${String(val).slice(0, 120)}n` };
    if (ty === 'string') return { t: 'string', ...clip(val) };
    if (ty === 'symbol') return { t: 'symbol', s: String(val).slice(0, 120) };
    if (ty === 'function') {
      const name = typeof val.name === 'string' && val.name ? val.name : 'anonymous';
      return { t: 'function', s: `ƒ ${name}()` };
    }

    if (ancestors.has(val)) return { t: 'ref', s: '[Circular]' };
    if (val instanceof Date) {
      return { t: 'date', s: Number.isNaN(val.getTime()) ? 'Invalid Date' : val.toISOString() };
    }
    if (val instanceof RegExp) return { t: 'regexp', s: String(val).slice(0, 200) };
    if (val instanceof Error) {
      return {
        t: 'error',
        name: String(val.name || 'Error').slice(0, 80),
        message: String(val.message || '').slice(0, 500),
        stack: typeof val.stack === 'string' ? val.stack.split('\n').slice(0, 8).join('\n').slice(0, 1200) : '',
      };
    }
    if (typeof Element !== 'undefined' && val instanceof Element) {
      const text = typeof val.textContent === 'string' ? val.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      return { t: 'element', s: describeElement(val), text };
    }
    if (typeof Node !== 'undefined' && val instanceof Node) {
      return { t: 'element', s: `#${String(val.nodeName || 'node').toLowerCase()}` };
    }

    if (depth >= MAX_DEPTH) return { t: 'max', s: shortVal(val) };
    ancestors.add(val);
    try {
      if (Array.isArray(val)) {
        const len = val.length;
        const limit = Math.min(len, MAX_ARRAY);
        const items = [];
        const previewParts = [];
        for (let i = 0; i < limit; i++) {
          let item;
          try { item = val[i]; } catch { item = '[Unreadable]'; }
          if (i < 5) previewParts.push(shortVal(item));
          items.push(walk(item, depth + 1));
        }
        const preview = len === 0 ? '[]' : `(${len}) [${previewParts.join(', ')}${len > 5 ? ', …' : ''}]`;
        return { t: 'array', len, preview, items, more: Math.max(0, len - limit) };
      }
      if (val instanceof Map) {
        const len = val.size;
        const entries = [];
        const previewParts = [];
        let i = 0;
        for (const [k, v] of val.entries()) {
          if (i < 4) previewParts.push(`${shortVal(k)} => ${shortVal(v)}`);
          if (i >= MAX_PROPS) break;
          entries.push([walk(k, depth + 1), walk(v, depth + 1)]);
          i++;
        }
        return { t: 'map', len, preview: `Map(${len}) {${previewParts.join(', ')}${len > 4 ? ', …' : ''}}`, entries, more: Math.max(0, len - entries.length) };
      }
      if (val instanceof Set) {
        const len = val.size;
        const items = [];
        const previewParts = [];
        let i = 0;
        for (const item of val.values()) {
          if (i < 5) previewParts.push(shortVal(item));
          if (i >= MAX_ARRAY) break;
          items.push(walk(item, depth + 1));
          i++;
        }
        return { t: 'set', len, preview: `Set(${len}) {${previewParts.join(', ')}${len > 5 ? ', …' : ''}}`, items, more: Math.max(0, len - items.length) };
      }
      let cls = 'Object';
      try {
        const name = val.constructor?.name;
        if (typeof name === 'string' && name) cls = name.slice(0, 60);
      } catch {}
      let keys = [];
      try { keys = Object.keys(val); } catch {}
      if (!keys.length) {
        try {
          keys = Object.getOwnPropertyNames(val).filter(k => k !== '__proto__').slice(0, MAX_PROPS);
        } catch {}
      }
      const limit = Math.min(keys.length, MAX_PROPS);
      const entries = [];
      const previewParts = [];
      for (let i = 0; i < limit; i++) {
        const k = keys[i];
        let v;
        try { v = val[k]; } catch { v = '[Getter threw]'; }
        if (i < 5) previewParts.push(`${k}: ${shortVal(v)}`);
        entries.push([String(k).slice(0, 120), walk(v, depth + 1)]);
      }
      const prefix = cls !== 'Object' ? `${cls} ` : '';
      const preview = keys.length === 0 ? `${prefix}{}` : `${prefix}{${previewParts.join(', ')}${keys.length > 5 ? ', …' : ''}}`;
      return { t: 'object', cls, preview, entries, more: Math.max(0, keys.length - limit) };
    } finally {
      ancestors.delete(val);
    }
  };

  return walk(rootVal, 0);
}

const SERIALIZE_FN_SOURCE = serializeRemoteValueInPage.toString();

export function descriptorToSummary(desc) {
  if (!desc || typeof desc !== 'object') return 'undefined';
  switch (desc.t) {
    case 'undefined': return 'undefined';
    case 'null': return 'null';
    case 'boolean': return String(desc.v);
    case 'number': return desc.s !== undefined ? desc.s : String(desc.v);
    case 'bigint': return desc.s || '0n';
    case 'string': return desc.truncated ? `${desc.v}…` : String(desc.v ?? '');
    case 'symbol': return desc.s || 'Symbol()';
    case 'function': return desc.s || 'ƒ ()';
    case 'date': return desc.s || 'Date';
    case 'regexp': return desc.s || '/(?:)/';
    case 'error': return `${desc.name || 'Error'}: ${desc.message || ''}`.trim();
    case 'element': return desc.text ? `${desc.s} ${desc.text}` : (desc.s || '<element>');
    case 'array':
    case 'object':
    case 'map':
    case 'set':
      return desc.preview || desc.cls || desc.t;
    case 'ref':
    case 'max':
      return desc.s || '…';
    default:
      return String(desc.s ?? desc.v ?? '');
  }
}

export function descriptorFromRemotePrimitive(remote) {
  if (!remote || typeof remote !== 'object') return { t: 'undefined' };
  if (remote.type === 'undefined') return { t: 'undefined' };
  if (remote.subtype === 'null' || remote.value === null) return { t: 'null' };
  if (remote.type === 'boolean') return { t: 'boolean', v: Boolean(remote.value) };
  if (remote.type === 'number') {
    if (remote.unserializableValue) return { t: 'number', s: String(remote.unserializableValue) };
    return { t: 'number', v: Number(remote.value) };
  }
  if (remote.type === 'bigint') return { t: 'bigint', s: String(remote.unserializableValue || remote.description || '0n') };
  if (remote.type === 'string') {
    const s = String(remote.value ?? '');
    return s.length > 1000 ? { t: 'string', v: s.slice(0, 1000), truncated: true } : { t: 'string', v: s };
  }
  if (remote.type === 'symbol') return { t: 'symbol', s: String(remote.description || 'Symbol()').slice(0, 120) };
  if (remote.type === 'function') return { t: 'function', s: String(remote.description || 'ƒ ()').split('\n')[0].slice(0, 120) };
  return { t: 'max', s: String(remote.description || remote.className || remote.type || 'Object').slice(0, 200) };
}

export async function inspectJsHandle(handle, timeoutMs = 400) {
  if (!handle || typeof handle.evaluate !== 'function') return null;
  let timer = null;
  try {
    return await Promise.race([
      handle.evaluate(serializeRemoteValueInPage),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function formatCdpException(exceptionDetails) {
  const ex = exceptionDetails?.exception;
  const text = String(
    ex?.description
    || (ex?.value !== undefined ? String(ex.value) : '')
    || exceptionDetails?.text
    || 'Uncaught exception',
  );
  const lines = text.split('\n');
  const message = lines[0].slice(0, 500);
  const stack = lines.length > 1
    ? lines.slice(0, 8).join('\n').slice(0, 1200)
    : (exceptionDetails?.stackTrace?.callFrames || [])
        .slice(0, 6)
        .map(f => `    at ${f.functionName || '(anonymous)'} (${f.url || '<eval>'}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1})`)
        .join('\n')
        .slice(0, 1200);
  return { message, stack };
}

function pushTabConsoleEntry(browser, tab, entry) {
  if (!tab.consoleLogs) tab.consoleLogs = [];
  tab.devtoolsSeq = (tab.devtoolsSeq || 0) + 1;
  const full = { id: tab.devtoolsSeq, time: new Date().toISOString(), ...entry };
  tab.consoleLogs.push(full);
  if (tab.consoleLogs.length > 200) tab.consoleLogs.splice(0, tab.consoleLogs.length - 200);
  browser.emit('devtools', { tabId: tab.id, kind: 'console', entry: full });
  return full;
}

export function devtoolsSnapshot(browser, tabId) {
  const tab = browser.tabs?.get(tabId);
  if (!tab || tab.hidden) {
    return { tabId, console: [], network: [] };
  }
  return {
    tabId: tab.id,
    console: (tab.consoleLogs || []).slice(-200),
    network: (tab.networkLogs || []).slice(-200),
  };
}

export function devtoolsClear(browser, tabId, target = 'all') {
  const tab = browser.tabs?.get(tabId);
  if (!tab || tab.hidden) return false;
  if (target === 'console' || target === 'all') {
    if (tab.consoleLogs) tab.consoleLogs.length = 0;
  }
  if (target === 'network' || target === 'all') {
    if (tab.networkLogs) tab.networkLogs.length = 0;
  }
  browser.emit('devtools-cleared', { tabId: tab.id, target });
  return true;
}

export async function devtoolsEvaluate(browser, tabId, expression) {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new InputError('请输入有效的 JavaScript 表达式。');
  }
  if (expression.length > MAX_EVAL_EXPRESSION) {
    throw new InputError('脚本内容过长（上限 50KB）。');
  }
  await browser.waitReady();
  const tab = browser.tabs?.get(tabId);
  if (!tab || tab.hidden || tab.crashed || tab.page?.isClosed?.()) {
    throw new InputError('目标标签页不可用或已关闭。', 404);
  }
  const code = expression.trim();
  pushTabConsoleEntry(browser, tab, { level: 'command', text: code.slice(0, 2000) });

  let descriptor = null;
  let errorInfo = null;

  if (tab.cdp && typeof tab.cdp.send === 'function') {
    try {
      const res = await tab.cdp.send('Runtime.evaluate', {
        expression: code,
        includeCommandLineAPI: true,
        awaitPromise: true,
        replMode: true,
        returnByValue: false,
        userGesture: true,
        timeout: EVAL_TIMEOUT_MS,
      });
      if (res?.exceptionDetails) {
        errorInfo = formatCdpException(res.exceptionDetails);
      } else if (res?.result?.objectId) {
        const objectId = res.result.objectId;
        try {
          const serialized = await tab.cdp.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: SERIALIZE_FN_SOURCE,
            returnByValue: true,
            silent: true,
          });
          descriptor = serialized?.result?.value ?? descriptorFromRemotePrimitive(res.result);
        } catch {
          descriptor = descriptorFromRemotePrimitive(res.result);
        } finally {
          tab.cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
        }
      } else {
        descriptor = descriptorFromRemotePrimitive(res?.result);
      }
    } catch (error) {
      errorInfo = {
        message: String(error?.message || '脚本执行失败').split('\n')[0].slice(0, 500),
        stack: '',
      };
    }
  } else {
    try {
      descriptor = await tab.page.evaluate(async ({ src, fnSrc }) => {
        const serialize = (0, eval)(`(${fnSrc})`);
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        let value;
        try {
          value = await (0, eval)(src);
        } catch (err) {
          if (err instanceof SyntaxError) {
            const fn = new AsyncFunction(src);
            value = await fn();
          } else {
            throw err;
          }
        }
        return serialize.call(value);
      }, { src: code, fnSrc: SERIALIZE_FN_SOURCE });
    } catch (error) {
      errorInfo = {
        message: String(error?.message || '脚本执行失败').split('\n')[0].slice(0, 500),
        stack: '',
      };
    }
  }

  if (errorInfo) {
    const entry = pushTabConsoleEntry(browser, tab, {
      level: 'error',
      text: errorInfo.message,
      stack: errorInfo.stack || undefined,
      fromEval: true,
    });
    return { ok: false, tabId: tab.id, error: errorInfo.message, stack: errorInfo.stack || '', entry };
  }

  const entry = pushTabConsoleEntry(browser, tab, {
    level: 'result',
    text: descriptorToSummary(descriptor),
    value: descriptor,
  });
  browser.refresh?.(tab).catch(() => {});
  return { ok: true, tabId: tab.id, entry };
}
