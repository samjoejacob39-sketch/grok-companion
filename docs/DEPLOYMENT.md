# Deployment guide — 24/7 on a VPS

The companion is a single Node process: dashboard + REST API + the Discord
gateway client. It keeps replying with zero browsers open. Two supported
deployment styles below — **systemd** (bare metal / classic VPS) and
**Docker**. Both keep state in `data/`.

---

## ⚡ The model is a free hosted call — the VPS stays tiny

You don't host any model. The dashboard's default brain is **OpenRouter**
(free key → free models like NVIDIA Nemotron 3.5 Lightning). That means:

- the smallest VPS plan you like (1 vCPU / 1 GB is plenty),
- no API bill — free-tier fair-use caps apply,
- the only setup is pasting one free key in the dashboard.

Self-hosting the model (Ollama on the same box) is optional — see
*Setup guide → 4c* if you ever want that.

---

## A. systemd (recommended for a single-purpose VPS)

### 1. Provision

Ubuntu 22.04/24.04 or Debian 12 assumed:

```bash
# node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt-get install -y nodejs

# dedicated user + files
sudo useradd -r -m -d /opt/companion -s /usr/sbin/nologin companion || true
sudo mkdir -p /opt/companion && sudo chown companion:companion /opt/companion

# ship the code as the companion user
sudo -u companion git clone https://github.com/samjoejacob39-sketch/grok-companion.git /opt/companion
cd /opt/companion && sudo -u companion npm ci --omit=dev
```

### 2. First boot & seeds

Optionally seed the owner password once via env, then remove it:

```bash
sudo -u companion ADMIN_PASSWORD='your-first-password' timeout 20 node server/index.js
# reach the dashboard, add keys + password hash in the UI, Ctrl+C
```

### 3. Install the unit

```bash
sudo cp deploy/companion.service /etc/systemd/system/companion.service
sudo systemctl daemon-reload
sudo systemctl enable --now companion
systemctl status companion        # active (running)?
journalctl -u companion -f        # live boot/supervisor logs
```

The unit (see `deploy/companion.service`):

- `Restart=always`, `RestartSec=5` — auto-recovers from crashes
- `After=network-online.target` — safe at boot
- hardened: `NoNewPrivileges`, `ProtectSystem=full`, `PrivateTmp`,
  its own user, and only `/opt/companion/data` writable

### 4. Reverse proxy (strongly recommended)

Put TLS in front; the dashboard sets `HttpOnly/SameSite=Strict` cookies and
marks them `Secure` automatically when the request is https (behind a proxy
that's detected via `x-forwarded-proto`).

nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name companion.example.com;

  ssl_certificate     /etc/letsencrypt/live/companion.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/companion.example.com/privkey.pem;

  location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    client_max_body_size 2m;
  }
}
```

When using a proxy, set `TRUST_PROXY=true` in the service unit env so rate
limiting sees real client IPs.

### 5. Updating

```bash
cd /opt/companion
sudo -u companion git pull
sudo -u companion npm ci --omit=dev
sudo systemctl restart companion
```

Short downtime (~2s) — the gateway reconnects automatically.

---

## B. Docker

```bash
cp .env.example .env      # set ADMIN_PASSWORD (+ keys if you want them seeded)
docker compose up -d --build
docker compose logs -f companion
```

- State persists through `./data:/app/data`
- `restart: unless-stopped` keeps it alive across reboots/crashes
- image targets Node 24 alpine, runs as a non-root user, has a HEALTHCHECK on
  `/api/health`

Update: `docker compose build && docker compose up -d`.

---

## Backups (both methods)

Everything important is in one folder:

```bash
tar -czf companion-backup-$(date +%F).tgz /opt/companion/data
# or restore anywhere: untar + npm ci + start — config, sessions, memory, logs intact
```

Included: `config.json` (with secrets — store the archive **encrypted** if you
ship it off-box), `sessions.json`, `context.json`, `approvals.json`, daily logs.

The dashboard also offers **Settings → Download config backup** which writes a
timestamped snapshot into `data/backups/`.

---

## Operations cheat-sheet

| task                       | systemd                        | docker                          |
|----------------------------|--------------------------------|---------------------------------|
| status                     | `systemctl status companion`   | `docker compose ps`             |
| logs                       | `journalctl -u companion -f`   | `docker compose logs -f`        |
| dashboard file logs        | `/opt/companion/data/logs/`    | `data/logs/` on the host        |
| restart                    | `sudo systemctl restart companion` | `docker compose restart`    |
| stop                       | `sudo systemctl stop companion`| `docker compose down`           |

Health endpoint: `GET /api/health` → `{"ok":true}` (public, no auth — use for
uptime monitors). Every other API route requires the session cookie.

---

## Security model (what's enforced, where)

| layer        | control                                                                 |
|--------------|-------------------------------------------------------------------------|
| transport    | TLS terminates at your proxy; `Secure` cookies auto-enable on https     |
| sessions     | scrypt-hashed owner password; HttpOnly + SameSite=Strict + max-age      |
| CSRF         | `x-companion` header required on every mutating request + Origin check  |
| secrets      | never serialized to the browser (only `configured · last4`); env seed accepted once |
| injection    | no DB, no SQL; JSON body limit 1 MB; prompt gets a secret-leak guard (aborts if a secret would be included) |
| voice        | `NoNewPrivileges`, `ProtectSystem`, `PrivateTmp`, dedicated user        |
| abuse        | login rate limit (8/15min/IP), blocked-user lists, keyword blocklist, cooldowns, daily caps  |
| blast radius | `reply.stopped` flag is checked before *any* generation or send          |

If the VPS is compromised, rotate immediately: (1) bot token — Developer
Portal → Reset Token, (2) xAI key — console.x.ai → revoke, (3) dashboard
password — Settings → change (revokes all sessions).

---

## Monitoring

- **Connection monitor card** (Discord link page) — gateway status feed,
  resync/disconnect events, live ping.
- **Overview tiles** — replies today, approvals waiting, spend vs cap,
  bot uptime, breaker state.
- **Logs page** — full audit trail from any device.
- External: poll `?$` `GET /api/health` every 30–60s from your uptime watcher.
