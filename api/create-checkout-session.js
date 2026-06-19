const TOKENS_PER_DOLLAR = 400_000; // $2.50 per 1M tokens

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const liveSecretKey = cleanEnv(process.env.STRIPE_SECRET_KEY);
  const livePriceId   = cleanEnv(process.env.STRIPE_PRICE_ID);
  const testSecretKey = cleanEnv(process.env.STRIPE_TEST_SECRET_KEY);
  const testPriceId   = cleanEnv(process.env.STRIPE_TEST_PRICE_ID);
  const hasTestKeys   = Boolean(testSecretKey && testPriceId);
  const hasLiveKeys   = Boolean(liveSecretKey && livePriceId);
  const testMode      = !hasLiveKeys && (process.env.STRIPE_MODE === 'test' || hasTestKeys);
  const secretKey     = testMode ? testSecretKey : liveSecretKey;
  const priceId       = testMode ? testPriceId   : livePriceId;

  const { uid = '', email = '', kind = 'pro', dollars = 0 } = request.body || {};
  const isCreditCheckout = kind === 'credits';

  if (!secretKey || (!isCreditCheckout && !priceId)) {
    const missingNames = testMode
      ? 'STRIPE_TEST_SECRET_KEY and STRIPE_TEST_PRICE_ID'
      : 'STRIPE_SECRET_KEY and STRIPE_PRICE_ID';
    response.status(200).json({
      configured: false,
      message: `Stripe is not configured. Add ${missingNames} in Vercel.`,
    });
    return;
  }

  if (!uid) {
    response.status(401).json({ error: 'login_required', message: 'Log in before continuing to Stripe.' });
    return;
  }

  const origin = request.headers.origin || 'https://www.rrotex.com';
  let body;

  if (isCreditCheckout) {
    const amount = Math.floor(Number(dollars));
    if (!Number.isFinite(amount) || amount < 5 || amount > 500) {
      response.status(400).json({ error: 'invalid_amount', message: 'Choose an amount between $5 and $500.' });
      return;
    }
    const texTokens = amount * TOKENS_PER_DOLLAR;
    body = new URLSearchParams({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `${(texTokens / 1_000_000).toFixed(1)}M ROTEX TexTokens`,
      'line_items[0][price_data][unit_amount]': String(amount * 100),
      'line_items[0][quantity]': '1',
      success_url: `${origin}/account?credits=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/account#credits`,
      client_reference_id: uid,
      'metadata[uid]':       uid,
      'metadata[kind]':      'textokens',
      'metadata[dollars]':   String(amount),
      'metadata[textokens]': String(texTokens),
    });
  } else {
    body = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${origin}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/account#pro`,
      client_reference_id: uid,
      'metadata[uid]':  uid,
      'metadata[kind]': 'pro',
    });
  }

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

function cleanEnv(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/[^\x20-\x7E]/g, '');
}
