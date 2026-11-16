// Aster (asterdex.com): a Binance-style perps exchange whose v3 API is signed
// with EVM keys. The wallet's own key can't sign trading requests: Aster only
// accepts them from an "API wallet" (agent) that the wallet has approved. The
// approval is itself just an EIP-712 signature from the wallet, so it needs no
// website visit: the first state() call approves one and every request after
// that is signed by it.
//
// The API wallet's key is derived from the wallet's key (keccak256 of the key
// and a fixed label), so the page has nothing new to store: the same wallet
// always finds the same API wallet. It is approved for perps only, never for
// withdrawals, and Aster lets the wallet revoke it at any time.
//
// Signing, as Aster's docs (futures-v3/general-info, asterCode/authentication)
// and its demo (github.com/asterdex/API-demo, aster-code-demo/utils.js) do it:
//  - requests (orders, account reads): the query string exactly as sent, minus
//    the signature, with user (the wallet), signer (the API wallet) and nonce
//    (microseconds) in it, is signed as EIP-712 Message { msg: string } under
//    the domain AsterSignTransaction / 1 / chainId 1666 / verifyingContract 0x0.
//    Aster checks the string as received, so parameter order is free, but it
//    must match byte for byte.
//  - approving / revoking an API wallet: the wallet signs the request's own
//    fields as an EIP-712 struct (ApproveAgent, DelAgent), each key's first
//    letter capitalised, bools as bool, integers as uint256, everything else as
//    string, in a fixed order, under the same domain with chainId 56; the
//    request also carries signatureChainId=56.
// Aster opens trading and account reads only after the wallet's first deposit
// (-5050 "This function can only be used after deposit"); approving an API
// wallet works before that. The REST API and its preflights allow any origin.
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, concat, hexToBytes, stringToBytes } from 'viem';
import { toStep, stepDecimals } from './util.js';

export const ASTER_API = 'https://fapi.asterdex.com';
export const ASTER_WS = 'wss://fstream.asterdex.com/stream';
export const ASTER_SITE = 'https://www.asterdex.com/en/futures/v1/BTCUSDT';
// what Aster's EIP-712 signatures are made under
export const ASTER_DOMAIN = { name: 'AsterSignTransaction', version: '1', chainId: 1666, verifyingContract: '0x0000000000000000000000000000000000000000' };
export const ASTER_MAIN_CHAIN = 56;       // the wallet's own (approval) signatures
const QUOTES = new Set(['USDT', 'USDC']); // also listed: USD1 / U margined pairs, a separate wallet each
const DEFAULT_LEVERAGE = 20;              // the real per-market caps (leverageBrackets) need a signed, funded account
const AGENT_DAYS = 180;                   // Aster refuses an API wallet that lasts under a few days
const AGENT_LABEL = 'aster api wallet / tokenlaunch perps v1';

const num = (x) => (x == null || x === '' ? 0 : +x);
const trim = (s) => (String(s).includes('.') ? String(s).replace(/0+$/, '').replace(/\.$/, '') : String(s));

async function readJson(r) {
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* plain text error */ }
  // errors come as { code, msg } (trading) or { error } (API wallet endpoints)
  const bad = !r.ok || (j && !Array.isArray(j) && ((typeof j.code === 'number' && j.code < 0) || j.error));
  if (bad) {
    const e = new Error(j?.msg || j?.error || text || `HTTP ${r.status}`);
    e.code = j?.code ?? r.status; e.status = r.status;
    throw e;
  }
  return j;
}
const get = async (path) => readJson(await fetch(ASTER_API + path));

/// the query string exactly as it is sent and signed: key=value&..., in the given order
export const asterQuery = (params) => Object.entries(params)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

/// a request signature: EIP-712 Message { msg } over the query string, by the API wallet
export const signAsterMsg = (account, msg) => account.signTypedData({
  domain: ASTER_DOMAIN, types: { Message: [{ name: 'msg', type: 'string' }] }, primaryType: 'Message', message: { msg },
});
/// the wallet's own signature on an API wallet change (ApproveAgent, DelAgent, ...):
/// the request's fields as a struct, keys capitalised, types read off the values
export function asterMainTypedData(params, primaryType) {
  const message = Object.fromEntries(Object.entries(params).map(([k, v]) => [k[0].toUpperCase() + k.slice(1), v]));
  const fields = Object.entries(message).map(([name, v]) => ({ name, type: typeof v === 'boolean' ? 'bool' : Number.isInteger(v) ? 'uint256' : 'string' }));
  return { domain: { ...ASTER_DOMAIN, chainId: ASTER_MAIN_CHAIN }, types: { [primaryType]: fields }, primaryType, message };
}
export const signAsterMain = (account, params, primaryType) => account.signTypedData(asterMainTypedData(params, primaryType));

/// EVM private key -> { account, key }. Throws if it isn't one.
export function asterAccount(secret) {
  let k = String(secret || '').trim();
  if (/^[0-9a-f]{64}$/i.test(k)) k = '0x' + k;
  if (!/^0x[0-9a-f]{64}$/i.test(k)) throw new Error('Aster signs with an EVM key: 32 bytes of hex (0x...)');
  return { account: privateKeyToAccount(k), key: k };
}
/// the API wallet that belongs to a wallet key: same input, same API wallet. A
/// hash, so the API wallet's key never leads back to the wallet's.
export function asterAgentKey(mainKey) {
  const { key } = asterAccount(mainKey);
  return keccak256(concat([hexToBytes(key), stringToBytes(AGENT_LABEL)]));
}

// --- one shared websocket for every stream (book, candles, trades, prices) --------
const ws = { sock: null, open: false, subs: new Map(), id: 1 };
function wsSend(method, params) { if (ws.open && params.length) ws.sock.send(JSON.stringify({ method, params, id: ws.id++ })); }
function wsConnect() {
  if (ws.sock) return;
  const s = new WebSocket(ASTER_WS);
  ws.sock = s;
  s.onopen = () => { ws.open = true; wsSend('SUBSCRIBE', [...ws.subs.keys()]); };
  s.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    const cbs = m?.stream && ws.subs.get(m.stream);
    if (cbs) for (const cb of cbs) { try { cb(m.data); } catch { /* one bad listener */ } }
  };
  // Aster pings and the browser answers by itself; it still drops a connection after 24 h
  s.onclose = () => { ws.sock = null; ws.open = false; if (ws.subs.size) setTimeout(wsConnect, 1500); };
  s.onerror = () => { try { s.close(); } catch { /* closing */ } };
}
function wsSub(stream, cb) {
  let set = ws.subs.get(stream);
  if (!set) { set = new Set(); ws.subs.set(stream, set); wsSend('SUBSCRIBE', [stream]); }
  set.add(cb);
  wsConnect();
  return () => {
    set.delete(cb);
    if (!set.size && ws.subs.get(stream) === set) { ws.subs.delete(stream); wsSend('UNSUBSCRIBE', [stream]); }
  };
}
const hidden = () => typeof document !== 'undefined' && document.hidden;

// --- markets ----------------------------------------------------------------------
// the trading rules per symbol, and the latest Market objects, so a session can
// fill in each market's real leverage cap once it can read it
const specs = new Map();
const live = new Map();

function specOf(s) {
  const f = Object.fromEntries((s.filters || []).map((x) => [x.filterType, x]));
  return {
    symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset, margin: s.marginAsset,
    tick: trim(f.PRICE_FILTER?.tickSize ?? '0.01'), lot: trim(f.LOT_SIZE?.stepSize ?? '1'),
    minQty: num(f.LOT_SIZE?.minQty), maxQty: num(f.LOT_SIZE?.maxQty), marketMaxQty: num(f.MARKET_LOT_SIZE?.maxQty),
    minNotional: num(f.MIN_NOTIONAL?.notional) || 5,
    // a limit price must sit within these multiples of the mark price
    up: num(f.PERCENT_PRICE?.multiplierUp) || 0, down: num(f.PERCENT_PRICE?.multiplierDown) || 0,
  };
}
async function loadSpecs() {
  const info = await get('/fapi/v3/exchangeInfo');
  const out = [];
  for (const s of info.symbols || []) {
    if (s.contractType !== 'PERPETUAL' || s.status !== 'TRADING' || !QUOTES.has(s.quoteAsset)) continue;
    const sp = specOf(s); specs.set(sp.symbol, sp); out.push(sp);
  }
  return out;
}
async function spec(coin) {
  if (!specs.has(coin)) await loadSpecs();
  const s = specs.get(coin);
  if (!s) throw new Error(`Aster has no ${coin} market`);
  return s;
}

const hours = new Map(); // funding interval per symbol (most are 8 h, some 4 h or 1 h)
const perHour = (coin, rate) => num(rate) / (hours.get(coin) || 8);
function applyTicker(m, t) {
  m.mid = num(t.lastPrice ?? t.c) || m.mid;
  const open = num(t.openPrice ?? t.o);
  m.change = t.priceChangePercent != null ? num(t.priceChangePercent) : open ? (m.mid / open - 1) * 100 : m.change;
  m.volume = num(t.quoteVolume ?? t.q);
}
function applyMark(m, p) {
  m.mark = num(p.markPrice ?? p.p) || m.mark;
  m.oracle = num(p.indexPrice ?? p.i) || m.oracle;
  m.funding = perHour(m.coin, p.lastFundingRate ?? p.r);
  if (!m.mid) m.mid = m.mark;
}

async function markets() {
  const [sp, tickers, marks, funding] = await Promise.all([
    loadSpecs(), get('/fapi/v3/ticker/24hr'), get('/fapi/v3/premiumIndex'), get('/fapi/v3/fundingInfo').catch(() => []),
  ]);
  for (const f of funding || []) if (+f.fundingIntervalHours) hours.set(f.symbol, +f.fundingIntervalHours);
  const tBy = new Map(tickers.map((t) => [t.symbol, t])), pBy = new Map(marks.map((p) => [p.symbol, p]));
  const list = sp.map((s) => {
    const m = {
      coin: s.symbol, label: s.quote === 'USDT' ? s.base : `${s.base}/${s.quote}`, dex: '', dexName: 'Aster', asset: null, venue: 'aster',
      tick: s.tick, lot: s.lot, szDecimals: stepDecimals(s.lot), pxDecimals: stepDecimals(s.tick),
      minNotional: s.minNotional, maxLeverage: live.get(s.symbol)?.maxLeverage || DEFAULT_LEVERAGE, onlyIsolated: false,
      collateral: s.margin, delisted: false, mid: 0, mark: 0, oracle: 0, change: 0, funding: 0, oi: 0, volume: 0,
    };
    const t = tBy.get(s.symbol); if (t) applyTicker(m, t);
    const p = pBy.get(s.symbol); if (p) applyMark(m, p);
    live.set(m.coin, m);
    return m;
  });
  return list.sort((a, b) => b.volume - a.volume);
}

// open interest is one request per symbol, so it is kept for the busiest markets only
const OI_TOP = 30;
async function refreshOi(list) {
  const top = [...list].sort((a, b) => b.volume - a.volume).slice(0, OI_TOP);
  await Promise.all(top.map((m) => get(`/fapi/v3/openInterest?symbol=${m.coin}`).then((r) => { m.oi = num(r.openInterest); }).catch(() => {})));
}
function watchPrices(list, onUpdate) {
  const by = new Map(list.map((m) => [m.coin, m]));
  let dirty = false, stop = false, oiTimer = 0;
  // two all-market streams: marks + funding every 3 s, and 24 h tickers of whatever traded
  const offs = [
    wsSub('!markPrice@arr', (arr) => { for (const p of arr || []) { const m = by.get(p.s); if (m) { applyMark(m, p); dirty = true; } } }),
    wsSub('!miniTicker@arr', (arr) => { for (const t of arr || []) { const m = by.get(t.s); if (m) { applyTicker(m, t); dirty = true; } } }),
  ];
  const flush = setInterval(() => { if (dirty) { dirty = false; onUpdate(); } }, 1000);
  const oi = async () => {
    if (stop) return;
    if (!hidden()) { await refreshOi(list); onUpdate(); }
    if (!stop) oiTimer = setTimeout(oi, 60000);
  };
  oiTimer = setTimeout(oi, 3000);
  return () => { stop = true; clearInterval(flush); clearTimeout(oiTimer); offs.forEach((f) => f()); };
}

// --- chart ------------------------------------------------------------------------
const toK = (k) => (Array.isArray(k)
  ? { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }
  : { t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v });
async function candles(coin, interval, start, end) {
  // Aster serves at most 1500 bars a call: page back from the end
  const out = [];
  let until = Math.floor(end);
  for (let page = 0; page < 6; page++) {
    const rows = await get(`/fapi/v3/klines?symbol=${encodeURIComponent(coin)}&interval=${interval}&endTime=${until}&limit=1500`);
    if (!rows?.length) break;
    out.push(...rows.map(toK));
    if (rows.length < 1500 || +rows[0][0] <= start) break;
    until = +rows[0][0] - 1;
  }
  const seen = new Set();
  return out.filter((c) => c.t >= start - 1 && !seen.has(c.t) && seen.add(c.t)).sort((a, b) => a.t - b.t);
}
function subCandles(coin, interval, cb) {
  return wsSub(`${coin.toLowerCase()}@kline_${interval}`, (d) => d?.k && cb(toK(d.k)));
}
function subBook(coin, cb) {
  // Aster's book has no per-level order counts
  const conv = (side) => (side || []).map(([px, sz]) => ({ px, sz, n: 0 }));
  let stop = false;
  // a REST read paints at once; the stream then sends the top 20 levels every 100 ms
  get(`/fapi/v3/depth?symbol=${encodeURIComponent(coin)}&limit=20`).then((b) => { if (!stop) cb({ levels: [conv(b.bids), conv(b.asks)] }); }).catch(() => {});
  const off = wsSub(`${coin.toLowerCase()}@depth20@100ms`, (d) => cb({ levels: [conv(d.b), conv(d.a)] }));
  return () => { stop = true; off(); };
}
function subTrades(coin, cb) {
  // m = the buyer was the maker, so the seller hit the bid
  return wsSub(`${coin.toLowerCase()}@aggTrade`, (t) => cb([{ px: t.p, sz: t.q, side: t.m ? 'A' : 'B', time: +t.T }]));
}

// --- account ----------------------------------------------------------------------
const ORDER_TYPES = { LIMIT: 'Limit', MARKET: 'Market', STOP: 'Stop Limit', STOP_MARKET: 'Stop Market', TAKE_PROFIT: 'Take Profit Limit', TAKE_PROFIT_MARKET: 'Take Profit Market', TRAILING_STOP_MARKET: 'Trailing Stop' };
const TRIGGERS = new Set(['STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET']);
const TIF = { Gtc: 'GTC', Ioc: 'IOC', Alo: 'GTX', GTC: 'GTC', IOC: 'IOC', ALO: 'GTX', GTX: 'GTX' };
export const NO_DEPOSIT = -5050;
const noDeposit = (e) => e?.code === NO_DEPOSIT || /only be used after deposit/i.test(e?.message || '');
const noAgent = (e) => /no agent|agent .*expired|agent not/i.test(e?.message || '');
const ignorable = (e) => /no need to change/i.test(e?.message || '') || e?.code === -4046 || e?.code === -4059;

function connect(secret, opts = {}) {
  const { account: main } = asterAccount(secret);
  const address = main.address;
  // opts.agentKey: an API wallet made elsewhere (e.g. on asterdex.com's API page)
  const agent = privateKeyToAccount(opts.agentKey ? asterAccount(opts.agentKey).key : asterAgentKey(secret));
  const signer = agent.address;

  // the nonce must be within 60 s of Aster's clock and never repeat for an API wallet
  let skew = 0, lastNonce = 0;
  const clock = get('/fapi/v3/time').then((t) => { skew = +t.serverTime - Date.now(); }).catch(() => {});
  const nonce = () => { let n = Math.floor((Date.now() + skew) * 1000); if (n <= lastNonce) n = lastNonce + 1; lastNonce = n; return n; };

  async function send(method, path, query) {
    const r = method === 'GET'
      ? await fetch(`${ASTER_API}${path}?${query}`)
      : await fetch(ASTER_API + path, { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: query });
    return readJson(r);
  }
  /// a request signed by the API wallet
  async function signedRaw(method, path, params = {}) {
    await clock;
    const q = asterQuery({ ...params, user: address, signer, nonce: nonce() });
    return send(method, path, `${q}&signature=${await signAsterMsg(agent, q)}`);
  }
  /// a change to the API wallet, signed by the wallet itself
  async function signedMain(method, path, params, primaryType) {
    await clock;
    const p = { ...params, asterChain: 'Mainnet', user: address, nonce: nonce() };
    const signature = await signAsterMain(main, p, primaryType);
    return send(method, path, asterQuery({ ...p, signature, signatureChainId: ASTER_MAIN_CHAIN }));
  }

  /// the API wallets this wallet has approved (works before any deposit)
  const agents = () => signedRaw('GET', '/fapi/v3/agent');
  /// approve this session's API wallet: perps only, no withdrawals, AGENT_DAYS long
  async function approveSigner() {
    const params = {
      agentName: `perps-${signer.slice(2, 8)}`, agentAddress: signer, ipWhitelist: '',
      expired: Math.floor(Date.now() + AGENT_DAYS * 86400e3), canSpotTrade: false, canPerpTrade: true, canWithdraw: false,
    };
    try { return await signedMain('POST', '/fapi/v3/approveAgent', params, 'ApproveAgent'); } catch (e) {
      // already there but expired: revoke it and approve it again
      if (!/already exists/i.test(e.message)) throw e;
      await revokeSigner().catch(() => {});
      return signedMain('POST', '/fapi/v3/approveAgent', params, 'ApproveAgent');
    }
  }
  const revokeSigner = () => signedMain('DELETE', '/fapi/v3/agent', { agentAddress: signer }, 'DelAgent');

  // approve the API wallet once, before the first signed request (renewing it near expiry)
  let ready = null;
  function ensureSigner() {
    ready ??= (async () => {
      let mine = null;
      try { mine = (await agents()).find((a) => a.agentAddress?.toLowerCase() === signer.toLowerCase()); } catch (e) { if (!noAgent(e)) throw e; }
      if (opts.agentKey) { if (!mine) throw new Error(`API wallet ${signer} is not approved for ${address} on Aster`); return; }
      if (!mine || +mine.expired < Date.now() + 7 * 86400e3 || !mine.canPerpTrade) {
        if (mine) await revokeSigner().catch(() => {});
        await approveSigner();
      }
    })().catch((e) => {
      setTimeout(() => { ready = null; }, 30000); // don't sign approvals on every poll
      throw new Error(`could not approve an Aster API wallet: ${e.message}`);
    });
    return ready;
  }
  async function signed(method, path, params) { await ensureSigner(); return signedRaw(method, path, params); }
  // Is the API wallet approved already? Reading the list changes nothing, so
  // polling uses this; approving (a signature that changes the account) waits
  // for the first order or setupApiKey() - something the user did on purpose.
  let known = null;
  async function signerReady() {
    if (opts.agentKey) return true;
    if (known && Date.now() - known.at < 60000) return known.ok;
    let mine = null;
    try { mine = (await agents()).find((a) => a.agentAddress?.toLowerCase() === signer.toLowerCase()); } catch (e) { if (!noAgent(e)) throw e; }
    const ok = !!mine && +mine.expired >= Date.now() + 7 * 86400e3 && !!mine.canPerpTrade;
    known = { at: Date.now(), ok };
    return ok;
  }
  const setupApiKey = async () => { ready = null; await ensureSigner(); known = { at: Date.now(), ok: true }; return { msg: `Aster API wallet ${signer.slice(0, 8)}… approved (perps only, no withdrawals)` }; };

  // once per session: hedge mode, fees, leverage caps
  let dual = null, fees = null, brackets = null;
  // hedge mode needs a positionSide on every order; if it can't be read, assume one-way and ask again next time
  const hedge = async () => (dual ??= signed('GET', '/fapi/v3/positionSide/dual').then((r) => !!r.dualSidePosition).catch(() => { dual = null; return false; }));
  const maxLev = new Map();
  async function loadBrackets() {
    brackets ??= signed('GET', '/fapi/v3/leverageBrackets').then((rows) => {
      for (const r of rows || []) {
        const cap = Math.max(...(r.brackets || []).map((b) => +b.initialLeverage || 0));
        if (cap > 0) { maxLev.set(r.symbol, cap); const m = live.get(r.symbol); if (m) m.maxLeverage = cap; }
      }
    }).catch(() => { brackets = null; });
    return brackets;
  }

  let polls = 0, fills = [], orders = [], ordersDirty = true;
  const touched = new Set(); // symbols this session traded: their fills are read too
  async function state() {
    try {
      if (!(await signerReady())) {
        return {
          st: {
            marginSummary: { accountValue: '0' }, withdrawable: '0', crossMarginSummary: { accountValue: '0', totalNtlPos: '0' },
            crossMaintenanceMarginUsed: '0', assetPositions: [],
            venueNote: 'Aster trades through an API wallet that your wallet approves with one signature (perps only, no withdrawals). It is approved on your first Aster order, or with the button below. Aster then opens the account at the first USDT deposit (asterdex.com).',
          },
          orders: [], fills: [], fees: null,
        };
      }
      const [acct, risk] = await Promise.all([signed('GET', '/fapi/v3/account'), signed('GET', '/fapi/v3/positionRisk')]);
      const n = polls++;
      if (n === 0) { loadBrackets(); fees ??= signed('GET', '/fapi/v3/commissionRate', { symbol: 'BTCUSDT' }).then((r) => ({ taker: +r.takerCommissionRate, maker: +r.makerCommissionRate })).catch(() => null); }
      // every open order across symbols weighs 40 of the 2400/minute budget: every third poll, or after a change
      if (ordersDirty || n % 3 === 0) {
        ordersDirty = false;
        orders = (await signed('GET', '/fapi/v3/openOrders')).map((o) => {
          const trig = TRIGGERS.has(o.type);
          return {
            coin: o.symbol, oid: o.orderId, side: o.side === 'BUY' ? 'B' : 'A', sz: String(num(o.origQty) - num(o.executedQty)),
            limitPx: num(o.price) ? o.price : o.stopPrice, orderType: ORDER_TYPES[o.type] || o.type,
            reduceOnly: !!(o.reduceOnly || o.closePosition), isTrigger: trig, triggerPx: trig ? o.stopPrice : undefined,
            timestamp: +o.time || +o.updateTime, positionSide: o.positionSide, closePosition: !!o.closePosition,
          };
        });
      }
      const positions = (risk || []).filter((p) => num(p.positionAmt) !== 0);
      // fills need a symbol each: read the ones with positions, orders or recent activity
      if (n % 3 === 0) {
        const recent = await signed('GET', '/fapi/v3/allOrders', { limit: 50 }).catch(() => []);
        const syms = [...new Set([...positions.map((p) => p.symbol), ...touched,
          ...(recent || []).filter((o) => num(o.executedQty) > 0).sort((a, b) => b.updateTime - a.updateTime).map((o) => o.symbol)])].slice(0, 8);
        const lists = await Promise.all(syms.map((s) => signed('GET', '/fapi/v3/userTrades', { symbol: s, limit: 50 }).catch(() => [])));
        fills = lists.flat().map((t) => {
          const buy = t.side === 'BUY';
          // one-way mode doesn't say open or close: a fill that realised PnL closed something
          const closing = t.positionSide === 'LONG' ? !buy : t.positionSide === 'SHORT' ? buy : num(t.realizedPnl) !== 0;
          return {
            coin: t.symbol, oid: t.orderId, tid: t.id, side: buy ? 'B' : 'A', px: t.price, sz: t.qty, time: +t.time,
            dir: closing ? (buy ? 'Close Short' : 'Close Long') : (buy ? 'Open Long' : 'Open Short'),
            closedPnl: t.realizedPnl ?? '0', fee: t.commission ?? '0', feeToken: t.commissionAsset || 'USDT',
          };
        }).sort((a, b) => b.time - a.time).slice(0, 100);
      }
      let ntl = 0;
      const assetPositions = positions.map((p) => {
        const szi = num(p.positionAmt), value = Math.abs(num(p.notional)) || Math.abs(szi) * num(p.markPrice);
        const iso = String(p.marginType).toLowerCase() === 'isolated', lev = num(p.leverage) || 1;
        const margin = iso && num(p.isolatedMargin) ? num(p.isolatedMargin) : value / lev;
        const upnl = num(p.unRealizedProfit);
        if (!iso) ntl += value;
        return { position: {
          coin: p.symbol, szi: String(szi), entryPx: p.entryPrice, positionValue: String(value), unrealizedPnl: String(upnl),
          returnOnEquity: String(margin ? upnl / margin : 0), liquidationPx: num(p.liquidationPrice) ? p.liquidationPrice : null,
          marginUsed: String(margin), leverage: { type: iso ? 'isolated' : 'cross', value: lev }, positionSide: p.positionSide,
        } };
      });
      return {
        st: {
          marginSummary: { accountValue: String(num(acct.totalMarginBalance)) }, withdrawable: String(num(acct.maxWithdrawAmount ?? acct.availableBalance)),
          crossMarginSummary: { accountValue: String(num(acct.totalCrossWalletBalance) + num(acct.totalCrossUnPnl)), totalNtlPos: String(ntl) },
          crossMaintenanceMarginUsed: String(num(acct.totalMaintMargin)), assetPositions, venueNote: null,
        },
        orders, fills, fees: await fees,
      };
    } catch (e) {
      if (!noDeposit(e)) throw e;
      // the API wallet is approved, but Aster opens the account at the first deposit
      return {
        st: {
          marginSummary: { accountValue: '0' }, withdrawable: '0', crossMarginSummary: { accountValue: '0', totalNtlPos: '0' },
          crossMaintenanceMarginUsed: '0', assetPositions: [],
          venueNote: 'API wallet approved. Aster opens trading after the first deposit: deposit USDT to this wallet\'s Aster account (asterdex.com, from BNB Chain, Ethereum or Arbitrum).',
        },
        orders: [], fills: [], fees: null,
      };
    }
  }

  const sideFor = async (isBuy, reduceOnly) => ((await hedge()) ? { positionSide: (isBuy !== !!reduceOnly) ? 'LONG' : 'SHORT' } : reduceOnly ? { reduceOnly: 'true' } : {});
  const pxStep = (x, s, mode) => toStep(x, s.tick, mode);

  // a trigger that closes the whole position when the mark price crosses it
  async function placeTrigger(coin, kind, px, long) {
    const s = await spec(coin);
    const p = { symbol: coin, side: long ? 'SELL' : 'BUY', type: kind === 'tp' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET', stopPrice: pxStep(+px, s, 'round'), closePosition: 'true', workingType: 'MARK_PRICE' };
    if (await hedge()) p.positionSide = long ? 'LONG' : 'SHORT';
    ordersDirty = true;
    return signed('POST', '/fapi/v3/order', p);
  }

  async function order({ coin, isBuy, sz, type = 'market', px, slippage = 1, reduceOnly = false, tif = 'Gtc', tp, sl }) {
    const s = await spec(coin);
    const quantity = toStep(+sz, s.lot);
    if (!(+quantity > 0) || +quantity < s.minQty) throw new Error(`size rounds below Aster's minimum (${s.minQty} ${coin}, lot ${s.lot})`);
    const p = { symbol: coin, side: isBuy ? 'BUY' : 'SELL', ...(await sideFor(isBuy, reduceOnly)) };
    let price, timeInForce;
    if (type === 'market') {
      // an IOC limit at the far side of the book +- slippage: Aster's own MARKET
      // type would take anything up to the symbol's take bound (2% on BTC). The
      // price also has to stay inside the PERCENT_PRICE band around the mark.
      const [bt, pi] = await Promise.all([get(`/fapi/v3/ticker/bookTicker?symbol=${coin}`), get(`/fapi/v3/premiumIndex?symbol=${coin}`)]);
      const mark = num(pi.markPrice), slip = Math.max(0, +slippage || 0) / 100;
      if (isBuy) {
        const want = (num(bt.askPrice) || mark) * (1 + slip), cap = s.up && mark ? mark * s.up : Infinity;
        price = want > cap ? pxStep(cap, s, 'floor') : pxStep(want, s, 'ceil');
      } else {
        const want = (num(bt.bidPrice) || mark) * (1 - slip), cap = s.down && mark ? mark * s.down : 0;
        price = want < cap ? pxStep(cap, s, 'ceil') : pxStep(want, s, 'floor');
      }
      timeInForce = 'IOC';
    } else {
      if (!(+px > 0)) throw new Error('a limit order needs a price');
      price = pxStep(+px, s, 'round');
      timeInForce = TIF[tif] || 'GTC';
    }
    if (+quantity * +price < s.minNotional && !reduceOnly) throw new Error(`Aster's minimum order is ${s.minNotional} ${s.margin}`);
    touched.add(coin); ordersDirty = true;
    const res = await signed('POST', '/fapi/v3/order', { ...p, type: 'LIMIT', timeInForce, quantity, price, newOrderRespType: 'RESULT' });
    if (type === 'market' && !(num(res?.executedQty) > 0)) throw new Error(`nothing filled within ${slippage}% of the book (order ${res?.orderId ?? ''} ${res?.status || 'expired'})`);
    const done = [];
    const long = isBuy;
    if (!reduceOnly) {
      if (tp) done.push(await placeTrigger(coin, 'tp', tp, long).then(() => 'TP set', (e) => `TP failed: ${e.message}`));
      if (sl) done.push(await placeTrigger(coin, 'sl', sl, long).then(() => 'SL set', (e) => `SL failed: ${e.message}`));
    }
    const filled = num(res?.executedQty);
    const msg = filled ? `filled ${trim(res.executedQty)} @ ${trim(res.avgPrice)}` : `order ${res?.orderId ?? ''} placed`;
    return { ok: true, id: res?.orderId, msg: [msg, ...done].join(' · ') };
  }
  // Aster cancels triggers and plain orders the same way
  const cancel = (coin, oid) => { ordersDirty = true; return signed('DELETE', '/fapi/v3/order', { symbol: coin, orderId: oid }); };
  async function cancelAll() {
    // Aster cancels per symbol
    const open = await signed('GET', '/fapi/v3/openOrders');
    const syms = [...new Set((open || []).map((o) => o.symbol))];
    ordersDirty = true;
    await Promise.all(syms.map((sym) => signed('DELETE', '/fapi/v3/allOpenOrders', { symbol: sym })));
    return { ok: true, msg: syms.length ? `cancelled every order on ${syms.join(', ')}` : 'no open orders' };
  }
  async function setLeverage(coin, lev, cross) {
    await loadBrackets();
    const cap = maxLev.get(coin) || 125;
    await signed('POST', '/fapi/v3/marginType', { symbol: coin, marginType: cross ? 'CROSSED' : 'ISOLATED' }).catch((e) => { if (!ignorable(e)) throw e; });
    await signed('POST', '/fapi/v3/leverage', { symbol: coin, leverage: Math.max(1, Math.min(cap, Math.round(lev))) });
    return { ok: true, msg: `${coin} ${Math.round(lev)}x ${cross ? 'cross' : 'isolated'}` };
  }
  async function setTpsl(coin, { tp, sl, long }) {
    // replace the position's existing TP / SL of the kind being set
    const open = await signed('GET', '/fapi/v3/openOrders', { symbol: coin });
    const old = (open || []).filter((o) => (o.closePosition || o.reduceOnly) && ((tp && o.type === 'TAKE_PROFIT_MARKET') || (sl && o.type === 'STOP_MARKET')));
    await Promise.all(old.map((o) => cancel(coin, o.orderId).catch(() => {})));
    const done = [];
    if (tp) { await placeTrigger(coin, 'tp', tp, long); done.push(`TP ${tp}`); }
    if (sl) { await placeTrigger(coin, 'sl', sl, long); done.push(`SL ${sl}`); }
    return { ok: true, msg: `${coin} ${done.join(' · ')}` };
  }

  return {
    address, signer, state, order, cancel, cancelAll, setLeverage, setTpsl, pollMs: 3000,
    approveSigner, revokeSigner, ensureSigner, setupApiKey, agents, signed, signedRaw,
  };
}

export const aster = {
  id: 'aster', name: 'Aster', site: ASTER_SITE, collateral: 'USDT',
  key: {
    kind: 'evm', label: 'EVM private key (0x...)',
    help: 'Aster trades through an API wallet that your EVM wallet approves with one signature (on your first Aster order, perps only, no withdrawals). Deposit USDT at asterdex.com to open the account.',
  },
  markets, watchPrices, candles, subCandles, subBook, subTrades, connect,
};
