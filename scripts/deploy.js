import path from 'node:path';
import { projectRoot } from '../src/config.js';
import { readJson, writePrivateJson } from '../src/files.js';
import { ssh, run, quote } from './process.js';

const remote = process.env.DITTO_REMOTE || 'devbox';
const image = process.env.DITTO_IMAGE || 'ditto-chromium:local';
const container = 'ditto-browser';
const previous = await readJson(path.join(projectRoot, '.local', 'deployment.json'));
const home = (await ssh(remote, 'printf %s "$HOME"', { capture: true })).trim();
const directory = process.env.DITTO_REMOTE_DIR || `${home}/Ditto`;
const dataDir = `${home}/.local/share/ditto`;
if (!directory.startsWith(`${home}/`) || /[\r\n]/.test(directory)) throw new Error('Remote directory must be inside your home.');
console.log(`Deploying source to ${remote}:${directory}`);
const prepare = `python3 -c ${quote(`
from pathlib import Path
import json, os
p = Path(${JSON.stringify(directory)})
marker = p / '.ditto-deployment'
if p.exists() and any(p.iterdir()) and not marker.exists():
    raise SystemExit('Refusing to overwrite an existing unrelated directory.')
p.mkdir(parents=True, exist_ok=True)
marker.write_text('ditto-browser-bridge\\n')
d = Path(${JSON.stringify(dataDir)})
d.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(d, 0o700)
`)}`;
await ssh(remote, prepare);
await run('rsync', ['-az', '--exclude=.git', '--exclude=.local', '--exclude=node_modules', '--exclude=artifacts',
  '--exclude=.playwright-mcp', '--exclude=coverage', '--exclude=.env*', '--exclude=*.log', `${projectRoot}/`, `${remote}:${directory}/`]);
await ssh(remote, `cd ${quote(directory)} && npm ci --ignore-scripts --no-fund`);
await ssh(remote, `docker image inspect ${quote(image)}`, { capture: true }).catch(async () => {
  if (image !== 'ditto-chromium:local') return ssh(remote, `docker pull ${quote(image)}`);
  await ssh(remote, `python3 -c ${quote(`
from pathlib import Path
import shutil, subprocess, tempfile, uuid
build_name = 'ditto-image-build-' + uuid.uuid4().hex[:10]
context = Path(tempfile.mkdtemp(prefix='ditto-image-', dir=str(Path.home())))
try:
    shutil.copyfile(${JSON.stringify(`${directory}/deploy/install-browser.sh`)}, context / 'install-browser.sh')
    shutil.copyfile('/usr/bin/node', context / 'node')
    (context / 'node').chmod(0o755)
    subprocess.run(['docker', 'run', '--name', build_name, '--label', 'io.ditto.project=ditto-browser-bridge',
      '--security-opt', ${JSON.stringify(`seccomp=${directory}/deploy/seccomp.json`)},
      '-e', ${JSON.stringify(`DITTO_APT_MIRROR=${process.env.DITTO_APT_MIRROR || ''}`)},
      '-v', str(context) + ':/ditto-build:ro', 'debian:bookworm-slim', 'sh', '/ditto-build/install-browser.sh'], check=True)
    subprocess.run(['docker', 'commit', '--change', 'ENV DITTO_CHROMIUM_PATH=/usr/bin/chromium',
      '--change', 'WORKDIR /app', '--change', 'LABEL io.ditto.project=ditto-browser-bridge',
      build_name, ${JSON.stringify(image)}], check=True)
finally:
    subprocess.run(['docker', 'rm', '-f', build_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(str(context))
`)}`);
});
const existing = await ssh(remote,
  `docker inspect --format '{{index .Config.Labels "io.ditto.project"}}' ${container}`, { capture: true }).catch(error => {
    if (error.code === 1) return null;
    throw error;
  });
if (existing !== null) {
  if (existing.trim() !== 'ditto-browser-bridge') throw new Error('An unrelated container already uses the Ditto name.');
  if (previous?.remote === remote && previous?.viewerUnit === 'ditto-rrweb.service') {
    await ssh(remote, `systemctl --user disable --now ${quote(previous.viewerUnit)}`);
  }
  await ssh(remote, `docker stop -t 20 ${container}`);
  await ssh(remote, `docker rm ${container}`);
}
await ssh(remote, `python3 -c ${quote(`
import socket
for port in [3217, 9222]:
    with socket.socket() as listener:
        try:
            listener.bind(('127.0.0.1', port))
        except OSError:
            raise SystemExit('Port %s is in use. Refusing to alter any existing service.' % port)
`)}`);
const user = (await ssh(remote, 'id -u', { capture: true })).trim();
const group = (await ssh(remote, 'id -g', { capture: true })).trim();
const args = [
  'docker', 'run', '-d', '--name', container, '--label', 'io.ditto.project=ditto-browser-bridge',
  '--restart', 'unless-stopped', '--init', '--network', 'host', '--user', `${user}:${group}`,
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
  '--security-opt', `seccomp=${directory}/deploy/seccomp.json`,
  '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m', '--tmpfs', '/run:rw,nosuid,nodev,size=16m',
  '--shm-size', '1g', '--pids-limit', '1024',
  '-v', `${directory}:/app:ro`, '-v', `${dataDir}:/data:rw`, '-w', '/app',
  '-e', 'HOME=/data', '-e', 'DITTO_DATA_DIR=/data', '-e', 'DITTO_PORT=3217', '-e', 'DITTO_CDP_PORT=9222',
  image, 'node', 'src/main.js',
];
await ssh(remote, args.map(quote).join(' '));
await writePrivateJson(path.join(projectRoot, '.local', 'deployment.json'), { remote, directory, dataDir, container, image });
const ready = `node --input-type=module -e ${quote(`
let ok = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const r = await fetch('http://127.0.0.1:3217/health', {signal: AbortSignal.timeout(1500)});
    if (r.ok && (await r.json()).browserReady) { ok = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!ok) process.exit(1);
console.log('Ditto Chromium is ready on loopback port 3217; CDP on 9222.');
`)}`;
await ssh(remote, ready);
console.log('Deployment complete. Run npm run connect to open the live viewer.');
