import path from 'node:path';
import { configuration } from './config.js';
import { loadCredentials } from './auth.js';
import { SyncStore } from './sync-store.js';
import { BrowserService } from './browser.js';
import { createApplication } from './app.js';
import { UpstreamSync } from './upstream-sync.js';
import { createLogger } from './logger.js';
import { HistoryStore } from './history.js';

process.umask(0o077);
const config = configuration();
const logger = createLogger({
  enabled: config.logging !== false,
  file: config.logFile,
  fallbackFile: config.logFile ? path.join(config.dataDir, 'logs', 'ditto.log') : null,
});
const history = new HistoryStore(config.dataDir);
await history.load();
const credentials = await loadCredentials(config.dataDir);
const sync = config.syncUpstream ? new UpstreamSync(config.syncUpstream, credentials) : new SyncStore(config.dataDir);
await sync.load();
const browser = new BrowserService(config);
sync.on('browser-state', upstream => {
  if (browser.importing !== upstream.importing) {
    browser.importing = upstream.importing;
    if (upstream.importing) browser.control.release();
    else for (const tab of browser.tabs.values()) browser.checkpoint(tab);
    browser.emit('change', browser.summary());
  }
});
const application = createApplication({ config, credentials, browser, sync, logger, history });
await new Promise((resolve, reject) => {
  application.server.once('error', reject);
  application.server.listen(config.port, config.host, resolve);
});
try {
  await browser.start();
  if (sync.pending) await sync.apply(undefined, browser);
} catch {
  console.error('Chromium failed to start. Check the browser installation and sandbox support.');
  await application.close();
  sync.close?.();
  process.exit(1);
}
if (config.demo && browser.context.pages().every(page => page.url() === 'about:blank')) {
  await browser.open(`http://127.0.0.1:${config.port}/demo.html`);
  for (const page of browser.context.pages()) if (page.url() === 'about:blank') await page.close();
}
logger.log('server', `Ditto ready: http://${config.host}:${config.port} (auth: ${config.authRequired ? 'enabled' : 'open'}, cdp: 127.0.0.1:${config.cdpPort}, log: ${logger.filePath() || 'stdout-only'})`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  logger.log('server', 'stopping');
  await application.close();
  sync.close?.();
  await browser.stop();
  await history.flush();
  await logger.flush();
}
process.on('SIGTERM', () => stop().then(() => process.exit(0)));
process.on('SIGINT', () => stop().then(() => process.exit(0)));
browser.on('unexpectedClose', () => stop().then(() => process.exit(1)));
