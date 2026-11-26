import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivateJson } from './files.js';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function envValue(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseBool(envRaw, fileVal, fallback) {
  if (envRaw !== undefined) {
    const low = envRaw.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(low)) return true;
    if (['0', 'false', 'no', 'off'].includes(low)) return false;
    throw new Error(`Invalid boolean value: ${envRaw}`);
  }
  if (fileVal !== undefined && fileVal !== null) {
    if (typeof fileVal !== 'boolean') throw new Error('Invalid boolean option in config file.');
    return fileVal;
  }
  return fallback;
}

function port(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error('Invalid listener port.');
  }
  return parsed;
}

function viewport(value) {
  if (value === undefined || value === null || value === '') return { width: 1920, height: 1080 };
  if (typeof value === 'object' && !Array.isArray(value)) {
    const width = Number(value.width);
    const height = Number(value.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 320 || width > 7680 || height < 320 || height > 4320) {
      throw new Error('Invalid viewport; use WIDTHxHEIGHT, for example 1920x1080.');
    }
    return { width, height };
  }
  const match = /^(\d{3,4})x(\d{3,4})$/i.exec(String(value).trim());
  const width = match ? Number(match[1]) : NaN;
  const height = match ? Number(match[2]) : NaN;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
    width < 320 || width > 7680 || height < 320 || height > 4320) {
    throw new Error('Invalid viewport; use WIDTHxHEIGHT, for example 1920x1080.');
  }
  return { width, height };
}

function normalizeToken(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('Invalid token in config file.');
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/[\r\n\0]/.test(trimmed)) throw new Error('Invalid token: control characters are not allowed.');
  if (trimmed.length > 512) throw new Error('Invalid token: maximum length is 512 characters.');
  return trimmed;
}

const VALID_SCREENCAST_QUALITIES = new Set(['smooth', 'balanced', 'high', 'lossless']);

function screencastQuality(envRaw, fileVal) {
  const raw = envRaw !== undefined ? envRaw : fileVal;
  if (raw === undefined || raw === null || raw === '') return 'balanced';
  const normalized = String(raw).trim().toLowerCase();
  if (!VALID_SCREENCAST_QUALITIES.has(normalized)) {
    throw new Error('Invalid screencastQuality; use smooth, balanced, high, or lossless.');
  }
  return normalized;
}

function deviceScaleFactor(envRaw, fileVal) {
  const raw = envRaw !== undefined ? envRaw : fileVal;
  if (raw === undefined || raw === null || raw === '') return 2;
  const parsed = Number(raw);
  if (parsed !== 1 && parsed !== 2) {
    throw new Error('Invalid deviceScaleFactor; use 1 or 2.');
  }
  return parsed;
}

function loadConfigFile(filePath) {
  if (!filePath) return { data: {}, loaded: false };
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid config file (${filePath}): root must be a JSON object.`);
    }
    return { data: parsed, loaded: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { data: {}, loaded: false };
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file (${filePath}).`);
    }
    throw error;
  }
}

export async function writeConfig(filePath, data) {
  await writePrivateJson(filePath, data);
}

export function configuration(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir || envValue('DITTO_DATA_DIR') || path.join(projectRoot, '.local'));
  const rawConfigFile = overrides.configFile !== undefined ? overrides.configFile : envValue('DITTO_CONFIG');
  const configFile = rawConfigFile === null || rawConfigFile === ''
    ? null
    : path.resolve(rawConfigFile || path.join(dataDir, 'config.json'));
  const { data: file, loaded: configFileLoaded } = loadConfigFile(configFile);

  const rawFresh = envValue('DITTO_SYNC_FRESH_MS') ?? file.syncFreshMs;
  const freshMs = rawFresh === undefined || rawFresh === null ? NaN : Number(rawFresh);

  const rawLogFile = process.env.DITTO_LOG_FILE !== undefined
    ? process.env.DITTO_LOG_FILE
    : (file.logFile !== undefined ? file.logFile : undefined);
  const logFile = rawLogFile === undefined
    ? path.join(dataDir, 'logs', 'ditto.log')
    : (rawLogFile === null || ['', '0', 'off', 'none', 'false'].includes(String(rawLogFile).trim().toLowerCase())
      ? null
      : path.resolve(String(rawLogFile).trim()));

  const envToken = envValue('DITTO_TOKEN');
  const token = overrides.token !== undefined
    ? normalizeToken(overrides.token)
    : normalizeToken(envToken !== undefined ? envToken : file.token);

  const envAuth = envValue('DITTO_AUTH');
  const authRequired = overrides.authRequired !== undefined
    ? Boolean(overrides.authRequired)
    : (envAuth !== undefined
      ? parseBool(envAuth, undefined, false)
      : (file.authRequired !== undefined && file.authRequired !== null
        ? parseBool(undefined, file.authRequired, false)
        : Boolean(token)));

  const hostRaw = envValue('DITTO_HOST') ?? (typeof file.host === 'string' && file.host.trim() ? file.host.trim() : '0.0.0.0');
  const userAgentRaw = envValue('DITTO_USER_AGENT') ?? (typeof file.userAgent === 'string' && file.userAgent.trim() ? file.userAgent.trim() : undefined);

  return {
    host: hostRaw,
    port: port(envValue('DITTO_PORT') ?? file.port, 3217),
    cdpPort: port(envValue('DITTO_CDP_PORT') ?? file.cdpPort, 9222),
    token,
    authRequired,
    agentAllowRemote: parseBool(envValue('DITTO_AGENT_REMOTE'), file.agentAllowRemote, false),
    logging: parseBool(envValue('DITTO_LOG'), file.logging, true) && !process.env.NODE_TEST_CONTEXT,
    logFile,
    syncFreshMs: Number.isFinite(freshMs) && freshMs >= 0 ? freshMs : 5 * 60 * 1000,
    userAgent: userAgentRaw,
    dataDir,
    configFile,
    configFileLoaded,
    chromiumPath: envValue('DITTO_CHROMIUM_PATH') || undefined,
    attachCDP: envValue('DITTO_ATTACH_CDP') || undefined,
    syncUpstream: envValue('DITTO_SYNC_UPSTREAM') || undefined,
    demo: parseBool(envValue('DITTO_DEMO'), file.demo, true),
    viewport: viewport(envValue('DITTO_VIEWPORT') ?? file.viewport),
    deviceScaleFactor: deviceScaleFactor(envValue('DITTO_DEVICE_SCALE_FACTOR'), file.deviceScaleFactor),
    screencastQuality: screencastQuality(envValue('DITTO_SCREENCAST_QUALITY'), file.screencastQuality),
    screencastRetina: parseBool(envValue('DITTO_SCREENCAST_RETINA'), file.screencastRetina, false),
    restoreTabs: parseBool(envValue('DITTO_RESTORE_TABS'), file.restoreTabs, true),
    publicDir: path.join(projectRoot, 'public'),
    ...overrides,
    // Keep normalized/derived fields consistent when overrides passed dataDir/token.
    ...(overrides.token !== undefined ? { token } : {}),
    ...(overrides.authRequired !== undefined ? { authRequired: Boolean(overrides.authRequired) } : { authRequired }),
    ...(overrides.dataDir !== undefined ? { dataDir } : {}),
    ...(overrides.configFile !== undefined ? { configFile } : {}),
  };
}
