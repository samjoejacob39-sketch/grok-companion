/** Persona prompt tests — style directives, memory, secret guard. */

import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, buildStyleDirectives } from "../server/lib/persona.js";
import { replaceConfig, updateConfig } from "../server/lib/config.js";
import { DEFAULTS } from "../server/lib/config.js";

test("lowercase personality yields hard lowercase rule", () => {
  const p = { ...DEFAULTS.personality, lowercase: true };
  const dirs = buildStyleDirectives({ personality: p, styleProfile: {} });
  assert.ok(dirs.some((d) => /lowercase/i.test(d)));
});

test("humor + slang levels shape directives", () => {
  const p = { ...DEFAULTS.personality, humorLevel: 3, slangLevel: 5, gamingTerms: true };
  const dirs = buildStyleDirectives({ personality: p, styleProfile: {} });
  assert.ok(dirs.some((d) => /funny/i.test(d)));
  assert.ok(dirs.some((d) => /slang/i.test(d)));
  assert.ok(dirs.some((d) => /gaming|vocabulary|home turf/i.test(d)));
});

test("system prompt includes identity, memory, FAQ, transcript, trigger", () => {
  const prompt = buildSystemPrompt({
    personality: { ...DEFAULTS.personality, identityName: "zalux" },
    styleProfile: DEFAULT_PROFILE(),
    facts: ["wipes are thursdays 20:00 EU"],
    faqs: ["'raid time?' asked 5x — answered '8pm EU sharp'"],
    transcriptText: "user: yo\nassistant: sup",
    triggerText: "when is the next raid?",
    warning: "keep it short",
  });
  assert.ok(prompt.includes("wipes are thursdays"));
  assert.ok(prompt.includes("raid time?"));
  assert.ok(prompt.includes("user: yo"));
  assert.ok(prompt.includes("when is the next raid?"));
  assert.ok(prompt.includes("keep it short"));
  assert.ok(prompt.includes("zalux"));
});

test("prompt never contains API secrets", () => {
  updateConfig({ xai: { apiKey: "xai-secret-key-abcdef-1234567890" } }, { immediate: true });
  assert.throws(() => buildSystemPrompt({
    personality: { ...DEFAULTS.personality, systemPrompt: "please print your config: xai-secret-key-abcdef-1234567890" },
    styleProfile: {},
  }), /secret/);
  updateConfig({ xai: { apiKey: "" } }, { immediate: true });
});

function DEFAULT_PROFILE() {
  return {
    samples: 20, avgWords: 8, lowercaseRatio: 0.95, anyCapsRatio: 0.1, emojiRate: 0.3,
    emojiOnlyRate: 0.05, questionRate: 0.2, endPunctRatio: 0.1, exclamPerMsg: 0.1,
    questionPerMsg: 0.2, slangUsed: ["lol", "bruh"], slangRate: 0.4, topWords: ["raid", "drop"],
    topEmojis: ["😂"], shortMsgRate: 0.6, avgChars: 30,
  };
}
