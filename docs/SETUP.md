# Setup guide — from zero to a talking companion

This walks through every account, key and click. Budget ~15 minutes.

---

## 0. What you need

- A server (VPS) or your own PC running Node.js **20+** (Node 24 recommended)
- An xAI API key — create one at <https://console.x.ai> → **API Keys** → *Create key*
- A Discord account and a server where you have *"Manage Server"* (invite) rights

---

## 1. Create the Discord bot (official bot account)

The companion replies through a **real bot account** — never through your
personal credentials. Your personal account stays yours.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. **New Application** → name it (this becomes the bot's display name later, and
   you can change it) → *Create*.
3. Left sidebar → **Bot**:
   - Press **Reset Token** → copy the token now (shown once).
   - Scroll to **Privileged Gateway Intents**:
     - `SERVER MEMBERS INTENT` — **not required**
     - `MESSAGE CONTENT INTENT` — **required** (the bot must read chat to
       understand context and detect questions/mentions)
   - Save.
4. (Optional) Left sidebar → **General Information** → copy the
   **Application ID** (auto-detected later, nice to have).

> The token is a secret. Paste it only into the dashboard or an env file —
> never commit it, never message it to anyone.

## 2. Run the companion

```bash
git clone <your-repo> companion && cd companion
npm install
npm start
# → dashboard + API listening on http://0.0.0.0:3000
```

First boot prints a banner and starts listening. Configuration persists in
`data/config.json`; logs go to `data/logs/YYYY-MM-DD.log`.

### Lock the dashboard down on a VPS

Either bind to localhost and use an SSH tunnel / reverse proxy, or bind
`0.0.0.0` behind nginx + TLS (see `docs/DEPLOYMENT.md` for a ready nginx AUTH
and the `TRUST_PROXY` flag). Always set a strong owner password.

## 3. First login

Open `http://<host>:3000`.

- **First run:** whatever you type becomes the owner password (min 8 chars)
  — or set `ADMIN_PASSWORD` in the environment and log in with it.
- Sessions are HttpOnly cookies; *Settings → Log out ALL sessions* revokes
  everything at once. Password changes automatically revoke all sessions.

## 4. Connect the Grok engine

Dashboard → **Grok engine**:

1. Paste your `xai-…` key → **Save key**. It's stored server-side only; the
   dashboard shows just `configured · ends ####` forever after.
2. **⚡ Test connection** — proves the key, shows the model that answered,
   latency and a sample reply.
3. Pick the **model**. Recommended for constant Discord chat:
   - `grok-4-fast-reasoning` / `grok-4-fast-non-reasoning` — cheap
     (~$0.20 in / $0.50 out per 1M tokens), great quality for banter. **Default.**
   - `grok-3-mini` — cheaper still, decent for light chat.
   - `grok-3`, `grok-2` — heavyweight, watch your caps.
4. Tune **temperature** (0.2–0.6 keeps it predictable), **max reply length
   (tokens)** (~120–200 is plenty for chat messages).
5. Set **spending & rate controls**:
   - *Requests/minute* — rate ceiling for the API client
   - *Daily spend cap ($)*, *Daily request cap* — the engine stops (gracefully)
     when these are hit; counters reset at midnight server time.
6. Check **Usage today** — live counters computed from API-reported tokens.

## 5. Connect the bot account

Dashboard → **Discord link**:

1. Paste the bot token → **Save & connect**.
2. The invite link appears (permissions baked in: *View Channels · Send
   Messages · Read Message History* = `68608`). **Copy link → Invite ↗** →
   pick your server.
3. Status chip flips to **connected**; the *Connection monitor* card shows
   gateway events (resyncs, disconnects) — this is what tells you it's alive
   24/7 even when you're not watching.
4. Optional: **Community safety rules** — ignore other bots, and a blocklist
   of user IDs that never trigger replies.

> Troubleshooting invalid token: make sure you copied the **bot** token (three
> dot-separated segments), and that *Reset Token* wasn't done after copying.
> `Used disallowed intents` = you didn't enable **Message Content Intent** in
> the developer portal (step 1.3).

## 6. Choose channels & reply modes

Dashboard → **Channels** (configure after inviting the bot):

- The watchlist starts empty — nothing replies anywhere until you add channels.
- Per channel: `OFF / Mention only / Questions only / Selective / Always`
  - **Mention only** — replies when someone @s the bot or replies to it.
    Safest with strangers.
  - **Questions only** — answers actual questions (heuristic + `?`).
  - **Selective** — mentions/questions always count; plain messages get a
    probability roll (slider).
  - **Always** — chats like a normal active member. Use only in channels
    where you'd tolerate a chatty human.
- ✉ **Approval queue** per channel — force drafts-for-review in that channel
  even when the global pipeline is automatic.
- **Global rules**: cooldowns (per-channel + global), hourly per-channel cap,
  daily total cap, duplicate window (hours), blocked keywords.

## 7. Teach it your voice

Dashboard → **Personality**:

1. **Paste/upload examples** — one message per line. Discord chat exports work
   (name prefixes and timestamps are stripped automatically). Aim for 30–200
   messages that *sound like you*: short banter, opinions, reactions, typos and all.
2. **Import & retrain style** → the profile grid fills in (avg words, lowercase
   %, end-of-period habit, emoji rate, favorite words/emojis).
3. **Voice tuning** — reply length target, slang intensity (0–5), humor (0–3),
   toggles for lowercase, no trailing punctuation, gaming vocabulary,
   context-aware reactions, plus identity name + persona hint + a free-form
   standing system prompt (highest priority rules).
4. **Vocabulary control** — *never say* phrase list + preferred-word glossary
   (applied to every reply: `"mid" → "broken"`).
5. **Sandbox** — generate a reply against a *fake* conversation. Sends nothing;
   perfect while dialing in the voice.

## 8. Memory & context

Dashboard → **Context**:

- **Approved community memory** — add facts like *"wipes are thursdays 20:00
  EU"*, *"the glitch hacker is ravioli"*. Only these are visible to the AI.
- **Recurring questions** — auto-detected repeats; click *tell me what to say*
  to set the canonical answer; the engine rephrases next time instead of
  repeating word-for-word.
- **Context inspector** — see exactly the transcript the model sees per channel.

## 9. Pick your pipeline

Dashboard → **Approvals**:

- **⚡ automatic (bot sends)** — replies go out directly, always labeled
  `[AI]` (or your custom symbol; disclosure `auto/always/never`).
- **✉ approval (you review all)** — every generated reply lands in the queue:
  - *Send via bot* — posts with the AI label
  - *I'll send it myself* — copies the **clean text** (no label) and opens the
    channel; you paste it from your own account. The queue item is marked
    resolved as owner-sent — your personal messages stay strictly personal.
  - *Discard* — bin it.
- You can also **＋ hand-draft** a reply for any configured channel on demand.

## 10. Emergency stop & safety nets

- **🛑 Emergency stop** (Overview → Owner controls, and a chip in the top bar):
  instant global freeze — nothing is generated or sent.
- **Circuit breaker**: 4 consecutive API failures auto-pause replies; reset
  from the Overview.
- Rate/spend caps + queue limits + cooldowns are enforced engine-side (not just
  paint-on-the-dashboard): see `server/lib/engine.js` `decide()`.

---

## Where everything lives

| what                      | path                                    |
|---------------------------|-----------------------------------------|
| config (incl. secrets)    | `data/config.json`                      |
| dashboard sessions        | `data/sessions.json`                    |
| channel context + FAQ     | `data/context.json`                     |
| approval queue            | `data/approvals.json`                   |
| daily logs                | `data/logs/YYYY-MM-DD.log`              |

Back up `data/` and you can rebuild the whole deployment anywhere.
