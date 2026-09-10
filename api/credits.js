const { getAuthUserId } = require('./_lib/clerk-auth');
const { getBalance, getPlan } = require('./_lib/credits-store');
const { getBatchLimit } = require('./_lib/pricing');

// Real per-account balance now (Clerk user id -> Redis), replacing the old
// anonymous-cookie mock. Signed-out visitors get no balance -- there's
// nothing to charge or display until there's a real account.
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const userId = await getAuthUserId(req);
    if (!userId) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'Sign in required.' }));
      return;
    }
    const credits = await getBalance(userId);
    const plan = await getPlan(userId);
    const batchLimit = getBatchLimit(plan);
    res.statusCode = 200;
    res.end(JSON.stringify({ credits, plan, batchLimit }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Could not load credits' }));
  }
};
