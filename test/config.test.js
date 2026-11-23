import test from 'node:test';
import assert from 'node:assert/strict';
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
