# Security Policy

Ditto handles live browser sessions (Cookies, `localStorage`, `sessionStorage`, DOM snapshots, and CDP control). Security boundaries are treated as core architectural invariants.

## Threat Model & Deployment Boundaries

- **Single-user trusted network model**: Ditto is designed for a single developer connecting their personal machine to a trusted remote Linux host (private LAN, Tailscale/WireGuard VPN, or SSH tunnel).
- **Never expose port `3217` or `9222` to the public internet.** Access to the web console or CDP is functionally equivalent to access to your logged-in Chromium profile.
- **Loopback-only Agent API**: When running in the default zero-token LAN mode (`DITTO_AUTH=0`), `/api/agent/*` (including `/api/agent/eval`) strictly accepts requests from loopback (`127.0.0.1` / `::1`) only. Set `DITTO_AUTH=1` if you require authenticated remote access.
- **Loopback-only CDP**: Chromium's remote debugging port (`9222`) always binds to `127.0.0.1` inside the host/container and is not published externally by default.

## Built-in Protections

1. **Inert DOM Replay Sandbox**:
   - The live `rrweb` replay iframe runs with `sandbox="allow-same-origin"` (never `allow-scripts`, never `UNSAFE_replayCanvas`).
   - Recorded scripts, inline event handlers, and active navigation/form targets are stripped server-side by `src/recording.js`, and a strict CSP (`script-src 'none'; connect-src 'none'`) is injected into every reconstructed document.
2. **Scoped Asset Cache (No Open Proxy)**:
   - `/api/assets/:id` only serves resources already observed or cached by the owned Chromium instance, with strict size bounds (2 MiB per asset, 32 MiB total). It never fetches arbitrary user-supplied URLs.
3. **Sensitive Input Protection**:
   - Password and hidden inputs are masked at record time (`maskInputOptions: { password: true, hidden: true }`).
   - Password typing from the web console appends keystrokes without reading back masked values.
   - Elements matching `[data-ditto-private]` and `input[type="file"]` are excluded from recording and control.
4. **Cookie Integrity**:
   - `Secure`, `HttpOnly`, `SameSite`, expiration, host-only boundaries, and supported partition keys are preserved during import — Ditto never downgrades cookie security attributes to force login.
   - Cookie origin matching enforces strict domain boundaries and rejects deceptive suffixes.
5. **Private On-Disk Permissions**:
   - Runtime data directories default to mode `0700`; credentials and pending sync files are written with mode `0600`.
   - Page content, cookies, tokens, and storage values are never written to logs.

## Reporting a Vulnerability

If you discover a security vulnerability in Ditto, please **do not** open a public issue with exploit details.

Instead, report it privately via GitHub Security Advisories (**Security → Advisories → Report a vulnerability** on this repository) with:
- A clear description of the vulnerability and affected component (`src/`, `public/`, `extension/`, `scripts/`)
- Steps to reproduce or proof-of-concept
- Potential impact and any suggested mitigation

We will acknowledge receipt and work on a fix promptly before coordinated disclosure.
