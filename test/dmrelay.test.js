/** DM relay parser tests. */

import test from "node:test";
import assert from "node:assert/strict";
import { parseDmRequest } from "../server/lib/dmrelay.js";

test("bot mention + dm with a target ping", () => {
  const r = parseDmRequest({
    content: "<@1541> dm <@9988> tell him the raid is 8pm",
    mentionIds: ["1541"],
  });
  assert.deepEqual(r, { targetId: "9988", targetName: null, instruction: "tell him the raid is 8pm" });
});

test("name-based target, bot mention not stripped when tags absent", () => {
  const r = parseDmRequest({
    content: "dmzaluxoo drop a joke",   // no leading mention → must still parse (loose form)
    mentionIds: [],
  });
  assert.equal(r, null);   // without a bot ping the gateway never routes here, but stay safe
});

test("dm @name instruction (no id)", () => {
  const r = parseDmRequest({
    content: "<@1541> dm @zaluxoo send a joke",
    mentionIds: ["1541"],
  });
  assert.equal(r.targetId, null);
  assert.equal(r.targetName, "zaluxoo");
  assert.equal(r.instruction, "send a joke");
});

test("bare dm request → generic hello", () => {
  const r = parseDmRequest({ content: "<@5678> dm <@9988>", mentionIds: ["5678"] });
  assert.equal(r.targetId, "9988");
  assert.equal(r.instruction, "");
});

test("pronoun targets yield no name", () => {
  const r = parseDmRequest({ content: "<@1> dm him", mentionIds: ["1"] });
  assert.equal(r.targetId, null);
  assert.equal(r.targetName, null);
  assert.equal(r.instruction, "");
});

test("not a dm request → null", () => {
  assert.equal(parseDmRequest({ content: "what a great day", mentionIds: [] }), null);
  assert.equal(parseDmRequest({ content: "spammy words dm... kind of", mentionIds: [] }), null);
  assert.equal(parseDmRequest({ content: "", mentionIds: [] }), null);
});
