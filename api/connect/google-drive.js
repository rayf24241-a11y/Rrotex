module.exports = function handler(request, response) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${canonicalOrigin(request)}/api/connect/google-drive-callback`;
  if (!clientId) {
    response.status(200).json({
      configured: false,
      message: 'Google Drive is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      redirect_uri: redirectUri,
    });
    return;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
    state: 'rotex-google-drive',
  });

  response.status(200).json({
    configured: true,
    redirect_uri: redirectUri,
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
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
