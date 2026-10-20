/**
 * Context memory — per-channel rolling transcript (in-memory, persisted), FAQ learning, fact store usage.
 * The AI always sees real recent conversation before deciding to reply.
 */

import { join } from "node:path";
import { readJson, writeJsonDebounced, flushAll } from "./store.js";
import { DATA_DIR } from "./config.js";
import { trigramSimilarity, normalize, contentWords } from "./text.js";
import { log } from "./logger.js";
import { audit } from "./audit.js";

const CONTEXT_FILE = join(DATA_DIR, "context.json");

const MAX_STORED_PER_CHANNEL = 60;
const FAQ_SIMILARITY = 0.52;

/** channelId -> { id, guildId, name, messages: [{ts, authorId, author, bot, content, refToBot}] } */
const channels = new Map();
let faqs = [];         // [{id, norm, display, count, lastAnswer, lastTs, ts}]
const dirty = new Set();
let persistTimer = null;

// ── bootstrap ────────────────────────────────────────────────────
export function initContext() {
  const disk = readJson(CONTEXT_FILE, { channels: {}, faqs: [] });
  for (const [id, c] of Object.entries(disk.channels || {})) {
    channels.set(id, { id, guildId: c.guildId, name: c.name || "", messages: (c.messages || []).slice(-MAX_STORED_PER_CHANNEL) });
  }
  faqs = (disk.faqs || []).slice(0, 500);
  log.info(`[context] restored ${channels.size} channels, ${faqs.length} FAQ entries`);
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const out = { channels: {}, faqs };
    for (const [id, c] of channels) {
      out.channels[id] = { guildId: c.guildId, name: c.name, messages: c.messages.slice(-MAX_STORED_PER_CHANNEL) };
    }
    writeJsonDebounced(CONTEXT_FILE, out, 500);
  }, 800);
}

export function flushContext() {
  clearTimeout(persistTimer);
  const out = { channels: {}, faqs };
  for (const [id, c] of channels) {
    out.channels[id] = { guildId: c.guildId, name: c.name, messages: c.messages.slice(-MAX_STORED_PER_CHANNEL) };
  }
  try {
    writeJsonDebounced(CONTEXT_FILE, out, 0);
  } catch (err) {
    log.warn("[context] final flush failed:", err.message);
  }
}

// ── channel transcript ───────────────────────────────────────────

export function recordMessage({ channel, guildId, name, msg }) {
  let c = channels.get(channel);
  if (!c) {
    c = { id: channel, guildId, name: name || "", messages: [] };
    channels.set(channel, c);
  }
  if (name) c.name = name;
  const entry = {
    ts: Date.now(),
    authorId: msg.authorId,
    author: msg.authorName || "unknown",
    bot: !!msg.bot,
    content: String(msg.content || "").slice(0, 1200),
    refToBot: !!msg.refToBot,
  };
  c.messages.push(entry);
  if (c.messages.length > MAX_STORED_PER_CHANNEL) c.messages = c.messages.slice(-MAX_STORED_PER_CHANNEL);
  dirty.add(channel);
  schedulePersist();
}

export function getChannelContext(channelId) {
  return channels.get(channelId) || { id: channelId, guildId: null, name: "", messages: [] };
}

export function listTrackedChannels() {
  return [...channels.values()].map((c) => ({
    id: c.id, guildId: c.guildId, name: c.name, count: c.messages.length,
    lastTs: c.messages.length ? c.messages[c.messages.length - 1].ts : null,
  }));
}

/**
 * Transcript for prompt building. Optionally starts at the triggering message,
 * includes bot's own outgoing messages (labeled) so it doesn't lose the thread.
 */
export function buildTranscript(channelId, { maxTurns = 14, maxChars = 5200, untilTs = null, includeAfter = [] } = {}) {
  const c = getChannelContext(channelId);
  let msgs = c.messages.filter((m) => !untilTs || m.ts <= untilTs);
  // drop leading bot messages with no preceding human messages
  const firstHuman = msgs.findIndex((m) => !m.bot);
  if (firstHuman > 0) msgs = msgs.slice(firstHuman);
  const trimmed = msgs.slice(-maxTurns);
  const lines = [];
  let used = 0;
  for (const m of trimmed) {
    const tag = m.bot ? "assistant" : "user";
    const line = `${tag}: ${m.content}`;
    if (used + line.length > maxChars && lines.length > 0) break;
    lines.push(line);
    used += line.length;
  }
  for (const extra of includeAfter) lines.push(extra);
  return lines.join("\n");
}

export function pruneChannel(channelId) {
  channels.delete(channelId);
  dirty.add(channelId);
  schedulePersist();
}

export function clearAllContext() {
  channels.clear();
  faqs = [];
  schedulePersist();
  audit("context.clear", "All cached context and FAQ data wiped by owner");
}

// ── FAQ / recurring question detection ───────────────────────────

export function normalizeQuestionId(text) {
  let norm = normalize(text).replace(/[^a-z0-9?@ ]/g, "").trim();
  if (!norm.endsWith("?")) norm += "?";
  return norm.slice(0, 180);
}

/**
 * Blended similarity for question matching: trigram (typo tolerance)
 * + content-word Jaccard (paraphrase tolerance). Not perfect, cheap — good enough.
 */
function faqSimilarity(a, b) {
  const tri = trigramSimilarity(a, b);
  const wa = new Set(contentWords(a));
  const wb = new Set(contentWords(b));
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = new Set([...wa, ...wb]).size || 1;
  const wordSim = inter / union;
  return Math.max(tri, 0.7 * wordSim + 0.3 * tri);
}

/**
 * Track a user question. If it resembles a stored FAQ, bump count; else create one.
 * Returns enriched FAQ for prompting (or null if disabled).
 */
export function learnQuestion(rawText, askedBy) {
  if (!rawText || rawText.length < 6) return null;
  const now = Date.now();
  const norm = normalizeQuestionId(rawText);

  let hit = null;
  for (const f of faqs) {
    if (faqSimilarity(f.norm, norm) >= FAQ_SIMILARITY) { hit = f; break; }
  }
  if (hit) {
    hit.count += 1;
    hit.lastTs = now;
    hit.lastSender = askedBy || hit.lastSender;
    hit.display = hit.count === 1 && hit.norm.length ? hit.norm : (norm.length > hit.norm.length ? hit.norm : hit.norm);
  } else {
    hit = { id: `fq${now}${Math.random().toString(36).slice(2, 6)}`, norm, display: norm, count: 1, lastAnswer: "", lastTs: now, ts: now, askedBy: askedBy || "" };
    faqs.push(hit);
    if (faqs.length > 500) faqs = faqs.slice(-500);
  }
  schedulePersist();
  return hit;
}

export function faqHasPastAnswer(faq) {
  return !!(faq && faq.lastAnswer && trigramSimilarity(faq.lastAnswer, faq.norm || "") >= 0);
}

export function matchFaq(rawText) {
  if (!rawText) return null;
  const norm = normalizeQuestionId(rawText);
  let best = null;
  for (const f of faqs) {
    const sim = faqSimilarity(f.norm, norm);
    if (sim >= FAQ_SIMILARITY && (!best || sim > best._sim)) { best = f; best._sim = sim; }
  }
  return best;
}

/** Remember the answer given for a question (so repeats can be rephrased, not echoed). */
export function rememberAnswer(questionText, answer) {
  if (!questionText || !answer) return null;
  const f = learnQuestion(questionText, "self");
  if (f) {
    f.lastAnswer = String(answer).slice(0, 1200);
    f.lastAnswerTs = Date.now();
    schedulePersist();
    return f;
  }
  return null;
}

export function listFaqs({ limit = 80, minCount = 1 } = {}) {
  const out = faqs
    .filter((f) => (f.count || 1) >= minCount)
    .sort((a, b) => (b.count || 0) - (a.count || 0) || b.lastTs - a.lastTs)
    .slice(0, limit)
    .map((f) => ({ id: f.id, display: f.display, count: f.count, lastAnswer: f.lastAnswer, ts: f.ts, lastTs: f.lastTs }));
  return out;
}

export function deleteFaq(id) {
  const before = faqs.length;
  faqs = faqs.filter((f) => f.id !== id);
  schedulePersist();
  return faqs.length !== before;
}

export function deleteAllFaqs() {
  faqs = [];
  schedulePersist();
}

export const contextAPI = {
  initContext, recordMessage, buildTranscript, getChannelContext, listTrackedChannels,
  learnQuestion, matchFaq, rememberAnswer, listFaqs, deleteFaq, deleteAllFaqs,
  pruneChannel, clearAllContext, flushContext, FAQ_SIMILARITY,
};
export default contextAPI;
