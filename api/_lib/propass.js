// Signed "Pro pass" - stateless proof of an active Pro subscription.
// Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256 of the payload)
// Payload: { uid, sub (Stripe subscription id), plan: 'pro', exp (epoch ms) }
const crypto = require('crypto');

function getSecret() {
  const secret = String(process.env.PRO_PASS_SECRET || '').trim();
  return secret.length >= 32 ? secret : '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signProPass(payload) {
  const secret = getSecret();
  if (!secret) return '';
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function verifyProPass(pass) {
  const secret = getSecret();
  if (!secret || typeof pass !== 'string' || pass.length > 2000) return null;
  const [body, sig] = pass.split('.', 2);
  if (!body || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.plan !== 'pro' && payload.plan !== 'plus') return null;
    if (!payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { signProPass, verifyProPass };
