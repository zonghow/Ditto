# Contributing to Ditto

Thank you for your interest in contributing to Ditto!

## Core Engineering Principles

1. **Zero Build Step**: Both the server (`src/`, Node.js 22+ ESM) and the web console (`public/`, native browser ESM) and Chrome MV3 extension (`extension/`) run directly without webpack, Vite, or transpilation. Keep dependencies minimal and browser code standard ESM.
2. **Strict CSP Compatibility**: Files served under `public/` must never rely on inline `<script>` tags (`script-src 'self'`).
3. **Security Invariants First**: Never relax the replay iframe sandbox (`allow-same-origin` without `allow-scripts`), never expose arbitrary URL fetching on `/api/assets/:id`, and never log cookies, tokens, or recorded DOM contents.
4. **Keep Modules Focused**: Respect the modular structure across `src/browser-*.js`, `src/routes/*.js`, `src/ws-hub.js`, and `public/*.js`.

## Local Development Setup

Requires **Node.js 22+**.

```bash
git clone https://github.com/zonghow/ditto.git
cd ditto
npm ci --ignore-scripts
npx playwright install chromium
npm start
```

Open `http://127.0.0.1:3217` in your browser. To develop with the Chrome extension locally, load `extension/` as an unpacked extension at `chrome://extensions/` and connect to `http://127.0.0.1:3217`.

## Running Tests

All tests use synthetic login state and isolated temporary profiles — they never read your real Chrome profile.

```bash
# Fast unit tests (no Chromium required)
npm test

# End-to-end real Chromium + Web Console + rrweb + tab/drawer/optimistic UI tests
npm run test:integration

# Companion attach mode integration tests
npm run test:attach

# Chrome MV3 extension side-load + auto-sync integration tests
npm run test:extension
```

Quick syntax check across all ESM files:

```bash
for f in src/*.js src/routes/*.js public/*.js extension/*.js scripts/*.js; do
  node --check "$f"
done
```

## Pull Request Guidelines

- Keep PRs focused on a single feature or fix.
- Add unit tests in `test/*.test.js` (and integration assertions in `test/integration.js` or `test/extension-integration.js` when changing browser/UI/extension behavior).
- Ensure `npm test` and relevant integration suites pass before opening a PR.
- Update `README.md` / `README.zh-CN.md` / `skills/ditto/SKILL.md` if CLI flags, UI controls, or environment variables change.
