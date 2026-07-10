// Roblox OAuth callback: exchanges the one-time code for a token SERVER-SIDE
// (the client secret never touches the browser), reads the identity-only
// profile, and hands just the public identity (id + username) back to the
// signed-in page to link. The access token is used once for /userinfo and
// discarded — it is never sent to the browser or stored.
module.exports = async function handler(request, response) {
  const clientId = process.env.ROBLOX_OAUTH_CLIENT_ID;
  const clientSecret = process.env.ROBLOX_OAUTH_CLIENT_SECRET;
  const q = request.query || {};
  const code = String(q.code || '');
  const state = String(q.state || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
  const redirectUri = `${canonicalOrigin(request)}/api/connect/roblox-callback`;

  const back = (hash) => {
    // response.end (not .send) so this works on both Vercel and the local
    // dev-server, which doesn't provide the .send helper.
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.statusCode = 200;
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>ROTEX</title></head><body style="background:#070A12;color:#EAF0FC;font-family:-apple-system,Segoe UI,sans-serif">
      <script>try{window.location.replace('/account#${hash}')}catch(e){window.location.href='/account'}</script>
      <p style="padding:24px">Returning to ROTEX…</p></body></html>`);
  };

  if (!clientId || !clientSecret) return back('roblox_error=not_configured');
  if (!code) return back('roblox_error=' + encodeURIComponent(String(q.error || 'no_code')));

  try {
    const tokenRes = await fetch('https://apis.roblox.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
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

    // Identity only. `sub` is the Roblox user id; the rest is public profile.
    const profile = {
      id: String(info.sub),
      username: String(info.preferred_username || info.name || ''),
      display: String(info.nickname || info.name || ''),
      picture: String(info.picture || ''),
      state,
    };
    const payload = Buffer.from(JSON.stringify(profile)).toString('base64');
    return back('roblox=' + encodeURIComponent(payload));
  } catch {
    return back('roblox_error=exchange_error');
  }
};

function canonicalOrigin(request) {
  const host = request.headers.host || '';
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    return `${protocol}://${host}`;
  }
  return 'https://www.rrotex.com';
}
