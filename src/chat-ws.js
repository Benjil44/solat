const { verifyToken } = require('./users');

// Map of ws → { username, isDJ }
const clients = new Map();

const MAX_MSG_LEN = 200;
const MAX_HISTORY = 50;
const chatHistory = []; // last N messages for late joiners

function setupChatWS(wss) {
  wss.on('connection', (ws, req) => {
    const url   = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const djKey = url.searchParams.get('djKey');

    let username;
    let isDJ = false;

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
    } else {
      ws.close(4001, 'Unauthorized');
      return;
    }

    clients.set(ws, { username, isDJ });

    // Send recent history to new joiner
    if (chatHistory.length > 0) {
      ws.send(JSON.stringify({ type: 'history', messages: chatHistory }));
    }

    // Announce join (only for viewers, not DJ)
    if (!isDJ) {
      broadcast({ type: 'system', text: `${username} joined`, time: Date.now() }, ws);
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type !== 'chat') return;

        const text = String(msg.text || '').trim().slice(0, MAX_MSG_LEN);
        if (!text) return;

        const out = {
          type: 'chat',
          username,
          isDJ,
          text,
          time: Date.now()
        };

        addToHistory(out);
        broadcast(out, null); // send to everyone including sender
      } catch {}
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (!isDJ) {
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

module.exports = { setupChatWS, getChatClientCount, djAnnounce };
