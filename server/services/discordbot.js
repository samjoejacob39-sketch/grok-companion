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
  generateDraft, postProcess, engineStats, getEngineState, MAX_CONCURRENT, resetBreaker,
} from "../lib/engine.js";
import { buildSystemPrompt } from "../lib/persona.js";
import { chatComplete } from "../lib/grok.js";
import { parseDmRequest } from "../lib/dmrelay.js";
import { audit } from "../lib/audit.js";
import { log } from "../lib/logger.js";
import approvals from "./approvals.js";

let client = null;
let membersIntent = false;   // true once login succeeds with the GuildMembers intent
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
  // Administrator (8) — owner asked for full server access on invite
  return `https://discord.com/oauth2/authorize?client_id=${cid}&scope=bot&permissions=8`;
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

  // GuildMembers unlocks full member lists (mass-DM broadcast). If the portal
  // toggle is off, Discord refuses the login — retry without it instead of dying.
  const withMembers = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers];
  const withoutMembers = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];

  for (const intents of [withMembers, withoutMembers]) {
    client = new Client({ intents, partials: [Partials.Channel] });
    wireClient(client);
    try {
      await client.login(token);
      membersIntent = intents === withMembers;
      return client;
    } catch (err) {
      const msg = err?.message || "login failed";
      if (/disallowed intents/i.test(msg) && intents === withMembers) {
        log.warn("[discord] SERVER MEMBERS INTENT is off in the portal — retrying without it (broadcast member lists will be limited until it's enabled: Developer Portal → Bot → Privileged Gateway Intents)");
        try { await client.destroy(); } catch { /* noop */ }
        client = null;
        continue;   // retry with the reduced intent set
      }
      setStatus("error", msg);
      log.error("[discord] login failed:", msg);
      audit("discord.login_error", msg.slice(0, 300));
      try { await client.destroy(); } catch { /* noop */ }
      client = null;
      return null;
    }
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

const seenMessages = new Map();   // id -> ts — hard guard against duplicate processing

function handleMessage(msg) {
  try {
    if (!msg?.id) return;
    if (seenMessages.has(msg.id)) return;
    seenMessages.set(msg.id, Date.now());
    if (seenMessages.size > 500) {
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const [id, ts] of seenMessages) if (ts < cutoff) seenMessages.delete(id);
    }
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

  // explicit command: "dm @user <something>" (with or without pinging the bot) → personal DM relay
  const looksLikeDmCmd = /^dm\b/i.test(trimmed) || /^broadcast\b/i.test(trimmed);
  const dmDirect = looksLikeDmCmd && (/<@!?\d+>/.test(trimmed) || /@everyone\b/i.test(trimmed) || /^dm\s+@\w/i.test(trimmed));
  if ((mentionedBot || dmDirect) && !cfg.reply.stopped && cfg.discord.dmRelay !== false) {
    const dmReq = parseDmRequest({ content: trimmed, botId: botUser?.id });
    if (dmReq) {
      handleDmRequest(msg, dmReq).catch((err) => log.error("[dm] relay failed:", err?.message || err));
      return;   // don't ALSO fire the normal channel reply
    }
    if (mentionedBot && looksLikeDmCmd) {
      msg.channel.send("usage: `@me dm @user <message>` → i'll DM that person privately. for everyone: `@me dm @everyone <message>` (admins only)").catch(() => {});
      return;
    }
  }

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

  // ping the person we're answering (and reply-link their message) when the engagement was theirs
  const shouldPing = decision.mentioned || decision.isQuestion || decision.casual || refToBot;

  queueJob({
    kind: "auto",
    channelId: msg.channelId,
    channelName: msg.channel?.name || "",
    guildId: msg.guildId,
    replyToMessageId: msg.id,
    mentionId: shouldPing ? msg.author?.id : null,
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

async function runJob({ kind, channelId, channelName, messageCtx, triggerNorm, transcriptText, memoryFacts, faqEntries, replyToMessageId, mentionId }) {
  const cfg = getConfig();
  const started = Date.now();
  const typing = startTypingLoop(channelId);

  try {
    const draftRes = await generateDraft({ transcriptText, triggerText: messageCtx.triggerContent, memoryFacts, faqEntries });
    if (!draftRes.text) {
      recordFailure(new Error("AI returned empty draft"));
      return;
    }
    if (draftRes.violated) {
      audit("reply.violation", "Draft discarded — hit do-not-say list", { channel: channelName });
      return;
    }
    // the model decides when silence is the human thing to do
    if (/^\s*\[\[\s*skip\s*\]\]/i.test(String(draftRes.text))) {
      log.info(`[engine] quiet #${channelName}: ai chose not to reply`);
      audit("reply.skip", "Model chose not to reply", { channel: channelName });
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
        reason: messageCtx.mentionedBot ? "mention" : messageCtx.isQuestion ? "question" : "ambient",
      });
      return;
    }

    // humans take a beat to read + type — no instant wall-of-reply feel
    const humanDelay = 800 + Math.floor(Math.random() * 2800);
    await new Promise((r) => setTimeout(r, humanDelay));

    await sendAiMessage(channelId, draftRes.text, "ai-auto", null, {
      latency: Date.now() - started,
      triggerNorm,
      mentionId,
      replyToMessageId,
    });
    // record what was answered so recurring questions get rephrased next time
    const faqAfter = matchFaq(messageCtx.triggerContent);
    if (faqAfter) rememberAnswer(faqAfter.display || messageCtx.triggerContent, draftRes.text);
  } finally {
    typing.stop();
  }
}

/** keeps the "typing…" indicator alive while generation runs (Discord drops it after ~10s) */
function startTypingLoop(channelId) {
  const channel = client?.channels?.cache?.get(channelId);
  if (!channel || typeof channel.sendTyping !== "function") return { stop() {} };
  const timer = setInterval(() => { channel.sendTyping().catch(() => {}); }, 6000);
  channel.sendTyping().catch(() => {});
  return { stop: () => clearInterval(timer) };
}

function channelApproval(channelId) {
  return !!(getConfig().channels || []).find((c) => c.id === channelId)?.approvalMode;
}

// ── DM relay ─────────────────────────────────────────────────────

const dmTracker = new Map();   // requesterId -> { day, count, lastTs }

function dmRelayAllowed(requesterId) {
  const now = Date.now();
  const cfg = getConfig().reply;
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const t = dmTracker.get(requesterId) || { day: dayKey, count: 0, lastTs: 0 };
  if (t.day !== dayKey) { t.day = dayKey; t.count = 0; }
  if (now - t.lastTs < 45_000) return { ok: false, why: "cooldown 45s between DM commands" };
  const cap = getConfig().discord?.dmMaxPerDay ?? 20;
  if (t.count >= cap) return { ok: false, why: `daily DM cap (${cap}) reached` };
  t.lastTs = now; t.count += 1;
  dmTracker.set(requesterId, t);
  return { ok: true };
}

async function resolveDmTarget(msg, req) {
  if (req.targetId) {
    return msg.mentions?.users?.get(req.targetId)
      || client?.users?.cache?.get(req.targetId)
      || await client?.users?.fetch(req.targetId).catch(() => null)
      || null;
  }
  if (req.targetName) {
    // second ping in the same message that isn't the author/bot?
    const other = [...(msg.mentions?.users?.values() || [])].find((u) => u.id !== msg.author?.id && u.id !== client?.user?.id);
    if (other) return other;
    const name = String(req.targetName).toLowerCase();
    const members = await msg.guild?.members.fetch({ query: req.targetName, limit: 8 }).catch(() => null);
    if (!members) return null;
    const list = [...members.values()];
    // prefer the @username handle — only fall back to display name/nickname
    const byUsername = list.find((m) => m.user?.username?.toLowerCase() === name);
    if (byUsername) return byUsername.user;
    const byDisplay = list.find((m) => m.displayName?.toLowerCase() === name);
    return (byDisplay || list[0])?.user || null;
  }
  return null;
}

async function generateDmDraft({ requesterName, targetName, instruction }) {
  const cfg = getConfig();
  const prompt = buildSystemPrompt({
    personality: cfg.personality,
    styleProfile: cfg.styleProfile || {},
    facts: (cfg.memory.facts || []).slice(0, 8).map((f) => f.text),
    faqs: [],
    transcriptText: "",
    triggerText: instruction,
    warning: "",
  });
  const sys = `${prompt}\n\nMODE: PRIVATE DM DELIVERY. Write ONE direct message to ${targetName} on behalf of the community. A member named ${requesterName} asked you to do this: "${instruction}". If it's a joke → make it a short actually-funny one. If it's info → answer briefly and accurately. If it's a hello → greet warmly. ${cfg.reply.stopped ? "" : ""}Keep it 1–2 sentences, casual and lowercase: style matches your personality. No quotes, no role prefixes, no "here's your" meta-talk.`;
  const messages = [{ role: "system", content: sys }, { role: "user", content: "Write the DM text only." }];
  let res = await chatComplete({ messages });
  let out = postProcess(res.content);
  if (!String(out.text || "").trim()) {
    res = await chatComplete({ messages, maxTokens: Math.max((cfg.xai.maxOutputTokens || 800) * 2, 1000) });
    out = postProcess(res.content);
  }
  if (!String(out.text || "").trim()) throw new Error("model produced nothing for the DM");
  return out.text.slice(0, 500);
}

export async function handleDmRequest(msg, req) {
  const requesterId = msg.author?.id;
  const allowed = dmRelayAllowed(requesterId);
  if (!allowed.ok) return;   // silent throttle — no public scolding

  // ── broadcast: "dm @everyone <text>" or "broadcast <text>" — ADMIN ONLY ──
  if (req.broadcast) {
    return broadcastEveryone(msg, req);
  }

  try {
    const target = await resolveDmTarget(msg, req);
    if (!target) {
      msg.channel.send("lo siento, can't figure out who that is — ping them right after the word dm, like: dm @name <thing>").catch(() => {});
      audit("dm.unresolved", "DM target not found", { requester: requesterId });
      return;
    }
    const botUser = client?.user;
    if (target.id === requesterId) {
      msg.channel.send("dm yourself? 😭 here's your message: it is what it is").catch(() => {});
      return;
    }
    if (botUser && target.id === botUser.id) return;

    const instruction = req.instruction || "say hi and drop a quick joke";
    const started = Date.now();
    const text = await generateDmDraft({ requesterName: msg.author?.username || "a member", targetName: target.username || "them", instruction });
    const out = applyAiMarker(text, "dm");
    try {
      await target.send(out);
    } catch (dmErr) {
      msg.channel.send(`tried, but ${target.username}'s DMs are closed 🤷`).catch(() => {});
      audit("dm.closed", `DMs to ${target.tag} are closed`, { requester: requesterId });
      return;
    }
    msg.channel.send(`✅ dm sent to @${target.username || target.tag} privately`).catch(() => {});
    sendLog.push({
      ts: Date.now(), channelId: msg.channelId, channelName: `DM → ${target.username || target.tag}`,
      source: "dm", text: out.slice(0, 300), latencyMs: Date.now() - started, draftId: null,
    });
    audit("dm.sent", `Delivered DM to ${target.tag} for ${msg.author?.username}`, { requester: requesterId });
    recordSuccess();
  } catch (err) {
    recordFailure(err);
    audit("dm.failed", err?.message || "dm relay failed", { requester: requesterId });
    log.error("[dm] relay error:", err?.message || err);
  }
}

/** Admin-only mass DM: "@bot dm @everyone <text>" — delivers verbatim text to every member. */
async function broadcastEveryone(msg, req) {
  const member = msg.member;
  const isAdmin = !!(member?.permissions?.has?.("Administrator") || member?.permissions?.has?.("ManageGuild"));
  if (!isAdmin) {
    msg.channel.send("mass dms are admin-only, sry 🤝").catch(() => {});
    audit("dm.broadcast_denied", "non-admin attempted broadcast", { requester: msg.author?.id });
    return;
  }
  const text = String(req.instruction || "").trim().slice(0, 800);
  if (!text) {
    msg.channel.send("type the message too, like: dm @everyone <your text>").catch(() => {});
    return;
  }
  const guild = msg.guild;
  if (!guild) return;
  if (!membersIntent) {
    msg.channel.send("to mass-DM the whole server, the owner must enable SERVER MEMBERS INTENT first: Developer Portal → Bot → Privileged Gateway Intents → toggle on → restart the bot").catch(() => {});
    audit("dm.broadcast_no_intent", "broadcast attempted without Server Members Intent");
    return;
  }

  msg.channel.send("📬 collecting members… big servers take a bit").catch(() => {});
  try {
    const members = await guild.members.fetch();
    const targets = [...members.values()].filter((m) => !m.user?.bot && m.id !== msg.author?.id);
    const cap = getConfig().discord?.broadcastCap ?? 250;
    const list = targets.slice(0, cap);
    let sent = 0, failed = 0, consecutiveFail = 0;
    for (const m of list) {
      try {
        await m.send(text);
        sent += 1; consecutiveFail = 0;
      } catch {
        failed += 1; consecutiveFail += 1;
        if (consecutiveFail >= 10) {
          audit("dm.broadcast_aborted", "10 consecutive DM failures — stopping");
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 2500));   // pacing — fast mass-DMing gets bots flagged
    }
    sendLog.push({
      ts: Date.now(), channelId: msg.channelId, channelName: `broadcast → ${guild.name}`,
      source: "dm", text: text.slice(0, 200), latencyMs: 0, draftId: null,
    });
    msg.channel.send(`📬 done — delivered to ${sent}${failed ? `, ${failed} unreachable (DMs closed)` : ""}`).catch(() => {});
    audit("dm.broadcast", `Delivered to ${sent}/${list.length} members`, { requester: msg.author?.id });
    recordSuccess();
  } catch (err) {
    msg.channel.send("couldn't fetch the member list — the bot needs the SERVER MEMBERS INTENT enabled (Developer Portal → Bot → Privileged Gateway Intents)").catch(() => {});
    audit("dm.broadcast_failed", err?.message || "broadcast failed");
    log.error("[dm] broadcast error:", err?.message || err);
  }
}

// ── sending ──────────────────────────────────────────────────────

const AI_KINDS = new Set(["companion", "ai-auto", "ai-approved", "dm"]);

function applyAiMarker(text, kind) {
  const cfg = getConfig();
  if (cfg.generatedReply.disclosure === "never") return text;
  if (!AI_KINDS.has(kind)) return text;   // compose/test messages stay unlabeled
  const symbol = cfg.generatedReply.markSymbol || "[AI]";
  return `${text} ${symbol}`.trim();
}

export async function sendAiMessage(channelId, text, kind = "companion", draftId = null, extra = {}) {
  const channel = client?.channels?.cache?.get(channelId);
  if (!channel || typeof channel.send !== "function") {
    return { ok: false, err: `Bot has no access to channel ${channelId}` };
  }
  try {
    let out = applyAiMarker(text, kind);
    // the model prefixes [[ping]] only when a notification is truly needed
    let pingId = null;
    const pingMatch = out.match(/^\s*\[\[\s*ping\s*\]\]\s*/i);
    if (pingMatch) {
      out = out.slice(pingMatch[0].length);
      pingId = extra.mentionId && /^\d+$/.test(String(extra.mentionId)) ? String(extra.mentionId) : null;
    }
    const content = pingId ? `<@${pingId}> ${out}` : out;
    const payload = extra.replyToMessageId
      ? { content, reply: { messageReference: extra.replyToMessageId, failIfNotExists: false } }
      : content;
    const msg = await channel.send(payload);
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

/** Approved draft listener from the approvals flow. Pings the original triggerer. */
export async function sendApprovedDraft(channelId, text, draftId, authorId = null) {
  const res = await sendAiMessage(channelId, text, "ai-approved", draftId, {
    mentionId: authorId && /^\d+$/.test(String(authorId)) ? authorId : null,
  });
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
