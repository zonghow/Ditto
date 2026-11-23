import path from 'node:path';
import { projectRoot } from '../src/config.js';
import { readJson, writePrivateJson } from '../src/files.js';
import { run, ssh, quote } from './process.js';

// Upgrade only observation/control. The original container keeps Chromium,
// user tabs, login import and the 9222 endpoint it already owns.
const deployment = await readJson(path.join(projectRoot, '.local', 'deployment.json'));
if (!deployment) throw new Error('Deploy the original Browser Service first.');
const { remote, dataDir, container } = deployment;
if (!deployment.directory.startsWith('/home/') && !deployment.directory.startsWith('/data')) throw new Error('Companion directory must be inside the existing remote deployment.');
if (/\s|[\r\n]/.test(deployment.directory + dataDir)) throw new Error('Systemd paths containing whitespace are not supported by this PoC.');
const directory = `${deployment.directory}-rrweb`;
const unitName = 'ditto-rrweb.service';
const label = (await ssh(remote, `docker inspect --format '{{index .Config.Labels "io.ditto.project"}}' ${quote(container)}`, { capture: true })).trim();
if (label !== 'ditto-browser-bridge') throw new Error('Not the Ditto-owned browser container.');
const prepare = `
from pathlib import Path
p = Path(${JSON.stringify(directory)})
marker = p / '.ditto-deployment'
if p.exists() and any(p.iterdir()) and (not marker.exists() or marker.read_text() != 'ditto-rrweb-companion\\n'):
    raise SystemExit('Refusing to overwrite an unrelated companion directory.')
p.mkdir(parents=True, exist_ok=True)
marker.write_text('ditto-rrweb-companion\\n')
`;
await ssh(remote, `python3 -c ${quote(prepare)}`);
await run('rsync', ['-az', '--exclude=.git', '--exclude=.local', '--exclude=node_modules', '--exclude=artifacts',
  '--exclude=.playwright-mcp', '--exclude=coverage', '--exclude=.env*', '--exclude=*.log', `${projectRoot}/`, `${remote}:${directory}/`]);
await ssh(remote, `npm --prefix ${quote(directory)} ci --ignore-scripts --no-fund`);
const installed = (await ssh(remote, `systemctl --user show --property=LoadState --value ${quote(unitName)}`, { capture: true })).trim();
const unit = `# Ditto rrweb companion
[Unit]
Description=Ditto rrweb live replay and control (existing Chromium)
After=network.target

[Service]
Type=simple
WorkingDirectory=${directory}
ExecStart=/usr/bin/node ${directory}/src/main.js
Environment=DITTO_PORT=3218
Environment=DITTO_DATA_DIR=${dataDir}
Environment=DITTO_ATTACH_CDP=http://127.0.0.1:9222
Environment=DITTO_SYNC_UPSTREAM=http://127.0.0.1:3217
Environment=DITTO_DEMO=0
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
const configure = `
from pathlib import Path
import socket
p = Path.home() / '.config/systemd/user' / ${JSON.stringify(unitName)}
if p.exists() and '# Ditto rrweb companion' not in p.read_text():
    raise SystemExit('Refusing to replace an unrelated systemd unit.')
if ${JSON.stringify(installed)} != 'loaded':
    with socket.socket() as listener:
        try:
            listener.bind(('127.0.0.1', 3218))
        except OSError:
            raise SystemExit('Companion port 3218 is already in use.')
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(${JSON.stringify(unit)})
p.chmod(0o600)
`;
await ssh(remote, `python3 -c ${quote(configure)}`);
await ssh(remote, 'systemctl --user daemon-reload');
await ssh(remote, `systemctl --user enable ${quote(unitName)}`);
await ssh(remote, `systemctl --user restart ${quote(unitName)}`);
await ssh(remote, `node --input-type=module -e ${quote(`
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  try {
    const response = await fetch('http://127.0.0.1:3218/health', { signal: AbortSignal.timeout(1000) });
    if (response.ok && (await response.json()).browserReady) process.exit(0);
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
process.exit(1);
`)}`);
await writePrivateJson(path.join(projectRoot, '.local', 'deployment.json'), { ...deployment,
  viewerPort: 3218, viewerDirectory: directory, viewerUnit: unitName });
console.log('rrweb companion started on devbox loopback :3218. Existing Chromium and tabs were not restarted.');
console.log('Run npm run connect to switch Mac :3217 to the companion. Login uploads keep using the original single writer.');
