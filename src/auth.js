const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const { createUser, findUser, createToken, getSubscriptionStatus } = require('./users');

// POST /auth/register
router.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
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
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

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

  const sub = getSubscriptionStatus(user);
  const token = createToken(user);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('token', token, { httpOnly: true, secure, sameSite: secure ? 'strict' : 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.json({ success: true, username: user.username, subscription: sub });
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
