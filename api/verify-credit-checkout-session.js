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
    response.status(500).json({ verified: false, message: session.error?.message || 'Could not verify credit checkout.' });
    return;
  }

  const paid = session.payment_status === 'paid' || session.status === 'complete';
  const userMatches = session.client_reference_id === uid || session.metadata?.uid === uid;
  const isCreditPack = session.metadata?.kind === 'textokens';
  if (!paid || !userMatches || !isCreditPack) {
    response.status(403).json({ verified: false, message: 'Checkout was not completed for this user.' });
    return;
  }

  const dollars = Math.floor(Number(session.metadata?.dollars || 0));
  const texTokens = Math.floor(Number(session.metadata?.textokens || dollars * 1000000));
  if (!dollars || !texTokens) {
    response.status(400).json({ verified: false, message: 'Credit checkout is missing token metadata.' });
    return;
  }

  response.status(200).json({
    verified: true,
    dollars,
    texTokens,
    sessionId: session.id,
  });
};

function cleanEnv(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/[^\x20-\x7E]/g, '');
}
