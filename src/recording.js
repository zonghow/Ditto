import { normalizeDocumentUrl, rrwebFragmentBaseUrl } from './assets.js';

export const MAX_RECORDING_BYTES = 12 * 1024 * 1024;
export const MAX_RECORDING_EVENTS = 2000;
export const EXTERNAL_STYLE_THRESHOLD = 32 * 1024;
export const EXTERNAL_STYLE_OVERFLOW_BUDGET = 256 * 1024;
export const EXTERNAL_STYLE_OVERFLOW_THRESHOLD = 4 * 1024;
export const REPLAY_CSP = "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const INERT_TAGS = new Set(['script', 'noscript', 'object', 'embed', 'base', 'audio', 'source', 'track', 'foreignobject', 'animate', 'animatetransform', 'animatemotion', 'set']);

function firstSrcsetCandidate(srcset) {
  if (typeof srcset !== 'string') return '';
  const trimmed = srcset.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('data:')) {
    const match = /^(data:[^\s]+?)(?:,\s+|\s+|$)/.exec(trimmed);
    return match ? match[1] : '';
  }
  return trimmed.split(/\s+/)[0]?.replace(/,+$/, '') || '';
}

function isCrossOriginHttpUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || !base) return false;
  try {
    const baseUrl = new URL(base);
    if (!['http:', 'https:'].includes(baseUrl.protocol)) return false;
    const target = new URL(value, baseUrl);
    return ['http:', 'https:'].includes(target.protocol) && target.origin !== baseUrl.origin;
  } catch {
    return false;
  }
}

export class RecordingSanitizer {
  nodes = new Map();
  styles = new Set();
  externalizedStyles = new Set();
  externalizedStyleChildren = new Map();
  inlineStyleTextChildren = new Map();
  inlineStyleBytes = 0;
  documentUrls = new Set();
  securityId = 1_000_000_000;

  constructor(assets, scope, base) {
    this.assets = assets;
    this.scope = scope;
    this.base = base;
    this.rememberDocumentUrl(base);
  }

  rememberDocumentUrl(href) {
    const normalized = normalizeDocumentUrl(href);
    if (!normalized) return;
    this.base = normalized;
    if (this.documentUrls.size < 128) {
      this.documentUrls.add(normalized);
      const parentDir = rrwebFragmentBaseUrl(normalized);
      if (parentDir) this.documentUrls.add(parentDir);
    }
  }

  attributes(attributes, tag = '', isMutation = false) {
    const clean = {};
    const rawHref = attributes?.href ?? attributes?.HREF;
    const cssBase = tag === 'link' && typeof rawHref === 'string'
      ? (normalizeDocumentUrl(rawHref, this.base) || this.base)
      : this.base;
    for (const [name, value] of Object.entries(attributes || {})) {
      const key = name.toLowerCase();
      if (tag === 'iframe' && (key === 'src' || key === 'rr_src')) {
        if (isCrossOriginHttpUrl(value, this.base)) clean['data-ditto-xorigin'] = '1';
        else if (isMutation) clean['data-ditto-xorigin'] = null;
        continue;
      }
      if (/^on/.test(key) || key.startsWith('rr_media') || ['srcdoc', 'srcset', 'rr_src', 'ping', 'action', 'formaction', 'target', 'integrity', 'nonce', 'autofocus', 'autoplay', 'http-equiv', 'content', 'sandbox', 'download', 'data-ditto-xorigin'].includes(key)) continue;
      if (tag === 'video' && ['controls', 'loop', 'muted', 'preload', 'playsinline', 'webkit-playsinline', 'crossorigin', 'disablepictureinpicture', 'controlslist'].includes(key)) continue;
      if (key === 'poster') {
        if (tag === 'video') clean[name] = this.assets.reference(this.scope, value, this.base, true, this.documentUrls);
        continue;
      }
      if (key === 'style' && value && typeof value === 'object') {
        clean[name] = Object.fromEntries(Object.entries(value).map(([property, data]) => [property,
          Array.isArray(data) ? [this.assets.css(this.scope, data[0], this.base, this.documentUrls), data[1]]
            : data === false ? false : this.assets.css(this.scope, data, this.base, this.documentUrls)]));
      } else if (key === 'style' || key === '_csstext') {
        clean[name] = this.assets.css(this.scope, value, key === '_csstext' ? cssBase : this.base, this.documentUrls);
      } else if (['src', 'href', 'xlink:href', 'background', 'rr_dataurl'].includes(key)) {
        // Anchors, frames, and media elements stay inert locally; video frames stream as snapshots.
        if (['a', 'area', 'iframe', 'base', 'video', 'audio'].includes(tag)) continue;
        if (tag === 'link' && key === 'href') clean[name] = this.assets.reference(this.scope, value, this.base, false, this.documentUrls);
        else if (key !== 'href' || ['use', 'image', 'feimage'].includes(tag) || !tag) {
          const isImage = key === 'src' || key === 'rr_dataurl' || key === 'background' || tag === 'image' || tag === 'feimage';
          clean[name] = this.assets.reference(this.scope, value, this.base, isImage, this.documentUrls);
        }
      } else if (key === 'value' && tag === 'input' && ['password', 'hidden', 'file'].includes(String(attributes.type).toLowerCase())) {
        clean[name] = '';
      } else if (!['__proto__', 'constructor', 'prototype'].includes(key)) clean[name] = value;
    }
    if (tag === 'img' && !clean.src && typeof attributes?.srcset === 'string') {
      const candidate = firstSrcsetCandidate(attributes.srcset);
      if (candidate) clean.src = this.assets.reference(this.scope, candidate, this.base, true, this.documentUrls);
    }
    if (tag === 'iframe') clean.sandbox = 'allow-same-origin';
    return clean;
  }

  styleExternalizeThreshold() {
    return this.inlineStyleBytes >= EXTERNAL_STYLE_OVERFLOW_BUDGET
      ? EXTERNAL_STYLE_OVERFLOW_THRESHOLD
      : EXTERNAL_STYLE_THRESHOLD;
  }

  externalizeStyleNode(node, countInline = true) {
    if (typeof this.assets?.putInlineCss !== 'function') return null;
    const rawType = node.attributes?.type ?? node.attributes?.TYPE;
    if (typeof rawType === 'string' && rawType.trim() && !/^text\/css\b/i.test(rawType.trim())) return null;
    const hasCssText = typeof node.attributes?._cssText === 'string' && node.attributes._cssText.length > 0;
    const children = Array.isArray(node.childNodes) ? node.childNodes : [];
    const textChildrenOnly = children.length > 0 && children.every(c => c && c.type === 3 && typeof c.textContent === 'string');
    if (!hasCssText && !textChildrenOnly) return null;
    const rawCss = hasCssText ? node.attributes._cssText : children.map(c => c.textContent).join('');
    const cssBytes = Buffer.byteLength(rawCss, 'utf8');
    if (cssBytes < this.styleExternalizeThreshold()) {
      if (countInline) this.inlineStyleBytes += cssBytes;
      return null;
    }
    const href = this.assets.putInlineCss(this.scope, rawCss, this.base, this.documentUrls);
    if (!href) {
      if (countInline) this.inlineStyleBytes += cssBytes;
      return null;
    }
    this.externalizedStyles.add(node.id);
    for (const child of children) {
      if (Number.isInteger(child.id)) {
        this.nodes.set(child.id, '');
        this.styles.add(child.id);
        this.externalizedStyleChildren.set(child.id, node.id);
      }
    }
    const attrs = { ...(node.attributes || {}) };
    delete attrs._cssText;
    delete attrs._CSSTEXT;
    const clean = this.attributes(attrs, 'style');
    clean.rel = 'stylesheet';
    clean.href = href;
    node.tagName = 'link';
    node.attributes = clean;
    node.childNodes = [];
    return node;
  }

  node(input, budget, depth = 0) {
    if (!input || typeof input !== 'object' || !Number.isInteger(input.id) || depth > 200 || ++budget.count > 100000) throw new Error('Recording document exceeds the safe replay budget.');
    const node = { ...input };
    const tag = String(node.tagName || '').toLowerCase();
    this.nodes.set(node.id, tag);
    if (node.isStyle || tag === 'style') this.styles.add(node.id);
    if (INERT_TAGS.has(tag)) {
      node.tagName = tag === 'foreignobject' ? 'g' : 'noscript';
      node.attributes = {};
      node.childNodes = [];
      return node;
    }
    if (node.type === 2 && tag === 'style') {
      const externalized = this.externalizeStyleNode(node);
      if (externalized) return externalized;
      const textKids = new Set();
      for (const child of node.childNodes || []) {
        if (child?.type === 3 && Number.isInteger(child.id)) textKids.add(child.id);
      }
      this.inlineStyleTextChildren.set(node.id, textKids);
    }
    if (node.type === 2) node.attributes = this.attributes(node.attributes, tag);
    if (node.type === 3 && node.isStyle) node.textContent = this.assets.css(this.scope, node.textContent, this.base, this.documentUrls);
    if (node.childNodes) node.childNodes = node.childNodes.map(child => this.node(child, budget, depth + 1));
    if (tag === 'head') {
      node.childNodes.unshift({ type: 2, id: ++this.securityId, tagName: 'meta',
        // rrweb deliberately neutralizes an original page's title-cased CSP.
        // Lowercase is still a real CSP in HTML, and keeps OUR restrictive
        // replay policy active before any reconstructed resource nodes load.
        attributes: { 'http-equiv': 'content-security-policy', content: REPLAY_CSP }, childNodes: [] });
    }
    return node;
  }

  event(input) {
    if (!input || !Number.isFinite(input.timestamp) || !Number.isInteger(input.type)) return null;
    const event = { type: input.type, timestamp: input.timestamp, data: input.data };
    const data = event.data;
    if ([0, 1].includes(event.type)) return null;
    if (event.type === 4) {
      if (!data || !Number.isFinite(data.width) || !Number.isFinite(data.height)) return null;
      if (typeof data.href === 'string') this.rememberDocumentUrl(data.href);
      return { ...event, data: { href: 'about:blank', width: Math.min(16384, Math.max(1, data.width)), height: Math.min(16384, Math.max(1, data.height)) } };
    }
    if (event.type === 2) {
      this.nodes.clear();
      this.styles.clear();
      this.externalizedStyles.clear();
      this.externalizedStyleChildren.clear();
      this.inlineStyleTextChildren.clear();
      this.inlineStyleBytes = 0;
      return { ...event, data: { node: this.node(data.node, { count: 0 }), initialOffset: data.initialOffset } };
    }
    if (event.type === 5) {
      if (data?.tag === 'ditto-focus' && Number.isInteger(data.payload?.id)) {
        return { ...event, data: { tag: data.tag, payload: { id: data.payload.id } } };
      }
      if (data?.tag === 'ditto-input-selection' && Number.isInteger(data.payload?.id)
        && Number.isInteger(data.payload?.start) && Number.isInteger(data.payload?.end)
        && data.payload.start >= 0 && data.payload.end >= 0) {
        return {
          ...event,
          data: {
            tag: data.tag,
            payload: { id: data.payload.id, start: data.payload.start, end: data.payload.end },
          },
        };
      }
      if ((data?.tag === 'ditto-canvas' || data?.tag === 'ditto-video') && Number.isInteger(data.payload?.id) &&
        typeof data.payload?.dataUrl === 'string' && data.payload.dataUrl.length <= 1024 * 1024 &&
        /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(data.payload.dataUrl)) {
        const width = Number.isFinite(data.payload.width) ? Math.min(8192, Math.max(1, Math.round(data.payload.width))) : null;
        const height = Number.isFinite(data.payload.height) ? Math.min(8192, Math.max(1, Math.round(data.payload.height))) : null;
        return { ...event, data: { tag: data.tag, payload: { id: data.payload.id, width, height, dataUrl: data.payload.dataUrl } } };
      }
      if (data?.tag === 'ditto-xorigin' && data.payload && typeof data.payload === 'object') {
        const count = Number.isFinite(data.payload.count) ? Math.min(100, Math.max(0, Math.round(data.payload.count))) : 0;
        return { ...event, data: { tag: data.tag, payload: { visible: Boolean(data.payload.visible), dominant: Boolean(data.payload.dominant), count } } };
      }
      return null;
    }
    if (event.type !== 3 || !data || !Number.isInteger(data.source)) return null;
    // Never replay canvas commands, fonts containing code/plugin data, logs,
    // network plugins, or arbitrary custom payloads from the analyzed page.
    if (![0, 1, 2, 3, 4, 5, 6, 8, 12, 13, 14, 15, 16].includes(data.source)) return null;
    event.data = { ...data };
    if (data.source === 0) {
      const rawAdds = data.adds || [];
      // rrweb MutationBuffer flattens newly inserted <style> elements and their
      // text child nodes into separate entries in the same adds array. Group
      // those paired text children back onto the <style> before sanitization so
      // large dynamic style-loader sheets are externalized to <link> immediately.
      const pendingEmptyStyles = new Map();
      for (const add of rawAdds) {
        const n = add?.node;
        if (n?.type === 2 && String(n.tagName || '').toLowerCase() === 'style' && Number.isInteger(n.id) && !(n.childNodes?.length)) {
          pendingEmptyStyles.set(n.id, []);
        }
      }
      const pairedChildAdds = new Set();
      if (pendingEmptyStyles.size) {
        for (const add of rawAdds) {
          const list = pendingEmptyStyles.get(add?.parentId);
          if (list && add.node?.type === 3 && typeof add.node.textContent === 'string') {
            list.push(add);
          } else if (list) {
            pendingEmptyStyles.delete(add.parentId);
          }
        }
      }
      const extraAttributes = [];
      const addedStyleParents = new Set();
      const adds = [];
      for (const add of rawAdds) {
        if (pairedChildAdds.has(add)) continue;
        if (this.externalizedStyles.has(add.parentId) && add.node?.type === 3 && typeof add.node.textContent === 'string') {
          if (Number.isInteger(add.node.id)) {
            this.nodes.set(add.node.id, '');
            this.styles.add(add.node.id);
            this.externalizedStyleChildren.set(add.node.id, add.parentId);
          }
          addedStyleParents.add(add.parentId);
          const href = this.assets?.putInlineCss?.(this.scope, add.node.textContent, this.base, this.documentUrls) || '';
          extraAttributes.push({ id: add.parentId, attributes: { href } });
          continue;
        }
        const paired = Number.isInteger(add?.node?.id) ? pendingEmptyStyles.get(add.node.id) : null;
        if (paired?.length) {
          const combined = { ...add.node, childNodes: paired.map(entry => entry.node) };
          const externalized = this.externalizeStyleNode(combined, false);
          if (externalized) {
            this.nodes.set(externalized.id, 'style');
            this.styles.add(externalized.id);
            for (const entry of paired) pairedChildAdds.add(entry);
            adds.push({ ...add, node: externalized });
            continue;
          }
        }
        if (this.nodes.get(add.parentId) === 'style' && !this.externalizedStyles.has(add.parentId)
          && add.node?.type === 3 && typeof add.node.textContent === 'string') {
          const textKids = this.inlineStyleTextChildren.get(add.parentId) || new Set();
          const cssBytes = Buffer.byteLength(add.node.textContent, 'utf8');
          if (textKids.size === 0 && cssBytes >= this.styleExternalizeThreshold() && typeof this.assets?.putInlineCss === 'function') {
            const href = this.assets.putInlineCss(this.scope, add.node.textContent, this.base, this.documentUrls);
            if (href) {
              const stub = { ...add.node, isStyle: true, textContent: `@import url("${href}");` };
              this.nodes.set(stub.id, '');
              this.styles.add(stub.id);
              textKids.add(stub.id);
              this.inlineStyleTextChildren.set(add.parentId, textKids);
              adds.push({ ...add, node: stub });
              continue;
            }
          }
          this.inlineStyleBytes += cssBytes;
          if (Number.isInteger(add.node.id)) {
            textKids.add(add.node.id);
            this.inlineStyleTextChildren.set(add.parentId, textKids);
          }
        }
        adds.push({ ...add, node: this.node(add.node, { count: 0 }) });
      }
      const removes = [];
      for (const rem of data.removes || []) {
        if (this.externalizedStyles.has(rem.parentId)) {
          this.externalizedStyleChildren.delete(rem.id);
          if (!addedStyleParents.has(rem.parentId)) {
            extraAttributes.push({ id: rem.parentId, attributes: { href: '' } });
          }
          continue;
        }
        if (this.externalizedStyles.has(rem.id)) {
          this.externalizedStyles.delete(rem.id);
          for (const [childId, parentId] of this.externalizedStyleChildren) {
            if (parentId === rem.id) this.externalizedStyleChildren.delete(childId);
          }
        }
        this.inlineStyleTextChildren.get(rem.parentId)?.delete(rem.id);
        this.inlineStyleTextChildren.delete(rem.id);
        removes.push(rem);
      }
      const attributes = [];
      for (const item of data.attributes || []) {
        if (this.externalizedStyles.has(item.id) && item.attributes && ('_cssText' in item.attributes || '_csstext' in item.attributes)) {
          const copy = { ...item.attributes };
          const rawCss = copy._cssText ?? copy._csstext;
          delete copy._cssText;
          delete copy._csstext;
          const clean = this.attributes(copy, 'style', true);
          clean.href = typeof rawCss === 'string' && rawCss
            ? (this.assets?.putInlineCss?.(this.scope, rawCss, this.base, this.documentUrls) || '')
            : '';
          attributes.push({ ...item, attributes: clean });
          continue;
        }
        attributes.push({ ...item, attributes: this.attributes(item.attributes, this.nodes.get(item.id), true) });
      }
      const texts = [];
      for (const item of data.texts || []) {
        const parentStyleId = this.externalizedStyleChildren.get(item.id);
        if (parentStyleId !== undefined) {
          const href = typeof item.value === 'string' && item.value
            ? (this.assets?.putInlineCss?.(this.scope, item.value, this.base, this.documentUrls) || '')
            : '';
          extraAttributes.push({ id: parentStyleId, attributes: { href } });
          continue;
        }
        let value = item.value;
        if (this.styles.has(item.id) && typeof value === 'string') {
          const cssBytes = Buffer.byteLength(value, 'utf8');
          let soleTextChild = false;
          for (const kids of this.inlineStyleTextChildren.values()) {
            if (kids.has(item.id)) { soleTextChild = kids.size === 1; break; }
          }
          if (soleTextChild && cssBytes >= this.styleExternalizeThreshold() && typeof this.assets?.putInlineCss === 'function') {
            const href = this.assets.putInlineCss(this.scope, value, this.base, this.documentUrls);
            value = href ? `@import url("${href}");` : this.assets.css(this.scope, value, this.base, this.documentUrls);
          } else {
            value = this.assets.css(this.scope, value, this.base, this.documentUrls);
          }
        }
        texts.push({ ...item, value });
      }
      event.data.adds = adds;
      if (data.removes) event.data.removes = removes;
      event.data.attributes = [...attributes, ...extraAttributes];
      event.data.texts = texts;
    } else if (data.source === 8) {
      event.data.adds = (data.adds || []).map(add => ({ ...add, rule: this.assets.css(this.scope, add.rule, this.base, this.documentUrls) }));
      if (data.replace) event.data.replace = this.assets.css(this.scope, data.replace, this.base, this.documentUrls);
      if (data.replaceSync) event.data.replaceSync = this.assets.css(this.scope, data.replaceSync, this.base, this.documentUrls);
    } else if (data.source === 13 && data.set) {
      event.data.set = { ...data.set, value: this.assets.css(this.scope, data.set.value, this.base, this.documentUrls) };
    } else if (data.source === 15 && data.styles) {
      event.data.styles = data.styles.map(style => ({ ...style, rules: style.rules?.map(rule => ({ ...rule,
        rule: this.assets.css(this.scope, rule.rule, this.base, this.documentUrls) })) }));
    }
    return event;
  }
}

export const PRE_SERIALIZED_EVENTS = Symbol('preSerializedEvents');

export function attachPreSerialized(message, eventJsons) {
  Object.defineProperty(message, PRE_SERIALIZED_EVENTS, {
    value: eventJsons,
    enumerable: false,
    configurable: true,
  });
  return message;
}

export function serializeRecordingMessage(message) {
  const eventJsons = message?.[PRE_SERIALIZED_EVENTS];
  if (!Array.isArray(eventJsons) || eventJsons.length !== message?.events?.length) {
    return JSON.stringify(message);
  }
  return `{"type":${JSON.stringify(message.type)},"tabId":${JSON.stringify(message.tabId)},"documentId":${JSON.stringify(message.documentId)},"firstSequence":${message.firstSequence},"lastSequence":${message.lastSequence},"serverTime":${message.serverTime},"events":[${eventJsons.join(',')}]}`;
}

// A live checkpoint, not an unbounded archive. Sequence numbers make dropped
// packets observable; reconnect/resume starts with a complete latest checkpoint.
export class RecordingBuffer {
  events = [];
  eventJsons = [];
  eventSizes = [];
  bytes = 0;
  sequence = 0;
  firstSequence = 0;
  meta = null;
  needsCheckpoint = false;

  constructor(tabId, documentId) {
    this.tabId = tabId;
    this.documentId = documentId;
  }

  append(event) {
    if (!event) return null;
    if (event.type === 4) { this.meta = event; return null; }
    const rawJson = JSON.stringify(event);
    const size = Buffer.byteLength(rawJson);
    if (size > MAX_RECORDING_BYTES) { this.needsCheckpoint = true; return null; }
    if (event.type === 2) {
      if (!this.meta) return null;
      const meta = { ...this.meta, timestamp: event.timestamp - 1 };
      const metaJson = JSON.stringify(meta);
      const metaSize = Buffer.byteLength(metaJson);
      this.events = [meta, event];
      this.eventJsons = [metaJson, rawJson];
      this.eventSizes = [metaSize, size];
      this.bytes = size + metaSize;
      this.firstSequence = ++this.sequence;
      this.sequence++;
      this.needsCheckpoint = false;
      return this.snapshot();
    }
    if (!this.events.length || this.needsCheckpoint) return null;
    if (event.type === 5 && (event.data?.tag === 'ditto-canvas' || event.data?.tag === 'ditto-video' || event.data?.tag === 'ditto-xorigin')) {
      const targetTag = event.data.tag;
      const targetId = event.data.payload.id;
      for (let i = this.events.length - 1; i >= 0; i--) {
        const existing = this.events[i];
        if (existing.type === 5 && existing.data?.tag === targetTag && (targetTag === 'ditto-xorigin' || existing.data.payload?.id === targetId)) {
          this.bytes = Math.max(0, this.bytes - (this.eventSizes[i] || 0));
          this.events.splice(i, 1);
          this.eventJsons.splice(i, 1);
          this.eventSizes.splice(i, 1);
        }
      }
    }
    if (this.bytes + size > MAX_RECORDING_BYTES || this.events.length >= MAX_RECORDING_EVENTS) {
      this.needsCheckpoint = true;
      return null;
    }
    this.events.push(event);
    this.eventJsons.push(rawJson);
    this.eventSizes.push(size);
    this.bytes += size;
    this.sequence++;
    return attachPreSerialized({
      type: 'rrweb-events', tabId: this.tabId, documentId: this.documentId,
      firstSequence: this.sequence, lastSequence: this.sequence, serverTime: Date.now(), events: [event],
    }, [rawJson]);
  }

  snapshot() {
    if (!this.events.length) return null;
    return attachPreSerialized({
      type: 'rrweb-snapshot', tabId: this.tabId, documentId: this.documentId,
      firstSequence: this.firstSequence, lastSequence: this.sequence, serverTime: Date.now(), events: this.events,
    }, this.eventJsons.slice());
  }
}
