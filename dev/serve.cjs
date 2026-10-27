'use strict';
/* ============================================================
   Local stand-in for production: serves the app under /guestlist/
   (as eunchan.me does) and runs api/session.js the way Vercel runs a
   function, so the server-set unlock cookie can be tested. python's
   http.server can't do that (POST api/session -> 501, JS fallback).

   Run: node dev/serve.cjs (PORT overrides 8126), then open
   http://127.0.0.1:8126/guestlist/ - 127.0.0.1 rather than localhost,
   so cookies from other localhost servers don't leak in.
   ============================================================ */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = '/guestlist/';
const PORT = Number(process.env.PORT) || 8126;
const FUNCTIONS = { 'api/session': require(path.join(ROOT, 'api/session.js')) };
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, headers = {}) {
  res.writeHead(status, headers);
  res.end();
}

// Vercel hands functions the parsed JSON body as req.body.
function runFunction(handler, req, res) {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (/^application\/json/.test(req.headers['content-type'] || '')) {
      try { req.body = raw ? JSON.parse(raw) : undefined; } catch { return send(res, 400); }
    } else {
      req.body = raw || undefined;
    }
    handler(req, res);
  });
}

function serveFile(rel, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { Allow: 'GET, HEAD' });
  // Stay inside the repo, away from dotfiles (.git) and function sources.
  const file = path.resolve(ROOT, rel || 'index.html');
  const parts = rel.split('/');
  if (!file.startsWith(ROOT + path.sep) || parts.some((p) => p.startsWith('.')) || parts[0] === 'api') {
    return send(res, 404);
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store', // edits show up on a plain reload
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  // Like eunchan.me, the app only exists under /guestlist/.
  if (!pathname.startsWith(BASE)) return send(res, 302, { Location: BASE });
  let rel;
  try { rel = decodeURIComponent(pathname.slice(BASE.length)); } catch { return send(res, 400); }
  if (FUNCTIONS[rel]) return runFunction(FUNCTIONS[rel], req, res);
  serveFile(rel, req, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Guestlist at http://127.0.0.1:${PORT}${BASE}`);
});
