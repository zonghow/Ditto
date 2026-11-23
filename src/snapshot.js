import CryptoJS from 'crypto-js';

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function object(value, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(description);
  return value;
}

export function httpOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new InputError('网站地址必须是完整的 HTTP/HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === 'null') {
    throw new InputError('只支持不含用户名和密码的 HTTP/HTTPS 网站地址。');
  }
  return url.origin;
}

export function matchesDomain(hostname, domain, hostOnly = false) {
  const clean = domain.replace(/^\./, '').toLowerCase();
  const host = hostname.toLowerCase();
  return host === clean || (!hostOnly && host.endsWith(`.${clean}`));
}

export function normalizeCookie(input, now = Date.now() / 1000) {
  object(input, 'Cookie 格式错误。');
  if (typeof input.name !== 'string' || typeof input.value !== 'string' || input.name.length > 4096) {
    throw new InputError('Cookie 必须包含字符串 name 和 value。');
  }
  let domain = input.domain;
  if (typeof domain !== 'string' || !domain || /[\s/\\:@?#]/.test(domain)) {
    throw new InputError('Cookie 域名格式错误。');
  }
  domain = domain.toLowerCase();
  const hostname = domain.replace(/^\./, '');
  try {
    if (new URL(`https://${hostname}`).hostname !== hostname) throw new Error();
  } catch { throw new InputError('Cookie 域名格式错误。'); }
  const cookiePath = input.path ?? '/';
  if (typeof cookiePath !== 'string' || !cookiePath.startsWith('/') || /[\r\n]/.test(cookiePath)) {
    throw new InputError('Cookie 路径格式错误。');
  }
  const expires = input.expirationDate ?? input.expires;
  if (expires !== undefined && (!Number.isFinite(expires) || expires < -1)) {
    throw new InputError('Cookie 过期时间格式错误。');
  }
  if (expires !== undefined && expires !== -1 && expires <= now) return null;
  for (const attribute of ['hostOnly', 'secure', 'httpOnly', 'session']) {
    if (input[attribute] !== undefined && typeof input[attribute] !== 'boolean') {
      throw new InputError('Cookie 安全属性必须是布尔值。');
    }
  }
  const hostOnly = input.hostOnly ?? !domain.startsWith('.');
  const result = {
    name: input.name,
    value: input.value,
    path: cookiePath,
    secure: Boolean(input.secure),
    httpOnly: Boolean(input.httpOnly),
  };
  // CDP's URL form preserves host-only cookies. Do not broaden them to a domain cookie.
  if (hostOnly) {
    result.url = `${result.secure ? 'https' : 'http'}://${hostname}${cookiePath}`;
  } else {
    result.domain = domain.startsWith('.') ? domain : `.${domain}`;
  }
  const sameSite = String(input.sameSite ?? 'unspecified').toLowerCase();
  const mapping = { strict: 'Strict', lax: 'Lax', none: 'None', no_restriction: 'None' };
  if (mapping[sameSite]) result.sameSite = mapping[sameSite];
  else if (sameSite !== 'unspecified') throw new InputError('不支持的 Cookie SameSite 值。');
  if (result.sameSite === 'None' && !result.secure) {
    throw new InputError('SameSite=None 的 Cookie 必须同时设置 Secure。');
  }
  if (expires !== undefined && expires !== -1 && !input.session) result.expires = expires;
  if (input.partitionKey !== undefined) {
    if (typeof input.partitionKey === 'string') {
      result.partitionKey = { topLevelSite: httpOrigin(input.partitionKey), hasCrossSiteAncestor: true };
    } else {
      object(input.partitionKey, 'Cookie 分区信息格式错误。');
      if (typeof input.partitionKey.hasCrossSiteAncestor !== 'boolean') {
        throw new InputError('Cookie 分区信息缺少 hasCrossSiteAncestor，请使用新版 Chrome 扩展重新采集。');
      }
      result.partitionKey = {
        topLevelSite: httpOrigin(input.partitionKey.topLevelSite),
        hasCrossSiteAncestor: input.partitionKey.hasCrossSiteAncestor,
      };
    }
  }
  return { cookie: result, hostname, domain, hostOnly };
}

function entries(value, label = 'localStorage') {
  if (Array.isArray(value)) {
    if (value.length > 10000) throw new InputError(`${label} 项目过多。`);
    return value.map(item => {
      object(item, `${label} 格式错误。`);
      if (typeof item.name !== 'string' || typeof item.value !== 'string') {
        throw new InputError(`${label} 项目必须是字符串 name/value。`);
      }
      return { name: item.name, value: item.value };
    });
  }
  object(value, `${label} 格式错误。`);
  return entries(Object.entries(value).map(([name, item]) => ({ name, value: item })), label);
}

export function normalizeSnapshot(payload, source = 'extension', now = Date.now() / 1000) {
  object(payload, '同步数据格式错误。');
  let cookies;
  let origins;
  const warnings = [];
  const fullMode = source === 'extension' && payload.mode === 'full';
  if (source === 'cookiecloud') {
    const cookieData = object(payload.cookie_data, 'CookieCloud 缺少 cookie_data。');
    if (Object.values(cookieData).some(value => !Array.isArray(value))) {
      throw new InputError('CookieCloud Cookie 分组格式错误。');
    }
    cookies = Object.values(cookieData).flat();
    const storage = payload.local_storage_data ?? {};
    object(storage, 'CookieCloud local_storage_data 格式错误。');
    origins = Object.entries(storage).map(([hostname, localStorage]) => ({
      origin: /^https?:\/\//.test(hostname) ? httpOrigin(hostname) : httpOrigin(`https://${hostname}`),
      localStorage,
    }));
    if (origins.length) {
      warnings.push('CookieCloud 只保留 hostname，localStorage 按 HTTPS 默认端口恢复。HTTP 或其他端口请使用 Ditto 扩展。');
    }
  } else {
    if (payload.schemaVersion !== 1) throw new InputError('不支持的同步数据版本。');
    cookies = payload.cookies;
    origins = payload.origins ?? [];
  }
  const maxCookies = fullMode ? 50000 : 10000;
  const maxOrigins = fullMode ? 200 : 100;
  if (!Array.isArray(cookies) || cookies.length > maxCookies || !Array.isArray(origins) || origins.length > maxOrigins) {
    throw new InputError('同步范围过大或数据格式错误。');
  }
  const byOrigin = new Map();
  for (const item of origins) {
    object(item, '网站存储格式错误。');
    const origin = httpOrigin(item.origin);
    if (origin !== item.origin && source !== 'cookiecloud') throw new InputError('origin 不应包含路径。');
    if (byOrigin.has(origin)) {
      if (fullMode) continue;
      throw new InputError('网站 origin 重复。');
    }
    byOrigin.set(origin, {
      origin,
      localStorage: entries(item.localStorage ?? [], 'localStorage'),
      sessionStorage: item.sessionStorage ? entries(item.sessionStorage, 'sessionStorage') : [],
    });
  }
  const normalized = new Map();
  let expired = 0;
  let skippedInvalid = 0;
  for (const input of cookies) {
    let result;
    try {
      result = normalizeCookie(input, now);
    } catch (error) {
      if (fullMode) { skippedInvalid++; continue; }
      throw error;
    }
    if (!result) { expired++; continue; }
    const domainLabels = result.hostname.split('.').filter(Boolean);
    if (source !== 'cookiecloud' && !result.hostOnly && domainLabels.length < 2) {
      if (fullMode) { skippedInvalid++; continue; }
      throw new InputError('Cookie 不属于本次请求的网站或其父域。');
    }
    if (source !== 'cookiecloud' && !fullMode && ![...byOrigin.keys()].some(origin => {
      const host = new URL(origin).hostname.toLowerCase();
      if (matchesDomain(host, result.domain, result.hostOnly)) return true;
      const labels = host.split('.').filter(Boolean);
      return labels.slice(1).some((_, index) => {
        const parent = labels.slice(index + 1);
        return parent.length >= 2 && matchesDomain(parent.join('.'), result.domain, result.hostOnly);
      });
    })) {
      throw new InputError('Cookie 不属于本次请求的网站或其父域。');
    }
    // Never import this service's admin session into the agent browser.
    if (input.name === 'ditto_session') continue;
    const key = JSON.stringify([result.domain, result.cookie.path, result.cookie.name, result.cookie.partitionKey ?? null]);
    normalized.set(key, result.cookie);
  }
  if (expired) warnings.push(`已跳过 ${expired} 个过期 Cookie，不会延长有效期。`);
  if (skippedInvalid) warnings.push(`已跳过 ${skippedInvalid} 个格式不规范的 Cookie。`);
  const missingStorageOrigins = [];
  if (Array.isArray(payload.missingStorageOrigins)) {
    for (const raw of payload.missingStorageOrigins.slice(0, 20)) {
      try {
        const clean = httpOrigin(raw);
        if (!missingStorageOrigins.includes(clean)) missingStorageOrigins.push(clean);
      } catch { /* ignore invalid origin */ }
    }
  }
  if (Array.isArray(payload.warnings)) {
    // Extension warnings are fixed, non-sensitive status messages, not arbitrary strings to echo.
    if (payload.warnings.includes('storage-unavailable')) {
      if (missingStorageOrigins.length) {
        warnings.push(`以下站点未在主力机打开同源标签页，未采集 Storage：${missingStorageOrigins.slice(0, 4).join('、')}${missingStorageOrigins.length > 4 ? ` 等 ${missingStorageOrigins.length} 个` : ''}`);
      } else {
        warnings.push('部分网站没有已打开的页面，未采集其 localStorage。');
      }
    }
    if (payload.warnings.includes('partition-api-unavailable')) warnings.push('浏览器未提供完整分区 Cookie API。');
  }
  return {
    schemaVersion: 1,
    source,
    mode: fullMode ? 'full' : 'scoped',
    collectedAt: Number.isFinite(Date.parse(payload.collectedAt ?? payload.update_time))
      ? new Date(payload.collectedAt ?? payload.update_time).toISOString() : new Date(now * 1000).toISOString(),
    cookies: [...normalized.values()],
    origins: [...byOrigin.values()],
    missingStorageOrigins,
    warnings,
  };
}

export function decryptCookieCloud(envelope, credentials) {
  object(envelope, 'CookieCloud 上传格式错误。');
  if (envelope.uuid !== credentials.uuid || typeof envelope.encrypted !== 'string') {
    throw new InputError('CookieCloud UUID 与本服务的配对配置不一致。');
  }
  const type = envelope.crypto_type ?? 'legacy';
  if (!['legacy', 'aes-128-cbc-fixed'].includes(type)) throw new InputError('不支持的 CookieCloud 加密算法。');
  const key = CryptoJS.MD5(`${credentials.uuid}-${credentials.password}`).toString().slice(0, 16);
  try {
    const options = type === 'legacy' ? undefined : {
      iv: CryptoJS.enc.Hex.parse('00000000000000000000000000000000'),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    };
    const decrypted = CryptoJS.AES.decrypt(envelope.encrypted,
      type === 'legacy' ? key : CryptoJS.enc.Utf8.parse(key), options).toString(CryptoJS.enc.Utf8);
    return JSON.parse(decrypted);
  } catch {
    throw new InputError('CookieCloud 解密失败，请核对 UUID、密码和加密算法。');
  }
}

export function snapshotSummary(snapshot) {
  return {
    source: snapshot.source,
    mode: snapshot.mode || 'scoped',
    collectedAt: snapshot.collectedAt,
    cookieCount: snapshot.cookies.length,
    originCount: snapshot.origins.length,
    storageCount: snapshot.origins.reduce((total, item) => total + (item.localStorage?.length || 0) + (item.sessionStorage?.length || 0), 0),
    origins: snapshot.origins.map(item => item.origin),
    missingStorageOrigins: snapshot.missingStorageOrigins || [],
    warnings: snapshot.warnings,
  };
}
