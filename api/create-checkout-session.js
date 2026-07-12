const { verifyProPass } = require('./_lib/propass.js');

// 2026-07 re-denomination: $1 = 2 displayed TexTokens. Internally 1 displayed
// TexToken = 30,000 units (see TT_UNIT in api/chat.js), so $1 credits 60k
// internal units to the wallet. Existing balances keep their internal value.
const TT_UNIT = 30_000;
const TOKENS_PER_DOLLAR = 20 * TT_UNIT; // $1 = 20 TexTokens (raised from 2 -- old rate was ~25x worse value than Pro and bought less than one build)
const PRO_PRICE_CENTS = 2000; // $20 - one-time charge, grants 30 days of Pro

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secretKey = cleanEnv(process.env.STRIPE_SECRET_KEY);
  const priceId   = cleanEnv(process.env.STRIPE_PRICE_ID);

  const { uid = '', email = '', kind = 'pro', dollars = 0, authToken = '' } = request.body || {};
  const isCreditCheckout = kind === 'credits';
  const desktopCallback = normalizeDesktopCallback(request.body?.desktopCallback);
  const desktopCallbackQuery = desktopCallback ? `&desktop_callback=${encodeURIComponent(desktopCallback)}` : '';

  if (!secretKey) {
    response.status(200).json({
      configured: false,
      message: 'Stripe is not configured. Add STRIPE_SECRET_KEY in Vercel.',
    });
    return;
  }

  // Live checkout only. Reject test keys so real pricing never silently uses test mode.
  if (secretKey.startsWith('sk_test_')) {
    response.status(500).json({
      configured: false,
      message: 'STRIPE_SECRET_KEY is a test key. Set a live Stripe key (sk_live_...) in Vercel to charge real payments.',
    });
    return;
  }

  if (!uid) {
    response.status(401).json({ error: 'login_required', message: 'Log in before continuing to Stripe.' });
    return;
  }

  const auth = await verifyFirebaseToken(authToken);
  if (!auth.ok || auth.uid !== uid) {
    response.status(401).json({ error: 'login_required', message: 'Your login expired. Sign in again before checkout.' });
    return;
  }
  const verifiedEmail = auth.email || email || '';

  if (!isCreditCheckout) {
    const existingPass = verifyProPass(request.body?.proPass || '');
    if (existingPass?.uid === uid) {
      // One-time Pro pass (no subscription id) - verifyProPass already
      // rejects expired passes, so a valid one here is still within its 30 days.
      if (!existingPass.sub) {
        response.status(200).json({
          configured: true,
          alreadyPro: true,
          message: 'You already have an active Pro pass.',
        });
        return;
      }
      const active = await stripeSubscriptionIsActive(secretKey, existingPass.sub);
      if (active) {
        response.status(200).json({
          configured: true,
          alreadyPro: true,
          message: 'You already have an active Pro subscription.',
        });
        return;
      }
    }
    if (await stripeUidHasActiveSubscription(secretKey, uid)) {
      response.status(200).json({
        configured: true,
        alreadyPro: true,
        message: 'This account already has an active Pro subscription.',
      });
      return;
    }
    if (verifiedEmail && await stripeEmailHasActiveSubscription(secretKey, verifiedEmail, priceId)) {
      response.status(200).json({
        configured: true,
        alreadyPro: true,
        message: 'This email already has an active Pro subscription.',
      });
      return;
    }
  }

  const origin = request.headers.origin || 'https://www.rrotex.com';
  let body;

  if (isCreditCheckout) {
    const amount = Math.floor(Number(dollars));
    if (!Number.isFinite(amount) || amount < 5 || amount > 500) {
      response.status(400).json({ error: 'invalid_amount', message: 'Choose an amount between $5 and $500.' });
      return;
    }
    const texTokens = amount * TOKENS_PER_DOLLAR;
    body = new URLSearchParams({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `${texTokens / TT_UNIT} ROTEX TexTokens`,
      'line_items[0][price_data][unit_amount]': String(amount * 100),
      'line_items[0][quantity]': '1',
      success_url: `${origin}/account?credits=success&session_id={CHECKOUT_SESSION_ID}${desktopCallbackQuery}`,
      cancel_url:  `${origin}/account#credits`,
      client_reference_id: uid,
      'metadata[uid]':       uid,
      'metadata[email]':     verifiedEmail,
      'metadata[kind]':      'textokens',
      'metadata[dollars]':   String(amount),
      'metadata[textokens]': String(texTokens),
    });
  } else {
    // One-time charge, not a recurring subscription: grants exactly 30 days
    // of Pro (see verify-checkout-session.js), then the user buys again.
    body = new URLSearchParams({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': 'ROTEX Pro - 30 days',
      'line_items[0][price_data][unit_amount]': String(PRO_PRICE_CENTS),
      'line_items[0][quantity]': '1',
      success_url: `${origin}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}${desktopCallbackQuery}`,
      cancel_url:  `${origin}/account#pro`,
      client_reference_id: uid,
      'metadata[uid]':  uid,
      'metadata[email]': verifiedEmail,
      'metadata[kind]': 'pro',
    });
  }

  if (verifiedEmail) body.set('customer_email', verifiedEmail);

  const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await stripeResponse.json();
  if (!stripeResponse.ok) {
    response.status(500).json({ error: 'stripe_error', message: data.error?.message || 'Stripe checkout failed.' });
    return;
  }

  response.status(200).json({ configured: true, mode: 'live', url: data.url });
};

function cleanEnv(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/[^\x20-\x7E]/g, '');
}

function normalizeDesktopCallback(value) {
  const port = Number(String(value || '').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
  return String(port);
}

async function stripeSubscriptionIsActive(secretKey, subscriptionId) {
  const stripeResponse = await fetch(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  const subscription = await stripeResponse.json().catch(() => ({}));
  if (!stripeResponse.ok) return false;
  return subscription.status === 'active' || subscription.status === 'trialing';
}

async function stripeEmailHasActiveSubscription(secretKey, email, priceId) {
  const customerResponse = await fetch(
    `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=10`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  const customers = await customerResponse.json().catch(() => ({}));
  if (!customerResponse.ok || !Array.isArray(customers.data)) return false;
  for (const customer of customers.data) {
    const subResponse = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customer.id)}&status=all&limit=10`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    const subs = await subResponse.json().catch(() => ({}));
    if (subResponse.ok && Array.isArray(subs.data) && subs.data.some((sub) => isActiveProSubscription(sub, priceId))) {
      return true;
    }
  }
  return false;
}

async function stripeUidHasActiveSubscription(secretKey, uid) {
  const active = await searchStripeSubscriptions(secretKey, `metadata['uid']:'${escapeStripeSearch(uid)}' AND metadata['kind']:'pro' AND status:'active'`);
  if (active) return true;
  return searchStripeSubscriptions(secretKey, `metadata['uid']:'${escapeStripeSearch(uid)}' AND metadata['kind']:'pro' AND status:'trialing'`);
}

async function searchStripeSubscriptions(secretKey, query) {
  const searchResponse = await fetch(
    `https://api.stripe.com/v1/subscriptions/search?${new URLSearchParams({ query, limit: '1' }).toString()}`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  const result = await searchResponse.json().catch(() => ({}));
  return searchResponse.ok && Array.isArray(result.data) && result.data.length > 0;
}

function escapeStripeSearch(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isActiveProSubscription(subscription, priceId) {
  if (subscription.status !== 'active' && subscription.status !== 'trialing') return false;
  if (subscription.metadata?.kind === 'pro') return true;
  const items = Array.isArray(subscription.items?.data) ? subscription.items.data : [];
  return items.some((item) => item.price?.id === priceId);
}

async function verifyFirebaseToken(authToken) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'rotex-e0be7';
  if (!authToken || !projectId) return { ok: false };
  try {
    const result = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(authToken)}`);
    if (result.ok) {
      const token = await result.json();
      return {
        ok: token.aud === projectId && Boolean(token.sub),
        uid: token.sub || '',
        email: token.email || '',
      };
    }
  } catch {}
  return verifyFirebaseTokenSignature(authToken, projectId);
}

async function verifyFirebaseTokenSignature(authToken, projectId) {
  try {
    const [headerPart, payloadPart, signaturePart] = String(authToken || '').split('.');
    if (!headerPart || !payloadPart || !signaturePart) return { ok: false };
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (payload.aud !== projectId) return { ok: false };
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return { ok: false };
    const certsRes = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    if (!certsRes.ok) return { ok: false };
    const certs = await certsRes.json();
    const cert = certs[header.kid];
    if (!cert) return { ok: false };
    const crypto = require('crypto');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), cert, Buffer.from(signaturePart, 'base64url'));
    return {
      ok,
      uid: ok ? (payload.sub || payload.user_id || '') : '',
      email: ok ? (payload.email || '') : '',
    };
  } catch {
    return { ok: false };
  }
}
