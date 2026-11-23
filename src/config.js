import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function port(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error('Invalid listener port.');
  }
  return parsed;
}

function viewport(value) {
  if (value === undefined || value === '') return { width: 1920, height: 1080 };
  const match = /^(\d{3,4})x(\d{3,4})$/i.exec(String(value).trim());
  const width = match ? Number(match[1]) : NaN;
  const height = match ? Number(match[2]) : NaN;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
    width < 320 || width > 7680 || height < 320 || height > 4320) {
    throw new Error('Invalid viewport; use WIDTHxHEIGHT, for example 1920x1080.');
  }
  return { width, height };
}

export function configuration(overrides = {}) {
  const freshMs = Number(process.env.DITTO_SYNC_FRESH_MS);
  const dataDir = path.resolve(process.env.DITTO_DATA_DIR || path.join(projectRoot, '.local'));
  const rawLogFile = process.env.DITTO_LOG_FILE;
  const logFile = rawLogFile === undefined
    ? path.join(dataDir, 'logs', 'ditto.log')
    : (['', '0', 'off', 'none', 'false'].includes(rawLogFile.trim().toLowerCase()) ? null : path.resolve(rawLogFile.trim()));
  return {
    host: (process.env.DITTO_HOST || '0.0.0.0').trim(),
    port: port(process.env.DITTO_PORT, 3217),
    cdpPort: port(process.env.DITTO_CDP_PORT, 9222),
    authRequired: process.env.DITTO_AUTH === '1',
    agentAllowRemote: process.env.DITTO_AGENT_REMOTE === '1',
    logging: process.env.DITTO_LOG !== '0' && !process.env.NODE_TEST_CONTEXT,
    logFile,
    syncFreshMs: Number.isFinite(freshMs) && freshMs >= 0 ? freshMs : 5 * 60 * 1000,
    userAgent: process.env.DITTO_USER_AGENT?.trim() || undefined,
    dataDir,
    chromiumPath: process.env.DITTO_CHROMIUM_PATH || undefined,
    attachCDP: process.env.DITTO_ATTACH_CDP || undefined,
    syncUpstream: process.env.DITTO_SYNC_UPSTREAM || undefined,
    demo: process.env.DITTO_DEMO !== '0',
    viewport: viewport(process.env.DITTO_VIEWPORT),
    publicDir: path.join(projectRoot, 'public'),
    ...overrides,
  };
}
