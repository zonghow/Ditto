import { spawn } from 'node:child_process';

export function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export function run(command, args, { capture = false, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...options });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
    }
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve(stdout);
      else {
        // Never include captured output in an exception: it may be a private credential.
        const error = new Error(`${command} exited with status ${code}.`);
        error.code = code;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

export function ssh(remote, command, options = {}) {
  if (!/^[a-zA-Z0-9_.@-]+$/.test(remote) || remote.startsWith('-')) throw new Error('Invalid SSH target.');
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', remote, command], options);
}
