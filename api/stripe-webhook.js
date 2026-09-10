const { getStripe } = require('./_lib/stripe-client');
const { PLANS } = require('./_lib/stripe-catalog');
const {
  adjustBalance, setPlan, wasEventProcessed, markEventProcessed,
  hasUsedFirstPurchaseBonus, markFirstPurchaseBonusUsed,
} = require('./_lib/credits-store');

// Stripe signature verification needs the exact raw request bytes -- do not
// JSON-parse before this, or the signature check will fail.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method not allowed');
    return;
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Stripe webhook misconfigured: missing STRIPE_WEBHOOK_SECRET.');
    res.statusCode = 500;
    res.end('Webhook not configured');
    return;
  }
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    res.statusCode = 400;
    res.end('Missing stripe-signature header');
    return;
  }

  const rawBody = await readRawBody(req);
  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    res.statusCode = 400;
    res.end('Invalid signature');
    return;
  }

  if (await wasEventProcessed(event.id)) {
    res.statusCode = 200;
    res.end('Already processed');
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.metadata && session.metadata.kind === 'pack') {
        const userId = session.metadata.userId;
        let credits = Number(session.metadata.credits) || 0;
        if (userId && credits > 0) {
          const isFirstPurchase = !(await hasUsedFirstPurchaseBonus(userId));
          if (isFirstPurchase) {
            credits = Math.round(credits * 1.15);
            await markFirstPurchaseBonusUsed(userId);
          }
          await adjustBalance(userId, credits);
        }
      }
      // Subscription plan activation happens on invoice.paid below, which
      // fires for the very first invoice too -- one code path for both
      // "just subscribed" and "renewed".
    }

    if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
      if (subscriptionId) {
        const stripe = getStripe();
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const meta = subscription.metadata || {};
        const plan = PLANS[meta.planId];
        if (meta.userId && plan) {
          await setPlan(meta.userId, meta.planId);
          await adjustBalance(meta.userId, plan.monthlyCredits);
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const meta = subscription.metadata || {};
      if (meta.userId) await setPlan(meta.userId, 'free');
    }

    await markEventProcessed(event.id);
    res.statusCode = 200;
    res.end('ok');
  } catch (err) {
    console.error('Stripe webhook handling failed:', err.message);
    res.statusCode = 500;
    res.end('Internal error');
  }
};
