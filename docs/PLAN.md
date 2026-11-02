# PiDash v2.0 Roadmap & Implementation Plan

> Branch: `feature/v2-roadmap`  
> Legend: ✅ Done · ✅ In Progress · ✅ Pending · ❌ Blocked

---

## Slice 1 — Bug Fixes (Fast Wins)
| # | Item | Status |
|---|------|--------|
| 1.1 | Remove dead `slug()` function | ✅ |
| 1.2 | Fix `aggregate()` domains: sum → max | ✅ |
| 1.3 | Fix `DELETE /api/servers/:id` to return 404 on missing ID | ✅ |
| 1.4 | `decryptPassword` — catch throws, return `""` on malformed cipher | ✅ |
| 1.5 | `collectSnapshot` double-normalizes servers — remove redundant call | ✅ |
| 1.6 | Far-future cache headers on static assets (`Cache-Control: immutable`) | ✅ |
| 1.7 | Bump `package.json` version to `2.0.0` | ✅ |

---

## Slice 2 — Architecture: Module Split
| # | Item | Status |
|---|------|--------|
| 2.1 | Create `src/crypto.js` — AES-256-GCM encrypt/decrypt | ✅ |
| 2.2 | Create `src/auth.js` — auth, CSRF, proxy validation | ✅ |
| 2.3 | Create `src/db.js` — all SQLite operations | ✅ |
| 2.4 | Create `src/pihole.js` — Pi-hole API client (v5, v6) | ✅ |
| 2.5 | Slim down `server.js` — routes only, re-exports from src/* | ✅ |
| 2.6 | Add SIGTERM / SIGINT graceful shutdown (close DB) | ✅ |
| 2.7 | Rate-limit `/api/snapshot` — 5s minimum between calls, return cached | ✅ |

---

## Slice 3 — Security Improvements
| # | Item | Status |
|---|------|--------|
| 3.1 | Fix `safeEqual` timing leak — HMAC-SHA256 approach (fixed-length outputs) | ✅ |
| 3.2 | Replace static `CSRF_SECRET` with per-session token (`/api/csrf-token` endpoint) | ✅ |
| 3.3 | Add `Strict-Transport-Security` header when `ENABLE_HTTPS=true` | ✅ |
| 3.4 | Add `Permissions-Policy` header to all responses | ✅ |
| 3.5 | Upgrade self-signed cert generation: RSA 2048 → ECDSA P-256 | ✅ |
| 3.6 | Remove `CSRF_SECRET` env var from docker-compose / `.env.example` | ✅ |

---

## Slice 4 — Database: History & Alerts Schema
| # | Item | Status |
|---|------|--------|
| 4.1 | Add `metrics` table — per-server snapshots with timestamps | ✅ |
| 4.2 | Add `alerts` table — server state change events | ✅ |
| 4.3 | `recordMetrics(snapshot)` — persist after every successful snapshot | ✅ |
| 4.4 | `getHistory(range)` — bucket metrics for 1h / 6h / 24h / 7d ranges | ✅ |
| 4.5 | `generateAlerts(snapshot)` — detect online→offline / offline→online transitions | ✅ |
| 4.6 | `pruneOldData()` — delete metrics older than 30 days on startup | ✅ |

---

## Slice 5 — New API Endpoints
| # | Item | Status |
|---|------|--------|
| 5.1 | `GET /api/csrf-token` — issue a per-session CSRF token | ✅ |
| 5.2 | `GET /api/history?range=1h\|6h\|24h\|7d` — historical metrics per server | ✅ |
| 5.3 | `GET /api/alerts` — unread alerts | ✅ |
| 5.4 | `POST /api/alerts/read` — mark all alerts read | ✅ |
| 5.5 | `POST /api/servers/:id/test` — test connection to one server | ✅ |
| 5.6 | `POST /api/servers/:id/blocking` — toggle Pi-hole blocking `{enabled:bool}` | ✅ |
| 5.7 | `GET /api/servers/:id/queries?limit=100` — proxy query log from Pi-hole | ✅ |

---

## Slice 6 — UI / UX Overhaul
| # | Item | Status |
|---|------|--------|
| 6.1 | HiDPI-aware canvas: set `width/height` via `devicePixelRatio`, `ctx.scale(dpr,dpr)` | ✅ |
| 6.2 | Add legend to line chart (queries / blocked) | ✅ |
| 6.3 | Blocking status pill on each server card (Filtering / Paused) | ✅ |
| 6.4 | Blocking toggle button on server cards | ✅ |
| 6.5 | Add "History" tab with range selector (1h / 6h / 24h / 7d) | ✅ |
| 6.6 | Add "Query Log" tab — filterable recent queries per server | ✅ |
| 6.7 | Alert badge in header showing unread count | ✅ |
| 6.8 | Alerts panel (slide-in or dropdown) with dismiss-all | ✅ |
| 6.9 | Replace `alert()` in settings with inline error banner | ✅ |
| 6.10 | "Test Connection" button per server in settings dialog | ✅ |
| 6.11 | Loading skeleton on first paint (before snapshot arrives) | ✅ |
| 6.12 | `<title>` shows live online count — `2/3 online · PiDash` | ✅ |
| 6.13 | Server name tooltip on truncated titles | ✅ |
| 6.14 | Dark / light mode: respect `prefers-color-scheme` + manual toggle in header | ✅ |
| 6.15 | Mobile header: icon-only buttons on narrow screens | ✅ |
| 6.16 | Save button: disable during save, show spinner | ✅ |
| 6.17 | Success toast after settings save | ✅ |
| 6.18 | CSRF token wired into all non-GET fetches in `apiFetch` | ✅ |

---

## Slice 7 — Test Suite
| # | Item | Status |
|---|------|--------|
| 7.1 | `test/crypto.test.js` — unit tests for encrypt/decrypt (moved + expanded) | ✅ |
| 7.2 | `test/auth.test.js` — port security.test.js + add CSRF token tests | ✅ |
| 7.3 | `test/pihole.test.js` — unit tests for v5/v6 fetch, blocking toggle | ✅ |
| 7.4 | `test/db.test.js` — metrics recording, history bucketing, alert generation | ✅ |
| 7.5 | Update `test/api.test.js` — cover new endpoints (history, alerts, blocking, test) | ✅ |
| 7.6 | Keep `test/utils.test.js` working (backward compat via server.js re-exports) | ✅ |
| 7.7 | Keep `test/security.test.js` working | ✅ |
| 7.8 | All tests pass: `npm test` | ✅ |

---

## Slice 8 — Final Polish & QA
| # | Item | Status |
|---|------|--------|
| 8.1 | Update `.env.example` — document new env vars, remove CSRF_SECRET | ✅ |
| 8.2 | Update `docker-compose.yml` — remove CSRF_SECRET, add new vars | ✅ |
| 8.3 | Update `CLAUDE.md` — reflect new architecture | ✅ |
| 8.4 | Bump CSS/JS cache-buster query param to `?v=7` | ✅ |
| 8.5 | Final `npm test` — all green | ✅ |
| 8.6 | Notify user for final review | ✅ |
