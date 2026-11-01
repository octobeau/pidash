import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptPassword, decryptPassword } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, "..", "data", "pidash.sqlite");
const configPath = process.env.PIHOLE_CONFIG || path.join(__dirname, "..", "config", "piholes.json");

export const colors = ["#39d98a", "#4c9ffe", "#f97373", "#f5b642", "#a78bfa", "#22d3ee"];

// Range definitions: [label, hours back, bucket size minutes]
const HISTORY_RANGES = {
  "1h":  { hours: 1,    bucketMinutes: 5   },
  "6h":  { hours: 6,    bucketMinutes: 15  },
  "24h": { hours: 24,   bucketMinutes: 60  },
  "7d":  { hours: 168,  bucketMinutes: 360 }
};

export const db = openDatabase();

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

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      online INTEGER NOT NULL DEFAULT 1,
      queries INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      block_rate REAL NOT NULL DEFAULT 0,
      forwarded INTEGER NOT NULL DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0,
      clients INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_metrics ON metrics(server_id, captured_at);

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      server_name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      read INTEGER NOT NULL DEFAULT 0
    );
  `);

  seedDatabase(database);
  pruneOldData(database);
  return database;
}

function seedDatabase(database) {
  const count = database.prepare("SELECT COUNT(*) AS count FROM servers").get().count;
  if (count > 0 || !existsSync(configPath)) return;

  try {
    let raw = JSON.parse(readFileSync(configPath, "utf8"));
    if (!Array.isArray(raw)) raw = raw.servers || [];
    let seeded = 0;
    raw.forEach((entry, index) => {
      const server = normalizeServer(entry, index);
      if (server) { insertServer(database, server); seeded++; }
    });
    console.log(`Seeded ${seeded} Pi-hole server(s) from ${configPath}`);
  } catch (error) {
    console.warn(`Could not seed database from ${configPath}: ${error.message}`);
  }
}

function pruneOldData(database) {
  // Keep 30 days of metrics
  database.prepare("DELETE FROM metrics WHERE captured_at < datetime('now', '-30 days')").run();
  // Keep 7 days of read alerts
  database.prepare("DELETE FROM alerts WHERE read = 1 AND created_at < datetime('now', '-7 days')").run();
}

// ── Server CRUD ──────────────────────────────────────────────────────────────

export function loadServers() {
  return db.prepare("SELECT * FROM servers WHERE enabled = 1 ORDER BY id").all().map(rowToServer);
}

export function listServerConfigs() {
  return db.prepare("SELECT * FROM servers ORDER BY id").all().map(redactServerRow);
}

export function createServerConfig(input) {
  const server = normalizeServer(input);
  if (!server) throw new Error("Server URL is required");
  const id = insertServer(db, server);
  return redactServerRow(db.prepare("SELECT * FROM servers WHERE id = ?").get(id));
}

export function updateServerConfig(id, input) {
  const existing = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
  if (!existing) throw new Error("Server not found");

  const clearPassword = input.clearPassword === true;
  const hasPasswordInput = Object.prototype.hasOwnProperty.call(input, "password");
  const password = clearPassword ? "" : hasPasswordInput ? input.password : decryptPassword(existing.password_cipher);
  const normalized = normalizeServer({ ...input, password });
  if (!normalized) throw new Error("Server URL is required");

  const passwordCipher = clearPassword ? "" : hasPasswordInput ? encryptPassword(input.password) : existing.password_cipher;
  db.prepare(`
    UPDATE servers
    SET name = ?, url = ?, password_cipher = ?, version = ?, color = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(normalized.name, normalized.url, passwordCipher, normalized.version, normalized.color, normalized.enabled === false ? 0 : 1, id);

  return redactServerRow(db.prepare("SELECT * FROM servers WHERE id = ?").get(id));
}

export function deleteServerConfig(id) {
  const result = db.prepare("DELETE FROM servers WHERE id = ?").run(id);
  if (result.changes === 0) throw new Error("Server not found");
}

function insertServer(database, server) {
  const result = database.prepare(`
    INSERT INTO servers (name, url, password_cipher, version, color, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(server.name, server.url, encryptPassword(server.password), server.version, server.color, server.enabled === false ? 0 : 1);
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

// ── Metrics ──────────────────────────────────────────────────────────────────

export function recordMetrics(snapshot) {
  const stmt = db.prepare(`
    INSERT INTO metrics (server_id, captured_at, online, queries, blocked, block_rate, forwarded, cached, clients)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const server of snapshot.servers) {
    const s = server.summary;
    stmt.run(String(server.id), snapshot.generatedAt, server.online ? 1 : 0,
      s.queries, s.blocked, s.blockRate, s.forwarded, s.cached, s.clients);
  }
}

export function getHistory(range = "24h") {
  const config = HISTORY_RANGES[range] || HISTORY_RANGES["24h"];
  const cutoff = new Date(Date.now() - config.hours * 3_600_000).toISOString();
  const bucketSec = config.bucketMinutes * 60;

  const rows = db.prepare(`
    SELECT
      server_id,
      datetime((strftime('%s', captured_at) / ?) * ?, 'unixepoch') AS bucket,
      AVG(queries)    AS queries,
      AVG(blocked)    AS blocked,
      AVG(block_rate) AS block_rate,
      MAX(online)     AS online
    FROM metrics
    WHERE captured_at >= ?
    GROUP BY server_id, bucket
    ORDER BY server_id, bucket
  `).all(bucketSec, bucketSec, cutoff);

  // Group by server_id
  const byServer = {};
  for (const row of rows) {
    if (!byServer[row.server_id]) byServer[row.server_id] = [];
    byServer[row.server_id].push({
      time: row.bucket,
      queries: Math.round(row.queries),
      blocked: Math.round(row.blocked),
      blockRate: Number(row.block_rate.toFixed(2)),
      online: Boolean(row.online)
    });
  }

  // Include server names
  const serverRows = db.prepare("SELECT id, name, color FROM servers ORDER BY id").all();
  return serverRows.map((s) => ({
    id: String(s.id),
    name: s.name,
    color: s.color,
    points: byServer[String(s.id)] || []
  }));
}

// ── Alerts ───────────────────────────────────────────────────────────────────

// Track last known online state per server (in memory — acceptable for single-process)
const lastOnlineState = new Map();

export function generateAlerts(snapshot) {
  for (const server of snapshot.servers) {
    const sid = String(server.id);
    const wasOnline = lastOnlineState.get(sid);
    const isNowOnline = server.online;

    if (wasOnline === true && !isNowOnline) {
      db.prepare(`INSERT INTO alerts (server_id, server_name, type, message) VALUES (?, ?, ?, ?)`)
        .run(sid, server.name, "offline", `${server.name} went offline`);
    } else if (wasOnline === false && isNowOnline) {
      db.prepare(`INSERT INTO alerts (server_id, server_name, type, message) VALUES (?, ?, ?, ?)`)
        .run(sid, server.name, "online", `${server.name} came back online`);
    }

    lastOnlineState.set(sid, isNowOnline);
  }
}

export function getAlerts(limit = 50) {
  return db.prepare(`
    SELECT id, server_id, server_name, type, message, created_at, read
    FROM alerts
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

export function markAlertsRead() {
  db.prepare("UPDATE alerts SET read = 1 WHERE read = 0").run();
}

export function unreadAlertCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE read = 0").get().count;
}

// ── Server normalizer (shared with pihole.js) ─────────────────────────────

export function normalizeServer(input, index = 0) {
  if (!input) return null;
  const source = input.url || input.baseUrl || input.host;
  if (!source) return null;

  const parsed = new URL(source.includes("://") ? source : `http://${source}`);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Server URL must use http or https");
  }

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
