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
  if (!key) throw new GrokError("No xAI API key configured", 401);

  const cfg = getConfig().xai;
  const base = cfg.baseUrl || "https://api.x.ai/v1";
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || cfg.requestTimeoutMs || 25_000);

  try {
    const res = await fetch(`${base}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }

    if (!res.ok) {
      const msg = json?.error || json?.msg || text.slice(0, 300) || `HTTP ${res.status}`;
      throw new GrokError(`xAI API ${res.status}: ${msg}`, res.status, json);
    }
    return json;
  } catch (err) {
    if (err instanceof GrokError) throw err;
    if (err.name === "AbortError") throw new GrokError("xAI request timed out", 504);
    throw new GrokError(`xAI connection failed: ${err.message}`, 502);
  } finally {
    clearTimeout(t);
  }
}

export async function listModels() {
  const key = getSecret("xai");
  if (!key) return { ok: false, models: GROK_MODELS, error: "no key" };
  try {
    checkRateLimits();
    const cfg = getConfig().xai;
    const base = cfg.baseUrl || "https://api.x.ai/v1";
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const models = (json.data || []).map((m) => ({
      id: m.id,
      label: m.id,
      ctx: m.context_length || null,
      pricing: null,
    }));
    bumpDaily(1, 0);
    return { ok: true, models, error: null };
  } catch (err) {
    log.warn("[grok] /models fetch failed — using built-in list:", err.message);
    return { ok: false, models: GROK_MODELS, error: err.message };
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

  const started = Date.now();
  bumpDaily(1, 0);
  if (rateLimited) callHistory.push(Date.now());

  const json = await grokFetch("/chat/completions", payload, cfg.requestTimeoutMs);
  const latencyMs = Date.now() - started;

  const choice = json?.choices?.[0];
  const content = choice?.message?.content || "";
  const usage = json?.usage || null;
  const cost = estimateCost(payload.model, usage);
  bumpDaily(0, cost);

  lastResponseMeta = { model: payload.model, latencyMs, usage, cost };
  log.info(`[grok] ${payload.model} ${latencyMs}ms ${(content || "").length}ch cost=$${cost.toFixed(5)}`);

  return { content, usage, meta: { model: payload.model, latencyMs, usage, cost } };
}

export const grok = { chatComplete, testConnection, listModels, getUsage, getLastMeta, GROK_MODELS, GrokError };
export default grok;
