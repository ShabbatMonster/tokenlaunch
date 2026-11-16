// Backpack Exchange's REST API answers CORS only for https://backpack.exchange,
// so a page served from anywhere else can't even read its market list. The
// perps page's Backpack calls are forwarded from here instead (the websocket
// accepts any origin and is not proxied). Only Backpack's API host, only its
// /api and /wapi paths, and only the headers its signing uses; the signature
// is made in the page, so no key ever passes through here unsigned or is kept.
//
//   ANY /backpack/api/<path>?<query>   -> https://api.backpack.exchange/api/<path>?<query>
//   ANY /backpack/wapi/<path>?<query>  -> https://api.backpack.exchange/wapi/<path>?<query>
export const BACKPACK_UPSTREAM = 'https://api.backpack.exchange';
export const BACKPACK_PROXY_PREFIX = '/backpack';
const PASS = ['content-type', 'x-api-key', 'x-signature', 'x-timestamp', 'x-window'];

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

export async function handleBackpackProxy(req, res) {
  const [path, query] = (req.url || '').split('?');
  if (!path.startsWith(BACKPACK_PROXY_PREFIX + '/api/') && !path.startsWith(BACKPACK_PROXY_PREFIX + '/wapi/')) return false;
  const target = BACKPACK_UPSTREAM + path.slice(BACKPACK_PROXY_PREFIX.length) + (query ? '?' + query : '');
  const headers = {};
  for (const h of PASS) if (req.headers[h]) headers[h] = req.headers[h];
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const up = await fetch(target, { method: req.method, headers, body: body?.length ? body : undefined, redirect: 'manual' });
    const out = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-cache' }).end(out);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Backpack: ' + e.message }));
  }
  return true;
}
