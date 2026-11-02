import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const authMode = String(process.env.AUTH_MODE || "basic").toLowerCase();
const dashboardUser = process.env.DASHBOARD_USERNAME || "admin";
const dashboardPassword = process.env.DASHBOARD_PASSWORD || "";
const authProxyUserHeader = normalizeHeaderName(process.env.AUTH_PROXY_USER_HEADER || "x-forwarded-user");
const authProxyEmailHeader = normalizeHeaderName(process.env.AUTH_PROXY_EMAIL_HEADER || "x-forwarded-email");
const authProxyNameHeader = normalizeHeaderName(process.env.AUTH_PROXY_NAME_HEADER || "x-forwarded-name");
const trustedProxiesRaw = String(process.env.TRUSTED_PROXIES || "127.0.0.1,::1");

export const trustedProxyRules = parseTrustedProxyRules(trustedProxiesRaw);

// Per-process random key for timing-safe HMAC comparisons (eliminates length leak)
const timingKey = randomBytes(32);

// Per-session CSRF tokens: Map<token, expiresAt>
const csrfTokens = new Map();
const CSRF_TTL_MS = 3_600_000; // 1 hour

export function generateCsrfToken() {
  pruneExpiredCsrfTokens();
  const token = randomBytes(32).toString("hex");
  csrfTokens.set(token, Date.now() + CSRF_TTL_MS);
  return token;
}

function pruneExpiredCsrfTokens() {
  const now = Date.now();
  for (const [token, expiry] of csrfTokens) {
    if (expiry < now) csrfTokens.delete(token);
  }
}

export function validateCsrf(req) {
  const token = req.headers["x-csrf-token"] || req.headers["x-xsrf-token"] || "";
  if (token) {
    const expiry = csrfTokens.get(token);
    if (expiry && expiry > Date.now()) return true;
  }
  // Fallback: same-origin check via Origin/Referer
  const origin = req.headers.origin || req.headers.referer || "";
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === (req.headers.host || "");
  } catch {
    return false;
  }
}

export function isAuthorized(req) {
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
    return (
      safeEqual(decoded.slice(0, separator), dashboardUser) &&
      safeEqual(decoded.slice(separator + 1), dashboardPassword)
    );
  } catch {
    return false;
  }
}

export function isProxyAuthorized(req) {
  if (!isRequestFromTrustedProxy(req)) return false;
  return Boolean(headerValue(req, authProxyUserHeader));
}

export function isRequestFromTrustedProxy(req) {
  try {
    const remote = String(req.socket?.remoteAddress || req.connection?.remoteAddress || "");
    const normalized = remote.replace(/^::ffff:/, "");
    return trustedProxyRules.some((rule) => matchesTrustedProxyRule(normalized, rule));
  } catch {
    return false;
  }
}

export function parseTrustedProxyRules(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((e) => e.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.endsWith("*")) return { type: "prefix", value: entry.slice(0, -1) };
      if (entry.includes("/")) {
        const [address, bits] = entry.split("/");
        const prefixLength = Number(bits);
        if (isIP(address) === 4 && Number.isInteger(prefixLength) && prefixLength >= 0 && prefixLength <= 32) {
          return { type: "cidr4", address, prefixLength };
        }
      }
      return { type: "exact", value: entry };
    });
}

export function matchesTrustedProxyRule(address, rule) {
  if (!address || !rule) return false;
  if (rule.type === "exact") return address === rule.value;
  if (rule.type === "prefix") return Boolean(rule.value) && address.startsWith(rule.value);
  if (rule.type === "cidr4") return isIpv4InCidr(address, rule.address, rule.prefixLength);
  return false;
}

export function sendUnauthorized(res, httpsEnabled = false) {
  const headers = {
    ...securityHeaders(httpsEnabled),
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  };
  if (authMode === "basic") headers["WWW-Authenticate"] = 'Basic realm="Pi-hole Dashboard"';
  res.writeHead(401, headers);
  res.end("Authentication required");
}

export function currentUser(req) {
  if (authMode === "proxy") {
    return {
      mode: authMode,
      username: headerValue(req, authProxyUserHeader),
      email: headerValue(req, authProxyEmailHeader),
      name: headerValue(req, authProxyNameHeader)
    };
  }
  return { mode: authMode, username: authMode === "basic" ? dashboardUser : "" };
}

export function securityHeaders(httpsEnabled = false) {
  const headers = {
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
  if (httpsEnabled) {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  }
  return headers;
}

// HMAC-based comparison: both inputs hash to fixed-length 32-byte buffers,
// eliminating the length timing leak present in a direct buffer comparison.
function safeEqual(actual, expected) {
  const a = createHmac("sha256", timingKey).update(String(actual)).digest();
  const b = createHmac("sha256", timingKey).update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

function isIpv4InCidr(address, network, prefixLength) {
  if (isIP(address) !== 4 || isIP(network) !== 4) return false;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(network) & mask);
}

function ipv4ToNumber(address) {
  return address.split(".").reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function headerValue(req, headerName) {
  const value = req.headers[headerName];
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function normalizeHeaderName(name) {
  return String(name).trim().toLowerCase();
}
