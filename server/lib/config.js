import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || join(__dirname, "..", "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_FILE = join(DATA_DIR, "config.json");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");

let cache = null;
let saveTimer = null;

// ── helpers ──────────────────────────────────────────────────────

export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch === null || patch === undefined) return base;
  if (typeof base !== "object" || base === null || typeof patch !== "object") return patch;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) continue;
    out[key] = patch[key] === null ? patch[key] : deepMerge(base[key], patch[key]);
  }
  return out;
}

function cloneDeep(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export const DEFAULTS = {
  version: 1,
  admin: { username: "admin", passwordHash: "" },
  sessionSecret: "",
  auth: { maxSessions: 3, sessionTtlHours: 72 },
  xai: {
    apiKeySet: false,
    apiKeyLast4: "",
    model: "llama3.2:3b",
    baseUrl: "http://127.0.0.1:11434/v1",
    maxOutputTokens: 250,
    temperature: 0.85,
    topP: 0.95,
    requestTimeoutMs: 25000,
    rateLimit: { requestsPerMinute: 20, maxDailyCostUsd: 5, maxDailyRequests: 600 },
  },
  discord: {
    botTokenSet: false,
    botTokenLast4: "",
    clientId: "",
    permissions: {
      ignoreBots: true,
      ignoreSelf: true,
      requireMentionOrSelected: true,
      blockedUsers: [],
      blockedRoles: [],
      allowedRoles: [],
      respectChannelMode: true,
    },
  },
  channels: [],
  reply: {
    stopped: false,
    mode: "selective",
    cooldownSeconds: 180,
    globalCooldownSeconds: 30,
    maxPerChannelHour: 12,
    maxDailyReplies: 200,
    duplicateWindowHours: 36,
    blockedKeywords: ["giveaway", "nitro", "free money", "hack"],
  },
  personality: {
    identityName: "",
    identityHint: "",
    lowercase: true,
    noPunctuation: false,
    maxWords: 35,
    slangLevel: 3,
    humorLevel: 2,
    gamingTerms: true,
    dialectAl: false,
    autoLearn: true,
    systemPrompt: "",
    examples: [],
    yamls: [],
    doNotSay: [],
    glossary: {},
    reactionGuidance: true,
  },
  memory: {
    facts: [],
    faqs: [],
    pinned: [],
    enabled: true,
    maxTurns: 14,
    maxContextChars: 5200,
  },
  generatedReply: {
    disclosure: "auto",
    markSymbol: "[AI]",
  },
  styleSamples: [],
  audit: { level: "info", retentionDays: 14 },
};

// ── load / persist ───────────────────────────────────────────────

function loadFromDisk() {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    console.error("[config] failed to parse config.json — falling back to defaults:", err.message);
    return null;
  }
}

function writeFileSyncAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    console.error("[config] persist failed:", err.message);
  }
}

if (loadFromDisk() === null) {
  writeFileSyncAtomic(CONFIG_FILE, DEFAULTS);
  cache = cloneDeep(DEFAULTS);
} else {
  cache = deepMerge(cloneDeep(DEFAULTS), loadFromDisk());
}

export function getConfig() {
  return cache;
}

export function updateConfig(patch, opts = {}) {
  const { persist = true, immediate = false } = opts;
  cache = deepMerge(cache, patch);
  if (persist) {
    if (immediate) writeFileSyncAtomic(CONFIG_FILE, cache);
    else {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => writeFileSyncAtomic(CONFIG_FILE, cache), 300);
    }
  }
  return cache;
}

export function replaceConfig(next) {
  cache = deepMerge(cloneDeep(DEFAULTS), next || {});
  writeFileSyncAtomic(CONFIG_FILE, cache);
  return cache;
}

// secrets: read straight from config (in-memory) or env fallback
export function getSecret(key) {
  const c = getConfig();
  if (key === "xai") return c.xai.apiKey || "";
  if (key === "discord") return c.discord.botToken || "";
  return "";
}

/** Store a secret server-side (never leaves this process). */
export function setSecret(key, value) {
  const clean = String(value || "").trim();
  if (!clean) return;
  if (key === "xai") updateConfig({ xai: { apiKey: clean } }, { immediate: true });
  if (key === "discord") updateConfig({ discord: { botToken: clean } }, { immediate: true });
}

export function hasSecret(key) {
  return !!getSecret(key);
}

export function markSecretSet(key) {
  const secret = getSecret(key);
  const last4 = secret.slice(-4);
  if (key === "xai") updateConfig({ xai: { apiKeySet: !!secret, apiKeyLast4: last4 } }, { immediate: true });
  if (key === "discord") updateConfig({ discord: { botTokenSet: !!secret, botTokenLast4: last4 } }, { immediate: true });
}

// ── dashboard sessions ───────────────────────────────────────────

function loadSessions() {
  if (!existsSync(SESSIONS_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSessions(map) {
  try {
    writeFileSyncAtomic(SESSIONS_FILE, map);
  } catch (err) {
    console.error("[config] session save failed:", err.message);
  }
}

export function createSession(username, ttlHours) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  const map = loadSessions();
  map[token] = { username, created: now, expires: now + ttlHours * 3600_000 };
  // cap number of sessions
  const entries = Object.entries(map).sort((a, b) => a[1].created - b[1].created);
  const max = getConfig().auth?.maxSessions || 3;
  while (entries.length > max) {
    const [oldToken] = entries.shift();
    delete map[oldToken];
  }
  saveSessions(map);
  return token;
}

export function validateSession(token) {
  if (!token || typeof token !== "string") return null;
  const map = loadSessions();
  const s = map[token];
  if (!s) return null;
  if (Date.now() > s.expires) {
    delete map[token];
    saveSessions(map);
    return null;
  }
  return s;
}

export function revokeSession(token) {
  const map = loadSessions();
  if (!map[token]) return false;
  delete map[token];
  saveSessions(map);
  return true;
}

export function revokeAllSessions() {
  saveSessions({});
}

export function sessionSecret() {
  const existing = getConfig().sessionSecret;
  if (existing) return existing;
  const secret = randomBytes(48).toString("hex");
  updateConfig({ sessionSecret: secret }, { immediate: true });
  return secret;
}

export function clearSecret(key) {
  if (key === "xai") updateConfig({ xai: { apiKey: "", apiKeySet: false, apiKeyLast4: "" } }, { immediate: true });
  if (key === "discord") updateConfig({ discord: { botToken: "", botTokenSet: false, botTokenLast4: "" } }, { immediate: true });
}

export function backupConfig() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(DATA_DIR, `config-backup-${stamp}.json`);
  writeFileSyncAtomic(file, getConfig());
  return file;
}
