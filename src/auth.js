import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { readJson, writePrivateJson, privateDirectory } from './files.js';

export const SESSION_COOKIE = 'ditto_session';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

export function constantEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function loadCredentials(dataDir) {
  await privateDirectory(dataDir);
  const file = path.join(dataDir, 'credentials.json');
  const existing = await readJson(file);
  if (existing) {
    for (const name of ['dashboardToken', 'syncToken', 'sessionKey']) {
      if (typeof existing[name] !== 'string' || existing[name].length < 32) {
        throw new Error('Invalid private credentials file.');
      }
    }
    if (!existing.cookieCloud?.uuid || !existing.cookieCloud?.password) {
      throw new Error('Invalid CookieCloud credentials.');
    }
    return existing;
  }
  const credentials = {
    dashboardToken: randomBytes(32).toString('base64url'),
    syncToken: randomBytes(32).toString('base64url'),
    sessionKey: randomBytes(32).toString('base64url'),
    cookieCloud: { uuid: randomUUID(), password: randomBytes(24).toString('base64url') },
  };
  await writePrivateJson(file, credentials);
  return credentials;
}

export class Authentication {
  constructor(credentials) {
    this.credentials = credentials;
  }

  signature(payload) {
    return createHmac('sha256', this.credentials.sessionKey).update(payload).digest('base64url');
  }

  session(now = Date.now()) {
    const payload = `${Math.floor(now / 1000) + SESSION_SECONDS}.${randomBytes(12).toString('base64url')}`;
    return `${payload}.${this.signature(payload)}`;
  }

  validSession(value, now = Date.now()) {
    if (typeof value !== 'string' || value.length > 200) return false;
    const parts = value.split('.');
    if (parts.length !== 3 || !/^\d+$/.test(parts[0])) return false;
    const expires = Number(parts[0]);
    if (expires <= Math.floor(now / 1000) || expires > Math.floor(now / 1000) + SESSION_SECONDS) return false;
    return constantEqual(parts[2], this.signature(`${parts[0]}.${parts[1]}`));
  }

  isDashboard(request) {
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    if (constantEqual(bearer, this.credentials.dashboardToken)) return true;
    const cookies = String(request.headers.cookie || '').split(';');
    const entry = cookies.map(item => item.trim()).find(item => item.startsWith(`${SESSION_COOKIE}=`));
    return Boolean(entry && this.validSession(entry.slice(SESSION_COOKIE.length + 1)));
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
