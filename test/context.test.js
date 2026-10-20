/** Context memory tests — FAQ learning, dedupe, transcripts. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  initContext, recordMessage, buildTranscript, learnQuestion, matchFaq, rememberAnswer,
  listFaqs, deleteFaq, deleteAllFaqs, clearAllContext, getChannelContext,
} from "../server/lib/context.js";

test("FAQ learning dedupes near-identical questions", () => {
  clearAllContext();
  const q1 = learnQuestion("what time is the raid tonight", "alice");
  assert.ok(q1);
  const q2 = learnQuestion("what time is the raid 2night", "bob");
  assert.equal(q2.id, q1.id, "similar question should bump count, not duplicate");
  assert.equal(q2.count, 2);
  assert.ok(matchFaq("what time is raid tonite"));
  assert.equal(matchFaq("completely unrelated"), null);
});

test("rememberAnswer attaches answer used for repeat-avoidance", () => {
  clearAllContext();
  learnQuestion("how do i get valor points", "sam");
  rememberAnswer("how do i get valor points", "you convert honor in the pvp hub");
  const hit = matchFaq("so how do i get valor points again");
  assert.ok(hit && hit.lastAnswer.includes("honor"));
});

test("transcript includes user + assistant labels and drops nothing important", () => {
  clearAllContext();
  recordMessage({ channel: "c1", guildId: "g1", name: "general", msg: { authorId: "a1", authorName: "dan", content: "yo anyone home?" } });
  recordMessage({ channel: "c1", guildId: "g1", name: "general", msg: { authorId: "a2", authorName: "lex", content: "yea whats good" } });
  recordMessage({ channel: "c1", guildId: "g1", name: "general", msg: { authorId: "bot", authorName: "companion", bot: true, content: "sup" } });
  const t = buildTranscript("c1");
  assert.match(t, /user: yo anyone home\?/);
  assert.match(t, /user: yea whats good/);
  assert.match(t, /assistant: sup/);
});

test("listFaqs sorts by count and deleteFaq removes", () => {
  clearAllContext();
  const a = learnQuestion("who won the match yesterday", "x1");
  const b = learnQuestion("who won the match yesterday", "x2");
  const c = learnQuestion("how do i link steam", "x3");
  const r1 = learnQuestion("who won the match yesterda", "x4");
  const list = listFaqs({});
  assert.ok(list.length >= 2);
  assert.ok(list[0].count >= list[list.length - 1].count);
  deleteFaq(c.id);
  const after = listFaqs({});
  assert.ok(!after.some((f) => f.id === c.id));
});

test("channel context stores capped history", () => {
  clearAllContext();
  for (let i = 0; i < 70; i++) {
    recordMessage({ channel: "cap", guildId: "g", name: "n", msg: { authorId: "u", authorName: "u", content: "msg " + i } });
  }
  const c = getChannelContext("cap");
  assert.ok(c.messages.length <= 65);
  assert.equal(c.messages[c.messages.length - 1].content, "msg 69");
});

test("deleteAllFaqs clears", () => {
  learnQuestion("is the server up right now or not", "z");
  deleteAllFaqs();
  assert.equal(listFaqs({}).length, 0);
});
