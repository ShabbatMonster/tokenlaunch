// Local server for the launcher — serves the built site in docs/ so you can use
// it from your browser any time. Rebuilds first (so the latest src/ is live),
// then serves and opens the browser. Zero external deps (pure Node http).
//
//   node serve.mjs            # build + serve on http://localhost:8788 + open browser
//   node serve.mjs --no-open  # don't launch the browser
//   PORT=9000 node serve.mjs  # custom port
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'docs');
const PORT = Number(process.env.PORT) || 8788;
const OPEN = !process.argv.includes('--no-open');

// rebuild so any src/ edits are reflected; if it fails, serve whatever's in docs/
try {
  console.log('building…');
  const r = spawnSync(process.execPath, [join(HERE, 'build.mjs')], { cwd: HERE, stdio: 'inherit' });
  if (r.status !== 0) console.warn('build failed — serving the existing docs/ instead');
} catch (e) { console.warn('build skipped:', e.message); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url || '/').split('?')[0]);
    if (path === '/') path = '/index.html';
    // prevent path traversal outside docs/
    const filePath = normalize(join(ROOT, path));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const s = await stat(filePath).catch(() => null);
    const target = s && s.isDirectory() ? join(filePath, 'index.html') : filePath;
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const url = `http://localhost:${PORT}/`;
    console.log(`already running at ${url} — opening browser`);
    if (OPEN) { try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); } catch {} }
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`launcher live at ${url}  (Ctrl+C to stop)`);
  if (OPEN) {
    // Windows: `start`; mac: `open`; linux: `xdg-open`
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
});
