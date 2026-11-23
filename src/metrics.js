import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

const CATEGORY_ORDER = ['renderer', 'service', 'browser', 'other'];
const CATEGORY_LABELS = {
  renderer: '网页渲染',
  service: 'Ditto 服务',
  browser: '浏览器内核',
  other: '其他进程',
};

export function parseProcStatus(text) {
  const name = text.match(/^Name:\s*(.+)$/m)?.[1]?.trim() || '';
  const ppid = Number(text.match(/^PPid:\s*(\d+)/m)?.[1] || 0);
  const rssKb = Number(text.match(/^VmRSS:\s*(\d+)/m)?.[1] || 0);
  const swapKb = Number(text.match(/^VmSwap:\s*(\d+)/m)?.[1] || 0);
  return { name, ppid, rssBytes: rssKb * 1024, swapBytes: swapKb * 1024 };
}

export function parseSmapsRollup(text) {
  if (!text) return null;
  const pssKb = text.match(/^Pss:\s*(\d+)/m)?.[1];
  return pssKb !== undefined ? Number(pssKb) * 1024 : null;
}

export function parsePsOutput(stdout) {
  const list = [];
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssBytes = Number(match[3]) * 1024;
    const comm = match[4];
    const args = match[5] || '';
    const name = comm.split('/').pop() || comm;
    list.push({ pid, ppid, name, rssBytes, pssBytes: null, swapBytes: 0, cmdline: args });
  }
  return list;
}

export function filterDescendantTree(processes, rootPids) {
  const roots = new Set([...rootPids].filter(id => Number.isInteger(id) && id > 0));
  if (!roots.size) return [];
  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  const isIncluded = pid => {
    const seen = new Set();
    let cur = pid;
    while (cur && !seen.has(cur)) {
      if (roots.has(cur)) return true;
      seen.add(cur);
      cur = byPid.get(cur)?.ppid;
    }
    return false;
  };
  return processes.filter(proc => isIncluded(proc.pid));
}

export function classifyProcess(proc, selfPid) {
  if (proc.pid === selfPid) return { category: 'service', label: 'Ditto 服务 (Node)' };
  const cmd = String(proc.cmdline || '');
  const name = String(proc.name || '').toLowerCase();
  const type = cmd.match(/--type=([^\x00\s]+)/)?.[1] || '';
  const utilSub = cmd.match(/--utility-sub-type=([^\x00\s]+)/)?.[1]?.split('.').pop() || '';
  const isBrowserBin = /chrom|headless_shell|playwright/i.test(name) || /--type=/.test(cmd);

  if (type === 'renderer') return { category: 'renderer', label: '网页渲染进程' };
  if (type === 'gpu-process') return { category: 'browser', label: 'GPU 进程' };
  if (type === 'zygote' || type === 'broker') return { category: 'browser', label: '进程孵化器' };
  if (type === 'utility') {
    if (utilSub === 'NetworkService') return { category: 'browser', label: '网络服务' };
    if (utilSub === 'StorageService') return { category: 'browser', label: '存储服务' };
    if (utilSub === 'AudioService') return { category: 'browser', label: '音频服务' };
    return { category: 'browser', label: '工具进程' };
  }
  if (name === 'node' || name.startsWith('node')) return { category: 'service', label: 'Node 子进程' };
  if (isBrowserBin) return { category: 'browser', label: '浏览器主进程' };
  return { category: 'other', label: proc.name || `PID ${proc.pid}` };
}

async function readLinuxProcesses() {
  const entries = await readdir('/proc');
  const pids = entries.filter(name => /^\d+$/.test(name));
  const results = await Promise.all(pids.map(async pidText => {
    try {
      const [statusText, rollupText, cmdText] = await Promise.all([
        readFile(`/proc/${pidText}/status`, 'utf8'),
        readFile(`/proc/${pidText}/smaps_rollup`, 'utf8').catch(() => null),
        readFile(`/proc/${pidText}/cmdline`, 'utf8').catch(() => ''),
      ]);
      const parsed = parseProcStatus(statusText);
      const pssBytes = parseSmapsRollup(rollupText);
      return {
        pid: Number(pidText),
        ppid: parsed.ppid,
        name: parsed.name,
        rssBytes: parsed.rssBytes,
        pssBytes,
        swapBytes: parsed.swapBytes,
        cmdline: cmdText.replace(/\0+/g, ' '),
      };
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}

async function readPsProcesses() {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,comm=,args='], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 3000,
    });
    return parsePsOutput(stdout);
  } catch {
    return [];
  }
}

async function readCgroupLimitBytes(systemTotalBytes) {
  if (process.platform !== 'linux') return null;
  const candidates = [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ];
  for (const file of candidates) {
    try {
      const raw = (await readFile(file, 'utf8')).trim();
      if (!raw || raw === 'max') continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0 && value < systemTotalBytes * 0.99) return value;
    } catch { /* ignore */ }
  }
  return null;
}

function safeHost(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.host || rawUrl;
  } catch {
    return rawUrl || '';
  }
}

export async function collectMemoryMetrics({ browser = null, pid = process.pid, extraRootPids = [], platform = process.platform, readProcesses = null } = {}) {
  const browserPid = browser?.context?.browser?.()?.process?.()?.pid || browser?.browser?.process?.()?.pid || null;
  const roots = [pid, browserPid, ...extraRootPids].filter(id => Number.isInteger(id) && id > 0);
  const all = readProcesses
    ? await readProcesses()
    : platform === 'linux' ? await readLinuxProcesses() : await readPsProcesses();
  let tree = filterDescendantTree(all, roots);

  const mem = process.memoryUsage();
  if (!tree.some(proc => proc.pid === pid)) {
    tree = [{ pid, ppid: 0, name: 'node', rssBytes: mem.rss, pssBytes: null, swapBytes: 0, cmdline: '' }, ...tree];
  }

  const hasPss = tree.some(proc => Number.isFinite(proc.pssBytes) && proc.pssBytes > 0);
  const processes = tree.map(proc => {
    const { category, label } = classifyProcess(proc, pid);
    const bytes = (Number.isFinite(proc.pssBytes) && proc.pssBytes > 0) ? proc.pssBytes : proc.rssBytes;
    return {
      pid: proc.pid,
      category,
      label,
      bytes,
      rssBytes: proc.rssBytes,
      swapBytes: proc.swapBytes || 0,
    };
  }).sort((a, b) => b.bytes - a.bytes);

  const byCategory = new Map();
  let totalBytes = 0;
  let rssBytes = 0;
  let swapBytes = 0;
  for (const proc of processes) {
    totalBytes += proc.bytes;
    rssBytes += proc.rssBytes;
    swapBytes += proc.swapBytes;
    const item = byCategory.get(proc.category) || {
      category: proc.category,
      label: CATEGORY_LABELS[proc.category] || proc.category,
      bytes: 0,
      count: 0,
    };
    item.bytes += proc.bytes;
    item.count += 1;
    byCategory.set(proc.category, item);
  }

  const summary = CATEGORY_ORDER
    .map(cat => byCategory.get(cat))
    .filter(Boolean)
    .sort((a, b) => b.bytes - a.bytes);

  const tabs = [];
  let recordingBytes = 0;
  if (browser?.tabs && typeof browser.tabs.values === 'function') {
    for (const tab of browser.tabs.values()) {
      if (tab.hidden) continue;
      const bytes = tab.recording?.bytes || 0;
      recordingBytes += bytes;
      tabs.push({
        id: tab.id,
        title: tab.url === 'about:blank' ? '新标签页' : (tab.title || '新标签页'),
        host: safeHost(tab.url),
        recordingBytes: bytes,
      });
    }
    tabs.sort((a, b) => b.recordingBytes - a.recordingBytes);
  }

  const systemTotalBytes = os.totalmem();
  const limitBytes = await readCgroupLimitBytes(systemTotalBytes);

  return {
    collectedAt: Date.now(),
    metric: hasPss ? 'pss' : 'rss',
    totalBytes,
    rssBytes,
    swapBytes,
    processCount: processes.length,
    systemTotalBytes,
    limitBytes,
    summary,
    node: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers || 0,
      assetCacheBytes: browser?.assets?.bytes || 0,
      assetCount: browser?.assets?.entries?.size || 0,
      recordingBytes,
    },
    tabs,
    processes: processes.slice(0, 32),
  };
}

export function createMemoryCollector({ browser = null, ttlMs = 2000 } = {}) {
  let cached = null;
  let expiresAt = 0;
  let inflight = null;
  return async ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && cached && now < expiresAt) return cached;
    if (!inflight) {
      inflight = collectMemoryMetrics({ browser })
        .then(result => {
          cached = result;
          expiresAt = Date.now() + ttlMs;
          return result;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  };
}
