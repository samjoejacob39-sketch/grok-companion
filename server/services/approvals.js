/**
 * Approval queue — AI drafts waiting for owner review.
 * Nothing sends to Discord until the owner approves, edits, or discards each draft.
 */

import { join } from "node:path";
import { readJson, writeJsonDebounced } from "../lib/store.js";
import { DATA_DIR } from "../lib/config.js";
import { audit } from "../lib/audit.js";
import { log } from "../lib/logger.js";

const FILE = join(DATA_DIR, "approvals.json");

const MAX = 80;
let queue = [];
let nextId = 1;

export function initApprovals() {
  const disk = readJson(FILE, { queue: [] });
  queue = (disk.queue || [])
    .filter((d) => d && d.id)
    .sort((a, b) => a.ts - b.ts)
    .slice(-MAX);
  nextId = queue.reduce((mx, d) => Math.max(mx, d.id || 0), 0) + 1;
  log.info(`[approvals] restored ${queue.length} pending drafts`);
}

function persist() {
  writeJsonDebounced(FILE, { queue }, 300);
}

export function enqueueDraft({ channelId, channelName, guildId, guildName, authorId, authorName, triggerContent, draft, reason }) {
  if (!draft || !String(draft).trim()) return null;
  const entry = {
    id: nextId++,
    ts: Date.now(),
    channelId,
    channelName: channelName || channelId,
    guildId,
    guildName: guildName || "",
    authorId,
    authorName: authorName || "",
    triggerContent: String(triggerContent || "").slice(0, 500),
    draft: String(draft).trim().slice(0, 1800),
    status: "pending",
    reason: reason || "",
  };
  queue.push(entry);
  if (queue.filter((d) => d.status === "pending").length > MAX / 2) {
    const old = queue.findIndex((d) => d.status !== "pending");
    if (old >= 0) queue.splice(old, 1);
  }
  audit("approval.enqueue", `Draft queued in ${channelName}`, { channel: channelName });
  persist();
  return entry;
}

export function listDrafts({ status = null, limit = 60 } = {}) {
  const filtered = status ? queue.filter((d) => d.status === status) : queue;
  return filtered.slice(-limit).reverse();
}

export function pendingCount() {
  return queue.filter((d) => d.status === "pending").length;
}

export function getDraft(id) {
  return queue.find((d) => d.id === id && d.status === "pending") || null;
}

export function markSent(id, finalText) {
  const d = queue.find((x) => x.id === id);
  if (!d) return null;
  d.status = "sent";
  d.finalText = String(finalText || d.draft).slice(0, 1800);
  d.resolvedTs = Date.now();
  persist();
  return d;
}

export function markDiscarded(id) {
  const d = queue.find((x) => x.id === id);
  if (!d || d.status !== "pending") return null;
  d.status = "discarded";
  d.resolvedTs = Date.now();
  persist();
  return d;
}

/** update the draft text (owner edits) without resolving */
export function editDraft(id, text) {
  const d = queue.find((x) => x.id === id);
  if (!d || d.status !== "pending") return null;
  d.draft = String(text || "").slice(0, 1800);
  d.edited = true;
  persist();
  return d;
}

export function clearResolved() {
  const before = queue.length;
  queue = queue.filter((d) => d.status === "pending");
  persist();
  return before - queue.length;
}

export const approvalsAPI = { initApprovals, enqueueDraft, listDrafts, pendingCount, getDraft, markSent, markDiscarded, editDraft, clearResolved };
export default approvalsAPI;
