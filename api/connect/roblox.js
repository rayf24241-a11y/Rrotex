// "Sign in with Roblox" — starts the Roblox OAuth 2.0 flow with the LOWEST
// possible scope: `openid profile` = identity only (user id, username, display
// name, avatar). It cannot read assets, spend Robux, message, or change
// anything on the account. Env-gated: dormant until ROBLOX_OAUTH_CLIENT_ID /
// ROBLOX_OAUTH_CLIENT_SECRET are set, so shipping it changes nothing until the
// Roblox OAuth app exists.
module.exports = function handler(request, response) {
  const clientId = process.env.ROBLOX_OAUTH_CLIENT_ID;
  const redirectUri = `${canonicalOrigin(request)}/api/connect/roblox-callback`;
  if (!clientId) {
    response.status(200).json({
      configured: false,
      message: 'Roblox sign-in is not set up yet. Add ROBLOX_OAUTH_CLIENT_ID and ROBLOX_OAUTH_CLIENT_SECRET in Vercel, and register this redirect URI on the Roblox OAuth app.',
      redirect_uri: redirectUri,
    });
    return;
  }

  // The frontend passes an opaque `state` (a random nonce it also stored in
  // sessionStorage) so the callback round-trip can't be forged (CSRF) and the
  // page knows the return belongs to it.
  const state = String((request.query && request.query.state) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128) || 'rotex-roblox';

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
