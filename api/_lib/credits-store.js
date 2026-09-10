const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const STARTING_BALANCE = 50; // every new account starts with 50 free credits

async function getBalance(userId) {
  let balance = await redis.get(`credits:${userId}`);
  if (balance === null || balance === undefined) {
    balance = STARTING_BALANCE;
    await redis.set(`credits:${userId}`, balance);
  }
  return Number(balance);
}

// Positive delta to add credits, negative to spend/deduct. Atomic, and seeds
// the starting balance first so a brand-new account can't get an
// out-of-nowhere negative balance from a concurrent first request.
async function adjustBalance(userId, delta) {
  await getBalance(userId);
  const newBalance = await redis.incrby(`credits:${userId}`, delta);
  return Number(newBalance);
}

async function getPlan(userId) {
  const plan = await redis.get(`plan:${userId}`);
  return plan || 'free';
}

async function setPlan(userId, plan) {
  await redis.set(`plan:${userId}`, plan);
}

// Stripe can retry the same webhook event -- record processed event ids so a
// retry never double-credits an account or double-grants a subscription.
async function wasEventProcessed(eventId) {
  return !!(await redis.get(`stripe_event:${eventId}`));
}

async function markEventProcessed(eventId) {
  await redis.set(`stripe_event:${eventId}`, 1, { ex: 60 * 60 * 24 * 30 });
}

// First-ever credit pack purchase grants a 15% bonus (more credits, same
// price) -- tracked once per account so it can't be reused.
async function hasUsedFirstPurchaseBonus(userId) {
  return !!(await redis.get(`first_purchase_bonus:${userId}`));
}

async function markFirstPurchaseBonusUsed(userId) {
  await redis.set(`first_purchase_bonus:${userId}`, 1);
}

async function getJob(jobId) {
  return redis.get(`job:${jobId}`);
}

async function setJob(jobId, data) {
  await redis.set(`job:${jobId}`, data);
}

module.exports = {
  getBalance, adjustBalance, getPlan, setPlan,
  wasEventProcessed, markEventProcessed,
  hasUsedFirstPurchaseBonus, markFirstPurchaseBonusUsed,
  getJob, setJob, STARTING_BALANCE,
};
