import {
  clearViewerSessionCookie,
  installViewerSessionCookie,
  parsePairingInput,
  verifyPairing,
} from './capture.js';

const $ = id => document.getElementById(id);
let settings = null;
let toastTimer = null;

function result(message) {
  $('result').hidden = false;
  $('result').textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('result').hidden = true; }, 6000);
}

function paired() {
  $('paired').textContent = settings ? `已配对 ${settings.endpoint}` : '未配对';
  $('pairing-section').hidden = Boolean(settings);
  $('connected-bar').hidden = !settings;
}

const saved = await chrome.storage.local.get(['settings', 'autoSyncStatus']);
settings = saved.settings || null;
paired();

function showStatus(status = saved.autoSyncStatus) {
  const pill = $('automatic-status');
  const labels = { offline: '未连接', connecting: '连接中', online: '已连接' };
  if (!settings && !status?.paired) {
    pill.textContent = '未配对';
    pill.dataset.state = 'idle';
  } else if (status?.uploading) {
    pill.textContent = '同步中';
    pill.dataset.state = 'uploading';
  } else {
    pill.textContent = labels[status?.connection] || '连接中';
    pill.dataset.state = status?.connection === 'online' ? 'online' : 'idle';
  }

  const meta = $('last-sync-meta');
  if (!meta) return;
  if (status?.error) {
    meta.textContent = status.error;
  } else if (status?.lastUpload?.at) {
    const modeText = status.lastUpload.mode === 'full' ? '全量' : status.lastUpload.mode === 'tab' ? '新标签页' : '按需';
    const time = new Date(status.lastUpload.at).toLocaleTimeString();
    meta.textContent = `最近${modeText}同步 ${time} · ${status.lastUpload.cookieCount ?? 0} Cookie / ${status.lastUpload.storageCount ?? 0} Storage`;
  } else {
    meta.textContent = '每 5 分钟全量同步 Cookie · 新开页主动同步';
  }
}

showStatus();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.autoSyncStatus) showStatus(changes.autoSyncStatus.newValue);
});
chrome.runtime.sendMessage({ type: 'sync-status' }).then(response => showStatus(response?.status)).catch(() => {});

async function connectService() {
  try {
    $('save-pairing').disabled = true;
    const nextSettings = parsePairingInput($('pairing').value, $('pairing-token')?.value || '');
    const health = await fetch(`${nextSettings.endpoint}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!health?.ok) {
      throw new Error(`无法连接 ${nextSettings.endpoint}`);
    }
    const healthData = await health.json().catch(() => ({}));
    if (healthData.authRequired && !nextSettings.syncToken) {
      $('pairing-token')?.focus();
      throw new Error('该服务已开启鉴权，请填写访问 Token');
    }
    const verified = await verifyPairing(nextSettings);
    if (verified?.viewerSession) {
      await installViewerSessionCookie(nextSettings.endpoint, verified.viewerSession).catch(() => {});
    }
    settings = nextSettings;
    await chrome.storage.local.set({ settings });
    $('pairing').value = '';
    if ($('pairing-token')) $('pairing-token').value = '';
    paired();
    showStatus({ paired: true, connection: 'connecting' });
    result(verified?.viewerSession
      ? `已连接 ${settings.endpoint}，当前浏览器访问观测页将自动免登`
      : `已连接 ${settings.endpoint}`);
  } catch (error) {
    result(error.message || '地址格式无效，例如 http://10.0.0.2:3217');
  } finally {
    $('save-pairing').disabled = false;
  }
}

$('save-pairing').addEventListener('click', connectService);
$('pairing').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); connectService(); } });
$('pairing-token')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); connectService(); } });
$('sync').addEventListener('click', async () => {
  try {
    if (!settings) throw new Error('请先连接开发机地址');
    $('sync').disabled = true;
    const response = await chrome.runtime.sendMessage({ type: 'sync-now' });
    if (!response?.ok) throw new Error(response?.error || '同步未完成');
    const pending = response.pending;
    result(`已全量同步 ${pending.cookieCount ?? pending.importedCookies ?? 0} Cookie · ${pending.storageCount ?? pending.importedStorage ?? 0} Storage`);
  } catch (error) { result(error.message || '同步失败'); }
  finally { $('sync').disabled = false; }
});
$('viewer').addEventListener('click', async () => {
  if (!settings?.endpoint) { result('请先填写开发机地址'); return; }
  if (settings.syncToken && chrome.cookies?.get) {
    try {
      const existing = await chrome.cookies.get({ url: `${settings.endpoint}/api`, name: 'ditto_session' });
      if (!existing?.value) {
        const verified = await verifyPairing(settings);
        if (verified?.viewerSession) {
          await installViewerSessionCookie(settings.endpoint, verified.viewerSession);
        }
      }
    } catch { /* Still open viewer even if pre-auth fails. */ }
  }
  chrome.tabs.create({ url: settings.endpoint });
});
$('forget').addEventListener('click', async () => {
  const previous = settings?.endpoint || '';
  if (previous) await clearViewerSessionCookie(previous).catch(() => {});
  await chrome.storage.local.remove(['settings', 'origins', 'automaticSync', 'autoSyncStatus']);
  settings = null;
  $('pairing').value = previous;
  if ($('pairing-token')) $('pairing-token').value = '';
  showStatus(null);
  paired();
  $('pairing').focus();
});
