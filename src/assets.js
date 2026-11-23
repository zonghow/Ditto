import { randomBytes } from 'node:crypto';

export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_REFERENCES = 8192;
const EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

function cssUnescape(value) {
  return value.replace(/\\([\da-f]{1,6})\s?|\\(.)/gi, (_, hex, character) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : character);
}

export function normalizeDocumentUrl(raw, base) {
  if (typeof raw !== 'string' || !raw) return '';
  try {
    const parsed = new URL(raw, base || undefined);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

export function rrwebFragmentBaseUrl(raw, base) {
  const normalized = normalizeDocumentUrl(raw, base);
  if (!normalized) return '';
  try {
    return new URL('.', normalized).href;
  } catch {
    return '';
  }
}

function decodeNumericEntities(text) {
  return text.replace(/&#x([\da-f]+);?|&#(\d+);?/gi, (_, hex, dec) => {
    const code = parseInt(hex || dec, hex ? 16 : 10);
    return Number.isFinite(code) ? String.fromCodePoint(Math.min(code, 0x10ffff) || 0xfffd) : '';
  });
}

function isSafeSvgDataUrl(value) {
  if (value.length >= MAX_ASSET_BYTES) return false;
  const match = /^data:image\/svg\+xml((?:;(?:charset=[\w-]+|utf-?8|base64))*),(.*)$/is.exec(value);
  if (!match) return false;
  const params = match[1].toLowerCase();
  const payload = match[2];
  let decoded = payload;
  if (params.includes(';base64')) {
    if (!/^[a-z0-9+/=\s]*$/i.test(payload)) return false;
    try {
      decoded = Buffer.from(payload, 'base64').toString('utf8');
    } catch {
      return false;
    }
  } else {
    decoded = payload.replace(/(?:%[\da-f]{2})+/gi, chunk => {
      try { return decodeURIComponent(chunk); } catch { return chunk; }
    });
  }
  const withoutEmbeddedRaster = decoded.replace(/data:image\/(?:png|gif|jpe?g|webp|avif);base64,[a-z0-9+/=\s]+/gi, '');
  const normalized = decodeNumericEntities(withoutEmbeddedRaster).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]+/g, '');
  if (!/<\s*svg[\s>]/i.test(normalized)) return false;
  if (/<\s*(?:script|foreignobject|iframe|object|embed)\b|(?:^|[\s"'/])on[a-z]+\s*=|j[\s\x00-\x1f]*a[\s\x00-\x1f]*v[\s\x00-\x1f]*a[\s\x00-\x1f]*s[\s\x00-\x1f]*c[\s\x00-\x1f]*r[\s\x00-\x1f]*i[\s\x00-\x1f]*p[\s\x00-\x1f]*t\s*:/i.test(normalized)) {
    return false;
  }
  return true;
}

function isSafeDataAsset(value, { allowSvg = false, allowFont = false } = {}) {
  if (typeof value !== 'string' || value.length >= MAX_ASSET_BYTES) return false;
  if (/^data:image\/(?:png|gif|jpe?g|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\s]+$/i.test(value)) {
    return true;
  }
  if (allowFont && /^data:(?:font\/(?:woff2?|ttf|otf|sfnt)|application\/(?:font-woff2?|font-sfnt|x-font-(?:woff2?|ttf|otf|truetype|opentype)|vnd\.ms-fontobject));base64,[a-z0-9+/=\s]+$/i.test(value)) {
    return true;
  }
  if (allowSvg && isSafeSvgDataUrl(value)) {
    return true;
  }
  return false;
}

function sniffBinaryAssetType(body) {
  if (!Buffer.isBuffer(body) || body.length < 4) return '';
  if (body.length >= 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return 'image/png';
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body.length >= 6 && (body.subarray(0, 6).equals(Buffer.from('GIF87a')) || body.subarray(0, 6).equals(Buffer.from('GIF89a')))) return 'image/gif';
  if (body.length >= 12 && body.subarray(0, 4).equals(Buffer.from('RIFF')) && body.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'image/webp';
  if (body[0] === 0x00 && body[1] === 0x00 && body[2] === 0x01 && body[3] === 0x00) return 'image/x-icon';
  if (body.subarray(0, 4).equals(Buffer.from('wOFF'))) return 'font/woff';
  if (body.subarray(0, 4).equals(Buffer.from('wOF2'))) return 'font/woff2';
  const head = body.subarray(0, 256).toString('utf8').trimStart();
  if (/^(?:<\?xml[\s\S]{0,160})?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return '';
}

// Resources come only from responses/cache of the observed page. A replay URL
// never causes a new authenticated request, and is not a general-purpose proxy.
export class AssetCache {
  entries = new Map();
  references = new Map();
  scopeGenerations = new Map();
  requestedMissing = new Set();
  bytes = 0;

  constructor(onReady = () => {}) { this.onReady = onReady; }

  currentGeneration(scope) {
    return this.scopeGenerations.get(scope) || 0;
  }

  // Called when a tab navigates to a new document. Keep the current and
  // immediately preceding generation so in-flight responses are preserved while
  // long-lived tabs never exhaust MAX_REFERENCES.
  advanceScope(scope) {
    const next = this.currentGeneration(scope) + 1;
    this.scopeGenerations.set(scope, next);
    const minKeep = next - 1;
    for (const [id, entry] of this.entries) {
      if (entry.scope !== scope || entry.generation >= minKeep) continue;
      this.bytes -= entry.bytes;
      this.entries.delete(id);
      this.references.delete(entry.key);
      this.requestedMissing.delete(id);
    }
    return next;
  }

  touch(id, entry) {
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  markMissing(id) {
    if (this.entries.has(id)) this.requestedMissing.add(id);
  }

  reference(scope, value, base, image = false, documentUrls = null) {
    if (typeof value !== 'string') return image ? EMPTY_IMAGE : '';
    const trimmed = value.trim();
    if (!trimmed) return image ? EMPTY_IMAGE : '';
    if (trimmed.startsWith('#')) return trimmed.length <= 1024 ? trimmed : (image ? EMPTY_IMAGE : '');
    if (trimmed.startsWith('data:')) {
      return isSafeDataAsset(trimmed, { allowSvg: image, allowFont: !image }) ? trimmed : (image ? EMPTY_IMAGE : '');
    }
    if (trimmed.length > 16384) return image ? EMPTY_IMAGE : '';
    let url;
    try { url = new URL(cssUnescape(trimmed), base || undefined); } catch { return image ? EMPTY_IMAGE : ''; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return image ? EMPTY_IMAGE : '';
    const fragment = url.hash;
    url.hash = '';
    if (fragment && !image && (
      url.href === normalizeDocumentUrl(base) ||
      url.href === rrwebFragmentBaseUrl(base) ||
      documentUrls?.has(url.href)
    )) {
      return fragment;
    }
    const key = `${scope}\n${url.href}`;
    const generation = this.currentGeneration(scope);
    let id = this.references.get(key);
    if (!id) {
      if (this.references.size >= MAX_REFERENCES) {
        // Evict the oldest entry with lowest generation rather than silently failing forever.
        const oldest = this.entries.values().next().value;
        if (oldest) {
          this.bytes -= oldest.bytes;
          this.entries.delete(oldest.id);
          this.references.delete(oldest.key);
          this.requestedMissing.delete(oldest.id);
        } else {
          return image ? EMPTY_IMAGE : '';
        }
      }
      id = randomBytes(18).toString('hex');
      this.references.set(key, id);
      this.entries.set(id, { id, key, scope, generation, bytes: 0, body: null, contentType: null, referenced: true });
    } else {
      const existing = this.entries.get(id);
      if (existing) {
        existing.generation = generation;
        existing.referenced = true;
      }
    }
    return `/api/assets/${id}${fragment}`;
  }

  css(scope, text, base, documentUrls = null) {
    if (typeof text !== 'string') return '';
    // CSP and the script-free sandbox are the final boundary, including for CSS
    // escape/syntax cases not understood by this lightweight URL rewriter.
    return text.replace(/@import\s+(["'])(.*?)\1/gi,
      (_, quote, url) => `@import url("${this.reference(scope, url, base, false, documentUrls)}")`)
      .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
        (_, double, single, bare) => {
          const value = (double ?? single ?? bare ?? '').trim();
          if (value.startsWith('/api/assets/')) {
            return `url("${value.replace(/["\r\n]/g, '')}")`;
          }
          if (value.startsWith('data:')) {
            if (!isSafeDataAsset(value, { allowSvg: true, allowFont: true })) return 'url("")';
            return `url("${value.replace(/"/g, '%22').replace(/[\r\n]/g, '')}")`;
          }
          return `url("${this.reference(scope, value, base, false, documentUrls).replace(/"/g, '')}")`;
        });
  }

  put(scope, url, contentType, body) {
    if (!Buffer.isBuffer(body) || body.length > MAX_ASSET_BYTES) return false;
    let type = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (!type || type === 'application/octet-stream' || type === 'binary/octet-stream') {
      type = sniffBinaryAssetType(body);
    } else if (type === 'image/jpg') {
      type = 'image/jpeg';
    } else if (type === 'image/ico' || type === 'image/icon' || type === 'text/ico') {
      type = 'image/x-icon';
    }
    if (!/^(?:image\/(?:png|jpeg|gif|webp|avif|apng|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)|font\/[\w.+-]+|application\/(?:font-woff2?|font-sfnt|vnd\.ms-fontobject|x-font-[\w-]+)|text\/css)$/.test(type)) return false;
    const key = `${scope}\n${(() => {
      try { const u = new URL(url); u.hash = ''; return u.href; } catch { return ''; }
    })()}`;
    const existedBefore = this.references.has(key);
    const prevEntry = existedBefore ? this.entries.get(this.references.get(key)) : null;
    const wasMissing = Boolean(prevEntry && !prevEntry.body && (prevEntry.referenced || this.requestedMissing.has(prevEntry.id)));

    const reference = this.reference(scope, url, url);
    const id = reference.split('/').pop()?.split('#')[0];
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (!existedBefore) entry.referenced = false;
    const data = type === 'text/css' ? Buffer.from(this.css(scope, body.toString('utf8'), url)) : body;
    if (data.length > MAX_ASSET_BYTES) return false;
    this.bytes -= entry.bytes;
    entry.body = data;
    entry.contentType = type;
    entry.bytes = data.length;
    entry.generation = this.currentGeneration(scope);
    this.bytes += data.length;
    this.touch(id, entry);
    // LRU eviction: evict least-recently-used payloads, keeping opaque references alive.
    for (const older of this.entries.values()) {
      if (this.bytes <= MAX_CACHE_BYTES) break;
      if (!older.body || older === entry) continue;
      this.bytes -= older.bytes;
      older.body = null;
      older.bytes = 0;
    }
    const shouldNotify = wasMissing || this.requestedMissing.delete(id);
    if (shouldNotify) this.onReady(id);
    return true;
  }

  get(id) {
    const entry = this.entries.get(id);
    if (entry && entry.body) this.touch(id, entry);
    return entry;
  }

  // Recorded DOM keeps the full URL, so a payload evicted or missed at record
  // time can still be attributed to the exact scope that referenced it.
  source(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const split = entry.key.indexOf('\n');
    if (split < 0) return null;
    return { scope: entry.key.slice(0, split), url: entry.key.slice(split + 1) };
  }

  removeScope(scope) {
    this.scopeGenerations.delete(scope);
    for (const [id, entry] of this.entries) {
      if (entry.scope !== scope) continue;
      this.bytes -= entry.bytes;
      this.entries.delete(id);
      this.references.delete(entry.key);
      this.requestedMissing.delete(id);
    }
  }
}
