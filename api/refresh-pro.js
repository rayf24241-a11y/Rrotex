// Reissues the Pro pass if the Stripe subscription is still active.
// Called by the app when the stored pass is close to expiry. A cancelled
// subscription fails the check, the pass expires, and the user downgrades
// automatically — no webhook or database needed.
//
// One-time 30-day Pro passes (no subscription id) have nothing to check
// against Stripe — they're returned unchanged as long as they're still
// within their original 30 days (verifyProPass already rejects expired
// ones). They are never re-signed with a fresh expiry here, since that
// would silently extend a one-time purchase indefinitely.
//
// Also accepts an idToken fallback so a stale/mis-signed subscription pass
// can be recovered by verifying the Firebase identity directly against Stripe.
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
  const payload = verifyProPass(proPass);

  // One-time 30-day pass, still within its window — nothing to check against
  // Stripe (no subscription exists). Hand it back unchanged.
  if (payload && !payload.sub) {
    response.status(200).json({ refreshed: true, proPass });
    return;
  }

  // Fallback: pass missing/expired, or a subscription-backed pass — verify
  // the Firebase identity and look up the Stripe subscription directly.
  let resolvedPayload = payload;
  if (!resolvedPayload) {
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
    resolvedPayload = { uid: auth.uid, sub: '' };
  }

  // If we have a valid subscription ID from the old pass, confirm it is still active.
  if (resolvedPayload.sub) {
    const stripeResponse = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(resolvedPayload.sub)}`,
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

  // Reaching here means a recurring-subscription pass (sub present, confirmed
  // active above) — one-time 30-day passes already returned earlier. 35 days
  // buffers this subscription refresh past the natural billing-month length.
  const newPass = signProPass({
    uid: resolvedPayload.uid,
    sub: resolvedPayload.sub,
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
