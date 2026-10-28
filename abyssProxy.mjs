// Abyss's launch API — the name, description, image and links a launched coin
// shows on abyss.trading — answers browser calls from *.abyss.trading only, and
// the storage URL it hands back for the image has no CORS of its own either.
// Both hops are forwarded here so the page reaches them from a single origin,
// which also means no preflight at all. Used by serve.mjs; the Abyss pad falls
// back to launching without the extras when it is not there.
//
//   POST /abyss-api/api/v1/launch-upload-sessions?chainId=4663  -> api.abyss.trading
//   PUT  /abyss-api/upload?url=<the storage URL the API issued>  -> that URL
export const ABYSS_API = 'https://api.abyss.trading';
export const ABYSS_PROXY_PREFIX = '/abyss-api';
const ABYSS_UPLOAD_HOST = /\.r2\.cloudflarestorage\.com$/;
// exactly the headers the signed session flow needs, and nothing else
const ABYSS_HEADERS = ['authorization', 'content-type', 'idempotency-key', 'if-none-match', 'x-amz-meta-upload-id'];

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

export async function abyssProxy(req, res, path, query) {
  let target;
  if (path === `${ABYSS_PROXY_PREFIX}/upload`) {
    // only ever the storage host the API itself named, never an arbitrary URL
    target = new URL(new URLSearchParams(query).get('url') || '');
    if (target.protocol !== 'https:' || !ABYSS_UPLOAD_HOST.test(target.hostname)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"code":"INVALID_REQUEST","error":"not an Abyss upload URL"}');
      return;
    }
  } else {
    target = new URL(path.slice(ABYSS_PROXY_PREFIX.length) + (query ? '?' + query : ''), ABYSS_API);
  }
  const headers = {};
  for (const h of ABYSS_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
  const out = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
    ...(upstream.headers.get('retry-after') ? { 'retry-after': upstream.headers.get('retry-after') } : {}),
    'cache-control': 'no-store',
  });
  res.end(out);
}

/// Handle an /abyss-api request, or report that it was not one.
export async function handleAbyssProxy(req, res) {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  if (!path.startsWith(ABYSS_PROXY_PREFIX)) return false;
  const query = (req.url || '').split('?').slice(1).join('?');
  await abyssProxy(req, res, path, query).catch((e) => {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'RPC_UNAVAILABLE', error: String(e.message || e) }));
  });
  return true;
}
