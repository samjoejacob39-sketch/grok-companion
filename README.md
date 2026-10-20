# Companion — Grok AI for your Discord server

A self-hosted Discord companion that **chats like you** — powered by the official
xAI Grok API, running 24/7 on your own VPS, and fully controlled from a private
dark-glass dashboard.

The bot learns your writing style from real example messages, watches the
channels you choose, follows the current conversation, remembers approved
community facts, avoids repeating itself, and replies with your voice
(automatically, or draft-by-draft with your approval).

```
┌──────────────┐   official gateway    ┌───────────────────────────────┐
│ your Discord │ ─────────────────────▶│  companion (this project)     │
│   server     │ ◀─────────────────────│  ├─ discord.js bot (24/7)     │
└──────────────┘   [AI]-labeled reply  │  ├─ reply engine + context    │
                                       │  ├─ xAI Grok API client       │
          browser ────────────────────▶│  └─ dashboard (REST + SPA)    │
          you control everything       └───────────────────────────────┘
```

## Highlights

- **Your voice, learned** — paste or upload example messages; the style engine
  distills length habits, lowercase tendencies, emoji favorites, slang and
  gaming vocabulary into concrete prompt directives. Tune with sliders
  (slang intensity, humor, reply length) and identity hints.
- **Live conversation context** — a rolling transcript of recent channel
  messages is included in every prompt, so replies follow the *current* flow,
  not a stale trigger.
- **Approved memory only** — facts the AI may reference are owner-curated.
  Recurring questions are auto-detected (fuzzy match) and the bot is told to
  rephrase instead of repeating itself.
- **Precise reply control per channel** — modes: `off`, `mention only`,
  `questions only`, `selective` (probability roll), `always`. Plus per-channel
  + global cooldowns, hourly/daily caps, blocked keywords, duplicate-trigger
  suppression, blocked users.
- **Approval pipeline** — either the bot sends directly (clearly labeled,
  `[AI]` by default), or *every* reply lands in the dashboard queue for an
  owner decision: edit → send via bot (labeled), or “I'll send it myself”
  (clean copy → send from your own account, so your personal messages stay yours).
- **Spending controls** — requests/minute, daily request cap, daily $ cap
  computed from real API token usage per model. Circuit breaker + emergency stop.
- **Secrets stay server-side** — the xAI key and bot token are stored in
  `data/config.json` on the VPS and are never returned to the browser
  (the dashboard only ever sees `configured · last 4`).
- **Dashboard auth** — single-owner password (scrypt), HttpOnly SameSite=Strict
  session cookie, CSRF header check, same-origin enforcement, login rate limiting.
- **24/7 operation** — one Node process serves the dashboard, REST API and the
  bot gateway; it keeps replying with no browser open. Docker and systemd
  units included.

## Stack

Node.js ≥ 20 (ESM) · `express` · `discord.js@14` · zero-build vanilla-JS SPA.
Only **two runtime dependencies**. No CDN assets; system fonts only.

## Quick start

```bash
# 1. install
npm install

# 2. (optional) seed credentials — or add them in the dashboard instead
cp .env.example .env    # then edit .env: ADMIN_PASSWORD, XAI_API_KEY, DISCORD_BOT_TOKEN

# 3. run
npm start               # dashboard on http://localhost:3000
# dev loop:
npm run dev
```

Then open `http://localhost:3000`:

1. **Log in** (first login sets your owner password if `ADMIN_PASSWORD` wasn't seeded).
2. **AI engine** → pick your brain:
   - **⟡ Local Llama — FREE** (default-ready): install [Ollama](https://ollama.com) next to
     the server, `ollama pull llama3.2:3b`, accept the defaults → *Test local model*.
     No key, no cost, ~2 GB RAM.
   - **☁ Official Grok**: paste your xAI API key (`xai-…`) → *Test connection* → pick a model.
3. **Discord link** → paste your bot token → *Save & connect* → copy the invite
   link → add the bot to your server.
4. **Channels** → configure which channels it may reply in and the reply mode.
5. **Personality** → paste a few dozen of your real messages → import → save voice.
6. Optionally switch to **approval mode** in *Approvals* while you watch it work.

Full walk-through with screenshots-level detail: [`docs/SETUP.md`](docs/SETUP.md).
VPS deployment (systemd + Docker + backups): [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Project layout

```
server/
  index.js              entrypoint — express app + bot autostart + graceful shutdown
  auth.js               password hashing, sessions, cookies, CSRF, login limiter
  routes/api.js         REST API (secrets never serialized)
  services/
    discordbot.js       discord.js gateway client, reply pipeline, send history
    approvals.js        owner review queue for drafts
  lib/
    config.js           config store (data dir), sessions, secret accessors
    engine.js           reply decision rules + generation pipeline
    context.js          per-channel transcript + FAQ memory
    persona.js          system-prompt builder (voice directives)
    style.js            writing-style analyzer (examples → profile)
    grok.js             xAI chat completions client + usage/cost accounting
    text.js             normalization, similarity, slang/question heuristics
    ratelim.js          sliding window + cooldown gates
    logger.js           daily file logs + rotation
    audit.js            in-memory audit ring (dashboard feed)
    store.js            atomic JSON persistence helpers
public/                 dashboard SPA (dark glassmorphism, purple)
test/                   node --test suites (51 tests, all logic-mocked — no network)
deploy/                 systemd unit
docs/                   SETUP.md, DEPLOYMENT.md
data/                   runtime state (config, sessions, context, logs) — gitignored
```

## Scripts

| command        | what it does                                    |
|----------------|-------------------------------------------------|
| `npm start`    | run the companion (dashboard + bot, port 3000)  |
| `npm run dev`  | same with `node --watch` auto-restart           |
| `npm test`     | run the unit-test suite (isolated temp data dir)|

## Configuration reference

Everything lives in `data/config.json` (created on first boot). Manage it all
from the dashboard; the file is the durable store.

| key                     | meaning                                                     |
|-------------------------|-------------------------------------------------------------|
| `xai`                   | model, temperature, token/timeout limits, request rate caps |
| `discord`               | bot client id, guild cache, permission rules                |
| `channels[]`            | per-channel: mode, enabled, approval-only, cooldowns, hint  |
| `reply`                 | global reply rules + emergency stop flag                    |
| `personality`           | voice settings + example messages + glossary + do-not-say   |
| `memory`                | approved facts, transcript limits                           |
| `generatedReply`        | `auto` vs `approval` pipeline, AI label (`[AI]` symbol)     |
| `audit`                 | audit retention                                             |

Environment: `PORT` (3000), `HOST`, `DATA_DIR`, `LOG_DIR`, `LOG_LEVEL`,
`ADMIN_PASSWORD`, `XAI_API_KEY`, `DISCORD_BOT_TOKEN`, `TRUST_PROXY`.

## A note on honesty

The bot always labels AI-generated sends (`[AI]` by default — configurable to
`always`/`never`… we recommend leaving it on). Messages you send personally
through your own Discord account are never involved: that path is yours alone.
The dashboard also keeps a per-message history of every send with its origin
(`AI · auto`, `AI · approved`, `you · sent via bot`).

## License

MIT — yours to run.
