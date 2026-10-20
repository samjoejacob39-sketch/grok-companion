/** DM relay parser tests. */

import test from "node:test";
import assert from "node:assert/strict";
import { parseDmRequest } from "../server/lib/dmrelay.js";

test("bot ping + target ping → target id read from the surviving mention", () => {
  const r = parseDmRequest({
    content: "<@1541> dm <@9988> tell him the raid is 8pm",
    botId: "1541",
  });
  assert.deepEqual(r, { targetId: "9988", targetName: null, instruction: "tell him the raid is 8pm", broadcast: false });
});

test("dm @name instruction (no id ping)", () => {
  const r = parseDmRequest({
    content: "<@1541> dm @zaluxoo send a joke",
    botId: "1541",
  });
  assert.equal(r.targetId, null);
  assert.equal(r.targetName, "zaluxoo");
  assert.equal(r.instruction, "send a joke");
  assert.equal(r.broadcast, false);
});

test("bare dm → generic hello", () => {
  const r = parseDmRequest({ content: "<@5678> dm <@9988>", botId: "5678" });
  assert.equal(r.targetId, "9988");
  assert.equal(r.instruction, "");
  assert.equal(r.broadcast, false);
});

test("@everyone → broadcast with the message", () => {
  const r = parseDmRequest({ content: "<@1541> dm @everyone maintenance at 8pm be there", botId: "1541" });
  assert.equal(r.broadcast, true);
  assert.equal(r.targetId, null);
  assert.equal(r.instruction, "maintenance at 8pm be there");
});

test("dm everyone (no @) → broadcast", () => {
  const r = parseDmRequest({ content: "<@1541> dm everyone free skins tonight", botId: "1541" });
  assert.equal(r.broadcast, true);
  assert.equal(r.instruction, "free skins tonight");
});

test("broadcast keyword → broadcast, empty message allowed for prompting", () => {
  const r = parseDmRequest({ content: "<@1541> broadcast", botId: "1541" });
  assert.equal(r.broadcast, true);
  assert.equal(r.instruction, "");
});

test("pronoun targets yield no name", () => {
  const r = parseDmRequest({ content: "<@1> dm him", botId: "1" });
  assert.equal(r.targetId, null);
  assert.equal(r.targetName, null);
  assert.equal(r.instruction, "");
  assert.equal(r.broadcast, false);
});

test("not a dm request → null", () => {
  assert.equal(parseDmRequest({ content: "what a great day", botId: "1" }), null);
  assert.equal(parseDmRequest({ content: "spammy words dm... kind of", botId: "1" }), null);
  assert.equal(parseDmRequest({ content: "hey man remember when we owned those noobs", botId: "1" }), null);
  assert.equal(parseDmRequest({ content: "", botId: "1" }), null);
});
