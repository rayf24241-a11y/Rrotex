const LOW_EMAIL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const lowCreditEmailTimes = new Map();
const usageLogs = [];

function providerBalanceUsd() {
  const value = Number(process.env.PROVIDER_CREDIT_BALANCE || process.env.ROTEXT_PROVIDER_CREDIT_BALANCE || process.env.ROTEX_PROVIDER_CREDIT_BALANCE || 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function estimateTokens(messages, maxTokens) {
  const inputText = (messages || []).map((message) => String(message.content || '')).join('\n');
  const inputTokens = Math.max(1, Math.ceil(inputText.length / 4));
  const outputTokens = Math.max(1, Math.ceil(Number(maxTokens || 900) * 0.45));
  return { inputTokens, outputTokens };
}

function estimateTexTokens(selected, messages, maxTokens, mode = {}) {
  const tokens = estimateTokens(messages, maxTokens);
  let textokens = (
    tokens.inputTokens * (selected.inputTexTokens || 1)
    + tokens.outputTokens * (selected.outputTexTokens || 1)
  ) * (selected.multiplier || 1);
  if (mode.agent) textokens *= 2;
  if (mode.superAgent) textokens *= 4;
  return {
    ...tokens,
    textokens: Math.ceil(textokens),
    providerCostUsd: textokens / 1000000,
  };
}

async function checkCreditSafety({ selected, provider, model, userId, estimate, texTokensLeft }) {
  const balance = providerBalanceUsd();
  if (Number.isFinite(Number(texTokensLeft)) && Number(texTokensLeft) <= 0) {
    return {
      ok: false,
      error: 'no_textokens',
      text: 'You are out of TexTokens. Upgrade to Pro or add more TexTokens to continue.',
      balance,
    };
  }
  if (Number.isFinite(Number(texTokensLeft)) && estimate.textokens > Number(texTokensLeft)) {
    return {
      ok: false,
      error: 'no_textokens',
      text: 'You are out of TexTokens. Upgrade to Pro or add more TexTokens to continue.',
      balance,
    };
  }
  if (balance < 5) {
    await sendLowCreditEmail({ balance, provider, model, userId, estimatedCost: estimate.providerCostUsd });
    return {
      ok: false,
      error: 'provider_credits_empty',
      text: 'Too many requests right now. Please retry later or upgrade/add TexTokens.',
      balance,
    };
  }
  if (balance < 10 && selected.expensive) {
    await sendLowCreditEmail({ balance, provider, model, userId, estimatedCost: estimate.providerCostUsd });
    return {
      ok: false,
      error: 'provider_credits_low',
      text: 'AI is busy right now. Please retry later.',
      balance,
    };
  }
  if (estimate.providerCostUsd > balance) {
    await sendLowCreditEmail({ balance, provider, model, userId, estimatedCost: estimate.providerCostUsd });
    return {
      ok: false,
      error: 'provider_credits_low',
      text: 'Too many requests right now. Please retry later or upgrade/add TexTokens.',
      balance,
    };
  }
  if (balance < 10) {
    await sendLowCreditEmail({ balance, provider, model, userId, estimatedCost: estimate.providerCostUsd });
  }
  return { ok: true, balance };
}

function insufficientCreditsError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return /insufficient|credit|quota|billing|payment|required balance|low balance|out of credits/.test(text);
}

async function onInsufficientCredits({ provider, model, userId, estimate, reason = 'insufficient credits' }) {
  const balance = providerBalanceUsd();
  await sendLowCreditEmail({ balance, provider, model, userId, estimatedCost: estimate?.providerCostUsd || 0, reason });
}

function logUsage(entry) {
  usageLogs.push({
    user_id: entry.user_id || 'unknown',
    model: entry.model || '',
    input_tokens: Math.max(0, Math.floor(Number(entry.input_tokens) || 0)),
    output_tokens: Math.max(0, Math.floor(Number(entry.output_tokens) || 0)),
    real_provider_cost: Math.max(0, Number(entry.real_provider_cost) || 0),
    textokens_charged: Math.max(0, Math.ceil(Number(entry.textokens_charged) || 0)),
    status: entry.status || 'unknown',
    created_at: new Date().toISOString(),
  });
  if (usageLogs.length > 1000) usageLogs.splice(0, usageLogs.length - 1000);
}

function adminUsageSummary() {
  const today = new Date().toISOString().slice(0, 10);
  const todayLogs = usageLogs.filter((item) => String(item.created_at).startsWith(today));
  return {
    providerBalance: providerBalanceUsd(),
    totalUsageToday: todayLogs.length,
    totalProviderCostToday: todayLogs.reduce((sum, item) => sum + Number(item.real_provider_cost || 0), 0),
    totalTexTokensSpent: todayLogs.reduce((sum, item) => sum + Number(item.textokens_charged || 0), 0),
    lowCreditWarnings: providerBalanceUsd() < 10,
  };
}

async function sendLowCreditEmail({ balance, provider, model, userId, estimatedCost, reason = 'low or empty credits' }) {
  const key = `${provider || 'provider'}:${balance < 5 ? 'under5' : 'under10'}:${reason}`;
  const now = Date.now();
  if (now - Number(lowCreditEmailTimes.get(key) || 0) < LOW_EMAIL_COOLDOWN_MS) return;
  lowCreditEmailTimes.set(key, now);

  const to = 'rayf24241@gmail.com';
  const subject = 'ROTEX credits are low';
  const text = [
    'ROTEX provider credits are low or empty.',
    '',
    `Current provider balance: ${balance}`,
    `Provider: ${provider || 'unknown'}`,
    `Model: ${model || 'unknown'}`,
    `User ID: ${userId || 'unknown'}`,
    `Task estimate: ${estimatedCost || 0}`,
    `Reason: ${reason}`,
    `Time: ${new Date().toISOString()}`,
    '',
    'Please add more credits so users can keep using ROTEX.',
  ].join('\n');

  try {
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    const gmailUser = process.env.GMAIL_USER || 'rayf24241@gmail.com';
    if (gmailPass) {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: gmailUser, pass: gmailPass },
      });
      await transporter.sendMail({ from: `ROTEX <${gmailUser}>`, to, subject, text });
      return;
    }

    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'ROTEX <onboarding@resend.dev>',
          to,
          subject,
          text,
        }),
      });
    }
  } catch (error) {
    console.error('Low credit email failed:', error?.message || error);
  }
}

module.exports = {
  adminUsageSummary,
  checkCreditSafety,
  estimateTexTokens,
  insufficientCreditsError,
  logUsage,
  onInsufficientCredits,
  providerBalanceUsd,
};
