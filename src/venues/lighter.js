// Lighter (lighter.xyz): a zk-rollup perps exchange. Its accounts belong to an
// EVM address (keys.v1.evm), but orders are not signed by that key: each
// account has up to 255 "API keys" of Lighter's own kind (Schnorr over the
// ECgFp5 curve, hashed with Poseidon2 over the Goldilocks field), and every
// trading transaction is signed by one of them. Indexes 0-3 belong to
// Lighter's own web and mobile apps, so this page registers its own key at
// index 4. Registering is one ChangePubKey transaction, signed by the new key
// and also by the EVM key (EIP-191 personal_sign over the text Lighter's
// signer builds). The API key's private half is then kept in the local store,
// under keys.v1.lighterApi, so the EVM key signs only that once.
//
// The signer is Lighter's own: the browser build of elliottech/lighter-go
// (web-wasm/main.wasm, the file the official lighter-ts example ships), run by
// the Go 1.26.8 runtime it was built with. Both are vendored byte-for-byte (see
// SIGNER below) and the wasm is checked against its published sha256 before it
// runs. It loads only when something needs signing (2.5 MB gzipped).
//
// Everything public is open to any origin (CORS *). The account's open orders
// need an auth token, which the API key signs. Lighter refuses sendTx and the
// full websocket from restricted regions (code 20558); the read-only stream
// (?readonly=true) and the REST reads work everywhere.
import { privateKeyToAccount } from 'viem/accounts';
import { toStep } from './util.js';

export const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai/api/v1';
export const LIGHTER_WS = 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true';
export const LIGHTER_CHAIN_ID = 304;            // mainnet (lighter-python signer_client.py, lighter-ts example)
export const LIGHTER_API_KEY_INDEX = 4;         // 0-3 are Lighter's own apps
export const LIGHTER_STORE_KEY = 'keys.v1.lighterApi';
// where the signer came from, and the hash it must have (web-wasm/main.manifest.json)
export const SIGNER = {
  repo: 'https://github.com/elliottech/lighter-go/tree/74e2b996dcbb44e58ebf133ae463b1ea1c6b51fc/web-wasm',
  file: 'vendor/lighter/main.wasm.gz',        // under docs/, next to perps.html
  sha256: '6caf0765a6f993bff0bd25ff4553ba8ea5657d0a6b85c767aae44ac5dcf17de9',   // of the unzipped main.wasm
  runtime: 'go1.26.8 lib/wasm/wasm_exec.js, sha256 0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14',
};

// transaction and order constants (lighter-go types/txtypes/constants.go)
const TX = { CHANGE_PUB_KEY: 8, CREATE_ORDER: 14, CANCEL_ORDER: 15, CANCEL_ALL: 16, UPDATE_LEVERAGE: 20, GROUPED: 28 };
const OT = { LIMIT: 0, MARKET: 1, SL: 2, TP: 4 };
const TIF = { IOC: 0, GTT: 1, POST: 2 };
const GROUP = { OTO: 1, OCO: 2, OTOCO: 3 };
const EXPIRY_28D = -1;                          // the signer turns -1 into now + 28 days
const TPSL_SLIP = 5;                            // % worst price on a triggered TP/SL (Lighter's own cap is 10)
const NO_ACCOUNT = 'no Lighter account yet: deposit at app.lighter.xyz';
const NO_KEY = 'set up a Lighter trading key first (one signature with this wallet)';

export class LighterError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
async function get(path) {
  const r = await fetch(LIGHTER_API + path);
  const j = await r.json().catch(() => null);
  if (!j || !r.ok || (j.code != null && j.code !== 200)) throw new LighterError(j?.message || `Lighter ${path}: HTTP ${r.status}`, j?.code);
  return j;
}
/// a signed transaction to Lighter. A plain form post, so the browser sends it without a preflight.
export async function sendTx(txType, txInfo, api = LIGHTER_API) {
  const r = await fetch(api + '/sendTx', { method: 'POST', body: new URLSearchParams({ tx_type: String(txType), tx_info: txInfo }) });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 200) throw new LighterError(j?.message || `Lighter sendTx: HTTP ${r.status}`, j?.code);
  return j;
}

// --- the signer -------------------------------------------------------------------
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function gunzip(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
let signerP = null;
/// Load Lighter's wasm signer once. `src` (bytes, gzipped or not) is for Node;
/// the page fetches it from docs/vendor/lighter/.
export function loadSigner(src) {
  signerP ??= (async () => {
    await import('./vendor/lighter-wasm_exec.js');   // defines globalThis.Go
    let bytes = src;
    if (!bytes) {
      const url = new URL(SIGNER.file, globalThis.document?.baseURI ?? import.meta.url);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Lighter signer: HTTP ${r.status} for ${url}`);
      bytes = await r.arrayBuffer();
    }
    bytes = new Uint8Array(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== SIGNER.sha256) throw new Error('Lighter signer failed its checksum: not running it');
    const go = new globalThis.Go();
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    go.run(instance);                          // settles only if the program exits, which it never does
    if (globalThis._signerVersion !== 2) throw new Error('Lighter signer: unexpected version');
  })().catch((e) => { signerP = null; throw e; });
  return signerP;
}
/// One signer call. Each export hands back a bound function that returns a
/// promise (the calling convention of lighter-ts's signers.ts); a failure
/// comes back as { error }.
export async function signerCall(name, ...args) {
  await loadSigner();
  const r = await globalThis[name](...args)();
  if (r?.error) throw new Error(`Lighter signer: ${r.error}`);
  return r;
}
/// a brand-new API key as the official web app makes one: a random seed,
/// which the signer turns into the key pair (signer/key_manager.go)
export async function newApiKey(accountIndex, apiKeyIndex = LIGHTER_API_KEY_INDEX, chainId = LIGHTER_CHAIN_ID) {
  const seed = hex(crypto.getRandomValues(new Uint8Array(132)));
  const r = await signerCall('_createClient', seed, chainId, accountIndex, 0, apiKeyIndex);
  return { prv: r.prv, pub: r.pk };
}

// --- markets ----------------------------------------------------------------------
const step = (d) => (d > 0 ? (10 ** -d).toFixed(d) : '1');
/// a decimal string at the market's precision -> the integer the signer takes
const toInt = (s, d) => Math.round(+s * 10 ** d);
const lastPx = new Map();                       // coin -> { mid, mark }, for market orders and positions
let metaP = null;
const meta = new Map(), metaById = new Map();
function setMeta(list) {
  for (const d of list) { meta.set(d.symbol, d); metaById.set(d.market_id, d); }
}
function loadMeta() {
  metaP ??= get('/orderBookDetails?filter=perp').then((j) => setMeta(j.order_book_details || [])).finally(() => { metaP = null; });
  return metaP;
}
async function marketOf(coin) {
  if (!meta.has(coin)) await loadMeta();
  const d = meta.get(coin);
  if (!d) throw new Error(`Lighter has no ${coin} market`);
  return d;
}
const isLive = (d) => d.market_type === 'perp' && d.status === 'active' && !d.market_config?.hidden;

function applyStats(m, s) {
  m.mid = +s.mid_price || +s.last_trade_price || m.mid;
  m.mark = +s.mark_price || m.mark;
  m.oracle = +s.index_price || m.oracle;
  if (s.current_funding_rate != null) m.funding = +s.current_funding_rate / 100;   // percent per hour
  if (m.mark && s.open_interest != null) m.oi = +s.open_interest / m.mark;          // one side, in USD here
  m.volume = +s.daily_quote_token_volume || 0;
  m.change = +s.daily_price_change || 0;                                             // already a percent
  lastPx.set(m.coin, { mid: m.mid, mark: m.mark });
}
async function markets() {
  const [det, fr] = await Promise.all([get('/orderBookDetails?filter=perp'), get('/funding-rates').catch(() => ({}))]);
  setMeta(det.order_book_details || []);
  // funding-rates lists several exchanges, each as an 8-hour rate (Lighter's ETH
  // there is 8x the hourly current_funding_rate the stream shows)
  const fund = new Map((fr.funding_rates || []).filter((f) => f.exchange === 'lighter').map((f) => [f.market_id, +f.rate / 8]));
  return (det.order_book_details || []).filter(isLive).map((d) => {
    const m = {
      coin: d.symbol, label: d.symbol, dex: '', dexName: 'Lighter', asset: null, venue: 'lighter', marketId: d.market_id,
      szDecimals: d.size_decimals, pxDecimals: d.price_decimals, tick: step(d.price_decimals), lot: step(d.size_decimals),
      minSize: +d.min_base_amount, minNotional: +d.min_quote_amount || 10,
      // margin fractions are in 1/10000ths: 200 = 2% = 50x
      maxLeverage: Math.max(1, Math.floor(10000 / (d.min_initial_margin_fraction || 10000))), onlyIsolated: false,
      collateral: 'USDC', delisted: false,
      mid: +d.last_trade_price || +d.mark_price, mark: +d.mark_price, oracle: +d.index_price,
      change: +d.daily_price_change || 0, funding: fund.get(d.market_id) ?? 0,
      oi: +d.open_interest || 0,                 // in coins, one side (open_interest_usd counts both)
      volume: +d.daily_quote_token_volume || 0,
    };
    lastPx.set(m.coin, { mid: m.mid, mark: m.mark });
    return m;
  });
}

// --- one shared read-only websocket -------------------------------------------------
// subscribe with 'order_book/0', messages come back on 'order_book:0'
const ws = { sock: null, open: false, subs: new Map(), timer: 0, last: 0 };
function wsSend(o) { if (ws.open) ws.sock.send(JSON.stringify(o)); }
function wsConnect() {
  if (ws.sock || typeof WebSocket === 'undefined') return;
  const s = new WebSocket(LIGHTER_WS);
  ws.sock = s;
  s.onopen = () => {
    ws.open = true;
    for (const ch of new Set([...ws.subs.values()].map((x) => x.channel))) wsSend({ type: 'subscribe', channel: ch });
  };
  s.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    ws.last = Date.now();
    if (m?.type === 'ping') { wsSend({ type: 'pong' }); return; }
    if (!m?.channel) return;
    for (const sub of ws.subs.values()) if (sub.wire === m.channel) sub.cb(m);
  };
  s.onclose = () => {
    ws.sock = null; ws.open = false;
    if (ws.subs.size) setTimeout(wsConnect, 3000);
  };
  s.onerror = () => { try { s.close(); } catch { /* closing */ } };
  clearInterval(ws.timer);
  ws.timer = setInterval(() => wsSend({ type: 'ping' }), 30000);
}
function wsSub(channel, cb) {
  const k = channel + Math.random();
  const first = ![...ws.subs.values()].some((x) => x.channel === channel);
  ws.subs.set(k, { channel, wire: channel.replace(/\//g, ':'), cb });
  wsConnect();
  if (first) wsSend({ type: 'subscribe', channel });
  return () => {
    ws.subs.delete(k);
    if (![...ws.subs.values()].some((x) => x.channel === channel)) wsSend({ type: 'unsubscribe', channel });
  };
}

function watchPrices(list, onUpdate) {
  const byId = new Map(list.map((m) => [m.marketId, m]));
  let stop = false, due = 0;
  // the stream pushes many times a second; the page needs about one repaint a second
  const changed = () => { if (!due) due = setTimeout(() => { due = 0; if (!stop) onUpdate(); }, 1000); };
  const unsub = wsSub('market_stats/all', (msg) => {
    const ms = msg.market_stats || {};
    for (const s of ms.market_id != null ? [ms] : Object.values(ms)) { const m = byId.get(s.market_id); if (m) applyStats(m, s); }
    changed();
  });
  // if the stream is down, read the same numbers over REST every 15 s
  const poll = setInterval(async () => {
    if (stop || Date.now() - ws.last < 15000 || globalThis.document?.hidden) return;
    try {
      for (const d of (await get('/orderBookDetails?filter=perp')).order_book_details || []) {
        const m = byId.get(d.market_id);
        if (m) applyStats(m, { ...d, mid_price: d.last_trade_price, open_interest: +d.open_interest * +d.mark_price, current_funding_rate: m.funding * 100 });
      }
      changed();
    } catch { /* next time */ }
  }, 15000);
  return () => { stop = true; unsub(); clearInterval(poll); clearTimeout(due); };
}

// --- chart ------------------------------------------------------------------------
// Lighter has 1m 5m 15m 30m 1h 4h 12h 1d; the page's other intervals are built from those
const RES = { '1m': ['1m', 1], '3m': ['1m', 3], '5m': ['5m', 1], '15m': ['15m', 1], '30m': ['30m', 1], '1h': ['1h', 1], '2h': ['1h', 2], '4h': ['4h', 1], '8h': ['4h', 2], '12h': ['12h', 1], '1d': ['1d', 1], '1w': ['1d', 7] };
const IV_MS = { '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '8h': 288e5, '12h': 432e5, '1d': 864e5, '1w': 6048e5 };
const MONDAY = 4 * 864e5;                       // 1970-01-01 was a Thursday; weeks open on Monday
const bucketOf = (t, iv) => (iv === '1w' ? Math.floor((t - MONDAY) / IV_MS['1w']) * IV_MS['1w'] + MONDAY : Math.floor(t / IV_MS[iv]) * IV_MS[iv]);
const toK = (c) => ({ t: +c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v });
function merge(bars, t) {
  return { t, o: bars[0].o, h: Math.max(...bars.map((b) => b.h)), l: Math.min(...bars.map((b) => b.l)), c: bars.at(-1).c, v: bars.reduce((s, b) => s + b.v, 0) };
}
/// raw bars at one of Lighter's resolutions. The endpoint returns at most 500,
/// counted back from end_timestamp whatever the start, so longer spans page back.
async function rawCandles(marketId, res, start, end) {
  const ms = IV_MS[res], byT = new Map();
  let to = Math.floor(end);
  for (let page = 0; page < 8 && to >= start; page++) {
    const n = Math.min(500, Math.ceil((to - start) / ms) + 1);
    const cs = (await get(`/candles?market_id=${marketId}&resolution=${res}&start_timestamp=${Math.floor(start)}&end_timestamp=${to}&count_back=${n}`)).c || [];
    for (const c of cs) byT.set(+c.t, toK(c));
    if (cs.length < n) break;
    to = Math.min(...cs.map((c) => +c.t)) - 1;
  }
  return [...byT.values()].filter((c) => c.t >= start).sort((a, b) => a.t - b.t);
}
async function candles(coin, interval, start, end) {
  const [res, k] = RES[interval] || [interval, 1];
  const d = await marketOf(coin);
  // from the opening of the bar that holds start
  const raw = await rawCandles(d.market_id, res, bucketOf(start, interval), end);
  if (k === 1) return raw;
  const groups = new Map();
  for (const c of raw) { const b = bucketOf(c.t, interval); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(c); }
  return [...groups.entries()].map(([t, bars]) => merge(bars, t)).sort((a, b) => a.t - b.t);
}
function subCandles(coin, interval, cb) {
  const [res, k] = RES[interval] || [interval, 1];
  let dead = false, unsub = null, bucket = 0;
  const bars = new Map();
  const push = (c) => {
    const bar = toK(c);
    if (k === 1) { cb(bar); return; }
    const b = bucketOf(bar.t, interval);
    if (b < bucket) return;
    if (b > bucket) { bucket = b; bars.clear(); }
    bars.set(bar.t, bar);
    cb(merge([...bars.values()].sort((x, y) => x.t - y.t), b));
  };
  marketOf(coin).then(async (d) => {
    // a built interval needs the finished base bars of its current bucket first
    if (k > 1) { const now = Date.now(); for (const c of await rawCandles(d.market_id, res, bucketOf(now, interval), now).catch(() => [])) push(c); }
    if (!dead) unsub = wsSub(`candle/${d.market_id}/${res}`, (m) => { for (const c of m.candles || []) push(c); });
  }).catch(() => {});
  return () => { dead = true; unsub?.(); };
}
function subBook(coin, cb) {
  let dead = false, unsub = null, due = 0;
  const bids = new Map(), asks = new Map();          // price number -> { px, sz, n }
  const side = (map, desc) => [...map.entries()].sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).slice(0, 50).map((e) => e[1]);
  const emit = () => { if (!due) due = setTimeout(() => { due = 0; if (!dead) cb({ levels: [side(bids, true), side(asks, false)] }); }, 100); };
  const apply = (map, levels) => {
    for (const l of levels || []) { if (+l.size > 0) map.set(+l.price, { px: l.price, sz: l.size, n: 1 }); else map.delete(+l.price); }
  };
  marketOf(coin).then((d) => {
    if (dead) return;
    // a REST read paints at once; the stream's first message is the whole book, then changes
    get(`/orderBookOrders?market_id=${d.market_id}&limit=100`).then((j) => {
      if (dead || bids.size || asks.size) return;
      const agg = (orders, map) => { for (const o of orders || []) { const p = +o.price, l = map.get(p); if (l) { l.sz = String(+l.sz + +o.remaining_base_amount); l.n++; } else map.set(p, { px: o.price, sz: o.remaining_base_amount, n: 1 }); } };
      agg(j.bids, bids); agg(j.asks, asks); emit();
    }).catch(() => {});
    unsub = wsSub(`order_book/${d.market_id}`, (m) => {
      const ob = m.order_book || {};
      if (m.type?.startsWith('subscribed')) { bids.clear(); asks.clear(); }
      apply(bids, ob.bids); apply(asks, ob.asks);
      emit();
    });
  }).catch(() => {});
  return () => { dead = true; unsub?.(); clearTimeout(due); };
}
function subTrades(coin, cb) {
  let dead = false, unsub = null;
  const seen = new Set();
  marketOf(coin).then((d) => {
    if (dead) return;
    unsub = wsSub(`trade/${d.market_id}`, (m) => {
      const ts = [...(m.trades || []), ...(m.liquidation_trades || [])].filter((t) => !seen.has(t.trade_id) && seen.add(t.trade_id));
      if (seen.size > 2000) seen.clear();
      // the maker is the resting side, so the taker bought when the maker was the ask
      if (ts.length) cb(ts.sort((a, b) => a.timestamp - b.timestamp).map((t) => ({ px: t.price, sz: t.size, side: t.is_maker_ask ? 'B' : 'A', time: t.timestamp })));
    });
  }).catch(() => {});
  return () => { dead = true; unsub?.(); };
}

// --- account ----------------------------------------------------------------------
const ORDER_TYPES = { limit: 'Limit', market: 'Market', 'stop-loss': 'Stop Market', 'stop-loss-limit': 'Stop Limit', 'take-profit': 'Take Profit Market', 'take-profit-limit': 'Take Profit Limit', twap: 'TWAP' };
const ms = (t) => (+t < 1e12 ? +t * 1000 : +t);
const memoryStore = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; };

/// EVM private key -> its address. Throws if it isn't one.
export function lighterAddress(secret) {
  const s = String(secret || '').trim();
  try { return privateKeyToAccount(s.startsWith('0x') ? s : '0x' + s).address; } catch { throw new Error('Lighter needs an EVM private key: 0x + 64 hex'); }
}

function connect(secret, { store, apiKeyIndex = LIGHTER_API_KEY_INDEX } = {}) {
  const raw = String(secret || '').trim();
  const address = lighterAddress(raw);
  const evm = privateKeyToAccount(raw.startsWith('0x') ? raw : '0x' + raw);
  if (!(apiKeyIndex >= 4 && apiKeyIndex <= 254)) throw new Error('Lighter API key index must be 4-254 (0-3 are Lighter\'s own apps)');
  const kv = store || memoryStore();
  const slot = `${address.toLowerCase()}:${apiKeyIndex}`;
  const loadKey = () => (kv.get(LIGHTER_STORE_KEY, {}) || {})[slot] || null;
  const saveKey = (rec) => { const all = kv.get(LIGHTER_STORE_KEY, {}) || {}; all[slot] = rec; kv.set(LIGHTER_STORE_KEY, all); };

  // the account this address owns: the lowest index is the main account
  // (sub-accounts start at 2^47), as lighter-python's system_setup picks it
  let acct, acctAt = 0;
  async function accountIndex() {
    if (acct != null || (acct === null && Date.now() - acctAt < 15000)) return acct;
    try {
      const subs = (await get(`/accountsByL1Address?l1_address=${address}`)).sub_accounts || [];
      acct = subs.length ? Math.min(...subs.map((a) => +a.index)) : null;
    } catch (e) {
      if (e.code === 21100 || /not found/i.test(e.message)) acct = null; else throw e;
    }
    acctAt = Date.now();
    return acct;
  }

  // is our stored key the one registered at apiKeyIndex? Rechecked every 5 minutes,
  // in case it was replaced from elsewhere.
  let checked = { key: '', at: 0, ok: false };
  async function keyLive(a, rec) {
    const tag = `${a}:${rec.pub}`;
    if (checked.key === tag && Date.now() - checked.at < 300000) return checked.ok;
    const keys = (await get(`/apikeys?account_index=${a}&api_key_index=${apiKeyIndex}`)).api_keys || [];
    const ok = keys.some((k) => +k.api_key_index === apiKeyIndex && String(k.public_key).replace(/^0x/, '').toLowerCase() === rec.pub.replace(/^0x/, '').toLowerCase());
    checked = { key: tag, at: Date.now(), ok };
    return ok;
  }
  // put our key into the signer for this account
  let installed = '';
  async function install(a, rec) {
    if (installed === `${a}:${rec.pub}`) return;
    await signerCall('_createClientByPrv', rec.prv, LIGHTER_CHAIN_ID, a, 0, apiKeyIndex);
    installed = `${a}:${rec.pub}`;
  }
  /// what every trading call needs: an account, and our key registered on it
  async function ready() {
    const a = await accountIndex();
    if (a == null) throw new Error(NO_ACCOUNT);
    const rec = loadKey();
    if (!rec || !(await keyLive(a, rec))) throw new Error(NO_KEY);
    await install(a, rec);
    return a;
  }

  let auth = { token: '', until: 0 };
  async function authToken(a) {
    if (auth.token && Date.now() < auth.until) return auth.token;
    const r = await signerCall('_createAuthToken', a, apiKeyIndex);   // valid for an hour
    auth = { token: r.token, until: Date.now() + 50 * 60e3 };
    return auth.token;
  }

  // Nonces count up per API key. Keep our own copy (several transactions can go
  // out back to back) and refetch it whenever a send fails.
  let nonce = null, queue = Promise.resolve();
  function transact(txType, sign) {
    const run = async () => {
      const a = await ready();
      for (let attempt = 0; ; attempt++) {
        nonce ??= (await get(`/nextNonce?account_index=${a}&api_key_index=${apiKeyIndex}`)).nonce;
        const signed = await sign(a, nonce);
        try {
          const r = await sendTx(txType, signed.txInfo);
          nonce++;
          return { ...r, txHash: r.tx_hash || signed.txHash };
        } catch (e) {
          nonce = null;
          if (e.code === 21104 && attempt < 2) continue;       // invalid nonce: fetch it and sign again
          throw e;
        }
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  /// Register this page's API key on the account: one EVM signature. Safe to
  /// call again; it does nothing when the key is already live.
  async function setupApiKey() {
    const a = await accountIndex();
    if (a == null) throw new Error(NO_ACCOUNT);
    let rec = loadKey();
    // a key is saved before it is registered, so a lost answer never strands one
    if (!rec || rec.account !== a) { rec = { ...(await newApiKey(a, apiKeyIndex)), account: a }; saveKey(rec); checked = { key: '', at: 0, ok: false }; }
    if (await keyLive(a, rec)) return { msg: `Lighter trading key #${apiKeyIndex} is already set up` };
    installed = '';
    await install(a, rec);
    const n = (await get(`/nextNonce?account_index=${a}&api_key_index=${apiKeyIndex}`)).nonce;
    const { body } = await signerCall('_getChangePubKeyTransaction', a, n, apiKeyIndex);
    const l1Sig = await evm.signMessage({ message: body });      // EIP-191, as lighter-python's encode_defunct
    const signed = await signerCall('_signChangePubKey', a, l1Sig, n, apiKeyIndex);
    await sendTx(TX.CHANGE_PUB_KEY, signed.txInfo);
    nonce = null;
    // the official app polls every 2 s until the new key shows up
    for (let i = 0; i < 15; i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      checked = { key: '', at: 0, ok: false };
      if (await keyLive(a, rec).catch(() => false)) return { msg: `Lighter trading key #${apiKeyIndex} registered` };
    }
    throw new Error('the key was sent but has not shown up on Lighter yet; try again in a minute');
  }

  let polls = 0, fills = [], fees = null;
  async function state() {
    const empty = (note) => ({
      st: { marginSummary: { accountValue: '0' }, withdrawable: '0', crossMarginSummary: { accountValue: '0', totalNtlPos: '0' }, crossMaintenanceMarginUsed: '0', assetPositions: [], venueNote: note },
      orders: [], fills: [], fees: null,
    });
    const a = await accountIndex();
    if (a == null) return empty(NO_ACCOUNT);
    const acctP = get(`/account?by=index&value=${a}`);
    acctP.catch(() => {});                        // awaited below; this only keeps an early failure quiet
    if (!meta.size) await loadMeta().catch(() => {});
    const rec = loadKey();
    const live = rec ? await keyLive(a, rec).catch(() => false) : false;
    let orders = [], orderErr = '';
    if (live) {
      await install(a, rec);
      const j = await get(`/accountActiveOrders?account_index=${a}&auth=${encodeURIComponent(await authToken(a))}`).catch((e) => { orderErr = e.message; auth.until = 0; return {}; });
      orders = (j.orders || []).map((o) => ({
        coin: metaById.get(o.market_index)?.symbol || String(o.market_index), oid: o.order_id ?? String(o.order_index),
        side: o.is_ask ? 'A' : 'B', sz: o.remaining_base_amount, limitPx: o.price,
        orderType: ORDER_TYPES[o.type] || o.type, reduceOnly: !!o.reduce_only,
        isTrigger: +o.trigger_price > 0, triggerPx: +o.trigger_price > 0 ? o.trigger_price : undefined, timestamp: ms(o.created_at || o.timestamp),
      }));
    }
    // trade history is public by account, and heavier: every third poll
    if (polls++ % 3 === 0) {
      const h = await get(`/trades?account_index=${a}&sort_by=timestamp&sort_dir=desc&limit=100`).catch(() => null);
      if (h) {
        fills = (h.trades || []).filter((t) => (t.market_kind || 'perps') === 'perps').map((t) => {
          const ask = +t.ask_account_id === a, maker = t.is_maker_ask === ask;
          const rate = (maker ? +t.maker_fee : +t.taker_fee) / 1e6 || 0;   // fee rates are in millionths
          if (!fees) fees = {}; fees[maker ? 'maker' : 'taker'] ??= rate;
          return {
            coin: t.market_symbol || metaById.get(t.market_id)?.symbol, oid: ask ? t.ask_id_str : t.bid_id_str, side: ask ? 'A' : 'B',
            px: t.price, sz: t.size, time: ms(t.timestamp), dir: ask ? 'Sell' : 'Buy',
            closedPnl: (ask ? t.ask_account_pnl : t.bid_account_pnl) ?? '0', fee: String(rate * +t.usd_amount), feeToken: 'USDC',
            liquidation: t.type === 'liquidation',
          };
        }).sort((x, y) => y.time - x.time);
      }
    }
    const ac = (await acctP).accounts?.[0];
    if (!ac) return empty(NO_ACCOUNT);
    let ntl = 0;
    const assetPositions = [];
    for (const p of ac.positions || []) {
      const size = +p.position;
      if (!size) continue;
      const szi = (+p.sign < 0 ? -1 : 1) * size;
      const imf = +p.initial_margin_fraction;           // a percent here: 2.00 = 50x
      const lev = imf ? Math.round(10000 / imf) / 100 : (metaById.get(p.market_id) ? Math.floor(10000 / metaById.get(p.market_id).min_initial_margin_fraction) : 1);
      const value = +p.position_value, upnl = +p.unrealized_pnl, iso = +p.margin_mode === 1;
      const margin = iso ? +p.allocated_margin : value * imf / 100;
      ntl += value;
      assetPositions.push({ position: {
        coin: p.symbol, szi: String(szi), entryPx: p.avg_entry_price, positionValue: String(value), unrealizedPnl: String(upnl),
        returnOnEquity: String(margin ? upnl / margin : 0), liquidationPx: +p.liquidation_price > 0 ? p.liquidation_price : null,
        marginUsed: String(margin), leverage: { type: iso ? 'isolated' : 'cross', value: lev },
        cumFunding: { sinceOpen: p.total_funding_paid_out },
      } });
    }
    return {
      st: {
        marginSummary: { accountValue: String(+ac.total_asset_value || +ac.collateral || 0) }, withdrawable: String(+ac.available_balance || 0),
        crossMarginSummary: { accountValue: String(+ac.cross_asset_value || 0), totalNtlPos: String(ntl) },
        crossMaintenanceMarginUsed: String(+ac.cross_maintenance_margin_requirement || 0), assetPositions,
        venueNote: orderErr ? `open orders unavailable: ${orderErr}` : live ? null : rec ? 'Lighter trading key not registered yet: press "Set up Lighter trading key"' : NO_KEY,
        accountIndex: a,
      },
      // the rates show once the account has both a maker and a taker fill; till then the page uses lighter.fees
      orders, fills, fees: fees?.maker != null && fees?.taker != null ? fees : null,
    };
  }

  // the worst price a market order may fill at: the book's mid now, +/- slippage
  async function midOf(d) {
    try {
      const j = await get(`/orderBookOrders?market_id=${d.market_id}&limit=1`);
      const b = +j.bids?.[0]?.price, k = +j.asks?.[0]?.price;
      if (b && k) return (b + k) / 2;
    } catch { /* fall back to the last price seen */ }
    const p = lastPx.get(d.symbol);
    if (p?.mid || p?.mark) return p.mid || p.mark;
    throw new Error(`no ${d.symbol} price to bound the market order`);
  }
  let coi = 0;
  const clientIndex = () => (coi = Math.max(coi + 1, Date.now() % 2 ** 47));    // 1..2^48-1, unique per order
  const priceInt = (d, x) => Math.max(1, toInt(toStep(x, step(d.price_decimals), 'round'), d.price_decimals));
  // a reduce-only trigger order that closes the position at market: size 0
  // means "whatever the position is" (lighter-python create_position_tied_sl_tp)
  const trigger = (d, type, px, closeIsAsk) => ({
    MarketIndex: d.market_id, ClientOrderIndex: 0, BaseAmount: 0,
    Price: priceInt(d, closeIsAsk ? px * (1 - TPSL_SLIP / 100) : px * (1 + TPSL_SLIP / 100)),
    IsAsk: closeIsAsk ? 1 : 0, Type: type, TimeInForce: TIF.IOC, ReduceOnly: 1, TriggerPrice: priceInt(d, px), OrderExpiry: EXPIRY_28D,
  });
  const orderArgs = (o) => [o.MarketIndex, o.ClientOrderIndex, String(o.BaseAmount), String(o.Price), o.IsAsk, o.Type, o.TimeInForce, o.ReduceOnly, String(o.TriggerPrice), o.OrderExpiry];
  function sendOrders(orders, group) {
    if (orders.length === 1) return transact(TX.CREATE_ORDER, (a, n) => signerCall('_signCreateOrder', a, ...orderArgs(orders[0]), n));
    return transact(TX.GROUPED, (a, n) => signerCall('_signCreateGroupedOrders', a, group, orders.length, ...orders.flatMap(orderArgs), n));
  }

  async function order({ coin, isBuy, sz, type = 'market', px, slippage = 1, reduceOnly = false, tif = 'Gtc', tp, sl }) {
    const d = await marketOf(coin);
    const amount = toStep(+sz, step(d.size_decimals));
    if (!(+amount > 0)) throw new Error(`size rounds to zero (lot ${step(d.size_decimals)} ${coin})`);
    if (+amount < +d.min_base_amount) throw new Error(`Lighter's minimum ${coin} order is ${d.min_base_amount}`);
    const market = type === 'market';
    const ref = market ? await midOf(d) : +px;
    if (!(ref > 0)) throw new Error('enter a limit price');
    if (+amount * ref < +d.min_quote_amount) throw new Error(`Lighter's minimum order is ${+d.min_quote_amount} USDC`);
    const t = market ? TIF.IOC : tif === 'Alo' ? TIF.POST : tif === 'Ioc' ? TIF.IOC : TIF.GTT;
    const main = {
      MarketIndex: d.market_id, ClientOrderIndex: clientIndex(), BaseAmount: toInt(amount, d.size_decimals),
      Price: priceInt(d, market ? ref * (1 + (isBuy ? 1 : -1) * slippage / 100) : ref),
      IsAsk: isBuy ? 0 : 1, Type: market ? OT.MARKET : OT.LIMIT, TimeInForce: t, ReduceOnly: reduceOnly ? 1 : 0,
      TriggerPrice: 0, OrderExpiry: t === TIF.IOC ? 0 : EXPIRY_28D,
    };
    // TP/SL ride along as children that arm once the entry fills (one-triggers-the-other)
    const kids = [tp && trigger(d, OT.TP, +tp, !!isBuy), sl && trigger(d, OT.SL, +sl, !!isBuy)].filter(Boolean);
    const r = await sendOrders([main, ...kids], kids.length === 2 ? GROUP.OTOCO : GROUP.OTO);
    return { ok: true, id: r.txHash, msg: `order sent${kids.length ? ' with TP/SL' : ''} (${String(r.txHash).slice(0, 10)}…)` };
  }
  async function cancel(coin, oid) {
    const d = await marketOf(coin);
    await transact(TX.CANCEL_ORDER, (a, n) => signerCall('_signCancelOrder', a, d.market_id, String(oid), n));
    return { msg: 'cancelled' };
  }
  async function cancelAll() {
    // time-in-force 0 = cancel now; no market index = every market
    await transact(TX.CANCEL_ALL, (a, n) => signerCall('_signCancelAllOrders', a, 0, 0, n));
    return { msg: 'cancelled every Lighter order' };
  }
  async function setLeverage(coin, lev, cross) {
    const d = await marketOf(coin);
    // leverage is set as an initial margin fraction in 1/10000ths (lighter-python update_leverage)
    const imf = Math.max(d.min_initial_margin_fraction || 0, Math.floor(10000 / lev));
    await transact(TX.UPDATE_LEVERAGE, (a, n) => signerCall('_signUpdateLeverage', a, d.market_id, imf, cross ? 0 : 1, n));
    return { msg: `${lev}x ${cross ? 'cross' : 'isolated'}` };
  }
  /// TP/SL on the open position. Lighter keeps adding these, so the ones of the
  /// same kind already resting on this market are cancelled first.
  async function setTpsl(coin, { tp, sl, long }) {
    const d = await marketOf(coin);
    const { orders } = await state();
    const old = orders.filter((o) => o.coin === coin && o.isTrigger && o.reduceOnly && ((tp && /take profit/i.test(o.orderType)) || (sl && /stop/i.test(o.orderType))));
    for (const o of old) await cancel(coin, o.oid);
    const kids = [tp && trigger(d, OT.TP, +tp, !!long), sl && trigger(d, OT.SL, +sl, !!long)].filter(Boolean);
    if (!kids.length) return { msg: old.length ? 'TP/SL removed' : 'nothing to set' };
    await sendOrders(kids, GROUP.OCO);
    return { msg: 'TP/SL set' };
  }

  return {
    address, apiKeyIndex, pollMs: 3000,
    state, order, cancel, cancelAll, setLeverage, setTpsl, setupApiKey,
    accountIndex, hasApiKey: () => !!loadKey(),
  };
}

export const lighter = {
  id: 'lighter', name: 'Lighter', site: 'https://app.lighter.xyz', collateral: 'USDC', defaultCoin: 'ETH',
  fees: { taker: 0, maker: 0 },   // the Standard tier is fee-free; Premium accounts get their rates from their fills
  key: { kind: 'evm', label: 'EVM private key (0x...)', help: 'Lighter accounts belong to an EVM address: deposit at app.lighter.xyz, then set up a trading key here (one signature).' },
  markets, watchPrices, candles, subCandles, subBook, subTrades, connect,
};
