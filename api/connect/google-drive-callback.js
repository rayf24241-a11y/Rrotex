module.exports = function handler(request, response) {
  response.setHeader('Content-Type', 'text/html');
  response.status(200).send(`<!doctype html>
<html>
  <head><title>Google Drive connected</title></head>
  <body>
    <script>
      localStorage.setItem('rotex:pending-activation', 'Google Drive');
      window.location.href = '/';
    </script>
    <p>Google Drive connected. Returning to ROTEX...</p>
  </body>
</html>`);
};
