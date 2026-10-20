/** Persistence helpers — atomic JSON writes with debounce; safe on Windows & Linux. */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

const pending = new Map();

export function mkdirp(pathStr) {
  mkdirSync(pathStr, { recursive: true });
}

/**
 * Read a JSON file with graceful fallback.
 */
export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const txt = readFileSync(file, "utf8");
    return txt.trim().length === 0 ? fallback : JSON.parse(txt);
  } catch (err) {
    fallback && console.error("[store] parse failed", file, err.message);
    return fallback;
  }
}

/**
 * Schedule an atomic (tmp + rename) JSON write. Coalesces rapid updates per file.
 */
export function writeJsonDebounced(file, value, delayMs = 400) {
  pending.set(file, value);                       // last write wins
  const existing = debounceTimers.get(file);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    const v = pending.get(file);
    pending.delete(file);
    debounceTimers.delete(file);
    if (v !== undefined) writeJsonAtomicFromObject(file, v);
  }, delayMs);
  debounceTimers.set(file, t);
}

const debounceTimers = new Map();

export function writeJsonAtomic(data, file) {
  return writeJsonAtomicFromObject(file, data);
}

function writeJsonAtomicFromObject(file, obj) {
  try {
    mkdirp(dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    console.error("[store] write failed", file, err.message);
  }
}

/** flush any debounced writes immediately (used on shutdown) */
export function flushAll() {
  for (const [file, v] of pending) {
    pending.delete(file);
    const t = debounceTimers.get(file);
    if (t) clearTimeout(t);
    debounceTimers.delete(file);
    if (v !== undefined) writeJsonAtomicFromObject(file, v);
  }
}

export async function ensureDirAsync(pathStr) {
  try { await mkdir(pathStr, { recursive: true }); } catch { /* exists */ }
}
