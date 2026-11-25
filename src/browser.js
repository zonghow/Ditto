import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { privateDirectory } from './files.js';
import { InputError, httpOrigin } from './snapshot.js';
import { AssetCache } from './assets.js';
import { ControlLease } from './control.js';
import { recorderSource, RECORDER_BINDING, RECORDER_KEY } from './recorder.js';
import { NativeTabOrder, orderedTabs } from './tab-order.js';
import { importSnapshotToBrowser } from './import-snapshot.js';
import { ScreencastManager } from './screencast.js';
import {
  performControl as runPerformControl,
  dispatchControl as runDispatchControl,
  performScreencastInput as runPerformScreencastInput,
  getSelectionText as runGetSelectionText,
  uploadFileToTab as runUploadFileToTab,
} from './browser-control.js';
import {
  isTabWatched as checkTabWatched,
  syncTabWatched as runSyncTabWatched,
  syncAllRecorderWatchState as runSyncAllRecorderWatchState,
  ensureRecorder as runEnsureRecorder,
  startDocument as runStartDocument,
  reconcileRecorder as runReconcileRecorder,
  receiveRecording as runReceiveRecording,
  captureTaintedVideo as runCaptureTaintedVideo,
  checkpoint as runCheckpoint,
  captureResource as runCaptureResource,
  captureCachedResources as runCaptureCachedResources,
  refillAsset as runRefillAsset,
} from './browser-recording.js';
import {
  handleDownload as runHandleDownload,
  readPageFavicon as runReadPageFavicon,
  refreshTab as runRefreshTab,
  refreshHistory as runRefreshHistory,
  placeTabAfter as runPlaceTabAfter,
  openTab as runOpenTab,
  recoverCrashedTab as runRecoverCrashedTab,
  executeTabAction as runExecuteTabAction,
  dispatchTabAction as runDispatchTabAction,
} from './browser-tabs.js';
import {
  attachTabDiagnostics,
  runAgentSnapshot,
  runAgentAct,
  runAgentEvaluate,
  runAgentScreenshot,
  runAgentConsole,
  runAgentNetwork,
} from './agent-ops.js';
import {
  devtoolsSnapshot as runDevtoolsSnapshot,
  devtoolsClear as runDevtoolsClear,
  devtoolsEvaluate as runDevtoolsEvaluate,
} from './devtools.js';

const execFileAsync = promisify(execFile);

// Playwright disables ThirdPartyStoragePartitioning by default; combined with
// Chromium 142+'s default 3PC blocking, cross-origin iframes (such as SSO or
// embedded WebShells) throw SecurityError on window.localStorage. Explicitly
// allow third-party cookies/storage in the profile Preferences without
// overwriting Playwright's --disable-features switch.
export async function ensureThirdPartyStoragePrefs(profileDir) {
  const defaultDir = path.join(profileDir, 'Default');
  const prefsPath = path.join(defaultDir, 'Preferences');
  let prefs = {};
  try {
    const raw = await readFile(prefsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed;
  } catch { /* First launch or unreadable prefs: start clean. */ }
  const existingProfile = prefs.profile && typeof prefs.profile === 'object' && !Array.isArray(prefs.profile)
    ? prefs.profile : {};
  if (existingProfile.cookie_controls_mode === 0 && existingProfile.block_third_party_cookies === false) return;
  prefs.profile = {
    ...existingProfile,
    cookie_controls_mode: 0,
    block_third_party_cookies: false,
  };
  await mkdir(defaultDir, { recursive: true, mode: 0o700 });
  await writeFile(prefsPath, JSON.stringify(prefs), { mode: 0o600 });
}

const MAX_AGENT_SESSIONS = 50;

const SESSION_PALETTE = [
  '#5e8bff', // Cobalt
  '#f5a524', // Amber
  '#2dd496', // Mint
  '#a78bfa', // Violet
  '#38bdf8', // Sky
  '#f472b6', // Rose
  '#fb923c', // Tangerine
  '#818cf8', // Periwinkle
];

const AGENT_NAMES = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  terminal: 'CLI',
};

const ACTION_LABELS = {
  open: '打开网页',
  navigate: '跳转网页',
  reload: '刷新',
  back: '后退',
  forward: '前进',
  snapshot: '读取页面',
  click: '点击',
  hover: '悬停',
  fill: '输入',
  type: '输入',
  select: '选择',
  press: '按键',
  scroll: '滚动',
  upload: '上传文件',
  wait: '等待',
  eval: '执行脚本',
  screenshot: '截图',
  sync: '同步登录态',
  'accept-dialog': '确认弹窗',
  'dismiss-dialog': '取消弹窗',
};

async function cleanUserAgent(chromiumPath, explicitUserAgent) {
  if (explicitUserAgent) return explicitUserAgent;
  let major = '136';
  try {
    const executable = chromiumPath || chromium.executablePath();
    const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 3000 });
    major = /(\d+)\.\d+\.\d+/.exec(stdout)?.[1] || major;
  } catch { /* Fall back to standard Chrome major version if binary inspection fails. */ }
  const osToken = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export class BrowserService extends EventEmitter {
  ready = false;
  tabs = new Map();
  sessionTabs = new Map();
  agentSessions = new Map();
  agentTypeCounters = new Map();
  paletteCounter = 0;
  hiddenPages = new WeakSet();
  viewers = new Map();
  downloads = new Map();
  cookieFingerprints = new Map();
  storageFingerprints = new Map();
  importing = false;
  activeImport = null;
  lastImport = null;
  assetRefills = new Map();
  assetMisses = new Map();
  tickCount = 0;

  constructor(config) {
    super();
    this.config = config;
    this.viewport = { ...(config.viewport || { width: 1920, height: 1080 }) };
    this.deviceScaleFactor = config.deviceScaleFactor === 1 ? 1 : 2;
    this.pendingViewport = null;
    this.resizingViewport = false;
    this.assets = new AssetCache(id => this.emit('asset', { type: 'asset-ready', id }));
    this.control = new ControlLease(() => this.emit('change', this.summary()));
    this.screencast = new ScreencastManager({
      defaultQuality: config.screencastQuality,
      defaultRetina: config.screencastRetina,
    });
    this.screencast.on('frame', frame => this.emit('screencast-frame', frame));
    this.controlQueue = Promise.resolve();
    this.controlBacklog = 0;
    this.queuedWheel = null;
    this.queuedScreencastMove = null;
  }

  async start() {
    this.stopping = false;
    this.tabs.clear();
    this.sessionTabs.clear();
    this.agentSessions.clear();
    this.agentTypeCounters.clear();
    this.downloads.clear();
    this.cookieFingerprints.clear();
    this.storageFingerprints.clear();
    this.paletteCounter = 0;
    this.tickCount = 0;
    this.hiddenPages = new WeakSet();
    this.frameDocuments = new WeakMap();
    this.assetRefills = new Map();
    this.assetMisses = new Map();
    this.assets = new AssetCache(id => this.emit('asset', { type: 'asset-ready', id }));
    const profile = path.join(this.config.dataDir, 'profile');
    this.downloadsDir = path.join(this.config.dataDir, 'downloads');
    await privateDirectory(profile);
    await rm(this.downloadsDir, { recursive: true, force: true }).catch(() => {});
    await privateDirectory(this.downloadsDir);
    if (this.config.attachCDP) {
      // An in-place viewer upgrade attaches to the exact existing default context.
      // Disconnecting this client must never close the service-owned Chromium.
      const url = new URL(this.config.attachCDP);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Attach CDP must be a literal loopback HTTP endpoint.');
      this.connection = await chromium.connectOverCDP(url.origin);
      this.context = this.connection.contexts()[0];
      if (!this.context) throw new Error('No persistent browser context to attach.');
    } else {
      await ensureThirdPartyStoragePrefs(profile);
      const userAgent = await cleanUserAgent(this.config.chromiumPath, this.config.userAgent);
      const baseArgs = [
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        ...(this.deviceScaleFactor > 1 ? [`--force-device-scale-factor=${this.deviceScaleFactor}`] : []),
      ];
      const args = this.config.cdpPort ? [
        `--remote-debugging-port=${this.config.cdpPort}`,
        '--remote-debugging-address=127.0.0.1',
        ...baseArgs,
      ] : baseArgs;
      const launchOptions = chromiumSandbox => ({
        channel: 'chromium',
        executablePath: this.config.chromiumPath,
        headless: true,
        chromiumSandbox,
        userAgent,
        ignoreDefaultArgs: ['--enable-automation'],
        viewport: this.config.viewport,
        deviceScaleFactor: this.deviceScaleFactor,
        acceptDownloads: true,
        args,
      });
      const preferSandbox = process.env.DITTO_CHROMIUM_SANDBOX === '1'
        || (process.env.DITTO_CHROMIUM_SANDBOX !== '0' && process.platform === 'linux' && process.geteuid?.() !== 0);
      try {
        this.context = await chromium.launchPersistentContext(profile, launchOptions(preferSandbox));
      } catch (error) {
        if (!preferSandbox || process.env.DITTO_CHROMIUM_SANDBOX === '1') throw error;
        this.context = await chromium.launchPersistentContext(profile, launchOptions(false));
      }
    }
    this.context.setDefaultTimeout(10000);
    this.context.setDefaultNavigationTimeout(20000);
    await this.grantLocalNetworkAccess();
    this.recordingInstance = randomUUID();
    this.bindingName = `${RECORDER_BINDING}_${this.recordingInstance.replaceAll('-', '')}`;
    this.source = await recorderSource(this.config.port, this.bindingName, this.recordingInstance);
    await this.context.exposeBinding(this.bindingName, (source, message) => this.receiveRecording(source, message));
    await this.context.addInitScript({ content: this.source });
    this.context.on('page', page => {
      // newPage emits before resolving. Seed pages are marked immediately after it resolves.
      setImmediate(() => this.track(page));
    });
    this.context.on('close', () => {
      this.ready = false;
      this.lnaCdp = null;
      clearInterval(this.timer);
      this.control.release();
      this.emit('change', this.summary());
      if (!this.stopping) this.emit('unexpectedClose');
    });
    for (const page of this.context.pages()) this.track(page);
    if (this.config.attachCDP || this.config.cdpPort) {
      this.tabOrder = new NativeTabOrder();
      this.tabOrder.on('change', () => this.emit('change', this.summary()));
      await this.tabOrder.start(this.config.attachCDP || `http://127.0.0.1:${this.config.cdpPort}`).catch(() => {});
    }
    this.ready = true;
    this.timer = setInterval(() => this.tick(), 1500);
    this.timer.unref();
    this.emit('change', this.summary());
  }

  // Chromium 142+ enables Local Network Access (LNA) checks that block public-IP
  // sites from fetching or embedding private/ULA intranet hosts in headless mode
  // where no interactive permission prompt can be accepted. Chromium resets
  // Browser.setPermission overrides whenever the CDP session detaches, so keep a
  // browser-level CDP session open for the lifetime of BrowserService.
  async grantLocalNetworkAccess() {
    if (!this.context) return;
    await this.lnaCdp?.detach?.().catch(() => {});
    this.lnaCdp = null;
    try {
      const browser = this.context.browser?.();
      if (typeof browser?.newBrowserCDPSession === 'function') {
        this.lnaCdp = await browser.newBrowserCDPSession();
      } else {
        const page = this.context.pages?.()?.[0];
        if (page && typeof this.context.newCDPSession === 'function') {
          this.lnaCdp = await this.context.newCDPSession(page);
        }
      }
      if (!this.lnaCdp) return;
      for (const name of ['local-network-access', 'local-network', 'loopback-network']) {
        await this.lnaCdp.send('Browser.setPermission', {
          permission: { name },
          setting: 'granted',
        }).catch(() => {});
      }
    } catch { /* Older Chromium builds do not implement LNA permissions. */ }
  }

  async setViewport({ width, height } = {}) {
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 640 || w > 3840 || h < 360 || h > 2160) return false;
    if (this.viewport && Math.abs(this.viewport.width - w) < 4 && Math.abs(this.viewport.height - h) < 4) return false;
    this.pendingViewport = { width: w, height: h };
    if (this.resizingViewport) return true;
    this.resizingViewport = true;
    try {
      while (this.pendingViewport) {
        const next = this.pendingViewport;
        this.pendingViewport = null;
        if (this.viewport && Math.abs(this.viewport.width - next.width) < 4 && Math.abs(this.viewport.height - next.height) < 4) continue;
        this.viewport = next;
        const activeTabs = [...this.tabs.values()].filter(tab => !tab.hidden && !tab.page.isClosed());
        await Promise.all(activeTabs.map(tab => tab.page.setViewportSize(next).catch(() => {})));
        await Promise.all(activeTabs
          .filter(tab => this.screencast.hasViewers(tab.id))
          .map(tab => this.screencast.updateViewport(tab.id, next).catch(() => {})));
        this.emit('change', this.summary());
      }
    } finally {
      this.resizingViewport = false;
    }
    return true;
  }

  isTabWatched(tabId) { return checkTabWatched(this, tabId); }
  syncTabWatched(tab) { return runSyncTabWatched(this, tab); }
  syncAllRecorderWatchState() { return runSyncAllRecorderWatchState(this); }
  handleDownload(tab, download) { return runHandleDownload(this, tab, download); }

  downloadsSummary() {
    return [...this.downloads.values()]
      .filter(item => item.status === 'ready' || item.status === 'downloading')
      .slice(-10)
      .reverse()
      .map(({ id, tabId, filename, size, status, createdAt }) => ({ id, tabId, filename, size, status, createdAt }));
  }

  getDownload(id) {
    const item = this.downloads.get(id);
    if (!item || item.status !== 'ready') return null;
    return item;
  }

  track(page) {
    if (page.isClosed() || this.hiddenPages.has(page) || [...this.tabs.values()].some(tab => tab.page === page)) return;
    let orderRank = null;
    for (const item of this.tabs.values()) {
      if (Number.isFinite(item.orderRank)) orderRank = Math.max(orderRank ?? 0, item.orderRank + 1000);
    }
    const tab = {
      id: randomUUID(), page, title: '', url: page.url(), favicon: null, faviconUrlFor: null,
      createdAt: new Date().toISOString(),
      recordedAt: null, recording: null, sanitizer: null, documentId: null, busy: false, hidden: false,
      recordingStatus: 'starting', resourceTasks: new Set(), orderRank,
      lastWatched: false, refreshing: false, originObserved: false,
    };
    this.tabs.set(tab.id, tab);
    attachTabDiagnostics(tab, (kind, entry) => this.emit('devtools', { tabId: tab.id, kind, entry }));
    const currentViewport = page.viewportSize();
    if (this.viewport && (!currentViewport || currentViewport.width !== this.viewport.width || currentViewport.height !== this.viewport.height)) {
      page.setViewportSize(this.viewport).catch(() => {}).finally(() => {
        if (this.screencast.sessions.size > 0) this.screencast.resyncBounds();
      });
    } else if (this.screencast.sessions.size > 0) {
      this.screencast.resyncBounds();
    }
    this.emit('change', this.summary());
    const refresh = () => {
      tab.loading = false;
      this.screencast.noteActivity(tab.id);
      this.refresh(tab, { refreshFavicon: true });
      this.ensureRecorder(tab);
      this.refreshHistory(tab);
    };
    page.on('domcontentloaded', refresh);
    page.on('load', refresh);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) refresh(); });
    page.on('dialog', dialog => {
      tab.pendingDialog = dialog;
      // Never copy dialog text from untrusted web pages.
      tab.dialog = { type: dialog.type(), closing: Boolean(tab.closing), hasPrompt: dialog.type() === 'prompt' };
      this.emit('change', this.summary());
    });
    page.on('dialogclosed', () => {
      tab.dialog = null;
      tab.pendingDialog = null;
      this.emit('change', this.summary());
    });
    page.on('download', download => {
      this.handleDownload(tab, download).catch(() => {});
    });
    page.on('crash', () => {
      tab.documentId = null;
      tab.recording = null;
      tab.sanitizer = null;
      tab.recordingStatus = 'crashed';
      tab.crashed = true;
      tab.lastWatched = false;
      this.screencast.removeTab(tab.id).catch(() => {});
      this.emit('tab-crashed', { tabId: tab.id, url: tab.url });
      this.emit('recording', { type: 'rrweb-reset', tabId: tab.id, documentId: null });
      this.emit('change', this.summary());
    });
    page.on('response', response => this.captureResource(tab, response));
    page.on('request', request => {
      // Authentication redirects and top-level navigation discover new origins;
      // do not disclose request paths, query strings or arbitrary page contents.
      if (this.importing || tab.hidden || this.hiddenPages.has(page)) return;
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) this.emit('cookie-origin', request.url());
    });
    page.on('close', () => {
      clearTimeout(tab.agentCooldownTimer);
      this.tabs.delete(tab.id);
      for (const [sid, tid] of this.sessionTabs) {
        if (tid === tab.id) this.sessionTabs.delete(sid);
      }
      this.assets.removeScope(tab.id);
      this.screencast.removeTab(tab.id).catch(() => {});
      tab.cdp?.detach().catch(() => {});
      this.pruneAgentSessions();
      this.tabOrder?.refresh().catch(() => {});
      this.emit('change', this.summary());
    });
    refresh();
    this.captureCachedResources(tab).catch(() => {});
  }

  pruneAgentSessions() {
    if (this.agentSessions.size <= MAX_AGENT_SESSIONS) return;
    const activeIds = new Set();
    for (const tab of this.tabs.values()) {
      if (tab.ownerSession) activeIds.add(tab.ownerSession);
      if (tab.agentMeta?.sessionId) activeIds.add(tab.agentMeta.sessionId);
    }
    for (const sid of [...this.agentSessions.keys()]) {
      if (this.agentSessions.size <= MAX_AGENT_SESSIONS) break;
      if (!activeIds.has(sid)) this.agentSessions.delete(sid);
    }
  }

  readPageFavicon(tab) { return runReadPageFavicon(tab); }
  refresh(tab, options) { return runRefreshTab(this, tab, options); }
  refreshHistory(tab) { return runRefreshHistory(this, tab); }

  summary() {
    const now = Date.now();
    const tabs = orderedTabs([...this.tabs.values()].filter(tab => !tab.hidden), this.tabOrder);
    const sessionsById = new Map();
    const tabSummaries = tabs.map(tab => {
      const meta = tab.agentMeta || (tab.ownerSession ? this.agentSessions.get(tab.ownerSession) : null);
      const active = Boolean(tab.agentBusy || (tab.agentActiveUntil && now < tab.agentActiveUntil));
      const agent = meta ? {
        sessionId: meta.sessionId,
        agent: meta.agent,
        label: meta.label,
        workspace: meta.workspace || null,
        color: meta.color,
        busy: Boolean(tab.agentBusy),
        active,
        action: active ? (tab.agentAction || null) : null,
        updatedAt: tab.agentUpdatedAt || null,
      } : null;
      if (agent) {
        const prev = sessionsById.get(meta.sessionId);
        if (!prev) {
          sessionsById.set(meta.sessionId, {
            sessionId: meta.sessionId,
            agent: meta.agent,
            label: meta.label,
            workspace: meta.workspace || null,
            color: meta.color,
            active,
            busy: Boolean(tab.agentBusy),
            action: agent.action,
            primaryTabId: tab.id,
            tabCount: 1,
            updatedAt: tab.agentUpdatedAt || 0,
          });
        } else {
          prev.tabCount += 1;
          if (active) prev.active = true;
          if (tab.agentBusy) prev.busy = true;
          if ((tab.agentUpdatedAt || 0) >= prev.updatedAt) {
            prev.updatedAt = tab.agentUpdatedAt || 0;
            prev.primaryTabId = tab.id;
            if (agent.action) prev.action = agent.action;
          }
        }
      }
      return {
        id: tab.id, title: tab.title || '新标签页', url: tab.url, favicon: tab.favicon || null,
        createdAt: tab.createdAt, recordedAt: tab.recordedAt, dialog: tab.dialog || null,
        documentId: tab.documentId, recordingStatus: tab.recordingStatus,
        index: this.tabOrder?.get(tab.targetId)?.index ?? null,
        nativeTabId: this.tabOrder?.get(tab.targetId)?.nativeTabId ?? null,
        windowId: tab.windowId ?? null, pinned: this.tabOrder?.get(tab.targetId)?.pinned || false,
        loading: Boolean(tab.loading), canGoBack: Boolean(tab.canGoBack), canGoForward: Boolean(tab.canGoForward),
        agent,
      };
    });
    return {
      ready: this.ready,
      importing: this.importing,
      viewport: this.viewport,
      screencast: {
        quality: this.screencast.defaultQuality,
        retina: this.screencast.defaultRetina,
        retinaCapable: this.deviceScaleFactor >= 2 && !this.config.attachCDP,
      },
      transport: 'rrweb',
      lifecycle: this.config.attachCDP ? 'attached' : 'owned',
      control: this.control.summary(),
      tabOrder: tabs.length > 0 && tabs.every(tab => this.tabOrder?.get(tab.targetId)) ? 'chromium' : 'discovery',
      activeTabId: tabs.find(tab => this.tabOrder?.get(tab.targetId)?.active)?.id || null,
      agentSessions: [...sessionsById.values()],
      downloads: this.downloadsSummary(),
      tabs: tabSummaries,
    };
  }

  setViewer(id, selected = null, paused = false, viewMode = 'browser') {
    this.viewers.set(id, { selected, paused, viewMode });
    this.syncAllRecorderWatchState();
  }

  removeViewer(id) {
    this.viewers.delete(id);
    this.control.release(id);
    this.screencast.removeViewer(id).catch(() => {}).finally(() => this.syncAllRecorderWatchState());
    this.syncAllRecorderWatchState();
  }

  async enableScreencast(viewerId, tabId, options = {}) {
    const tab = this.tabs.get(tabId);
    const ok = await this.screencast.enable(tab, viewerId, this.viewport, {
      getBrowserCdp: () => this.lnaCdp,
      quality: options.quality,
      retina: options.retina,
    });
    this.syncAllRecorderWatchState();
    return ok;
  }

  async disableScreencast(viewerId, tabId) {
    const res = tabId
      ? await this.screencast.disable(tabId, viewerId)
      : await this.screencast.removeViewer(viewerId);
    this.syncAllRecorderWatchState();
    return res;
  }

  performScreencastInput(id, input) { return runPerformScreencastInput(this, id, input); }

  async tick() {
    if (!this.ready || this.importing) return;
    this.tickCount = (this.tickCount + 1) >>> 0;
    this.control.expire();
    const hasViewer = this.viewers.size > 0;
    const now = Date.now();
    const hasActiveAgent = [...this.tabs.values()].some(tab =>
      !tab.hidden && (tab.agentBusy || (tab.agentActiveUntil && now < tab.agentActiveUntil)));
    const tabOrderIncomplete = Boolean(this.tabOrder && [...this.tabs.values()].some(tab =>
      !tab.hidden && tab.targetId && !this.tabOrder.get(tab.targetId)));
    if (hasViewer || tabOrderIncomplete) {
      this.tabOrder?.refresh().catch(() => {});
    }
    const shouldRefreshMeta = hasViewer || hasActiveAgent || (this.tickCount % 4 === 0);
    for (const tab of this.tabs.values()) {
      if (tab.hidden || tab.page.isClosed() || tab.crashed) continue;
      if (shouldRefreshMeta) this.refresh(tab, { fromTick: true });
      if (!tab.documentId) this.ensureRecorder(tab);
      if (hasViewer && tab.recording?.needsCheckpoint && this.isTabWatched(tab.id)) this.checkpoint(tab);
    }
  }

  ensureRecorder(tab) { return runEnsureRecorder(this, tab); }
  startDocument(tab, page, documentId) { return runStartDocument(this, tab, page, documentId); }
  reconcileRecorder(tab, page) { return runReconcileRecorder(this, tab, page); }
  receiveRecording(source, message) { return runReceiveRecording(this, source, message); }
  captureTaintedVideo(tab, message) { return runCaptureTaintedVideo(this, tab, message); }
  checkpoint(tab, force = false) { return runCheckpoint(this, tab, force); }

  cachedRecording(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.hidden) return null;
    return tab.recording?.snapshot() || null;
  }

  cachedRecordings() {
    return [...this.tabs.values()].filter(tab => !tab.hidden).map(tab => tab.recording?.snapshot()).filter(Boolean);
  }

  captureResource(tab, response) { return runCaptureResource(this, tab, response); }
  captureCachedResources(tab) { return runCaptureCachedResources(this, tab); }
  refillAsset(id) { return runRefillAsset(this, id); }

  acquireControl(id) {
    if (!this.ready || this.importing) throw new InputError('浏览器正在启动或导入登录态，不能接管。', 409);
    this.control.acquire(id);
  }

  performControl(id, input) { return runPerformControl(this, id, input); }
  dispatchControl(id, revision, command) { return runDispatchControl(this, id, revision, command); }
  getSelectionText(tabId) { return runGetSelectionText(this, tabId); }
  uploadFileToTab(tabId, file) { return runUploadFileToTab(this, tabId, file); }
  placeTabAfter(tab, afterTabId) { return runPlaceTabAfter(this, tab, afterTabId); }
  open(url = 'about:blank', options = {}) { return runOpenTab(this, url, options); }
  recoverCrashedTab(tab, targetUrl, options = {}) { return runRecoverCrashedTab(this, tab, targetUrl, options); }

  tabAction(tabId, action, options = {}) {
    // Only tab activation shares the input queue so delayed old-page clicks
    // cannot steal remote focus after switching tabs. Navigation, reload, stop,
    // close and dialog actions run concurrently across tabs like native Chrome
    // so a slow page load never blocks new tabs, URL overrides, or other tabs.
    if (action !== 'activate') {
      return this.dispatchTabAction(tabId, action, options);
    }
    const operation = this.controlQueue.then(() => this.dispatchTabAction(tabId, action, options));
    this.controlQueue = operation.catch(() => {});
    return operation;
  }

  _executeTabAction(tab, action, options = {}) { return runExecuteTabAction(this, tab, action, options); }
  dispatchTabAction(tabId, action, options = {}) { return runDispatchTabAction(this, tabId, action, options); }
  importSnapshot(snapshot) { return importSnapshotToBrowser(this, snapshot); }

  normalizeSession(sessionId) {
    return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim().slice(0, 200) : null;
  }

  ensureAgentSession({ sessionId = null, agent = null, workspace = null } = {}) {
    const sid = this.normalizeSession(sessionId) || 'default-agent';
    let normalizedAgent = typeof agent === 'string' && agent.trim() ? agent.trim().toLowerCase().slice(0, 32) : '';
    if (!normalizedAgent) {
      if (sid.includes('claude')) normalizedAgent = 'claude';
      else if (sid.includes('codex')) normalizedAgent = 'codex';
      else if (sid.includes('opencode')) normalizedAgent = 'opencode';
      else if (sid.includes('cursor')) normalizedAgent = 'cursor';
      else normalizedAgent = 'terminal';
    }
    const cleanWorkspace = typeof workspace === 'string' && workspace.trim() ? workspace.trim().slice(0, 48) : null;
    let entry = this.agentSessions.get(sid);
    if (!entry) {
      const count = (this.agentTypeCounters.get(normalizedAgent) || 0) + 1;
      this.agentTypeCounters.set(normalizedAgent, count);
      const color = SESSION_PALETTE[(this.paletteCounter++) % SESSION_PALETTE.length];
      const baseName = AGENT_NAMES[normalizedAgent] || 'Agent';
      entry = {
        sessionId: sid,
        agent: normalizedAgent,
        number: count,
        label: `${baseName} #${count}`,
        workspace: cleanWorkspace,
        color,
      };
      this.agentSessions.set(sid, entry);
      this.pruneAgentSessions();
    } else if (cleanWorkspace && !entry.workspace) {
      entry.workspace = cleanWorkspace;
    }
    return entry;
  }

  async withAgentActivity(tab, context, actionKey, operation) {
    if (!tab) return operation();
    const meta = this.ensureAgentSession(context);
    tab.agentMeta = meta;
    tab.agentBusy = true;
    tab.agentAction = ACTION_LABELS[actionKey] || actionKey;
    tab.agentUpdatedAt = Date.now();
    tab.agentActiveUntil = Date.now() + 2600;
    this.screencast.noteActivity(tab.id);
    clearTimeout(tab.agentCooldownTimer);
    this.emit('change', this.summary());
    try {
      return await operation();
    } finally {
      tab.agentBusy = false;
      tab.agentActiveUntil = Date.now() + 2400;
      clearTimeout(tab.agentCooldownTimer);
      if (!tab.page.isClosed()) {
        tab.agentCooldownTimer = setTimeout(() => {
          tab.agentCooldownTimer = null;
          if (this.tabs.has(tab.id) && !tab.agentBusy) this.emit('change', this.summary());
        }, 2450);
        tab.agentCooldownTimer.unref?.();
      }
      this.emit('change', this.summary());
    }
  }

  sessionTabId(sessionId) {
    const sid = this.normalizeSession(sessionId);
    if (!sid) return null;
    const tid = this.sessionTabs.get(sid);
    const tab = tid ? this.tabs.get(tid) : null;
    if (!tab || tab.hidden || tab.page.isClosed()) {
      this.sessionTabs.delete(sid);
      return null;
    }
    return tid;
  }

  bindSessionTab(sessionId, tabId) {
    const sid = this.normalizeSession(sessionId);
    if (!sid || !tabId) return;
    this.sessionTabs.set(sid, tabId);
    const tab = this.tabs.get(tabId);
    if (tab && !tab.ownerSession) tab.ownerSession = sid;
  }

  async waitReady(timeoutMs = 15000) {
    if (!this.ready) throw new InputError('浏览器尚未就绪。', 409);
    if (!this.importing) return;
    const deadline = Date.now() + timeoutMs;
    while (this.importing && Date.now() < deadline) {
      await Promise.race([
        this.activeImport || new Promise(resolve => this.once('change', resolve)),
        new Promise(resolve => setTimeout(resolve, Math.max(50, deadline - Date.now()))),
      ]);
    }
    if (!this.ready || this.importing) throw new InputError('浏览器正在导入登录态，请稍后重试。', 409);
  }

  checkAgentTabAccess() {
    this.control.expire();
  }

  runOnTab(tab, operation) {
    const next = (tab.agentQueue || Promise.resolve()).then(operation);
    tab.agentQueue = next.catch(() => {});
    return next;
  }

  async agentOpen(url = 'about:blank', options = {}) {
    const { sessionId = null } = options;
    await this.waitReady();
    if (url !== 'about:blank') httpOrigin(url);
    const visibleBefore = [...this.tabs.values()].filter(item => !item.hidden && !item.page.isClosed());
    const onlyBlankBefore = visibleBefore.every(item => item.url === 'about:blank');
    const page = await this.context.newPage();
    this.track(page);
    const tab = [...this.tabs.values()].find(item => item.page === page);
    const sid = this.normalizeSession(sessionId);
    if (sid) tab.ownerSession = sid;
    this.bindSessionTab(sid, tab.id);
    await this.withAgentActivity(tab, options, 'open', async () => {
      if (url !== 'about:blank') {
        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      await this.refresh(tab);
      await this.ensureRecorder(tab);
      if (onlyBlankBefore) {
        await page.bringToFront().catch(() => {});
      }
      await this.tabOrder?.refresh().catch(() => {});
    });
    return tab.id;
  }

  resolveTab(tabId, sessionId = null) {
    if (!this.ready) throw new InputError('浏览器尚未就绪。', 409);
    const visible = orderedTabs([...this.tabs.values()].filter(tab => !tab.hidden && !tab.page.isClosed()), this.tabOrder);
    if (!visible.length) throw new InputError('当前没有打开的标签页，请先使用 ditto open <url> 打开网页。', 404);
    const sid = this.normalizeSession(sessionId);
    if (!tabId) {
      const boundId = this.sessionTabId(sid);
      if (boundId) return visible.find(tab => tab.id === boundId);
      if (visible.length === 1 && (!visible[0].ownerSession || visible[0].ownerSession === sid)) {
        this.bindSessionTab(sid, visible[0].id);
        return visible[0];
      }
      throw new InputError('当前存在多个或归属其他会话的标签页。为避免多会话冲突，请先执行 ditto open <url> 创建当前会话专属标签页，或加 --tab <tabId> 指定目标标签页。', 409);
    }
    const key = String(tabId).trim();
    let found = visible.find(tab => tab.id === key);
    if (!found && /^\d+$/.test(key)) {
      const index = Number(key) - 1;
      if (index >= 0 && index < visible.length) found = visible[index];
    }
    if (!found) {
      const matches = visible.filter(tab => tab.id.startsWith(key));
      if (matches.length > 1) throw new InputError('标签页 ID 前缀匹配到多个标签页，请传入更完整的 ID。', 400);
      found = matches[0];
    }
    if (!found) throw new InputError('未找到指定的远端标签页。', 404);
    this.bindSessionTab(sid, found.id);
    return found;
  }

  async agentTabAction(tabId, action, options = {}) {
    const { url, sessionId = null, promptText } = options;
    await this.waitReady();
    const allowed = ['activate', 'navigate', 'reload', 'back', 'forward', 'close',
      'confirm-close', 'cancel-close', 'accept-dialog', 'dismiss-dialog'];
    if (!allowed.includes(action)) throw new InputError('不支持的标签页操作。');
    const tab = this.resolveTab(tabId, sessionId);
    this.checkAgentTabAccess(tab);
    // Dialog dismissal/acceptance must never deadlock behind an in-flight action
    // that triggered the native dialog and is waiting for the JS thread to unblock.
    if (['confirm-close', 'cancel-close', 'accept-dialog', 'dismiss-dialog'].includes(action)) {
      return this.withAgentActivity(tab, options, action, () =>
        this._executeTabAction(tab, action, { url, promptText, bringToFront: false }));
    }
    return this.runOnTab(tab, () => this.withAgentActivity(tab, options, action, async () => {
      await this.waitReady();
      if (tab.page.isClosed()) throw new InputError('这个远端标签页已关闭。', 404);
      return this._executeTabAction(tab, action, { url, promptText, bringToFront: false });
    }));
  }

  agentSnapshot(tabId, options = {}) { return runAgentSnapshot(this, tabId, options); }
  agentAct(tabId, options = {}) { return runAgentAct(this, tabId, options); }
  agentEvaluate(tabId, expression, options = {}) { return runAgentEvaluate(this, tabId, expression, options); }
  agentScreenshot(tabId, options = {}) { return runAgentScreenshot(this, tabId, options); }
  agentConsole(tabId, options = {}) { return runAgentConsole(this, tabId, options); }
  agentNetwork(tabId, options = {}) { return runAgentNetwork(this, tabId, options); }
  devtoolsSnapshot(tabId) { return runDevtoolsSnapshot(this, tabId); }
  devtoolsClear(tabId, target) { return runDevtoolsClear(this, tabId, target); }
  devtoolsEvaluate(tabId, expression) { return runDevtoolsEvaluate(this, tabId, expression); }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.ready = false;
    clearInterval(this.timer);
    this.control.release();
    await this.screencast.stopAll().catch(() => {});
    await this.lnaCdp?.detach?.().catch(() => {});
    this.lnaCdp = null;
    this.tabOrder?.close();
    this.tabOrder = null;
    for (const tab of this.tabs.values()) {
      await tab.page.evaluate(key => { window[key]?.stop(); delete window[key]; }, RECORDER_KEY).catch(() => {});
      await tab.cdp?.detach().catch(() => {});
    }
    if (this.downloadsDir) await rm(this.downloadsDir, { recursive: true, force: true }).catch(() => {});
    if (this.config.attachCDP) { await this.connection?.close(); this.connection = null; }
    else await this.context?.close();
  }
}
