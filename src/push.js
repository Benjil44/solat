const fs       = require('fs');
const path     = require('path');
const webpush  = require('web-push');
const { getPushPrefs } = require('./users');

const SUBS_PATH = path.join(__dirname, '../data/push-subs.json');

// Initialise VAPID only if keys are configured
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_SECRET_KEY) {
  webpush.setVapidDetails(
    'mailto:dj@localhost',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_SECRET_KEY
  );
}

function _load() {
  try { return JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8')); } catch { return {}; }
}

function _save(subs) {
  try {
    fs.mkdirSync(path.dirname(SUBS_PATH), { recursive: true });
    const tmp = SUBS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(subs, null, 2), 'utf8');
    fs.renameSync(tmp, SUBS_PATH);
  } catch (_) {}
}

/** Save or update a push subscription for a user. */
function saveSub(username, subscription) {
  const subs = _load();
  subs[username] = subscription;
  _save(subs);
}

/** Remove a push subscription for a user. */
function removeSub(username) {
  const subs = _load();
  delete subs[username];
  _save(subs);
}

async function _send(username, sub, payload, stale) {
  return webpush.sendNotification(sub, JSON.stringify(payload)).catch(err => {
    if (err.statusCode === 410 || err.statusCode === 404) stale.push(username);
  });
}

async function _broadcast(payload, prefKey) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  const subs  = _load();
  const stale = [];
  await Promise.allSettled(
    Object.entries(subs).map(([username, sub]) => {
      if (prefKey) {
        const prefs = getPushPrefs(username);
        // Default goLive=true, others=false
        const defaultOn = prefKey === 'goLive';
        if (prefs ? !prefs[prefKey] : !defaultOn) return Promise.resolve();
      }
      return _send(username, sub, payload, stale);
    })
  );
  if (stale.length) {
    const s = _load();
    for (const u of stale) delete s[u];
    _save(s);
  }
}

/** Send a "DJ is live" push notification (filtered by goLive pref, default on). */
async function notifyLive(title) {
  await _broadcast({
    title: 'DJ is LIVE',
    body:  title ? `Now playing: ${title}` : 'The stream has started',
    url:   '/watch.html',
  }, 'goLive');
}

/** Notify subscribers who opted in to next-track announcements. */
async function notifyNextTrack(title) {
  if (!title) return;
  await _broadcast({
    title: 'Up Next',
    body:  title,
    url:   '/watch.html',
  }, 'nextTrack');
}

/** Notify a specific user that their request was accepted (if opted in). */
async function notifyRequestAccepted(username, title) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  const prefs = getPushPrefs(username);
  if (!prefs || !prefs.requestAccepted) return;
  const subs = _load();
  const sub  = subs[username];
  if (!sub) return;
  const stale = [];
  await _send(username, sub, {
    title: 'Request Accepted!',
    body:  `"${title}" is up next`,
    url:   '/watch.html',
  }, stale);
  if (stale.length) {
    const s = _load();
    delete s[username];
    _save(s);
  }
}

/** Send a custom push to all subscribers (no pref filter — admin override). */
async function notifyCustom(title, body) {
  await _broadcast({ title, body, url: '/watch.html' }, null);
}

module.exports = { saveSub, removeSub, notifyLive, notifyNextTrack, notifyRequestAccepted, notifyCustom };
