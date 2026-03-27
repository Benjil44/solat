const fs   = require('fs');
const path = require('path');
const { verifyToken, findUser } = require('./users');
const { addRequest, voteRequest, reactRequest, getRequests, getAcceptedQueue } = require('./requests');
const { appendPostBan } = require('./flagged');
const { incrementMessages } = require('./stats');

// Map of ws → { username, isDJ, isAlive, lastMsgAt, msgCount }
const clients = new Map();

const MAX_MSG_LEN  = 200;
const MAX_HISTORY  = 50;
const RATE_MIN_MS  = 500;   // minimum ms between messages per client
const FLOOD_LIMIT  = 10;    // messages within FLOOD_WINDOW_MS → disconnect
const FLOOD_WIN_MS = 5000;  // flood detection window
const chatHistory  = [];    // last N messages for late joiners

// ── Chat history persistence ──────────────────────────────────────────────────
const HISTORY_PATH = path.join(__dirname, '../data/chat-history.json');

// Load saved history on startup
try {
  const saved = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  if (Array.isArray(saved)) chatHistory.push(...saved.slice(-MAX_HISTORY));
} catch {}

// Debounced save — writes at most once every 5 s to avoid excessive I/O
let _saveTimer = null;
function persistHistory() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const tmp = HISTORY_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(chatHistory));
      fs.renameSync(tmp, HISTORY_PATH);
    } catch {}
  }, 5000);
}

// ── Ping/pong keepalive — runs every 30s ──────────────────────────────────────
const PING_INTERVAL_MS = 30_000;

const pingInterval = setInterval(() => {
  for (const [ws, info] of clients) {
    if (!info.isAlive) {
      // Didn't respond to last ping — connection is dead
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    info.isAlive = false;   // reset; set back to true on pong
    try { ws.ping(); } catch (_) { clients.delete(ws); }
  }
}, PING_INTERVAL_MS);

// Prevent the interval from keeping the process alive during shutdown
pingInterval.unref();

function setupChatWS(wss) {
  wss.on('connection', (ws, req) => {
    const url   = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const djKey = url.searchParams.get('djKey');

    let username;
    let isDJ     = false;
    let isGuest  = false;

    // DJ connects with admin key
    if (djKey && djKey === process.env.ADMIN_KEY) {
      username = '🎧 DJ';
      isDJ = true;
    } else if (token) {
      // Regular viewer with JWT
      const payload = verifyToken(token);
      if (!payload) {
        ws.close(4001, 'Invalid token');
        return;
      }
      username = payload.username;
    } else if (process.env.GUEST_WATCH === 'true') {
      // Anonymous guest — receive-only when GUEST_WATCH is enabled
      username = 'Guest';
      isGuest  = true;
    } else {
      ws.close(4001, 'Unauthorized');
      return;
    }

    clients.set(ws, { username, isDJ, isGuest, isAlive: true, lastMsgAt: 0, msgCount: 0, floodWindowStart: 0 });

    // Respond to pong — mark connection alive
    ws.on('pong', () => {
      const info = clients.get(ws);
      if (info) info.isAlive = true;
    });

    // Send recent history to new joiner
    if (chatHistory.length > 0) {
      ws.send(JSON.stringify({ type: 'history', messages: chatHistory }));
    }

    // Announce join (only for named viewers, not DJ or guests)
    if (!isDJ && !isGuest) {
      broadcast({ type: 'system', text: `${username} joined`, time: Date.now() }, ws);
    }

    ws.on('message', (raw) => {
      const info = clients.get(ws);
      if (!info) return;

      // Guests are receive-only — drop all outbound messages silently
      if (info.isGuest) return;

      // ── Rate limiting ──────────────────────────────────────────────────────
      const now = Date.now();

      // Hard rate: minimum gap between messages
      if (now - info.lastMsgAt < RATE_MIN_MS) return;

      // Flood detection: count messages in rolling window
      if (now - info.floodWindowStart > FLOOD_WIN_MS) {
        info.floodWindowStart = now;
        info.msgCount = 0;
      }
      info.msgCount++;
      if (info.msgCount > FLOOD_LIMIT) {
        // Disconnect flooder
        ws.close(4029, 'Message flood detected');
        clients.delete(ws);
        console.warn(`[Chat] Flood disconnect: ${info.username}`);
        return;
      }

      info.lastMsgAt = now;

      // ── Chat ban check ─────────────────────────────────────────────────────
      const freshUser = !isDJ && findUser(username);
      if (freshUser && freshUser.chatBanned) {
        // Log their attempt and inform them — but don't broadcast
        try {
          const raw2 = JSON.parse(String(raw));
          if (raw2.type === 'chat' && raw2.text) {
            appendPostBan(username, String(raw2.text).slice(0, 200), now);
          }
        } catch (_) {}
        try { ws.send(JSON.stringify({ type: 'system', text: '\u26a0 You have been muted by the DJ. You can still request music using the Requests tab.', time: now })); } catch (_) {}
        return;
      }

      // ── Parse and dispatch ────────────────────────────────────────────────
      try {
        const msg = JSON.parse(String(raw));

        // ── Vote via WS (viewer upvotes a request) ─────────────────────────
        if (msg.type === 'vote' && msg.requestId) {
          const result = voteRequest(msg.requestId, username);
          if (result.ok) broadcastRequests();
          return;
        }

        // ── Emoji reaction on a request ────────────────────────────────────
        if (msg.type === 'react' && msg.requestId && msg.emoji) {
          const result = reactRequest(msg.requestId, msg.emoji, username);
          if (result.ok) broadcastRequests();
          return;
        }

        // ── Floating chat reaction (visual effect for all viewers) ─────────
        if (msg.type === 'reaction' && msg.emoji) {
          const ALLOWED = ['🔥', '❤️', '🎵', '👏'];
          if (ALLOWED.includes(msg.emoji)) {
            broadcast({ type: 'reaction', emoji: msg.emoji }, null);
          }
          return;
        }

        if (msg.type !== 'chat') return;

        const text = String(msg.text || '').trim().slice(0, MAX_MSG_LEN);
        if (!text) return;

        // ── /request command ───────────────────────────────────────────────
        if (text.startsWith('/request ')) {
          const title = text.slice(9).trim();
          if (!title) return;
          const result = addRequest(username, title);
          if (result.error) {
            try { ws.send(JSON.stringify({ type: 'system', text: `\u26a0 ${result.error}`, time: now })); } catch (_) {}
            return;
          }
          const sysMsg = result.autoVoted
            ? { type: 'system', text: `${username} upvoted: \u201c${result.request.title}\u201d`, time: now }
            : { type: 'system', text: `\ud83c\udfb5 ${username} requested: \u201c${title}\u201d`, time: now };
          addToHistory(sysMsg);
          broadcast(sysMsg, null);
          broadcastRequests();
          return;
        }

        const out = {
          type: 'chat',
          username,
          isDJ,
          text,
          time: now
        };

        addToHistory(out);
        broadcast(out, null); // send to everyone including sender
        incrementMessages();
      } catch {}
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (!isDJ && !isGuest) {
        broadcast({ type: 'system', text: `${username} left`, time: Date.now() }, null);
      }
    });

    ws.on('error', () => clients.delete(ws));
  });
}

function broadcast(msg, skipWs) {
  const data = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws !== skipWs && ws.readyState === 1 /* OPEN */) {
      ws.send(data);
    }
  }
}

function addToHistory(msg) {
  chatHistory.push(msg);
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
  persistHistory();
}

function getChatClientCount() {
  return clients.size;
}

// DJ can push a system message (e.g. "Now playing: Track X")
function djAnnounce(text) {
  const msg = { type: 'system', text: `🎧 DJ: ${text}`, time: Date.now() };
  addToHistory(msg);
  broadcast(msg, null);
}

/** Push the current request list + play queue to every connected client. */
function broadcastRequests() {
  const data = JSON.stringify({ type: 'requests', requests: getRequests(), queue: getAcceptedQueue() });
  for (const [ws] of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(data); } catch (_) {}
    }
  }
}

/** Send any message to every connected client (used for next-track broadcasts etc). */
function broadcastAll(msg) {
  broadcast(msg, null);
}

/** Returns recent chat messages from a specific user (for pre-ban capture). */
function getChatHistoryForUser(username, limit = 30) {
  return chatHistory
    .filter(m => m.type === 'chat' && m.username === username)
    .slice(-limit);
}

module.exports = { setupChatWS, getChatClientCount, djAnnounce, broadcastRequests, broadcastAll, getChatHistoryForUser };
