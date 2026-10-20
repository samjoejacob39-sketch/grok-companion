/** Views: Personality, Context, Channels, Approvals, Logs, Settings */

import api from "./api.js";
import { card, tile, slider, numberField, toggleField, tagEditor } from "./views-core.js";
import { el, $, toast, modal, fmtTime, fmtDur, copyText, modeLabel } from "./ui.js";

/* ══ PERSONALITY ═══════════════════════════════════════════════════ */

export async function renderPersonality(host) {
  const data = await api.get("/personality");
  const p = data.settings;

  const nameInput = el("input", { type: "text", value: p.identityName || "", placeholder: "e.g. your in-game name people call you" });
  const hintInput = el("input", { type: "text", value: p.identityHint || "", placeholder: "e.g. 'I run the server, I main jungle, I'm blunt but friendly'" });
  const promptBox = el("textarea", { style: "min-height:110px", placeholder: "Extra standing rules: opinions to always hold, topics to avoid, how you greet people…"   });
  promptBox.value = p.systemPrompt || "";

  const profile = data.styleProfile || {};

  const profCard = card("Your writing style", "derived from real messages you upload — the backbone of style matching",
    data.examplesCount
      ? el("div", { class: "prof-grid" },
          el("div", { class: "prof-cell" }, el("div", { class: "k", text: "examples" }), el("div", { class: "v", text: String(data.examplesCount) })),
          el("div", { class: "prof-cell" }, el("div", { class: "k", text: "avg words" }), el("div", { class: "v", text: profile.avgWords?.toFixed?.(1) ?? "—" })),
          el("div", { class: "prof-cell" }, el("div", { class: "k", text: "lowercase" }), el("div", { class: "v", text: profile.lowercaseRatio != null ? `${Math.round(profile.lowercaseRatio * 100)}%` : "—" })),
          el("div", { class: "prof-cell" }, el("div", { class: "k", text: "periods at end" }), el("div", { class: "v", text: profile.endPunctRatio != null ? `${Math.round(profile.endPunctRatio * 100)}%` : "—" })),
          el("div", { class: "prof-cell" }, el("div", { class: "k", text: "emoji habit" }), el("div", { class: "v", text: profile.emojiRate != null ? `${Math.round(profile.emojiRate * 100)}%` : "—" })),
          el("div", { class: "prof-cell" }, el("div", { class: "k", text: "questions asked" }), el("div", { class: "v", text: profile.questionRate != null ? `${Math.round(profile.questionRate * 100)}%` : "—" })),
          profile.emojiRate === undefined ? null : el("div", { class: "prof-cell", style: "grid-column:1/-1" }, el("div", { class: "k", text: "favourite / trending words & emojis" }), el("div", { class: "tiny", style: "margin-top:4px", text: `${(profile.topWords || []).slice(0, 14).join(" · ")}${(profile.topEmojis || []).length ? "   " + profile.topEmojis.slice(0, 8).join(" ") : ""}` })),
        )
      : el("div", { class: "tiny muted", text: "No examples yet — paste some of your own messages below and the profile builds itself." })
  );

  /* example importer */
  const importBox = el("textarea", { style: "min-height:130px", placeholder: "one message per line (paste how you actually write)…\n\nlol nah\nwait what kinda server wipes on a sunday??\nbro the drop rate is cooked fr" });
  const fileInput = el("input", { type: "file", accept: ".txt,.text,.csv,.log", style: "display:none" });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { importBox.value = String(r.result || ""); toast(`loaded ${f.name}`, "ok", 2000); };
    r.readAsText(f);
  });

  const uploadBtn = el("button", { class: "btn sm", text: "⇪ Upload .txt", on: () => fileInput.click() });

  profCard.append(el("div", { class: "stack" },
    importBox,
    el("div", { class: "row" },
      uploadBtn,
      el("button", { class: "btn sm", text: "just analyze", on: async () => {
        if (!importBox.value.trim()) return toast("paste messages first", "warn");
        const r = await api.post("/personality/analyze", { raw: importBox.value });
        if (r.found && r.profile) {
          toast(`${r.found} examples · avg ${r.profile.avgWords} words · ${Math.round(r.profile.lowercaseRatio * 100)}% lowercase · avg ${r.profile.avgChars} chars`, "ok", 6000);
        } else {
          toast("couldn't extract any messages", "warn");
        }
      } }),
      el("button", { class: "btn primary sm", text: "Import & retrain style", on: async () => {
        if (!importBox.value.trim()) return toast("paste messages first", "warn");
        try {
          const r = await api.post("/personality/examples", { raw: importBox.value });
          toast(`imported ${r.added} — ${r.total} total style examples`, "ok");
          importBox.value = "";
          window.refreshView();
        } catch (e) { toast(e.message, "err"); }
      } }),
      data.examplesCount ? el("button", { class: "btn ghost sm danger", text: "clear dataset", on: async () => {
        if (confirm(`Delete all ${data.examplesCount} style examples?`)) {
          await api.del("/personality/examples");
          toast("style dataset cleared", "warn");
          window.refreshView();
        }
      } }) : null
    ),
    el("div", { class: "tiny muted", text: "Chat exports work too: name-prefixed lines get cleaned automatically." }),
    fileInput
  ));

  /* sliders + toggles */
  const words = slider("Reply length target (words)", 5, 80, 5, p.maxWords ?? 35);
  const slangLvl = slider("Slang intensity", 0, 5, 1, p.slangLevel ?? 3);
  const humor = slider("Humor / banter", 0, 3, 1, p.humorLevel ?? 2);
  const lower = toggleField("always lowercase (like your messages)", p.lowercase);
  const noPunct = toggleField("skip end-of-message punctuation", p.noPunctuation);
  const gaming = toggleField("gaming/PC vocabulary", p.gamingTerms);
  const reactions = toggleField("context-aware reactions (hype, empathize, curse at drops)", p.reactionGuidance);

  const tunerCard = card("Voice tuning", "fine-grained sliders layered on top of the learned profile",
    words.el, slangLvl.el, humor.el,
    el("div", { class: "stack" }, lower.el, noPunct.el, gaming.el, reactions.el),
    el("div", { class: "field" }, el("span", { text: "identity name (how friends know you)" }), nameInput),
    el("div", { class: "field" }, el("span", { text: "persona hint (any context the AI should keep in mind)" }), hintInput),
    el("div", { class: "field" }, el("span", { text: "standing system prompt (highest priority)" }), promptBox),
    el("button", { class: "btn primary sm", text: "Save voice settings", on: async () => {
      await api.put("/personality", {
        identityName: nameInput.value, identityHint: hintInput.value, systemPrompt: promptBox.value,
        maxWords: words.get(), slangLevel: slangLvl.get(), humorLevel: humor.get(),
        lowercase: lower.get(), noPunctuation: noPunct.get(), gamingTerms: gaming.get(), reactionGuidance: reactions.get(),
      });
      toast("Voice saved", "ok");
    } })
  );

  /* do-not-say + glossary */
  const dns = tagEditor("Never say these (phrase list)", p.doNotSay || [], "e.g. 'my other account' + Enter");
  const glossRows = el("div", { class: "stack" });
  const gloss = Object.entries(p.glossary || {});
  const glossState = gloss.map(([k, v]) => ({ k, v }));
  redrawGloss();

  function redrawGloss() {
    glossRows.innerHTML = "";
    for (const [i, row] of glossState.entries()) {
      const k = el("input", { value: row.k, placeholder: "word to replace", style: "flex:1" });
      const v = el("input", { value: row.v, placeholder: "your preferred word", style: "flex:1" });
      k.addEventListener("input", () => row.k = k.value);
      v.addEventListener("input", () => row.v = v.value);
      glossRows.append(el("div", { class: "row" }, k, v, el("button", { class: "btn ghost sm", text: "✕", on: () => { glossState.splice(i, 1); redrawGloss(); } })));
    }
    glossRows.append(el("button", { class: "btn ghost sm", text: "+ preferred word", on: () => { glossState.push({ k: "", v: "" }); redrawGloss(); } }));
  }

  const valuesCard = card("Vocabulary control", "your exact vocabulary — preferred terms + hard no-phrases",
    dns.el, el("div", { class: "field" }, el("span", { text: "preferred words (applied to every reply)" }), glossRows),
    el("button", { class: "btn sm", text: "Save vocabulary", on: async () => {
      const glossary = {};
      for (const r of glossState) if (r.k.trim() && r.v.trim()) glossary[r.k.trim()] = r.v.trim();
      await api.put("/personality", { doNotSay: dns.get(), glossary });
      toast("Vocabulary saved", "ok");
      window.refreshView();
    } })
  );

  /* sandbox */
  const sandboxBox = el("textarea", { style: "min-height:80px", placeholder: "FAKE conversation to preview against…\n\nuser: yo you up? who won last night\nuser2: nah bruh we got stomped" });
  const sandboxTrigger = el("input", { type: "text", placeholder: "the actual message that should trigger the reply" });
  const out = el("div", { class: "draft-trigger", style: "display:none" });

  const previewBtn = el("button", { class: "btn sm", text: "▶ generate sandbox reply", on: async () => {
    const btn = previewBtn;
    btn.disabled = true;
    btn.textContent = "thinking…";
    try {
      const r = await api.post("/personality/preview", { fakeTranscript: sandboxBox.value, note: sandboxTrigger.value });
      out.style.display = "";
      out.textContent = r.draft || "(empty)";
      if (r.violated) toast("careful: draft hit a do-not-say phrase", "warn");
    } catch (e) { toast(e.message, "err", 6000); }
    btn.disabled = false;
    btn.textContent = "▶ generate sandbox reply";
  } });

  const sandboxCard = card("Sandbox (Sends NOTHING)", "run the exact reply-generation pipeline against a fake channel — pure preview",
    el("div", { class: "note tiny" }, "Perfect for checking the voice before you let it loose. Uses the identity, sliders, learned style and memory — no Discord send."),
    sandboxBox, sandboxTrigger, previewBtn, out
  );

  host.append(profCard, el("div", { class: "grid c2" }, tunerCard, valuesCard), sandboxCard);
}

function analyzeToCells(profile) {
  return profile?.avgWords ?? "";
}
void analyzeToCells;

/* ══ CONTEXT ═══════════════════════════════════════════════════════ */

export async function renderContext(host) {
  const m = await api.get("/memory");
  const memToggle = toggleField("Memory injection enabled", m.enabled);
  memToggle.input.addEventListener("change", async () => {
    await api.put("/memory/settings", { enabled: memToggle.get() });
    toast("memory " + (memToggle.get() ? "on" : "off"), "ok");
  });

  const factsCard = card("Approved community memory", "facts the AI may naturally weave in (owner-approved only)",
    el("div", { class: "stack" }, (m.facts || []).map((f) => el("div", { class: "row between" },
      el("div", { text: f.text }),
      el("button", { class: "btn ghost tiny", text: "✕", on: async () => { await api.del(`/memory/facts/${f.id}`); window.refreshView(); } })
    )) || [el("span", { class: "tiny muted", text: "no facts yet" })]),
    el("div", { class: "row", style: "margin-top:10px" },
      el("input", { id: "fact-text", type: "text", placeholder: "e.g. 'wipes are thursdays 20:00 EU', 'ravioli is the glitch hacker'", style: "flex:1; min-width:180px", onkeydown: (e) => { if (e.key === "Enter") addFact(); } }),
      el("button", { class: "btn sm primary", id: "fact-add", text: "add fact", on: addFact })
    )
  );

  async function addFact() {
    const v = $("#fact-text", host).value.trim();
    if (!v) return;
    try {
      await api.post("/memory/facts", { text: v });
      $("#fact-text", host).value = "";
      toast("fact locked in", "ok");
      window.refreshView();
    } catch (e) { toast(e.message, "err"); }
  }

  /* FAQ table */
  const faq = m.faqs || [];
  const faqCard = card("Recurring questions", "auto-detected repeats — so the bot never sounds like a broken record",
    faq.length
      ? el("table", { class: "tbl" },
          el("thead", {}, el("tr", {}, th("question"), th("asked"), th("last answer given"), th(""))),
          el("tbody", {}, faq.map((f) => el("tr", {},
            el("td", { style: "max-width:280px", text: f.display }),
            el("td", { text: `×${f.count}`, class: f.count > 1 ? "warn-text" : "" }),
            el("td", { style: "max-width:280px", text: f.lastAnswer ? f.lastAnswer.slice(0, 90) : "—" }),
            el("td", {}, el("button", { class: "btn ghost tiny", text: "tell me what to say", on: () => answerFaq(f.display) }))
          )))
        )
      : el("div", { class: "tiny muted", text: "None seen yet. When community members ask the same thing more than once, it shows up here — the engine then rephrases instead of repeating." }),
  );

  async function answerFaq(questionText) {
    const answer = prompt(`What should the bot remember for "${questionText}"?`, "keep it brief — words you'd use");
    if (!answer) return;
    await api.post("/memory/faqs/answer", { question: questionText, answer });
    toast("answer saved — future replies to this question will vary, not repeat", "ok");
    window.refreshView();
  }

  /* transcript inspector */
  const channels = m.channels || [];
  const sel = el("select", { style: "max-width:280px" });
  for (const c of channels) sel.append(el("option", { value: c.id, text: `#${c.name || c.id} (${c.count})` }));
  const outBox = el("div", { class: "mono", style: "margin-top:10px; background:rgba(0,0,0,.35); border:1px solid rgba(255,255,255,.06); border-radius:10px; padding:12px; max-height:330px; overflow:auto; white-space:pre-wrap; font-size:11.5px" });
  const inspect = async () => {
    const id = sel.value;
    if (!id) return;
    const r = await api.get(`/memory/context?channelId=${encodeURIComponent(id)}`);
    outBox.textContent = r.transcript || "(no context recorded — enable the bot in this channel)";
  };
  sel.addEventListener("change", inspect);
  if (channels.length) inspect();

  const ctxCard = card("Context inspector", "exactly what the model sees for a channel — rolling last-N transcript",
    channels.length
      ? el("div", { class: "row" }, sel,
          el("button", { class: "btn sm", text: "refresh", on: inspect }),
          el("button", { class: "btn sm danger", text: "wipe this channel's memory", on: async () => {
            if (confirm("Clear cached transcript for this channel?")) {
              await api.del(`/memory/context?channelId=${encodeURIComponent(sel.value)}`);
              toast("cleared", "warn");
              window.refreshView();
            }
          } })
        )
      : el("div", { class: "tiny muted", text: "The bot records context only in channels it's configured for." }),
    outBox
  );

  host.append(el("div", { class: "row" }, memToggle.el),
    el("div", { class: "grid c2" }, factsCard, faqCard), ctxCard);
}

function th(text) { return el("th", { text }); }

/* ══ CHANNELS ══════════════════════════════════════════════════════ */

export async function renderChannels(host) {
  const data = await api.get("/channels");
  const reply = data.reply;
  const channels = data.channels || [];

  /* global rules card */
  const cd = numberField("Per-channel cooldown (s)", reply.cooldownSeconds ?? 180);
  const gcd = numberField("Global cooldown (s)", reply.globalCooldownSeconds ?? 30);
  const mph = numberField("Max replies / channel / hour", reply.maxPerChannelHour ?? 12);
  const day = numberField("Max replies / day (all channels)", reply.maxDailyReplies ?? 200);
  const dupWin = numberField("Duplicate window (h)", reply.duplicateWindowHours ?? 36);
  const chance = slider("Selective mode reply chance (%)", 0, 100, 5, Math.round((reply.selectiveProbability ?? 0.25) * 100));
  const kws = tagEditor("Blocked keywords (never engage)", reply.blockedKeywords || [], "e.g. giveaway links");

  const globalCard = card("Global reply rules", "applied everywhere, on top of per-channel settings",
    cd.el, gcd.el, mph.el, day.el, dupWin.el, chance.el, kws.el,
    el("button", { class: "btn primary sm", text: "Save global rules", on: async () => {
      await api.put("/reply", {
        cooldownSeconds: cd.get(), globalCooldownSeconds: gcd.get(),
        maxPerChannelHour: mph.get(), maxDailyReplies: day.get(),
        duplicateWindowHours: dupWin.get(),
        selectiveProbability: chance.get() / 100,
        blockedKeywords: kws.get(),
      });
      toast("Global rules saved", "ok");
    } })
  );

  /* per-channel config */
  const chansCard = card("Channel watchlist", "exactly where the companion is allowed to exist",
    channels.length
      ? el("div", { class: "stack" }, channels.map((c) => channelRow(c)))
      : el("div", { class: "tiny muted", text: "No channels configured. Open Discord → connect the bot → browse channels to configure them." })
  );

  function channelRow(c) {
    const box = el("div", { class: "card", style: "background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.07) " });
    const modeRow = el("div", { class: "mode-row" });
    const modes = [
      ["off", "OFF"], ["mention", "Mention only"], ["question", "Questions only"],
      ["selective", "Selective"], ["always", "Always"],
    ];
    for (const [value, label] of modes) {
      modeRow.append(el("div", { class: `mode-btn ${c.mode === value ? "on" : ""}`, text: label, on: async (ev) => {
        await api.put(`/channels/${c.id}`, { mode: value, name: c.name, guildId: c.guildId });
        toast(`${c.name} → ${label}`, "ok");
        window.refreshView();
      } }));
    }
    const approvalT = el("div", { class: `mode-btn ${c.approvalMode ? "on" : ""}`, text: "✉ approval queue", on: async () => {
      await api.put(`/channels/${c.id}`, { approvalMode: !c.approvalMode });
      toast(c.approvalMode ? `${c.name} → auto-send restored` : `${c.name} → drafts need your approval`, "ok");
      window.refreshView();
    } });

    box.append(
      el("div", { class: "row between" }, el("b", { text: `#${c.name || c.id}` }), el("span", { class: `tiny ${c.enabled ? "ok-text" : "bad-text"}`, text: c.enabled ? "watching" : "disabled" })),
      modeRow, approvalT,
      el("div", { class: "tiny muted", style: "margin-top:4px", text: c.systemHint ? `custom hint: ${c.systemHint}` : "" })
    );
    return box;
  }

  host.append(el("div", { class: "grid c2" }, globalCard, chansCard));
}

/* ══ APPROVALS ═════════════════════════════════════════════════════ */

export async function renderApprovals(host) {
  const cfg = (await api.get("/dashboard")).config.generatedReply;
  const list = await api.get("/approvals?status=pending");

  const settingsCard = card("Reply pipeline", "who sends what, and how AI is labeled",
    el("div", { class: "mode-row" },
      el("div", { class: `mode-btn ${cfg.mode !== "approval" ? "on" : ""}`, text: "⚡ automatic (bot sends)", on: async () => {
        await api.put("/generated", { mode: "auto" });
        toast("automatic mode — bot sends directly", "ok");
        window.refreshView();
      } }),
      el("div", { class: `mode-btn ${cfg.mode === "approval" ? "on" : ""}`, text: "✉ approval (you review all)", on: async () => {
        await api.put("/generated", { mode: "approval" });
        toast("approval mode — every reply waits for you", "ok");
        window.refreshView();
      } }),
    ),
    el("div", { class: "tiny muted", style: "margin: 8px 0", text: "approval mode = every reply lands here first; you decide. automatic = bot posts directly (still labeled, limited by cooldowns/rates)." }),
    disclosurePicker(cfg)
  );

  function disclosurePicker(c) {
    const disc = c.disclosure || "auto";
    const sym = el("input", { id: "mark-symbol", type: "text", value: c.markSymbol || "[AI]", style: "max-width:90px", title: "marker symbol" });
    sym.addEventListener("change", async () => {
      await api.put("/generated", { markSymbol: sym.value });
      toast("symbol saved", "ok");
    });
    const row = el("div", { class: "row" }, el("span", { class: "tiny muted", text: "AI label on bot-posted replies:" }));
    for (const v of ["auto", "always", "never"]) {
      row.append(el("div", { class: `mode-btn ${disc === v ? "on" : ""}`, text: v, on: async () => {
        await api.put("/generated", { disclosure: v });
        toast("AI label rule updated", "ok");
        window.refreshView();
      } }));
    }
    row.append(sym);
    return row;
  }

  const draftsCard = card(`Pending drafts (${list.pending})`, "your review desk — nothing reaches Discord until you act",
    list.drafts?.length
      ? el("div", { class: "stack" }, list.drafts.map((d) => draftRow(d)))
      : el("div", { class: "tiny muted", text: "Empty. The bot generates drafts automatically when approval mode is on — or hand-draft one below." })
  );

  const chans = (await api.get("/dashboard")).config.channels || [];
  if (chans.length) {
    const pick = el("select");
    for (const c of chans) pick.append(el("option", { value: c.id, text: `#${c.name || c.id}` }));
    const focus = el("input", { type: "text", placeholder: "optional: what to answer / focus on", style: "max-width:260px" });
    draftsCard.append(el("div", { class: "row", style: "margin-top:12px" }, pick, focus,
      el("button", { class: "btn sm", text: "＋ hand-draft a reply", on: async () => {
        try {
          await api.post("/approvals/generate", { channelId: pick.value, channelName: (chans.find((c) => c.id === pick.value) || {}).name, focus: focus.value });
          toast("draft queued for your review", "ok");
          window.refreshView();
        } catch (e) { toast(e.message, "err", 6000); }
      } })
    ));
  }

  host.append(el("div", { class: "grid c2" }, settingsCard, draftsCard));
}

function draftRow(d) {
  const box = el("div", { class: "draft-card" });
  const ta = el("textarea", { style: "min-height:60px" });
  ta.value = d.draft;

  const sendBtn = el("button", { class: "btn primary sm", text: "Send via bot (labeled [AI])", on: async () => {
    try {
      await api.post(`/approvals/${d.id}/send`, { text: ta.value });
      toast("sent through the bot", "ok");
      window.refreshView();
    } catch (e) { toast(e.message, "err", 6000); }
  } });

  const selfBtn = el("button", { class: "btn sm", text: "I'll send it myself", on: async () => {
    const r = await api.post(`/approvals/${d.id}/send-self`, { text: ta.value });
    copyText(r.text);
    if (r.jump) window.open(r.jump, "_blank", "noopener noreferrer");
    toast("clean text copied (no AI label) — Discord opened; paste from your own account", "ok", 7000);
    window.refreshView();
  } });

  const discardBtn = el("button", { class: "btn ghost sm danger", text: "Discard", on: async () => {
    await api.post(`/approvals/${d.id}/discard`);
    toast("dropped", "warn", 2000);
    window.refreshView();
  } });

  box.append(
    el("div", { class: "draft-meta" },
      el("b", { text: `#${d.channelName}` }),
      el("span", { text: fmtTime(d.ts) }),
      d.reason ? el("span", { class: "chip", text: d.reason }) : null,
      el("span", { text: `· reply to ${d.authorName || "channel"}` })
    ),
    el("div", { class: "draft-trigger", text: `↩ "${d.triggerContent.slice(0, 160)}"` }),
    ta,
    el("div", { class: "row" }, sendBtn, selfBtn, discardBtn)
  );
  return box;
}

/* ══ LOGS ══════════════════════════════════════════════════════════ */

export async function renderLogs(host) {
  const a = (await api.get("/audit?limit=250")).entries;
  const tbl = el("table", { class: "tbl" },
    el("thead", {}, el("tr", {}, th("time"), th("action"), th("detail"))),
    el("tbody", {}, a.slice().reverse().map((e) => el("tr", {},
      el("td", { class: "mono tiny", text: new Date(e.ts).toLocaleTimeString() }),
      el("td", { text: e.action, class: e.action.startsWith("error") || e.action.includes("fail") ? "bad-text" : "" }),
      el("td", { style: "max-width:480px", text: e.detail || "" })
    )))
  );
  host.append(card("Audit trail", "everything the server logged, newest first", el("div", { style: "max-height:65vh; overflow:auto" }, tbl)));
}

/* ══ SETTINGS ══════════════════════════════════════════════════════ */

export async function renderSettings(host) {
  const dash = await api.get("/dashboard");
  const cfg = dash.config;

  const pwCard = card("Dashboard password", "change the login password; all other sessions get kicked",
    (() => {
      const cur = el("input", { type: "password", placeholder: "current password" });
      const next = el("input", { type: "password", placeholder: "new password (min 8 chars)" });
      const btn = el("button", { class: "btn sm primary", text: "Change password", on: async () => {
        try {
          await api.post("/auth/password", { current: cur.value, next: next.value });
          toast("password changed — log in again", "ok");
          setTimeout(() => location.reload(), 1200);
        } catch (e) { toast(e.message === "password must be at least 8 characters" ? "min 8 characters" : e.message, "err"); }
      } });
      return el("div", { class: "stack", style: "max-width:400px" }, cur, next, btn);
    })()
  );

  const dataCard = card("Data management", "context, FAQ memory, engine state, backup",
    el("div", { class: "row" },
      el("button", { class: "btn sm danger", text: "Wipe cached context (all channels)", on: async () => {
        if (!confirm("Erase all cached channel transcripts?")) return;
        await api.del("/memory/context");
        toast("context wiped", "warn");
      } }),
      el("button", { class: "btn sm danger", text: "Clear FAQ memory", on: async () => {
        if (!confirm("Delete all learned recurring questions?")) return;
        await api.del("/memory/faqs");
        toast("FAQ cleared", "warn");
      } }),
      el("button", { class: "btn sm", text: "Reset engine rate-state", on: async () => {
        await api.post("/control/reset-state");
        toast("cooldowns/counters reset", "ok");
      } }),
      el("button", { class: "btn sm", text: "Download config backup", on: async () => {
        const r = await api.post("/control/backup");
        toast(`saved server-side: ${r.file}`, "ok", 5000);
      } }),
    )
  );

  const seedCard = card("Configuration summary", "what's live right now",
    el("div", { class: "grid tiles" },
      tile("xAI key", cfg.xai.keyConfigured ? "configured" : "missing", cfg.xai.keyConfigured ? `ends ${cfg.xai.keyLast4}` : "add in Grok page", cfg.xai.keyConfigured ? "ok" : "bad"),
      tile("Discord token", cfg.discord.tokenConfigured ? "configured" : "missing", cfg.discord.tokenConfigured ? `ends ${cfg.discord.tokenLast4}` : "add in Discord page", cfg.discord.tokenConfigured ? "ok" : "bad"),
      tile("Model", cfg.xai.model, cfg.personality.lowercase ? "lowercase · style-guided" : "mixed case style", "accent"),
      tile("Channels", String((cfg.channels || []).length), "under active engine", "accent"),
      tile("Style examples", String((await api.get("/personality")).examplesCount), "learned messages", "accent"),
      tile("Facts", String((cfg.memory.facts || []).length), "approved memory", "accent"),
    )
  );

  const dangerCard = card("Session", "log out of every device",
    el("div", { class: "row" },
      el("button", { class: "btn danger sm", text: "Log out ALL sessions", on: async () => {
        await api.post("/auth/logout-all");
        location.reload();
      } })
    )
  );

  host.append(seedCard, el("div", { class: "grid c2" }, pwCard, dataCard), dangerCard);
}

export const configViews = { renderPersonality, renderContext, renderChannels, renderApprovals, renderLogs, renderSettings };
