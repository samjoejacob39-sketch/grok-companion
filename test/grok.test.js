/** Grok client tests with a mocked global fetch. */

import test from "node:test";
import assert from "node:assert/strict";
import { chatComplete, estimateCost, GrokError } from "../server/lib/grok.js";
import { updateConfig } from "../server/lib/config.js";

let lastFetchArgs = null;
const realFetch = globalThis.fetch;

function mockFetch(handler) {
  globalThis.fetch = async (url, opts) => {
    lastFetchArgs = { url, opts };
    return handler(url, opts);
  };
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test("chatCompletion parses response and tracks usage", async () => {
  updateConfig({ xai: { apiKey: "xai-test-key-1234567890", baseUrl: "https://api.x.ai/v1" } }, { immediate: true });
  mockFetch(() => new Response(JSON.stringify({
    choices: [{ message: { content: "lol yeah raid is 8pm" } }],
    usage: { prompt_tokens: 500, completion_tokens: 60 },
  }), { status: 200, headers: { "Content-Type": "application/json" } }));

  const res = await chatComplete({ messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  assert.equal(res.content, "lol yeah raid is 8pm");
  assert.ok(res.meta.latencyMs >= 0);
  assert.equal(res.usage.prompt_tokens, 500);
  assert.equal(lastFetchArgs.opts.headers.Authorization, "Bearer xai-test-key-1234567890");
  assert.match(lastFetchArgs.url, /chat\/completions/);
});

test("API errors map to GrokError with proper status", async () => {
  mockFetch(() => new Response(JSON.stringify({ error: "invalid api key" }), { status: 401 }));
  await assert.rejects(() => chatComplete({ messages: [] }), (err) => err instanceof GrokError && err.status === 401);
});

test("missing API key throws a clear error", async () => {
  updateConfig({ xai: { apiKey: "" } }, { immediate: true });
  await assert.rejects(() => chatComplete({ messages: [] }), (err) => /No xAI API key/.test(err.message));
  updateConfig({ xai: { apiKey: "xai-test-key-1234567890" } }, { immediate: true });
});

test("connection failures map to 502 GrokError", async () => {
  mockFetch(() => { throw new Error("ECONNREFUSED"); });
  await assert.rejects(() => chatComplete({ messages: [] }), (err) => err instanceof GrokError && err.status === 502);
});

test("cost estimate uses per-model pricing", () => {
  const fast = estimateCost("grok-4-fast-reasoning", { prompt_tokens: 5_000_000, completion_tokens: 1_000_000 });
  assert.ok(Math.abs(fast - (0.2 * 5 + 0.5 * 1)) < 1e-9);
  const big = estimateCost("grok-3", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  assert.ok(Math.abs(big - (3 + 15)) < 1e-9);
  assert.equal(estimateCost("grok-3", null), 0);
});
