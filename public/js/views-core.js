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
    tile("AI engine", dash.config.xai.keyConfigured || dash.config.xai.provider === "local" ? "ready" : "add free key",
      `${{ openrouter: "OpenRouter · free", gemini: "Gemini · free", grok: "xAI Grok (paid)", local: "local (free)", custom: "custom" }[dash.config.xai.provider] || "custom"} · ${dash.config.xai.model || "—"}`,
      dash.config.xai.keyConfigured || dash.config.xai.provider === "local" ? "ok" : "warn"),
    tile("Cost today", dash.config.xai.provider === "grok" ? `$${(gu.usd || 0).toFixed(3)}` : "$0",
      dash.config.xai.provider === "grok" ? `${gu.requests} calls · cap $${rl.maxDailyCostUsd ?? 5}/day` : `${gu.requests} calls · free tier`,
      dash.config.xai.provider === "grok" && (gu.usd || 0) >= (rl.maxDailyCostUsd || 5) ? "bad" : "ok"),
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
  const testBtn = el("button", { class: "btn sm", text: "⚡ Test AI", on: async () => {
    testBtn.disabled = true;
    try {
      const r = await api.post("/xai/test");
      toast(`Brain OK — ${r.model} · ${((r.usageMs || 0) / 1000).toFixed(1)}s · "${(r.sample || "").slice(0, 60)}"`, "ok", 6000);
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
  const provider = cfg.provider || "openrouter";
  const isGemini = provider === "gemini";
  const isLocal = provider === "local" || provider === "custom";

  const PRESETS = [
    { id: "openrouter", btn: "🟢 OpenRouter — free key, free models", base: "https://openrouter.ai/api/v1", model: "nvidia/nemotron-3.5-lightning:free", help: "openrouter.ai → sign up free → Keys → create key. Free models include NVIDIA Nemotron 3.5 (the 'flash' one), MiniMax, Gemma." },
    { id: "gemini", btn: "☁ Google Gemini — free key", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", help: "aistudio.google.com/apikey → create free key (no credit card)." },
  ];

  /* ── provider picker rows ──────────────────────────────────────── */
  const providerRow = el("div", { class: "mode-row" });
  for (const p of PRESETS) {
    providerRow.append(el("div", { class: `mode-btn ${provider === p.id ? "on" : ""}`, text: p.btn, on: async () => {
      if (provider === p.id) return;
      try {
        await api.put("/xai/settings", { baseUrl: p.base, model: p.model });
        toast(`${p.id === "gemini" ? "Gemini" : "OpenRouter"} selected — now paste its free key below`, "ok", 5000);
        window.refreshView();
      } catch (e) { toast(e.message, "err", 6000); }
    } }));
  }
  providerRow.append(el("div", { class: `mode-btn ${isLocal ? "on" : ""}`, text: "⚙ custom / advanced", title: "host one yourself (Ollama, vLLM…) or point at any OpenAI-compatible API", on: async () => {
    toast("edit the server URL + model fields below", "ok");
  } }));

  const providerCard = card("Model brain", "free hosted models — a one-time free API key, then $0",
    providerRow,
    el("div", { class: "tiny muted", style: "margin-top:8px", text:
      provider === "openrouter" ? "OpenRouter: ONE free key unlocks dozens of $0 models (Nemotron 3.5, MiniMax, Gemma…). No credit card."
      : isGemini ? "Google's free tier: fast Flash models, generous daily quota, no credit card."
      : "custom endpoint — edited below" })
  );

  /* ── engine card (base URL + model + key + test) ────────────────── */
  const preset = PRESETS.find((p) => p.id === provider);
  const baseInput = el("input", { type: "text", value: cfg.baseUrl || PRESETS[0].base, style: "font-family:var(--mono)" });
  const modelInput = el("input", { type: "text", value: cfg.model || PRESETS[0].model, style: "font-family:var(--mono)" });
  const providerHelp = preset?.help || "any OpenAI-compatible /v1 endpoint works here (Ollama, vLLM, llama.cpp, Groq, Together…)";
  const testBtn = el("button", { class: "btn sm", text: "⚡ Test model", on: async () => {
    testBtn.disabled = true; testBtn.textContent = "thinking…";
    try {
      const r = await api.post("/xai/test");
      toast(`Connected — ${r.model} · ${r.usageMs}ms · said "${(r.sample || "").slice(0, 60)}"`, "ok", 8000);
    } catch (e) { toast(`Test failed: ${e.message}`, "err", 9000); }
    testBtn.disabled = false; testBtn.textContent = "⚡ Test model";
  } });

  const stack = el("div", { class: "stack", style: "max-width:560px" },
    el("div", { class: "note tiny", text: providerHelp }),
    el("label", { class: "field" }, el("span", { text: "Server URL (OpenAI-compatible /v1)" }), baseInput),
    el("label", { class: "field" }, el("span", { text: "Model name" }), modelInput),
  );

  if (!isLocal) {
    const keyInput = el("input", { type: "password", placeholder: isGemini ? "AIza… (free from aistudio.google.com/apikey)" : "sk-or-v1-… (free from openrouter.ai/keys)", autocomplete: "off", style: "font-family:var(--mono)" });
    stack.append(
      el("label", { class: "field" },
        el("span", { text: cfg.keyConfigured ? `API key configured (ends ${cfg.keyLast4}) — paste a new one to replace` : `Paste your free API key (${isGemini ? "Gemini" : "OpenRouter"})` }),
        keyInput
      ),
      el("div", { class: "row" },
        el("button", { class: "btn primary sm", text: cfg.keyConfigured ? "Replace key" : "Save key", on: async () => {
          const v = keyInput.value.trim();
          if (!v) return toast("enter the key first", "warn");
          try {
            await api.put("/xai/key", { key: v });
            keyInput.value = "";
            toast("Key saved server-side", "ok");
            window.refreshView();
          } catch (e) { toast(e.message, "err", 6000); }
        } }),
        cfg.keyConfigured ? el("button", { class: "btn ghost sm danger", text: "Remove key", on: async () => {
          if (!confirm("Remove the API key? Auto replies pause until you add another.")) return;
          await api.del("/xai/key");
          toast("Key removed", "warn");
          window.refreshView();
        } }) : null,
        testBtn
      )
    );
  } else {
    stack.append(el("div", { class: "row" }, el("button", { class: "btn primary sm", text: "Save engine", on: async () => {
      const u = baseInput.value.trim();
      if (!/^https?:\/\/\S+$/.test(u)) return toast("URL must start with http:// or https://", "warn");
      await api.put("/xai/settings", { baseUrl: u, model: modelInput.value.trim() || PRESETS[0].model });
      toast("Engine saved", "ok");
      window.refreshView();
    } }), testBtn));
  }
  const engineCard = card(isLocal ? "Custom engine" : `${isGemini ? "Gemini" : "OpenRouter"} engine`, "key stays on this server, never in the browser", stack);

  /* ── model + tuning card ───────────────────────────────────────── */
  const modelSelect = el("select");
  const priceLine = el("div", { class: "tiny muted", text: " " });
  const fillModels = async () => {
    modelSelect.innerHTML = "";
    try {
      const r = await api.get("/xai/models");
      const list = r.models || [];
      for (const m of list) {
        const p = m.pricing && (m.pricing.in || m.pricing.out) ? ` · $${m.pricing.in}/$${m.pricing.out} per M tok` : m.pricing ? " · free" : "";
        modelSelect.append(el("option", { value: m.id, text: `${m.label || m.id}${p}`, selected: m.id === cfg.model }));
      }
      if (cfg.model && ![...modelSelect.options].some((o) => o.value === cfg.model)) {
        modelSelect.append(el("option", { value: cfg.model, text: `${cfg.model} (saved)`, selected: true }));
      }
      updatePrice();
    } catch { modelSelect.append(el("option", { value: cfg.model || "nvidia/nemotron-3.5-lightning:free", text: cfg.model || "nvidia/nemotron-3.5-lightning:free" })); }
  };
  const updatePrice = () => {
    const v = modelSelect.value;
    priceLine.textContent = v.includes(":free") || v.startsWith("gemini") ? "free tier — $0.00 forever (subject to daily fair-use caps)"
      : v.startsWith("grok-4-fast") ? "~$0.20 in / $0.50 out per 1M tokens"
      : v.startsWith("grok") ? "paid model — watch the daily cap"
      : "";
  };
  modelSelect.addEventListener("change", updatePrice);
  await fillModels();

  const temp = slider("Temperature (creativity)", 0.1, 1, 0.05, cfg.temperature);
  const toks = slider("Max reply length (tokens)", 40, 700, 10, cfg.maxOutputTokens);
  const timeout = slider("Request timeout (s)", 4, 150, 1, Math.round((cfg.requestTimeoutMs || 25000) / 1000));

  const modelCard = card("Model & sampling", "which model replies and how it sounds",
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

  /* rate card */
  const rl = cfg.rateLimit || {};
  const rpm = numberField("Requests / minute", rl.requestsPerMinute ?? 20);
  const dreq = numberField("Daily request cap", rl.maxDailyRequests ?? 600);
  const limitsCard = card("Rate controls", "protects your free quota from spam floods",
    rpm.el, dreq.el,
    el("button", { class: "btn sm", text: "Save limits", on: async () => {
      await api.put("/xai/limits", { requestsPerMinute: rpm.get(), maxDailyRequests: dreq.get() });
      toast("Limits saved", "ok");
    } })
  );

  const usage = (await api.get("/xai/usage")).usage;
  const usageCard = card("Usage today", "calls against your free quota",
    el("div", { class: "grid tiles" },
      tile("Calls", String(usage.today.requests), `${usage.callsLastMinute} in last minute`),
      tile("Cost", "$0.0000", "free models"),
      tile("Budget used", "0%", "replies running")
    )
  );

  host.append(providerCard, el("div", { class: "grid c2" }, engineCard, modelCard), limitsCard, usageCard);
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
