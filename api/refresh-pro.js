// Reissues the Pro pass if the Stripe subscription is still active.
// Called by the app when the stored pass is close to expiry. A cancelled
// subscription fails the check, the pass expires, and the user downgrades
// automatically — no webhook or database needed.
//
// Also accepts an idToken fallback so a stale/mis-signed pass can be recovered
// by verifying the Firebase identity directly against Stripe.
const { signProPass, verifyProPass } = require('./_lib/propass.js');
const { userHasActiveProSubscription, stripeMode } = require('./_lib/stripe.js');

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

  const { secretKey } = stripeMode();
  if (!secretKey) {
    response.status(200).json({ refreshed: false, message: 'Stripe is not configured.' });
    return;
  }

  const { proPass = '', authToken = '' } = request.body || {};
  let payload = verifyProPass(proPass);

  // Fallback: if the signed pass is invalid (e.g. secret rotated), verify the
  // Firebase identity and look up the Stripe subscription directly.
  if (!payload || !payload.sub) {
    const auth = await verifyFirebaseToken(authToken);
    if (!auth.ok) {
      response.status(401).json({ refreshed: false, message: 'Invalid or expired Pro pass. Go Pro again from the pricing page.' });
      return;
    }
    const hasSubscription = await userHasActiveProSubscription(auth.uid, auth.email, '');
    if (!hasSubscription) {
      response.status(403).json({ refreshed: false, cancelled: true, message: 'This Pro subscription is no longer active.' });
      return;
    }
    payload = { uid: auth.uid, sub: '' };
  }

  // If we have a valid subscription ID from the old pass, confirm it is still active.
  if (payload.sub) {
    const stripeResponse = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(payload.sub)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    const subscription = await stripeResponse.json();
    if (!stripeResponse.ok) {
      response.status(500).json({ refreshed: false, message: subscription.error?.message || 'Could not check the subscription.' });
      return;
    }
    const active = subscription.status === 'active' || subscription.status === 'trialing';
    if (!active) {
      response.status(403).json({ refreshed: false, cancelled: true, message: 'This Pro subscription is no longer active.' });
      return;
    }
  }

  const newPass = signProPass({
    uid: payload.uid,
    sub: payload.sub,
    plan: 'pro',
    exp: Date.now() + 35 * 24 * 60 * 60 * 1000,
  });

  response.status(200).json({ refreshed: true, proPass: newPass });
};

async function verifyFirebaseToken(authToken) {
  if (!authToken || !process.env.FIREBASE_PROJECT_ID) return { ok: false };
  try {
    const result = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(authToken)}`);
    if (!result.ok) return { ok: false };
    const token = await result.json();
    return {
      ok: token.aud === process.env.FIREBASE_PROJECT_ID && Boolean(token.sub),
      uid: token.sub || '',
      email: token.email || '',
    };
  } catch {
    return { ok: false };
  }
}

function cleanEnv(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/[^\x20-\x7E]/g, '');
}
