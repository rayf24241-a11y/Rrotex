module.exports = function handler(request, response) {
  response.setHeader('Content-Type', 'text/html');
  response.status(200).send('<h1>Google Drive returned to ROTEX</h1><p>OAuth callback received. Token exchange/storage is the next step.</p>');
};
