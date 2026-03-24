// ─── Stripe Payment Routes ────────────────────────────────────────────────────
// All routes are no-ops (503) when STRIPE_SECRET_KEY is not set in .env.
// To enable:
//   1. Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID in .env
//   2. Create a product + price at https://dashboard.stripe.com/products
//   3. For local testing: stripe listen --forward-to localhost:3000/payment/webhook

const express  = require('express');
const router   = express.Router();
const { verifyToken, findUser, extendSubscription } = require('./users');

// Initialise Stripe only if the key is present — server starts fine without it
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const ACCESS_DAYS = parseInt(process.env.STRIPE_ACCESS_DAYS, 10) || 30;

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies.token || req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  next();
}

// ── GET /payment/config — let the frontend know if payments are enabled ────────
router.get('/config', (req, res) => {
  res.json({
    enabled: !!stripe && !!process.env.STRIPE_PRICE_ID,
    days:    ACCESS_DAYS,
  });
});

// ── POST /payment/create-checkout ─────────────────────────────────────────────
// Creates a Stripe Checkout session and returns the redirect URL.
router.post('/create-checkout', requireAuth, async (req, res) => {
  if (!stripe)                        return res.status(503).json({ error: 'Payments not configured' });
  if (!process.env.STRIPE_PRICE_ID)   return res.status(503).json({ error: 'STRIPE_PRICE_ID not set' });

  const user = findUser(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode:                 'payment',   // one-time; change to 'subscription' for recurring
      payment_method_types: ['card'],
      line_items: [{
        price:    process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      metadata:    { username: user.username },
      success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/pricing.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] create-checkout error:', err.message);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// ── GET /payment/success — redirect target after Stripe checkout ───────────────
router.get('/success', (req, res) => {
  res.redirect('/watch.html?subscribed=1');
});

// ── POST /payment/webhook ─────────────────────────────────────────────────────
// IMPORTANT: registered with express.raw() in server.js BEFORE express.json()
// so Stripe signature verification works on the raw request body.
router.post('/webhook', (req, res) => {
  if (!stripe) return res.sendStatus(200);

  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('[Stripe] STRIPE_WEBHOOK_SECRET not set — skipping signature check');
    return res.sendStatus(200);
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Stripe] Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const username = session.metadata && session.metadata.username;

    if (username) {
      const newExpiry = extendSubscription(username, ACCESS_DAYS);
      console.log(`[Stripe] Payment received — extended ${username} by ${ACCESS_DAYS}d → ${newExpiry}`);
    } else {
      console.warn('[Stripe] checkout.session.completed missing username metadata');
    }
  }

  res.sendStatus(200);
});

module.exports = router;
