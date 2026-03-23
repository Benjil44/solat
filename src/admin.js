const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/users.json');

// ─── Admin auth middleware (key from .env) ────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.cookies.adminKey || req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Admin access denied' });
  }
  next();
}

// ─── Admin login — just sets a cookie ────────────────────────────────────────
router.post('/login', (req, res) => {
  const { key } = req.body;
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Wrong admin key' });
  }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('adminKey', key, { httpOnly: true, secure, sameSite: secure ? 'strict' : 'lax', maxAge: 12 * 60 * 60 * 1000 }); // 12h
  res.json({ success: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie('adminKey');
  res.json({ success: true });
});

// ─── User list ────────────────────────────────────────────────────────────────
router.get('/users', requireAdmin, (req, res) => {
  const raw = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) : {};
  const now = Date.now();
  const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

  const users = Object.values(raw).map(u => {
    const registered = new Date(u.registeredAt).getTime();
    const trialEnds  = registered + SIX_MONTHS_MS;
    const trialActive = now < trialEnds;
    const isPaid = u.paidUntil && new Date(u.paidUntil).getTime() > now;

    let status, daysLeft;
    if (trialActive) {
      status = 'trial';
      daysLeft = Math.ceil((trialEnds - now) / 86400000);
    } else if (isPaid) {
      status = 'paid';
      daysLeft = Math.ceil((new Date(u.paidUntil) - now) / 86400000);
    } else {
      status = 'expired';
      daysLeft = 0;
    }

    return {
      username: u.username,
      registeredAt: u.registeredAt,
      paidUntil: u.paidUntil || null,
      status,
      daysLeft
    };
  });

  // Sort: trial first, then paid, then expired; alphabetical within group
  const order = { trial: 0, paid: 1, expired: 2 };
  users.sort((a, b) => order[a.status] - order[b.status] || a.username.localeCompare(b.username));

  res.json(users);
});

// ─── Extend subscription ──────────────────────────────────────────────────────
// Body: { username, days }  — adds N days from today (or from current paidUntil if in future)
router.post('/extend', requireAdmin, (req, res) => {
  const { username, days } = req.body;
  if (!username || !days || isNaN(days) || days < 1) {
    return res.status(400).json({ error: 'Provide username and days (positive number)' });
  }

  const raw = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) : {};
  if (!raw[username]) return res.status(404).json({ error: 'User not found' });

  const now = Date.now();
  const currentPaid = raw[username].paidUntil ? new Date(raw[username].paidUntil).getTime() : 0;
  const base = Math.max(now, currentPaid);  // extend from whichever is later
  const newPaidUntil = new Date(base + days * 86400000).toISOString();

  raw[username].paidUntil = newPaidUntil;
  fs.writeFileSync(DB_PATH, JSON.stringify(raw, null, 2));

  res.json({ success: true, username, paidUntil: newPaidUntil });
});

// ─── Delete / ban user ────────────────────────────────────────────────────────
router.delete('/users/:username', requireAdmin, (req, res) => {
  const { username } = req.params;
  const raw = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) : {};
  if (!raw[username]) return res.status(404).json({ error: 'User not found' });

  delete raw[username];
  fs.writeFileSync(DB_PATH, JSON.stringify(raw, null, 2));
  res.json({ success: true });
});

module.exports = router;
