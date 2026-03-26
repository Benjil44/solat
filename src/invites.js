const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const INVITES_PATH = path.join(__dirname, '../data/invites.json');

function loadInvites() {
  if (!fs.existsSync(INVITES_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(INVITES_PATH, 'utf8')); } catch { return {}; }
}

function saveInvites(invites) {
  const tmp = INVITES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(invites, null, 2), 'utf8');
  fs.renameSync(tmp, INVITES_PATH);
}

// Generate a unique 8-char uppercase hex code (e.g. A3F9C21B)
function generateCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Create N new invite codes (default 1, max 50)
function createInvites(count = 1) {
  count = Math.max(1, Math.min(50, count));
  const invites = loadInvites();
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code;
    let attempts = 0;
    do { code = generateCode(); attempts++; } while (invites[code] && attempts < 100);
    invites[code] = { code, createdAt: new Date().toISOString(), usedBy: null, usedAt: null };
    codes.push(code);
  }
  saveInvites(invites);
  return codes;
}

// Returns { valid: true } or { valid: false, error: '...' }
function validateInvite(code) {
  if (!code) return { valid: false, error: 'Invite code is required' };
  const invites = loadInvites();
  const invite  = invites[String(code).toUpperCase()];
  if (!invite)        return { valid: false, error: 'Invalid invite code' };
  if (invite.usedBy)  return { valid: false, error: 'Invite code has already been used' };
  return { valid: true, invite };
}

// Mark a code as used by username
function useInvite(code, username) {
  const invites = loadInvites();
  const key = String(code).toUpperCase();
  if (!invites[key]) return false;
  invites[key].usedBy = username;
  invites[key].usedAt = new Date().toISOString();
  saveInvites(invites);
  return true;
}

function listInvites() {
  return Object.values(loadInvites())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function deleteInvite(code) {
  const invites = loadInvites();
  const key = String(code).toUpperCase();
  if (!invites[key]) return false;
  delete invites[key];
  saveInvites(invites);
  return true;
}

module.exports = { createInvites, validateInvite, useInvite, listInvites, deleteInvite };
