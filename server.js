require('dotenv').config();

const http        = require('http');
const express     = require('express');
const WebSocket   = require('ws');
const NodeMediaServer = require('node-media-server');
const cookieParser = require('cookie-parser');
const cors        = require('cors');
const path        = require('path');
const fs          = require('fs');

const rateLimit   = require('express-rate-limit');
const authRoutes  = require('./src/auth');
const adminRoutes = require('./src/admin');
const { verifyToken } = require('./src/users');
const { setupStreamWS, getStreamTitle, setStreamTitle, isBrowserLive, getCurrentRecording, getSessionStartTime, getSetlist } = require('./src/stream-ws');
const { setupChatWS, getChatClientCount, djAnnounce }   = require('./src/chat-ws');

// ─── Config ───────────────────────────────────────────────────────────────────
const HTTP_PORT  = process.env.PORT       || 3000;
const RTMP_PORT  = 1935;
const STREAM_KEY = process.env.STREAM_KEY || 'djlive';
const HLS_PATH   = path.join(__dirname, 'media');

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // trust Cloudflare / reverse proxy for req.ip and req.secure

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Rate-limit login/register — max 15 attempts per minute per IP
const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — wait a minute and try again' }
});
app.use('/auth/login',    authLimiter);
app.use('/auth/register', authLimiter);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/auth',  authRoutes);
app.use('/admin', adminRoutes);

// ─── Live state ───────────────────────────────────────────────────────────────
let isLive   = false;
let coverUrl = '';

// Viewer heartbeat map: username → timestamp
const viewers = new Map();

app.post('/api/heartbeat', requireAuth, (req, res) => {
  viewers.set(req.user.username, Date.now());
  res.json({ ok: true });
});

setInterval(() => {
  const cutoff = Date.now() - 30_000;
  for (const [k, t] of viewers) { if (t < cutoff) viewers.delete(k); }
}, 10_000);

// ─── Public APIs ──────────────────────────────────────────────────────────────
// No-auth live check — safe to expose (no stream key or user data)
app.get('/api/live', (req, res) => {
  res.json({
    live:    isLive || isBrowserLive(),
    viewers: viewers.size,
    title:   getStreamTitle(),
  });
});

app.get('/api/status', requireAuth, (req, res) => {
  res.json({
    live:      isLive || isBrowserLive(),
    streamKey: STREAM_KEY,
    title:     getStreamTitle(),
    coverUrl,
    viewers:   viewers.size
  });
});

// Protected HLS segments — no browser caching for live content
app.use('/live', requireAuth, (req, res, next) => {
  if (req.path.endsWith('.m3u8') || req.path.endsWith('.ts')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
}, express.static(HLS_PATH));

// ─── Admin APIs ───────────────────────────────────────────────────────────────
app.get('/api/admin/stream-status', requireAdmin, (req, res) => {
  res.json({
    live: isLive || isBrowserLive(),
    streamKey: STREAM_KEY,
    viewers: viewers.size,
    title: getStreamTitle(),
    recording: !!getCurrentRecording(),
    sessionStart: getSessionStartTime(),
  });
});

// Setlist for current session
app.get('/api/admin/setlist', requireAdmin, (req, res) => {
  res.json({ setlist: getSetlist(), sessionStart: getSessionStartTime() });
});

// List recordings
const REC_DIR = path.join(__dirname, 'media', 'recordings');
app.get('/api/admin/recordings', requireAdmin, (req, res) => {
  try {
    fs.mkdirSync(REC_DIR, { recursive: true });
    const files = fs.readdirSync(REC_DIR)
      .filter(f => f.endsWith('.webm'))
      .map(f => {
        const stat = fs.statSync(path.join(REC_DIR, f));
        return { name: f, size: stat.size, date: stat.mtime };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ recordings: files });
  } catch { res.json({ recordings: [] }); }
});

// Download a recording
app.get('/api/admin/recordings/:file', requireAdmin, (req, res) => {
  const file = path.basename(req.params.file); // prevent path traversal
  const full = path.join(REC_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  res.download(full);
});

app.post('/api/admin/title', requireAdmin, (req, res) => {
  const { title, cover } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  setStreamTitle(title);
  coverUrl = typeof cover === 'string' ? cover.trim() : '';
  djAnnounce(`Now playing: ${title}`);
  res.json({ ok: true, title: getStreamTitle(), coverUrl });
});

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies.token || req.headers['x-token'];
  if (!token) {
    if (req.accepts('html')) return res.redirect('/');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = verifyToken(token);
  if (!user) {
    res.clearCookie('token');
    if (req.accepts('html')) return res.redirect('/');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
  const registered    = new Date(user.registeredAt).getTime();
  const now           = Date.now();
  const trialActive   = (now - registered) < SIX_MONTHS_MS;
  const isPaid        = user.paidUntil && new Date(user.paidUntil).getTime() > now;
  if (!trialActive && !isPaid) {
    if (req.accepts('html')) return res.redirect('/expired.html');
    return res.status(403).json({ error: 'Subscription expired' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const key = req.cookies.adminKey || req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    if (req.accepts('html')) return res.redirect('/admin-login.html');
    return res.status(401).json({ error: 'Admin access denied' });
  }
  next();
}

// ─── HTTP server + WebSocket upgrade ─────────────────────────────────────────
const server = http.createServer(app);

const wssStream = new WebSocket.Server({ noServer: true }); // /ws/stream (DJ)
const wssChat   = new WebSocket.Server({ noServer: true }); // /ws/chat (all)

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://localhost`);

  if (pathname === '/ws/stream') {
    wssStream.handleUpgrade(req, socket, head, (ws) => {
      wssStream.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/chat') {
    wssChat.handleUpgrade(req, socket, head, (ws) => {
      wssChat.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

setupStreamWS(wssStream);
setupChatWS(wssChat);

// ─── RTMP / HLS (node-media-server) ──────────────────────────────────────────
const nmsConfig = {
  rtmp: {
    port:         RTMP_PORT,
    chunk_size:   60000,
    gop_cache:    true,
    ping:         30,
    ping_timeout: 60
  },
  http: {
    port:        8888,
    mediaroot:   HLS_PATH,
    allow_origin: '*'
  },
  trans: {
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    tasks: [
      {
        app:      'live',
        hls:      true,
        hlsFlags: '[hls_time=2:hls_list_size=5:hls_flags=delete_segments]',
        dash:     false
      }
    ]
  }
};

const nms = new NodeMediaServer(nmsConfig);

nms.on('prePublish', (id, StreamPath) => {
  const key = StreamPath.split('/').pop();
  if (key !== STREAM_KEY) {
    nms.getSession(id).reject();
    console.log('[RTMP] Rejected bad stream key:', key);
    return;
  }
  isLive = true;
  console.log('[RTMP] Stream started →', StreamPath);
});

nms.on('donePublish', () => {
  isLive = false;
  viewers.clear();
  console.log('[RTMP] Stream ended');
});

nms.run();

// ─── 404 + Error handlers ─────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.accepts('html')) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message);
  if (req.accepts('html')) return res.status(500).send('<h1 style="font-family:sans-serif;color:#ff4400">500 — Server Error</h1>');
  res.status(500).json({ error: 'Internal server error' });
});

// ─── User data auto-backup ────────────────────────────────────────────────────
const USERS_DB   = path.join(__dirname, 'data', 'users.json');
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');

function backupUsers() {
  if (!fs.existsSync(USERS_DB)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest  = path.join(BACKUP_DIR, `users_${stamp}.json`);
  try {
    fs.copyFileSync(USERS_DB, dest);
    // Keep only last 30 backups
    const all = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('users_') && f.endsWith('.json'))
      .sort();
    if (all.length > 30) {
      all.slice(0, all.length - 30).forEach(f => {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
      });
    }
    console.log('[BACKUP] users.json →', dest);
  } catch (e) { console.error('[BACKUP] Failed:', e.message); }
}

backupUsers();                              // run on startup
setInterval(backupUsers, 24 * 60 * 60 * 1000); // then every 24h

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(HTTP_PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║          DJ STREAM SERVER RUNNING             ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Viewers:  http://localhost:${HTTP_PORT}               ║`);
  console.log(`║  DJ Panel: http://localhost:${HTTP_PORT}/dj.html        ║`);
  console.log(`║  Admin:    http://localhost:${HTTP_PORT}/admin-login.html║`);
  console.log(`║  RTMP in:  rtmp://localhost:${RTMP_PORT}/live/${STREAM_KEY}  ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
