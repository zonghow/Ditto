import { normalizeDocumentUrl, rrwebFragmentBaseUrl } from './assets.js';

export const MAX_RECORDING_BYTES = 8 * 1024 * 1024;
export const MAX_RECORDING_EVENTS = 2000;
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
      return { ...event, data: { node: this.node(data.node, { count: 0 }), initialOffset: data.initialOffset } };
    }
    if (event.type === 5) {
      if (data?.tag === 'ditto-focus' && Number.isInteger(data.payload?.id)) {
        return { ...event, data: { tag: data.tag, payload: { id: data.payload.id } } };
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
      event.data.adds = (data.adds || []).map(add => ({ ...add, node: this.node(add.node, { count: 0 }) }));
      event.data.attributes = (data.attributes || []).map(item => ({ ...item,
        attributes: this.attributes(item.attributes, this.nodes.get(item.id), true) }));
      event.data.texts = (data.texts || []).map(item => ({ ...item,
        value: this.styles.has(item.id) ? this.assets.css(this.scope, item.value, this.base, this.documentUrls) : item.value }));
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
