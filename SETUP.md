# DJ Stream Server — Setup Guide

## Requirements

- [Node.js](https://nodejs.org) v18+
- [FFmpeg](https://ffmpeg.org/download.html) — must be installed and in PATH
- OBS Studio (for the DJ to stream)

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

Edit `.env` — at minimum change `JWT_SECRET` to a random string.

---

## 3. Install FFmpeg (Windows)

1. Download from https://ffmpeg.org/download.html
2. Extract to `C:\ffmpeg`
3. Add `C:\ffmpeg\bin` to your Windows PATH
4. Test: open CMD and type `ffmpeg -version`

---

## 4. Start the server

```bash
npm start
```

---

## 5. Open ports on your router (for internet access)

Forward these ports to your home server PC:
- **3000** → TCP  (web clients)
- **1935** → TCP  (DJ RTMP stream from OBS)

Find your public IP at https://whatismyip.com

---

## 6. DJ OBS Settings

In OBS → Settings → Stream:
- **Service:** Custom
- **Server:** `rtmp://YOUR_PUBLIC_IP:1935/live`
- **Stream Key:** `djlive` (or whatever you set in .env)

---

## 7. Clients (TV users)

Open a browser on the TV and go to:
```
http://YOUR_PUBLIC_IP:3000
```

- Register with a username + password
- They get **6 months free** automatically
- Once logged in, they see the stream when you go live

---

## File structure

```
C:/solat/
  server.js          — Main server (RTMP + HTTP)
  src/
    auth.js          — Login/register routes
    users.js         — User database helpers
  public/
    index.html       — Login/register page (TV-friendly)
    watch.html       — Stream viewer
    expired.html     — Subscription expired page
  data/
    users.json       — User accounts (auto-created)
  media/             — HLS stream segments (auto-created by FFmpeg)
  .env               — Your configuration
```

---

## Adding paid subscriptions later

When you're ready to charge, set `paidUntil` on a user in `data/users.json`:

```json
"username": {
  ...
  "paidUntil": "2027-01-01T00:00:00.000Z"
}
```

You can automate this with a payment gateway (Stripe, etc.) later.
