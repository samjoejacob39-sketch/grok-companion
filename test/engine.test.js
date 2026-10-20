/** Reply engine tests — decision rules, post-processing. */

import test from "node:test";
import assert from "node:assert/strict";
import { decide, postProcess, markReplied, getEngineState } from "../server/lib/engine.js";
import { updateConfig, DEFAULTS, replaceConfig } from "../server/lib/config.js";
import { normalize } from "../server/lib/text.js";

function freshState() {
  // grab existing engine state (module singleton) and clear it
  const st = getEngineState();
  st.lastReplyTsByChannel.clear();
  st.lastReplyTsGlobal = 0;
  st.hourly.clear();
  st.dailyCount = 0;
  st.recentReplies.clear();
  st.breakerOpen = false;
  return st;
}

function baseMsg(over = {}) {
  return {
    authorId: "u1", authorName: "user", bot: false, self: false,
    mentionedBot: false, refToBot: false, content: "hey is the raid still on?",
    ...over,
  };
}

function baseChannel(over = {}) {
  return { id: "ch1", enabled: true, mode: "mention", ...over };
}

function cfg(over = {}) {
  return { ...DEFAULTS.reply, stopped: false, cooldownSeconds: 30, globalCooldownSeconds: 10, maxPerChannelHour: 20, maxDailyReplies: 300, duplicateWindowHours: 1, selectiveProbability: 0.5, blockedKeywords: [], ...over };
}

test("mention mode requires an actual mention", () => {
  const st = freshState();
  const d = decide({ message: baseMsg(), channelCfg: baseChannel(), replyCfg: cfg(), state: st, random: 0.99 });
  assert.equal(d.allow, false);
  assert.equal(d.code, "mention_absent");

  const d2 = decide({ message: baseMsg({ mentionedBot: true }), channelCfg: baseChannel(), replyCfg: cfg(), state: st });
  assert.equal(d2.allow, true);
});

test("question mode allows plain questions but not chit-chat", () => {
  const st = freshState();
  const d = decide({ message: baseMsg({ content: "wait how does this work exactly" }), channelCfg: baseChannel({ mode: "question" }), replyCfg: cfg(), state: st });
  assert.equal(d.allow, true);
  const d2 = decide({ message: baseMsg({ content: "hahaha so true" }), channelCfg: baseChannel({ mode: "question" }), replyCfg: cfg(), state: st });
  assert.equal(d2.allow, false);
});

test("selective mode honors reply chance", () => {
  const st = freshState();
  const dHigh = decide({ message: baseMsg({ content: "man that ranked game was something else" }), channelCfg: baseChannel({ mode: "selective", replyChance: 1 }), replyCfg: cfg({ selectiveProbability: 0 }), state: st, random: 0.9 });
  assert.equal(dHigh.allow, true);
  const dLow = decide({ message: baseMsg({ content: "man that ranked game was something else" }), channelCfg: baseChannel({ mode: "selective", replyChance: 0 }), replyCfg: cfg(), state: st, random: 0.01 });
  assert.equal(dLow.allow, false);
  assert.equal(dLow.code, "selective_roll");
});

test("questions always count in selective mode (no chance roll)", () => {
  const st = freshState();
  const d = decide({ message: baseMsg({ content: "hey is the raid still on?" }), channelCfg: baseChannel({ mode: "selective", replyChance: 0 }), replyCfg: cfg(), state: st, random: 0.99 });
  assert.equal(d.allow, true);
});

test("emergency stop blocks everything", () => {
  const st = freshState();
  const d = decide({ message: baseMsg({ mentionedBot: true }), channelCfg: baseChannel(), replyCfg: cfg({ stopped: true }), state: st });
  assert.equal(d.allow, false);
  assert.equal(d.code, "stopped");
});

test("circuit breaker blocks everything", () => {
  const st = freshState();
  st.breakerOpen = true;
  const d = decide({ message: baseMsg({ mentionedBot: true }), channelCfg: baseChannel(), replyCfg: cfg(), state: st });
  assert.equal(d.allow, false);
  assert.equal(d.code, "breaker");
  st.breakerOpen = false;
});

test("disabled channel is skipped", () => {
  const st = freshState();
  const d = decide({ message: baseMsg({ mentionedBot: true }), channelCfg: baseChannel({ enabled: false }), replyCfg: cfg(), state: st });
  assert.equal(d.allow, false);
  assert.equal(d.code, "channel_off");
});

test("blocked keyword prevents engagement", () => {
  const st = freshState();
  const d = decide({ message: baseMsg({ mentionedBot: true, content: "yo check this Nitro giveaway" }), channelCfg: baseChannel(), replyCfg: cfg({ blockedKeywords: ["giveaway"] }), state: st });
  assert.equal(d.allow, false);
  assert.equal(d.code, "keyword_block");
});

test("own messages and bot messages are skipped", () => {
  const st = freshState();
  const self = decide({ message: baseMsg({ self: true }), channelCfg: baseChannel(), replyCfg: cfg(), state: st });
  assert.equal(self.allow, false);
  assert.equal(self.code, "self");
});

test("channel cooldown blocks back-to-back replies", () => {
  const st = freshState();
  markReplied("ch1", "first reply", "trigger text");
  const d = decide({ message: baseMsg({ mentionedBot: true }), channelCfg: baseChannel(), replyCfg: cfg({ cooldownSeconds: 3000 }), state: st });
  assert.equal(d.allow, false);
  assert.equal(d.code, "cooldown_channel");
});

test("hourly rate cap kicks in", () => {
  const st = freshState();
  st.hourly.set("ch1:" + Math.floor(Date.now() / 3_600_000), 50);
  const d = decide({ message: baseMsg({ mentionedBot: true }), channelCfg: baseChannel(), replyCfg: cfg(), state: st });
  assert.equal(d.allow, false);
  assert.equal(d.code, "rate_hour");
});

test("duplicate trigger suppression", () => {
  const st = freshState();
  st.recentReplies.set("ch1", [{ ts: Date.now(), norm: "replynorm", triggerNorm: normalize("hey is the raid still on?"), text: "" }]);
  const d = decide({ message: baseMsg({ mentionedBot: true }), channelCfg: baseChannel(), replyCfg: cfg(), state: st });
  assert.equal(d.allow, false);
  assert.equal(d.code, "duplicate_trigger");
});

test("too-short messages are never worth it", () => {
  const st = freshState();
  const d = decide({ message: baseMsg({ mentionedBot: true, content: "ok" }), channelCfg: baseChannel(), replyCfg: cfg({ minMessageChars: 4 }), state: st });
  assert.equal(d.allow, false);
  assert.equal(d.code, "too_short");
  // with the default length floor, casual one-liners like "heyy" sail through instead
  const d2 = decide({ message: baseMsg({ mentionedBot: true, content: "heyy" }), channelCfg: baseChannel(), replyCfg: cfg(), state: st });
  assert.equal(d2.allow, true);
});

test("casual one-liners engage in selective mode even on a failed roll", () => {
  const st = freshState();
  const ch = baseChannel({ mode: "selective" });
  const d = decide({ message: baseMsg({ content: "heyy" }), channelCfg: ch, replyCfg: cfg(), state: st, random: 0.99 });
  assert.equal(d.allow, true);
  // turn them off → back to the normal selective roll
  const d2 = decide({ message: baseMsg({ content: "heyy" }), channelCfg: ch, replyCfg: cfg({ respondToCasual: false }), state: st, random: 0.99 });
  assert.equal(d2.allow, false);
  assert.equal(d2.code, "selective_roll");
  // long messages that merely START with "hey" are not casual (nor questions) → normal roll applies
  const d3 = decide({ message: baseMsg({ content: "hey man remember when we owned those noobs yesterday" }), channelCfg: ch, replyCfg: cfg(), state: st, random: 0.99 });
  assert.equal(d3.allow, false, "run-of-the-mill chit-chat still follows the chance roll");
});

test("smart mode answers when a reply is required, gambles otherwise", () => {
  const st = freshState();
  const ch = baseChannel({ mode: "smart" });
  // directly asked a question → reply required
  const d1 = decide({ message: baseMsg({ content: "wait is the event tonight or tmrw" }), channelCfg: ch, replyCfg: cfg(), state: st, random: 0.99 });
  assert.equal(d1.allow, true);
  // ambient chit-chat with no requirement → small chance; missed here
  const d2 = decide({ message: baseMsg({ content: "been grinding valorant all day tbh" }), channelCfg: ch, replyCfg: cfg(), state: st, random: 0.99 });
  assert.equal(d2.allow, false);
  assert.equal(d2.code, "smart_roll");
  // recent bot activity = live convo with the bot → engage
  st.lastReplyTsByChannel.set("ch1", Date.now() - 60_000);
  const d3 = decide({ message: baseMsg({ content: "nah but fr tho same" }), channelCfg: ch, replyCfg: cfg(), state: st, random: 0.99 });
  assert.equal(d3.allow, true);
});

test("postProcess lowercases, strips roles/quotes, applies glossary, flags violations", () => {
  const c = replaceConfig({
    personality: { ...DEFAULTS.personality, lowercase: true, glossary: { "mid": "broken" }, doNotSay: ["chads"] },
  });
  const out = postProcess('Assistant: "That pick is Mid and totally chads"');
  assert.match(out.text, /that pick is broken/);
  assert.equal(out.violated, true);
  assert.ok(!/[A-Z]/.test(out.text.replace(/AI/g, "")) || out.text === out.text.toLowerCase());
  replaceConfig(DEFAULTS);
});
