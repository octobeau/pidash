# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run all tests (unit + integration + security)
npm test

# Run a single test file
node --test test/utils.test.js

# Syntax check the server without running it
npm run check

# Start the server locally (requires .env)
cp .env.example .env   # first time only
npm start

# Build and run via Docker Compose (mirrors production)
docker compose up --build
```

Tests require Node ≥ 22.5 (uses `node:sqlite` and `node:test`). The integration test in `test/api.test.js` spawns a real server process on port 8081 and cleans up after itself.

## Architecture

**No npm dependencies.** The entire backend is `server.js` — a single ES module using only Node built-ins (`node:http`, `node:https`, `node:sqlite`, `node:crypto`, `node:fs`, etc.). The frontend is vanilla JS/CSS in `public/`.

### Request flow

1. `server.js:requestHandler` handles all routes.
2. CSRF validation runs first for non-GET `/api/*` requests (same-origin `Origin`/`Referer` check, or token match if `CSRF_SECRET` is set).
3. `isAuthorized` enforces `AUTH_MODE`: `basic` (HTTP Basic Auth), `proxy` (trusted identity headers), or `none`.
4. `/api/snapshot` (POST) — the main data endpoint — calls `collectSnapshot`, which fans out parallel `collectServer` calls per Pi-hole.
5. Each `collectServer` calls `fetchV6`, `fetchV5`, or `fetchAuto` (tries v6 then v5). Pi-hole v6 requires a session token obtained via `POST /api/auth`; tokens are cached in `sessionCache` (in-memory Map).
6. Static files are served from `public/` for all other GET requests.

### Data storage

SQLite via `node:sqlite` (`DatabaseSync`). The database path defaults to `data/pidash.sqlite` and is configurable via `DATABASE_PATH`. The schema is a single `servers` table. Passwords are encrypted with AES-256-GCM (`encryptPassword` / `decryptPassword`) using `CONFIG_ENCRYPTION_KEY`. The browser never receives stored passwords — only `hasPassword: true`.

An optional JSON seed file (`PIHOLE_CONFIG`) populates the database on first run when the `servers` table is empty.

### Key env vars

| Variable | Purpose |
|---|---|
| `CONFIG_ENCRYPTION_KEY` | Required to store/read Pi-hole passwords |
| `AUTH_MODE` | `basic` (default), `proxy`, or `none` |
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` | Basic auth credentials |
| `TRUSTED_PROXIES` | Comma-separated IPs/CIDRs/prefixes for proxy auth mode |
| `AUTH_PROXY_*_HEADER` | Header names injected by IdP in proxy mode |
| `ENABLE_HTTPS` / `HTTPS_PORT` | Enable self-signed HTTPS on the app itself |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | Override self-signed cert with your own |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Set to `0` only for Pi-holes with self-signed certs |
| `PIHOLE_TIMEOUT_MS` | Per-request timeout to Pi-hole APIs (default 7000ms) |

### Pi-hole API normalization

`fetchV6` and `fetchV5` each return a common shape: `{ version, summary, queryTypes, topDomains, topBlocked, topClients, upstreams, history }`. The helper functions `objectFromAny`, `listFromAny`, and `historyFromAny` handle the inconsistent field names across Pi-hole API versions. `normalizeV5Summary` and `normalizeV6Summary` map version-specific fields to the shared `summary` shape.

### Proxy trust model

`parseTrustedProxyRules` parses `TRUSTED_PROXIES` into rule objects (exact IP, IPv4 CIDR, or wildcard prefix). `isRequestFromTrustedProxy` checks the socket's remote address against those rules before accepting identity headers in proxy auth mode.

### Exports used by tests

`server.js` exports: `requestHandler`, `loadServers`, `normalizeServer`, `listServerConfigs`, `createServerConfig`, `updateServerConfig`, `deleteServerConfig`, `encryptPassword`, `decryptPassword`, `collectSnapshot`, `collectServer`, `fetchV6`, `fetchV5`, `getJson`, `sendUnauthorized`, `isAuthorized`, `isProxyAuthorized`, `isRequestFromTrustedProxy`, `parseTrustedProxyRules`, `matchesTrustedProxyRule`, `currentUser`.
