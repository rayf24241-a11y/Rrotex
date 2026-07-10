// "Sign in with Roblox" — one function handles BOTH the OAuth start and the
// callback (Vercel Hobby caps at 12 functions, so start+callback share a URL).
// - No `code` param  -> START: return the Roblox authorize URL (JSON).
// - `code` present   -> CALLBACK: exchange it server-side and return the
//   identity to the signed-in page.
// Lowest scope only: `openid profile` = user id + username + avatar. It cannot
// read assets, spend Robux, message, or change anything on the account.
// Env-gated: dormant until ROBLOX_OAUTH_CLIENT_ID / ROBLOX_OAUTH_CLIENT_SECRET
// are set, so shipping it changes nothing until the Roblox OAuth app exists.
module.exports = async function handler(request, response) {
  const clientId = process.env.ROBLOX_OAUTH_CLIENT_ID;
  const clientSecret = process.env.ROBLOX_OAUTH_CLIENT_SECRET;
  const q = request.query || {};
  const redirectUri = `${canonicalOrigin(request)}/api/connect/roblox`;

  // ── CALLBACK: Roblox redirected back here with ?code=...&state=... ──
  if (q.code || q.error) {
    const back = (hash) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.statusCode = 200;
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>ROTEX</title></head><body style="background:#070A12;color:#EAF0FC;font-family:-apple-system,Segoe UI,sans-serif">
        <script>try{window.location.replace('/account#${hash}')}catch(e){window.location.href='/account'}</script>
        <p style="padding:24px">Returning to ROTEX…</p></body></html>`);
    };
    const state = String(q.state || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
    if (!clientId || !clientSecret) return back('roblox_error=not_configured');
    if (!q.code) return back('roblox_error=' + encodeURIComponent(String(q.error || 'no_code')));
    try {
      const tokenRes = await fetch('https://apis.roblox.com/oauth/v1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code: String(q.code),
          redirect_uri: redirectUri,
        }),
      });
      const tok = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tok.access_token) return back('roblox_error=token_exchange_failed');

      const infoRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      const info = await infoRes.json().catch(() => ({}));
      if (!infoRes.ok || !info.sub) return back('roblox_error=userinfo_failed');

      // Identity only — the access token is used once here and discarded.
      const profile = {
        id: String(info.sub),
        username: String(info.preferred_username || info.name || ''),
        display: String(info.nickname || info.name || ''),
        picture: String(info.picture || ''),
        state,
      };
      return back('roblox=' + encodeURIComponent(Buffer.from(JSON.stringify(profile)).toString('base64')));
    } catch {
      return back('roblox_error=exchange_error');
    }
  }

  // ── START: return the authorize URL for the frontend to navigate to ──
  if (!clientId) {
    response.status(200).json({
      configured: false,
      message: 'Roblox sign-in is not set up yet. Add ROBLOX_OAUTH_CLIENT_ID and ROBLOX_OAUTH_CLIENT_SECRET in Vercel, and register this redirect URI on the Roblox OAuth app.',
      redirect_uri: redirectUri,
    });
    return;
  }
  const state = String(q.state || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128) || 'rotex-roblox';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile', // LOW: identity only — nothing sensitive.
    response_type: 'code',
    state,
  });
  response.status(200).json({
    configured: true,
    redirect_uri: redirectUri,
    url: `https://apis.roblox.com/oauth/v1/authorize?${params.toString()}`,
  });
};

function canonicalOrigin(request) {
  const host = request.headers.host || '';
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    return `${protocol}://${host}`;
  }
  return 'https://www.rrotex.com';
}
