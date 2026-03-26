const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH          = path.join(__dirname, '../data/music-db.json');
const CORRECTIONS_PATH = path.join(__dirname, '../data/corrections.json');

let _db          = _loadDB();
let _corrections = _loadCorrections();

function _loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return {}; }
}
function _loadCorrections() {
  try { return JSON.parse(fs.readFileSync(CORRECTIONS_PATH, 'utf8')); } catch { return []; }
}

function _saveDB() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_PATH);
  } catch (_) {}
}
function _saveCorrections() {
  try {
    const tmp = CORRECTIONS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_corrections, null, 2), 'utf8');
    fs.renameSync(tmp, CORRECTIONS_PATH);
  } catch (_) {}
}

// ── Normalise for matching ────────────────────────────────────────────────────
function normalize(s) {
  return String(s).toLowerCase()
    .replace(/[^\w\s\-']/g, '')   // keep letters, digits, dash, apostrophe
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Levenshtein distance ──────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, n + 1, ...curr);
  }
  return curr[n];
}

/**
 * Token-based fuzzy score (0–1).
 * Works well for partial queries like "daft pank" → "Daft Punk - One More Time".
 * Allows 1 edit for tokens ≥ 4 chars, 0 edits for shorter tokens.
 */
function tokenScore(query, title) {
  const qTokens = normalize(query).split(/\s+/).filter(t => t.length > 1);
  const eTokens = normalize(title).split(/\s+/).filter(t => t.length > 1);
  if (!qTokens.length || !eTokens.length) return 0;

  let matched = 0;
  for (const qt of qTokens) {
    let best = 0;
    for (const et of eTokens) {
      const maxEdits = qt.length >= 4 ? 1 : 0;
      const dist = levenshtein(qt, et);
      if (dist <= maxEdits) {
        const score = 1 - dist / Math.max(qt.length, et.length);
        if (score > best) best = score;
      }
    }
    matched += best;
  }
  return matched / qTokens.length;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called when a request is accepted or played.
 * Adds the title to the knowledge base so future typos can be corrected.
 */
function learnTrack(title, opts = {}) {
  const key = normalize(title);
  if (!key) return;
  if (!_db[key]) {
    _db[key] = { canonical: title, plays: 0, score: 0, aliases: [] };
  }
  if (opts.played) {
    _db[key].plays  = (_db[key].plays  || 0) + 1;
    _db[key].score  = (_db[key].score  || 0) + (opts.votes || 1);
  }
  _saveDB();
}

/**
 * Returns up to `limit` suggestions for the given query.
 * Searches canonical titles AND known aliases.
 * Threshold: 0.65 token score.
 */
function suggest(query, limit = 4) {
  const nq = normalize(query);
  if (nq.length < 3) return [];

  const THRESHOLD = 0.65;
  const seen = new Map();   // canonical → best score

  for (const [, entry] of Object.entries(_db)) {
    // Score against canonical
    const s1 = tokenScore(query, entry.canonical);
    if (s1 >= THRESHOLD) {
      const prev = seen.get(entry.canonical) || 0;
      if (s1 > prev) seen.set(entry.canonical, s1);
    }
    // Score against aliases
    for (const alias of entry.aliases || []) {
      const s2 = tokenScore(query, alias);
      if (s2 >= THRESHOLD) {
        const prev = seen.get(entry.canonical) || 0;
        if (s2 > prev) seen.set(entry.canonical, s2);
      }
    }
  }

  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([title, score]) => ({ title, score: Math.round(score * 100) }));
}

/**
 * DJ submits a correction: what a user typed → what it should be.
 * Saved as "pending" until admin reviews.
 */
function submitCorrection(original, canonical, submittedBy) {
  // Don't duplicate an already-pending correction for the same pair
  const dup = _corrections.find(
    c => c.status === 'pending' &&
         normalize(c.original) === normalize(original) &&
         normalize(c.canonical) === normalize(canonical)
  );
  if (dup) return dup;

  const correction = {
    id:          uuidv4(),
    original:    original.trim(),
    canonical:   canonical.trim(),
    submittedBy,
    createdAt:   new Date().toISOString(),
    status:      'pending'
  };
  _corrections.unshift(correction);
  _saveCorrections();
  return correction;
}

/**
 * Admin accepts a correction.
 * The original (misspelled) form is stored as an alias so it matches next time.
 */
function acceptCorrection(id) {
  const c = _corrections.find(c => c.id === id);
  if (!c || c.status !== 'pending') return false;
  c.status     = 'accepted';
  c.resolvedAt = new Date().toISOString();
  _saveCorrections();

  const canonKey   = normalize(c.canonical);
  const originalNorm = normalize(c.original);

  if (!_db[canonKey]) {
    _db[canonKey] = { canonical: c.canonical, plays: 0, score: 0, aliases: [] };
  }
  if (!_db[canonKey].aliases.includes(originalNorm)) {
    _db[canonKey].aliases.push(originalNorm);
  }
  // Remove any stale entry that was created from the misspelled title
  if (_db[originalNorm] && originalNorm !== canonKey) delete _db[originalNorm];
  _saveDB();
  return true;
}

function rejectCorrection(id) {
  const c = _corrections.find(c => c.id === id);
  if (!c || c.status !== 'pending') return false;
  c.status     = 'rejected';
  c.resolvedAt = new Date().toISOString();
  _saveCorrections();
  return true;
}

function getCorrections(statusFilter) {
  if (statusFilter) return _corrections.filter(c => c.status === statusFilter);
  return [..._corrections];
}

function getDB() {
  return Object.values(_db).sort((a, b) => (b.score || 0) - (a.score || 0));
}

module.exports = { learnTrack, suggest, submitCorrection, acceptCorrection, rejectCorrection, getCorrections, getDB };
