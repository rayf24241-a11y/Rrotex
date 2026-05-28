module.exports = function handler(request, response) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    response.status(200).json({
      configured: false,
      message: 'Google Drive is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    });
    return;
  }

  const origin = process.env.PUBLIC_SITE_URL || 'https://www.rrotex.com';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/connect/google-drive-callback`,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
    state: 'rotex-google-drive',
  });

  response.status(200).json({
    configured: true,
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  });
};
