module.exports = function handler(request, response) {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
  if (!clientId) {
    response.status(200).json({
      configured: false,
      message: 'OneDrive is not configured yet. Add MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.',
    });
    return;
  }

  const origin = request.headers.origin || 'https://www.rrotex.com';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/connect/onedrive-callback`,
    response_type: 'code',
    response_mode: 'query',
    scope: 'offline_access User.Read Files.ReadWrite',
    state: 'rotex-onedrive',
  });

  response.status(200).json({
    configured: true,
    url: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`,
  });
};
