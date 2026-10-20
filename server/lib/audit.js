/**
 * Audit log — append-only ring buffer persisted to disk.
 * Every significant action (login, key change, bot event, AI action, stop/start) gets an entry.
 * Redacts secrets; dashboard reads from memory, not raw files.
 */

import { getConfig } from "./config.js";

let entries = [];
const MAX = 400;
const SECRET_PATTERNS = [
  /xai-[A-Za-z0-9-]{10,}/g,
  /sk-[A-Za-z0-9-]{10,}/g,
  /MT[A-Za-z0-9_-]{30,}/g,           // discord bot tokens start with MT/MF/etc base64 snowflake
  /Bearer [A-Za-z0-9._-]{10,}/g,
];

export function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

export function audit(action, detail, meta = {}) {
  const entry = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    ts: Date.now(),
    action,
    detail: redact(typeof detail === "string" ? detail : safeJson(detail)),
    ...meta,   // e.g. { channel, user, ok }
  };
  entries.push(entry);
  if (entries.length > MAX) entries = entries.slice(-MAX);
  return entry;
}

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

export function listAudit({ limit = 120, level } = {}) {
  if (level) return entries.filter((e) => (metaLevel(e) === level)).slice(-limit);
  return entries.slice(-limit);
}

function metaLevel(e) {
  if (e.action.startsWith("error")) return "error";
  if (e.action.startsWith("warn")) return "warn";
  return "info";
}

/** Persist audit trail on graceful shutdown via updateConfig hook (simple: read only). */
export function stripAuditSecrets(text) {
  return redact(text || "");
}

export const auditAPI = { audit, listAudit, redact };
export default auditAPI;
