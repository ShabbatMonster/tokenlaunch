// The local relay for Bags (bagsProxy.mjs, mounted by serve.mjs).
//
// Bags' API refuses a browser: its preflight allows any origin, but the request
// itself comes back 403 "Origin not allowed" from anywhere but bags.fm. So the
// pad's calls go through the local server, which drops the Origin header and
// adds the API key it keeps (.bags-api-key, gitignored) - the key is set once
// and never has to be typed into the page.
//
// Checked two ways: against a stand-in upstream that echoes exactly what it was
// sent (origin gone, key added, a multipart image body byte-for-byte intact),
// and live against Bags itself when a key is available.
//   node test/js/bags-proxy.test.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs'; import path from 'node:path';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');

/// Run the relay in its own process, so its upstream and key come from `env`.
async function startProxy(env) {
  const child = spawn(process.execPath, ['-e', `
    import('./bagsProxy.mjs').then(({ handleBagsProxy }) => {
      const s = require('node:http').createServer(async (req, res) => { if (!(await handleBagsProxy(req, res))) res.writeHead(404).end(); });
      s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));
    });`], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((ok, bad) => {
    child.stdout.on('data', (d) => { const m = String(d).match(/PORT (\d+)/); if (m) ok(Number(m[1])); });
    child.on('exit', (c) => bad(new Error('relay exited ' + c)));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

// --- against a stand-in that echoes what it receives ---------------------------
const seen = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, headers: req.headers, sha: createHash('sha256').update(body).digest('hex'), len: body.length });
    res.writeHead(req.url.includes('fail') ? 418 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: !req.url.includes('fail'), response: 'echo' }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UP = `http://127.0.0.1:${upstream.address().port}/api/v1`;
const relay = await startProxy({ BAGS_UPSTREAM: UP, BAGS_API_KEY: 'preset-key-123' });
try {
  const st = await fetch(`${relay.url}/bags-api/_status`).then((r) => r.text());
  check(JSON.parse(st).proxy === true && JSON.parse(st).presetKey === true, 'the relay reports it is there and holds a key');
  check(!st.includes('preset-key-123'), 'without ever saying what the key is');

  await fetch(`${relay.url}/bags-api/token-launch/supported-quote-tokens?flow=dbc`, { headers: { origin: 'http://localhost:8080' } });
  let s = seen.at(-1);
  check(s.url === '/api/v1/token-launch/supported-quote-tokens?flow=dbc', 'the path and query reach Bags unchanged', s.url);
  check(!s.headers.origin, 'the browser\'s Origin header is not passed on — that is what Bags refuses');
  check(s.headers['x-api-key'] === 'preset-key-123', 'the key this computer keeps is added when the page sends none');

  await fetch(`${relay.url}/bags-api/auth/me`, { headers: { 'x-api-key': 'pasted-key' } });
  check(seen.at(-1).headers['x-api-key'] === 'pasted-key', 'a key the page does send still wins');

  // an image upload: the multipart body and its boundary must arrive intact
  const form = new FormData();
  const img = new Uint8Array(4096).map((_, i) => (i * 37) & 255);
  form.append('image', new Blob([img], { type: 'image/png' }), 'image.png');
  form.append('name', 'Relay Test');
  const req = new Request('http://x', { method: 'POST', body: form });
  const raw = Buffer.from(await req.arrayBuffer());
  await fetch(`${relay.url}/bags-api/token-launch/create-token-info`, { method: 'POST', headers: { 'content-type': req.headers.get('content-type') }, body: raw });
  s = seen.at(-1);
  check(s.method === 'POST' && s.headers['content-type'] === req.headers.get('content-type'), 'a multipart upload keeps its content-type and boundary');
  check(s.len === raw.length && s.sha === createHash('sha256').update(raw).digest('hex'), 'and its body arrives byte for byte', `${s.len} bytes`);

  const f = await fetch(`${relay.url}/bags-api/fail`);
  check(f.status === 418 && (await f.json()).success === false, 'Bags\' own status and error body come back as they are');
} finally {
  relay.stop();
  upstream.close();
}

// --- the key file is never committed or served -------------------------------------
{
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  check(/^\.bags-api-key$/m.test(ignore), '.bags-api-key is gitignored');
  const serve = fs.readFileSync(path.join(ROOT, 'serve.mjs'), 'utf8');
  check(/const ROOT = join\(HERE, 'docs'\)/.test(serve) && /handleBagsProxy/.test(serve),
    'and the local server serves docs/ only, so the key file beside it cannot be fetched');
}

// --- live, against Bags --------------------------------------------------------------
{
  const B = 'https://public-api-v2.bags.fm/api/v1';
  const direct = await fetch(`${B}/agent/v2/auth/init`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8080' },
    body: JSON.stringify({ address: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9' }),
  }).then(async (r) => ({ status: r.status, body: await r.text() })).catch((e) => ({ err: e.message }));
  if (direct.err) console.log('SKIP  Bags unreachable: ' + direct.err);
  else {
    check(direct.status === 403 && /Origin not allowed/.test(direct.body),
      'straight from a browser page, Bags answers 403 "Origin not allowed" — the reason for the relay', `${direct.status}`);
    const live = await startProxy({});
    try {
      const via = await fetch(`${live.url}/bags-api/agent/v2/auth/init`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8080' },
        body: JSON.stringify({ address: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9' }),
      });
      check(via.status === 200 && (await via.json()).success, 'through the relay the same request is answered');
      const st = await fetch(`${live.url}/bags-api/_status`).then((r) => r.json());
      if (!st.presetKey) console.log('SKIP  no preset key (BAGS_API_KEY or .bags-api-key) to try a keyed call through the relay');
      else {
        const q = await fetch(`${live.url}/bags-api/token-launch/supported-quote-tokens?flow=dbc`, { headers: { origin: 'http://localhost:8080' } });
        const body = await q.json().catch(() => ({}));
        check(q.status === 200 && body.success && body.response?.tokens?.length > 0,
          'a keyed call works with no key in the page — the relay adds the one it keeps', `${body.response?.tokens?.length} quotes`);
      }
    } finally {
      live.stop();
    }
  }
}

console.log('');
process.exit(fails.length ? 1 : 0);
