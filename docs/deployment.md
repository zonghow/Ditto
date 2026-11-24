# Deployment & Operations Guide

This guide covers all deployment topologies, environment variables, SSH-tunnel mode, legacy Docker 18 support, zero-downtime viewer upgrades, and CookieCloud compatibility.

---

## 1. Standard Docker Deployment (Recommended)

Works on any Linux host with Docker (`docker compose` v2, legacy `docker-compose`, or Docker 18+):

```bash
git clone https://github.com/zonghow/ditto.git
cd ditto
sh scripts/docker-up.sh
```

Then install the zero-dependency `ditto` CLI and Agent Skill on the host:

```bash
sh scripts/install-skill.sh
ditto status
```

### Custom Mirrors (Slow Debian / npm Networks)

```bash
DITTO_APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn \
DITTO_NPM_REGISTRY=https://registry.npmmirror.com \
sh scripts/docker-up.sh
```

### Container Maintenance

```bash
docker logs --tail 50 ditto-browser
docker restart ditto-browser
docker stop ditto-browser
```

---

## 2. SSH-Tunnel Mode (Loopback-Only Remote Server)

If your remote Linux host is only reachable over SSH (no direct LAN/VPN access to port `3217`), Ditto includes built-in SSH deploy & tunnel helpers:

```bash
# On your local machine (Mac / Linux)
npm ci --ignore-scripts
DITTO_REMOTE=my-devbox npm run deploy
DITTO_REMOTE=my-devbox npm run connect
```

- `npm run deploy` syncs the source tree to `$HOME/Ditto` on the remote host, builds `ditto-chromium:local` (compatible with legacy Docker 18 via `deploy/seccomp.json`), and starts `ditto-browser` bound strictly to `127.0.0.1:3217` and `127.0.0.1:9222`.
- `npm run connect` establishes a persistent SSH control-master tunnel forwarding remote `127.0.0.1:3217` and `127.0.0.1:9222` to your local `127.0.0.1`, and opens the authenticated console.
- `npm run disconnect` tears down the local SSH tunnel without stopping the remote Chromium container.

### Zero-Downtime Viewer Companion (`deploy:viewer`)

To upgrade the `rrweb` web console without restarting Chromium or closing open tabs:

```bash
DITTO_REMOTE=my-devbox npm run deploy:viewer
DITTO_REMOTE=my-devbox npm run connect
```

The companion service attaches to the existing Chromium over CDP (`127.0.0.1:9222`), listens on `127.0.0.1:3218` via a user `systemd` unit (`ditto-rrweb.service`), and forwards login-state sync requests to the primary container so only one owner writes the browser profile.

---

## 3. Native Host Run (No Docker)

Requires **Node.js 22+** and Chromium (or Playwright Chromium):

```bash
npm ci --ignore-scripts
npx playwright install chromium
npm start
```

You can also point Ditto to an existing Chromium binary via `DITTO_CHROMIUM_PATH=/usr/bin/chromium`.

---

## 4. Playwright MCP Integration

Ditto ships with an `opencode.jsonc` and `npm run mcp` script that attach `@playwright/mcp` directly to Ditto's Chromium CDP endpoint (`http://127.0.0.1:9222`):

```bash
npm run mcp
```

> Note: When running via Docker (`docker-compose.yml`), port `9222` stays private inside the container by default because the `ditto` CLI communicates over port `3217`. If you need external host tools to connect directly to `127.0.0.1:9222` CDP, switch `docker-compose.yml` from `ports:` to `network_mode: host` on Linux.

---

## 5. CookieCloud Compatibility

Existing [CookieCloud](https://github.com/easychen/CookieCloud) users can upload cookies without installing the Ditto Chrome extension:

1. Open the Ditto web console → click the right-side **⚙ Settings** gear → **CookieCloud Compatible Config** → **Show Config**.
2. Configure CookieCloud in **Upload** mode with:
   - **Server URL**: `http://<host>:3217/cookiecloud`
   - **UUID & Password**: shown in the drawer
   - **Extra Header**: `Authorization:Bearer <syncToken>` (when `DITTO_AUTH=1`)
   - **Encryption**: `legacy` or `aes-128-cbc-fixed` (gzip supported)

> **Caveat**: CookieCloud groups `localStorage` by hostname only (losing scheme and port), so Ditto maps imported CookieCloud storage to default HTTPS origins and emits a warning. Use the Ditto MV3 extension for exact origin/port preservation, proactive new-tab sync, and full-profile delta sync.

---

## 6. Environment Variables Reference

| Variable | Default | Description |
| --- | --- | --- |
| `DITTO_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | HTTP/WebSocket bind address |
| `DITTO_PORT` | `3217` | HTTP/WebSocket server port |
| `DITTO_CDP_PORT` | `9222` | Chromium CDP loopback port |
| `DITTO_AUTH` | `0` | Set to `1` to require dashboard & sync bearer tokens |
| `DITTO_AGENT_REMOTE` | `0` | Set to `1` to allow non-loopback calls to `/api/agent/*` when `DITTO_AUTH=0` |
| `DITTO_DATA_DIR` | `~/.local/share/ditto` (`/data` in Docker) | Persistent Chromium profile, credentials, and history directory (`0700`) |
| `DITTO_LOG_FILE` | `<dataDir>/ditto.log` | Structured log path (set to `0` or `none` to disable file logging) |
| `DITTO_CHROMIUM_PATH` | Playwright bundled / `/usr/bin/chromium` | Custom Chromium executable path |
| `DITTO_VIEWPORT` | `1920x1080` | Initial remote viewport (`WIDTHxHEIGHT`, adaptive in viewer) |
| `DITTO_DEMO` | `0` | Set to `1` to serve synthetic demo page at `/demo.html` |
| `DITTO_APT_MIRROR` | _(empty)_ | Custom Debian APT mirror URL during Docker image build |
| `DITTO_NPM_REGISTRY` | _(empty)_ | Custom npm registry URL during Docker image build |
| `DITTO_REMOTE` | `devbox` | SSH host alias used by `scripts/deploy.js` and `scripts/connect.js` |
| `DITTO_REMOTE_DIR` | `$HOME/Ditto` | Remote directory used by `scripts/deploy.js` |
| `DITTO_IMAGE` | `ditto-chromium:local` | Docker image name used by `scripts/deploy.js` |
