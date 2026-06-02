import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "0.0.0.0";
const httpsEnabled = String(process.env.ENABLE_HTTPS || "").toLowerCase() === "true";
const httpsPort = Number(process.env.HTTPS_PORT || 8443);
const tlsCertFile = process.env.TLS_CERT_FILE || path.join(__dirname, "certs", "selfsigned.crt");
const tlsKeyFile = process.env.TLS_KEY_FILE || path.join(__dirname, "certs", "selfsigned.key");
const configPath = process.env.PIHOLE_CONFIG || path.join(__dirname, "config", "piholes.json");
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, "data", "pidash.sqlite");
const timeoutMs = Number(process.env.PIHOLE_TIMEOUT_MS || 7000);
const authMode = String(process.env.AUTH_MODE || "basic").toLowerCase();
const dashboardUser = process.env.DASHBOARD_USERNAME || "admin";
const dashboardPassword = process.env.DASHBOARD_PASSWORD || "";
const authProxyUserHeader = normalizeHeaderName(process.env.AUTH_PROXY_USER_HEADER || "x-forwarded-user");
const authProxyEmailHeader = normalizeHeaderName(process.env.AUTH_PROXY_EMAIL_HEADER || "x-forwarded-email");
const authProxyNameHeader = normalizeHeaderName(process.env.AUTH_PROXY_NAME_HEADER || "x-forwarded-name");
const encryptionSecret = process.env.CONFIG_ENCRYPTION_KEY || "";

const colors = ["#39d98a", "#4c9ffe", "#f97373", "#f5b642", "#a78bfa", "#22d3ee"];
const sessionCache = new Map();
const db = openDatabase();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const requestHandler = async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, { ok: true });
    }

    if (!isAuthorized(req)) {
      return sendUnauthorized(res);
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      return sendJson(res, currentUser(req));
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, {
        authMode,
        encryptionConfigured: Boolean(encryptionSecret),
        servers: listServerConfigs()
      });
    }

    if (req.method === "POST" && url.pathname === "/api/snapshot") {
      const servers = loadServers();
      const snapshot = await collectSnapshot(servers);
      return sendJson(res, snapshot);
    }

    if (url.pathname === "/api/servers") {
      if (req.method === "GET") return sendJson(res, { servers: listServerConfigs() });
      if (req.method === "POST") return sendJson(res, createServerConfig(await readJsonBody(req)), 201);
    }

    const serverRoute = url.pathname.match(/^\/api\/servers\/(\d+)$/);
    if (serverRoute) {
      const id = Number(serverRoute[1]);
      if (req.method === "PUT") return sendJson(res, updateServerConfig(id, await readJsonBody(req)));
      if (req.method === "DELETE") {
        deleteServerConfig(id);
        return sendJson(res, { ok: true });
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, { error: "Method not allowed" }, 405);
    }

    const filePath = resolveStaticPath(url.pathname);
    const file = await readFile(filePath);
    res.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    if (req.method !== "HEAD") res.end(file);
    else res.end();
  } catch (error) {
    if (error?.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    console.error(error);
    sendJson(res, { error: error.message || "Internal server error" }, 500);
  }
};

createServer(requestHandler).listen(port, host, () => {
  console.log(`Pi-hole dashboard listening on http://${host}:${port}`);
});

if (httpsEnabled) {
  const tls = {
    cert: await readFile(tlsCertFile),
    key: await readFile(tlsKeyFile)
  };
  createHttpsServer(tls, requestHandler).listen(httpsPort, host, () => {
    console.log(`Pi-hole dashboard listening on https://${host}:${httpsPort}`);
  });
}

function openDatabase() {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      password_cipher TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT 'auto',
      color TEXT NOT NULL DEFAULT '#39d98a',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  seedDatabase(database);
  return database;
}

function seedDatabase(database) {
  const count = database.prepare("SELECT COUNT(*) AS count FROM servers").get().count;
  if (count > 0 || !existsSync(configPath)) return;

  try {
    let raw = JSON.parse(readFileSyncText(configPath));
    if (!Array.isArray(raw)) raw = raw.servers || [];
    raw.map(normalizeServer).filter(Boolean).forEach((server) => insertServer(database, server));
    console.log(`Seeded ${raw.length} Pi-hole server(s) from ${configPath}`);
  } catch (error) {
    console.warn(`Could not seed database from ${configPath}: ${error.message}`);
  }
}

function readFileSyncText(filePath) {
  return readFileSync(filePath, "utf8");
}

function loadServers() {
  return db.prepare("SELECT * FROM servers WHERE enabled = 1 ORDER BY id").all().map(rowToServer);
}

function normalizeServer(input, index = 0) {
  if (!input) return null;
  const source = input.url || input.baseUrl || input.host;
  if (!source) return null;

  const parsed = new URL(source.includes("://") ? source : `http://${source}`);
  parsed.pathname = parsed.pathname
    .replace(/\/admin\/api\.php$/i, "")
    .replace(/\/admin\/?$/i, "")
    .replace(/\/api\/?$/i, "")
    .replace(/\/+$/g, "");
  parsed.search = "";
  parsed.hash = "";

  return {
    id: input.id || null,
    name: input.name || parsed.hostname || `Pi-hole ${index + 1}`,
    url: parsed.toString().replace(/\/$/, ""),
    password: input.password || input.token || input.apiKey || "",
    version: String(input.version || input.apiVersion || "auto").toLowerCase(),
    color: input.color || colors[index % colors.length],
    enabled: input.enabled === undefined ? true : input.enabled !== false && input.enabled !== "false"
  };
}

function listServerConfigs() {
  return db.prepare("SELECT * FROM servers ORDER BY id").all().map(redactServerRow);
}

function createServerConfig(input) {
  const server = normalizeServer(input);
  if (!server) throw new Error("Server URL is required");
  const id = insertServer(db, server);
  return redactServerRow(db.prepare("SELECT * FROM servers WHERE id = ?").get(id));
}

function updateServerConfig(id, input) {
  const existing = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
  if (!existing) throw new Error("Server not found");

  const normalized = normalizeServer({ ...input, password: input.password || decryptPassword(existing.password_cipher) });
  if (!normalized) throw new Error("Server URL is required");
  const passwordCipher = input.password ? encryptPassword(input.password) : existing.password_cipher;
  db.prepare(`
    UPDATE servers
    SET name = ?, url = ?, password_cipher = ?, version = ?, color = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    normalized.name,
    normalized.url,
    passwordCipher,
    normalized.version,
    normalized.color,
    normalized.enabled === false ? 0 : 1,
    id
  );
  return redactServerRow(db.prepare("SELECT * FROM servers WHERE id = ?").get(id));
}

function deleteServerConfig(id) {
  db.prepare("DELETE FROM servers WHERE id = ?").run(id);
}

function insertServer(database, server) {
  const result = database.prepare(`
    INSERT INTO servers (name, url, password_cipher, version, color, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    server.name,
    server.url,
    encryptPassword(server.password),
    server.version,
    server.color,
    server.enabled === false ? 0 : 1
  );
  return result.lastInsertRowid;
}

function rowToServer(row) {
  return {
    id: String(row.id),
    name: row.name,
    url: row.url,
    password: decryptPassword(row.password_cipher),
    version: row.version,
    color: row.color
  };
}

function redactServerRow(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    version: row.version,
    color: row.color,
    enabled: Boolean(row.enabled),
    hasPassword: Boolean(row.password_cipher)
  };
}

function encryptPassword(password) {
  if (!password) return "";
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(password), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptPassword(ciphertext) {
  if (!ciphertext) return "";
  const [version, iv, tag, encrypted] = String(ciphertext).split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Unsupported encrypted password format");

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function encryptionKey() {
  if (!encryptionSecret) {
    throw new Error("CONFIG_ENCRYPTION_KEY is required before storing Pi-hole passwords");
  }

  const decoded = Buffer.from(encryptionSecret, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(encryptionSecret).digest();
}

async function collectSnapshot(rawServers) {
  const servers = rawServers.map(normalizeServer).filter(Boolean);
  const results = await Promise.all(servers.map((server) => collectServer(server)));
  return {
    generatedAt: new Date().toISOString(),
    totals: aggregate(results),
    servers: results
  };
}

async function collectServer(server) {
  const started = Date.now();
  try {
    const data = server.version === "5"
      ? await fetchV5(server)
      : server.version === "6"
        ? await fetchV6(server)
        : await fetchAuto(server);

    return {
      id: server.id,
      name: server.name,
      url: server.url,
      color: server.color,
      online: true,
      version: data.version,
      latencyMs: Date.now() - started,
      summary: data.summary,
      queryTypes: data.queryTypes,
      topDomains: data.topDomains,
      topBlocked: data.topBlocked,
      topClients: data.topClients,
      upstreams: data.upstreams,
      history: data.history,
      error: null
    };
  } catch (error) {
    return {
      id: server.id,
      name: server.name,
      url: server.url,
      color: server.color,
      online: false,
      version: server.version === "auto" ? "unknown" : server.version,
      latencyMs: Date.now() - started,
      summary: emptySummary(),
      queryTypes: {},
      topDomains: [],
      topBlocked: [],
      topClients: [],
      upstreams: [],
      history: [],
      error: error.message
    };
  }
}

async function fetchAuto(server) {
  try {
    return await fetchV6(server);
  } catch (v6Error) {
    try {
      return await fetchV5(server);
    } catch (v5Error) {
      throw new Error(`v6: ${v6Error.message}; v5: ${v5Error.message}`);
    }
  }
}

async function fetchV6(server) {
  const headers = await v6Headers(server);
  const [summaryRaw, queryTypesRaw, topDomainsRaw, topBlockedRaw, topClientsRaw, upstreamsRaw, historyRaw, blockingRaw] = await Promise.all([
    getJson(`${server.url}/api/stats/summary`, { headers }),
    getJson(`${server.url}/api/stats/query_types`, { headers }, true),
    getJson(`${server.url}/api/stats/top_domains?count=10`, { headers }, true),
    getJson(`${server.url}/api/stats/top_domains?blocked=true&count=10`, { headers }, true),
    getJson(`${server.url}/api/stats/top_clients?count=10`, { headers }, true),
    getJson(`${server.url}/api/stats/upstreams`, { headers }, true),
    getJson(`${server.url}/api/history`, { headers }, true),
    getJson(`${server.url}/api/dns/blocking`, { headers }, true)
  ]);

  return {
    version: "6",
    summary: normalizeV6Summary(summaryRaw, blockingRaw),
    queryTypes: objectFromAny(queryTypesRaw?.types || queryTypesRaw?.querytypes || queryTypesRaw),
    topDomains: listFromAny(topDomainsRaw?.domains?.allowed || topDomainsRaw?.top_domains || topDomainsRaw?.domains || topDomainsRaw),
    topBlocked: listFromAny(topBlockedRaw?.domains?.blocked || topBlockedRaw?.top_ads || topBlockedRaw?.domains || topBlockedRaw),
    topClients: listFromAny(topClientsRaw?.clients || topClientsRaw?.top_clients || topClientsRaw),
    upstreams: listFromAny(upstreamsRaw?.upstreams || upstreamsRaw?.forward_destinations || upstreamsRaw),
    history: historyFromAny(historyRaw)
  };
}

async function v6Headers(server) {
  if (!server.password) return {};
  const cached = sessionCache.get(server.id);
  if (cached?.expires > Date.now() + 5000) return { "X-FTL-SID": cached.sid };

  const auth = await getJson(`${server.url}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: server.password })
  });
  const session = auth.session || auth;
  const sid = session.sid;
  if (!sid) throw new Error("Pi-hole v6 auth did not return a session id");
  sessionCache.set(server.id, {
    sid,
    expires: Date.now() + Number(session.validity || 300) * 1000
  });
  return { "X-FTL-SID": sid };
}

async function fetchV5(server) {
  const auth = server.password ? `&auth=${encodeURIComponent(server.password)}` : "";
  const api = `${server.url}/admin/api.php`;
  const [summaryRaw, queryTypesRaw, topItemsRaw, topClientsRaw, overtimeRaw, forwardedRaw] = await Promise.all([
    getJson(`${api}?summaryRaw${auth}`),
    getJson(`${api}?getQueryTypes${auth}`, {}, true),
    getJson(`${api}?topItems=10${auth}`, {}, true),
    getJson(`${api}?topClients=10${auth}`, {}, true),
    getJson(`${api}?overTimeData10mins${auth}`, {}, true),
    getJson(`${api}?getForwardDestinations${auth}`, {}, true)
  ]);

  return {
    version: "5",
    summary: normalizeV5Summary(summaryRaw),
    queryTypes: objectFromAny(queryTypesRaw?.querytypes || queryTypesRaw),
    topDomains: listFromAny(topItemsRaw?.top_queries || topItemsRaw?.top_sources || []),
    topBlocked: listFromAny(topItemsRaw?.top_ads || []),
    topClients: listFromAny(topClientsRaw?.top_sources || topClientsRaw?.top_clients || topClientsRaw),
    upstreams: listFromAny(forwardedRaw?.forward_destinations || forwardedRaw),
    history: historyFromAny(overtimeRaw)
  };
}

async function getJson(url, options = {}, optional = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      if (optional && [401, 403, 404].includes(response.status)) return null;
      throw new Error(`${response.status} ${response.statusText} from ${new URL(url).pathname}`);
    }
    if (response.status === 204) return null;
    return await response.json();
  } catch (error) {
    if (optional) return null;
    if (error.name === "AbortError") throw new Error(`Timed out calling ${new URL(url).host}`);
    throw new Error(formatFetchError(error, url));
  } finally {
    clearTimeout(timer);
  }
}

function formatFetchError(error, url) {
  const target = new URL(url);
  const cause = deepestCause(error);
  const code = cause?.code || error?.cause?.code || error?.code;
  const certCodes = new Set([
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID"
  ]);

  if (certCodes.has(code)) {
    return `TLS certificate rejected for ${target.origin}. Use http if your Pi-hole exposes the API over LAN HTTP, or set NODE_TLS_REJECT_UNAUTHORIZED=0 for a self-signed HTTPS certificate.`;
  }

  if (code === "ECONNREFUSED") return `Connection refused by ${target.origin}`;
  if (code === "ENOTFOUND") return `Could not resolve ${target.hostname}`;
  return cause?.message || error.message || `Failed to call ${target.origin}`;
}

function deepestCause(error) {
  let current = error;
  while (current?.cause && current.cause !== current) current = current.cause;
  return current;
}

function normalizeV5Summary(raw) {
  return {
    queries: number(raw?.dns_queries_today ?? raw?.total_queries),
    blocked: number(raw?.ads_blocked_today),
    blockRate: number(raw?.ads_percentage_today),
    domains: number(raw?.domains_being_blocked),
    forwarded: number(raw?.queries_forwarded),
    cached: number(raw?.queries_cached),
    clients: number(raw?.unique_clients),
    status: raw?.status || "unknown"
  };
}

function normalizeV6Summary(raw, blockingRaw) {
  const queries = number(pathValue(raw, ["queries.total", "queries.total_today", "total_queries", "dns_queries_today"]));
  const blocked = number(pathValue(raw, ["queries.blocked", "queries.blocked_today", "ads_blocked_today"]));
  return {
    queries,
    blocked,
    blockRate: number(pathValue(raw, ["queries.percent_blocked", "ads_percentage_today"])) || (queries ? (blocked / queries) * 100 : 0),
    domains: number(pathValue(raw, ["gravity.domains_being_blocked", "gravity.domains", "domains_being_blocked"])),
    forwarded: number(pathValue(raw, ["queries.forwarded", "queries.forwarded_today", "queries_forwarded"])),
    cached: number(pathValue(raw, ["queries.cached", "queries.cached_today", "queries_cached"])),
    clients: number(pathValue(raw, ["clients.active", "clients.total", "unique_clients"])),
    status: blockingRaw?.blocking === false ? "disabled" : "enabled"
  };
}

function aggregate(servers) {
  const online = servers.filter((server) => server.online);
  const totals = online.reduce((acc, server) => {
    acc.queries += server.summary.queries;
    acc.blocked += server.summary.blocked;
    acc.domains += server.summary.domains;
    acc.forwarded += server.summary.forwarded;
    acc.cached += server.summary.cached;
    acc.clients += server.summary.clients;
    return acc;
  }, emptySummary());
  totals.blockRate = totals.queries ? (totals.blocked / totals.queries) * 100 : 0;
  return {
    ...totals,
    online: online.length,
    total: servers.length
  };
}

function emptySummary() {
  return { queries: 0, blocked: 0, blockRate: 0, domains: 0, forwarded: 0, cached: 0, clients: 0, status: "unknown" };
}

function objectFromAny(input) {
  if (!input || typeof input !== "object") return {};
  if (Array.isArray(input)) {
    return Object.fromEntries(input.map((item) => [item.name || item.type || item[0], number(item.count || item.value || item[1])]).filter(([key]) => key));
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, number(value?.count ?? value)]));
}

function listFromAny(input) {
  if (!input || typeof input !== "object") return [];
  if (Array.isArray(input)) {
    return input.map((item) => ({
      label: String(item.domain || item.client || item.name || item.ip || item[0] || "unknown"),
      count: number(item.count ?? item.queries ?? item.value ?? item[1])
    })).filter((item) => item.label !== "unknown" || item.count);
  }
  return Object.entries(input).map(([label, count]) => ({ label, count: number(count?.count ?? count) }));
}

function historyFromAny(input) {
  const raw = input?.history || input?.domains_over_time || input?.over_time_data || input;
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => ({
      label: String(item.timestamp || item.time || item.label || ""),
      queries: number(item.queries ?? item.total ?? item.queries_total),
      blocked: number(item.blocked ?? item.ads ?? item.ads_total)
    })).slice(-48);
  }
  return Object.entries(raw).map(([label, value]) => ({
    label,
    queries: number(value?.queries ?? value?.queries_total ?? value?.total ?? value),
    blocked: number(value?.blocked ?? value?.ads_total ?? value?.ads ?? 0)
  })).slice(-48);
}

function pathValue(object, paths) {
  for (const item of paths) {
    const value = item.split(".").reduce((acc, key) => acc?.[key], object);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pihole";
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

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendUnauthorized(res) {
  const headers = {
    ...securityHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  };
  if (authMode === "basic") headers["WWW-Authenticate"] = 'Basic realm="Pi-hole Dashboard"';
  res.writeHead(401, headers);
  res.end("Authentication required");
}

function isAuthorized(req) {
  if (authMode === "none") return true;
  if (authMode === "proxy") return isProxyAuthorized(req);
  if (authMode !== "basic") return false;
  if (!dashboardPassword) return false;

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return safeEqual(username, dashboardUser) && safeEqual(password, dashboardPassword);
  } catch {
    return false;
  }
}

function isProxyAuthorized(req) {
  const username = headerValue(req, authProxyUserHeader);
  return Boolean(username);
}

function currentUser(req) {
  if (authMode === "proxy") {
    return {
      mode: authMode,
      username: headerValue(req, authProxyUserHeader),
      email: headerValue(req, authProxyEmailHeader),
      name: headerValue(req, authProxyNameHeader)
    };
  }

  return {
    mode: authMode,
    username: authMode === "basic" ? dashboardUser : ""
  };
}

function headerValue(req, headerName) {
  const value = req.headers[headerName];
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function normalizeHeaderName(name) {
  return String(name).trim().toLowerCase();
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}
