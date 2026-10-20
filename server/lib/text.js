/** Text utilities: normalization, similarity (trigram Jaccard), slang/gaming vocab detection. Pure — unit-tested. */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "for", "with", "by", "from", "as", "it", "its", "this", "that",
  "these", "those", "i", "im", "you", "your", "yours", "he", "she", "they", "them", "their",
  "we", "us", "our", "my", "me", "what", "which", "who", "whom", "how", "when", "where", "why",
  "not", "no", "yes", "so", "if", "then", "than", "too", "very", "just", "about", "up", "out",
  "do", "does", "did", "done", "can", "could", "will", "would", "should", "shall", "may", "might",
  "have", "has", "had", "am", "pm", "here", "there", "now", "one", "all", "also", "get", "got",
]);

/** common gaming + internet slang we boost as "community signal" */
export const SLANG_TERMS = new Set([
  "lol", "lmao", "lmfao", "rofl", "kek", "haha", "hehe", "bruh", "bro", "sis", "dude", "man",
  "yo", "sup", "hi", "hey", "wsp", "wyd", "wbu", "hbu", "idk", "idc", "imo", "imho", "tbh",
  "ngl", "fr", "frfr", "bc", "cuz", "cus", "ofc", "ik", "iirc", "afaik", "smh", "mfw", "tfw",
  "gg", "ggwp", "wp", "ez", "clutch", "cringe", "based", "sus", "cap", "nocap", "rizz", "gyatt",
  "goated", "mid", "opp", "op", "nerf", "buff", "meta", "walled", "aim", "kd", "kdr", "eh",
  "afk", "brb", "ttyl", "gl", "hf", "gg_ez", "diff", "dodge", "main", "smurf", "thrower",
  "phase", "farming", "wave", "jungle", "lane", "bot", "top", "mid", "af", "ping", "spike",
  "lfg", "lgtm", "til", "salty", "tilted", "choke", "bait", "farming", "grind", "drop",
  "gucci", "w", "L", "W", "take the L", "ratio", "ratioed", "sheeesh", "yoooo", "yo",
  "bruhh", "dawg", "fam", "gng", "gang", "bins", "lowkey", "highkey", "deadass", "bet",
  "ong", "pose", "goofy", "busted", "goofier", "cooked", "cooking", "let him cook", "salad",
  "nah", "yeah", "yea", "nah bro", "damn", "bruhv", "ahh", "ah", "u", "ur", "pls", "plz",
  "thx", "ty", "yw", "np", "nvm", "wtf", "wth", "stfu", "bs", "lgtm", "sry", "sorry",
]);

const GAMING_DOMAINS = [
  "fps", "mmorpg", "mmo", "rpg", "moba", "pvp", "pve", "dps", "heal", "tank", "cc",
  "elos", "ranked", "cd", "ult", "hp", "mp", "xp", "lvl", "level", "boss", "raid",
  "loot", "drop", "patch", "nerfed", "meta", "build", "loadout", "perk", "sprint",
];

export function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/<@!?\d+>/g, " @user ")          // mentions -> generic
    .replace(/https?:\/\/\S+/g, " link ")    // links -> generic
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\p{L}\p{N}\s?!@]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(str) {
  return normalize(str).split(/\s+/).filter((t) => t.length > 0);
}

export function contentWords(str) {
  return tokenize(str).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/** Trigram-set Jaccard similarity in [0,1]. Used for duplicate + FAQ matching. */
export function trigramSimilarity(a, b) {
  const ga = trigramSet(a), gb = trigramSet(b);
  if (!ga.size && !gb.size) return a === b ? 1 : 0;
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

function trigramSet(str) {
  const s = normalize(str);
  const out = new Set();
  if (s.length <= 3) { out.add(s); return out; }
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** Which slang / gaming terms appear in a message (for style + context signals). */
export function detectSlang(str) {
  const words = new Set(tokenize(str));
  const hits = [];
  for (const w of words) {
    if (SLANG_TERMS.has(w)) hits.push(w);
    if (GAMING_DOMAINS.includes(w)) hits.push(w);
  }
  // common emoji reactions count too
  const emoji = str.match(/\p{Extended_Pictographic}/gu);
  if (emoji) hits.push(...emoji);
  return hits;
}

/** Is this message a question? (ends with ?, or starts with interrogative / modal verb) */
const INTERROGATIVES = [
  "what", "why", "how", "who", "whom", "whose", "where", "when", "which", "is", "are", "am",
  "was", "were", "can", "could", "should", "would", "will", "do", "does", "did", "may", "might",
  "anyone", "anybody", "someone", "any", "guys", "help", "thoughts", "opinions", "idea", "wait",
];

export function looksLikeQuestion(str) {
  const s = str.trim();
  if (!s) return false;
  if (/\?\s*$/.test(s)) return true;
  const first = tokenize(s)[0];
  if (first && INTERROGATIVES.includes(first)) return true;
  // "anyone know how to..." style
  if (/\b(anyone|anybody|someone)\s+(know|knew|has|have|got)\b/i.test(s)) return true;
  return false;
}

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function randInt(n) {
  return Math.floor(Math.random() * n);
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function isEmojiOnly(str) {
  const s = str.trim();
  if (!s) return false;
  const stripped = s.replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\s|\p{P}/gu, "");
  return stripped.length === 0 && /\p{Extended_Pictographic}/u.test(s);
}
