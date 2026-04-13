// ─── Stripe Payment Routes ────────────────────────────────────────────────────
// All routes are no-ops (503) when STRIPE_SECRET_KEY is not set in .env.
// To enable:
//   1. Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID in .env
//   2. Create a product + price at https://dashboard.stripe.com/products
//   3. For local testing: stripe listen --forward-to localhost:3000/payment/webhook

const express  = require('express');
const router   = express.Router();
const { verifyToken, findUser, extendSubscription, saveStripeCustomer } = require('./users');

// Tip notification callback — set by server.js after chat WS is ready
let _onTip = null;
function onTip(cb) { _onTip = cb; }

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
router.get('/config', async (req, res) => {
  const enabled = !!stripe && !!process.env.STRIPE_PRICE_ID;
  if (!enabled) return res.json({ enabled: false, days: ACCESS_DAYS });

  // Fetch the real price from Stripe so the frontend can display it
  try {
    const price    = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID);
    const amount   = price.unit_amount;                                  // pence/cents
    const currency = (price.currency || 'gbp').toUpperCase();
    const symbol   = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '£';
    const display  = amount ? `${symbol}${(amount / 100).toFixed(2)}` : null;
    const interval = price.recurring ? price.recurring.interval : null;  // 'month', 'year', or null
    res.json({ enabled, days: ACCESS_DAYS, display, interval, currency });
  } catch (err) {
    console.warn('[Stripe] price fetch failed:', err.message);
    res.json({ enabled, days: ACCESS_DAYS, display: null, interval: null });
  }
});

// ── POST /payment/portal — create a Stripe Billing Portal session ─────────────
// Lets users view invoices and cancel their subscription.
router.post('/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });

  const user = findUser(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.stripeCustomerId)
    return res.status(400).json({ error: 'No billing account found — contact support' });

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${baseUrl}/profile.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] portal error:', err.message);
    res.status(500).json({ error: 'Could not open billing portal' });
  }
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
      cancel_url:  `${baseUrl}/pricing.html?cancelled=1`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] create-checkout error:', err.message);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// ── POST /payment/create-tip ──────────────────────────────────────────────────
// Creates a Stripe Checkout session for a one-time tip in pence/cents.
router.post('/create-tip', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });

  const user   = findUser(req.user.username);
  if (!user)   return res.status(404).json({ error: 'User not found' });

  const amount = parseInt(req.body.amount, 10); // in pence/cents
  if (!amount || amount < 50 || amount > 100000)
    return res.status(400).json({ error: 'Invalid tip amount (50–100000 pence)' });

  try {
    const baseUrl  = `${req.protocol}://${req.get('host')}`;
    const currency = (process.env.STRIPE_CURRENCY || 'gbp').toLowerCase();
    const session  = await stripe.checkout.sessions.create({
      mode:                 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency,
          unit_amount: amount,
          product_data: { name: '💸 DJ Tip', description: `Tip from ${user.username}` },
        },
        quantity: 1,
      }],
      metadata:    { username: user.username, type: 'tip', amount: String(amount), currency },
      success_url: `${baseUrl}/watch.html?tipped=1`,
      cancel_url:  `${baseUrl}/watch.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] create-tip error:', err.message);
    res.status(500).json({ error: 'Could not create tip session' });
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
    const tipType  = session.metadata && session.metadata.type;

    if (!username) {
      console.warn('[Stripe] checkout.session.completed missing username metadata');
    } else if (tipType === 'tip') {
      // Tip payment — notify the DJ via chat broadcast
      const amount   = parseInt(session.metadata.amount || '0', 10);
      const currency = (session.metadata.currency || 'gbp').toUpperCase();
      const symbol   = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '£';
      const display  = `${symbol}${(amount / 100).toFixed(2)}`;
      console.log(`[Stripe] Tip received — ${username} tipped ${display}`);
      if (_onTip) _onTip({ username, amount, display });
    } else {
      // Subscription payment — extend access and save Stripe customer ID for portal
      if (session.customer) saveStripeCustomer(username, session.customer);
      const newExpiry = extendSubscription(username, ACCESS_DAYS);
      console.log(`[Stripe] Payment received — extended ${username} by ${ACCESS_DAYS}d → ${newExpiry}`);
    }
  }

  res.sendStatus(200);
});

module.exports = router;
module.exports.onTip = onTip;
