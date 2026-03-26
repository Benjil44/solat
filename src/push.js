const fs       = require('fs');
const path     = require('path');
const webpush  = require('web-push');

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

/** Send a "DJ is live" push notification to all subscribers. */
async function notifyLive(title) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  const subs   = _load();
  const payload = JSON.stringify({
    title: 'DJ is LIVE',
    body:  title ? `Now playing: ${title}` : 'The stream has started',
    url:   '/watch.html',
  });
  const stale = [];
  await Promise.allSettled(
    Object.entries(subs).map(([username, sub]) =>
      webpush.sendNotification(sub, payload).catch(err => {
        // 410 Gone = subscription expired/unsubscribed
        if (err.statusCode === 410 || err.statusCode === 404) stale.push(username);
      })
    )
  );
  if (stale.length) {
    const s = _load();
    for (const u of stale) delete s[u];
    _save(s);
  }
}

module.exports = { saveSub, removeSub, notifyLive };
