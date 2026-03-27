const fs   = require('fs');
const path = require('path');

const WF_PATH = path.join(__dirname, '../data/wordfilter.json');

function _load() {
  try {
    const d = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

function _save(words) {
  try {
    fs.mkdirSync(path.dirname(WF_PATH), { recursive: true });
    const tmp = WF_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(words));
    fs.renameSync(tmp, WF_PATH);
  } catch {}
}

function getWords()  { return _load(); }

function addWord(word) {
  const w = String(word).trim().toLowerCase();
  if (!w) return false;
  const words = _load();
  if (words.includes(w)) return false;
  words.push(w);
  _save(words);
  return true;
}

function removeWord(word) {
  const w = String(word).trim().toLowerCase();
  const words = _load();
  const next = words.filter(x => x !== w);
  if (next.length === words.length) return false;
  _save(next);
  return true;
}

/** Returns the matched word if text contains a banned word, null otherwise. */
function checkText(text) {
  const words = _load();
  if (!words.length) return null;
  const lower = String(text).toLowerCase();
  return words.find(w => lower.includes(w)) || null;
}

module.exports = { getWords, addWord, removeWord, checkText };
