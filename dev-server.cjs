const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;

// Zero-dependency .env loader -- api/credits.js reads process.env directly
// (KV_REST_API_URL, KV_REST_API_TOKEN). Real shell env vars still win
// (checked first), matching normal dotenv behavior. .env.local loads after
// .env so it can override, mirroring how `vercel env pull` writes to it.
(function loadDotEnv() {
  for (const name of ['.env', '.env.local']) {
    try {
      const text = fs.readFileSync(path.join(root, name), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
        if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
      }
    } catch { /* file doesn't exist -- fine */ }
  }
})();

const port = Number(process.env.PORT || 5173);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const apiRoutes = {
  '/api/credits': './api/credits.js',
  '/api/generate': './api/generate.js',
  '/api/texture': './api/texture.js',
  '/api/checkout': './api/checkout.js',
  '/api/stripe-webhook': './api/stripe-webhook.js',
};

// Mirrors Vercel's filesystem dynamic-route convention (api/status/[id].js)
// for local dev: match a prefix, pull the rest of the path into req.query.id
// the same way Vercel populates it in production.
const apiDynamicRoutes = [
  { prefix: '/api/status/', file: './api/status/[id].js' },
  { prefix: '/api/result/', file: './api/result/[id].js' },
];

function loadHandler(relPath) {
  // Bust the module cache so edits to api/*.js take effect without
  // restarting the server.
  const resolved = require.resolve(relPath);
  delete require.cache[resolved];
  return require(relPath);
}

http.createServer(async (request, response) => {
  try {
    const apiPath = request.url.split('?')[0];
    if (apiRoutes[apiPath]) {
      const handler = loadHandler(apiRoutes[apiPath]);
      await handler(request, response);
      return;
    }

    const dynamicRoute = apiDynamicRoutes.find((route) => apiPath.startsWith(route.prefix));
    if (dynamicRoute) {
      const id = decodeURIComponent(apiPath.slice(dynamicRoute.prefix.length));
      request.query = { id };
      const handler = loadHandler(dynamicRoute.file);
      await handler(request, response);
      return;
    }

    let pathname = decodeURIComponent(new URL(request.url, `http://localhost:${port}`).pathname);
    if (pathname === '/') pathname = '/index.html';

    const filePath = path.resolve(root, `.${pathname}`);
    if (!filePath.startsWith(root)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(error?.stack || String(error));
  }
}).listen(port, () => {
  console.log(`ROTEX dev server listening at http://localhost:${port}`);
});
