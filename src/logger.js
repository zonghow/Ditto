import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_LOG_BYTES = 10 * 1024 * 1024;

export function createLogger({
  enabled = true,
  stdout = true,
  file = null,
  fallbackFile = null,
  maxBytes = MAX_LOG_BYTES,
} = {}) {
  let target = file || fallbackFile;
  let prepared = false;
  let queue = Promise.resolve();

  const appendTo = async (filePath, line) => {
    if (!prepared) {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      prepared = true;
    }
    const info = await stat(filePath).catch(() => null);
    if (info && info.size >= maxBytes) {
      await rename(filePath, `${filePath}.1`).catch(() => {});
    }
    await appendFile(filePath, `${line}\n`, { mode: 0o600 });
  };

  const writeLine = line => {
    if (!target) return;
    queue = queue.then(async () => {
      try {
        await appendTo(target, line);
      } catch {
        if (fallbackFile && target !== fallbackFile) {
          target = fallbackFile;
          prepared = false;
          try {
            await appendTo(target, line);
          } catch { /* Never interrupt browser service on log I/O failure. */ }
        }
      }
    });
  };

  return {
    log(scope, message) {
      if (!enabled) return;
      const line = `[${new Date().toISOString()}] [${scope}] ${message}`;
      if (stdout) console.log(line);
      writeLine(line);
    },
    filePath() { return target; },
    flush() { return queue; },
  };
}
