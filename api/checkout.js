const { getAuthUserId } = require('./_lib/clerk-auth');
const { getStripe } = require('./_lib/stripe-client');
const { PACKS, PLANS } = require('./_lib/stripe-catalog');

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function siteOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const userId = await getAuthUserId(req);
  if (!userId) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'Sign in required.' }));
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid request body.' }));
    return;
  }

  const kind = body.kind === 'plan' ? 'plan' : body.kind === 'pack' ? 'pack' : null;
  const id = typeof body.id === 'string' ? body.id : '';
  const catalogEntry = kind === 'pack' ? PACKS[id] : kind === 'plan' ? PLANS[id] : null;

  if (!catalogEntry) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Unknown pack or plan.' }));
    return;
  }

  const origin = siteOrigin(req);
  let stripe;
  try {
    stripe = getStripe();
  } catch (err) {
    console.error('Stripe misconfigured:', err.message);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Payments are temporarily unavailable.' }));
    return;
  }

  try {
    let session;
    if (kind === 'pack') {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: userId,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: catalogEntry.usd,
            product_data: { name: `${catalogEntry.credits.toLocaleString()} credits` },
          },
        }],
        metadata: { userId, kind: 'pack', packId: id, credits: String(catalogEntry.credits) },
        success_url: `${origin}/?checkout=success`,
        cancel_url: `${origin}/?checkout=cancelled`,
      });
    } else {
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        client_reference_id: userId,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            recurring: { interval: 'month' },
            unit_amount: catalogEntry.usd,
            product_data: { name: `ROTEX ${catalogEntry.name} plan` },
          },
        }],
        subscription_data: { metadata: { userId, planId: id } },
        metadata: { userId, kind: 'plan', planId: id },
        success_url: `${origin}/?checkout=success`,
        cancel_url: `${origin}/?checkout=cancelled`,
      });
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ url: session.url }));
  } catch (err) {
    console.error('Stripe checkout session creation failed:', err.message);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Could not start checkout.' }));
  }
};
