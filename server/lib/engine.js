/**
 * Reply engine — decides IF the bot should reply, then generates + post-processes drafts.
 * Exposes pure rules (unit-tested) plus the stateful pipeline.
 */

import { trigramSimilarity, looksLikeQuestion, normalize } from "./text.js";
import { buildSystemPrompt } from "./persona.js";
import { applyGlossary, violatesDoNotSay } from "./style.js";
import { chatComplete } from "./grok.js";
import { getConfig } from "./config.js";
import { log } from "./logger.js";

// ── runtime state ────────────────────────────────────────────────
const state = {
  lastReplyTsByChannel: new Map(),   // channelId -> ts
  lastReplyTsGlobal: 0,
  hourly: new Map(),                 // `${channelId}:${hourBucket}` -> count
  dailyCount: 0,
  dailyDate: "",
  recentReplies: new Map(),          // channelId -> [{ts, norm, text}]
  lastError: null,
  consecutiveErrors: 0,
  breakerOpen: false,
  breakerTs: 0,
};

const REPLY_DUP_SIMILARITY = 0.82;
export const MAX_CONCURRENT = 2;

// casual one-liners (heyy, yo, lol…) — worth engaging even though they're tiny
const CASUAL_CHAT_RE = /^(h+ey+y*|hi+|heya+|hello+|yo+|sup|wassup|whats up|what'?s up|wyd|hola|gm+|gn+|oi+|lol|lmao|bruh|bro|broo|haha+|hehe+|rip|oof)$/i;

export function isCasualGreeting(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[!.?,…\s]+$/g, "");
  return t.length > 0 && t.length <= 24 && CASUAL_CHAT_RE.test(t);
}

// ── pure decision ────────────────────────────────────────────────

/**
 * Pure reply decision. Inject everything it needs so tests are deterministic.
 * @param {object} message {authorId, authorName, bot, self, mentionedBot, refToBot, content}
 * @param {object} channelCfg {id, enabled, mode, cooldownSeconds?, maxPerHour?, replyChance?}
 * @param {object} replyCfg {stopped, mode, cooldownSeconds, globalCooldownSeconds, maxPerChannelHour, maxDailyReplies, duplicateWindowHours, blockedKeywords, selectiveProbability}
 * @param {object} state {lastReplyTsByChannel, lastReplyTsGlobal, hourly, dailyCount, recentReplies, breakerOpen}
 * @param {number} random 0..1 (for selective mode roll)
 * @returns {{allow:boolean, code:string, reason:string, mentioned?:boolean, isQuestion?:boolean}}
 */
export function decide({ message, channelCfg, replyCfg, state: st, random = Math.random() }) {
  const now = Date.now();

  if (replyCfg.stopped) return deny("stopped", "Emergency stop active");
  if (st.breakerOpen) return deny("breaker", "Circuit breaker open after repeated failures");
  if (!channelCfg || !channelCfg.enabled) return deny("channel_off", "Channel not configured or disabled");
  if (message.self) return deny("self", "Own message");

  const mode = (channelCfg.mode || "off").toLowerCase();
  if (mode === "off") return deny("mode_off", "Channel mode = off");

  const mentioned = !!message.mentionedBot;
  const isQ = looksLikeQuestion(message.content);
  // casual one-liners are always worth at least a shot (unless the owner turned them off)
  const casual = replyCfg.respondToCasual !== false && isCasualGreeting(message.content);

  switch (mode) {
    case "mention":
      if (!mentioned && !message.refToBot) return deny("mention_absent", "Mention required, none present");
      break;
    case "question":
      if (!mentioned && !isQ) return deny("question_absent", "Waiting for a question");
      break;
    case "selective":
      if (!mentioned && !isQ && !casual) {
        const chance = clampNum(channelCfg.replyChance ?? replyCfg.selectiveProbability ?? 0.25, 0, 1);
        if (random >= chance) return deny("selective_roll", `Selective roll: ${random.toFixed(2)} >= chance ${chance}`);
      }
      break;
    case "always":
      break; // any not-short message
    default:
      return deny("mode_unknown", `Unknown mode ${mode}`);
  }

  // keyword safety net (never reply into scam/spam-lure messages)
  const lowText = String(message.content || "").toLowerCase();
  const kwHit = (replyCfg.blockedKeywords || []).find((kw) => kw && lowText.includes(String(kw).toLowerCase()));
  if (kwHit) return deny("keyword_block", `Owner-blocked keyword: "${kwHit}"`);
  const minLen = numC(replyCfg.minMessageChars, 2);
  if (!casual && normalize(lowText).length < minLen) return deny("too_short", "Message too short to reply to");

  // per-channel hourly cap
  const hourKey = `${channelCfg.id}:${bucketHour(now)}`;
  if ((st.hourly?.get(hourKey) || 0) >= (channelCfg.maxPerHour ?? replyCfg.maxPerChannelHour ?? 12)) {
    return deny("rate_hour", "Channel hourly cap reached");
  }
  // global daily cap
  if (st.dailyCount >= (replyCfg.maxDailyReplies ?? 200)) return deny("rate_daily", "Daily reply cap reached");

  // channel cooldown
  const cdSec = numC(channelCfg.cooldownSeconds, numC(replyCfg.cooldownSeconds, 180));
  const since = now - (st.lastReplyTsByChannel?.get(channelCfg.id) || 0);
  if (since < cdSec * 1000) return deny("cooldown_channel", `Channel cooldown: ${Math.ceil((cdSec * 1000 - since) / 1000)}s left`);

  // global cooldown
  const gcd = numC(replyCfg.globalCooldownSeconds, 30);
  const sinceG = now - (st.lastReplyTsGlobal || 0);
  if (sinceG < gcd * 1000) return deny("cooldown_global", `Global cooldown: ${Math.ceil((gcd * 1000 - sinceG) / 1000)}s left`);

  // duplicate prevention: nearly identical trigger already answered recently (per channel)
  // casual one-liners skip this — saying "heyy" twice in a day shouldn't mute the bot
  const winMs = numC(replyCfg.duplicateWindowHours, 36) * 3600_000;
  const raw = normalize(message.content);
  if (!casual) {
    for (const r of st.recentReplies?.get(channelCfg.id) || []) {
      if (now - r.ts < winMs && r.triggerNorm && trigramSimilarity(r.triggerNorm, raw) >= REPLY_DUP_SIMILARITY) {
        return deny("duplicate_trigger", "Similar trigger already answered recently");
      }
    }
  }

  return { allow: true, code: "ok", reason: "ok", mentioned, isQuestion: isQ };
}

function deny(code, reason) { return { allow: false, code, reason }; }
function bucketHour(t) { return Math.floor(t / 3_600_000); }
function clampNum(v, min, max) { const n = parseFloat(v); return isNaN(n) ? min : Math.max(min, Math.min(max, n)); }
function numC(v, dflt) { const n = parseFloat(v); return isNaN(n) ? dflt : n; }

// ── state updates ────────────────────────────────────────────────

export function markReplied(channelId, replyText, triggerNorm = "") {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyDate !== today) { state.dailyDate = today; state.dailyCount = 0; }
  if (channelId) state.lastReplyTsByChannel.set(channelId, now);
  state.lastReplyTsGlobal = now;
  state.dailyCount += 1;
  const hourKey = `${channelId}:${bucketHour(now)}`;
  if (channelId) {
    state.hourly.set(hourKey, (state.hourly.get(hourKey) || 0) + 1);
    const recents = state.recentReplies.get(channelId) || [];
    recents.push({ ts: now, norm: normalize(replyText || ""), triggerNorm, text: replyText || "" });
    state.recentReplies.set(channelId, recents.slice(-14));
  }
}

export function markBreakerOpen(reason) {
  state.breakerOpen = true;
  state.breakerTs = Date.now();
  log.error("[engine] circuit breaker open:", reason);
}

export function resetBreaker() {
  state.breakerOpen = false;
  state.consecutiveErrors = 0;
  log.info("[engine] circuit breaker reset by owner");
}

export function recordFailure(err) {
  state.lastError = { message: err?.message || String(err), ts: Date.now() };
  state.consecutiveErrors += 1;
  if (state.consecutiveErrors >= 4 && !state.breakerOpen) markBreakerOpen(state.lastError.message);
}

export function recordSuccess() {
  state.consecutiveErrors = 0;
}

export function engineStats() {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyDate !== today) { state.dailyDate = today; state.dailyCount = 0; }
  let hourly = 0;
  for (const [k, v] of state.hourly) {
    if (parseInt(k.split(":")[1], 10) === bucketHour(now)) hourly += v;
  }
  return {
    daily: state.dailyCount, hourly,
    inFlight: global.inFlightEngine || 0,
    breakerOpen: state.breakerOpen,
    breakerTs: state.breakerTs,
    consecutiveErrors: state.consecutiveErrors,
    lastError: state.lastError,
  };
}

global.__engineInFlight = 0;
export function setInFlight(n) { global.__engineInFlight = n; }
// alias for engineStats default 0
Object.defineProperty(global, "inFlightEngine", { get: () => global.__engineInFlight, configurable: true });

export function resetEngineState() {
  state.lastReplyTsByChannel.clear();
  state.hourly.clear();
  state.recentReplies.clear();
  state.lastReplyTsGlobal = 0;
  state.breakerOpen = false;
  state.consecutiveErrors = 0;
}

export function getEngineState() {
  return state;
}

// ── generation ───────────────────────────────────────────────────

/**
 * Generate a draft (does NOT send). Returns { text, violated }.
 * One automatic retry if the first draft hit a do-not-say rule.
 */
export async function generateDraft({ transcriptText, triggerText, memoryFacts = [], faqEntries = [], warning = "" } = {}) {
  const cfg = getConfig();
  const prompt = buildSystemPrompt({
    personality: cfg.personality,
    styleProfile: cfg.styleProfile || {},
    facts: memoryFacts,
    faqs: faqEntries,
    transcriptText,
    triggerText,
    warning,
  });

  const messages = [{ role: "system", content: prompt }, { role: "user", content: "Write your reply now. Only the message itself." }];

  let res = await chatComplete({ messages });
  let out = postProcess(res.content);
  // thinking models can burn the whole token budget reasoning and return 0 characters — give them room
  if (!String(out.text || "").trim()) {
    log.warn("[engine] empty draft (model spent its budget thinking) — retrying with ~2x tokens");
    res = await chatComplete({ messages, maxTokens: Math.max((getConfig().xai.maxOutputTokens || 250) * 2, 1000) });
    out = postProcess(res.content);
  }
  if (out.violated) {
    log.warn("[engine] draft violated do-not-say; retrying once");
    res = await chatComplete({ messages });
    out = postProcess(res.content);
  }
  if (!String(out.text || "").trim()) {
    throw new Error("model replied with nothing (it used all its tokens reasoning) — raise 'Max reply length' on the AI page, or pick a non-thinking model");
  }
  return { text: out.text, violated: out.violated, usage: res.usage, meta: res.meta };
}

/**
 * Final cleanup on AI output: strip meta-talk, quotes, role prefixes;
 * enforce lowercase; apply glossary; detect do-not-say violations.
 */
export function postProcess(raw) {
  const cfg = getConfig();
  let text = String(raw || "").trim();
  text = text.replace(/^(?:assistant|user|ai|bot)\s*:\s*/i, "");
  text = text.replace(/^[ \t]*[-*]?\s*(?:the )?message[ “':-]*\s*/i, ""); // guard against "The message should be..."
  text = text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.split("\n").slice(0, 4).join("\n"); // keep replies tight
  if (cfg.personality.lowercase) text = text.toLowerCase();
  text = applyGlossary(text, cfg.personality.glossary).trim();
  const violated = violatesDoNotSay(text, cfg.personality.doNotSay);
  return { text, violated };
}

export const engineAPI = { decide, markReplied, generateDraft, postProcess, engineStats, getEngineState };
export default engineAPI;
