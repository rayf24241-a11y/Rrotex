// Server-authoritative TexToken wallet, stored in Vercel KV (Upstash Redis).
//
// The purchased balance lives here -- a server-only store the user cannot
// reach -- so it can only RISE from a Stripe-verified purchase (credit) and
// FALL from real usage (spend). This is what makes the balance unfakeable:
// nothing the client controls can change it.
//
// Everything is fail-safe: any Redis error returns null / no-ops and never
// throws, so a KV outage can never break chat or checkout. Callers treat a
// null balance as "not enabled / unknown" and fall back to their non-wallet
// path (the Firestore read), so the app keeps working if KV isn't configured.

const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const WALLET_PREFIX = 'rotex:wallet:';
const CREDITED_PREFIX = 'rotex:credited:';
const DEDUP_TTL_SECONDS = 400 * 24 * 60 * 60; // ~400 days: bounds key growth, still prevents realistic replay

function walletEnabled() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function redisCommand(...args) {
  if (!walletEnabled()) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`redis_${res.status}`);
  const data = await res.json();
  return data?.result;
}

function cleanId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 128);
}

// Current balance in TexTokens, or null if the key doesn't exist yet (caller
// should seed it once from the legacy Firestore balance).
async function getBalance(uid) {
  const key = cleanId(uid);
  if (!key || !walletEnabled()) return null;
  try {
    const result = await redisCommand('GET', WALLET_PREFIX + key);
    if (result === null || result === undefined) return null;
    return Math.max(0, Math.floor(Number(result) || 0));
  } catch { return null; }
}

// One-time migration of a pre-wallet balance. NX so it never overwrites a
// wallet that already exists (won't clobber real spend/credit history).
async function seed(uid, amount) {
  const key = cleanId(uid);
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (!key || !walletEnabled()) return;
  try { await redisCommand('SET', WALLET_PREFIX + key, String(amt), 'NX'); } catch {}
}

// Credit a Stripe-verified purchase EXACTLY once, deduped by the checkout
// session id (so a refreshed success page can't double-credit). Marks the
// session first, then increments -- if a rare mid-op failure loses a credit it
// under-credits (safe for the business) rather than double-credits.
// Returns the new balance, or null on failure / duplicate.
async function credit(uid, sessionId, amount) {
  const key = cleanId(uid);
  const sid = cleanId(sessionId);
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (!key || !sid || !amt || !walletEnabled()) return null;
  try {
    const firstTime = await redisCommand('SET', CREDITED_PREFIX + sid, '1', 'NX', 'EX', String(DEDUP_TTL_SECONDS));
    if (firstTime !== 'OK') return null; // already credited this session
    const balance = await redisCommand('INCRBY', WALLET_PREFIX + key, String(amt));
    return Math.max(0, Math.floor(Number(balance) || 0));
  } catch { return null; }
}

// Deduct real usage, floored at 0.
async function spend(uid, amount) {
  const key = cleanId(uid);
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (!key || !amt || !walletEnabled()) return;
  try {
    const balance = await redisCommand('INCRBY', WALLET_PREFIX + key, String(-amt));
    if (Number(balance) < 0) await redisCommand('SET', WALLET_PREFIX + key, '0');
  } catch {}
}

module.exports = { walletEnabled, getBalance, seed, credit, spend };
