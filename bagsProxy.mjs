// Bags' API refuses a browser: the preflight allows any origin, but the request
// itself comes back 403 "Origin not allowed" unless the page is on bags.fm (only
// /auth/me gets through). So the Bags pad's calls are forwarded from here, with
// no Origin header, the way Bags' own SDK and CLI call it.
//
// The API key is held here too, so it is set once and never has to sit in the
// page or the browser: BAGS_API_KEY in the environment, or the first line of
// .bags-api-key next to this file (gitignored; serve.mjs only serves docs/, so
// it cannot be fetched), or the Bags CLI's own ~/.config/bags/credentials.json.
// A key the page sends itself still wins, for a pasted one.
//
//   GET  /bags-api/_status          -> { proxy: true, presetKey: true|false } (never the key)
//   ANY  /bags-api/<path>?<query>   -> https://public-api-v2.bags.fm/api/v1/<path>?<query>
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// overridable only so the tests can point it at a stand-in
export const BAGS_UPSTREAM = process.env.BAGS_UPSTREAM || 'https://public-api-v2.bags.fm/api/v1';
export const BAGS_PROXY_PREFIX = '/bags-api';
const HERE = dirname(fileURLToPath(import.meta.url));

/// The key this computer keeps for Bags, if any. Read on each request so a
/// key added or changed later is picked up without restarting the server.
export function presetBagsKey() {
  if (process.env.BAGS_API_KEY) return process.env.BAGS_API_KEY.trim();
  const file = join(HERE, '.bags-api-key');
  if (existsSync(file)) {
    const k = readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
    if (k) return k;
  }
  const cli = join(homedir(), '.config', 'bags', 'credentials.json');
  if (existsSync(cli)) {
    try { const k = JSON.parse(readFileSync(cli, 'utf8')).api_key; if (k) return String(k).trim(); } catch { /* not the CLI's file */ }
  }
  return null;
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

/// Handle a /bags-api request, or report that it was not one.
export async function handleBagsProxy(req, res) {
  const url = new URL(req.url || '/', 'http://local');
  if (!url.pathname.startsWith(BAGS_PROXY_PREFIX)) return false;
  const send = (status, obj) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
  if (url.pathname === `${BAGS_PROXY_PREFIX}/_status`) { send(200, { proxy: true, presetKey: !!presetBagsKey() }); return true; }
  try {
    const target = BAGS_UPSTREAM + url.pathname.slice(BAGS_PROXY_PREFIX.length) + url.search;
    const headers = {};
    // the body is passed through untouched - multipart image uploads included,
    // which is why the content-type (with its boundary) is copied as-is
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    const key = req.headers['x-api-key'] || presetBagsKey();
    if (key) headers['x-api-key'] = key;
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
    const out = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
    });
    res.end(out);
  } catch (e) {
    send(502, { success: false, error: `the local server could not reach Bags: ${e.message || e}` });
  }
  return true;
}
