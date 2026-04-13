const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '../data/users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'dj-stream-secret-change-me-in-production';

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Avoids repeated disk reads on every auth check / heartbeat.
// Invalidated on every write so it's always consistent.
let _cache = null;

function loadUsers() {
  if (_cache) return _cache;
  if (!fs.existsSync(DB_PATH)) return (_cache = {});
  try {
    _cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return _cache;
  } catch {
    return (_cache = {});
  }
}

function saveUsers(users) {
  // Write to a temp file then atomically rename — prevents corruption on crash mid-write
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
  _cache = users;   // update cache in-place after successful write
}

// ─── User operations ──────────────────────────────────────────────────────────
function createUser(username, hashedPassword) {
  const users = loadUsers();

  if (users[username]) {
    return { error: 'Username already taken' };
  }

  const user = {
    id: uuidv4(),
    username,
    password: hashedPassword,
    registeredAt: new Date().toISOString(),
    paidUntil: null,   // set this when payment is implemented
    role: 'viewer'
  };

  users[username] = user;
  saveUsers(users);
  return { user };
}

function findUser(username) {
  const users = loadUsers();
  return users[username] || null;
}

function deleteUser(username) {
  const users = loadUsers();
  if (!users[username]) return false;
  delete users[username];
  saveUsers(users);
  return true;
}

// Extend (or set) a user's paidUntil by N days from today (or from current expiry if later)
function extendSubscription(username, days) {
  const users = loadUsers();
  if (!users[username]) return false;
  const now         = Date.now();
  const currentPaid = users[username].paidUntil
    ? new Date(users[username].paidUntil).getTime() : 0;
  const base        = Math.max(now, currentPaid);
  users[username].paidUntil = new Date(base + days * 86400000).toISOString();
  saveUsers(users);
  return users[username].paidUntil;
}

function updatePassword(username, newHashedPassword) {
  const users = loadUsers();
  if (!users[username]) return false;
  users[username].password = newHashedPassword;
  saveUsers(users);
  return true;
}

function updateAvatar(username, avatar) {
  const users = loadUsers();
  if (!users[username]) return false;
  users[username].avatar = avatar;
  saveUsers(users);
  return true;
}

function updatePushPrefs(username, prefs) {
  const users = loadUsers();
  if (!users[username]) return false;
  users[username].pushPrefs = { ...users[username].pushPrefs, ...prefs };
  saveUsers(users);
  return users[username].pushPrefs;
}

function getPushPrefs(username) {
  const users = loadUsers();
  const u = users[username];
  if (!u) return null;
  return { goLive: true, nextTrack: false, requestAccepted: false, ...u.pushPrefs };
}

function setSuspended(username, suspended) {
  const users = loadUsers();
  if (!users[username]) return false;
  users[username].suspended = !!suspended;
  saveUsers(users);
  return true;
}

// ─── Password reset tokens ────────────────────────────────────────────────────
// Stores short-lived tokens in users.json. Admin sees pending requests and
// shares the token with the user (e.g. via Discord/email).
function saveResetToken(username) {
  const users = loadUsers();
  if (!users[username]) return false;
  const token   = require('crypto').randomBytes(4).toString('hex').toUpperCase(); // 8-char
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();      // 24h
  users[username].resetToken   = token;
  users[username].resetExpires = expires;
  users[username].resetRequestedAt = new Date().toISOString();
  saveUsers(users);
  return token;
}

function consumeResetToken(username, token) {
  const users = loadUsers();
  const u = users[username];
  if (!u || !u.resetToken) return false;
  if (u.resetToken !== token.toUpperCase()) return false;
  if (new Date(u.resetExpires).getTime() < Date.now()) return false;
  delete u.resetToken;
  delete u.resetExpires;
  delete u.resetRequestedAt;
  saveUsers(users);
  return true;
}

function listResetRequests() {
  const users = loadUsers();
  const now   = Date.now();
  return Object.values(users)
    .filter(u => u.resetToken && u.resetExpires && new Date(u.resetExpires).getTime() > now)
    .map(u => ({ username: u.username, token: u.resetToken, requestedAt: u.resetRequestedAt, expires: u.resetExpires }));
}

// ─── Watch time / session tracking ───────────────────────────────────────────
function incrementWatchTime(username, seconds) {
  const users = loadUsers();
  if (!users[username]) return;
  users[username].watchSeconds = (users[username].watchSeconds || 0) + seconds;
  saveUsers(users);
}

// Track unique session attendance. sessionKey is a string (e.g. stream start ISO).
function markSessionAttended(username, sessionKey) {
  const users = loadUsers();
  if (!users[username]) return;
  const attended = users[username].sessionsAttended || [];
  if (!attended.includes(sessionKey)) {
    attended.push(sessionKey);
    users[username].sessionsAttended = attended;
    saveUsers(users);
  }
}

function saveStripeCustomer(username, customerId) {
  const users = loadUsers();
  if (!users[username]) return false;
  users[username].stripeCustomerId = customerId;
  saveUsers(users);
  return true;
}

function setChatBan(username, banned) {
  const users = loadUsers();
  if (!users[username]) return false;
  users[username].chatBanned = !!banned;
  saveUsers(users);
  return true;
}

function getSubscriptionStatus(user) {
  const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
  const registered = new Date(user.registeredAt).getTime();
  const now = Date.now();
  const trialActive = (now - registered) < SIX_MONTHS_MS;
  const isPaid = user.paidUntil && new Date(user.paidUntil).getTime() > now;

  const trialEnds = new Date(registered + SIX_MONTHS_MS);
  const daysLeft = Math.max(0, Math.ceil((trialEnds - now) / (1000 * 60 * 60 * 24)));

  if (trialActive) {
    return { active: true, type: 'trial', daysLeft };
  }
  if (isPaid) {
    const paidDaysLeft = Math.ceil((new Date(user.paidUntil) - now) / (1000 * 60 * 60 * 24));
    return { active: true, type: 'paid', daysLeft: paidDaysLeft };
  }
  return { active: false, type: 'expired', daysLeft: 0 };
}

// ─── JWT ──────────────────────────────────────────────────────────────────────
function createToken(user, rememberMe = false) {
  return jwt.sign(
    { id: user.id, username: user.username, registeredAt: user.registeredAt, paidUntil: user.paidUntil },
    JWT_SECRET,
    { expiresIn: rememberMe ? '30d' : '7d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

module.exports = { createUser, findUser, deleteUser, updatePassword, updateAvatar, updatePushPrefs, getPushPrefs, extendSubscription, setSuspended, setChatBan, saveStripeCustomer, saveResetToken, consumeResetToken, listResetRequests, incrementWatchTime, markSessionAttended, createToken, verifyToken, getSubscriptionStatus };
