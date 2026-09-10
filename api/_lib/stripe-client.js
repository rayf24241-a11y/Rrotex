const Stripe = require('stripe');

let cached = null;

function getStripe() {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  cached = new Stripe(key);
  return cached;
}

module.exports = { getStripe };
