// GitHub connect — one function handles both the OAuth start and the callback
// (Vercel Hobby caps at 12 functions, so they share a URL).
// - No `code` param -> START: return the GitHub authorize URL (JSON).
// - `code` present  -> CALLBACK: mark GitHub as pending-activation and return.
module.exports = function handler(request, response) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const redirectUri = `${canonicalOrigin(request)}/api/connect/github`;
  const q = request.query || {};

  // ── CALLBACK ──
  if (q.code || q.error) {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.statusCode = 200;
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>GitHub connected</title></head><body>
      <script>try{localStorage.setItem('rotex:pending-activation','GitHub')}catch(e){};window.location.href='/';</script>
      <p>GitHub connected. Returning to ROTEX...</p></body></html>`);
    return;
  }

  // ── START ──
  if (!clientId) {
    response.status(200).json({
      configured: false,
      message: 'GitHub is not configured yet. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
      redirect_uri: redirectUri,
    });
    return;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read:user user:email repo',
    state: 'rotex-github',
  });

  response.status(200).json({
    configured: true,
    redirect_uri: redirectUri,
    url: `https://github.com/login/oauth/authorize?${params.toString()}`,
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
