import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { readJson, writePrivateJson, privateDirectory } from './files.js';

export const SESSION_COOKIE = 'ditto_session';
// Chrome/RFC 6265bis caps persistent cookie Max-Age at 400 days. Sessions
// themselves are permanent (expires=0) and sliding-renewed on every /api/state
// visit so a logged-in browser stays authenticated until explicit logout or
// token rotation.
export const SESSION_SECONDS = 400 * 24 * 60 * 60;

export function constantEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function loadCredentials(dataDir, { token } = {}) {
  await privateDirectory(dataDir);
  const file = path.join(dataDir, 'credentials.json');
  let credentials = await readJson(file);
  if (credentials) {
    for (const name of ['dashboardToken', 'syncToken', 'sessionKey']) {
      if (typeof credentials[name] !== 'string' || credentials[name].length < 32) {
        throw new Error('Invalid private credentials file.');
      }
    }
    if (!credentials.cookieCloud?.uuid || !credentials.cookieCloud?.password) {
      throw new Error('Invalid CookieCloud credentials.');
    }
  } else {
    credentials = {
      dashboardToken: randomBytes(32).toString('base64url'),
      syncToken: randomBytes(32).toString('base64url'),
      sessionKey: randomBytes(32).toString('base64url'),
      cookieCloud: { uuid: randomUUID(), password: randomBytes(24).toString('base64url') },
    };
    await writePrivateJson(file, credentials);
  }
  const unified = typeof token === 'string' && token.trim() ? token.trim() : '';
  if (unified) {
    return {
      ...credentials,
      dashboardToken: unified,
      syncToken: unified,
      unifiedToken: true,
    };
  }
  return {
    ...credentials,
    unifiedToken: constantEqual(credentials.dashboardToken, credentials.syncToken),
  };
}

export class Authentication {
  constructor(credentials) {
    this.credentials = credentials;
    // Bind session signatures to both the private sessionKey and active
    // dashboardToken so rotating the configured token immediately invalidates
    // all previously issued permanent sessions.
    this._signingKey = createHmac('sha256', credentials.sessionKey)
      .update(`ditto-session:${credentials.dashboardToken}`)
      .digest();
  }

  hasUnifiedToken() {
    return Boolean(this.credentials.unifiedToken || constantEqual(this.credentials.dashboardToken, this.credentials.syncToken));
  }

  signature(payload) {
    return createHmac('sha256', this._signingKey).update(payload).digest('base64url');
  }

  session(now = Date.now(), ttlSeconds = 0) {
    const expires = ttlSeconds > 0 ? Math.floor(now / 1000) + ttlSeconds : 0;
    const payload = `${expires}.${randomBytes(12).toString('base64url')}`;
    return `${payload}.${this.signature(payload)}`;
  }

  validSession(value, now = Date.now()) {
    if (typeof value !== 'string' || value.length > 200) return false;
    const parts = value.split('.');
    if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !parts[1]) return false;
    const expires = Number(parts[0]);
    if (expires !== 0) {
      const nowSec = Math.floor(now / 1000);
      if (expires <= nowSec || expires > nowSec + SESSION_SECONDS) return false;
    }
    return constantEqual(parts[2], this.signature(`${parts[0]}.${parts[1]}`));
  }

  sessionFromCookie(request) {
    const cookies = String(request.headers.cookie || '').split(';');
    const entry = cookies.map(item => item.trim()).find(item => item.startsWith(`${SESSION_COOKIE}=`));
    const value = entry ? entry.slice(SESSION_COOKIE.length + 1) : '';
    return value && this.validSession(value) ? value : null;
  }

  isDashboard(request) {
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    if (constantEqual(bearer, this.credentials.dashboardToken)) return true;
    return Boolean(this.sessionFromCookie(request));
  }

  isSync(request) {
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    return constantEqual(bearer, this.credentials.syncToken);
  }

  cookie(value, clear = false) {
    return `${SESSION_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}`;
  }
}

export function validHost(host) {
  if (typeof host !== 'string' || !host || host.length > 255 || /[\s/\\@?#]/.test(host)) return false;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    if (parsed.port) {
      const port = Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    }
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function allowedOrigin(request, allowExtension = false) {
  const origin = request.headers.origin;
  if (!origin) return true; // Non-browser clients (curl / CLI) have no Origin header.
  if (allowExtension && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true;
  return origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}`;
}
