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
  updateConfig({ xai: { apiKey: "", baseUrl: "https://api.x.ai/v1" } }, { immediate: true });
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

test("local OpenAI-compatible endpoint works with no API key and costs $0", async () => {
  updateConfig({ xai: { apiKey: "", baseUrl: "http://127.0.0.1:11434/v1" } }, { immediate: true });
  mockFetch(() => new Response(JSON.stringify({
    choices: [{ message: { content: "lol same tbh" } }],
    usage: { prompt_tokens: 900, completion_tokens: 40 },
  }), { status: 200, headers: { "Content-Type": "application/json" } }));

  const res = await chatComplete({ messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  assert.equal(res.content, "lol same tbh");
  assert.ok(!("Authorization" in lastFetchArgs.opts.headers), "must not send auth header to local server");
  assert.match(lastFetchArgs.url, /127\.0\.0\.1:11434\/v1\/chat\/completions/);
  assert.equal(res.meta.cost, 0, "local models must report zero cost");
  assert.equal(estimateCost("llama3.2:3b", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 0);
  updateConfig({ xai: { apiKey: "xai-test-key-1234567890", baseUrl: "https://api.x.ai/v1" } }, { immediate: true });
});

test("free hosted model (OpenRouter) works with key and costs $0", async () => {
  updateConfig({ xai: { apiKey: "sk-or-v1-testkey1234567890abcdefghij", baseUrl: "https://openrouter.ai/api/v1", model: "nvidia/nemotron-3.5-lightning:free" } }, { immediate: true });
  mockFetch(() => new Response(JSON.stringify({
    choices: [{ message: { content: "bf fr ngl" } }],
    usage: { prompt_tokens: 700, completion_tokens: 25 },
  }), { status: 200, headers: { "Content-Type": "application/json" } }));

  const res = await chatComplete({ messages: [{ role: "user", content: "yo" }] });
  assert.equal(res.content, "bf fr ngl");
  assert.equal(lastFetchArgs.opts.headers.Authorization, "Bearer sk-or-v1-testkey1234567890abcdefghij");
  assert.equal(res.meta.cost, 0);
  updateConfig({ xai: { apiKey: "xai-test-key-1234567890", baseUrl: "https://api.x.ai/v1", model: "grok-4-fast-reasoning" } }, { immediate: true });
});

test("hosted provider without any key gives a helpful error", async () => {
  updateConfig({ xai: { apiKey: "", baseUrl: "https://openrouter.ai/api/v1" } }, { immediate: true });
  await assert.rejects(() => chatComplete({ messages: [] }), (err) => /free one/.test(err.message));
  updateConfig({ xai: { apiKey: "xai-test-key-1234567890", baseUrl: "https://api.x.ai/v1" } }, { immediate: true });
});

test("thinking models: fast for banter, reasoning kept for thinkable questions", async () => {
  updateConfig({ xai: { apiKey: "sk-or-v1-testkey1234567890abcdefghij", baseUrl: "https://openrouter.ai/api/v1", model: "nvidia/nemotron-3.5-lightning:free" } }, { immediate: true });
  mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: "yo" } }] }), { status: 200 }));

  await chatComplete({ messages: [{ role: "user", content: "heyy" }] });
  let body = JSON.parse(lastFetchArgs.opts.body);
  assert.deepEqual(body.reasoning, { enabled: false });

  await chatComplete({ messages: [{ role: "user", content: "why does our event scheduling drift by hours every week? explain the difference between the two approaches" }] });
  body = JSON.parse(lastFetchArgs.opts.body);
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.ok(body.max_tokens >= 2000);

  updateConfig({ xai: { apiKey: "xai-test-key-1234567890", baseUrl: "https://api.x.ai/v1", model: "grok-4-fast-reasoning" } }, { immediate: true });
});
