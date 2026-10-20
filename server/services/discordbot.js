/**
 * Discord bot service — official discord.js gateway client.
 * Watches configured channels, feeds context, runs the reply pipeline
 * (auto-mode → send via bot account, approval-mode → queue for owner),
 * and exposes connection monitoring to the dashboard.
 */

import { Client, GatewayIntentBits, Partials, ChannelType, Events, ActivityType } from "discord.js";
import { getConfig, updateConfig, getSecret } from "../lib/config.js";
import { recordMessage, buildTranscript, learnQuestion, matchFaq, rememberAnswer } from "../lib/context.js";
import {
  decide, markReplied, recordFailure, recordSuccess,
  generateDraft, engineStats, getEngineState, MAX_CONCURRENT, resetBreaker,
} from "../lib/engine.js";
import { audit } from "../lib/audit.js";
import { log } from "../lib/logger.js";
import approvals from "./approvals.js";

let client = null;
let currentStatus = "not_configured"; // not_configured|connecting|ready|reconnecting|error|stopped
let lastReadyTs = 0;
let ping = 0;
let uptimeSince = 0;
const sendLog = [];          // recent outgoing messages (audit trail)
const MONITOR_LIMIT = 50;
let monitor = [];            // connection-monitor ring buffer

// run queue
const queue = [];
let inFlight = 0;
const MAX_QUEUE = 20;

// ── status helpers ───────────────────────────────────────────────

export function botStatus() {
  const cfg = getConfig();
  const user = client?.user;
  return {
    status: currentStatus,
    user: user ? { id: user.id, username: user.username, tag: user.tag, avatar: user.displayAvatarURL() } : null,
    ping: Math.max(0, ping | 0),
    lastReadyTs,
    uptimeSec: uptimeSince ? Math.floor((Date.now() - uptimeSince) / 1000) : 0,
    guilds: (cfg.discord.guilds || []).map((g) => ({ ...g, connected: !!client?.guilds?.cache?.has(g.id) })),
    inviteUrl: inviteUrl(),
    inFlight,
    queueLen: queue.length,
    monitor: monitor.slice(-MONITOR_LIMIT).reverse(),
  };
}

export function sendHistory(limit = 80) {
  return sendLog.slice(-limit).reverse();
}

export function inviteUrl() {
  const cfg = getConfig().discord;
  let cid = cfg.clientId || "";
  if (!cid && client?.user) cid = client.user.id;
  if (!cid && getSecret("discord")) {
    try {
      const seg = getSecret("discord").split(".")[0];
      cid = Buffer.from(seg, "base64").toString() || cid;
    } catch { /* malformed */ }
  }
  if (!cid || !/^\d+$/.test(cid)) return "";
  // ViewChannel 1024 + SendMessages 2048 + ReadMessageHistory 65536 = 68608
  return `https://discord.com/oauth2/authorize?client_id=${cid}&scope=bot&permissions=68608`;
}

function setStatus(s, detail = "") {
  if (currentStatus !== s) {
    monitor.push({ ts: Date.now(), status: s, detail: detail || "" });
    if (monitor.length > MONITOR_LIMIT * 2) monitor = monitor.slice(-MONITOR_LIMIT);
    if (s === "error" || s === "reconnecting") audit(`discord.${s}`, detail || s);
  }
  currentStatus = s;
}

// ── lifecycle ────────────────────────────────────────────────────

export async function startBot() {
  const token = getSecret("discord");
  if (!token) { setStatus("not_configured"); return null; }
  if (client) {
    try { await client.destroy(); } catch { /* down already */ }
    client = null;
  }
  setStatus("connecting");

  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  });

  wireClient(client);

  try {
    await client.login(token);
  } catch (err) {
    setStatus("error", err?.message || "login failed");
    log.error("[discord] login failed:", err?.message);
    audit("discord.login_error", (err?.message || "login failed").slice(0, 300));
    try { await client.destroy(); } catch { /* noop */ }
    client = null;
    return null;
  }
  return client;
}

export async function stopBot() {
  if (client) {
    try { await client.destroy(); } catch { /* noop */ }
    client = null;
  }
  setStatus("stopped", "stopped by dashboard");
  log.info("[discord] bot stopped");
}

export async function restartBot() {
  await stopBot();
  return startBot();
}

function wireClient(c) {
  c.on(Events.ClientReady, () => {
    lastReadyTs = Date.now();
    uptimeSince = lastReadyTs;
    setStatus("ready");
    log.info(`[discord] connected as ${c.user.tag}`);
    audit("discord.ready", `Connected as ${c.user.tag}`);

    if (!getConfig().discord.clientId) {
      updateConfig({ discord: { clientId: c.user.id } }, { immediate: true });
    }
    c.user.setPresence({
      activities: [{ name: "community chats", type: ActivityType.Custom }],
      status: "online",
    });
    const guilds = c.guilds.cache.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount ?? null, icon: g.iconURL() || null }));
    updateConfig({ discord: { guilds } }, { immediate: true });
  });

  c.on(Events.ShardDisconnect, () => setStatus("reconnecting", "gateway disconnected"));
  c.on(Events.ShardReconnecting, () => setStatus("reconnecting", "reconnecting to gateway"));
  c.on(Events.ShardResume, () => setStatus("ready"));
  c.on(Events.Error, (err) => setStatus("error", err?.message || "client error"));
  c.on(Events.Warn, (m) => log.warn("[discord] warn:", m));
  c.on("messageCreate", handleMessage);

  // live ping sampling for the dashboard
  const pingTimer = setInterval(() => {
    if (c.ws && typeof c.ws.ping === "number" && Number.isFinite(c.ws.ping)) ping = c.ws.ping;
  }, 30_000);
  c.__pingTimer = pingTimer;
}

// ── message handler ──────────────────────────────────────────────

function handleMessage(msg) {
  try {
    processMessage(msg).catch((err) => log.error("[discord] pipeline failed:", err?.message || err));
  } catch (err) {
    log.error("[discord] message handler threw:", err?.message || err);
  }
}

const REPLYABLE = new Set([ChannelType.GuildText, ChannelType.PublicThread, ChannelType.GuildAnnouncement, ChannelType.PrivateThread]);

export async function processMessage(msg) {
  if (!msg || !msg.channel) return;
  if (!REPLYABLE.has(msg.channel.type)) return;

  const cfg = getConfig();
  const botUser = client?.user;
  const isSelf = !!(botUser && msg.author?.id === botUser.id);

  // mention / reply-to-bot detection (regex-safe, no dynamic RegExp)
  const mentionedByPattern = !!(botUser && String(msg.content || "").includes(`<@${botUser.id}>`)) ||
    !!(botUser && String(msg.content || "").includes(`<@!${botUser.id}>`));
  const mentionedBot = mentionedByPattern || !!(botUser && msg.mentions?.users?.has(botUser.id));

  const refCached = msg.reference?.messageId ? msg.channel.messages.cache?.get(msg.reference.messageId) : null;
  const refToBot = !!(refCached && botUser && refCached.author?.id === botUser.id);

  // always record to context (learning), even when not replying
  recordMessage({
    channel: msg.channelId,
    guildId: msg.guildId,
    name: msg.channel?.name || "",
    msg: {
      authorId: msg.author?.id || "unknown",
      authorName: msg.author?.username || "unknown",
      bot: !!msg.author?.bot,
      content: msg.cleanContent || msg.content || "",
      refToBot,
    },
  });

  if (isSelf) return;
  if (msg.author?.bot && getConfig().discord.permissions?.ignoreBots !== false) return;

  // FAQ learning from genuine-looking user questions
  if (!msg.author?.bot && msg.content && msg.content.length > 8 && msg.content.length < 600 &&
      (msg.content.includes("?") || /^(what|why|how|who|where|when|can|should|does|is|are|will|anyone)\b/i.test(msg.content.trim()))) {
    learnQuestion(msg.content, msg.author?.username);
  }

  // channel must be configured
  const channelCfg = (cfg.channels || []).find((ch) => ch.id === msg.channelId);
  if (!channelCfg) return;
  if ((cfg.discord.permissions.blockedUsers || []).includes(msg.author?.id)) return;

  const trimmed = (msg.cleanContent || msg.content || "").trim();
  const isQ = trimmed.endsWith("?") || /^(what|why|how|who|where|when|can|could|should|does|is|are|will|anyone)\b/i.test(trimmed);

  const decision = decide({
    message: {
      authorId: msg.author?.id,
      authorName: msg.author?.username || "",
      bot: !!msg.author?.bot,
      self: false,
      mentionedBot,
      refToBot,
      content: trimmed,
    },
    channelCfg: {
      id: msg.channelId,
      enabled: channelCfg.enabled !== false,
      mode: channelCfg.mode || "off",
      cooldownSeconds: channelCfg.cooldownSeconds,
      maxPerHour: channelCfg.maxPerHour,
      replyChance: channelCfg.replyChance,
    },
    replyCfg: cfg.reply,
    state: getEngineState(),
    random: Math.random(),
  });

  if (!decision.allow) {
    log.info(`[engine] skip #${msg.channel?.name}: ${decision.code} — ${decision.reason}`);
    return;
  }

  const transcriptText = buildTranscript(msg.channelId);
  const memoryFacts = (cfg.memory.facts || []).slice(0, 14).map((f) => f.text);
  const faqEntries = [];
  const hit = matchFaq(trimmed);
  if (hit && (hit.count || 1) > 0 && hit.lastAnswer) {
    faqEntries.push(
      `RECURRING: member asked "${hit.display}" (asked ${hit.count}x before). ` +
      `You already answered: "${String(hit.lastAnswer).slice(0, 160)}". ` +
      `Reply briefly + differently this time — a short reminder, not a repeat.`
    );
  }

  if (!msg.channel.sendTyping) return;
  msg.channel.sendTyping().catch(() => {});

  queueJob({
    kind: "auto",
    channelId: msg.channelId,
    channelName: msg.channel?.name || "",
    guildId: msg.guildId,
    messageCtx: {
      authorId: msg.author?.id,
      authorName: msg.author?.username || "",
      triggerContent: trimmed,
      mentionedBot,
      isQuestion: isQ,
    },
    triggerNorm: normalizeLite(trimmed),
    transcriptText,
    memoryFacts,
    faqEntries,
  });
}

function normalizeLite(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function queueJob(job) {
  if (queue.length >= MAX_QUEUE) {
    audit("reply.queue_full", "Reply queue full — drop", { channel: job.channelName });
    return;
  }
  queue.push(job);
  if (inFlight < MAX_CONCURRENT) drainQueue();
}

async function drainQueue() {
  while (queue.length > 0 && inFlight < MAX_CONCURRENT) {
    const job = queue.shift();
    inFlight += 1;
    try {
      await runJob(job);
    } catch (err) {
      recordFailure(err);
      log.error("[engine] job failed:", err?.message || err);
      audit("reply.failed", err?.message || "job failed", { channel: job.channelName });
    } finally {
      inFlight -= 1;
    }
  }
  if (queue.length > 0) setImmediate(drainQueue);
}

async function runJob({ kind, channelId, channelName, messageCtx, triggerNorm, transcriptText, memoryFacts, faqEntries }) {
  const cfg = getConfig();
  const started = Date.now();

  const draftRes = await generateDraft({ transcriptText, triggerText: messageCtx.triggerContent, memoryFacts, faqEntries });
  if (!draftRes.text) {
    recordFailure(new Error("AI returned empty draft"));
    return;
  }
  if (draftRes.violated) {
    audit("reply.violation", "Draft discarded — hit do-not-say list", { channel: channelName });
    return;
  }

  // approval mode (global or per-channel)
  const approvalMode = cfg.generatedReply.mode === "approval" || channelApproval(channelId);
  if (approvalMode) {
    approvals.enqueueDraft({
      channelId,
      channelName,
      guildId: client?.channels?.cache?.get(channelId)?.guildId,
      authorId: messageCtx.authorId,
      authorName: messageCtx.authorName,
      triggerContent: messageCtx.triggerContent,
      draft: draftRes.text,
      reason: messageCtx.mentionedBot ? "mention" : messageCtx.isQuestion ? "question" : "selective",
    });
    return;
  }

  await sendAiMessage(channelId, draftRes.text, kind, null, {
    latency: Date.now() - started,
    triggerNorm,
  });
  // record what was answered so recurring questions get rephrased next time
  const faqAfter = matchFaq(triggerContent);
  if (faqAfter) rememberAnswer(faqAfter.display || triggerContent, draftRes.text);
}

function channelApproval(channelId) {
  return !!(getConfig().channels || []).find((c) => c.id === channelId)?.approvalMode;
}

// ── sending ──────────────────────────────────────────────────────

function applyAiMarker(text, kind) {
  const cfg = getConfig();
  if (cfg.generatedReply.disclosure === "never") return text;
  if (kind !== "companion") return text;
  const symbol = cfg.generatedReply.markSymbol || "[AI]";
  return `${text} ${symbol}`.trim();
}

export async function sendAiMessage(channelId, text, kind = "companion", draftId = null, extra = {}) {
  const channel = client?.channels?.cache?.get(channelId);
  if (!channel || typeof channel.send !== "function") {
    return { ok: false, err: `Bot has no access to channel ${channelId}` };
  }
  try {
    const out = applyAiMarker(text, kind);
    const msg = await channel.send(out);
    markReplied(channelId, out, extra.triggerNorm || "");
    recordSuccess();
    sendLog.push({
      ts: Date.now(), channelId, channelName: channel.name || "",
      source: kind === "companion" ? "ai-auto" : kind,
      text: out.slice(0, 300), latencyMs: extra.latency || 0,
      draftId,
    });
    audit("reply.sent", `AI replied in #${channel.name}`, { channel: channel.name });
    return { ok: true, id: msg.id };
  } catch (err) {
    recordFailure(err);
    return { ok: false, err: err?.message || "send failed" };
  }
}

/** Approved draft listener from the approvals flow. */
export async function sendApprovedDraft(channelId, text, draftId) {
  const res = await sendAiMessage(channelId, text, "ai-approved", draftId);
  if (res.ok) audit("approval.sent", `Approved draft sent`);
  else audit("approval.send_failed", res.err, {});
  return res;
}

/** Owner-composed (non-AI) message through the bot. Never gets an [AI] mark. */
export async function composeMessage(channelId, text) {
  const channel = client?.channels?.cache?.get(channelId);
  if (!channel || typeof channel.send !== "function") {
    return { ok: false, err: `Bot has no access to channel ${channelId}` };
  }
  try {
    const msg = await channel.send(String(text).slice(0, 2000));
    markReplied(channelId, "", "");
    sendLog.push({ ts: Date.now(), channelId, channelName: channel.name || "", source: "compose", text: String(text).slice(0, 300) });
    audit("compose.sent", `Owner composed message sent to #${channel.name}`);
    return { ok: true, id: msg.id };
  } catch (err) {
    return { ok: false, err: err?.message || "send failed" };
  }
}

export async function testMessage(guildId, channelId, text) {
  return composeMessage(channelId, text || "test message from dashboard");
}

// ── introspection ────────────────────────────────────────────────

export function listCachedGuilds() {
  if (!client) return [];
  return client.guilds.cache.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount ?? null, icon: g.iconURL() || null }));
}

export async function listChannels(guildId, textOnly = true) {
  const g = client?.guilds?.cache?.get(guildId);
  if (!g) return [];
  return g.channels.cache
    .filter((c) => !textOnly || (c.type === ChannelType.GuildText || c.type === ChannelType.PublicThread))
    .map((c) => ({
      id: c.id,
      name: `${c.type === ChannelType.PublicThread ? "-thread " : "#"}${c.name}`,
      type: c.type,
      nsfw: !!c.nsfw,
      parent: c.parentId,
      botPermissions: c.permissionsFor?.(c.guild.me)?.has("SendMessages") === true ? "send" : "none",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveChannelName(channelId) {
  const ch = client?.channels?.cache?.get(channelId);
  return ch?.name || null;
}

export { engineStats as stats };
