import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/logger.js';

test('logger appends timestamped lines to disk with 0600 permissions', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ditto-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logs', 'ditto.log');
  const logger = createLogger({ enabled: true, stdout: false, file });

  logger.log('agent', 'open tab=tab-1');
  logger.log('sync', 'origin=https://example.test ready (120ms)');
  await logger.flush();

  const content = await readFile(file, 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[agent\] open tab=tab-1$/);
  assert.match(lines[1], /\[sync\] origin=https:\/\/example\.test ready \(120ms\)$/);
  const info = await stat(file);
  assert.equal(info.mode & 0o777, 0o600);
});

test('logger rotates file to .1 when size reaches maxBytes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ditto-log-rot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ditto.log');
  const logger = createLogger({ enabled: true, stdout: false, file, maxBytes: 80 });

  logger.log('sync', 'first-line-that-exceeds-eighty-bytes-when-combined-with-timestamp-and-scope');
  logger.log('sync', 'second-line-after-rotation');
  await logger.flush();

  const archived = await readFile(`${file}.1`, 'utf8');
  const current = await readFile(file, 'utf8');
  assert.match(archived, /first-line-that-exceeds/);
  assert.match(current, /second-line-after-rotation/);
});

test('logger falls back to fallbackFile when primary path cannot be written', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ditto-log-fb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, 'not-a-dir');
  await writeFile(blocker, 'x');
  const primary = path.join(blocker, 'ditto.log');
  const fallback = path.join(dir, 'fallback', 'ditto.log');
  const logger = createLogger({ enabled: true, stdout: false, file: primary, fallbackFile: fallback });

  logger.log('server', 'started');
  await logger.flush();

  assert.equal(logger.filePath(), fallback);
  const content = await readFile(fallback, 'utf8');
  assert.match(content, /\[server\] started/);
});

test('disabled logger writes nothing to disk', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ditto-log-off-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ditto.log');
  const logger = createLogger({ enabled: false, stdout: false, file });

  logger.log('agent', 'should not appear');
  await logger.flush();

  await assert.rejects(() => stat(file));
});
