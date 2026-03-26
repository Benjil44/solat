/**
 * Stores chat messages from muted users for admin review.
 * Pre-ban messages are captured when the DJ mutes a user.
 * Post-ban messages are captured if the user attempts to send after being muted.
 */
const fs   = require('fs');
const path = require('path');

const FLAGGED_PATH = path.join(__dirname, '../data/flagged-messages.json');

// { [username]: { bannedAt: ISO, bannedBy: string, messages: [{text, time, type}] } }
let _data = _load();

function _load() {
  try { return JSON.parse(fs.readFileSync(FLAGGED_PATH, 'utf8')); } catch { return {}; }
}

function _save() {
  try {
    fs.mkdirSync(path.dirname(FLAGGED_PATH), { recursive: true });
    const tmp = FLAGGED_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_data, null, 2), 'utf8');
    fs.renameSync(tmp, FLAGGED_PATH);
  } catch (_) {}
}

/**
 * Create or refresh the ban record for a user.
 * Optionally attaches their recent chat history as "pre-ban" evidence.
 */
function banRecord(username, bannedBy, preBanMessages = []) {
  _data[username] = {
    bannedAt: new Date().toISOString(),
    bannedBy,
    messages: preBanMessages.map(m => ({ text: m.text, time: m.time, type: 'pre-ban' }))
  };
  _save();
}

/**
 * Append a post-ban message attempt (user tried to send while muted).
 */
function appendPostBan(username, text, time) {
  if (!_data[username]) {
    _data[username] = { bannedAt: new Date().toISOString(), bannedBy: 'system', messages: [] };
  }
  _data[username].messages.push({ text, time, type: 'post-ban' });
  // Cap at 100 messages per user
  if (_data[username].messages.length > 100) {
    _data[username].messages = _data[username].messages.slice(-100);
  }
  _save();
}

/**
 * Clear a user's flagged record when they are unmuted.
 */
function clearRecord(username) {
  delete _data[username];
  _save();
}

function getAll() {
  return { ..._data };
}

function getUser(username) {
  return _data[username] || null;
}

module.exports = { banRecord, appendPostBan, clearRecord, getAll, getUser };
