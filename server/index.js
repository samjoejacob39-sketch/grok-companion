/**
 * Companion server entrypoint.
 * One process serves dashboard + REST API + Discord bot, so automatic replies
 * run 24/7 on the VPS independently of any open browser.
 *
 * Env: PORT(3000), HOST(0.0.0.0), DATA_DIR, LOG_DIR, LOG_LEVEL,
 *      ADMIN_PASSWORD, XAI_API_KEY, DISCORD_BOT_TOKEN (first-run seeds)
 */

import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getConfig, DATA_DIR, hasSecret, setSecret, markSecretSet } from "./lib/config.js";
import { log, rotateLogs } from "./lib/logger.js";
import { flushAll } from "./lib/store.js";
import { flushContext, initContext } from "./lib/context.js";
import { initApprovals } from "./services/approvals.js";
import { startBot, stopBot } from "./services/discordbot.js";
import auth from "./auth.js";
import { audit } from "./lib/audit.js";
import apiRouter from "./routes/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

function seedFromEnv() {
  if (process.env.XAI_API_KEY && !hasSecret("xai")) {
    setSecret("xai", process.env.XAI_API_KEY);
    markSecretSet("xai");
    log.info("[boot] xAI key seeded from env");
  }
  if (process.env.DISCORD_BOT_TOKEN && !hasSecret("discord")) {
    setSecret("discord", process.env.DISCORD_BOT_TOKEN);
    markSecretSet("discord");
    log.info("[boot] Discord bot token seeded from env");
  }
  if (process.env.ADMIN_PASSWORD && !getConfig().admin.passwordHash) {
    try {
      auth.setPassword(process.env.ADMIN_PASSWORD);
      log.info("[boot] admin password seeded from env");
    } catch (err) {
      log.error("[boot] ADMIN_PASSWORD rejected (min 8 chars):", err.message);
    }
  }
}

function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);

  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  // /api/health — public, minimal
  app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

  // everything else under /api requires a dashboard session
  app.use("/api", (req, res, next) => auth.requireAuth(req, res, next));
  app.use("/api", apiRouter);

  // static dashboard
  const PUBLIC = process.env.PUBLIC_DIR || join(__dirname, "..", "public");
  app.use(express.static(PUBLIC, {
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  }));

  // SPA fallback for GET requests that aren't API hits
  app.use((req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
    if (req.method !== "GET") return res.status(404).json({ error: "not found" });
    const indexFile = join(PUBLIC, "index.html");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexFile, (err) => {
      if (err) res.status(500).send("dashboard missing — deploy public/ folder");
    });
  });

  // error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error("[http]", err?.message || err);
    res.status(err.status || 500).json({ error: err?.message || "server error" });
  });

  return app;
}

async function main() {
  console.log("");
  console.log("  ┌─ Companion ─────────────────────────────────┐");
  console.log("  │  xAI Grok Discord AI · v1.0                 │");
  console.log("  └─────────────────────────────────────────────┘");

  seedFromEnv();
  rotateLogs(getConfig().audit?.retentionDays ?? 14);
  initContext();
  initApprovals();

  const app = buildApp();
  const server = app.listen(PORT, HOST, () => {
    log.info(`[boot] dashboard + API listening on http://${HOST}:${PORT}`);
    audit("server.start", `server listening on ${HOST}:${PORT}`);
  });

  // auto-start bot so replies run 24/7, even with the dashboard closed
  if (hasSecret("discord") && !getConfig().reply.stopped) {
    startBot().catch((err) => log.error("[boot] discord autostart failed:", err?.message || err));
  } else {
    log.info("[boot] Discord autostart skipped (no token or emergency stop engaged)");
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[shutdown] ${signal} received — flushing state`);
    audit("server.stop", `shutdown (${signal})`);
    try { await stopBot(); } catch { /* already down */ }
    flushContext();
    flushAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => {
    log.error("[boot] unhandled rejection:", err?.message || err);
  });
  process.on("uncaughtException", (err) => {
    log.error("[boot] uncaught exception (continuing):", err);
  });
}

main().catch((err) => {
  console.error("[boot] fatal:", err);
  process.exit(1);
});
