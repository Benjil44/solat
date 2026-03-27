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
const helmet      = require('helmet');
const authRoutes    = require('./src/auth');
const adminRoutes   = require('./src/admin');
const paymentRoutes = require('./src/payment');
const { verifyToken, findUser } = require('./src/users');
const { setupStreamWS, getStreamTitle, setStreamTitle, isBrowserLive, getCurrentRecording, getSessionStartTime, getSetlist, stopFFmpegOnExit, getSessionHistory } = require('./src/stream-ws');
const { setupChatWS, getChatClientCount, djAnnounce, broadcastRequests, broadcastAll, getChatHistoryForUser } = require('./src/chat-ws');
const { learnTrack: _learn, suggest, submitCorrection, acceptCorrection, rejectCorrection, getCorrections, getDB: getMusicDB, manualAddTrack, removeTrack: removeDBTrack } = require('./src/music-db');
const { getWords: getFilterWords, addWord: addFilterWord, removeWord: removeFilterWord } = require('./src/wordfilter');
const { setChatBan } = require('./src/users');
const { banRecord, clearRecord: clearFlagged, getAll: getAllFlagged } = require('./src/flagged');
const { addRequest, voteRequest, reactRequest, setStatus: setReqStatus, removeRequest, clearFinished, getRequests, getTrending, cleanupExpired, moveRequest, getAcceptedQueue } = require('./src/requests');
const { resetStats, recordViewerCount, getStats } = require('./src/stats');
const { saveSub, removeSub, notifyLive, notifyNextTrack, notifyRequestAccepted } = require('./src/push');
const { updatePushPrefs, getPushPrefs } = require('./src/users');
const { logAudit, getAuditLog } = require('./src/audit');
const { updatePassword } = require('./src/users');
const bcrypt = require('bcryptjs');

// ─── Discord webhook ──────────────────────────────────────────────────────────
function _discordPost(body) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    const u = new URL(webhookUrl);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    req.on('error', () => {}); req.write(body); req.end();
  } catch {}
}

function notifyDiscord(streamTitle) {
  _discordPost(JSON.stringify({
    content: null,
    embeds: [{
      title: '🎧 DJ is LIVE',
      description: streamTitle ? `Now playing: **${streamTitle}**` : 'The stream has started!',
      color: 0xff4400,
      url: process.env.SITE_URL || undefined,
      timestamp: new Date().toISOString(),
    }]
  }));
}

function notifyDiscordOffline() {
  _discordPost(JSON.stringify({
    content: null,
    embeds: [{ title: '🔴 DJ went offline', color: 0x333333, timestamp: new Date().toISOString() }]
  }));
}

// ─── DJ Schedule ──────────────────────────────────────────────────────────────
const SCHEDULE_PATH = path.join(__dirname, 'data', 'schedule.json');

function getSchedule() {
  try {
    const d = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
    // Expire past schedules automatically
    if (d.scheduledAt && new Date(d.scheduledAt).getTime() < Date.now() - 30 * 60 * 1000) {
      if (d.repeat) {
        // Auto-advance by 7 days until the next occurrence is in the future
        let next = new Date(d.scheduledAt).getTime();
        while (next < Date.now() - 30 * 60 * 1000) {
          next += 7 * 24 * 60 * 60 * 1000;
        }
        const nextISO = new Date(next).toISOString();
        saveSchedule({ scheduledAt: nextISO, repeat: true });
        return { scheduledAt: nextISO, repeat: true };
      }
      clearSchedule();
      return null;
    }
    return d;
  } catch { return null; }
}

function saveSchedule(data) {
  fs.mkdirSync(path.dirname(SCHEDULE_PATH), { recursive: true });
  fs.writeFileSync(SCHEDULE_PATH + '.tmp', JSON.stringify(data));
  fs.renameSync(SCHEDULE_PATH + '.tmp', SCHEDULE_PATH);
}

function clearSchedule() {
  try { fs.unlinkSync(SCHEDULE_PATH); } catch {}
}

// ─── Config ───────────────────────────────────────────────────────────────────
const HTTP_PORT  = process.env.PORT       || 3000;
const RTMP_PORT  = 1935;
let STREAM_KEY = process.env.STREAM_KEY || 'djlive';
const HLS_PATH   = path.join(__dirname, 'media');

// ─── Startup env validation ───────────────────────────────────────────────────
const REQUIRED_ENV  = ['JWT_SECRET', 'ADMIN_KEY', 'STREAM_KEY'];
const missingEnv    = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error('\n[FATAL] Missing required environment variables:', missingEnv.join(', '));
  console.error('[FATAL] Set them in your .env file — server will not start.\n');
  process.exit(1);
}
if (process.env.JWT_SECRET === 'dj-stream-secret-change-me-in-production') {
  const suggest = require('crypto').randomBytes(32).toString('hex');
  console.error('\n[FATAL] JWT_SECRET is using the default insecure value.');
  console.error('[FATAL] Add this to your .env:  JWT_SECRET=' + suggest + '\n');
  process.exit(1);
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // trust Cloudflare / reverse proxy for req.ip and req.secure

// Stripe webhook needs raw body for signature verification — must come BEFORE express.json()
app.use('/payment/webhook', express.raw({ type: 'application/json' }));

// Security headers — CSP disabled until inline scripts are replaced with nonces
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CORS — only allow configured origin; blocks all cross-origin if ALLOWED_ORIGIN is unset
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
app.use(cors(ALLOWED_ORIGIN
  ? { origin: ALLOWED_ORIGIN, credentials: true }
  : { origin: false }
));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
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
app.use('/auth',    authRoutes);
app.use('/admin',   adminRoutes);
app.use('/payment', paymentRoutes);

// ─── Live state ───────────────────────────────────────────────────────────────
let isLive         = false;
let coverUrl       = '';
let nextTrackTitle = '';
let nextTrackCover = '';

// Viewer heartbeat map: username → timestamp
const viewers = new Map();

const heartbeatLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
app.post('/api/heartbeat', heartbeatLimiter, requireAuth, (req, res) => {
  viewers.set(req.user.username, Date.now());
  res.json({ ok: true });
});

let _wasLive = false;
setInterval(() => {
  const cutoff = Date.now() - 30_000;
  for (const [k, t] of viewers) { if (t < cutoff) viewers.delete(k); }
  const nowLive = isLive || isBrowserLive();
  if (nowLive && !_wasLive) {
    resetStats();
    notifyLive(getStreamTitle()).catch(() => {});
    notifyDiscord(getStreamTitle());
    clearSchedule();
  } else if (!nowLive && _wasLive) {
    notifyDiscordOffline();
  }
  _wasLive = nowLive;
  recordViewerCount(viewers.size);
}, 10_000);

// ─── Public APIs ──────────────────────────────────────────────────────────────
// ─── Health check (no auth — safe for uptime monitors) ───────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:  'ok',
    uptime:  Math.floor(process.uptime()),
    live:    isLive || isBrowserLive(),
    viewers: viewers.size,
    memMB:   Math.round(process.memoryUsage().rss / 1024 / 1024),
    version: require('./package.json').version,
  });
});

// Tells the register page whether an invite code is required
app.get('/api/invite-mode', (req, res) => {
  res.json({ inviteOnly: process.env.INVITE_ONLY === 'true' });
});

// No-auth live check — safe to expose (no stream key, no user data, no stream URL)
app.get('/api/live', (req, res) => {
  const sched = getSchedule();
  res.json({
    live:        isLive || isBrowserLive(),
    viewers:     viewers.size,
    title:       getStreamTitle(),
    coverUrl:    coverUrl || null,
    nextTrack:   nextTrackTitle || null,
    nextCover:   nextTrackCover || null,
    scheduledAt: sched ? sched.scheduledAt : null,
  });
});

app.get('/api/status', requireAuth, (req, res) => {
  res.json({
    live:      isLive || isBrowserLive(),
    streamKey: STREAM_KEY,
    title:     getStreamTitle(),
    coverUrl,
    viewers:   viewers.size,
    nextTrack: nextTrackTitle || null,
    nextCover: nextTrackCover || null,
  });
});

// HLS segments — auth required unless GUEST_WATCH=true is set
// When guest watch is enabled anyone can view the stream without an account
// Rate limit unauthenticated /live requests (guests) — 120 segments/min ≈ 4 concurrent streams
const hlsGuestLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  skip: (req) => !!(req.cookies && req.cookies.token), // skip for logged-in users
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

app.use('/live', hlsGuestLimiter, (req, res, next) => {
  if (process.env.GUEST_WATCH !== 'true') return requireAuth(req, res, next);
  next();
}, (req, res, next) => {
  if (req.path.endsWith('.m3u8') || req.path.endsWith('.ts')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
}, express.static(HLS_PATH));

// ─── Viewer history (sampled every 30s, kept for 2h) ─────────────────────────
const viewerHistory = []; // [{ t: timestamp, v: count }]
setInterval(() => {
  viewerHistory.push({ t: Date.now(), v: viewers.size });
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  while (viewerHistory.length && viewerHistory[0].t < cutoff) viewerHistory.shift();
}, 30_000).unref();

// ─── Admin APIs ───────────────────────────────────────────────────────────────
app.get('/api/admin/live-stats', requireAdmin, (req, res) => {
  const stats = getStats();
  const start = stats.sessionStart || getSessionStartTime();
  const durationSec = start ? Math.floor((Date.now() - new Date(start).getTime()) / 1000) : 0;
  res.json({
    live:          isLive || isBrowserLive(),
    viewers:       viewers.size,
    peakViewers:   stats.peakViewers,
    totalMessages: stats.totalMessages,
    totalRequests: stats.totalRequests,
    durationSec,
    topRequested:  getTrending(5),
  });
});

app.get('/api/admin/viewer-history', requireAdmin, (req, res) => {
  // Also include current snapshot
  const now = [{ t: Date.now(), v: viewers.size }];
  res.json({ history: [...viewerHistory, ...now] });
});

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

// Setlist for current live session
app.get('/api/admin/setlist', requireAdmin, (req, res) => {
  res.json({ setlist: getSetlist(), sessionStart: getSessionStartTime() });
});

// Full session history (persisted across restarts)
app.get('/api/admin/session-history', requireAdmin, (req, res) => {
  res.json({ sessions: getSessionHistory() });
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

// Delete a recording
app.delete('/api/admin/recordings/:file', requireAdmin, (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(REC_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(full); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/title', requireAdmin, (req, res) => {
  const { title, cover } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  setStreamTitle(title);
  coverUrl = typeof cover === 'string' ? cover.trim() : '';
  logAudit('admin', 'set-title', { title });
  // Clear next-track when the current track is set
  nextTrackTitle = '';
  nextTrackCover = '';
  broadcastAll({ type: 'next-track', title: null, cover: null });
  djAnnounce(`Now playing: ${title}`);
  res.json({ ok: true, title: getStreamTitle(), coverUrl });
});

// DJ announces the upcoming track to viewers
app.post('/api/admin/next-track', requireAdmin, (req, res) => {
  const { title, cover } = req.body;
  nextTrackTitle = typeof title === 'string' ? title.trim().slice(0, 120) : '';
  nextTrackCover = typeof cover === 'string' ? cover.trim() : '';
  broadcastAll({ type: 'next-track', title: nextTrackTitle || null, cover: nextTrackCover || null });
  if (nextTrackTitle) notifyNextTrack(nextTrackTitle).catch(() => {});
  res.json({ ok: true });
});

// ─── User profile ─────────────────────────────────────────────────────────────
app.get('/api/profile', requireAuth, (req, res) => {
  const user = req.user;
  const now  = Date.now();
  const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
  const registered    = new Date(user.registeredAt).getTime();
  const trialActive   = (now - registered) < SIX_MONTHS_MS;
  const isPaid        = user.paidUntil && new Date(user.paidUntil).getTime() > now;
  let subType, daysLeft;
  if (isPaid) {
    subType  = 'paid';
    daysLeft = Math.ceil((new Date(user.paidUntil).getTime() - now) / 86400000);
  } else if (trialActive) {
    subType  = 'trial';
    daysLeft = Math.ceil((SIX_MONTHS_MS - (now - registered)) / 86400000);
  } else {
    subType  = 'expired';
    daysLeft = 0;
  }
  const allUserReqs = getRequests().filter(r => r.requestedBy === user.username);
  const userRequests = allUserReqs.map(r => ({ id: r.id, title: r.title, status: r.status, votes: r.votes, requestedAt: r.requestedAt }));
  const stats = {
    total:    allUserReqs.length,
    pending:  allUserReqs.filter(r => r.status === 'pending').length,
    accepted: allUserReqs.filter(r => r.status === 'accepted').length,
    played:   allUserReqs.filter(r => r.status === 'played').length,
    rejected: allUserReqs.filter(r => r.status === 'rejected').length,
  };
  res.json({
    user: { username: user.username, subType, daysLeft, registeredAt: user.registeredAt, avatar: user.avatar || '', pushPrefs: getPushPrefs(user.username) },
    requests: userRequests,
    stats,
  });
});

// ─── Viewer Clips ─────────────────────────────────────────────────────────────
const CLIPS_PATH = path.join(__dirname, 'data', 'clips.json');

function loadClips() {
  try { return JSON.parse(fs.readFileSync(CLIPS_PATH, 'utf8')); } catch { return {}; }
}
function saveClips(clips) {
  fs.mkdirSync(path.dirname(CLIPS_PATH), { recursive: true });
  const tmp = CLIPS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clips));
  fs.renameSync(tmp, CLIPS_PATH);
}

app.post('/api/clips', requireAuth, (req, res) => {
  const clips = loadClips();
  const username = req.user.username;
  if (!clips[username]) clips[username] = [];
  if (clips[username].length >= 50) clips[username].shift(); // cap at 50
  clips[username].push({
    clipAt:   new Date().toISOString(),
    title:    getStreamTitle() || 'Unknown',
    isLive:   isLive || isBrowserLive(),
  });
  saveClips(clips);
  res.json({ ok: true });
});

app.get('/api/clips', requireAuth, (req, res) => {
  const clips = loadClips();
  res.json({ clips: (clips[req.user.username] || []).slice().reverse() });
});

app.delete('/api/clips/:idx', requireAuth, (req, res) => {
  const clips = loadClips();
  const username = req.user.username;
  const list = clips[username] || [];
  // idx is from reversed list — convert back
  const revIdx = parseInt(req.params.idx, 10);
  if (isNaN(revIdx)) return res.status(400).json({ error: 'Invalid index' });
  const realIdx = list.length - 1 - revIdx;
  if (realIdx < 0 || realIdx >= list.length) return res.status(404).json({ error: 'Not found' });
  list.splice(realIdx, 1);
  clips[username] = list;
  saveClips(clips);
  res.json({ ok: true });
});

// ─── Push Notifications ───────────────────────────────────────────────────────
// Return the VAPID public key so clients can subscribe
app.get('/api/push/vapid-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push notifications not configured' });
  res.json({ publicKey: key });
});

// Save a push subscription for the logged-in user
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  saveSub(req.user.username, sub);
  res.json({ ok: true });
});

// Remove the push subscription for the logged-in user
app.delete('/api/push/subscribe', requireAuth, (req, res) => {
  removeSub(req.user.username);
  res.json({ ok: true });
});

app.get('/api/push/prefs', requireAuth, (req, res) => {
  res.json(getPushPrefs(req.user.username) || { goLive: true, nextTrack: false, requestAccepted: false });
});

app.post('/api/push/prefs', requireAuth, (req, res) => {
  const { goLive, nextTrack, requestAccepted } = req.body;
  const updated = updatePushPrefs(req.user.username, {
    goLive:           typeof goLive === 'boolean'           ? goLive           : undefined,
    nextTrack:        typeof nextTrack === 'boolean'        ? nextTrack        : undefined,
    requestAccepted:  typeof requestAccepted === 'boolean'  ? requestAccepted  : undefined,
  });
  res.json({ ok: true, prefs: updated });
});

// ─── DJ Schedule ──────────────────────────────────────────────────────────────
// Public: viewers poll this to show go-live countdown
app.get('/api/schedule', (req, res) => {
  const s = getSchedule();
  res.json(s || { scheduledAt: null });
});

// Admin: set or clear the schedule
app.post('/api/admin/schedule', requireAdmin, (req, res) => {
  const { scheduledAt, repeat } = req.body; // ISO string or null
  if (!scheduledAt) {
    clearSchedule();
    return res.json({ ok: true, scheduledAt: null });
  }
  const ts = new Date(scheduledAt).getTime();
  if (isNaN(ts)) return res.status(400).json({ error: 'Invalid date' });
  saveSchedule({ scheduledAt, repeat: !!repeat });
  res.json({ ok: true, scheduledAt, repeat: !!repeat });
});

// ─── Admin: password reset ────────────────────────────────────────────────────
app.post('/api/admin/reset-password/:username', requireAdmin, async (req, res) => {
  const { username } = req.params;
  if (!findUser(username)) return res.status(404).json({ error: 'User not found' });
  const tempPass = require('crypto').randomBytes(5).toString('hex'); // 10-char hex
  const hashed   = await bcrypt.hash(tempPass, 10);
  updatePassword(username, hashed);
  logAudit('admin', 'reset-password', { username });
  res.json({ ok: true, tempPassword: tempPass });
});

// ─── Admin: audit log ────────────────────────────────────────────────────────
app.get('/api/admin/audit', requireAdmin, (req, res) => {
  res.json({ log: getAuditLog(200) });
});

// ─── Admin: word filter ───────────────────────────────────────────────────────
app.get('/api/admin/wordfilter', requireAdmin, (req, res) => {
  res.json({ words: getFilterWords() });
});

app.post('/api/admin/wordfilter', requireAdmin, (req, res) => {
  const { word } = req.body;
  if (!word || !String(word).trim()) return res.status(400).json({ error: 'Word required' });
  const added = addFilterWord(word);
  if (!added) return res.status(409).json({ error: 'Word already in list' });
  logAudit('admin', 'wordfilter-add', { word: String(word).trim().toLowerCase() });
  res.json({ ok: true });
});

app.delete('/api/admin/wordfilter/:word', requireAdmin, (req, res) => {
  const removed = removeFilterWord(decodeURIComponent(req.params.word));
  if (!removed) return res.status(404).json({ error: 'Word not found' });
  logAudit('admin', 'wordfilter-remove', { word: req.params.word });
  res.json({ ok: true });
});

// ─── Admin: music DB management ───────────────────────────────────────────────
app.get('/api/admin/music-db/search', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json({ results: [] });
  const results = getMusicDB()
    .filter(t => t.canonical.toLowerCase().includes(q))
    .slice(0, 20);
  res.json({ results });
});

app.post('/api/admin/music-db/add', requireAdmin, (req, res) => {
  const { title, aliases } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required' });
  manualAddTrack(String(title).trim(), Array.isArray(aliases) ? aliases : []);
  logAudit('admin', 'music-db-add', { title });
  res.json({ ok: true });
});

app.delete('/api/admin/music-db/entry/:title', requireAdmin, (req, res) => {
  const title = decodeURIComponent(req.params.title);
  const ok = removeDBTrack(title);
  if (!ok) return res.status(404).json({ error: 'Track not found' });
  logAudit('admin', 'music-db-remove', { title });
  res.json({ ok: true });
});

// ─── Admin: test push notification ───────────────────────────────────────────
app.post('/api/admin/push-test', requireAdmin, async (req, res) => {
  try {
    await notifyLive('Test — push notifications are working!');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: stream key management ────────────────────────────────────────────
const ENV_PATH = path.join(__dirname, '.env');

app.get('/api/admin/stream-key', requireAdmin, (req, res) => {
  res.json({ key: STREAM_KEY });
});

app.post('/api/admin/rotate-stream-key', requireAdmin, (req, res) => {
  const newKey = require('crypto').randomBytes(12).toString('hex');
  STREAM_KEY = newKey;
  // Update .env file so new key survives restarts
  try {
    if (fs.existsSync(ENV_PATH)) {
      let env = fs.readFileSync(ENV_PATH, 'utf8');
      if (/^STREAM_KEY=/m.test(env)) {
        env = env.replace(/^STREAM_KEY=.*/m, `STREAM_KEY=${newKey}`);
      } else {
        env += `\nSTREAM_KEY=${newKey}`;
      }
      fs.writeFileSync(ENV_PATH, env);
    }
  } catch (e) { console.warn('[stream-key] Could not update .env:', e.message); }
  logAudit('admin', 'rotate-stream-key', {});
  res.json({ key: newKey });
});

// ─── Track Requests ───────────────────────────────────────────────────────────
// Viewer: get current request list + accepted play queue
app.get('/api/requests', requireAuthOrAdmin, (req, res) => {
  res.json({ requests: getRequests(), queue: getAcceptedQueue() });
});

// Viewer: submit a request (rate-limited in requests.js — 1 per 3 min)
app.post('/api/requests', requireAuth, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required' });
  const result = addRequest(req.user.username, title);
  if (result.error) return res.status(429).json({ error: result.error });
  broadcastRequests();
  res.json(result);
});

// Viewer: toggle vote on a request
app.post('/api/requests/:id/vote', requireAuth, (req, res) => {
  const result = voteRequest(req.params.id, req.user.username);
  if (result.error) return res.status(404).json(result);
  broadcastRequests();
  res.json(result);
});

// DJ/Admin: change request status (accepted | played | rejected | pending)
app.patch('/api/requests/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['pending', 'accepted', 'played', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  // Capture request details before status change for notification
  const reqItem = getRequests().find(r => r.id === req.params.id);
  const ok = setReqStatus(req.params.id, status);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  broadcastRequests();
  // Notify requester if they opted in to request-accepted notifications
  if (status === 'accepted' && reqItem) {
    notifyRequestAccepted(reqItem.requestedBy, reqItem.title).catch(() => {});
  }
  res.json({ ok: true });
});

// DJ/Admin: delete a single request
app.delete('/api/requests/:id', requireAdmin, (req, res) => {
  const ok = removeRequest(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  broadcastRequests();
  res.json({ ok: true });
});

// DJ/Admin: reorder accepted request in the play queue
app.patch('/api/requests/:id/move', requireAdmin, (req, res) => {
  const { direction } = req.body;
  if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'direction must be up or down' });
  const ok = moveRequest(req.params.id, direction);
  if (!ok) return res.status(404).json({ error: 'Not found or cannot move' });
  broadcastRequests();
  res.json({ ok: true });
});

// DJ/Admin: clear all played/rejected from the list
app.delete('/api/requests', requireAdmin, (req, res) => {
  clearFinished();
  broadcastRequests();
  res.json({ ok: true });
});

// All-time trending
app.get('/api/trending', requireAuthOrAdmin, (req, res) => {
  res.json({ trending: getTrending() });
});

// Spelling suggestions (debounced from client — no rate limit needed, read-only)
app.get('/api/requests/suggest', requireAuthOrAdmin, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ suggestions: [] });
  res.json({ suggestions: suggest(q) });
});

// ─── Music DB / Corrections ───────────────────────────────────────────────────
// DJ submits a spelling correction for admin review
app.post('/api/music-db/corrections', requireAdmin, (req, res) => {
  const { original, canonical } = req.body;
  if (!original || !canonical) return res.status(400).json({ error: 'original and canonical required' });
  const correction = submitCorrection(original.trim(), canonical.trim(), 'DJ');
  res.json({ ok: true, correction });
});

// Admin sees pending corrections
app.get('/api/music-db/corrections', requireAdmin, (req, res) => {
  res.json({ corrections: getCorrections(req.query.status || undefined) });
});

// Admin accepts a correction — teaches the music DB
app.patch('/api/music-db/corrections/:id/accept', requireAdmin, (req, res) => {
  const ok = acceptCorrection(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found or already resolved' });
  res.json({ ok: true });
});

// Admin rejects a correction
app.patch('/api/music-db/corrections/:id/reject', requireAdmin, (req, res) => {
  const ok = rejectCorrection(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found or already resolved' });
  res.json({ ok: true });
});

// Admin: export music DB as CSV
app.get('/api/admin/music-db/export.csv', requireAdmin, (req, res) => {
  const rows = getMusicDB();
  const csv = [
    'title,plays,score,aliases',
    ...rows.map(r => [
      `"${String(r.canonical).replace(/"/g, '""')}"`,
      r.plays  || 0,
      r.score  || 0,
      `"${(r.aliases || []).join('; ').replace(/"/g, '""')}"`,
    ].join(','))
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="music-db.csv"');
  res.send(csv);
});

// Viewer: add/toggle emoji reaction on a request
app.post('/api/requests/:id/react', requireAuth, (req, res) => {
  const { emoji } = req.body;
  const result = reactRequest(req.params.id, emoji, req.user.username);
  if (result.error) return res.status(400).json(result);
  broadcastRequests();
  res.json(result);
});

// ─── Chat moderation ──────────────────────────────────────────────────────────
// DJ mutes a user from chat (they can still request music)
app.post('/api/admin/chat-ban/:username', requireAdmin, (req, res) => {
  const { username } = req.params;
  const ok = setChatBan(username, true);
  if (!ok) return res.status(404).json({ error: 'User not found' });
  const history = getChatHistoryForUser(username);
  banRecord(username, 'DJ', history);
  logAudit('admin', 'chat-ban', { username });
  djAnnounce(`${username} has been muted.`);
  res.json({ ok: true, username });
});

// Admin unmutes a user
app.delete('/api/admin/chat-ban/:username', requireAdmin, (req, res) => {
  const { username } = req.params;
  const ok = setChatBan(username, false);
  if (!ok) return res.status(404).json({ error: 'User not found' });
  clearFlagged(username);
  logAudit('admin', 'chat-unban', { username });
  djAnnounce(`${username} has been unmuted.`);
  res.json({ ok: true, username });
});

// Admin sees all flagged messages (from muted users)
app.get('/api/admin/flagged-messages', requireAdmin, (req, res) => {
  res.json({ flagged: getAllFlagged() });
});

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies.token || req.headers['x-token'];
  if (!token) {
    if (req.accepts('html')) return res.redirect('/');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.clearCookie('token');
    if (req.accepts('html')) return res.redirect('/');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // Re-fetch from DB so subscription changes (admin extends, payment webhook) take effect
  // immediately without requiring the user to re-login.
  const freshUser = findUser(payload.username);
  if (!freshUser) {
    res.clearCookie('token');
    if (req.accepts('html')) return res.redirect('/');
    return res.status(401).json({ error: 'User not found' });
  }
  if (freshUser.suspended) {
    res.clearCookie('token');
    if (req.accepts('html')) return res.redirect('/');
    return res.status(403).json({ error: 'Account suspended' });
  }
  const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
  const registered    = new Date(freshUser.registeredAt).getTime();
  const now           = Date.now();
  const trialActive   = (now - registered) < SIX_MONTHS_MS;
  const isPaid        = freshUser.paidUntil && new Date(freshUser.paidUntil).getTime() > now;
  if (!trialActive && !isPaid) {
    if (req.accepts('html')) return res.redirect('/expired.html');
    return res.status(403).json({ error: 'Subscription expired' });
  }
  req.user = freshUser;
  next();
}

// Accepts either a valid user token OR the admin key
function requireAuthOrAdmin(req, res, next) {
  const key = req.cookies.adminKey || req.headers['x-admin-key'];
  if (key && key === process.env.ADMIN_KEY) return next();
  return requireAuth(req, res, next);
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

const wssStream = new WebSocket.Server({ noServer: true, maxPayload: 5 * 1024 * 1024 }); // /ws/stream (DJ) — 5 MB max chunk
const wssChat   = new WebSocket.Server({ noServer: true, maxPayload: 4 * 1024 });         // /ws/chat (all) — 4 KB max message

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
    host:        '127.0.0.1',   // bind to localhost only — raw HLS not exposed publicly
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
  resetStats();
  notifyLive(getStreamTitle()).catch(() => {});
  notifyDiscord(getStreamTitle());
  clearSchedule();
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

const BACKUP_FILES = ['users', 'music-db', 'trending', 'corrections', 'session-history', 'flagged-messages'];

function backupUsers() {
  const DATA_DIR = path.join(__dirname, 'data');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  for (const name of BACKUP_FILES) {
    const src  = path.join(DATA_DIR, `${name}.json`);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(BACKUP_DIR, `${name}_${stamp}.json`);
    try {
      fs.copyFileSync(src, dest);
      // Keep only last 30 daily backups for this file
      const all = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith(`${name}_`) && f.endsWith('.json'))
        .sort();
      if (all.length > 30) {
        all.slice(0, all.length - 30).forEach(f => {
          try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
        });
      }
    } catch (e) { console.error(`[BACKUP] ${name}.json failed:`, e.message); }
  }
  console.log('[BACKUP] daily backup complete');
}

backupUsers();                              // run on startup
setInterval(backupUsers, 24 * 60 * 60 * 1000); // then every 24h

// Expire stale requests every 5 minutes
setInterval(() => {
  if (cleanupExpired()) broadcastRequests();
}, 5 * 60 * 1000).unref();

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal} — stopping server gracefully...`);
  stopFFmpegOnExit();     // end any live FFmpeg / recording session cleanly
  server.close(() => {
    console.log('[SHUTDOWN] HTTP server closed.');
    process.exit(0);
  });
  // Force-exit if still running after 8 s (e.g. hung WebSocket connections)
  setTimeout(() => { console.error('[SHUTDOWN] Forced exit after timeout'); process.exit(1); }, 8000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

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
