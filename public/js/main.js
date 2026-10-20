/** Companion dashboard entry — router, nav, session polling. */

import { api, setUnauthorizedHandler } from "./api.js";
import { el, $, $$, toast, fmtDur } from "./ui.js";
import { renderOverview, renderAI, renderDiscord } from "./views-core.js";
import { renderPersonality, renderContext, renderChannels, renderApprovals, renderLogs, renderSettings } from "./views-config.js";

const VIEWS = {
  overview:     { title: "Overview",        sub: "",               render: renderOverview },
  ai:           { title: "Grok engine",     sub: "xAI API · model · limits",  render: renderAI },
  discord:      { title: "Discord link",    sub: "bot account · guilds · safety", render: renderDiscord },
  personality:  { title: "Personality",     sub: "your voice, learned",       render: renderPersonality },
  context:      { title: "Context",         sub: "memory · FAQ · transcripts", render: renderContext },
  channels:     { title: "Channels",        sub: "watchlist · reply modes",   render: renderChannels },
  approvals:    { title: "Approvals",       sub: "review before it speaks",   render: renderApprovals },
  logs:         { title: "Logs",            sub: "audit trail",               render: renderLogs },
  settings:     { title: "Settings",        sub: "access · data",             render: renderSettings },
};

let current = localStorage.getItem("comp-view") || "overview";
let pollTimer = null;
let approvalsNotice = 0;

setUnauthorizedHandler(() => showLogin());

// ── boot ─────────────────────────────────────────────────────────

async function boot() {
  wireShell();
  const { authenticated, firstRun } = await api.get("/auth/status").catch(() => ({ authenticated: false, firstRun: false }));
  if (authenticated) showMain();
  else showLogin(firstRun);

  // approvals badge + health polling
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const d = await api.get("/dashboard");
      updateHeader(d);
      if (document.getElementById("main-shell") && !document.getElementById("main-shell").classList.contains("hidden")) {
        if (d.approvalsPending !== approvalsNotice) {
          approvalsNotice = d.approvalsPending;
          updateApprovalsPill(d.approvalsPending);
          if (approvalsNotice > 0 && current !== "approvals") {
            toast(`${approvalsPendingText()} — check Approvals`, "info", 4000);
          }
        }
        updateChips(d);
      }
    } catch { /* offline; retry next tick */ }
  }, 8000);
}

function approvalsPendingText() {
  return `${approvalsNotice} draft${approvalsNotice === 1 ? "" : "s"} waiting for your review`;
}

// ── login ────────────────────────────────────────────────────────

function showLogin(firstRun) {
  $("#login-shell").classList.remove("hidden");
  $("#main-shell").classList.add("hidden");
  const note = $("#login-note");
  note.classList.toggle("hidden", !firstRun);
  if (firstRun) {
    note.textContent = "First run: the password you type now becomes the owner password.";
    note.classList.add("login-note-first");
  }
  const foot = $("#login-foot");
  foot.textContent = `${location.host} · self-hosted · keys stay on this server`;
}

async function doLogin(e) {
  e && e.preventDefault();
  const btn = $("#login-btn");
  btn.disabled = true;
  btn.textContent = "verifying…";
  try {
    await api.post("/auth/login", { username: $("#login-user").value.trim(), password: $("#login-pass").value });
    $("#login-pass").value = "";
    showMain();
    toast("welcome back", "ok", 2000);
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Log in";
  }
}

// ── main shell ───────────────────────────────────────────────────

function showMain() {
  $("#login-shell").classList.add("hidden");
  $("#main-shell").classList.remove("hidden");
  $("#sidebar").classList.remove("open");
  location.hash = `#/${current}`;
  render(current);
}

function wireShell() {
  $("#login-form").addEventListener("submit", doLogin);
  $("#btn-stop-server").addEventListener("click", async () => {
    try { await api.post("/auth/logout"); } catch { /* already */ }
    location.reload();
  });
  $("#burger").addEventListener("click", () => $("#sidebar").classList.toggle("open"));

  // nav
  $("#nav").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-view]");
    if (!a) return;
    e.preventDefault();
    go(a.dataset.view);
    $("#sidebar").classList.remove("open");
  });

  window.refreshView = () => render(current);
  window.selectChannel = () => {};
  window.addEventListener("view-refresh", () => render(current));
  window.addEventListener("hashchange", () => {
    const v = (location.hash || "").replace(/^#\/?/, "");
    if (VIEWS[v] && v !== current) go(v, true);
  });
}

function go(view, fromHash = false) {
  if (!VIEWS[view]) view = "overview";
  current = view;
  localStorage.setItem("comp-view", view);
  if (!fromHash) location.hash = `#/${view}`;
  render(view);
}

async function render(view) {
  const v = VIEWS[view] || VIEWS.overview;
  const host = $("#view");
  host.innerHTML = "";
  $("#page-title").textContent = v.title;
  $("#page-sub").textContent = v.sub;
  $$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.view === view));
  host.append(el("div", { class: "tiny muted", text: "loading…" }));
  host.innerHTML = "";
  try {
    await v.render(host);
  } catch (err) {
    if (String(err.message) === "logged out") return;
    host.innerHTML = "";
    host.append(el("div", { class: "card glass" },
      el("h3", { text: "couldn't load this page" }),
      el("div", { class: "tiny muted", text: err.message || String(err) })
    ));
  }
}

// ── header chips ─────────────────────────────────────────────────

function updateChips(d) {
  const bot = $("#chip-bot");
  const map = {
    ready: [ "", "bot online" ],
    connecting: [ "warn", "bot connecting" ],
    reconnecting: [ "warn", "bot reconnecting" ],
    error: [ "bad", "bot error" ],
    stopped: [ "warn", "bot stopped" ],
    not_configured: [ "", "bot not configured" ],
  };
  const m = map[d.bot?.status] || ["", d.bot?.status || ""];
  bot.className = `chip ${m[0]}`;
  bot.textContent = m[1];

  const stop = $("#chip-stop");
  stop.classList.toggle("hidden", !d.config.reply.stopped);

  const ok = $("#chip-ok");
  const breaker = d.engine?.breakerOpen;
  ok.classList.toggle("hidden", !!breaker || !!d.config.reply.stopped);
  if (breaker) { ok.classList.remove("hidden"); ok.className = "chip bad"; ok.textContent = "circuit breaker open"; }
  else if (!d.config.reply.stopped) { ok.className = "chip ok"; ok.textContent = "healthy"; }
}

function updateHeader(d) {
  $("#brand-sub").textContent = d.config.reply.stopped ? "stopped" : `${d.bot?.status || "offline"} · ${d.config.xai.model || "no model"}`;
}

function updateApprovalsPill(n) {
  const pill = $("#pill-approvals");
  if (!pill) return;
  pill.classList.toggle("hidden", !n);
  pill.textContent = String(n);
}

boot().catch((err) => {
  console.error(err);
  toast("boot failed — " + err.message, "err", 10_000);
});
