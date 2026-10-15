// Serve docs/ on localhost, the way GitHub Pages serves it.
//
//   npm run serve            -> http://localhost:8080
//   PORT=3000 npm run serve  -> http://localhost:3000
//
// The pages load app.js as an ES module, which browsers refuse over file://,
// so opening docs/index.html straight from disk shows the layout but nothing
// works. This is the smallest server that fixes that: static files, the right
// content types, index.html for "/", nothing else.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', 'docs');
const PORT = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  // never serve anything outside docs/
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found: ' + rel); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving docs/ at http://localhost:${PORT}  (ctrl+c to stop)`);
});
