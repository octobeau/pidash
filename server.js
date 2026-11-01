import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encryptPassword, decryptPassword } from "./src/crypto.js";
import {
  authMode, generateCsrfToken, validateCsrf,
  isAuthorized, isProxyAuthorized, isRequestFromTrustedProxy,
  parseTrustedProxyRules, matchesTrustedProxyRule,
  sendUnauthorized, currentUser, securityHeaders
} from "./src/auth.js";
import {
  db, normalizeServer, loadServers, listServerConfigs,
  createServerConfig, updateServerConfig, deleteServerConfig,
  recordMetrics, getHistory, generateAlerts, getAlerts, markAlertsRead, unreadAlertCount
} from "./src/db.js";
import {
  collectSnapshot, collectServer, fetchV6, fetchV5, getJson,
  toggleBlocking, getQueryLog
} from "./src/pihole.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "0.0.0.0";
const httpsEnabled = String(process.env.ENABLE_HTTPS || "").toLowerCase() === "true";
const httpsPort = Number(process.env.HTTPS_PORT || 8443);
const tlsCertFile = process.env.TLS_CERT_FILE || path.join(__dirname, "certs", "selfsigned.crt");
const tlsKeyFile = process.env.TLS_KEY_FILE || path.join(__dirname, "certs", "selfsigned.key");
const advertisedHosts = String(process.env.DASHBOARD_PUBLIC_HOST || process.env.PUBLIC_HOST || "");

let loggedDockerBridgeHostHint = false;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

// Static assets that are versioned via query-string cache-busting
const IMMUTABLE_EXTS = new Set([".css", ".js", ".svg", ".ico", ".png", ".woff2"]);

export const requestHandler = async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const headers = securityHeaders(httpsEnabled);

    // CSRF check for all state-changing API calls
    if (req.method !== "GET" && req.method !== "HEAD" && url.pathname.startsWith("/api/")) {
      if (!validateCsrf(req)) {
        res.writeHead(403, { ...headers, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("CSRF validation failed");
        return;
      }
    }

    // Health check (no auth)
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, { ok: true }, 200, headers);
    }

    // CSRF token endpoint (no auth — public, safe to call before login)
    if (req.method === "GET" && url.pathname === "/api/csrf-token") {
      return sendJson(res, { token: generateCsrfToken() }, 200, headers);
    }

    if (!isAuthorized(req)) {
      return sendUnauthorized(res, httpsEnabled);
    }

    // ── Authenticated routes ──────────────────────────────────────────────

    if (req.method === "GET" && url.pathname === "/api/me") {
      return sendJson(res, currentUser(req), 200, headers);
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      const { encryptPassword: _enc, ..._ } = {};
      return sendJson(res, {
        authMode,
        encryptionConfigured: Boolean(process.env.CONFIG_ENCRYPTION_KEY || process.env.CONFIG_ENCRYPTION_KEY_FILE),
        servers: listServerConfigs()
      }, 200, headers);
    }

    if (req.method === "POST" && url.pathname === "/api/snapshot") {
      const servers = loadServers();
      const snapshot = await collectSnapshot(servers);
      if (!snapshot.cached) {
        recordMetrics(snapshot);
        generateAlerts(snapshot);
      }
      return sendJson(res, snapshot, 200, headers);
    }

    if (req.method === "GET" && url.pathname === "/api/history") {
      const range = url.searchParams.get("range") || "24h";
      return sendJson(res, { history: getHistory(range) }, 200, headers);
    }

    if (req.method === "GET" && url.pathname === "/api/alerts") {
      return sendJson(res, { alerts: getAlerts(), unread: unreadAlertCount() }, 200, headers);
    }

    if (req.method === "POST" && url.pathname === "/api/alerts/read") {
      markAlertsRead();
      return sendJson(res, { ok: true }, 200, headers);
    }

    // /api/servers collection
    if (url.pathname === "/api/servers") {
      if (req.method === "GET") return sendJson(res, { servers: listServerConfigs() }, 200, headers);
      if (req.method === "POST") return sendJson(res, createServerConfig(await readJsonBody(req)), 201, headers);
    }

    // /api/servers/:id
    const serverRoute = url.pathname.match(/^\/api\/servers\/(\d+)$/);
    if (serverRoute) {
      const id = Number(serverRoute[1]);
      if (req.method === "PUT") {
        try {
          return sendJson(res, updateServerConfig(id, await readJsonBody(req)), 200, headers);
        } catch (err) {
          if (/not found/i.test(err.message)) return sendJson(res, { error: err.message }, 404, headers);
          throw err;
        }
      }
      if (req.method === "DELETE") {
        try {
          deleteServerConfig(id);
          return sendJson(res, { ok: true }, 200, headers);
        } catch (err) {
          if (/not found/i.test(err.message)) return sendJson(res, { error: err.message }, 404, headers);
          throw err;
        }
      }
    }

    // /api/servers/:id/test
    const testRoute = url.pathname.match(/^\/api\/servers\/(\d+)\/test$/);
    if (testRoute && req.method === "POST") {
      const id = Number(testRoute[1]);
      const servers = loadServers();
      const server = servers.find((s) => String(s.id) === String(id));
      if (!server) return sendJson(res, { error: "Server not found" }, 404, headers);
      const result = await collectServer(server);
      return sendJson(res, result, 200, headers);
    }

    // /api/servers/:id/blocking
    const blockingRoute = url.pathname.match(/^\/api\/servers\/(\d+)\/blocking$/);
    if (blockingRoute && req.method === "POST") {
      const id = Number(blockingRoute[1]);
      const body = await readJsonBody(req);
      if (typeof body.enabled !== "boolean") {
        return sendJson(res, { error: "enabled (boolean) is required" }, 400, headers);
      }
      const servers = loadServers();
      const server = servers.find((s) => String(s.id) === String(id));
      if (!server) return sendJson(res, { error: "Server not found" }, 404, headers);
      const result = await toggleBlocking(server, body.enabled);
      return sendJson(res, result, 200, headers);
    }

    // /api/servers/:id/queries
    const queriesRoute = url.pathname.match(/^\/api\/servers\/(\d+)\/queries$/);
    if (queriesRoute && req.method === "GET") {
      const id = Number(queriesRoute[1]);
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
      const servers = loadServers();
      const server = servers.find((s) => String(s.id) === String(id));
      if (!server) return sendJson(res, { error: "Server not found" }, 404, headers);
      const queries = await getQueryLog(server, limit);
      return sendJson(res, { queries }, 200, headers);
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, { error: "Method not allowed" }, 405, headers);
    }

    // Static file serving
    const filePath = resolveStaticPath(url.pathname);
    const file = await readFile(filePath);
    const ext = path.extname(filePath);
    const isVersioned = url.search.includes("v=") && IMMUTABLE_EXTS.has(ext);
    res.writeHead(200, {
      ...headers,
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": isVersioned ? "public, max-age=31536000, immutable" : "no-store"
    });
    if (req.method !== "HEAD") res.end(file);
    else res.end();
  } catch (error) {
    if (error?.code === "ENOENT") {
      res.writeHead(404, {
        ...securityHeaders(httpsEnabled),
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end("Not found");
      return;
    }
    console.error(error);
    sendJson(res, { error: error.message || "Internal server error" }, 500, securityHeaders(httpsEnabled));
  }
};

async function startServer() {
  createServer(requestHandler).listen(port, host, () => {
    logListeningUrls("http", port, host);
  });

  if (httpsEnabled) {
    const tls = { cert: await readFile(tlsCertFile), key: await readFile(tlsKeyFile) };
    createHttpsServer(tls, requestHandler).listen(httpsPort, host, () => {
      logListeningUrls("https", httpsPort, host);
    });
  }
}

function gracefulShutdown(signal) {
  console.log(`${signal} received — shutting down`);
  try { db.close(); } catch {}
  process.exit(0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));
if (isMain) {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function logListeningUrls(protocol, listenPort, listenHost) {
  const { urls, hiddenContainerHosts, usedFallbackHost } = getListeningUrls(protocol, listenPort, listenHost);
  console.log("Pi-hole dashboard listening on " + urls.join(", "));
  if (usedFallbackHost && hiddenContainerHosts.length && !loggedDockerBridgeHostHint) {
    loggedDockerBridgeHostHint = true;
    console.log("Docker bridge address " + hiddenContainerHosts.join(", ") + " was hidden because it is usually not reachable from your LAN. Set DASHBOARD_PUBLIC_HOST to your host LAN IP or DNS name to advertise it in startup logs.");
  }
}

function getListeningUrls(protocol, listenPort, listenHost) {
  const configuredHosts = parseAdvertisedHosts(advertisedHosts);
  const detectedHosts = isWildcardHost(listenHost) ? getLocalIpAddresses() : [listenHost];
  const hiddenContainerHosts = configuredHosts.length ? [] : detectedHosts.filter(isContainerOnlyAddress);
  const hosts = configuredHosts.length ? configuredHosts : detectedHosts.filter((a) => !isContainerOnlyAddress(a));
  const uniqueHosts = hosts.length ? [...new Set(hosts)] : ["localhost"];
  return {
    hiddenContainerHosts,
    urls: uniqueHosts.map((h) => formatListeningUrl(protocol, h, listenPort)),
    usedFallbackHost: hosts.length === 0
  };
}

function parseAdvertisedHosts(value) {
  return String(value || "").split(/[\s,]+/).map(normalizeAdvertisedHost).filter(Boolean);
}

function normalizeAdvertisedHost(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  try {
    return new URL(source.includes("://") ? source : "http://" + source).host;
  } catch {
    return source.replace(/^https?:\/\//i, "").split("/")[0];
  }
}

function formatListeningUrl(protocol, urlHost, listenPort) {
  const hostWithPort = hostHasPort(urlHost) ? urlHost : formatUrlHost(urlHost) + ":" + listenPort;
  return protocol + "://" + hostWithPort;
}

function hostHasPort(urlHost) {
  if (urlHost.startsWith("[")) return urlHost.includes("]:");
  const parts = urlHost.split(":");
  return parts.length === 2 && /^\d+$/.test(parts[1]);
}

function isWildcardHost(listenHost) {
  return listenHost === "0.0.0.0" || listenHost === "::" || listenHost === "";
}

function getLocalIpAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const details of interfaces || []) {
      if (details.internal || details.family !== "IPv4") continue;
      addresses.push(details.address);
    }
  }
  return [...new Set(addresses)];
}

function isContainerOnlyAddress(address) {
  return isRunningInContainer() && /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
}

function isRunningInContainer() {
  return existsSync("/.dockerenv") || Boolean(process.env.KUBERNETES_SERVICE_HOST);
}

function formatUrlHost(urlHost) {
  return urlHost.includes(":") && !urlHost.startsWith("[") ? "[" + urlHost + "]" : urlHost;
}

function resolveStaticPath(pathname) {
  const cleaned = decodeURIComponent(pathname).replace(/\\/g, "/");
  const relative = cleaned === "/" ? "index.html" : cleaned.replace(/^\/+/, "");
  const resolved = path.resolve(publicDir, relative);
  const relativeToPublic = path.relative(publicDir, resolved);
  if (relativeToPublic.startsWith("..") || path.isAbsolute(relativeToPublic)) throw new Error("Invalid path");
  return resolved;
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, data, status = 200, headers = {}) {
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

// ── Re-exports (backward compat for tests and external consumers) ─────────────

export {
  encryptPassword, decryptPassword,
  isAuthorized, isProxyAuthorized, isRequestFromTrustedProxy,
  parseTrustedProxyRules, matchesTrustedProxyRule,
  sendUnauthorized, currentUser,
  normalizeServer, loadServers, listServerConfigs,
  createServerConfig, updateServerConfig, deleteServerConfig,
  collectSnapshot, collectServer, fetchV6, fetchV5, getJson
};
