/** Rate limiter tests. */

import test from "node:test";
import assert from "node:assert/strict";
import { SlidingWindow } from "../server/lib/ratelim.js";

test("sliding window allows within limit, blocks beyond, resets on expiry", async () => {
  const w = new SlidingWindow(3, 120);   // 3 hits / 120ms
  assert.equal(w.tryConsume("ip").ok, true);
  assert.equal(w.tryConsume("ip").ok, true);
  assert.equal(w.tryConsume("ip").ok, true);
  const blocked = w.tryConsume("ip");
  assert.equal(blocked.ok, false);
  assert.equal(w.count("ip"), 3);
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(w.tryConsume("ip").ok, true);
});

test("independent keys tracked separately", () => {
  const w = new SlidingWindow(2, 60_000);
  assert.equal(w.tryConsume("a").ok, true);   // a #1
  assert.equal(w.tryConsume("b").ok, true);   // b #1
  assert.equal(w.tryConsume("a").ok, true);   // a #2 (limit 2)
  assert.equal(w.tryConsume("a").ok, false);  // a blocked
  assert.equal(w.tryConsume("b").ok, true);   // b #2 allowed
  assert.equal(w.tryConsume("b").ok, false);  // b blocked now
  w.reset("a");
  assert.equal(w.tryConsume("a").ok, true);   // reset works only for a
});
