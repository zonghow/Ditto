# AGENTS.md — Coding Agent Guide for Ditto

This repository is **Ditto**, a zero-build-step Node.js 22+ ESM project providing a remote agent-owned Chromium browser with Chrome extension login-state sync, `ditto` CLI, and a live `rrweb` + CDP web console.

## Architecture Quick Map

- `src/main.js` — Process entry point & graceful shutdown
- `src/app.js` — Express HTTP server, static file caching, and route wiring
- `src/ws-hub.js` — Viewer & Extension WebSocket hubs, immediate interactive event flush, binary CDP screencast framing
- `src/routes/agent.js`, `src/routes/sync.js` — Agent automation endpoints (loopback-guarded when `DITTO_AUTH=0`) and Cookie/Storage sync routes
- `src/browser.js`, `src/browser-control.js`, `src/browser-recording.js`, `src/browser-tabs.js` — Persistent Chromium lifecycle, fast-path CDP input, watch-aware rrweb recording, tab management
- `src/recorder.js`, `src/recording.js`, `src/assets.js` — Page-injected rrweb recorder (pauses when unwatched or in screencast), DOM sanitizer, bounded private asset cache
- `src/screencast.js` — CDP `Page.startScreencast` manager and input validation
- `src/import-snapshot.js`, `src/sync-store.js`, `src/snapshot.js`, `src/upstream-sync.js` — SHA-256 delta Cookie/Storage import & CookieCloud adapter
- `public/` — Zero-build browser ESM web console (`app.js`, `replay.js`, `remote-control.js`, `screencast-view.js`, `tab-strip.js`, `overview.js`, `address-bar.js`, `memory-panel.js`)
- `extension/` — Chrome MV3 extension (delta 5-min full sync + proactive new-tab sync + on-demand sync)
- `scripts/ditto`, `skills/ditto/SKILL.md` — Zero-dependency Agent CLI and skill specification

## Non-Negotiable Rules

1. **Zero build step**: Do not introduce bundlers, TypeScript compile steps, or inline `<script>` tags in `public/` (strict CSP `script-src 'self'`).
2. **Security boundaries**:
   - Keep replay iframe `sandbox="allow-same-origin"` without `allow-scripts` or `UNSAFE_replayCanvas`.
   - Keep `/api/agent/*` loopback-only when `DITTO_AUTH=0` unless `DITTO_AGENT_REMOTE=1`.
   - Never eagerly pre-fetch assets during `refresh()`; `/api/assets/:id` refill stays lazy.
   - Keep `lnaCdp` alive until `BrowserService.stop()` (detaching resets CDP `Browser.setPermission`).
3. **Verification**:
   - Run `npm test` after any code change.
   - Run `npm run test:integration` when touching `src/browser*`, `src/ws-hub.js`, `src/recorder*`, or `public/`.
   - Run `npm run test:extension` when touching `extension/` or sync endpoints.
   - Run `npm run test:attach` when touching attach/companion mode.
