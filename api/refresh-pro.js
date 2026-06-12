// Reissues the Pro pass if the Stripe subscription is still active.
// Called by the app when the stored pass is close to expiry. A cancelled
// subscription fails the check, the pass expires, and the user downgrades
// automatically — no webhook or database needed.
const { signProPass, verifyProPass } = require('./_lib/propass.js');

module.exports = async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const liveSecretKey = cleanEnv(process.env.STRIPE_SECRET_KEY);
  const testSecretKey = cleanEnv(process.env.STRIPE_TEST_SECRET_KEY);
  const testMode = !liveSecretKey && (process.env.STRIPE_MODE === 'test' || Boolean(testSecretKey));
  const secretKey = testMode ? testSecretKey : liveSecretKey;

  if (!secretKey) {
    response.status(200).json({ refreshed: false, message: 'Stripe is not configured.' });
    return;
  }

  const { proPass = '' } = request.body || {};
  const payload = verifyProPass(proPass);
  if (!payload || !payload.sub) {
    response.status(401).json({ refreshed: false, message: 'Invalid or expired Plus pass. Upgrade again from the pricing page.' });
    return;
  }

  const stripeResponse = await fetch(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(payload.sub)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  const subscription = await stripeResponse.json();
  if (!stripeResponse.ok) {
    response.status(500).json({ refreshed: false, message: subscription.error?.message || 'Could not check the subscription.' });
    return;
  }

  const active = subscription.status === 'active' || subscription.status === 'trialing' || subscription.status === 'past_due';
  if (!active) {
    response.status(403).json({ refreshed: false, cancelled: true, message: 'This Plus subscription is no longer active.' });
    return;
  }

  const newPass = signProPass({
    uid: payload.uid,
    sub: payload.sub,
    plan: 'plus',
    exp: Date.now() + 35 * 24 * 60 * 60 * 1000,
  });

  response.status(200).json({ refreshed: true, proPass: newPass });
};

function cleanEnv(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/[^\x20-\x7E]/g, '');
}
