/** Views: Overview, Grok engine, Discord link */

import api from "./api.js";
import { el, $, toast, modal, fmtTime, fmtDur, copyText, modeLabel } from "./ui.js";

/* ══ shared helpers ════════════════════════════════════════════════ */

export function card(title, sub, ...children) {
  const c = el("div", { class: "card glass" });
  c.append(
    el("h3", {}, el("span", { class: "icon", text: "◈" }), title),
    sub ? el("div", { class: "sub", text: sub }) : null,
    ...children.filter(Boolean)
  );
  return c;
}

export function tile(k, v, d, cls) {
  return el("div", { class: "tile glass" },
    el("div", { class: "k", text: k }),
    el("div", { class: `v ${cls || ""}`, text: v }),
    d ? el("div", { class: "d", text: d }) : null
  );
}

export function slider(label, min, max, step, value) {
  const taken = parseFloat(value) || 0;
  const out = el("output", { text: String(taken) });
  const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(taken) });
  input.addEventListener("input", () => { out.textContent = input.value; });
  const wrap = el("div", { class: "slider-row" }, el("label", { text: label }), input, out);
  return { el: wrap, get: () => parseFloat(input.value), input, out };
}

export function numberField(label, value, step = 1, min = 0) {
  const input = el("input", { type: "number", value: String(value ?? ""), min: String(min), step: String(step), style: "max-width:220px" });
  const wrap = el("div", { class: "field" }, el("span", { text: label }), input);
  return { el: wrap, get: () => (input.value === "" ? 0 : parseFloat(input.value) || 0), input };
}

export function toggleField(label, checked) {
  const input = el("input", { type: "checkbox", checked: !!checked });
  const lab = el("label", { class: "toggle" }, input, el("span", { class: "tk" }), el("span", { text: label }));
  return { el: lab, get: () => input.checked, input };
}

export function tagEditor(label, items, placeholder) {
  const wrap = el("div", { class: "field" });
  if (label) wrap.append(el("span", { text: label }));
  const holder = el("div", { class: "tags" });
  const values = Array.isArray(items) ? [...items] : [];
  const redraw = () => {
    holder.innerHTML = "";
    values.forEach((v, i) => {
      holder.append(el("span", { class: "tag" }, v, el("button", { text: "✕", on: () => { values.splice(i, 1); redraw(); } })));
    });
  };
  redraw();
  const input = el("input", { type: "text", placeholder });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      e.preventDefault();
      values.push(input.value.trim());
      input.value = "";
      redraw();
    }
  });
  wrap.append(input, holder);
  return { el: wrap, get: () => values, input, redraw };
}

export function statusChip(status, labels) {
  const map = {
    ready: ["ok", "connected"], connecting: ["warn", "connecting…"], reconnecting: ["warn", "reconnecting…"],
    error: ["bad", "error"], stopped: ["warn", "stopped"], not_configured: ["", "not configured"],
  };
  const m = map[status] || ["", status];
  return el("span", { class: `chip ${m[0]}`, text: labels?.[status] || m[1] });
}

const SOURCE_LABEL = {
  "ai-auto": "AI · auto",
  "ai-approved": "AI · you approved",
  "compose": "you · sent via bot",
  "test": "test",
};

/* ══ OVERVIEW ══════════════════════════════════════════════════════ */

export async function renderOverview(host) {
  let dash;
  try { dash = await api.get("/dashboard"); }
  catch (e) { host.append(el("div", { class: "card glass", text: "Failed to load overview: " + e.message })); return; }

  const b = dash.bot;
  const eng = dash.engine;
  const gu = dash.grokUsage?.today || { usd: 0, requests: 0 };
  const rl = dash.config.xai.rateLimit || {};

  if (dash.config.reply.stopped) {
    host.append(el("div", { class: "banner stop" },
      el("b", { text: "🛑 EMERGENCY STOP ACTIVE" }),
      el("span", { text: " — the engine sends nothing and drafts nothing until you resume." })
    ));
  }

  host.append(el("div", { class: "grid tiles" },
    tile("Discord bot", b.status === "ready" ? "online" : b.status, b.user ? `as ${b.user.tag}${b.ping ? ` · ${b.ping}ms` : ""}` : "no token configured", b.status === "ready" ? "ok" : b.status === "error" ? "bad" : "warn"),
    tile("Replies today", String(eng.daily || 0), `${eng.hourly || 0} in the last hour`, eng.daily ? "accent" : ""),
    tile("Approvals waiting", String(dash.approvalsPending || 0), dash.approvalsPending ? "needs your review" : "queue clear", dash.approvalsPending ? "warn" : "ok"),
    tile("Spend today", `$${(gu.usd || 0).toFixed(3)}`, `${gu.requests} calls · cap $${rl.maxDailyCostUsd ?? 5}/day`, (gu.usd || 0) >= (rl.maxDailyCostUsd || 5) ? "bad" : ""),
    tile("Grok engine", dash.config.xai.keyConfigured ? "ready" : "no key", dash.config.xai.model || "—", dash.config.xai.keyConfigured ? "ok" : "bad"),
    tile("Bot uptime", b.status === "ready" ? fmtDur(b.uptimeSec) : "—", eng.breakerOpen ? "circuit breaker OPEN" : "watchdog healthy", eng.breakerOpen ? "bad" : "ok")
  ));

  /* owner controls */
  const estopBtn = el("button", {
    class: `btn ${dash.config.reply.stopped ? "primary" : "danger"}`,
    text: dash.config.reply.stopped ? "▶ Resume replies" : "🛑 Emergency stop",
    on: async () => {
      const next = !dash.config.reply.stopped;
      await api.post("/control/stop", { stopped: next, reason: next ? "owner panel" : "resumed from overview" });
      toast(next ? "Emergency stop engaged — nothing is sent" : "Replies resumed", next ? "warn" : "ok");
      window.refreshView();
    },
  });
  const testBtn = el("button", { class: "btn sm", text: "⚡ Test Grok", on: async () => {
    testBtn.disabled = true;
    try {
      const r = await api.post("/xai/test");
      toast(`Grok OK — ${r.model} · ${r.usageMs}ms · "${(r.sample || "").slice(0, 60)}"`, "ok", 6000);
    } catch (e) { toast(`Test failed: ${e.message}`, "err", 7000); }
    testBtn.disabled = false;
  } });
  const breakerBtn = el("button", { class: `btn sm ${eng.breakerOpen ? "danger" : "ghost"}`, text: eng.breakerOpen ? "⚠ Reset breaker" : "Breaker: ok", disabled: !eng.breakerOpen, on: async () => {
    await api.post("/control/breaker-reset");
    toast("Circuit breaker reset", "ok");
    window.refreshView();
  } });

  host.append(card("Owner controls", "global levers, live from any device", el("div", { class: "row" }, estopBtn, testBtn, breakerBtn)));

  /* outgoing feed */
  const feed = dash.sendHistory?.length
    ? dash.sendHistory.map((s) => {
        const label = SOURCE_LABEL[s.source] || s.source;
        return el("div", { class: "feed-item" },
          el("span", { class: "t", text: fmtTime(s.ts) }),
          el("span", { class: "a", text: `#${s.channelName || s.channelId}` }),
          (s.source === "ai-auto" || s.source === "ai-approved")
            ? el("span", { class: "aisym", text: "AI" }) : null,
          el("span", { style: "min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap", text: s.text.slice(0, 150) }),
          el("span", { class: "tiny muted", style: "margin-left:auto", text: label + (s.latencyMs ? ` · ${s.latencyMs}ms` : "") })
        );
      })
    : [el("div", { class: "tiny muted", text: "Nothing sent yet. Connect Discord → pick channels → the bot takes it from there." })];

  host.append(card("Recent outgoing", "every message this bot account has sent, labeled by origin", el("div", { class: "feed" }, feed)));

  host.append(card("Audit log", "logins, config changes, bot events — server-side only",
    el("div", { class: "feed" }, (dash.audit || []).slice().reverse().slice(0, 20).map((a) =>
      el("div", { class: "feed-item" },
        el("span", { class: "t", text: fmtTime(a.ts) }),
        el("span", { class: "a", text: a.action }),
        el("span", { style: "min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap", text: (a.detail || "").slice(0, 110) })
      )
    ))
  ));
}

/* ══ XAI ENGINE ════════════════════════════════════════════════════ */

export async function renderAI(host) {
  const cfg = await api.get("/xai/status");

  /* key card */
  const keyInput = el("input", { type: "password", placeholder: "xai-xxxxxxxxxxxxxxxx", autocomplete: "off", style: "font-family:var(--mono)" });
  const keyCard = card("xAI API key", "kept only on this server, never exposed to the browser",
    el("div", { class: "stack", style: "max-width:560px" },
      el("label", { class: "field" },
        el("span", { text: cfg.keyConfigured ? `Key configured (ends ${cfg.keyLast4}) — paste a new one to replace` : "Paste your xAI API key" }),
        keyInput
      ),
      el("div", { class: "row" },
        el("button", { class: "btn primary sm", text: cfg.keyConfigured ? "Replace key" : "Save key", on: async () => {
          const v = keyInput.value.trim();
          if (!v) return toast("enter a key first", "warn");
          try {
            await api.put("/xai/key", { key: v });
            keyInput.value = "";
            toast("API key saved server-side", "ok");
            window.refreshView();
          } catch (e) { toast(e.message, "err", 6000); }
        } }),
        cfg.keyConfigured ? el("button", { class: "btn danger sm", text: "Remove", on: async () => {
          if (!confirm("Remove the xAI key? Auto replies stop until a new one is added.")) return;
          await api.del("/xai/key");
          toast("Key removed", "warn");
          window.refreshView();
        } }) : null,
        el("button", { class: "btn sm", text: "⚡ Test connection", on: async () => {
          try {
            const r = await api.post("/xai/test");
            toast(`Connected — ${r.model} · ${r.usageMs}ms · said "${(r.sample || "").slice(0, 60)}"`, "ok", 7000);
          } catch (e) { toast(`Test failed: ${e.message}`, "err", 8000); }
        } })
      )
    )
  );

  /* model + tuning card */
  const modelSelect = el("select");
  const priceLine = el("div", { class: "tiny muted", text: " " });
  const fillModels = async () => {
    modelSelect.innerHTML = "";
    try {
      const r = await api.get("/xai/models");
      const list = r.models || [];
      for (const m of list) {
        const p = m.pricing ? ` · $${m.pricing.in}/$${m.pricing.out} per M tok` : "";
        modelSelect.append(el("option", { value: m.id, text: `${m.label || m.id}${p}`, selected: m.id === cfg.model }));
      }
      if (cfg.model && ![...modelSelect.options].some((o) => o.value === cfg.model)) {
        modelSelect.append(el("option", { value: cfg.model, text: `${cfg.model} (saved)`, selected: true }));
      }
      updatePrice();
    } catch { modelSelect.append(el("option", { value: cfg.model || "grok-4-fast-reasoning", text: cfg.model || "grok-4-fast-reasoning" })); }
  };
  const updatePrice = () => {
    const v = modelSelect.value;
    priceLine.textContent = v.startsWith("grok-4-fast") ? "grok-4-fast: ~$0.20 in / $0.50 out per 1M tokens — cheap enough for constant chat"
      : v.includes("mini") ? "mini tier: very cheap, good for banter"
      : v.includes("grok-3") || v.includes("grok-2") ? "full-size models cost ~$3/$15 per M — watch the daily cap"
      : "";
  };
  modelSelect.addEventListener("change", updatePrice);
  await fillModels();

  const temp = slider("Temperature (creativity)", 0.1, 1, 0.05, cfg.temperature);
  const toks = slider("Max reply length (tokens)", 40, 700, 10, cfg.maxOutputTokens);
  const timeout = slider("Request timeout (s)", 4, 40, 1, Math.round((cfg.requestTimeoutMs || 25000) / 1000));

  const modelCard = card("Model & sampling", "which Grok model replies and how it sounds",
    modelSelect, priceLine, temp.el, toks.el, timeout.el,
    el("button", { class: "btn sm", text: "Save tuning", on: async () => {
      await api.put("/xai/settings", {
        model: modelSelect.value,
        temperature: temp.get(),
        maxOutputTokens: Math.round(toks.get()),
        requestTimeoutMs: Math.round(timeout.get() * 1000),
      });
      toast("Saved — new replies use it", "ok");
    } })
  );

  /* limits card */
  const rl = cfg.rateLimit || {};
  const rpm = numberField("Requests / minute", rl.requestsPerMinute ?? 20);
  const usd = numberField("Daily spend cap ($)", rl.maxDailyCostUsd ?? 5, 0.5);
  const dreq = numberField("Daily request cap", rl.maxDailyRequests ?? 600);
  const limitsCard = card("Spending & rate controls", "hard ceilings — the API refuses calls beyond them, auto-replies pause gracefully",
    rpm.el, usd.el, dreq.el,
    el("button", { class: "btn sm", text: "Save limits", on: async () => {
      await api.put("/xai/limits", { requestsPerMinute: rpm.get(), maxDailyCostUsd: usd.get(), maxDailyRequests: dreq.get() });
      toast("Limits saved", "ok");
    } })
  );

  const usage = (await api.get("/xai/usage")).usage;
  const usageCard = card("Usage today", "computed from API-reported token usage",
    el("div", { class: "grid tiles" },
      tile("Calls", String(usage.today.requests), `${usage.callsLastMinute} in last minute`),
      tile("Est. spend", `$${(usage.today.usd || 0).toFixed(4)}`, "priced per model"),
      tile("Budget used", `${rl.maxDailyCostUsd ? Math.min(100, Math.round(((usage.today.usd || 0) / rl.maxDailyCostUsd) * 100)) : 0}%`, (usage.today.usd || 0) >= (rl.maxDailyCostUsd || 0) ? "capped — replies paused" : "replies running")
    )
  );

  host.append(keyCard, el("div", { class: "grid c2" }, modelCard, limitsCard), usageCard);
}

/* ══ DISCORD ═══════════════════════════════════════════════════════ */

export async function renderDiscord(host) {
  const st = await api.get("/discord/status");
  const bot = st.bot;
  const dashCfg = await api.get("/dashboard").then((d) => d.config.discord).catch(() => ({}));
  bot.permissions = dashCfg.permissions || {};

  /* connection card */
  const tokenInput = el("input", { type: "password", placeholder: "MDEyMzQ1Njc4MTIzNDU2Nzg5…", autocomplete: "off", style: "font-family:var(--mono)" });
  const stack = el("div", { class: "stack" });

  if (!st.tokenConfigured) {
    stack.append(
      el("label", { class: "field" }, el("span", { text: "Discord bot token" }), tokenInput),
      el("div", { class: "note tiny" }, "Developer Portal → your application → Bot → Reset Token. Enable MESSAGE CONTENT INTENT under Bot → Privileged Gateway Intents, or the bot can't read chit-chat."),
      el("button", { class: "btn primary sm", text: "Save token & connect", on: async () => {
        const v = tokenInput.value.trim();
        if (!v) return toast("paste the token first", "warn");
        try {
          await api.put("/discord/token", { token: v });
          toast("Token saved — connecting…", "ok");
          await api.post("/discord/connect").catch((e) => toast(e.message, "err", 6000));
          window.refreshView();
        } catch (e) { toast(e.message, "err", 6000); }
      } })
    );
  } else {
    stack.append(
      el("div", { class: "row" },
        el("button", { class: "btn primary sm", text: bot.status === "ready" ? "♻ Restart" : "▶ Connect", on: async () => {
          try { await api.post("/discord/connect"); toast("Connecting…", "ok"); } catch (e) { toast(e.message, "err", 6000); }
          window.refreshView();
        } }),
        el("button", { class: "btn danger sm", text: "⏸ Disconnect", on: async () => { await api.post("/discord/disconnect"); toast("Bot disconnected (replies pause).", "warn"); window.refreshView(); } }),
        el("button", { class: "btn ghost sm", text: `Remove token (ends ${st.tokenLast4})`, on: async () => {
          if (confirm("Remove the bot token?")) { await api.del("/discord/token"); window.refreshView(); }
        } })
      )
    );
  }

  host.append(card("Bot connection", "your bot account on the official Discord gateway",
    el("div", { class: "row" }, statusChip(bot.status), bot.user ? el("span", { class: "tiny muted", text: `${bot.user.tag}${bot.ping ? ` · ${bot.ping}ms ping` : ""}` }) : null),
    stack
  ));

  /* invite card */
  host.append(card("Add the bot to your server", "pre-scoped invite link (view channels · send messages · read history)",
    bot.inviteUrl
      ? el("div", { class: "row" },
          el("input", { type: "text", value: bot.inviteUrl, style: "flex:1; min-width:220px; font-family:var(--mono); font-size:11px", readOnly: true }),
          el("button", { class: "btn sm", text: "Copy", on: () => copyText(bot.inviteUrl) }),
          el("a", { class: "btn primary sm", href: bot.inviteUrl, target: "_blank", rel: "noopener noreferrer", text: "Invite ↗" })
        )
      : el("div", { class: "tiny muted", text: "Save your bot token above to generate your personal invite link." })
  ));

  /* guilds */
  host.append(card("Servers", "guilds this bot is a member of",
    (bot.guilds || []).length
      ? el("div", { class: "stack" }, bot.guilds.map((g) => el("div", { class: "row between" },
          el("b", { text: `${g.name}${g.connected ? "" : " (offline)"}` }),
          el("span", { class: "tiny muted", text: g.memberCount ? `${g.memberCount} members` : "" })
        )))
      : el("div", { class: "tiny muted", text: "Invite the bot to your server — it shows up here." })
  ));

  /* monitor */
  host.append(card("Connection monitor", "gateway events — disconnects, errors, resyncs",
    el("div", { class: "feed" }, (bot.monitor || []).length
      ? bot.monitor.map((m) => el("div", { class: "feed-item" },
          el("span", { class: "t", text: fmtTime(m.ts) }),
          el("span", { class: "a", text: m.status }),
          el("span", { text: (m.detail || "").slice(0, 100) })
        ))
      : el("div", { class: "tiny muted", text: bot.status === "connecting" || bot.status === "ready" ? "Watching the gateway 24/7…" : "Idle." })
    )
  ));

  /* safety permissions */
  const p = bot.permissions || {};
  const ignoreBots = toggleField("Ignore other bots' messages", p.ignoreBots !== false);
  const blocked = tagEditor("Blocked users (Discord IDs)", p.blockedUsers || [], "enter ID then press Enter");
  host.append(card("Community safety rules", "highest priority — these users never trigger replies", ignoreBots.el, blocked.el,
    el("button", { class: "btn sm", text: "Save safety rules", on: async () => {
      await api.put("/discord/permissions", { ignoreBots: ignoreBots.get(), blockedUsers: blocked.get() });
      toast("Saved", "ok");
      window.refreshView();
    } })
  ));
}
