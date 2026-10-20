/** Approval queue tests. */

import test from "node:test";
import assert from "node:assert/strict";
import { initApprovals, enqueueDraft, listDrafts, getDraft, markSent, markDiscarded, editDraft, clearResolved, pendingCount } from "../server/services/approvals.js";

test("enqueue + list + resolve happy path", () => {
  const d = enqueueDraft({ channelId: "c1", channelName: "general", authorName: "cam", triggerContent: "when is wipe?", draft: "thursday 20:00 as always", reason: "question" });
  assert.ok(d.id > 0);
  assert.equal(pendingCount(), 1);

  const found = getDraft(d.id);
  assert.ok(found);
  assert.equal(found.draft, "thursday 20:00 as always");

  const edited = editDraft(d.id, "thursday 20:00 EU sharp");
  assert.equal(edited.draft, "thursday 20:00 EU sharp");
  assert.equal(edited.edited, true);

  const sent = markSent(d.id, "thursday 20:00 EU sharp");
  assert.equal(sent.status, "sent");
  assert.equal(pendingCount(), 0);
  assert.equal(getDraft(d.id), null);
});

test("discard + resolved cleanup", () => {
  const a = enqueueDraft({ channelId: "c2", channelName: "memes", draft: "a", reason: "" });
  const b = enqueueDraft({ channelId: "c2", channelName: "memes", draft: "b", reason: "" });
  markDiscarded(a.id);
  assert.equal(getDraft(a.id), null);
  const removed = clearResolved();
  assert.ok(removed >= 1);
  const remaining = listDrafts({});
  assert.ok(remaining.every((x) => x.status === "pending"));
});

test("empty drafts are rejected", () => {
  assert.equal(enqueueDraft({ channelId: "x", draft: "   ", reason: "" }), null);
});
