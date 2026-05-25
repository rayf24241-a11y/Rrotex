const crypto = require('crypto');

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const email = String(request.body?.email || '').trim().toLowerCase();
  const code = String(request.body?.code || '').trim();
  const token = String(request.body?.token || '');
  const payload = readPayload(token);

  if (!payload || payload.email !== email || payload.expiresAt < Date.now() || payload.codeHash !== hash(code)) {
    response.status(400).json({ error: 'bad_code', message: 'That email code is wrong or expired.' });
    return;
  }

  response.status(200).json({
    ok: true,
    sessionPassword: hash(`firebase-session:${email}`).slice(0, 32),
  });
};

function secret() {
  return process.env.EMAIL_CODE_SECRET || process.env.STRIPE_SECRET_KEY || process.env.FIREBASE_API_KEY || 'rotex-dev-secret';
}

function hash(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex');
}

function readPayload(token) {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
