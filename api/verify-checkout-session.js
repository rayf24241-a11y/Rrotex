module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const hasTestKey = Boolean(process.env.STRIPE_TEST_SECRET_KEY);
  const testMode  = process.env.STRIPE_MODE === 'test' || (process.env.STRIPE_MODE !== 'live' && hasTestKey);
  const secretKey = testMode ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    response.status(200).json({ verified: false, message: 'Stripe is not configured.' });
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

  response.status(200).json({
    verified: true,
    pro: true,
    subscriptionId: session.subscription || '',
  });
};
