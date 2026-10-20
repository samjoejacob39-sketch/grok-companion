/**
 * xAI Grok client — official REST API (https://api.x.ai/v1, OpenAI-compatible).
 * No SDK needed; uses global fetch. Handles rate limiting, spend tracking, retries.
 */

import { getConfig, getSecret } from "./config.js";
import { log } from "./logger.js";

// ── model list (fallback when /models fetch fails) ──────────────
export const GROK_MODELS = [
  { id: "grok-4-fast-reasoning", label: "Grok 4 Fast (reasoning)", ctx: 2_000_000, pricing: { in: 0.2, out: 0.5 } },
  { id: "grok-4-fast-non-reasoning", label: "Grok 4 Fast (non-reasoning)", ctx: 2_000_000, pricing: { in: 0.2, out: 0.5 } },
  { id: "grok-3", label: "Grok 3", ctx: 131_072, pricing: { in: 3.0, out: 15.0 } },
  { id: "grok-3-mini", label: "Grok 3 mini", ctx: 131_072, pricing: { in: 0.3, out: 0.5 } },
  { id: "grok-2-1212", label: "Grok 2 (legacy)", ctx: 131_072, pricing: { in: 2.0, out: 10.0 } },
];

// ── local (free) models — any OpenAI-compatible server on your own box ──
export const LOCAL_MODELS = [
  { id: "llama3.2:3b", label: "Llama 3.2 3B (free, runs on your server)", ctx: 131_072, pricing: { in: 0, out: 0 } },
  { id: "llama3.2:3b-instruct-q4_K_M", label: "Llama 3.2 3B Q4 (low-RAM servers, ~2GB)", ctx: 131_072, pricing: { in: 0, out: 0 } },
  { id: "llama3.2:1b", label: "Llama 3.2 1B (super light, ~1.3GB)", ctx: 131_072, pricing: { in: 0, out: 0 } },
];
export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";

// live-fetched from https://openrouter.ai/api/v1/models (2026-10) — fallback when the API is unreachable
export const OPENROUTER_FREE = [
  { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning · free", ctx: null },
  { id: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron 3.5 Super (VL) · free", ctx: null },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B · free", ctx: null },
  { id: "minimax/minimax-m3.1-flash:free", label: "MiniMax M3.1 Flash · free", ctx: null },
  { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B · free", ctx: null },
  { id: "liquid/lfm-2.5-2.6b:free", label: "Liquid LFM 2.5 · free", ctx: null },
];

export function isLocalBase(baseUrl) {
  const b = String(baseUrl || "").trim();
  if (!b) return false;
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)/i.test(b)) return true;
  // docker bridge to a model server on the host machine
  return /^https?:\/\/(host\.docker\.internal|172\.17\.0\.1)/i.test(b);
}

// ── spend + rpm tracking ─────────────────────────────────────────
let callHistory = [];      // timestamps of last-minute requests
let dayUsage = { date: "", requests: 0, usd: 0 };
let lastResponseMeta = null;

function pruneMinute() {
  const now = Date.now();
  callHistory = callHistory.filter((t) => now - t < 60_000);
}

function bumpDaily(nRequests, costUsd) {
  const today = new Date().toISOString().slice(0, 10);
  if (dayUsage.date !== today) dayUsage = { date: today, requests: 0, usd: 0 };
  dayUsage.requests += nRequests;
  dayUsage.usd += costUsd;
}

export function getUsage() {
  const today = new Date().toISOString().slice(0, 10);
  if (dayUsage.date !== today) dayUsage = { date: today, requests: 0, usd: 0 };
  pruneMinute();
  return { today: { ...dayUsage }, callsLastMinute: callHistory.length };
}

export function getLastMeta() {
  return lastResponseMeta;
}

function checkRateLimits() {
  const cfg = getConfig().xai.rateLimit || {};
  pruneMinute();
  if (callHistory.length >= (cfg.requestsPerMinute || 20)) {
    throw new GrokError("Rate limit reached — too many requests per minute", 429);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (dayUsage.date !== today) dayUsage = { date: today, requests: 0, usd: 0 };
  const dailyCost = cfg.maxDailyCostUsd || 0;
  if (dailyCost > 0 && dayUsage.usd >= dailyCost) {
    throw new GrokError(`Daily spend cap reached ($${dayUsage.usd.toFixed(2)} / $${dailyCost})`, 402);
  }
  if (cfg.maxDailyRequests > 0 && dayUsage.requests >= cfg.maxDailyRequests) {
    throw new GrokError(`Daily request cap reached (${dayUsage.requests}/${cfg.maxDailyRequests})`, 429);
  }
}

export class GrokError extends Error {
  constructor(message, status = 500, detail = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function modelPricing(model) {
  const found = GROK_MODELS.find((m) => m.id === model);
  if (found) return found.pricing;
  if (!model.startsWith("grok")) return { in: 0, out: 0 };   // local / self-hosted models are free
  if (model.includes("fast")) return { in: 0.2, out: 0.5 };
  if (model.includes("mini")) return { in: 0.3, out: 0.5 };
  return { in: 3.0, out: 15.0 };
}

export function estimateCost(model, usage) {
  if (!usage) return 0;
  const p = modelPricing(model);
  return (usage.prompt_tokens || 0) / 1_000_000 * p.in + (usage.completion_tokens || 0) / 1_000_000 * p.out;
}

// ── core request ─────────────────────────────────────────────────

async function grokFetch(endpoint, body, timeoutMs) {
  const key = getSecret("xai");
  const cfg = getConfig().xai;
  const base = cfg.baseUrl || "https://openrouter.ai/api/v1";
  // hosted providers demand a key; local servers (Ollama, llama.cpp, vLLM…) ignore auth
  if (!key && /^https:\/\/(api\.)?x\.ai/i.test(base)) throw new GrokError("No xAI API key configured", 401);
  if (!key && !isLocalBase(base)) {
    throw new GrokError("No API key set — get a free one at openrouter.ai/keys (or aistudio.google.com/apikey) and paste it on the AI page", 401);
  }

  const controller = new AbortController();
  // local CPU inference is slow — never time out a healthy local model below 90s
  const local = isLocalBase(base);
  const effectiveTimeout = local
    ? Math.max(timeoutMs || 0, 90_000)
    : (timeoutMs || cfg.requestTimeoutMs || 25_000);
  const t = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const headers = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const url = `${base}${endpoint}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }

    if (!res.ok) {
      const rawMsg = json?.error || json?.msg;
      const msg = (typeof rawMsg === "string" ? rawMsg : rawMsg?.message) || text.slice(0, 300) || `HTTP ${res.status}`;
      throw new GrokError(`LLM API ${res.status}: ${msg}`, res.status, json);
    }
    return json;
  } catch (err) {
    if (err instanceof GrokError) throw err;
    if (err.name === "AbortError") throw new GrokError(local ? "Local model is taking too long (or isn't running)" : "LLM request timed out", 504);
    throw new GrokError(`LLM connection failed: ${err.message} — is the model server running?`, 502);
  } finally {
    clearTimeout(t);
  }
}

export async function listModels() {
  const key = getSecret("xai");
  const base = getConfig().xai.baseUrl || "https://openrouter.ai/api/v1";
  const local = isLocalBase(base);
  const openrouter = /openrouter\.ai/i.test(base);
  if (!key && !local && !openrouter) return { ok: false, models: GROK_MODELS, error: "no key" };
  try {
    checkRateLimits();
    const headers = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${base}/models`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    let models = (json.data || []).map((m) => ({
      id: m.id,
      label: local ? `${m.id} (local)` : m.id,
      ctx: m.context_length || null,
      pricing: local || openrouter ? { in: 0, out: 0 } : null,
    }));
    if (openrouter) {
      const free = models.filter((m) => m.id.endsWith(":free"));
      if (free.length) models = free.map((m) => ({ ...m, label: `${m.id.replace(":free", "")} · free` }));
    }
    if (local) {
      // if the server hasn't pulled llama3.2 yet, still offer it as a choice
      if (!models.some((m) => m.id.startsWith("llama3.2"))) {
        models = [...models, ...LOCAL_MODELS];
      }
    }
    bumpDaily(1, 0);
    return { ok: true, models, error: null };
  } catch (err) {
    log.warn("[grok] /models fetch failed — using built-in list:", err.message);
    const fallback = openrouter ? OPENROUTER_FREE : local ? LOCAL_MODELS : GROK_MODELS;
    return { ok: false, models: fallback, error: err.message };
  }
}

/** Test connectivity + auth with a tiny ping. */
export async function testConnection() {
  const reply = await chatComplete({
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    maxTokens: 8,
    temperature: 0,
  });
  return { ok: true, sample: reply.content, usageMs: reply.meta.latencyMs, model: reply.meta.model };
}

export async function chatComplete({ messages, maxTokens, temperature, topP, model, rateLimited = true }) {
  if (rateLimited) checkRateLimits();
  else pruneMinute();

  const cfg = getConfig().xai;
  const payload = {
    model: model || cfg.model,
    messages,
    max_tokens: Math.min(maxTokens ?? cfg.maxOutputTokens, 4000),
    temperature: temperature ?? cfg.temperature,
    top_p: topP ?? cfg.topP,
    stream: false,
  };

  // "thinking" models reason before answering and can eat the whole token budget — turn thinking OFF
  const thinkingModel = /nemotron|deepseek-?r1|qwq|thinking|reasoning|o[13]-|gpt-?5/i.test(payload.model);
  if (thinkingModel) {
    payload.reasoning = { enabled: false };                      // OpenRouter hint: no hidden thinking (other servers ignore it)
    payload.max_tokens = Math.max(payload.max_tokens, 1200);     // insurance if a server ignores the toggle
  }

  const started = Date.now();
  bumpDaily(1, 0);
  if (rateLimited) callHistory.push(Date.now());

  const timeoutMs = thinkingModel
    ? Math.max(cfg.requestTimeoutMs || 25_000, 60_000)
    : cfg.requestTimeoutMs;
  const json = await grokFetch("/chat/completions", payload, timeoutMs);
  const latencyMs = Date.now() - started;

  const choice = json?.choices?.[0];
  const content = choice?.message?.content || "";
  const usage = json?.usage || null;
  const cost = isLocalBase(cfg.baseUrl || "") ? 0 : estimateCost(payload.model, usage);
  bumpDaily(0, cost);

  lastResponseMeta = { model: payload.model, latencyMs, usage, cost };
  log.info(`[grok] ${payload.model} ${latencyMs}ms ${(content || "").length}ch cost=$${cost.toFixed(5)}`);

  return { content, usage, meta: { model: payload.model, latencyMs, usage, cost } };
}

export const grok = { chatComplete, testConnection, listModels, getUsage, getLastMeta, GROK_MODELS, GrokError };
export default grok;
