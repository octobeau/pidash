const timeoutMs = Number(process.env.PIHOLE_TIMEOUT_MS || 7000);

// In-memory v6 session cache: Map<serverId, {sid, expires}>
const sessionCache = new Map();

// In-memory snapshot cache for rate limiting
let lastSnapshotResult = null;
let lastSnapshotTime = 0;
const MIN_SNAPSHOT_INTERVAL_MS = 5_000;

export async function collectSnapshot(rawServers, { force = false } = {}) {
  const now = Date.now();
  if (!force && lastSnapshotResult && (now - lastSnapshotTime) < MIN_SNAPSHOT_INTERVAL_MS) {
    return { ...lastSnapshotResult, cached: true };
  }

  const results = await Promise.all(rawServers.map((server) => collectServer(server)));
  const snapshot = {
    generatedAt: new Date().toISOString(),
    totals: aggregate(results),
    servers: results,
    cached: false
  };

  lastSnapshotResult = snapshot;
  lastSnapshotTime = now;
  return snapshot;
}

export async function collectServer(server) {
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

export async function fetchV6(server) {
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

export async function fetchV5(server) {
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

// ── Blocking toggle ──────────────────────────────────────────────────────────

export async function toggleBlocking(server, enabled) {
  if (server.version === "5" || (server.version === "auto" && await isV5(server))) {
    const auth = server.password ? `&auth=${encodeURIComponent(server.password)}` : "";
    const cmd = enabled ? "enable" : "disable";
    await getJson(`${server.url}/admin/api.php?${cmd}${auth}`);
    return { enabled };
  }

  // v6
  const headers = await v6Headers(server);
  await getJson(`${server.url}/api/dns/blocking`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ blocking: enabled })
  });
  return { enabled };
}

async function isV5(server) {
  try {
    await getJson(`${server.url}/api/stats/summary`, {}, true);
    return false; // v6 responded
  } catch {
    return true; // assume v5
  }
}

// ── Query log ────────────────────────────────────────────────────────────────

export async function getQueryLog(server, limit = 100) {
  if (server.version === "5") {
    const auth = server.password ? `&auth=${encodeURIComponent(server.password)}` : "";
    const raw = await getJson(`${server.url}/admin/api.php?getAllQueries=${limit}${auth}`, {}, true);
    const data = raw?.data || [];
    return data.map((q) => ({
      time: q[0] ? new Date(Number(q[0]) * 1000).toISOString() : "",
      type: q[1] || "",
      domain: q[2] || "",
      client: q[3] || "",
      status: q[4] || ""
    }));
  }

  // v6
  const headers = await v6Headers(server);
  const raw = await getJson(`${server.url}/api/queries?max=${limit}`, { headers }, true);
  const queries = raw?.queries || [];
  return queries.map((q) => ({
    time: q.time ? new Date(Number(q.time) * 1000).toISOString() : "",
    type: q.type || "",
    domain: q.domain || "",
    client: q.client?.ip || q.client || "",
    status: q.status || ""
  }));
}

// ── v6 session management ────────────────────────────────────────────────────

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
  if (!sid && session.valid === true && /no password set/i.test(String(session.message || ""))) {
    return {};
  }
  if (!sid) throw new Error(v6MissingSidMessage(session));
  sessionCache.set(server.id, { sid, expires: Date.now() + Number(session.validity || 300) * 1000 });
  return { "X-FTL-SID": sid };
}

function v6MissingSidMessage(session) {
  const parts = ["Pi-hole v6 auth did not return a session id"];
  if (session.totp) parts.push("2FA appears to be enabled; use a Pi-hole application password in Pidash");
  if (session.valid === false) parts.push("Pi-hole marked the session invalid");
  if (session.message) parts.push(String(session.message));
  return parts.join(": ");
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

export async function getJson(url, options = {}, optional = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      if (optional && [401, 403, 404].includes(response.status)) return null;
      const detail = await responseErrorDetail(response);
      throw new Error(`${response.status} ${response.statusText} from ${new URL(url).pathname}${detail ? `: ${detail}` : ""}`);
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

async function responseErrorDetail(response) {
  const type = response.headers.get("content-type") || "";
  try {
    if (type.includes("application/json")) {
      const body = await response.json();
      return body?.error?.message || body?.error?.key || body?.message || "";
    }
    return (await response.text()).trim().slice(0, 200);
  } catch {
    return "";
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

// ── Data normalization ───────────────────────────────────────────────────────

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
  const online = servers.filter((s) => s.online);
  const totals = online.reduce((acc, s) => {
    acc.queries += s.summary.queries;
    acc.blocked += s.summary.blocked;
    acc.forwarded += s.summary.forwarded;
    acc.cached += s.summary.cached;
    acc.clients += s.summary.clients;
    // domains: max across servers (shared blocklists would double-count with sum)
    acc.domains = Math.max(acc.domains, s.summary.domains);
    return acc;
  }, emptySummary());
  totals.blockRate = totals.queries ? (totals.blocked / totals.queries) * 100 : 0;
  return { ...totals, online: online.length, total: servers.length };
}

function emptySummary() {
  return { queries: 0, blocked: 0, blockRate: 0, domains: 0, forwarded: 0, cached: 0, clients: 0, status: "unknown" };
}

export function objectFromAny(input) {
  if (!input || typeof input !== "object") return {};
  if (Array.isArray(input)) {
    return Object.fromEntries(
      input.map((item) => [item.name || item.type || item[0], number(item.count || item.value || item[1])])
        .filter(([key]) => key)
    );
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, number(value?.count ?? value)]));
}

export function listFromAny(input) {
  if (!input || typeof input !== "object") return [];
  if (Array.isArray(input)) {
    return input.map((item) => ({
      label: String(item.domain || item.client || item.name || item.ip || item[0] || "unknown"),
      count: number(item.count ?? item.queries ?? item.value ?? item[1])
    })).filter((item) => item.label !== "unknown" || item.count);
  }
  return Object.entries(input).map(([label, count]) => ({ label, count: number(count?.count ?? count) }));
}

export function historyFromAny(input) {
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
