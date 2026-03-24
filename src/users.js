const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '../data/users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'dj-stream-secret-change-me-in-production';

// ─── Database helpers ─────────────────────────────────────────────────────────
function loadUsers() {
  if (!fs.existsSync(DB_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  // Write to a temp file then atomically rename — prevents corruption on crash mid-write
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
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

function updatePassword(username, newHashedPassword) {
  const users = loadUsers();
  if (!users[username]) return false;
  users[username].password = newHashedPassword;
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

module.exports = { createUser, findUser, updatePassword, createToken, verifyToken, getSubscriptionStatus };
