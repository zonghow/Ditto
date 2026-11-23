import path from 'node:path';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { projectRoot } from '../src/config.js';
import { readJson, privateDirectory, writePrivateJson } from '../src/files.js';
import { ssh, run, quote } from './process.js';

const deployment = await readJson(path.join(projectRoot, '.local', 'deployment.json'));
const remote = process.env.DITTO_REMOTE || deployment?.remote || 'devbox';
const home = deployment?.dataDir ? undefined : (await ssh(remote, 'printf %s "$HOME"', { capture: true })).trim();
const dataDir = deployment?.dataDir || `${home}/.local/share/ditto`;
const socket = path.join(projectRoot, '.local', 'ssh.sock');
const tunnelFile = path.join(projectRoot, '.local', 'tunnel.json');
const remoteViewerPort = deployment?.viewerPort || 3217;
await privateDirectory(path.dirname(socket));
const control = operation => run('ssh', ['-S', socket, '-O', operation, remote], { capture: true });
if (process.argv.includes('--disconnect')) {
  if (existsSync(socket)) await control('exit');
  await unlink(tunnelFile).catch(() => {});
  console.log('Ditto SSH tunnel stopped. The remote browser remains running.');
  process.exit(0);
}
let running = false;
if (existsSync(socket)) {
  running = await control('check').then(() => true, () => false);
  if (!running) await unlink(socket);
  else {
    const tunnel = await readJson(tunnelFile);
    if ((tunnel?.viewerPort || 3217) !== remoteViewerPort) {
      await control('exit');
      running = false;
    }
  }
}
if (!running) {
  await run('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-M', '-S', socket, '-fnNT',
    '-L', `127.0.0.1:3217:127.0.0.1:${remoteViewerPort}`, '-L', '127.0.0.1:9222:127.0.0.1:9222', remote,
  ], { capture: true });
  await writePrivateJson(tunnelFile, { viewerPort: remoteViewerPort });
}
const health = await fetch('http://127.0.0.1:3217/health', { signal: AbortSignal.timeout(5000) });
if (!health.ok || !(await health.json()).browserReady) throw new Error('Remote Chromium is not ready.');
console.log('SSH tunnel ready. Viewer: http://127.0.0.1:3217');
if (!process.argv.includes('--no-open')) {
  // Read inside the command that needs the credential, never echo it to terminal/model context.
  const raw = await ssh(remote, `cat ${quote(`${dataDir}/credentials.json`)}`, { capture: true });
  const { dashboardToken } = JSON.parse(raw);
  const url = `http://127.0.0.1:3217/#token=${encodeURIComponent(dashboardToken)}`;
  if (process.platform === 'darwin') await run('open', [url], { capture: true });
  else console.log('Open the viewer and obtain the pairing token privately from your server credentials file.');
  console.log('Opened the viewer; the private pairing URL fragment is removed after session setup.');
}
