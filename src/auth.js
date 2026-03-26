const express   = require('express');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const router    = express.Router();

const { createUser, findUser, updatePassword, createToken, getSubscriptionStatus } = require('./users');
const { validateInvite, useInvite } = require('./invites');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts — try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many accounts created from this IP — try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /auth/register
router.post('/register', registerLimiter, async (req, res) => {
  const { username, password, inviteCode } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  // Invite-only mode — validate code before doing anything else
  const inviteOnly = process.env.INVITE_ONLY === 'true';
  if (inviteOnly) {
    const check = validateInvite(inviteCode);
    if (!check.valid) return res.status(400).json({ error: check.error });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  // Only allow alphanumeric + underscore in username
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = createUser(username, hashed);

    if (result.error) {
      return res.status(409).json({ error: result.error });
    }

    // Consume invite code now that registration succeeded
    if (inviteOnly && inviteCode) useInvite(inviteCode, result.user.username);

    const token = createToken(result.user);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('token', token, { httpOnly: true, secure, sameSite: secure ? 'strict' : 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, username: result.user.username });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, rememberMe } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = findUser(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (user.suspended) {
    return res.status(403).json({ error: 'Your account has been suspended' });
  }

  const sub    = getSubscriptionStatus(user);
  const remember = !!rememberMe;
  const token  = createToken(user, remember);
  const maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('token', token, { httpOnly: true, secure, sameSite: secure ? 'strict' : 'lax', maxAge });
  res.json({ success: true, username: user.username, subscription: sub });
});

// POST /auth/change-password
router.post('/change-password', async (req, res) => {
  const { verifyToken } = require('./users');
  const token = req.cookies.token || req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid session' });

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'Current and new password are required' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const user = findUser(payload.username);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const hashed = await bcrypt.hash(newPassword, 10);
  updatePassword(payload.username, hashed);
  res.json({ success: true });
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// GET /auth/me — returns current user info
router.get('/me', (req, res) => {
  const { verifyToken } = require('./users');
  const token = req.cookies.token || req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid token' });

  const user = findUser(payload.username);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const sub = getSubscriptionStatus(user);
  res.json({ username: user.username, subscription: sub });
});

// GET /auth/token — returns the raw JWT so the client can use it for WebSocket auth
// (safe: only works if the cookie is already valid)
router.get('/token', (req, res) => {
  const { verifyToken } = require('./users');
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid token' });
  res.json({ token });
});

module.exports = router;
