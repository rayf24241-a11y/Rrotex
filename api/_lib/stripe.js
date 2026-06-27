// Stripe subscription helpers used by checkout, refresh-pro, and chat.

function cleanEnv(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/[^\x20-\x7E]/g, '');
}

function stripeMode() {
  const liveSecretKey = cleanEnv(process.env.STRIPE_SECRET_KEY);
  const livePriceId   = cleanEnv(process.env.STRIPE_PRICE_ID);
  const testSecretKey = cleanEnv(process.env.STRIPE_TEST_SECRET_KEY);
  const testPriceId   = cleanEnv(process.env.STRIPE_TEST_PRICE_ID);
  const hasTestKeys   = Boolean(testSecretKey && testPriceId);
  const hasLiveKeys   = Boolean(liveSecretKey && livePriceId);
  const testMode      = process.env.STRIPE_MODE === 'test' || (!hasLiveKeys && hasTestKeys);
  return {
    testMode,
    secretKey: testMode ? testSecretKey : liveSecretKey,
    priceId: testMode ? testPriceId : livePriceId,
  };
}

function isActiveProSubscription(subscription, priceId) {
  if (subscription.status !== 'active' && subscription.status !== 'trialing') return false;
  if (subscription.metadata?.kind === 'pro') return true;
  const items = Array.isArray(subscription.items?.data) ? subscription.items.data : [];
  return items.some((item) => item.price?.id === priceId);
}

async function stripeSubscriptionIsActive(secretKey, subscriptionId) {
  const stripeResponse = await fetch(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  const subscription = await stripeResponse.json().catch(() => ({}));
  if (!stripeResponse.ok) return false;
  return subscription.status === 'active' || subscription.status === 'trialing';
}

async function stripeEmailHasActiveSubscription(secretKey, email, priceId) {
  const customerResponse = await fetch(
    `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=10`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  const customers = await customerResponse.json().catch(() => ({}));
  if (!customerResponse.ok || !Array.isArray(customers.data)) return false;
  for (const customer of customers.data) {
    const subResponse = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customer.id)}&status=all&limit=10`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    const subs = await subResponse.json().catch(() => ({}));
    if (subResponse.ok && Array.isArray(subs.data) && subs.data.some((sub) => isActiveProSubscription(sub, priceId))) {
      return true;
    }
  }
  return false;
}

async function stripeUidHasActiveSubscription(secretKey, uid) {
  const active = await searchStripeSubscriptions(secretKey, `metadata['uid']:'${escapeStripeSearch(uid)}' AND metadata['kind']:'pro' AND status:'active'`);
  if (active) return true;
  return searchStripeSubscriptions(secretKey, `metadata['uid']:'${escapeStripeSearch(uid)}' AND metadata['kind']:'pro' AND status:'trialing'`);
}

async function searchStripeSubscriptions(secretKey, query) {
  const searchResponse = await fetch(
    `https://api.stripe.com/v1/subscriptions/search?${new URLSearchParams({ query, limit: '1' }).toString()}`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  const result = await searchResponse.json().catch(() => ({}));
  return searchResponse.ok && Array.isArray(result.data) && result.data.length > 0;
}

function escapeStripeSearch(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function userHasActiveProSubscription(uid, email, subscriptionId) {
  const { secretKey, priceId } = stripeMode();
  if (!secretKey) return false;

  // Fast path: existing subscription ID from a previous pass.
  if (subscriptionId) {
    const active = await stripeSubscriptionIsActive(secretKey, subscriptionId);
    if (active) return true;
  }

  // Search by Firebase UID stored in Stripe metadata.
  if (uid) {
    const activeByUid = await stripeUidHasActiveSubscription(secretKey, uid);
    if (activeByUid) return true;
  }

  // Fallback: search by email.
  if (email && priceId) {
    const activeByEmail = await stripeEmailHasActiveSubscription(secretKey, email, priceId);
    if (activeByEmail) return true;
  }

  return false;
}

module.exports = {
  cleanEnv,
  escapeStripeSearch,
  isActiveProSubscription,
  searchStripeSubscriptions,
  stripeEmailHasActiveSubscription,
  stripeMode,
  stripeSubscriptionIsActive,
  stripeUidHasActiveSubscription,
  userHasActiveProSubscription,
};
