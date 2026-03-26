const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { learnTrack } = require('./music-db');
const { incrementRequests } = require('./stats');

const TRENDING_PATH    = path.join(__dirname, '../data/trending.json');
const MAX_PENDING        = 30;
const REQUEST_COOLDOWN   = 3 * 60 * 1000;   // 3 min between requests per user
const REQUEST_TIMEOUT    = 2 * 60 * 60 * 1000; // pending requests expire after 2h
const ALLOWED_REACTIONS  = ['🔥', '❤️', '👏'];

let _requests      = [];
let _acceptedOrder = [];           // ordered IDs of accepted requests (play queue)
const _lastRequest = new Map();   // username → timestamp
let _trending      = _loadTrending();

function _loadTrending() {
  try { return JSON.parse(fs.readFileSync(TRENDING_PATH, 'utf8')); } catch { return {}; }
}

function _saveTrending() {
  try {
    fs.mkdirSync(path.dirname(TRENDING_PATH), { recursive: true });
    const tmp = TRENDING_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_trending, null, 2), 'utf8');
    fs.renameSync(tmp, TRENDING_PATH);
  } catch (_) {}
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add a new request from a viewer.
 * If the same title is already pending/accepted, auto-upvote it instead.
 */
function addRequest(username, title) {
  title = title.trim().slice(0, 100);
  if (!title) return { error: 'Title cannot be empty' };

  const now  = Date.now();
  const last = _lastRequest.get(username) || 0;
  if (now - last < REQUEST_COOLDOWN) {
    const wait = Math.ceil((REQUEST_COOLDOWN - (now - last)) / 1000);
    return { error: `Wait ${wait}s before requesting again` };
  }

  // Duplicate active request → auto-upvote instead of duplicate entry
  const dup = _requests.find(r =>
    (r.status === 'pending' || r.status === 'accepted') &&
    r.title.toLowerCase() === title.toLowerCase()
  );
  if (dup) {
    const v = voteRequest(dup.id, username);
    _lastRequest.set(username, now);
    return { ok: true, autoVoted: true, request: dup, voted: v.voted };
  }

  const active = _requests.filter(r => r.status === 'pending' || r.status === 'accepted').length;
  if (active >= MAX_PENDING) return { error: 'Request queue is full — try again later' };

  _lastRequest.set(username, now);
  const req = {
    id:          uuidv4(),
    title,
    requestedBy: username,
    requestedAt: new Date().toISOString(),
    votes:       1,
    voters:      [username],
    status:      'pending',   // pending | accepted | played | rejected
    reactions:   {}           // { '🔥': ['user1'], '❤️': ['user2'] }
  };
  _requests.unshift(req);
  incrementRequests();
  return { ok: true, request: req };
}

/**
 * Toggle a vote on a request.
 * The original requester's vote is permanent (they always count).
 */
function voteRequest(id, username) {
  const req = _requests.find(r => r.id === id);
  if (!req) return { error: 'Request not found' };
  if (req.status !== 'pending' && req.status !== 'accepted') {
    return { error: 'Cannot vote on this request' };
  }
  // Requester can't un-vote their own request
  if (req.requestedBy === username) return { ok: true, voted: true, votes: req.votes };

  const idx = req.voters.indexOf(username);
  if (idx !== -1) {
    req.voters.splice(idx, 1);
  } else {
    req.voters.push(username);
  }
  req.votes = req.voters.length;
  return { ok: true, voted: idx === -1, votes: req.votes };
}

/** DJ changes the status of a request. 'played'/'accepted' teaches the music DB. */
function setStatus(id, status) {
  const req = _requests.find(r => r.id === id);
  if (!req) return false;
  const prev = req.status;
  req.status = status;
  // Maintain accepted order queue
  if (status === 'accepted' && prev !== 'accepted') {
    if (!_acceptedOrder.includes(id)) _acceptedOrder.push(id);
  } else if (status !== 'accepted' && prev === 'accepted') {
    _acceptedOrder = _acceptedOrder.filter(i => i !== id);
  }
  if (status === 'played') {
    const key = req.title.toLowerCase();
    _trending[key] = (_trending[key] || 0) + req.votes;
    _saveTrending();
    learnTrack(req.title, { played: true, votes: req.votes });
  } else if (status === 'accepted') {
    learnTrack(req.title, { played: false });
  }
  return true;
}

/** DJ removes a single request. */
function removeRequest(id) {
  const before = _requests.length;
  _requests      = _requests.filter(r => r.id !== id);
  _acceptedOrder = _acceptedOrder.filter(i => i !== id);
  return _requests.length < before;
}

/** Move an accepted request up or down in the play queue. */
function moveRequest(id, direction) {
  const idx = _acceptedOrder.indexOf(id);
  if (idx === -1) return false;
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= _acceptedOrder.length) return false;
  [_acceptedOrder[idx], _acceptedOrder[swapIdx]] = [_acceptedOrder[swapIdx], _acceptedOrder[idx]];
  return true;
}

/** Returns accepted requests in DJ-ordered sequence (the play queue). */
function getAcceptedQueue() {
  return _acceptedOrder.map(id => _requests.find(r => r.id === id)).filter(Boolean);
}

/** DJ clears all played/rejected requests from the list. */
function clearFinished() {
  _requests = _requests.filter(r => r.status === 'pending' || r.status === 'accepted');
}

/** Returns sorted request list: accepted first, then pending by vote count desc. */
function getRequests() {
  const order = { accepted: 0, pending: 1, played: 2, rejected: 3 };
  return [..._requests].sort((a, b) => {
    if (a.status !== b.status) return (order[a.status] ?? 4) - (order[b.status] ?? 4);
    return b.votes - a.votes;
  });
}

/** All-time most requested/played tracks, sorted by score. */
function getTrending(limit = 20) {
  return Object.entries(_trending)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([title, score]) => ({ title, score }));
}

/**
 * Toggle an emoji reaction on a request (🔥 ❤️ 👏).
 * Each user can toggle each emoji independently.
 */
function reactRequest(id, emoji, username) {
  if (!ALLOWED_REACTIONS.includes(emoji)) return { error: 'Invalid reaction' };
  const req = _requests.find(r => r.id === id);
  if (!req) return { error: 'Request not found' };
  if (req.status !== 'pending' && req.status !== 'accepted') {
    return { error: 'Cannot react to this request' };
  }
  if (!req.reactions) req.reactions = {};
  if (!req.reactions[emoji]) req.reactions[emoji] = [];
  const idx = req.reactions[emoji].indexOf(username);
  if (idx !== -1) {
    req.reactions[emoji].splice(idx, 1);
    if (!req.reactions[emoji].length) delete req.reactions[emoji];
  } else {
    req.reactions[emoji].push(username);
  }
  return { ok: true };
}

/**
 * Marks any pending requests older than REQUEST_TIMEOUT as 'rejected'.
 * Returns true if any requests were changed (caller should broadcastRequests).
 */
function cleanupExpired() {
  const cutoff = Date.now() - REQUEST_TIMEOUT;
  let changed = false;
  for (const req of _requests) {
    if (req.status === 'pending' && new Date(req.requestedAt).getTime() < cutoff) {
      req.status = 'rejected';
      changed = true;
    }
  }
  return changed;
}

module.exports = { addRequest, voteRequest, reactRequest, setStatus, removeRequest, clearFinished, getRequests, getTrending, cleanupExpired, moveRequest, getAcceptedQueue };
