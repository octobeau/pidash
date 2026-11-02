# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run all tests (unit + integration + security)
npm test

# Run a single test file
node --test test/db.test.js

# Syntax check all modules without running
npm run check
node --check src/crypto.js src/auth.js src/db.js src/pihole.js

# Start the server locally (requires .env)
cp .env.example .env   # first time only
npm start

# Build and run via Docker Compose (mirrors production)
docker compose up --build
```

Tests require Node ≥ 22.5 (uses `node:sqlite` and `node:test`). Each test file sets
`DATABASE_PATH=:memory:` before importing to avoid cross-file SQLite lock conflicts.
`test/api.test.js` spawns a real server on port 8081 with a temp SQLite file.

## Architecture

**No npm dependencies.** The backend is split across four `src/` modules and a thin
`server.js` router, all using only Node built-ins.

```
server.js          — request handler, routes, startup, re-exports for tests
src/
  crypto.js        — AES-256-GCM password encrypt/decrypt
  auth.js          — Basic/proxy auth, CSRF tokens, security headers, safeEqual
  db.js            — SQLite CRUD (servers, metrics, alerts), normalizeServer
  pihole.js        — Pi-hole API client (v5/v6), collectSnapshot, toggleBlocking, getQueryLog
public/
  index.html       — HTML shell (tabs: Overview, Top Lists, History, Query Log, Compare)
  styles.css       — CSS with dark/light mode tokens, responsive layout, skeleton loaders
  app.js           — Vanilla JS frontend (no framework)
test/
  api.test.js      — Integration tests (real server process)
  db.test.js       — DB CRUD + metrics/alerts unit tests
  pihole.test.js   — Pi-hole client unit tests
  security.test.js — Auth/proxy/CSRF tests
  utils.test.js    — Crypto + normalizeServer tests
```

### Request flow

1. `server.js:requestHandler` handles all routes.
2. CSRF validation runs first for non-GET `/api/*` (HMAC token or same-origin fallback).
3. `isAuthorized` enforces `AUTH_MODE`: `basic`, `proxy`, or `none`.
4. Route handlers delegate to `src/db.js` for data and `src/pihole.js` for live queries.
5. After every fresh snapshot, `recordMetrics` and `generateAlerts` persist state to SQLite.

### Data storage

SQLite via `node:sqlite` (`DatabaseSync`). Three tables:

| Table | Purpose |
|---|---|
| `servers` | Pi-hole server config (name, url, encrypted password, version, color, enabled) |
| `metrics` | Per-server time-series snapshot data (retained 30 days) |
| `alerts` | Online/offline transition events |

Passwords are encrypted with AES-256-GCM (`encryptPassword` / `decryptPassword`).
The browser never receives stored passwords — only `hasPassword: true`.

### Security model

- CSRF: per-session tokens via `GET /api/csrf-token` (stored server-side, 1h TTL)
  — with same-origin Origin/Referer check as fallback for requests without a token.
- `safeEqual`: HMAC-SHA256 both inputs against a random per-process key before
  `timingSafeEqual`, eliminating the length timing leak of direct buffer comparison.
- Security headers on every response: `CSP`, `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`; `Strict-Transport-Security` when HTTPS is on.
- Self-signed certs generated with ECDSA P-256 (replaces RSA 2048).

### API surface (v2)

```
GET  /healthz
GET  /api/csrf-token              → {token}
GET  /api/me                      → {mode, username, ...}
GET  /api/config                  → {authMode, encryptionConfigured, servers}
POST /api/snapshot                → full snapshot from all servers
GET  /api/history?range=1h|6h|24h|7d → time-series per server
GET  /api/alerts                  → {alerts, unread}
POST /api/alerts/read             → mark all read
GET  /api/servers                 → list
POST /api/servers                 → create
PUT  /api/servers/:id             → update
DELETE /api/servers/:id           → delete (404 if unknown)
POST /api/servers/:id/test        → single-server connectivity test
POST /api/servers/:id/blocking    → toggle blocking {enabled: bool}
GET  /api/servers/:id/queries     → query log proxy (?limit=)
```

### Key env vars

| Variable | Purpose |
|---|---|
| `CONFIG_ENCRYPTION_KEY` | Required to store/read Pi-hole passwords (base64 32-byte key) |
| `CONFIG_ENCRYPTION_KEY_FILE` | File path alternative to env var |
| `AUTH_MODE` | `basic` (default), `proxy`, or `none` |
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` | Basic auth credentials |
| `TRUSTED_PROXIES` | Comma-separated IPs/CIDRs/prefixes for proxy auth mode |
| `AUTH_PROXY_*_HEADER` | Header names injected by IdP in proxy mode |
| `ENABLE_HTTPS` / `HTTPS_PORT` | Enable ECDSA self-signed HTTPS |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | Override self-signed cert |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Set `0` only for Pi-holes with self-signed certs |
| `PIHOLE_TIMEOUT_MS` | Per-request timeout to Pi-hole APIs (default 7000ms) |
| `DATABASE_PATH` | SQLite path (default `data/pidash.sqlite`; use `:memory:` in tests) |

### Exports used by tests

`server.js` re-exports from `src/` modules:
`requestHandler`, `loadServers`, `normalizeServer`, `listServerConfigs`,
`createServerConfig`, `updateServerConfig`, `deleteServerConfig`,
`encryptPassword`, `decryptPassword`, `collectSnapshot`, `collectServer`,
`fetchV6`, `fetchV5`, `getJson`, `sendUnauthorized`, `isAuthorized`,
`isProxyAuthorized`, `isRequestFromTrustedProxy`, `parseTrustedProxyRules`,
`matchesTrustedProxyRule`, `currentUser`.
