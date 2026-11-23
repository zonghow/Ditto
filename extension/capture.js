export function originOf(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('每行填写一个完整的网站地址，例如 https://example.com'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('只支持不含用户名和密码的 HTTP/HTTPS 网站。');
  }
  return url.origin;
}

export function parseOrigins(text) {
  const origins = [...new Set(text.split('\n').map(line => line.trim()).filter(Boolean).map(originOf))];
  if (!origins.length || origins.length > 100) throw new Error('请选择 1–100 个网站。');
  return origins;
}

export function cookieMatches(cookie, origin) {
  const host = new URL(origin).hostname.toLowerCase();
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  return host === domain || (!cookie.hostOnly && host.endsWith(`.${domain}`));
}

// A login hop often lands on a sibling the remote browser has not opened yet.
// Pairing already consented to the requested site, so its registrable parent is
// part of the same capture. Unrelated sites stay out.
export function parentOrigins(origin) {
  const url = new URL(origin);
  // 127.0.0.1 and ::1 are addresses, not a domain that has a parent site.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(':')) return [];
  const labels = url.hostname.toLowerCase().split('.').filter(Boolean);
  const parents = [];
  // sso.example.com -> example.com. Stop before a one-label suffix such as com.
  for (let length = labels.length - 1; length >= 2; length -= 1) {
    parents.push(`${url.protocol}//${labels.slice(-length).join('.')}`);
  }
  return parents;
}

export function cookieTooBroad(cookie) {
  const labels = String(cookie.domain || '').replace(/^\./, '').toLowerCase().split('.').filter(Boolean);
  return cookie.hostOnly !== true && labels.length < 2;
}

export function cookieIdentity(cookie) {
  return JSON.stringify([cookie.domain, cookie.path, cookie.name, cookie.storeId,
    cookie.partitionKey?.topLevelSite ?? null, cookie.partitionKey?.hasCrossSiteAncestor ?? null]);
}

export function permissionPatterns(origins) {
  // Chrome match patterns do not isolate ports; actual capture still checks exact origins.
  return [...new Set(origins.map(origin => {
    const url = new URL(origin);
    return `${url.protocol}//${url.hostname}/*`;
  }))];
}

async function resolveProfileStores(api) {
  const stores = await api.cookies.getAllCookieStores();
  const tabs = await api.tabs.query({});
  const active = tabs.find(tab => tab.active && !tab.incognito);
  const store = stores.find(item => item.tabIds.includes(active?.id));
  const storeIds = store ? [store.id] : stores.filter(item => item.id === '0').map(item => item.id);
  // Keep incognito and unrelated profiles out of a normal-profile synchronization.
  if (!storeIds.length) throw new Error('无法确定当前浏览器 Profile 的 Cookie 存储。');
  return { storeIds, tabs };
}

async function collectAllStoreCookies(api, storeIds, warnings, progress) {
  const cookiesByKey = new Map();
  const nowSec = Date.now() / 1000;
  for (const storeId of storeIds) {
    progress('cookies');
    let cookies = await api.cookies.getAll({ storeId });
    try {
      progress('partitioned-cookies');
      const allPartitions = await api.cookies.getAll({ storeId, partitionKey: {} });
      cookies = cookies.concat(allPartitions);
    } catch { warnings.push('partition-api-unavailable'); }
    for (const cookie of cookies) {
      if (cookie.name === 'ditto_session' || cookieTooBroad(cookie)) continue;
      if (cookie.expirationDate !== undefined && cookie.expirationDate !== -1 && cookie.expirationDate <= nowSec) continue;
      cookiesByKey.set(cookieIdentity(cookie), cookie);
    }
  }
  return cookiesByKey;
}

async function captureTabStorage(api, tabId, expectedOrigin) {
  const results = await api.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'ISOLATED',
    func: expected => {
      if (location.origin !== expected) throw new Error('页面在采集时发生跳转。');
      const readStore = store => {
        const items = [];
        for (let i = 0; i < store.length; i++) {
          const name = store.key(i);
          if (name !== null) items.push({ name, value: store.getItem(name) ?? '' });
        }
        return items;
      };
      return {
        localStorage: readStore(localStorage),
        sessionStorage: readStore(sessionStorage),
      };
    },
    args: [expectedOrigin],
  });
  const payload = results[0]?.result;
  // Backward compatibility for unit test mocks that return a flat array for localStorage.
  if (Array.isArray(payload)) return { localStorage: payload, sessionStorage: [] };
  return {
    localStorage: Array.isArray(payload?.localStorage) ? payload.localStorage : [],
    sessionStorage: Array.isArray(payload?.sessionStorage) ? payload.sessionStorage : [],
  };
}

export async function captureSnapshot(origins, api = chrome, progress = () => {}) {
  progress('permissions');
  if (api.permissions && !await api.permissions.contains({ origins: permissionPatterns(origins) })) {
    throw new Error('网站访问权限尚未授予。请在 Chrome 扩展详情里将“网站访问权限”设置为“在所有网站上”，再重试。');
  }
  const warnings = [];
  const missingStorageOrigins = [];
  progress('profile');
  const { storeIds, tabs } = await resolveProfileStores(api);
  progress('tabs');
  const allCookies = await collectAllStoreCookies(api, storeIds, warnings, progress);
  const cookieOrigins = [...new Set(origins.flatMap(origin => [origin, ...parentOrigins(origin)]))];
  const cookies = [];
  for (const cookie of allCookies.values()) {
    if (cookieOrigins.some(origin => cookieMatches(cookie, origin))) cookies.push(cookie);
  }
  const originsData = [];
  progress('local-storage');
  await Promise.all(origins.map(async origin => {
    const candidates = tabs.filter(tab => {
      try { return !tab.incognito && originOf(tab.url) === origin; } catch { return false; }
    });
    candidates.sort((a, b) => Number(b.active) - Number(a.active));
    let localStorage = [];
    let sessionStorage = [];
    if (candidates[0]?.id !== undefined) {
      try {
        const captured = await captureTabStorage(api, candidates[0].id, origin);
        localStorage = captured.localStorage;
        sessionStorage = captured.sessionStorage;
      } catch {
        warnings.push('storage-unavailable');
        missingStorageOrigins.push(origin);
      }
    } else {
      warnings.push('storage-unavailable');
      missingStorageOrigins.push(origin);
    }
    originsData.push({ origin, localStorage, ...(sessionStorage.length ? { sessionStorage } : {}) });
  }));
  // Keep original origin ordering deterministic.
  const order = new Map(origins.map((origin, index) => [origin, index]));
  originsData.sort((a, b) => (order.get(a.origin) ?? 0) - (order.get(b.origin) ?? 0));
  return {
    schemaVersion: 1,
    mode: 'scoped',
    collectedAt: new Date().toISOString(),
    cookies,
    origins: originsData,
    ...(missingStorageOrigins.length ? { missingStorageOrigins } : {}),
    warnings: [...new Set(warnings)],
  };
}

export async function captureFullSnapshot(api = chrome, progress = () => {}, { excludeOrigin = null } = {}) {
  progress('permissions');
  if (api.permissions && !await api.permissions.contains({ origins: ['https://*/*', 'http://*/*'] })) {
    throw new Error('网站访问权限尚未授予。请在 Chrome 扩展详情里将“网站访问权限”设置为“在所有网站上”，再重试。');
  }
  const warnings = [];
  progress('profile');
  const { storeIds, tabs } = await resolveProfileStores(api);
  progress('tabs');
  const allCookies = await collectAllStoreCookies(api, storeIds, warnings, progress);

  // Pick one representative tab (preferring active) per open http/https origin.
  const tabByOrigin = new Map();
  for (const tab of tabs) {
    if (tab.incognito || tab.id === undefined || !tab.url) continue;
    let parsed;
    try { parsed = new URL(tab.url); } catch { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
    const origin = parsed.origin;
    if (excludeOrigin && origin === excludeOrigin && ['/', '/index.html'].includes(parsed.pathname)) continue;
    const prev = tabByOrigin.get(origin);
    if (!prev || (tab.active && !prev.active)) tabByOrigin.set(origin, tab);
  }
  const openOrigins = [...tabByOrigin.keys()].slice(0, 200);
  const originsData = [];
  progress('local-storage');
  await Promise.all(openOrigins.map(async origin => {
    const tab = tabByOrigin.get(origin);
    try {
      const captured = await captureTabStorage(api, tab.id, origin);
      if (captured.localStorage.length || captured.sessionStorage.length) {
        originsData.push({
          origin,
          localStorage: captured.localStorage,
          ...(captured.sessionStorage.length ? { sessionStorage: captured.sessionStorage } : {}),
        });
      }
    } catch { /* Restricted/discarded tab; cookies are still captured. */ }
  }));

  return {
    schemaVersion: 1,
    mode: 'full',
    collectedAt: new Date().toISOString(),
    cookies: [...allCookies.values()],
    origins: originsData,
    warnings: [...new Set(warnings)],
  };
}

export function parsePairingInput(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('请输入开发机服务地址，例如 http://10.0.0.2:3217');
  if (trimmed.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error('连接配置 JSON 格式错误。'); }
    const endpoint = originOf(parsed.endpoint);
    const syncToken = typeof parsed.syncToken === 'string' && parsed.syncToken.trim() ? parsed.syncToken.trim() : undefined;
    return syncToken ? { endpoint, syncToken } : { endpoint };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[\w.-]+:\d/.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  return { endpoint: originOf(withScheme) };
}

export function syncEndpoint(settings) {
  if (!settings?.endpoint) throw new Error('请先连接开发机服务地址。');
  return originOf(settings.endpoint);
}

export async function prepareUploadBody(payload, { allowGzip = true } = {}) {
  const text = JSON.stringify(payload);
  if (allowGzip && text.length > 4096 && typeof CompressionStream === 'function' && typeof Blob === 'function') {
    try {
      const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
      const buffer = await new Response(stream).arrayBuffer();
      return { body: new Uint8Array(buffer), headers: { 'Content-Encoding': 'gzip' } };
    } catch { /* Fall back to plain JSON if CompressionStream is unavailable. */ }
  }
  return { body: text, headers: {} };
}

export async function uploadSnapshot(settings, snapshot, fetcher = fetch) {
  const endpoint = syncEndpoint(settings);
  const { body, headers: extraHeaders } = await prepareUploadBody(snapshot, { allowGzip: fetcher === fetch });
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (settings.syncToken) headers.Authorization = `Bearer ${settings.syncToken}`;
  const response = await fetcher(`${endpoint}/api/sync`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '上传失败。');
  return result.applied || result.pending;
}
