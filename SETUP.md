# DJ Stream Server — Setup Guide

## Requirements

- [Node.js](https://nodejs.org) v18+
- [FFmpeg](https://ffmpeg.org/download.html) — must be installed and in PATH
- OBS Studio (for the DJ to stream via RTMP), or use the browser DJ panel

---

## 1. Install dependencies

```bash
cd C:/solat
npm install
```

---

## 2. Configure

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` — required changes before first start:

| Variable | Description |
|---|---|
| `JWT_SECRET` | Random string (min 32 chars) — **required** |
| `ADMIN_KEY` | Password for the admin panel — **required** |
| `STREAM_KEY` | OBS stream key — **required** |
| `ALLOWED_ORIGIN` | Your domain (e.g. `https://dj.example.com`) — for CORS |

The server **will not start** if `JWT_SECRET`, `ADMIN_KEY`, or `STREAM_KEY` are missing, or if `JWT_SECRET` is still the default placeholder value.

---

## 3. Install FFmpeg (Windows)

1. Download from https://ffmpeg.org/download.html
2. Extract to `C:\ffmpeg`
3. Add `C:\ffmpeg\bin` to your Windows PATH
4. Test: open CMD and type `ffmpeg -version`

On Linux/macOS: `sudo apt install ffmpeg` or `brew install ffmpeg`

---

## 4. Start the server

### Development (direct Node)

```bash
npm start
```

### Production (PM2 — recommended)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save            # auto-restart on reboot
pm2 startup         # install startup hook
```

Useful PM2 commands:

```bash
pm2 logs dj-stream   # tail logs
pm2 status           # check process status
pm2 restart dj-stream
pm2 stop dj-stream
```

Logs are written to `./logs/out.log` and `./logs/err.log`.

### Docker (easiest for Linux VPS)

Requires [Docker](https://docs.docker.com/get-docker/) with the Compose plugin.

```bash
cp .env.example .env   # edit .env first — set JWT_SECRET, ADMIN_KEY, STREAM_KEY
docker compose up -d   # build image and start in background
docker compose logs -f # tail logs
```

Useful commands:

```bash
docker compose down          # stop and remove container
docker compose restart       # restart after config change
docker compose pull && docker compose up -d --build  # rebuild after code update
```

Data is persisted in local directories (`./data`, `./media`, `./logs`) via volume mounts — the container can be destroyed and recreated without losing user accounts or recordings.

---

## 5. Nginx reverse proxy (recommended for production)

Install Nginx, then copy `nginx/dj-stream.conf` to your sites-enabled directory and edit it:

1. Replace `dj.example.com` with your actual domain
2. Obtain SSL certificates with Let's Encrypt:
   ```bash
   sudo certbot --nginx -d dj.example.com
   ```
3. Reload Nginx: `sudo nginx -s reload`

With Nginx in front, clients connect on port 443 (HTTPS) and Nginx proxies to Node on port 3000. You don't need to open port 3000 publicly.

---

## 6. Open ports on your router (for internet access)

| Port | Protocol | Purpose |
|---|---|---|
| 80 / 443 | TCP | Web clients (HTTP/HTTPS) |
| 1935 | TCP | DJ RTMP stream from OBS |
| 3000 | TCP | Direct Node access (skip if using Nginx) |

Find your public IP at https://whatismyip.com

---

## 7. DJ OBS Settings

In OBS → Settings → Stream:
- **Service:** Custom
- **Server:** `rtmp://YOUR_PUBLIC_IP:1935/live`
- **Stream Key:** value of `STREAM_KEY` in your `.env`

Alternatively, use the browser DJ panel at `/dj.html` — no OBS required.

---

## 8. Clients (viewers)

Open a browser and go to:
```
https://dj.example.com
```
or (without Nginx):
```
http://YOUR_PUBLIC_IP:3000
```

- Register with a username + password
- New accounts get **6 months free** automatically
- Once logged in, they see the stream when you go live

---

## 9. Admin panel

Go to `/admin-login.html` and enter your `ADMIN_KEY`.

The admin panel lets you:
- See live stream status and viewer count
- View and manage all user accounts
- Extend subscriptions manually
- Generate and manage invite codes
- Browse and download session recordings
- Set the stream title (shown to viewers)

---

## 10. Invite-only registration

To restrict registration to invited users only, set in `.env`:

```
INVITE_ONLY=true
```

Then generate invite codes in the admin panel → **Invite Codes** section. Share codes with people you want to allow to register. Each code is single-use.

---

## 11. Stripe payments (optional)

To enable paid subscriptions after the 6-month trial:

1. Create a product + recurring price in your [Stripe dashboard](https://dashboard.stripe.com)
2. Add to `.env`:
   ```
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_PRICE_ID=price_...
   STRIPE_ACCESS_DAYS=365
   ```
3. Set up the webhook in Stripe dashboard → Developers → Webhooks:
   - URL: `https://dj.example.com/payment/webhook`
   - Event: `checkout.session.completed`

Users whose trial has expired will see a "Subscribe" button on `/expired.html` → `/pricing.html` → Stripe Checkout → access extended automatically.

---

## File structure

```
C:/solat/
  server.js              — Main server (Express + RTMP + WebSocket)
  ecosystem.config.js    — PM2 process config
  nginx/
    dj-stream.conf       — Nginx reverse proxy config
  src/
    auth.js              — Login/register/logout routes
    admin.js             — Admin API routes
    users.js             — User database helpers
    invites.js           — Invite code system
    payment.js           — Stripe payment routes
    stream-ws.js         — Browser DJ panel WebSocket + recording
    chat-ws.js           — Live chat WebSocket
  public/
    index.html           — Login/register page
    watch.html           — Stream viewer
    dj.html              — Browser DJ panel
    admin.html           — Admin dashboard
    admin-login.html     — Admin login
    expired.html         — Subscription expired page
    pricing.html         — Stripe checkout page
    404.html             — 404 error page
  data/
    users.json           — User accounts (auto-created)
    invites.json         — Invite codes (auto-created)
    backups/             — Daily user DB backups (last 30 kept)
  media/
    recordings/          — Session recordings (.webm)
    live/                — HLS stream segments (auto-managed)
  logs/                  — PM2 logs (auto-created)
  .env                   — Your configuration (never commit this)
  .env.example           — Template for .env
```

---

## Health check

The server exposes a no-auth health endpoint for uptime monitors:

```
GET /api/health
```

Returns: `{ status, uptime, live, viewers, memMB, version }`

---

## Security notes

- `JWT_SECRET` must be a strong random string — the server rejects the default placeholder on startup
- The admin panel is protected only by `ADMIN_KEY` — use a long, random value
- HLS stream segments (`/live/*`) require a valid user session — raw port 8888 is bound to localhost only
- Set `ALLOWED_ORIGIN` to your domain to enable strict CORS
- Use Nginx + HTTPS in production — the Nginx config includes HSTS headers
- User data is backed up daily to `data/backups/` with 30-day retention
