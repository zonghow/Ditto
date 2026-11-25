import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { configuration } from '../src/config.js';

function withViewport(value, run) {
  const previous = process.env.DITTO_VIEWPORT;
  if (value === undefined) delete process.env.DITTO_VIEWPORT;
  else process.env.DITTO_VIEWPORT = value;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.DITTO_VIEWPORT;
    else process.env.DITTO_VIEWPORT = previous;
  }
}

test('the remote viewport defaults to 1920x1080', () => {
  assert.deepEqual(withViewport(undefined, () => configuration().viewport), { width: 1920, height: 1080 });
});

test('an explicit viewport override is parsed and validated', () => {
  assert.deepEqual(withViewport('1440x900', () => configuration().viewport), { width: 1440, height: 900 });
  assert.deepEqual(withViewport(' 2560X1440 ', () => configuration().viewport), { width: 2560, height: 1440 });
  assert.throws(() => withViewport('1920*1080', () => configuration()), /viewport/);
  assert.throws(() => withViewport('0x0', () => configuration()), /viewport/);
  assert.throws(() => withViewport('99999x1080', () => configuration()), /viewport/);
});

test('an explicit configuration override wins over the environment', () => {
  withViewport('1440x900', () => {
    assert.deepEqual(configuration({ viewport: { width: 1280, height: 720 } }).viewport, { width: 1280, height: 720 });
  });
});

test('logFile defaults under dataDir, honors DITTO_LOG_FILE, and supports disabling', () => {
  const prev = process.env.DITTO_LOG_FILE;
  try {
    delete process.env.DITTO_LOG_FILE;
    const def = configuration();
    assert.equal(def.logFile, `${def.dataDir}/logs/ditto.log`);

    process.env.DITTO_LOG_FILE = '/tmp/custom-ditto.log';
    assert.equal(configuration().logFile, '/tmp/custom-ditto.log');

    process.env.DITTO_LOG_FILE = 'off';
    assert.equal(configuration().logFile, null);
  } finally {
    if (prev === undefined) delete process.env.DITTO_LOG_FILE;
    else process.env.DITTO_LOG_FILE = prev;
  }
});

test('config.json loads user settings with defaults < file < env < overrides precedence', async () => {
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-cfg-test-'));
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    token: 'my-secret-token-2026',
    viewport: '1600x900',
    userAgent: 'DittoCustomUA/1.0',
    syncFreshMs: 120000,
    demo: false,
    agentAllowRemote: true,
    host: '127.0.0.1',
    port: 4100,
    cdpPort: 9333,
  }));
  const savedEnv = {};
  for (const key of ['DITTO_TOKEN', 'DITTO_AUTH', 'DITTO_VIEWPORT', 'DITTO_PORT', 'DITTO_DEMO']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  try {
    const cfg = configuration({ dataDir });
    assert.equal(cfg.configFileLoaded, true);
    assert.equal(cfg.token, 'my-secret-token-2026');
    assert.equal(cfg.authRequired, true);
    assert.deepEqual(cfg.viewport, { width: 1600, height: 900 });
    assert.equal(cfg.userAgent, 'DittoCustomUA/1.0');
    assert.equal(cfg.syncFreshMs, 120000);
    assert.equal(cfg.demo, false);
    assert.equal(cfg.agentAllowRemote, true);
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 4100);
    assert.equal(cfg.cdpPort, 9333);

    // Empty env vars (as passed by docker-compose ${VAR:-}) do not override config.json.
    process.env.DITTO_TOKEN = '';
    process.env.DITTO_AUTH = '';
    process.env.DITTO_VIEWPORT = '';
    const withEmptyEnv = configuration({ dataDir });
    assert.equal(withEmptyEnv.token, 'my-secret-token-2026');
    assert.equal(withEmptyEnv.authRequired, true);
    assert.deepEqual(withEmptyEnv.viewport, { width: 1600, height: 900 });

    // Non-empty env vars override config.json.
    process.env.DITTO_TOKEN = 'env-override-token';
    process.env.DITTO_VIEWPORT = '1280x720';
    process.env.DITTO_PORT = '4200';
    const withEnv = configuration({ dataDir });
    assert.equal(withEnv.token, 'env-override-token');
    assert.equal(withEnv.authRequired, true);
    assert.deepEqual(withEnv.viewport, { width: 1280, height: 720 });
    assert.equal(withEnv.port, 4200);

    // Explicit DITTO_AUTH=0 disables auth even when config.json sets a token.
    process.env.DITTO_AUTH = '0';
    assert.equal(configuration({ dataDir }).authRequired, false);

    // Explicit overrides win over everything.
    const withOverrides = configuration({ dataDir, token: 'override-tok', authRequired: true });
    assert.equal(withOverrides.token, 'override-tok');
    assert.equal(withOverrides.authRequired, true);
  } finally {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
});

test('config.json validates object viewport and rejects malformed JSON or control chars in token', async () => {
  const dataDir = await mkdtemp(path.join(process.env.DITTO_TEST_TEMP || os.tmpdir(), 'ditto-cfg-err-'));
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ viewport: { width: 1440, height: 900 } }));
  assert.deepEqual(configuration({ dataDir }).viewport, { width: 1440, height: 900 });
  assert.equal(configuration({ dataDir }).authRequired, false);

  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ token: 'bad\ntoken' }));
  assert.throws(() => configuration({ dataDir }), /Invalid token/);

  await writeFile(path.join(dataDir, 'config.json'), '{not-valid-json');
  assert.throws(() => configuration({ dataDir }), /Invalid JSON in config file/);
});
