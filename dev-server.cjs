const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 5173);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const routes = {
  '/api/firebase-config': './api/firebase-config.js',
  '/api/models': './api/models.js',
  '/api/chat': './api/chat.js',
  '/api/plugin-bridge': './api/chat.js',
  '/api/connect/roblox': './api/connect/roblox.js',
  '/api/connect/roblox-callback': './api/connect/roblox-callback.js',
};

http.createServer(async (request, response) => {
  try {
    if (routes[request.url.split('?')[0]]) {
      await handleApi(request, response, routes[request.url.split('?')[0]]);
      return;
    }

    let pathname = decodeURIComponent(new URL(request.url, `http://localhost:${port}`).pathname);
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/app' || pathname === '/chat') pathname = '/app.html';
    if (pathname === '/home' || pathname === '/community' || pathname === '/prompt-guide' || pathname === '/blog' || pathname === '/contact' || pathname === '/contact-us' || pathname === '/pricing') pathname = '/index.html';
    if (pathname === '/account') pathname = '/account.html';
    if (pathname === '/pro') pathname = '/account.html';
    if (pathname === '/login')   pathname = '/login.html';
    if (pathname === '/signup' || pathname === '/sign-up' || pathname === '/register') pathname = '/login.html';
    if (pathname === '/projects' || pathname === '/dashboard' || pathname === '/my-chats') pathname = '/projects.html';
    if (pathname === '/tokens')  pathname = '/tokens.html';
    if (pathname === '/documentation' || pathname === '/docs') pathname = '/docs.html';
    if (pathname === '/editor') pathname = '/app.html';

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

async function handleApi(request, response, modulePath) {
  const parsedUrl = new URL(request.url, `http://localhost:${port}`);
  request.query = Object.fromEntries(parsedUrl.searchParams.entries());
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  request.body = bodyText ? JSON.parse(bodyText) : {};

  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (data) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(data));
  };

  delete require.cache[require.resolve(modulePath)];
  const handler = require(modulePath);
  await handler(request, response);
}
