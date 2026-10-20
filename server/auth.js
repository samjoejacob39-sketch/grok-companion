/** Dashboard auth: single-owner password (scrypt), HttpOnly session cookies, rate-limited login. */

import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { getConfig, updateConfig, createSession, validateSession, revokeAllSessions, revokeSession } from "./lib/config.js";
import { SlidingWindow } from "./lib/ratelim.js";
import { audit } from "./lib/audit.js";
import { log } from "./lib/logger.js";

export const COOKIE_NAME = "companion_session";
const loginLimiter = new SlidingWindow(8, 15 * 60 * 1000); // 8 attempts / 15 min per IP

// ── password hashing ─────────────────────────────────────────────

export function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(pw), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(pw, stored) {
  if (!pw || !stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  try {
    const candidate = scryptSync(String(pw), salt, 64);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function hasPassword() {
  return !!getConfig().admin.passwordHash;
}

/** Set/rotate dashboard password (hashes; ignores plaintext — never stored). */
export function setPassword(pw) {
  if (!pw || String(pw).length < 8) throw new Error("password must be at least 8 characters");
  updateConfig({ admin: { passwordHash: hashPassword(pw) } }, { immediate: true });
  revokeAllSessions();
  audit("auth.password_set", "Dashboard password changed; all sessions revoked");
}

// ── session + login ──────────────────────────────────────────────

export function tryLogin(ip, { username, password }) {
  const cfg = getConfig();
  const gate = loginLimiter.tryConsume(ip || "anon");
  if (!gate.ok) return { ok: false, err: "Too many login attempts — wait 15 minutes", status: 429 };

  const storedPass = cfg.admin.passwordHash;
  const envPass = process.env.ADMIN_PASSWORD || "";

  // first-run bootstrap: if no password configured, first correct setup sets it
  if (!storedPass) {
    const seed = envPass || String(password || "");
    if (username && username !== (cfg.admin.username || "admin")) {
      return { ok: false, err: "invalid credentials" };
    }
    try {
      setPassword(seed);
      return startSession(seed);
    } catch (err) {
      return { ok: false, err: err.message, status: 400 };
    }
  }

  if (username && cfg.admin.username !== username) {
    audit("auth.login_fail", "bad username");
    return { ok: false, err: "invalid credentials" };
  }

  if (!verifyLogin(password, storedPass, envPass)) {
    audit("auth.login_fail", "invalid password");
    return { ok: false, err: "invalid credentials" };
  }

  loginLimiter.reset(ip || "anon");
  return startSession(password);
}

/** accept either config hash or ADMIN_PASSWORD env (env only during first-run fallback) */
function verifyLogin(pw, storedHash, envPw) {
  if (verifyPassword(pw, storedHash)) return true;
  if (envPw && timingSafeEq(String(pw), String(envPw))) return true;
  return false;
}

function timingSafeEq(a, b) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function startSession() {
  const cfg = getConfig();
  const token = createSession(cfg.admin.username || "admin", cfg.auth.sessionTtlHours || 72);
  audit("auth.login", "dashboard login");
  return { ok: true, token };
}

export function logout(token) {
  if (!token) return false;
  return revokeSession(token);
}

export function logoutEverywhere() {
  revokeAllSessions();
  audit("auth.logout_all", "All dashboard sessions revoked by owner");
}

export function sessionData(token) {
  return validateSession(token);
}

// ── cookie helpers ───────────────────────────────────────────────

export function sessionCookie(token, ttlHours = 72, secure = false) {
  const maxAge = Math.floor(ttlHours * 3600);
  const bits = [`${COOKIE_NAME}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function readCookie(req, name = COOKIE_NAME) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return "";
}

// ── middleware ───────────────────────────────────────────────────

const AUTH_BYPASS = new Set(["/auth/status", "/auth/login", "/health", "/auth/logout"]);

export function requireAuth(req, res, next) {
  // tolerate both mount styles ("/api/x" at root vs "x" mounted under /api)
  const p = req.path.startsWith("/api/") || req.path === "/api" ? req.path.slice(4) : req.path;
  // hydrate session when a valid cookie is present (even on bypass paths)
  const token = readCookie(req);
  const sess = sessionData(token);
  if (sess) { req.session = sess; req.authToken = token; }
  if (AUTH_BYPASS.has(p)) return requireCsrf(req, res, next);
  if (!sess) return res.status(401).json({ error: "unauthenticated" });
  requireCsrf(req, res, next);
}

export function requireCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // defense-in-depth against cross-site requests (cookie is SameSite=Strict anyway)
  const hdr = req.headers["x-companion"] || "";
  if (hdr !== "companion") return res.status(403).json({ error: "missing CSRF header" });
  // same-origin check when Origin header present
  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      if (o.host !== req.headers.host) return res.status(403).json({ error: "cross-origin blocked" });
    } catch {
      return res.status(403).json({ error: "bad origin" });
    }
  }
  next();
}

export function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "local";
}

export const authAPI = { tryLogin, logout, logoutEverywhere, setPassword, hasPassword, requireAuth, sessionCookie, clearCookie, readCookie, hashPassword, verifyPassword, clientIp };
export default authAPI;
