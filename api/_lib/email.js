// Shared email sender: Gmail SMTP (nodemailer) first, then Resend, silently
// no-ops if neither is configured. Never throws — callers can fire-and-await
// without wrapping in their own try/catch.
async function sendEmail({ to, subject, html }) {
  if (!to) return false;

  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  const gmailUser = process.env.GMAIL_USER || 'rayf24241@gmail.com';
  if (gmailPass) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: gmailUser, pass: gmailPass },
      });
      await transporter.sendMail({ from: `ROTEX <${gmailUser}>`, to, subject, html });
      return true;
    } catch (err) {
      console.error('Gmail send failed:', err.message);
    }
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const emailFrom = process.env.EMAIL_FROM || 'ROTEX <onboarding@resend.dev>';
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: emailFrom, to, subject, html }),
      });
      return res.ok;
    } catch (err) {
      console.error('Resend failed:', err.message);
    }
  }

  return false;
}

module.exports = { sendEmail };
