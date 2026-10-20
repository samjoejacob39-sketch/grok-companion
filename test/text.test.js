/** Text utility tests — normalization, question detection, similarity, slang. */

import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeQuestion, trigramSimilarity, normalize, detectSlang, isEmojiOnly } from "../server/lib/text.js";

test("normalize strips mentions/links/punct and lowercases", () => {
  assert.equal(normalize("<@1234> WHAT https://x.com/y ??  😳"), "@user what link ??");
});

test("looksLikeQuestion catches ? and interrogatives", () => {
  assert.equal(looksLikeQuestion("anyone got the drop rates for this thing?"), true);
  assert.equal(looksLikeQuestion("what is the raid schedule"), true);
  assert.equal(looksLikeQuestion("lol nah"), false);
  assert.equal(looksLikeQuestion("im farming rn"), false);
});

test("trigramSimilarity is 1 for identical, low for unrelated", () => {
  const a = "the memory has been restored";
  const b = "the memory has been restored";
  const c = "two completely different strings here ok";
  assert.ok(trigramSimilarity(a, b) > 0.99);
  assert.ok(trigramSimilarity(a, c) < 0.3);
});

test("detectSlang finds gaming and slang tokens", () => {
  const hits = detectSlang("bruh that nerf was lmao-level gg");
  assert.ok(hits.includes("bruh"));
  assert.ok(hits.includes("nerf"));
  assert.ok(hits.includes("gg"));
});

test("isEmojiOnly flags pure-emoji messages", () => {
  assert.equal(isEmojiOnly("😂😂"), true);
  assert.equal(isEmojiOnly("😂 nice one"), false);
});
