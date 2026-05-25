module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const hasTestKeys = Boolean(process.env.STRIPE_TEST_SECRET_KEY && process.env.STRIPE_TEST_PRICE_ID);
  const testMode = process.env.STRIPE_MODE === 'test' || (process.env.STRIPE_MODE !== 'live' && hasTestKeys);
  const secretKey = testMode ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY;
  const priceId   = testMode ? process.env.STRIPE_TEST_PRICE_ID   : process.env.STRIPE_PRICE_ID;

  if (!secretKey || !priceId) {
    const missingNames = testMode
      ? 'STRIPE_TEST_SECRET_KEY and STRIPE_TEST_PRICE_ID'
      : 'STRIPE_SECRET_KEY and STRIPE_PRICE_ID';
    response.status(200).json({
      configured: false,
      message: `Stripe is not configured. Add ${missingNames} in Vercel.`,
    });
    return;
  }

  const { uid = '', email = '' } = request.body || {};
  if (!uid) {
    response.status(401).json({ error: 'login_required', message: 'Log in before upgrading.' });
    return;
  }

  const origin = request.headers.origin || 'https://www.rrotex.com';
  const body = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: origin,
    client_reference_id: uid,
    'metadata[uid]': uid,
  });

  if (email) body.set('customer_email', email);

  const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await stripeResponse.json();
  if (!stripeResponse.ok) {
    response.status(500).json({ error: 'stripe_error', message: data.error?.message || 'Stripe checkout failed.' });
    return;
  }

  response.status(200).json({ configured: true, mode: testMode ? 'test' : 'live', url: data.url });
};
