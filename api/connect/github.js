module.exports = function handler(request, response) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    response.status(200).json({
      configured: false,
      message: 'GitHub is not configured yet. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
    });
    return;
  }

  const origin = process.env.PUBLIC_SITE_URL || 'https://www.rrotex.com';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/connect/github-callback`,
    scope: 'read:user user:email repo',
    state: 'rotex-github',
  });

  response.status(200).json({
    configured: true,
    url: `https://github.com/login/oauth/authorize?${params.toString()}`,
  });
};
