/**
 * REST API — all dashboard endpoints. Secrets are NEVER serialized into responses
 * (keys only appear as {configured, last4}). Auth enforced via session cookie + CSRF header.
 */

import express from "express";
import { getConfig, updateConfig, hasSecret, setSecret, clearSecret, markSecretSet, backupConfig } from "../lib/config.js";
import grok, { GrokError } from "../lib/grok.js";
import { listAudit, audit } from "../lib/audit.js";
import {
  initContext, listTrackedChannels, buildTranscript, listFaqs, deleteFaq, deleteAllFaqs,
  matchFaq, clearAllContext, learnQuestion, pruneChannel, rememberAnswer,
} from "../lib/context.js";
import { engineStats, resetBreaker, resetEngineState, generateDraft, postProcess } from "../lib/engine.js";
import { parseExamples, analyzeMessages, mergeProfile, DEFAULT_PROFILE } from "../lib/style.js";
import approvals, { initApprovals } from "../services/approvals.js";
import {
  startBot, stopBot, botStatus, sendHistory, inviteUrl, listCachedGuilds,
  listChannels as listDiscordChannels, composeMessage, sendApprovedDraft, testMessage,
} from "../services/discordbot.js";
import auth from "../auth.js";
import { log } from "../lib/logger.js";

const router = express.Router();

// helper: async wrapper
const h = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    log.error(`[api] ${req.method} ${req.path} failed:`, err?.message || err);
    const status = err instanceof GrokError ? err.status : 500;
    res.status(status || 500).json({ error: err?.message || "internal error" });
  });
};

function emit(res, data) {
  res.json({ ok: true, ...data });
}

function cleanChannelConfig(c) {
  return {
    id: c.id, name: c.name || "", guildId: c.guildId || "",
    enabled: c.enabled !== false,
    mode: c.mode || "off",
    approvalMode: c.approvalMode === true,
    cooldownSeconds: c.cooldownSeconds ?? null,
    maxPerHour: c.maxPerHour ?? null,
    replyChance: c.replyChance ?? null,
    systemHint: c.systemHint || "",
  };
}

/** config the dashboard is allowed to see (no secrets) */
function publicConfig() {
  const cfg = getConfig();
  return {
    xai: {
      keyConfigured: hasSecret("xai"),
      keyLast4: cfg.xai.apiKeyLast4 || "",
      model: cfg.xai.model,
      baseUrl: cfg.xai.baseUrl || "https://api.x.ai/v1",
      localMode: !/api\.x\.ai/i.test(cfg.xai.baseUrl || "https://api.x.ai/v1"),
      temperature: cfg.xai.temperature,
      topP: cfg.xai.topP,
      maxOutputTokens: cfg.xai.maxOutputTokens,
      requestTimeoutMs: cfg.xai.requestTimeoutMs,
      rateLimit: cfg.xai.rateLimit,
    },
    discord: {
      tokenConfigured: hasSecret("discord"),
      tokenLast4: cfg.discord.botTokenLast4 || "",
      clientId: cfg.discord.clientId || "",
      permissions: cfg.discord.permissions,
      inviteUrl: inviteUrl(),
      guilds: cfg.discord.guilds || [],
    },
    reply: cfg.reply,
    channels: (cfg.channels || []).map(cleanChannelConfig),
    personality: cfg.personality,
    memory: { ...cfg.memory },
    generatedReply: cfg.generatedReply,
    audit: cfg.audit,
    admin: { username: cfg.admin.username },
  };
}

/* ── AUTH ───────────────────────────────────────────────────────────── */

router.get("/auth/status", (req, res) => {
  emit(res, { authenticated: !!req.session, firstRun: !auth.hasPassword(), username: getConfig().admin.username });
});

router.post("/auth/login", h((req, res) => {
  const { username, password } = req.body || {};
  const result = auth.tryLogin(auth.clientIp(req), { username, password });
  if (!result.ok) return res.status(result.status || 401).json({ error: result.err });
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", auth.sessionCookie(result.token, getConfig().auth.sessionTtlHours, secure));
  emit(res, { authenticated: true });
}));

router.post("/auth/logout", h((req, res) => {
  const token = auth.readCookie(req);
  if (token) auth.logout(token);
  res.setHeader("Set-Cookie", auth.clearCookie());
  emit(res, {});
}));

router.post("/auth/logout-all", h((req, res) => {
  auth.logoutEverywhere();
  res.setHeader("Set-Cookie", auth.clearCookie());
  emit(res, {});
}));

router.post("/auth/password", h((req, res) => {
  const { current, next } = req.body || {};
  if (!auth.verifyPassword(current || "", getConfig().admin.passwordHash) && process.env.ADMIN_PASSWORD !== current) {
    return res.status(401).json({ error: "current password incorrect" });
  }
  auth.setPassword(next);
  res.setHeader("Set-Cookie", auth.clearCookie());
  emit(res, { changed: true, note: "log in again" });
}));

/* ── DASHBOARD OVERVIEW ─────────────────────────────────────────────── */

router.get("/dashboard", h((req, res) => {
  const stats = engineStats();
  const approvalsPending = approvals.pendingCount();
  const grokUsage = grok.getUsage();
  emit(res, {
    bot: botStatus(),
    engine: stats,
    grokUsage,
    approvalsPending,
    sendHistory: sendHistory(20),
    audit: listAudit({ limit: 25 }),
    config: publicConfig(),
    models: grok.GROK_MODELS.map((m) => m.id),
    serverTime: Date.now(),
  });
}));

/* ── xAI ────────────────────────────────────────────────────────────── */

router.get("/xai/status", (req, res) => emit(res, publicConfig().xai));

router.put("/xai/key", h((req, res) => {
  const key = String(req.body?.key || "").trim();
  if (!/^xai-[A-Za-z0-9_-]{16,}$/.test(key)) {
    return res.status(400).json({ error: "that doesn't look like an xAI key (expected format: xai-…)" });
  }
  setSecret("xai", key);
  updateConfig({ xai: {} }, { persist: true });
  markSecretSet("xai");
  audit("xai.key_set", `xAI API key stored (ends ${key.slice(-4)})`);
  emit(res, { configured: true, last4: key.slice(-4) });
}));

router.delete("/xai/key", h((req, res) => {
  clearSecret("xai");
  audit("xai.key_removed", "xAI API key removed");
  stopBot().catch(() => {});
  emit(res, {});
}));

router.get("/xai/models", h(async (req, res) => {
  const result = await grok.listModels();
  const filtered = result.models.filter((m) => !/image|vision|audio|tts|speech/i.test(m.id));
  const pricing = Object.fromEntries(grok.GROK_MODELS.map((m) => [m.id, m.pricing]));
  for (const m of filtered) if (!m.pricing && pricing[m.id]) m.pricing = pricing[m.id];
  emit(res, { ok: result.ok, models: filtered, pricing, error: result.error });
}));

router.post("/xai/test", h(async (req, res) => {
  try {
    const result = await grok.testConnection();
    audit("xai.test", `Connection OK (${result.meta?.latencyMs ?? "?"}ms, model ${result.meta?.model ?? "?"})`);
    emit(res, { connected: true, sample: result.sample, usageMs: result.usageMs, model: result.model });
  } catch (err) {
    audit("xai.test_fail", err.message);
    res.status(err instanceof GrokError ? err.status : 502).json({ error: err.message, detail: err.detail?.error || null });
  }
}));

router.put("/xai/settings", h((req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.model === "string" && b.model.trim()) patch.model = b.model.trim();
  if (typeof b.baseUrl === "string" && /^https?:\/\/\S+$/.test(b.baseUrl.trim())) patch.baseUrl = b.baseUrl.trim().replace(/\/+$/, "");
  if (typeof b.temperature === "number") patch.temperature = clampN(b.temperature, 0, 1.2);
  if (typeof b.topP === "number") patch.topP = clampN(b.topP, 0, 1);
  if (typeof b.maxOutputTokens === "number") patch.maxOutputTokens = Math.round(clampN(b.maxOutputTokens, 40, 4000));
  if (typeof b.requestTimeoutMs === "number") patch.requestTimeoutMs = Math.round(clampN(b.requestTimeoutMs, 4000, 240000));
  updateConfig({ xai: patch }, { immediate: true });
  audit("xai.settings", `LLM tuning: ${JSON.stringify(patch)}`);
  emit(res, publicConfig().xai);
}));

router.put("/xai/limits", h((req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.requestsPerMinute === "number") patch.requestsPerMinute = Math.round(clampN(b.requestsPerMinute, 1, 120));
  if (typeof b.maxDailyCostUsd === "number") patch.maxDailyCostUsd = clampN(b.maxDailyCostUsd, 0, 1000);
  if (typeof b.maxDailyRequests === "number") patch.maxDailyRequests = Math.round(clampN(b.maxDailyRequests, 0, 100000));
  updateConfig({ xai: { rateLimit: patch } }, { immediate: true });
  audit("xai.limits", `Spend/request limits: ${JSON.stringify(patch)}`);
  emit(res, publicConfig().xai.rateLimit);
}));

router.get("/xai/usage", (req, res) => emit(res, { usage: grok.getUsage(), engineStats: engineStats() }));

/* ── DISCORD ────────────────────────────────────────────────────────── */

router.get("/discord/status", (req, res) => emit(res, { bot: botStatus(), tokenConfigured: hasSecret("discord") }));

router.put("/discord/token", h((req, res) => {
  const token = String(req.body?.token || "").trim();
  if (token && !/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[-A-Za-z0-9_.]{20,}$/.test(token)) {
    return res.status(400).json({ error: "not a valid Discord bot token format" });
  }
  if (req.body?.clientId) updateConfig({ discord: { clientId: String(req.body.clientId).trim() } });
  if (token) {
    setSecret("discord", token);
    markSecretSet("discord");
    audit("discord.token_set", `Bot token stored (client ${getConfig().discord.clientId || "pending"})`);
  }
  emit(res, { configured: hasSecret("discord"), inviteUrl: inviteUrl() });
}));

router.delete("/discord/token", h((req, res) => {
  clearSecret("discord");
  audit("discord.token_removed", "Discord bot token removed");
  stopBot().catch(() => {});
  emit(res, {});
}));

router.post("/discord/connect", h(async (req, res) => {
  if (!hasSecret("discord")) return res.status(400).json({ error: "add a bot token first" });
  audit("discord.connect", "Owner requested bot connect");
  const c = await startBot();
  if (!c) return res.status(502).json({ error: "login failed (check token + gateway intents)" });
  emit(res, { bot: botStatus() });
}));

router.post("/discord/disconnect", h(async (req, res) => {
  audit("discord.disconnect", "Owner requested bot disconnect");
  await stopBot();
  emit(res, {});
}));

router.get("/discord/guilds", (req, res) => {
  emit(res, { guilds: listCachedGuilds(), configured: getConfig().discord.guilds || [] });
});

router.get("/discord/channels/:guildId", h(async (req, res) => {
  const channels = await listDiscordChannels(req.params.guildId, false);
  const configured = getConfig().channels || [];
  const enriched = channels.map((c) => {
    const cc = configured.find((x) => x.id === c.id);
    return { ...cleanChannelConfig(cc || { id: c.id, name: c.name, guildId: req.params.guildId }), live: true, kind: c.type, botPermissions: c.botPermissions, nsfw: c.nsfw };
  });
  const configOnly = configured
    .filter((cc) => !channels.some((ch) => ch.id === cc.id))
    .map(cleanChannelConfig);
  emit(res, { channels: [...enriched, ...configOnly.map((c) => ({ ...c, live: false }))] });
}));

router.post("/discord/test", h(async (req, res) => {
  const { channelId, text, guildId } = req.body || {};
  if (!channelId || !text) return res.status(400).json({ error: "channelId and text required" });
  const result = await testMessage(guildId, channelId, text);
  if (!result.ok) return res.status(502).json({ error: result.err });
  emit(res, result);
}));

router.post("/discord/send", h(async (req, res) => {
  const { channelId, text } = req.body || {};
  if (!channelId || !text) return res.status(400).json({ error: "channelId and text required" });
  const result = await composeMessage(channelId, text);
  if (!result.ok) return res.status(502).json({ error: result.err });
  emit(res, result);
}));

router.put("/discord/permissions", h((req, res) => {
  const p = req.body || {};
  const current = getConfig().discord.permissions;
  const next = {
    ...current,
    ignoreBots: p.ignoreBots !== undefined ? !!p.ignoreBots : current.ignoreBots,
    blockedUsers: Array.isArray(p.blockedUsers) ? p.blockedUsers.map(String).slice(0, 100) : current.blockedUsers,
    blockedRoles: Array.isArray(p.blockedRoles) ? p.blockedRoles.map(String).slice(0, 100) : current.blockedRoles,
    allowedRoles: Array.isArray(p.allowedRoles) ? p.allowedRoles.map(String).slice(0, 100) : current.allowedRoles,
  };
  updateConfig({ discord: { permissions: next } }, { immediate: true });
  audit("discord.permissions", "Permission rules updated");
  emit(res, { permissions: next });
}));

/* ── PERSONALITY ────────────────────────────────────────────────────── */

router.get("/personality", (req, res) => {
  const cfg = getConfig();
  const prof = cfg.styleProfile || analyzeMessages(cfg.personality.examples);
  emit(res, {
    settings: cfg.personality,
    styleProfile: prof,
    examplesCount: cfg.personality.examples.length,
    yamlCount: cfg.personality.yamls?.length || 0,
  });
});

router.put("/personality", h((req, res) => {
  const b = req.body || {};
  const cfg = getConfig();
  const patch = { ...cfg.personality };
  if (b.identityName !== undefined) patch.identityName = String(b.identityName).slice(0, 80);
  if (b.identityHint !== undefined) patch.identityHint = String(b.identityHint).slice(0, 500);
  if (b.lowercase !== undefined) patch.lowercase = !!b.lowercase;
  if (b.noPunctuation !== undefined) patch.noPunctuation = !!b.noPunctuation;
  if (b.maxWords !== undefined) patch.maxWords = Math.round(clampN(b.maxWords, 5, 120));
  if (b.slangLevel !== undefined) patch.slangLevel = Math.round(clampN(b.slangLevel, 0, 5));
  if (b.humorLevel !== undefined) patch.humorLevel = Math.round(clampN(b.humorLevel, 0, 3));
  if (b.gamingTerms !== undefined) patch.gamingTerms = !!b.gamingTerms;
  if (b.reactionGuidance !== undefined) patch.reactionGuidance = !!b.reactionGuidance;
  if (b.systemPrompt !== undefined) patch.systemPrompt = String(b.systemPrompt).slice(0, 2000);
  if (Array.isArray(b.doNotSay)) patch.doNotSay = b.doNotSay.map((s) => String(s).slice(0, 80)).filter(Boolean).slice(0, 80);
  if (b.glossary && typeof b.glossary === "object") {
    patch.glossary = Object.fromEntries(Object.entries(b.glossary).slice(0, 60).map(([k, v]) => [String(k).slice(0, 60), String(v).slice(0, 60)]));
  }
  updateConfig({ personality: patch }, { immediate: true });
  audit("personality.update", "Personality settings updated");
  emit(res, { settings: getConfig().personality });
}));

router.post("/personality/examples", h((req, res) => {
  const raw = String(req.body?.raw || "");
  const parsed = parseExamples(raw);
  if (parsed.length === 0) return res.status(400).json({ error: "no messages found in input" });
  const cfg = getConfig();
  const examples = [...cfg.personality.examples, ...parsed].slice(-400);
  const profile = analyzeMessages(examples);
  updateConfig({ personality: { examples }, styleProfile: profile }, { immediate: true });
  audit("personality.examples", `Imported ${parsed.length} style examples (total ${examples.length})`);
  emit(res, { added: parsed.length, total: examples.length, styleProfile: profile });
}));

router.post("/personality/examples/replace", h((req, res) => {
  const raw = String(req.body?.raw || "");
  const parsed = parseExamples(raw);
  const profile = analyzeMessages(parsed);
  updateConfig({ personality: { examples: parsed }, styleProfile: profile }, { immediate: true });
  audit("personality.examples", `Style dataset replaced with ${parsed.length} examples`);
  emit(res, { total: parsed.length, styleProfile: profile });
}));

router.delete("/personality/examples", h((req, res) => {
  updateConfig({ personality: { examples: [] }, styleProfile: DEFAULT_PROFILE() }, { immediate: true });
  audit("personality.examples", "Style dataset cleared");
  emit(res, {});
}));

router.post("/personality/analyze", h((req, res) => {
  const parsed = parseExamples(String(req.body?.raw || ""));
  emit(res, { found: parsed.length, profile: parsed.length ? analyzeMessages(parsed) : null });
}));

/** Preview a reply in a sandbox — generates but does NOT send to Discord */
router.post("/personality/preview", h(async (req, res) => {
  const { fakeTranscript, note } = req.body || {};
  const cfg = getConfig();
  const result = await generateDraft({
    transcriptText: String(fakeTranscript || "").slice(0, 4000),
    triggerText: String(note || "").slice(0, 800),
    warning: "Sandbox preview from the owner dashboard.",
  });
  emit(res, { draft: result.text, violated: result.violated, meta: result.meta });
}));

/* ── MEMORY / CONTEXT ───────────────────────────────────────────────── */

router.get("/memory", (req, res) => {
  const cfg = getConfig();
  emit(res, {
    facts: cfg.memory.facts || [],
    faqs: listFaqs({ limit: 100 }),
    enabled: cfg.memory.enabled,
    channels: listTrackedChannels(),
  });
});

router.post("/memory/facts", h((req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  if (text.length > 300) return res.status(400).json({ error: "max 300 characters per fact" });
  const cfg = getConfig();
  const fact = { id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, ts: Date.now(), source: req.body?.source || "owner" };
  const facts = [...(cfg.memory.facts || []), fact].slice(-40);
  updateConfig({ memory: { facts } }, { immediate: true });
  audit("memory.fact_add", `Approved fact added: "${text.slice(0, 60)}"`);
  emit(res, { fact });
}));

router.put("/memory/facts/:id", h((req, res) => {
  const cfg = getConfig();
  const facts = (cfg.memory.facts || []).map((f) => (f.id === req.params.id ? { ...f, text: String(req.body?.text || f.text).slice(0, 300) } : f));
  updateConfig({ memory: { facts } }, { immediate: true });
  emit(res, {});
}));

router.delete("/memory/facts/:id", h((req, res) => {
  const cfg = getConfig();
  const before = (cfg.memory.facts || []).length;
  const facts = (cfg.memory.facts || []).filter((f) => f.id !== req.params.id);
  updateConfig({ memory: { facts } }, { immediate: true });
  audit("memory.fact_remove", `Fact removed (${before} -> ${facts.length})`);
  emit(res, {});
}));

router.put("/memory/settings", h((req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.maxTurns !== undefined) patch.maxTurns = Math.round(clampN(b.maxTurns, 2, 40));
  updateConfig({ memory: patch }, { immediate: true });
  emit(res, { memory: publicConfig().memory });
}));

router.delete("/memory/faqs/:id", h((req, res) => {
  deleteFaq(req.params.id);
  audit("memory.faq_delete", `FAQ ${req.params.id} deleted`);
  emit(res, {});
}));

router.delete("/memory/faqs", h((req, res) => {
  deleteAllFaqs();
  audit("memory.faq_clear", "All FAQ memory cleared");
  emit(res, {});
}));

router.post("/memory/faqs/learn", h((req, res) => {
  const f = learnQuestion(String(req.body?.text || ""), "owner");
  emit(res, { faq: f ? { id: f.id, display: f.display, count: f.count } : null });
}));

router.post("/memory/faqs/:id/answer", h((req, res) => {
  const answer = String(req.body?.answer || "").trim();
  if (!answer) return res.status(400).json({ error: "answer required" });
  const faq = listFaqs({ limit: 500 }).find((f) => f.id === req.params.id);
  if (!faq) return res.status(404).json({ error: "faq not found" });
  const question = String(req.body?.question || faq.display || "");
  const updated = rememberAnswer(question, answer);
  if (!updated) return res.status(404).json({ error: "could not attach answer" });
  emit(res, { updated: { id: updated.id, display: updated.display, count: updated.count } });
}));

router.get("/memory/context", h((req, res) => {
  const channelId = String(req.query.channelId || "");
  if (!channelId) return res.status(400).json({ error: "channelId query param required" });
  const transcript = buildTranscript(channelId, {maxTurns: 30, maxChars: 6000});
  const faqHit = matchFaq(String(req.query.text || ""));
  emit(res, { channelId, transcript, faq: faqHit ? { display: faqHit.display, count: faqHit.count } : null });
}));

router.delete("/memory/context", h((req, res) => {
  const channelId = String(req.query.channelId || "");
  if (channelId) pruneChannel(channelId);
  else clearAllContext();
  audit("memory.context_clear", channelId ? `Context cleared for ${channelId}` : "All context cleared");
  emit(res, {});
}));

/* ── CHANNELS & REPLY RULES ─────────────────────────────────────────── */

router.get("/channels", (req, res) => {
  const cfg = getConfig();
  emit(res, { channels: (cfg.channels || []).map(cleanChannelConfig), reply: cfg.reply });
});

router.put("/channels/:id", h((req, res) => {
  const channelId = req.params.id;
  const b = req.body || {};
  const cfg = getConfig();
  const next = [...(cfg.channels || [])];
  let entry = next.find((c) => c.id === channelId);
  if (!entry) {
    entry = { id: channelId, name: b.name || channelId, guildId: b.guildId || "", enabled: true, mode: "off" };
    next.push(entry);
  }
  if (b.name !== undefined) entry.name = String(b.name).slice(0, 120);
  if (b.guildId !== undefined) entry.guildId = String(b.guildId);
  if (b.mode !== undefined) {
    const m = String(b.mode).toLowerCase();
    if (!["off", "mention", "question", "selective", "always"].includes(m)) return res.status(400).json({ error: `invalid mode ${m}` });
    entry.mode = m;
  }
  if (b.enabled !== undefined) entry.enabled = !!b.enabled;
  if (b.approvalMode !== undefined) entry.approvalMode = !!b.approvalMode;
  if (b.cooldownSeconds !== undefined) entry.cooldownSeconds = b.cooldownSeconds === null ? null : Math.round(clampN(b.cooldownSeconds, 10, 86400));
  if (b.maxPerHour !== undefined) entry.maxPerHour = b.maxPerHour === null ? null : Math.round(clampN(b.maxPerHour, 1, 200));
  if (b.replyChance !== undefined) entry.replyChance = b.replyChance === null ? null : clampN(b.replyChance, 0, 1);
  if (b.systemHint !== undefined) entry.systemHint = String(b.systemHint).slice(0, 1000);
  updateConfig({ channels: next }, { immediate: true });
  audit("channel.update", `#${entry.name} mode=${entry.mode} enabled=${entry.enabled} approval=${entry.approvalMode}`);
  emit(res, { channel: cleanChannelConfig(entry) });
}));

router.delete("/channels/:id", h((req, res) => {
  const cfg = getConfig();
  const next = (cfg.channels || []).filter((c) => c.id !== req.params.id);
  updateConfig({ channels: next }, { immediate: true });
  audit("channel.remove", `Channel removed from watch list`);
  emit(res, {});
}));

router.put("/reply", h((req, res) => {
  const b = req.body || {};
  const cur = getConfig().reply;
  const patch = { ...cur };
  if (b.cooldownSeconds !== undefined) patch.cooldownSeconds = Math.round(clampN(b.cooldownSeconds, 15, 86400));
  if (b.globalCooldownSeconds !== undefined) patch.globalCooldownSeconds = Math.round(clampN(b.globalCooldownSeconds, 5, 3600));
  if (b.maxPerChannelHour !== undefined) patch.maxPerChannelHour = Math.round(clampN(b.maxPerChannelHour, 1, 200));
  if (b.maxDailyReplies !== undefined) patch.maxDailyReplies = Math.round(clampN(b.maxDailyReplies, 1, 2000));
  if (b.duplicateWindowHours !== undefined) patch.duplicateWindowHours = Math.round(clampN(b.duplicateWindowHours, 1, 336));
  if (b.selectiveProbability !== undefined) patch.selectiveProbability = clampN(b.selectiveProbability, 0, 1);
  if (Array.isArray(b.blockedKeywords)) patch.blockedKeywords = b.blockedKeywords.map((s) => String(s).slice(0, 80)).filter(Boolean).slice(0, 60);
  if (b.defaultMode !== undefined && ["off", "mention", "question", "selective", "always"].includes(String(b.defaultMode))) {
    patch.selectiveModeDefault = String(b.defaultMode);
  }
  updateConfig({ reply: patch }, { immediate: true });
  audit("reply.settings", `Reply rules updated: ${JSON.stringify({...patch, blockedKeywords: patch.blockedKeywords?.length})}`);
  emit(res, { reply: getConfig().reply });
}));

/* ── APPROVALS + COMPOSE ────────────────────────────────────────────── */

router.get("/approvals", (req, res) => emit(res, { drafts: approvals.listDrafts({ status: req.query.status || null }), pending: approvals.pendingCount() }));

/** manually ask AI to draft a reply for a channel context (goes to approval queue) */
router.post("/approvals/generate", h(async (req, res) => {
  const channelId = String(req.body?.channelId || "");
  if (!channelId) return res.status(400).json({ error: "channelId required" });
  const cfg = getConfig();
  const transcript = buildTranscript(channelId);
  const memoryFacts = (cfg.memory.facts || []).slice(0, 14).map((f) => f.text);
  const result = await generateDraft({
    transcriptText: transcript,
    triggerText: String(req.body?.focus || "").slice(0, 800),
    memoryFacts,
    warning: "Draft requested by owner from dashboard. Send nothing yourself.",
  });
  const draft = approvals.enqueueDraft({
    channelId,
    channelName: req.body?.channelName || channelId,
    triggerContent: req.body?.focus || "(owner-initiated draft)",
    draft: result.text,
    reason: "owner_requested",
  });
  emit(res, { draft });
}));

router.post("/approvals/:id/edit", h((req, res) => {
  const d = approvals.editDraft(parseInt(req.params.id, 10), String(req.body?.text || ""));
  if (!d) return res.status(404).json({ error: "draft not found or already resolved" });
  emit(res, { draft: d });
}));

router.post("/approvals/:id/send", h(async (req, res) => {
  const d = approvals.getDraft(parseInt(req.params.id, 10));
  if (!d) return res.status(404).json({ error: "draft not found" });
  const text = req.body?.text ? String(req.body.text) : d.draft;
  const result = await sendApprovedDraft(d.channelId, text, d.id);
  if (!result.ok) return res.status(502).json({ error: result.err });
  approvals.markSent(d.id, text);
  emit(res, { sent: true, id: result.id });
}));

/** Owner sends themselves: returns clean text + jump link, marks resolved */
router.post("/approvals/:id/send-self", h((req, res) => {
  const d = approvals.getDraft(parseInt(req.params.id, 10));
  if (!d) return res.status(404).json({ error: "draft not found" });
  const clean = String(req.body?.text || d.draft).replace(/\s*\[AI\]\s*$/i, "");
  approvals.markSent(d.id, clean);
  audit("approval.send_self", `Owner marked draft as sent personally (guild ${d.guildId}, channel ${d.channelId})`);
  emit(res, { text: clean, jump: `https://discord.com/channels/${d.guildId || "@me"}/${d.channelId}` });
}));

router.post("/approvals/:id/discard", h((req, res) => {
  const d = approvals.markDiscarded(parseInt(req.params.id, 10));
  if (!d) return res.status(404).json({ error: "draft not found" });
  audit("approval.discard", `Draft discarded for #${d.channelName}`);
  emit(res, {});
}));

router.delete("/approvals/resolved", (req, res) => {
  const removed = approvals.clearResolved();
  emit(res, { removed });
});

/* ── CONTROL (emergency stop etc.) ──────────────────────────────────── */

router.put("/generated", h((req, res) => {
  const b = req.body || {};
  const cur = getConfig().generatedReply;
  const patch = { ...cur };
  if (["approval", "auto"].includes(b.mode)) patch.mode = b.mode;
  if (["auto", "always", "never"].includes(b.disclosure)) patch.disclosure = b.disclosure;
  if (typeof b.markSymbol === "string") patch.markSymbol = b.markSymbol.slice(0, 12) || "[AI]";
  updateConfig({ generatedReply: patch }, { immediate: true });
  audit("generated.pipeline", `reply pipeline: ${JSON.stringify(patch)}`);
  emit(res, { generatedReply: getConfig().generatedReply });
}));

router.post("/control/stop", h((req, res) => {
  const stopped = !!(req.body?.stopped ?? true);
  const reason = String(req.body?.reason || (stopped ? "emergency stop" : "")).slice(0, 120);
  updateConfig({ reply: { stopped } }, { immediate: true });
  audit(stopped ? "control.stopped" : "control.resumed", reason);
  log.warn(`[control] emergency stop ${stopped ? "ENGAGED" : "released"} — ${reason}`);
  emit(res, { stopped, reason });
}));

router.post("/control/breaker-reset", h((req, res) => {
  resetBreaker();
  emit(res, { breaker: false });
}));

router.post("/control/reset-state", h((req, res) => {
  resetEngineState();
  audit("control.reset_state", "Engine rate state reset");
  emit(res, {});
}));

router.post("/control/backup", h((req, res) => {
  const file = backupConfig();
  emit(res, { file: file.split(/[\\/]/).pop() });
}));

/* ── AUDIT + WELLNESS ──────────────────────────────────────────────── */

router.get("/audit", (req, res) => {
  emit(res, { entries: listAudit({ limit: clampN(parseInt(req.query.limit, 10) || 120, 1, 400) }) });
});

export default router;

function clampN(v, min, max) {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
