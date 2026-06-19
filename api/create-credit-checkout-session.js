module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const liveSecretKey = cleanEnv(process.env.STRIPE_SECRET_KEY);
  const testSecretKey = cleanEnv(process.env.STRIPE_TEST_SECRET_KEY);
  const testMode = !liveSecretKey && (process.env.STRIPE_MODE === 'test' || Boolean(testSecretKey));
  const secretKey = testMode ? testSecretKey : liveSecretKey;

  if (!secretKey) {
    response.status(200).json({ configured: false, message: 'Stripe is not configured. Add STRIPE_SECRET_KEY in Vercel.' });
    return;
  }

  const { uid = '', email = '', dollars = 0 } = request.body || {};
  const amount = Math.floor(Number(dollars));
  if (!uid) {
    response.status(401).json({ error: 'login_required', message: 'Log in before buying TexTokens.' });
    return;
  }
  if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
    response.status(400).json({ error: 'invalid_amount', message: 'Choose a whole dollar amount from $1 to $500.' });
    return;
  }

  const texTokens = amount * 1000000;
  const origin = request.headers.origin || 'https://www.rrotex.com';
  const body = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': `${texTokens.toLocaleString()} ROTEX TexTokens`,
    'line_items[0][price_data][unit_amount]': String(amount * 100),
    'line_items[0][quantity]': '1',
    success_url: `${origin}/account?credits=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/account#credits`,
    client_reference_id: uid,
    'metadata[uid]': uid,
    'metadata[kind]': 'textokens',
    'metadata[dollars]': String(amount),
    'metadata[textokens]': String(texTokens),
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
    response.status(500).json({ error: 'stripe_error', message: data.error?.message || 'Stripe credit checkout failed.' });
    return;
  }

  response.status(200).json({ configured: true, mode: testMode ? 'test' : 'live', url: data.url });
};

function cleanEnv(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/[^\x20-\x7E]/g, '');
}
