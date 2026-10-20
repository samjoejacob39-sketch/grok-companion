/**
 * Style engine — distills the owner's example messages into a concrete writing profile,
 * which persona.js converts into few-shot style guidance for Grok.
 * Pure heuristics (no network); fully unit-tested.
 */

import { tokenize, contentWords, isEmojiOnly, SLANG_TERMS } from "./text.js";

export const LOWERCASE_NEVER_CAPS = true;

/**
 * Parse a raw upload (plain text lines or "name: message" chat exports) into example messages.
 */
export function parseExamples(raw) {
  const rawText = String(raw || "").replace(/\r\n/g, "\n");
  const lines = rawText.split("\n");
  const out = [];
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    // strip chat-export prefixes like: "gamerboy — message", "2024-05-03 14:22 - name: message"
    line = line.replace(/^(\d{2,4}[-/.]\d{1,2}[-/.]\d{1,4}[ ,]+\d{1,2}:\d{2}(:\d{2})?)\s*[-|•]\s*/, "");
    line = line.replace(/^[\p{L}\p{N}_ .'-]{1,32}\s*[—–:\-|•]\s*/u, "");
    if (!line) continue;
    if (line.length > 1400) line = line.slice(0, 1400);
    out.push(line);
  }
  return out;
}

/** main entry — analyze a set of owner messages into a style profile */
export function analyzeMessages(messages) {
  const msgs = messages
    .map((m) => String(m || "").trim())
    .filter((m) => m.length > 0 && m.length < 1400)
    .slice(-600);
  if (msgs.length === 0) return DEFAULT_PROFILE();

  const stats = msgs.reduce(
    (acc, m) => {
      const words = tokenize(m).length;
      acc.words += words;
      acc.msgChars += m.length;
      if (m === m.toLowerCase() && /[a-z]/.test(m)) acc.allLower++;
      if (/[A-Z]/.test(m)) acc.anyCaps++;
      if (/\p{Extended_Pictographic}/u.test(m)) acc.withEmoji++;
      if (m.endsWith("?")) acc.questions++;
      if (/[!.]$/.test(m)) acc.endPunct++;
      acc.exclamations += (m.match(/!/g) || []).length;
      acc.questionMarks += (m.match(/\?/g) || []).length;
      for (const s of listSlangIn(m)) acc.slang.add(s);
      for (const w of contentWords(m)) acc.vocab.set(w, (acc.vocab.get(w) || 0) + 1);
      const emoji = m.match(/\p{Extended_Pictographic}/gu);
      if (emoji) emoji.forEach((e) => acc.emojis.set(e, (acc.emojis.get(e) || 0) + 1));
      if (isEmojiOnly(m)) acc.emojiOnly++;
      // "bursts": multiple short messages in a row (splitting)
      if (words <= 4) acc.shortMsgs++;
      return acc;
    },
    { words: 0, msgChars: 0, allLower: 0, anyCaps: 0, withEmoji: 0, questions: 0, endPunct: 0, exclamations: 0, questionMarks: 0, slang: new Set(), vocab: new Map(), emojis: new Map(), emojiOnly: 0, shortMsgs: 0 }
  );

  const n = msgs.length;
  const avgWords = stats.words / n;
  const topWords = [...stats.vocab.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([w, c]) => w);
  const topEmojis = [...stats.emojis.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e]) => e);

  return {
    samples: n,
    avgWords: +avgWords.toFixed(1),
    lowercaseRatio: round2(stats.allLower / n),
    anyCapsRatio: round2(stats.anyCaps / n),
    emojiRate: round2(stats.withEmoji / n),
    emojiOnlyRate: round2(stats.emojiOnly / n),
    questionRate: round2(stats.questions / n),
    endPunctRatio: round2(stats.endPunct / n),
    exclamPerMsg: round2(stats.exclamations / n),
    questionPerMsg: round2(stats.questionMarks / n),
    slangUsed: [...stats.slang],
    slangRate: round2([...stats.slang].length / Math.max(1, n / 3)),
    topWords,
    topEmojis,
    shortMsgRate: round2(stats.shortMsgs / n),
    avgChars: round2(stats.msgChars / n),
  };
}

function round2(x) {
  return Math.round((x || 0) * 100) / 100;
}

function listSlangIn(m) {
  const words = new Set(tokenize(m));
  const hits = [];
  for (const w of words) if (SLANG_TERMS.has(w)) hits.push(w);
  return hits;
}

/**
 * Personality sliders owner may tune manually; this merges analysis results with manual overrides.
 */
export function mergeProfile(profile, override) {
  if (!override || typeof override !== "object") return profile;
  const merged = { ...profile };
  for (const k of Object.keys(override)) {
    if (override[k] !== undefined && override[k] !== null && !(Array.isArray(override[k]) && override[k].length === 0)) {
      merged[k] = override[k];
    }
  }
  return merged;
}

/** Custom glossary: {word: replacement} applied with a regex (safe word boundaries). */
export function applyGlossary(text, glossary) {
  let out = String(text || "");
  if (!glossary || typeof glossary !== "object") return out;
  for (const [from, to] of Object.entries(glossary)) {
    if (!from || typeof from !== "string" || typeof to !== "string") continue;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      out = out.replace(new RegExp(`(^|\\s)${esc}($|\\s|\\?|!|,|\\.)`, "g"), (m, p1, p2) => `${p1}${to}${p2}`);
    } catch { /* bad regex char */ }
  }
  return out;
}

/** Do-not-say filter — drops final content that hits a banned phrase. */
export function violatesDoNotSay(text, phrases) {
  const t = String(text || "").toLowerCase();
  return (phrases || []).some((p) => p && t.includes(String(p).toLowerCase()));
}

export function DEFAULT_PROFILE() {
  return {
    samples: 0, avgWords: 0, lowercaseRatio: 0, anyCapsRatio: 0, emojiRate: 0, emojiOnlyRate: 0,
    questionRate: 0, endPunctRatio: 0, exclamPerMsg: 0.08, questionPerMsg: 0, slangUsed: [],
    slangRate: 0, topWords: [], topEmojis: [], shortMsgRate: 0, avgChars: 0,
  };
}

const styleAPI = { parseExamples, analyzeMessages, mergeProfile, applyGlossary, violatesDoNotSay, DEFAULT_PROFILE };
export default styleAPI;
