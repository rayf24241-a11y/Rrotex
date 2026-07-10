// One-account-per-device guard, persisted in Vercel KV (Upstash Redis).
//
// The FIRST authenticated uid seen for a given key (client IP, or normalized
// Gmail base address) permanently CLAIMS that key. Any different uid on the
// same key is blocked -- so making a 2nd, 3rd, ... account never works; only
// the first one can chat. Persisted in KV, so it survives cold starts and
// can't be reset by the user (unlike the old in-memory, daily check).
//
// Fail-open: if KV isn't configured or errors, returns { enforced:false,
// allowed:true } and the caller falls back to its in-memory best-effort check.
// Scoped by the caller to FREE users only -- Pro/dev are never blocked, so a
// paying customer on a shared IP (family/school) is never locked out.

const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const OWNER_TTL = 90 * 24 * 60 * 60; // 90 days, refreshed on each visit by the owner (abandoned IPs eventually free up)

function guardEnabled() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function redisCommand(...args) {
  if (!guardEnabled()) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`redis_${res.status}`);
  return (await res.json())?.result;
}

function clean(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.:@-]/g, '').slice(0, 160);
}

// Claim (or check) ownership of a key by a uid. First uid wins.
// Returns { enforced, allowed, owner }.
async function claimOwner(namespace, id, uid) {
  const cid = clean(id);
  const cuid = clean(uid);
  if (!guardEnabled() || !cid || !cuid) return { enforced: false, allowed: true, owner: '' };
  const key = 'rotex:owner:' + namespace + ':' + cid;
  try {
    const setRes = await redisCommand('SET', key, cuid, 'NX', 'EX', String(OWNER_TTL));
    if (setRes === 'OK') return { enforced: true, allowed: true, owner: cuid }; // first account claims it
    const owner = await redisCommand('GET', key);
    if (owner === cuid) {
      await redisCommand('EXPIRE', key, String(OWNER_TTL)); // keep the active owner's claim alive
      return { enforced: true, allowed: true, owner };
    }
    return { enforced: true, allowed: false, owner: owner || '' };
  } catch {
    return { enforced: false, allowed: true, owner: '' };
  }
}

module.exports = { guardEnabled, claimOwner };
