# CLAUDE.md — DJ Stream Project

## Project Overview
Node.js + Express DJ live-streaming platform. Single-instance (one DJ at a time).
Stack: Express, node-media-server (RTMP), WebSocket, HLS.js, FFmpeg, web-push.

## Key Commands
```bash
node server.js          # start server (port 3000)
git push origin main    # push requires VPN (proxy: 127.0.0.1:10808)
```

## Shell / Platform
- Windows 11, use bash (Git Bash / WSL-style paths like /c/solat/)
- Never `kill` all node.exe processes — target by PID only (see memory/feedback_kill_node.md)
- Use Unix syntax: forward slashes, /dev/null not NUL

## File Layout
```
server.js          main entry: Express routes, RTMP hooks, backup cron
src/               server-side modules (chat-ws, stream-ws, push, users, requests, etc.)
public/            static files served at /
  dj.html          DJ broadcast console (single-page app)
  watch.html       viewer page
  admin.html       admin panel
  profile.html     user profile
  index.html       login / register
  fonts/           Material Symbols Outlined (local, no CDN)
  hls.min.js       HLS.js (local copy)
  sw.js            service worker v3
data/              JSON data files (users, requests, chat, clips, etc.)
media/             HLS segments + recordings (not in git)
```

## Environment Variables (.env)
Required: `VAPID_PUBLIC_KEY`, `VAPID_SECRET_KEY`, `ADMIN_KEY`, `JWT_SECRET`, `STREAM_KEY`
Optional: `FFMPEG_PATH`, `DISCORD_WEBHOOK_URL`, `SITE_URL`, `INVITE_ONLY`, `GUEST_WATCH`, `STRIPE_*`

## Architecture
- Auth: JWT in httpOnly cookie; admin via `x-admin-key` header or `adminKey` cookie
- One active DJ WebSocket (`djSocket` in stream-ws.js); rejected if another is live
- Browser stream: WebSocket → FFmpeg → HLS segments in `media/live/`
- RTMP stream: OBS → node-media-server → same HLS path
- FFmpeg auto-records browser streams to `media/recordings/` as MKV
- Push notifications filtered per-user via `pushPrefs` in users.json

## Coding Conventions
- Icons: Material Symbols Outlined (`<span class="material-symbols-outlined">icon_name</span>`)
  Font is served locally from `/fonts/material-symbols-outlined.css` — no Google Fonts CDN
- No CDN dependencies for runtime assets (fonts, HLS.js all local)
- `innerHTML` for buttons containing icon spans; `textContent` for text-only
- Toast messages via `toast(msg, isError)` in dj.html / watch.html
- Data persistence: JSON files with atomic write (tmp → rename)
- Admin API routes use `requireAdmin` middleware; user routes use `requireAuth`

## Do Not
- Do not add CDN links for fonts or JS — serve locally
- Do not kill all node processes — target by PID
- Do not add CSP headers yet (all inline scripts, large refactor needed)
- Do not implement beat-sync or pitch-lock (complex DSP, deferred)
