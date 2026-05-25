const crypto = require('crypto');

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const email = String(request.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    response.status(400).json({ error: 'bad_email', message: 'Enter a real email address.' });
    return;
  }

  const resendKey = process.env.RESEND_API_KEY;
  const emailFrom = process.env.EMAIL_FROM || 'ROTEX <onboarding@resend.dev>';
  if (!resendKey) {
    response.status(503).json({
      error: 'email_not_configured',
      message: 'Email codes need RESEND_API_KEY in Vercel.',
    });
    return;
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const token = signPayload({ email, codeHash: hash(code), expiresAt });

  const emailResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: emailFrom,
      to: email,
      subject: 'Your ROTEX login code',
      html: `<p>Your ROTEX login code is:</p><h1>${code}</h1><p>This code expires in 10 minutes.</p>`,
    }),
  });

  if (!emailResponse.ok) {
    response.status(502).json({ error: 'email_failed', message: 'ROTEX could not send that code yet.' });
    return;
  }

  response.status(200).json({ ok: true, token });
};

function secret() {
  return process.env.EMAIL_CODE_SECRET || process.env.STRIPE_SECRET_KEY || process.env.FIREBASE_API_KEY || 'rotex-dev-secret';
}

function hash(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex');
}

function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
