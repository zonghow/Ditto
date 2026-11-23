import { createHash, randomUUID } from 'node:crypto';
import { InputError } from './snapshot.js';

const MAX_FINGERPRINTS = 60000;
const MAX_STORAGE_FINGERPRINTS = 5000;
const COOKIE_CONCURRENCY = 24;

function cookieKey(cookie) {
  return JSON.stringify([
    cookie.url || cookie.domain || '',
    cookie.path || '/',
    cookie.name,
    cookie.partitionKey?.topLevelSite ?? null,
    cookie.partitionKey?.hasCrossSiteAncestor ?? null,
  ]);
}

function cookieFingerprint(cookie) {
  return JSON.stringify([
    cookie.value,
    cookie.expires ?? null,
    Boolean(cookie.secure),
    Boolean(cookie.httpOnly),
    cookie.sameSite ?? null,
  ]);
}

function storageFingerprint(entries) {
  const hash = createHash('sha256');
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, value } of sorted) {
    hash.update(String(name.length));
    hash.update(':');
    hash.update(name);
    hash.update('=');
    hash.update(String(value.length));
    hash.update(':');
    hash.update(value);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function mapConcurrent(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

export async function importSnapshotToBrowser(browser, snapshot) {
  if (!browser.ready) throw new InputError('Chromium 尚未就绪。', 409);
  const fullMode = snapshot.mode === 'full';
  const storageFingerprints = browser.storageFingerprints || (browser.storageFingerprints = new Map());
  const originsWithStorage = (snapshot.origins || []).filter(item =>
    (item.localStorage?.length || 0) > 0 || (item.sessionStorage?.length || 0) > 0);

  const localTargets = [];
  const sessionTargets = [];
  const skippedOriginSet = new Set();
  let skippedUnchangedStorage = 0;

  for (const item of originsWithStorage) {
    const hasLocal = (item.localStorage?.length || 0) > 0;
    const hasSession = (item.sessionStorage?.length || 0) > 0;
    if (hasLocal) {
      const fp = storageFingerprint(item.localStorage);
      const lsKey = `ls|${item.origin}`;
      if (fullMode && storageFingerprints.get(lsKey) === fp) {
        skippedUnchangedStorage += item.localStorage.length;
        skippedOriginSet.add(item.origin);
      } else {
        localTargets.push({ item, fp, key: lsKey });
      }
    }
    if (hasSession) {
      const fp = storageFingerprint(item.sessionStorage);
      sessionTargets.push({ item, fp });
    }
  }

  // Only seeding changed localStorage requires a hidden seed page and an import lock.
  // Cookie-only writes and sessionStorage merges never interrupt live viewing or Agent work.
  const needsSeedPage = localTargets.length > 0;

  if (needsSeedPage && browser.importing) throw new InputError('Chromium 正忙，请稍后重试。', 409);

  let finishImport;
  if (needsSeedPage) {
    browser.importing = true;
    browser.activeImport = new Promise(resolve => { finishImport = resolve; });
    browser.emit('change', browser.summary());
  }

  const warnings = [];
  let importedCookies = 0;
  let skippedUnchangedCookies = 0;
  const importedOriginSet = new Set(skippedOriginSet);
  let writtenStorage = 0;
  let expiredCookies = 0;
  let seedPage = null;
  let cdp = null;
  let ownsCdp = false;

  try {
    const fingerprints = browser.cookieFingerprints || (browser.cookieFingerprints = new Map());
    const nowSec = Date.now() / 1000;
    const cookiesToWrite = [];

    for (const cookie of snapshot.cookies || []) {
      if (cookie.expires !== undefined && cookie.expires !== -1 && cookie.expires <= nowSec) {
        expiredCookies++;
        continue;
      }
      if (fullMode) {
        const key = cookieKey(cookie);
        const fp = cookieFingerprint(cookie);
        if (fingerprints.get(key) === fp) {
          skippedUnchangedCookies++;
          continue;
        }
      }
      cookiesToWrite.push(cookie);
    }

    // Reuse an existing tab's CDP session for pure Cookie writes so background
    // full syncs never spawn a hidden tab or interrupt live viewing/Agent work.
    if (!needsSeedPage && cookiesToWrite.length > 0) {
      for (const tab of browser.tabs.values()) {
        if (tab.cdp && !tab.page.isClosed() && !tab.crashed) {
          cdp = tab.cdp;
          break;
        }
      }
    }

    if (needsSeedPage || (cookiesToWrite.length > 0 && !cdp)) {
      seedPage = await browser.context.newPage();
      browser.hiddenPages.add(seedPage);
      const seedTab = [...browser.tabs.values()].find(tab => tab.page === seedPage);
      if (seedTab) { seedTab.hidden = true; browser.tabs.delete(seedTab.id); }
      cdp = await browser.context.newCDPSession(seedPage);
      ownsCdp = true;
      await cdp.send('Network.enable');
      await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    }

    if (cookiesToWrite.length > 0 && cdp) {
      // Apply individually in bounded parallel chunks: a single rejected Cookie
      // never discards all others, while full-profile sync stays fast.
      await mapConcurrent(cookiesToWrite, COOKIE_CONCURRENCY, async cookie => {
        try {
          const result = await cdp.send('Network.setCookie', cookie);
          if (result.success !== false) {
            importedCookies++;
            if (fingerprints.size >= MAX_FINGERPRINTS) fingerprints.clear();
            fingerprints.set(cookieKey(cookie), cookieFingerprint(cookie));
          }
        } catch { /* Do not log Cookie names, values, or raw protocol errors. */ }
      });
    }

    const totalCookies = (snapshot.cookies || []).length;
    if (expiredCookies) warnings.push(`${expiredCookies} 个 Cookie 在等待应用期间过期，已跳过。`);
    const rejectedCookies = totalCookies - importedCookies - expiredCookies - skippedUnchangedCookies;
    if (rejectedCookies > 0 && !fullMode) {
      warnings.push(`${rejectedCookies} 个 Cookie 被 Chromium 拒绝，未修改其安全属性。`);
    }

    for (const { item, fp, key } of localTargets) {
      if (!seedPage) continue;
      const seedUrl = `${item.origin}/.well-known/ditto-seed-${randomUUID()}`;
      try {
        // Fulfill locally at the correct origin. No unauthenticated target request is made.
        await seedPage.route(seedUrl, route => route.fulfill({
          status: 200, contentType: 'text/html',
          body: '<!doctype html><title>Ditto storage import</title>',
        }));
        await seedPage.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
        await seedPage.evaluate(items => {
          // Merge only the supplied keys, preserving unrelated browser state.
          for (const { name, value } of items) localStorage.setItem(name, value);
        }, item.localStorage);
        await seedPage.unroute(seedUrl);
        writtenStorage += item.localStorage.length;
        importedOriginSet.add(item.origin);
        if (storageFingerprints.size >= MAX_STORAGE_FINGERPRINTS) storageFingerprints.clear();
        storageFingerprints.set(key, fp);
      } catch {
        warnings.push(`有一个网站的 localStorage 导入失败；没有发送登录态到其他 origin。`);
      } finally {
        await seedPage.unroute(seedUrl).catch(() => {});
      }
    }

    for (const { item, fp } of sessionTargets) {
      // sessionStorage is tab-scoped; merge non-destructively into open tabs at
      // the exact matching origin without reloading their scripts.
      let matchedTabs = 0;
      let writtenTabs = 0;
      let skippedTabs = 0;
      for (const tab of browser.tabs.values()) {
        if (tab.hidden || tab.crashed || tab.page.isClosed()) continue;
        try {
          if (new URL(tab.page.url()).origin !== item.origin) continue;
          matchedTabs++;
          const ssKey = `ss|${tab.id}|${item.origin}`;
          if (fullMode && storageFingerprints.get(ssKey) === fp) {
            skippedTabs++;
            continue;
          }
          await tab.page.evaluate(items => {
            for (const { name, value } of items) {
              try { sessionStorage.setItem(name, value); } catch {}
            }
          }, item.sessionStorage);
          if (storageFingerprints.size >= MAX_STORAGE_FINGERPRINTS) storageFingerprints.clear();
          storageFingerprints.set(ssKey, fp);
          writtenTabs++;
        } catch { /* ignore cross-navigation race */ }
      }
      if (writtenTabs > 0) {
        writtenStorage += item.sessionStorage.length;
        importedOriginSet.add(item.origin);
      } else if (skippedTabs > 0 && skippedTabs === matchedTabs) {
        skippedUnchangedStorage += item.sessionStorage.length;
        importedOriginSet.add(item.origin);
      } else if (matchedTabs === 0 && !(item.localStorage?.length > 0)) {
        writtenStorage += item.sessionStorage.length;
      }
    }

    browser.lastImport = new Date().toISOString();
    return {
      importedCookies: importedCookies + skippedUnchangedCookies,
      writtenCookies: importedCookies,
      skippedUnchangedCookies,
      importedOrigins: importedOriginSet.size,
      importedStorage: writtenStorage + skippedUnchangedStorage,
      writtenStorage,
      skippedUnchangedStorage,
      importWarnings: warnings,
    };
  } finally {
    if (ownsCdp) await cdp?.detach().catch(() => {});
    await seedPage?.close().catch(() => {});
    if (needsSeedPage) {
      browser.importing = false;
      browser.activeImport = null;
      finishImport?.();
      browser.emit('change', browser.summary());
    }
  }
}
