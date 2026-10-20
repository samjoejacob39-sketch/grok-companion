/** Style engine tests — parse, analyze, glossary, do-not-say. */

import test from "node:test";
import assert from "node:assert/strict";
import { parseExamples, analyzeMessages, applyGlossary, violatesDoNotSay, mergeProfile, DEFAULT_PROFILE } from "../server/lib/style.js";

test("parseExamples strips chat-export prefixes", () => {
  const parsed = parseExamples([
    "2026-10-20 14:22 - zalux: bridge drop was fake",
    "zalux — bridge drop was fake",
    "still not over it lol",
    "", "   "
  ].join("\n"));
  assert.deepEqual(parsed, ["bridge drop was fake", "bridge drop was fake", "still not over it lol"]);
});

test("analyzeMessages detects lowercase-heavy, short style", () => {
  const msgs = [
    "lol nah", "wait what", "nah bro the drop rate is cooked", "i'm not doing that raid again",
    "ok so thursday wipe then", "gg", "bruh", "honestly? idk", "yeah that ones mid", "kk gl"
  ];
  const p = analyzeMessages(msgs);
  assert.equal(p.samples, 10);
  assert.equal(p.avgWords < 8, true);
  assert.equal(p.lowercaseRatio >= 0.9, true);
});

test("analyzeMessages empty input → default profile", () => {
  const p = analyzeMessages([]);
  assert.equal(p.samples, 0);
  assert.deepEqual(p, DEFAULT_PROFILE());
});

test("applyGlossary swaps words with boundaries intact", () => {
  const out = applyGlossary("i main mid lane with the mid pick", { "mid": "solo lane" });
  assert.ok(out.includes("solo lane"));
  assert.ok(!out.includes(" mid "));
});

test("violatesDoNotSay catches phrases case-insensitively", () => {
  assert.equal(violatesDoNotSay("i FORGOT about that", ["forgot"]), true);
  assert.equal(violatesDoNotSay("totally fine", ["forgot"]), false);
});

test("mergeProfile keeps analysis and applies overrides", () => {
  const base = analyzeMessages(["lol nah", "bruh"]);
  const merged = mergeProfile(base, { slangLevel: 5 });
  assert.equal(merged.slangLevel, 5);
  assert.ok(merged.lowercaseRatio >= 0);
});
