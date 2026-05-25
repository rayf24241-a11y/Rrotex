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

  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const token = signPayload({ email, codeHash: hash(code), expiresAt });

  // ── 1. Gmail SMTP (nodemailer) ─────────────────────────────────────────────
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  const gmailUser = process.env.GMAIL_USER || 'rayf24241@gmail.com';
  if (gmailPass) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: gmailUser, pass: gmailPass },
      });
      await transporter.sendMail({
        from: `ROTEX <${gmailUser}>`,
        to: email,
        subject: 'Your ROTEX login code',
        html: `<div style="font-family:sans-serif;max-width:400px">
          <h2 style="color:#4cc9f0">ROTEX</h2>
          <p>Your login code is:</p>
          <h1 style="font-size:52px;letter-spacing:10px;margin:8px 0">${code}</h1>
          <p style="color:#888;font-size:13px">Expires in 10 minutes. If you didn't request this, ignore it.</p>
        </div>`,
      });
      response.status(200).json({ ok: true, token });
      return;
    } catch (err) {
      console.error('Gmail send failed:', err.message);
    }
  }

  // ── 2. Resend ──────────────────────────────────────────────────────────────
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const emailFrom = process.env.EMAIL_FROM || 'ROTEX <onboarding@resend.dev>';
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: emailFrom,
          to: email,
          subject: 'Your ROTEX login code',
          html: `<p>Your ROTEX login code is:</p><h1>${code}</h1><p>Expires in 10 minutes.</p>`,
        }),
      });
      if (res.ok) {
        response.status(200).json({ ok: true, token });
        return;
      }
    } catch (err) {
      console.error('Resend failed:', err.message);
    }
  }

  // ── 3. Dev fallback — show code on screen ─────────────────────────────────
  response.status(200).json({
    ok: true,
    token,
    devCode: code,
    message: 'Email sender not configured — showing code on screen.',
  });
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
