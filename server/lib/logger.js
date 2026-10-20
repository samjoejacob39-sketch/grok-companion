/** Structured logging with rotation. Written only to server disk; never returned to the dashboard. */

import { mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.LOG_DIR || join(__dirname, "..", "..", "data", "logs");
mkdirSync(LOG_DIR, { recursive: true });

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = LEVELS[process.env.LOG_LEVEL || "info"] ?? 20;

export function setLogLevel(level) {
  minLevel = LEVELS[level] ?? 20;
}

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

function fmt(args) {
  return args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
}

function emit(level, color, args) {
  if ((LEVELS[level] ?? 20) < minLevel) return;
  const line = `${new Date().toISOString()} [${level}] ${fmt(args)}`;
  try {
    appendFileSync(join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`), line + "\n");
  } catch {
    /* disk hiccup — keep serving */
  }
  if (process.env.NODE_ENV !== "test") console.log(`${color}${line}${RESET}`);
}

export const log = {
  debug: (...a) => emit("debug", DIM, a),
  info: (...a) => emit("info", GREEN, a),
  warn: (...a) => emit("warn", YELLOW, a),
  error: (...a) => emit("error", RED, a),
};

/** Rotate old log files at startup. */
export function rotateLogs(retentionDays = 14) {
  try {
    const files = readdirSync(LOG_DIR).filter((f) => f.endsWith(".log"));
    for (const f of files) {
      const path = join(LOG_DIR, f);
      const ageDays = (Date.now() - statSync(path).mtimeMs) / 86_400_000;
      if (ageDays > retentionDays) unlinkSync(path);
    }
  } catch (err) {
    console.error("[logs] rotation failed:", err.message);
  }
}

/** Wrap an async fn so any throw still logs. */
export async function guarded(name, fn) {
  try {
    return await fn();
  } catch (err) {
    log.error(`[${name}]`, err);
    throw err;
  }
}
