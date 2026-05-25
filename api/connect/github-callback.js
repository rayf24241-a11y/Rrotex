module.exports = function handler(request, response) {
  response.setHeader('Content-Type', 'text/html');
  response.status(200).send(`<!doctype html>
<html>
  <head><title>GitHub connected</title></head>
  <body>
    <script>
      localStorage.setItem('rotex:pending-activation', 'GitHub');
      window.location.href = '/';
    </script>
    <p>GitHub connected. Returning to ROTEX...</p>
  </body>
</html>`);
};
