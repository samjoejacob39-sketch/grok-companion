/** tiny DOM helpers + toast + modal */

export function $(sel, root = document) {
  return root.querySelector(sel);
}
export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "on") e.addEventListener("click", v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "checked" || k === "disabled" || k === "selected") e[k] = !!v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

export function icon(svg) {
  const s = el("span", { class: "icon", text: svg });
  return s;
}

export const TOAST_ICON = { ok: "✓", err: "✕", info: "ℹ", warn: "⚠" };

export function toast(msg, kind = "info", ms = 3500) {
  const zone = $("#toasts");
  if (!zone) return;
  const t = el("div", { class: `toast ${kind}` }, el("b", { style: "margin-right:8px;", text: TOAST_ICON[kind] || "•" }), msg);
  zone.append(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity .3s";
    setTimeout(() => t.remove(), 320);
  }, ms);
}

export function modal(content, { title = "", onClose } = {}) {
  const zone = $("#modal-zone");
  zone.innerHTML = "";
  const close = (v) => {
    zone.innerHTML = "";
    onClose && onClose(v);
  };
  const back = el("div", { class: "modal-back" });
  const box = el("div", { class: "modal glass" });
  if (title) box.append(el("h3", { text: title }));
  if (content) box.append(content);
  const closeBtn = el("button", { class: "btn ghost sm", style: "position:absolute; top:10px; right:12px;", text: "✕", on: () => close() });
  back.append(box);
  box.addEventListener("click", (e) => e.stopPropagation());
  back.addEventListener("click", () => close());
  back.append(closeBtn);
  zone.append(back);
  return { close };
}

/* ── formatting ─────────────────────────────────────────────────── */

export function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtClock(ts) {
  if (!ts) return "—";
  return new Date(ts).toTimeString().slice(0, 8);
}

export function fmtDur(sec) {
  if (!sec && sec !== 0) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

export function debounce(fn, ms = 400) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast("copied to clipboard", "ok", 1800)).catch(() => fallbackCopy(text));
  } else fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try { document.execCommand("copy"); toast("copied to clipboard", "ok", 1800); } catch { toast("copy failed", "err"); }
  ta.remove();
}

export function modeLabel(mode) {
  return {
    off: "OFF — never reply",
    mention: "Mention only",
    question: "Questions only",
    selective: "Selective",
    always: "Always",
  }[mode] || mode;
}
