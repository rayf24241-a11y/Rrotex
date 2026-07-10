const { signProPass } = require('./_lib/propass.js');
const { sendEmail } = require('./_lib/email.js');
const { credit } = require('./_lib/token-wallet.js');

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secretKey = cleanEnv(process.env.STRIPE_SECRET_KEY);

  if (!secretKey) {
    response.status(200).json({ verified: false, message: 'Stripe is not configured.' });
    return;
  }

  if (secretKey.startsWith('sk_test_')) {
    response.status(500).json({ verified: false, message: 'Stripe is using a test key — cannot verify real payments. Set STRIPE_SECRET_KEY to a live key (sk_live_...).' });
    return;
  }

  const { sessionId = '', uid = '' } = request.body || {};
  if (!sessionId || !uid) {
    response.status(400).json({ verified: false, message: 'Missing session or user.' });
    return;
  }

  const stripeResponse = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );

  const session = await stripeResponse.json();
  if (!stripeResponse.ok) {
    response.status(500).json({ verified: false, message: session.error?.message || 'Could not verify checkout.' });
    return;
  }

  const paid = session.payment_status === 'paid' || session.status === 'complete';
  const userMatches = session.client_reference_id === uid || session.metadata?.uid === uid;
  if (!paid || !userMatches) {
    response.status(403).json({ verified: false, message: 'Checkout was not completed for this user.' });
    return;
  }

  if (session.metadata?.kind === 'textokens') {
    const dollars = Math.floor(Number(session.metadata?.dollars || 0));
    // Fallback matches create-checkout-session.js: $1 = 2 TexTokens = 60k
    // internal units (the old fallback of $1 = 1M internal would massively
    // over-credit under the 2026-07 re-denomination).
    const texTokens = Math.floor(Number(session.metadata?.textokens || dollars * 60_000));
    if (!dollars || !texTokens) {
      response.status(400).json({ verified: false, message: 'Credit checkout is missing token metadata.' });
      return;
    }

    // Server-authoritative credit: add the purchased tokens to the KV wallet.
    // This is the ONLY place a balance can rise, and it runs only after Stripe
    // has confirmed the paid session. Deduped by session id so a refreshed
    // success page can't double-credit. No-op if KV isn't configured (the
    // client-side Firestore credit below still updates the display).
    await credit(uid, session.id, texTokens);

    const buyerEmail = session.metadata?.email || session.customer_details?.email || '';
    const tokenLabel = (texTokens / 30_000).toFixed(1).replace(/\.0$/, ''); // display TexTokens
    await sendEmail({
      to: buyerEmail,
      subject: 'Your ROTEX TexTokens purchase',
      html: `<div style="font-family:sans-serif;max-width:400px">
        <h2 style="color:#4cc9f0">ROTEX</h2>
        <p>Thanks for your purchase! <strong>$${dollars}</strong> was charged and <strong>${tokenLabel} TexTokens</strong> were added to your account.</p>
        <p style="color:#888;font-size:13px">Session: ${session.id}</p>
      </div>`,
    });

    response.status(200).json({
      verified: true,
      dollars,
      texTokens,
      sessionId: session.id,
    });
    return;
  }

  const subscriptionId = session.subscription || '';
  if (subscriptionId) {
    const subResponse = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    const subscription = await subResponse.json().catch(() => ({}));
    const subActive = subscription.status === 'active' || subscription.status === 'trialing';
    if (!subResponse.ok || !subActive) {
      response.status(403).json({ verified: false, message: 'Pro subscription is not active yet.' });
      return;
    }
  }

  // Signed pass proves Pro status to /api/chat without a database.
  // One-time purchase: exactly 30 days, no auto-renewal. subscriptionId will
  // be empty for these; refresh-pro.js knows to skip the Stripe lookup for
  // a still-valid no-sub pass instead of treating it as a lapsed subscription.
  const proPass = signProPass({
    uid,
    sub: subscriptionId,
    plan: 'pro',
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });

  const buyerEmail = session.metadata?.email || session.customer_details?.email || '';
  await sendEmail({
    to: buyerEmail,
    subject: 'Welcome to ROTEX Pro',
    html: `<div style="font-family:sans-serif;max-width:400px">
      <h2 style="color:#4cc9f0">ROTEX</h2>
      <p>You're now a <strong>ROTEX Pro</strong> user. Your Pro features are active on this account for the next <strong>30 days</strong>.</p>
      <p style="color:#888;font-size:13px">This is a one-time purchase, not a subscription — nothing auto-renews. Come back to your account page after 30 days to get another 30 days of Pro.</p>
    </div>`,
  });

  response.status(200).json({
    verified: true,
    pro: true,
    subscriptionId,
    proPass,
  });
};

function cleanEnv(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/[^\x20-\x7E]/g, '');
}
