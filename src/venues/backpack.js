// Backpack Exchange (backpack.exchange): a centralised exchange with ~100 USDC
// perps and ~90 spot markets. It is here for BP, Backpack's own token, which
// only trades as SPOT (BP_USDC) - so this adapter lists perps and spot together
// and marks each Market `spot: true|false`.
//
// Keys: Backpack signs with an ED25519 API key the user creates under
// Settings -> API Keys on backpack.exchange (it is not derived from a wallet).
// The "API Secret" it shows is the base64 32-byte ED25519 seed, so the public
// "API Key" can be derived from it: pasting the secret alone is enough
// ("apiKey:apiSecret" is accepted too, and checked against each other).
//
// Signing (docs.backpack.exchange, Authentication > Signature Generation): the
// request's body or query fields, sorted by key, as a query string, prefixed
// with `instruction=<name>&` and followed by `&timestamp=<ms>&window=<ms>`;
// ED25519 over its UTF-8 bytes; headers X-API-Key (base64 public key),
// X-Signature (base64), X-Timestamp, X-Window. Public market data is unsigned.
//
// CORS: api.backpack.exchange only answers CORS for https://backpack.exchange,
// so a browser page on any other origin cannot read it - not even public GETs.
// Route REST through a same-origin proxy with setBackpackBase('/backpack') (the
// proxy forwards /api/... and /wapi/... and the X- headers verbatim). The
// websocket (wss://ws.backpack.exchange) accepts any origin, so it stays direct.
import { ed25519 } from '@noble/curves/ed25519';
import { toStep, stepDecimals } from './util.js';

export const BACKPACK_WS = 'wss://ws.backpack.exchange';
let BASE = 'https://api.backpack.exchange';
/// where REST calls go: the real API, or a same-origin proxy in front of it
export function setBackpackBase(url) { BASE = String(url || 'https://api.backpack.exchange').replace(/\/+$/, ''); }
export const backpackBase = () => BASE;

const WINDOW = 10000;               // ms a signed request stays valid (default 5000, max 600000)
const hidden = () => !!globalThis.document?.hidden;

// --- base64 without Buffer (this runs in the browser) -----------------------------
export const toB64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
export const fromB64 = (s) => {
  const t = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/// Backpack's timestamps: numbers (ms, or µs on the stream) and naive UTC strings
/// like "2026-11-16 19:00:00" or "2024-09-11T12:00:00.123456" with no zone.
export function parseUtc(v) {
  if (typeof v === 'number') return v > 1e14 ? Math.floor(v / 1000) : v;
  let s = String(v).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  return Date.parse(s);
}

// --- signing ------------------------------------------------------------------------
// booleans sign as true/false, numbers and decimal strings as written
const val = (v) => String(v);
/// fields sorted by key as `k=v&k=v`; an array value is listed once per value
/// (`marketType=SPOT&marketType=PERP`); empty fields are left out
function sortedQuery(params) {
  const out = [];
  for (const k of Object.keys(params || {}).sort()) {
    const v = params[k];
    if (v === undefined || v === null || v === '') continue;
    for (const x of Array.isArray(v) ? v : [v]) out.push(`${k}=${val(x)}`);
  }
  return out.join('&');
}
/// the exact string Backpack verifies. `params` is one request's fields, or an
/// array of them for a batch (POST /orders), each prefixed with the instruction.
export function backpackSigningString(instruction, params, timestamp, window = 5000) {
  const parts = (Array.isArray(params) ? params : [params]).map((p) => {
    const q = sortedQuery(p);
    return `instruction=${instruction}${q ? '&' + q : ''}`;
  });
  return `${parts.join('&')}&timestamp=${timestamp}&window=${window}`;
}

/// the pasted secret -> { apiKey (base64 public key), seed (32 bytes) }. Accepts
/// the API Secret alone (base64 32-byte seed), seed||public (64 bytes), or
/// "apiKey:apiSecret". Throws a readable error for anything else.
export function backpackKeys(secret) {
  const raw = String(secret || '').trim();
  if (!raw) throw new Error('paste your Backpack API Secret');
  let given = null, sec = raw;
  const m = raw.match(/^([A-Za-z0-9+/_=-]{40,})\s*[:|,\s]\s*([A-Za-z0-9+/_=-]{40,})$/);
  if (m) { given = m[1]; sec = m[2]; }
  let bytes;
  try { bytes = fromB64(sec); } catch { throw new Error('that is not base64: paste the API Secret Backpack showed when you created the key'); }
  if (bytes.length !== 32 && bytes.length !== 64) throw new Error(`a Backpack API Secret is 32 bytes of base64 (44 characters); this decodes to ${bytes.length} bytes`);
  const seed = bytes.slice(0, 32);
  const pub = ed25519.getPublicKey(seed);
  const apiKey = toB64(pub);
  if (bytes.length === 64 && toB64(bytes.slice(32)) !== apiKey) throw new Error('that 64-byte key does not match its own public half');
  if (given) {
    let g; try { g = toB64(fromB64(given)); } catch { g = null; }
    if (g !== apiKey) {
      // maybe pasted the other way round ("apiSecret:apiKey")
      if (g && toB64(ed25519.getPublicKey(fromB64(given).slice(0, 32))) === toB64(fromB64(sec))) return backpackKeys(`${sec}:${given}`);
      throw new Error('that API Secret does not belong to that API Key');
    }
  }
  return { apiKey, seed };
}

/// the four auth headers for one request
export function backpackHeaders({ apiKey, seed }, instruction, params, timestamp = Date.now(), window = WINDOW) {
  const msg = backpackSigningString(instruction, params, timestamp, window);
  const sig = ed25519.sign(new TextEncoder().encode(msg), seed);
  return { 'X-API-Key': apiKey, 'X-Signature': toB64(sig), 'X-Timestamp': String(timestamp), 'X-Window': String(window) };
}

async function readJson(r, what) {
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  if (!r.ok) {
    const e = new Error(j?.message || text || `Backpack ${what}: HTTP ${r.status}`);
    e.code = j?.code; e.status = r.status;
    throw e;
  }
  return j;
}
const get = async (path, q = {}) => {
  const qs = sortedQuery(q);
  return readJson(await fetch(BASE + path + (qs ? '?' + qs : '')), path);
};

/// a signed call: GET/DELETE-less-body fields go in the query string, others as
/// a JSON body; the same sorted fields are what gets signed either way
export async function backpackSigned(keys, method, path, instruction, params = {}) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const headers = backpackHeaders(keys, instruction, clean);
  const isGet = method === 'GET';
  const qs = isGet ? Object.keys(clean).sort().flatMap((k) => (Array.isArray(clean[k]) ? clean[k] : [clean[k]]).map((v) => `${k}=${encodeURIComponent(val(v))}`)).join('&') : '';
  const r = await fetch(BASE + path + (qs ? '?' + qs : ''), {
    method,
    headers: isGet ? headers : { ...headers, 'content-type': 'application/json; charset=utf-8' },
    body: isGet ? undefined : JSON.stringify(clean),
  });
  return readJson(r, path);
}

// last known prices, so positions and market orders have a reference between polls
const lastPx = new Map();

// --- one shared websocket: book, candles, trades ------------------------------------
// Streams are named `depth.200ms.SOL_USDC`, `kline.1m.SOL_USDC`, `trade.SOL_USDC`;
// every message is { stream, data }. The server pings every 60 s and browsers
// answer pings on their own, so no keep-alive is needed here.
const ws = { sock: null, subs: new Map(), open: false, n: 0 };
const wsSend = (o) => { if (ws.open) ws.sock.send(JSON.stringify(o)); };
function wsConnect() {
  if (ws.sock) return;
  const s = new WebSocket(BACKPACK_WS);
  ws.sock = s;
  s.onopen = () => {
    ws.open = true;
    const streams = [...new Set([...ws.subs.values()].map((x) => x.stream))];
    if (streams.length) wsSend({ method: 'SUBSCRIBE', params: streams });
  };
  s.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (!m?.stream || !m.data) return;
    for (const sub of ws.subs.values()) if (sub.stream === m.stream) sub.cb(m.data);
  };
  s.onclose = () => {
    ws.sock = null; ws.open = false;
    for (const sub of ws.subs.values()) sub.onReconnect?.();
    if (ws.subs.size) setTimeout(wsConnect, 1500);
  };
  s.onerror = () => { try { s.close(); } catch { /* closing */ } };
}
function wsSub(stream, cb, onReconnect) {
  const k = ++ws.n;
  const fresh = ![...ws.subs.values()].some((x) => x.stream === stream);
  ws.subs.set(k, { stream, cb, onReconnect });
  wsConnect();
  if (fresh) wsSend({ method: 'SUBSCRIBE', params: [stream] });
  return () => {
    ws.subs.delete(k);
    if (![...ws.subs.values()].some((x) => x.stream === stream)) wsSend({ method: 'UNSUBSCRIBE', params: [stream] });
    if (!ws.subs.size && ws.sock) { const s = ws.sock; ws.sock = null; ws.open = false; s.onclose = null; try { s.close(); } catch { /* closing */ } }
  };
}

// --- markets ----------------------------------------------------------------------
// Backpack funds perps every fundingInterval ms (an hour for all of them today);
// the page wants a per-hour fraction, so the interval rate is scaled to an hour.
const perHour = (rate, intervalMs) => (+rate || 0) / ((+intervalMs || 3600000) / 3600000);

function applyTicker(m, t) {
  const last = +t.lastPrice;
  if (last > 0) {
    m.mid = last;
    if (m.spot) { m.mark = last; m.oracle = last; }
  }
  m.change = +t.priceChangePercent * 100;   // Backpack gives a fraction: -0.0197 is -1.97%
  m.volume = +t.quoteVolume;                // 24h, in USDC
  lastPx.set(m.coin, { mark: m.mark || m.mid, mid: m.mid });
}
function applyMark(m, p) {
  m.mark = +p.markPrice; m.oracle = +p.indexPrice || m.mark;
  if (!m.mid) m.mid = m.mark;
  m.funding = perHour(p.fundingRate, m.fundingInterval);
  lastPx.set(m.coin, { mark: m.mark, mid: m.mid });
}

let infoCache = null;  // symbol -> raw market, for order sizing
const loadInfo = async () => (infoCache ??= get('/api/v1/markets').then((list) => new Map(list.map((x) => [x.symbol, x])))
  .catch((e) => { infoCache = null; throw e; }));

async function markets() {
  const [list, tickers, marks, ois] = await Promise.all([
    get('/api/v1/markets'), get('/api/v1/tickers').catch(() => []),
    get('/api/v1/markPrices').catch(() => []), get('/api/v1/openInterest').catch(() => []),
  ]);
  infoCache = Promise.resolve(new Map(list.map((x) => [x.symbol, x])));
  const tk = new Map(tickers.map((t) => [t.symbol, t]));
  const mk = new Map(marks.map((p) => [p.symbol, p]));
  const oi = new Map(ois.map((o) => [o.symbol, +o.openInterest || 0]));
  return list.filter((x) => (x.marketType === 'SPOT' || x.marketType === 'PERP') && x.visible !== false && x.orderBookState !== 'Closed').map((x) => {
    const spot = x.marketType === 'SPOT';
    const tick = x.filters.price.tickSize, lot = x.filters.quantity.stepSize;
    // max leverage is 1 / the base initial-margin fraction (SOL 0.02 -> 50x, BTC 0.0133 -> 75x)
    const imf = +x.imfFunction?.base;
    const m = {
      coin: x.symbol, label: spot ? `${x.baseSymbol}/${x.quoteSymbol}` : x.baseSymbol, pair: spot ? `${x.baseSymbol}/${x.quoteSymbol}` : undefined,
      base: x.baseSymbol, dex: '', dexName: 'Backpack', asset: null, venue: 'backpack', spot,
      tick, lot, szDecimals: stepDecimals(lot), pxDecimals: stepDecimals(tick), minQty: +x.filters.quantity.minQuantity || 0,
      minNotional: 0, maxLeverage: spot ? 1 : imf > 0 ? Math.floor(1 / imf + 1e-9) : 1, onlyIsolated: false,
      collateral: x.quoteSymbol, delisted: false, postOnly: x.orderBookState === 'PostOnly', fundingInterval: spot ? 0 : +x.fundingInterval || 3600000,
      mid: 0, mark: 0, oracle: 0, change: 0, funding: 0, oi: spot ? 0 : oi.get(x.symbol) || 0, volume: 0, rwa: x.rwaMarketType || null,
    };
    const t = tk.get(x.symbol); if (t) applyTicker(m, t);
    const p = !spot && mk.get(x.symbol); if (p) applyMark(m, p);
    m.minNotional = m.minQty * (m.mid || 0);
    return m;
  });
}
function watchPrices(list, onUpdate) {
  const by = new Map(list.map((m) => [m.coin, m]));
  let stop = false, n = 0;
  const tick = async () => {
    if (stop) return;
    try {
      // open interest only moves once a minute on Backpack's side
      const [tickers, marks, ois] = await Promise.all([
        get('/api/v1/tickers'), get('/api/v1/markPrices'), n++ % 20 === 0 ? get('/api/v1/openInterest').catch(() => null) : null,
      ]);
      for (const t of tickers) { const m = by.get(t.symbol); if (m) applyTicker(m, t); }
      for (const p of marks) { const m = by.get(p.symbol); if (m && !m.spot) applyMark(m, p); }
      for (const o of ois || []) { const m = by.get(o.symbol); if (m && !m.spot) m.oi = +o.openInterest || 0; }
      onUpdate();
    } catch { /* next time */ }
    if (!stop) setTimeout(tick, hidden() ? 6000 : 3000);
  };
  setTimeout(tick, 3000);
  return () => { stop = true; };
}

// --- chart ------------------------------------------------------------------------
const IVAL = { '1M': '1month' };
const IVAL_S = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800, '12h': 43200, '1d': 86400, '3d': 259200, '1w': 604800, '1M': 2678400 };
const toK = (c) => ({ t: parseUtc(c.start), o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume });
/// klines take startTime/endTime in SECONDS (the page speaks ms), and refuse a
/// range of much over 2000 bars, so long ranges are fetched in 1000-bar pieces
async function candles(coin, interval, start, end) {
  const iv = IVAL[interval] || interval, step = (IVAL_S[interval] || 60) * 1000;
  const out = new Map();
  for (let from = Math.floor(start / 1000), to = Math.floor(end / 1000); from < to;) {
    const upto = Math.min(to, from + (step / 1000) * 1000);
    const part = await get('/api/v1/klines', { symbol: coin, interval: iv, startTime: from, endTime: upto });
    for (const c of part || []) { const k = toK(c); if (k.t >= start - step && k.t <= end) out.set(k.t, k); }
    from = upto;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
function subCandles(coin, interval, cb) {
  const iv = IVAL[interval] || interval;
  return wsSub(`kline.${iv}.${coin}`, (d) => cb({ t: parseUtc(d.t), o: +d.o, h: +d.h, l: +d.l, c: +d.c, v: +d.v }));
}

/// depth: a REST snapshot, then the 200 ms stream of absolute level changes
/// (size 0 removes a level). Update ids must run on (U = previous u + 1);
/// on a gap or a reconnect the snapshot is fetched again.
const BOOK_LEVELS = 100;
function subBook(coin, cb) {
  const sides = [new Map(), new Map()];       // bids, asks: price number -> [px, sz]
  let last = null, loading = false, unsequenced = false, stopped = false;
  const buf = [];
  const emit = () => {
    if (stopped) return;
    const lv = (i) => [...sides[i].values()].sort((a, b) => (i ? +a[0] - +b[0] : +b[0] - +a[0])).slice(0, BOOK_LEVELS).map(([px, sz]) => ({ px, sz, n: 1 }));
    cb({ levels: [lv(0), lv(1)] });
  };
  const apply = (d) => {
    for (const [i, rows] of [[0, d.b], [1, d.a]]) for (const [px, sz] of rows || []) {
      if (+sz === 0) sides[i].delete(+px); else sides[i].set(+px, [px, sz]);
    }
    last = +d.u;
  };
  const snapshot = async () => {
    if (loading || stopped) return;
    loading = true;
    try {
      const b = await get('/api/v1/depth', { symbol: coin, limit: 1000 });
      sides[0].clear(); sides[1].clear();
      for (const [px, sz] of b.bids) sides[0].set(+px, [px, sz]);
      for (const [px, sz] of b.asks) sides[1].set(+px, [px, sz]);
      last = +b.lastUpdateId; unsequenced = false;
      for (const d of buf.splice(0)) if (+d.u > last) apply(d);
    } catch {
      // no REST (e.g. CORS without a proxy): build the book from the stream alone
      unsequenced = true;
      for (const d of buf.splice(0)) apply(d);
    }
    loading = false;
    emit();
  };
  const stop = wsSub(`depth.200ms.${coin}`, (d) => {
    if (loading || last == null) { buf.push(d); return; }
    if (!unsequenced && +d.U !== last + 1) {
      if (+d.u <= last) return;                 // already in the snapshot
      buf.push(d); snapshot(); return;
    }
    apply(d); emit();
  }, () => { last = null; });
  snapshot();
  return () => { stopped = true; stop(); };
}
function subTrades(coin, cb) {
  const conv = (px, sz, buyerMaker, time) => ({ px, sz, side: buyerMaker ? 'A' : 'B', time });
  // REST is newest first; the page wants each batch oldest first
  get('/api/v1/trades', { symbol: coin, limit: 30 })
    .then((ts) => cb(ts.map((t) => conv(t.price, t.quantity, t.isBuyerMaker, t.timestamp)).reverse())).catch(() => {});
  // the stream's `m` is "buyer was the maker", so the aggressor sold
  return wsSub(`trade.${coin}`, (d) => cb([conv(d.p, d.q, d.m, parseUtc(d.T))]));
}

// --- account ----------------------------------------------------------------------
const notFound = (e) => /not found/i.test(e?.message || '');

// Backpack labels a trigger order only by its trigger price; whether it is a
// take-profit or a stop depends on which side of the market that price sits.
function orderLabel(o, mark) {
  const base = o.orderType === 'Limit' ? 'Limit' : 'Market';
  if (o.triggerPrice == null) return base;
  const tp = mark > 0 && (o.side === 'Ask' ? +o.triggerPrice > mark : +o.triggerPrice < mark);
  return `${tp ? 'Take Profit' : 'Stop'} ${base}`;
}

/// fills come without open/close, so walk back from the current position: each
/// fill's start position is the next one's minus its own signed size
function withDirs(fills, positions, spotCoins) {
  const cur = new Map(positions.map((p) => [p.symbol, +p.netQuantity]));
  for (const f of fills) {
    if (spotCoins.has(f.coin)) { f.dir = f.side === 'B' ? 'Buy' : 'Sell'; continue; }
    const after = cur.get(f.coin) || 0, d = (f.side === 'B' ? 1 : -1) * +f.sz;
    const before = Math.round((after - d) * 1e9) / 1e9;
    f.startPosition = String(before);
    f.dir = f.side === 'B'
      ? (before >= 0 ? 'Open Long' : after <= 0 ? 'Close Short' : 'Short > Long')
      : (before <= 0 ? 'Open Short' : after >= 0 ? 'Close Long' : 'Long > Short');
    cur.set(f.coin, before);
  }
  return fills;
}

function connect(secret) {
  const keys = backpackKeys(secret);
  const call = (method, path, instruction, params) => backpackSigned(keys, method, path, instruction, params);
  const mkt = async (coin) => (await loadInfo()).get(coin);

  let polls = 0, fills = [], account = null;
  async function state() {
    const [balances, collateral, positions, orders, acct] = await Promise.all([
      call('GET', '/api/v1/capital', 'balanceQuery'),
      call('GET', '/api/v1/capital/collateral', 'collateralQuery').catch((e) => { if (notFound(e)) return null; throw e; }),
      call('GET', '/api/v1/position', 'positionQuery').catch((e) => { if (notFound(e)) return []; throw e; }),
      call('GET', '/api/v1/orders', 'orderQueryAll').catch((e) => { if (notFound(e)) return []; throw e; }),
      // fees and the leverage limit rarely change: every tenth poll
      polls % 10 === 0 ? call('GET', '/api/v1/account', 'accountQuery').catch((e) => { if (notFound(e)) return null; throw e; }) : account,
    ]);
    account = acct;
    const info = await loadInfo();
    const spotCoins = new Set([...info.values()].filter((x) => x.marketType === 'SPOT').map((x) => x.symbol));
    // trade history is heavier: every third poll
    if (polls++ % 3 === 0) {
      const h = await call('GET', '/wapi/v1/history/fills', 'fillHistoryQueryAll', { limit: 100, sortDirection: 'Desc' }).catch((e) => (notFound(e) ? [] : null));
      if (h) {
        fills = withDirs(h.map((f) => ({
          coin: f.symbol, oid: f.orderId, side: f.side === 'Bid' ? 'B' : 'A', px: f.price, sz: f.quantity, time: parseUtc(f.timestamp),
          closedPnl: '0', fee: f.fee ?? '0', feeToken: f.feeSymbol || 'USDC', liquidation: /Liquidat|Adl|Backstop/i.test(f.systemOrderType || ''),
        })).sort((a, b) => b.time - a.time), positions || [], spotCoins);
      }
    }

    // Leverage: Backpack has one account-wide leverage limit (PATCH /account
    // leverageLimit), not a per-market setting, and margins every perp cross
    // against the whole account (spot holdings count as collateral after a
    // haircut). A position's own initial-margin fraction (imf) is the larger of
    // 1/limit and the market's size-scaled imfFunction, so 1/imf is the
    // leverage it is actually held at.
    const limit = +account?.leverageLimit || 0;
    let ntl = 0;
    const assetPositions = [];
    for (const p of positions || []) {
      const szi = +p.netQuantity;
      if (!szi) continue;
      const mark = lastPx.get(p.symbol)?.mark || +p.markPrice || +p.entryPrice;
      const imf = +p.imf || (limit ? 1 / limit : 1);
      const value = Math.abs(szi) * mark;
      const upnl = szi * (mark - +p.entryPrice);
      const margin = value * imf;
      ntl += value;
      assetPositions.push({ position: {
        coin: p.symbol, szi: String(szi), entryPx: p.entryPrice, positionValue: String(value), unrealizedPnl: String(upnl),
        returnOnEquity: String(margin ? upnl / margin : 0), liquidationPx: +p.estLiquidationPrice > 0 ? p.estLiquidationPrice : null, marginUsed: String(margin),
        leverage: { type: 'cross', value: Math.max(1, Math.round(1 / imf)) }, cumFunding: { sinceOpen: p.cumulativeFundingPayment },
      } });
    }

    const spot = { balances: Object.entries(balances || {}).map(([coin, b]) => {
      const hold = +b.locked + +(b.staked || 0);
      return { coin, total: String(+b.available + hold), hold: String(hold) };
    }).filter((b) => +b.total > 0) };

    const eq = collateral ? +collateral.netEquity : 0;
    return {
      st: {
        marginSummary: { accountValue: String(eq) }, withdrawable: String(collateral ? +collateral.netEquityAvailable : 0),
        crossMarginSummary: { accountValue: String(eq), totalNtlPos: String(ntl) },
        crossMaintenanceMarginUsed: String(collateral ? +collateral.mmf * +collateral.netExposureFutures || 0 : 0), assetPositions,
        leverageLimit: limit || null,
        venueNote: collateral ? null : 'no Backpack account behind this API key: deposit on backpack.exchange first',
      },
      spot,
      orders: (orders || []).map((o) => {
        const trig = o.triggerPrice != null || o.status === 'TriggerPending';
        const qty = o.quantity ?? o.triggerQuantity;
        const label = orderLabel(o, lastPx.get(o.symbol)?.mark);
        // a sell take-profit and a buy stop fire on the way up; the others on the way down
        const above = (o.side === 'Ask') === label.startsWith('Take');
        return {
          coin: o.symbol, oid: o.id, side: o.side === 'Bid' ? 'B' : 'A',
          sz: String(Math.max(0, +qty - +(o.executedQuantity || 0))), limitPx: o.price ?? o.triggerPrice,
          orderType: label, reduceOnly: !!o.reduceOnly,
          isTrigger: trig, triggerPx: o.triggerPrice, timestamp: parseUtc(o.createdAt),
          triggerCondition: trig ? `${o.triggerBy ? o.triggerBy.replace('Price', ' price') : 'Price'} ${above ? 'above' : 'below'} ${o.triggerPrice}` : undefined,
        };
      }),
      fills,
      // fees are in basis points; perps and spot have their own tiers
      fees: account ? {
        taker: +account.futuresTakerFee / 1e4, maker: +account.futuresMakerFee / 1e4,
        spotTaker: +account.spotTakerFee / 1e4, spotMaker: +account.spotMakerFee / 1e4,
      } : null,
    };
  }

  /// best bid / ask now, for pricing a market order
  async function touch(coin) {
    try {
      const b = await get('/api/v1/depth', { symbol: coin, limit: 5 });
      // asks come best first, bids worst first
      return { bid: +b.bids.at(-1)?.[0] || 0, ask: +b.asks[0]?.[0] || 0 };
    } catch { const p = lastPx.get(coin); return { bid: p?.mid || 0, ask: p?.mid || 0 }; }
  }

  async function order({ coin, isBuy, sz, type = 'market', px, slippage = 1, reduceOnly = false, tif = 'GTC', tp, sl }) {
    const info = await mkt(coin);
    if (!info) throw new Error(`Backpack has no ${coin} market`);
    const spot = info.marketType === 'SPOT';
    const { tickSize: tick } = info.filters.price, { stepSize: lot, minQuantity } = info.filters.quantity;
    const quantity = toStep(+sz, lot);
    if (!(+quantity > 0)) throw new Error(`size rounds to zero (lot ${lot} ${info.baseSymbol})`);
    if (+quantity < +minQuantity) throw new Error(`Backpack's minimum on ${coin} is ${minQuantity} ${info.baseSymbol}`);
    if (spot && (tp || sl)) throw new Error('Backpack takes TP/SL only on perps: place a separate order for spot');
    const body = { symbol: coin, side: isBuy ? 'Bid' : 'Ask', orderType: 'Limit', quantity };
    if (reduceOnly && !spot) body.reduceOnly = true;
    if (tp) body.takeProfitTriggerPrice = toStep(+tp, tick, 'round');
    if (sl) body.stopLossTriggerPrice = toStep(+sl, tick, 'round');
    if (type === 'market') {
      // Hyperliquid-style market: an IOC limit `slippage`% through the touch, so
      // the page's slippage setting holds (Backpack's own Market type only has
      // its per-market impact limit). A spot buy locks size x that price in USDC.
      const t = await touch(coin);
      const ref = isBuy ? t.ask : t.bid;
      if (!(ref > 0)) throw new Error(`no ${isBuy ? 'asks' : 'bids'} on ${coin} to trade against`);
      body.price = toStep(ref * (1 + (isBuy ? 1 : -1) * slippage / 100), tick, isBuy ? 'ceil' : 'floor');
      body.timeInForce = 'IOC';
    } else {
      if (!(+px > 0)) throw new Error('enter a limit price');
      body.price = toStep(+px, tick, 'round');
      if (tif === 'Alo') { body.postOnly = true; body.timeInForce = 'GTC'; } else body.timeInForce = tif === 'Ioc' ? 'IOC' : 'GTC';
    }
    const res = await call('POST', '/api/v1/order', 'orderExecute', body);
    const done = +res?.executedQuantity || 0;
    if (body.timeInForce === 'IOC' && !done) throw new Error(`nothing filled within ${type === 'market' ? slippage + '% of the touch' : 'the limit'}`);
    return { ok: true, id: res?.id, msg: `order ${res?.id ?? ''} ${res?.status || 'placed'}${done ? ` · filled ${done}` : ''}` };
  }

  // trigger orders are ordinary orders on Backpack: the same cancel works
  const cancel = (coin, oid) => call('DELETE', '/api/v1/order', 'orderCancel', { orderId: String(oid), symbol: coin });
  // no symbol: every market, resting and trigger orders alike
  const cancelAll = () => call('DELETE', '/api/v1/orders', 'orderCancelAll', {});

  /// Backpack's leverage is one limit for the whole account, so `coin` only
  /// caps it at that market's maximum; isolated margin needs a subaccount.
  async function setLeverage(coin, lev, cross = true) {
    if (cross === false) throw new Error('Backpack margins every perp cross from the account: isolated margin needs a separate subaccount');
    const info = coin && await mkt(coin);
    const max = info?.imfFunction?.base ? Math.floor(1 / +info.imfFunction.base + 1e-9) : Infinity;
    const want = Math.max(1, Math.min(Math.round(+lev), max));
    await call('PATCH', '/api/v1/account', 'accountUpdate', { leverageLimit: String(want) });
    if (account) account.leverageLimit = String(want);
  }

  /// TP/SL on an open position: reduce-only trigger market orders for its whole
  /// size, replacing any take-profit / stop already resting on that side
  async function setTpsl(coin, { tp, sl, long }) {
    const info = await mkt(coin);
    if (!info) throw new Error(`Backpack has no ${coin} market`);
    if (info.marketType === 'SPOT') throw new Error('Backpack takes TP/SL only on perps');
    const [pos] = await call('GET', '/api/v1/position', 'positionQuery', { symbol: coin }).catch(() => []);
    const size = Math.abs(+pos?.netQuantity || 0);
    if (!size) throw new Error(`no open ${coin} position`);
    long ??= +pos.netQuantity > 0;
    const side = long ? 'Ask' : 'Bid';
    const mark = lastPx.get(coin)?.mark || +pos.markPrice;
    const open = await call('GET', '/api/v1/orders', 'orderQueryAll', { symbol: coin }).catch(() => []);
    for (const o of open || []) {
      if (o.triggerPrice == null || !o.reduceOnly || o.side !== side) continue;
      const isTp = orderLabel(o, mark).startsWith('Take');
      if ((tp && isTp) || (sl && !isTp)) await cancel(coin, o.id);
    }
    const qty = toStep(size, info.filters.quantity.stepSize);
    const out = [];
    for (const at of [tp, sl].filter(Boolean)) {
      // a trigger order carries its size as triggerQuantity (the order stream's `Y`)
      out.push(await call('POST', '/api/v1/order', 'orderExecute', {
        symbol: coin, side, orderType: 'Market', reduceOnly: true,
        triggerPrice: toStep(+at, info.filters.price.tickSize, 'round'), triggerQuantity: qty,
      }));
    }
    return out;
  }

  return { address: keys.apiKey, apiKey: keys.apiKey, state, order, cancel, cancelAll, setLeverage, setTpsl, pollMs: 3000, call };
}

export const backpack = {
  id: 'backpack', name: 'Backpack', site: 'https://backpack.exchange', collateral: 'USDC',
  defaultCoin: 'BP_USDC',
  key: {
    kind: 'apikey', label: 'Backpack API Secret (base64)',
    help: 'Create an API key on backpack.exchange under Settings > API Keys and paste its API Secret (the public API Key is worked out from it). Backpack trades BP as spot (BP/USDC) and perps against your USDC.',
  },
  markets, watchPrices, candles, subCandles, subBook, subTrades, connect,
};
