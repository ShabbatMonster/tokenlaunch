// Pacifica (pacifica.fi): a Solana perps exchange, and the venue for BP
// (Backpack's token). Orders are signed with the wallet's own ed25519 key, the
// same Solana key the launcher keeps in keys.v1.sol, so there is nothing to
// set up besides depositing USDC into Pacifica.
//
// Signing (as Pacifica's Python SDK, common/utils.py): the message is
//   { type, timestamp, expiry_window, data: <the request's own fields> }
// with every object's keys sorted, as compact JSON; ed25519 over its UTF-8
// bytes; the signature goes base58 in the body next to account / timestamp /
// expiry_window and the same fields unwrapped. GETs are unsigned. CORS is open.
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { toStep, stepDecimals } from './util.js';

export const PACIFICA_API = 'https://api.pacifica.fi/api/v1';
export const PACIFICA_WS = 'wss://ws.pacifica.fi/ws';
// the on-chain deposit (Pacifica's python-sdk rest/deposit.py)
export const PACIFICA_PROGRAM = 'PCFA5iYgmqK6MqPhWNKg7Yv7auX7VZ4Cx7T1eJyrAMH';
export const PACIFICA_CENTRAL_STATE = '9Gdmhq4Gv1LnNMp7aiS1HSVd7pNnXNMsbuXALCQRmGjY';
export const PACIFICA_VAULT = '72R843XwZxqWhsJceARQQTTbYtWy6Zw9et2YV4FpRHTa';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const MIN_DEPOSIT = 10;

const get = async (path) => {
  const r = await fetch(PACIFICA_API + path);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.success === false) throw new Error(j?.error || `Pacifica ${path}: HTTP ${r.status}`);
  return j.data ?? j;
};

export const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
/// the exact bytes Pacifica verifies
export const pacificaMessage = (type, timestamp, expiry, data) => JSON.stringify(sortKeys({ type, timestamp, expiry_window: expiry, data }));

const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

// last known prices, so positions can be valued between account polls
const lastPx = new Map();

// --- one shared websocket: book, candles ------------------------------------------
const ws = { sock: null, subs: new Map(), timer: 0, open: false };
const subKey = (p) => JSON.stringify(sortKeys(p));
function wsSend(o) { if (ws.open) ws.sock.send(JSON.stringify(o)); }
function wsConnect() {
  if (ws.sock) return;
  const s = new WebSocket(PACIFICA_WS);
  ws.sock = s;
  s.onopen = () => { ws.open = true; for (const { params } of ws.subs.values()) wsSend({ method: 'subscribe', params }); };
  s.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (!m?.channel || !m.data) return;
    for (const sub of ws.subs.values()) if (sub.match(m)) sub.cb(m.data);
  };
  s.onclose = () => {
    ws.sock = null; ws.open = false;
    if (ws.subs.size) setTimeout(wsConnect, 1500);
  };
  s.onerror = () => { try { s.close(); } catch { /* closing */ } };
  clearInterval(ws.timer);
  // the server drops a quiet connection after a minute
  ws.timer = setInterval(() => wsSend({ method: 'ping' }), 30000);
}
function wsSub(params, match, cb) {
  const k = subKey(params) + Math.random();
  ws.subs.set(k, { params, match, cb });
  wsConnect();
  wsSend({ method: 'subscribe', params });
  return () => {
    ws.subs.delete(k);
    if (![...ws.subs.values()].some((x) => subKey(x.params) === subKey(params))) wsSend({ method: 'unsubscribe', params });
  };
}

// --- markets ----------------------------------------------------------------------
function applyPrice(m, p) {
  m.mid = +p.mid || +p.mark; m.mark = +p.mark; m.oracle = +p.oracle;
  m.funding = +p.funding;                        // Pacifica funds every hour
  m.oi = +p.open_interest; m.volume = +p.volume_24h;
  m.change = +p.yesterday_price ? (m.mid / +p.yesterday_price - 1) * 100 : 0;
  lastPx.set(m.coin, { mark: m.mark, mid: m.mid });
}
async function markets() {
  const [info, prices] = await Promise.all([get('/info'), get('/info/prices')]);
  const byCoin = new Map(prices.map((p) => [p.symbol, p]));
  return info.filter((x) => (x.instrument_type || 'perpetual') === 'perpetual').map((x) => {
    const m = {
      coin: x.symbol, label: x.symbol, dex: '', dexName: 'Pacifica', asset: null, venue: 'pacifica',
      tick: x.tick_size, lot: x.lot_size, szDecimals: stepDecimals(x.lot_size), pxDecimals: stepDecimals(x.tick_size),
      minNotional: +x.min_order_size || 10, maxLeverage: +x.max_leverage || 1, onlyIsolated: !!x.isolated_only,
      collateral: 'USDC', delisted: false, mid: 0, mark: 0, oracle: 0, change: 0, funding: +x.funding_rate || 0, oi: 0, volume: 0,
    };
    const p = byCoin.get(x.symbol); if (p) applyPrice(m, p);
    return m;
  });
}
function watchPrices(list, onUpdate) {
  const by = new Map(list.map((m) => [m.coin, m]));
  let stop = false;
  const tick = async () => {
    if (stop) return;
    try { for (const p of await get('/info/prices')) { const m = by.get(p.symbol); if (m) applyPrice(m, p); } onUpdate(); } catch { /* next time */ }
    if (!stop) setTimeout(tick, document.hidden ? 5000 : 1500);
  };
  setTimeout(tick, 1500);
  return () => { stop = true; };
}

// --- chart ------------------------------------------------------------------------
const toK = (c) => ({ t: +c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v });
async function candles(coin, interval, start, end) {
  const out = await get(`/kline?symbol=${encodeURIComponent(coin)}&interval=${interval}&start_time=${Math.floor(start)}&end_time=${Math.floor(end)}`);
  return (out || []).map(toK).sort((a, b) => a.t - b.t);
}
function subCandles(coin, interval, cb) {
  return wsSub({ source: 'candle', symbol: coin, interval }, (m) => m.channel === 'candle' && m.data.s === coin && m.data.i === interval, (d) => cb(toK(d)));
}
function subBook(coin, cb) {
  const conv = (side) => side.map((l) => ({ px: l.p, sz: l.a, n: l.n }));
  // a REST read paints at once; the stream then updates every 250 ms
  get(`/book?symbol=${encodeURIComponent(coin)}`).then((b) => cb({ levels: [conv(b.l[0]), conv(b.l[1])] })).catch(() => {});
  return wsSub({ source: 'book', symbol: coin, agg_level: 1 }, (m) => m.channel === 'book' && m.data.s === coin, (d) => cb({ levels: [conv(d.l[0]), conv(d.l[1])] }));
}
function subTrades(coin, cb) {
  let stop = false, seen = 0;
  const tick = async () => {
    if (stop) return;
    try {
      // each fill is listed twice (maker and taker); the taker's side is the aggressor
      const ts = (await get(`/trades?symbol=${encodeURIComponent(coin)}`)).filter((t) => t.event_type === 'fulfill_taker' && t.created_at > seen);
      if (ts.length) {
        seen = Math.max(...ts.map((t) => t.created_at));
        cb(ts.map((t) => ({ px: t.price, sz: t.amount, side: /open_long|close_short/.test(t.side) ? 'B' : 'A', time: t.created_at })).reverse());
      }
    } catch { /* next time */ }
    if (!stop) setTimeout(tick, document.hidden ? 6000 : 2000);
  };
  tick();
  return () => { stop = true; };
}

// --- account ----------------------------------------------------------------------
const ORDER_TYPES = { limit: 'Limit', market: 'Market', stop_limit: 'Stop Limit', stop_market: 'Stop Market', take_profit_limit: 'Take Profit Limit', stop_loss_limit: 'Stop Loss Limit', take_profit_market: 'Take Profit Market', stop_loss_market: 'Stop Loss Market' };
const DIRS = { open_long: 'Open Long', open_short: 'Open Short', close_long: 'Close Long', close_short: 'Close Short' };

/// Solana secret key (base58, 64 bytes) -> its address. Throws if it isn't one.
export function pacificaAddress(secretB58) {
  const sk = bs58.decode(String(secretB58 || '').trim());
  if (sk.length !== 64) throw new Error('Pacifica signs with a Solana key: 64 bytes, base58');
  const pub = ed25519.getPublicKey(sk.slice(0, 32));
  if (bs58.encode(pub) !== bs58.encode(sk.slice(32))) throw new Error('that Solana key does not match its own address');
  return bs58.encode(pub);
}

function connect(secretB58) {
  const address = pacificaAddress(secretB58);
  const seed = bs58.decode(String(secretB58).trim()).slice(0, 32);
  let mkts = null;
  const mkt = async (coin) => { mkts ??= new Map((await get('/info')).map((x) => [x.symbol, x])); return mkts.get(coin); };

  async function post(path, type, data) {
    const timestamp = Date.now(), expiry = 30000;
    const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(pacificaMessage(type, timestamp, expiry, data)), seed));
    const r = await fetch(PACIFICA_API + path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: address, signature: sig, timestamp, expiry_window: expiry, ...data }),
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { /* plain text error */ }
    if (!r.ok || j?.success === false || j?.error) throw new Error(j?.error || text || `HTTP ${r.status}`);
    return j?.data ?? j;
  }

  let polls = 0, fills = [];
  async function state() {
    const [acct, positions, orders, settings] = await Promise.all([
      get(`/account?account=${address}`).catch((e) => { if (/not found|does not exist/i.test(e.message)) return null; throw e; }),
      get(`/positions?account=${address}`).catch(() => []),
      get(`/orders?account=${address}`).catch(() => []),
      get(`/account/settings?account=${address}`).catch(() => ({})),
    ]);
    // trade history is heavier: every third poll
    if (polls++ % 3 === 0) {
      const h = await get(`/trades/history?account=${address}&limit=100`).catch(() => null);
      if (h) {
        fills = h.map((t) => ({
          coin: t.symbol, oid: t.order_id, side: /open_long|close_short/.test(t.side) ? 'B' : 'A', px: t.price, sz: t.amount, time: t.created_at,
          dir: DIRS[t.side] || t.side, closedPnl: t.pnl ?? '0', fee: t.fee ?? '0', feeToken: 'USDC', liquidation: /liquidation/.test(t.cause || ''),
        })).sort((a, b) => b.time - a.time);
      }
    }
    const levs = new Map((settings?.margin_settings || []).map((s) => [s.symbol, s]));
    let ntl = 0;
    const assetPositions = [];
    for (const p of positions || []) {
      const szi = (p.side === 'bid' ? 1 : -1) * +p.amount;
      const mark = lastPx.get(p.symbol)?.mark || +p.entry_price;
      const set = levs.get(p.symbol);
      const info = await mkt(p.symbol);
      const lev = +set?.leverage || +info?.max_leverage || 1;
      const value = Math.abs(szi) * mark;
      const upnl = szi * (mark - +p.entry_price);
      const margin = p.isolated && +p.margin ? +p.margin : value / lev;
      ntl += value;
      assetPositions.push({ position: {
        coin: p.symbol, szi: String(szi), entryPx: p.entry_price, positionValue: String(value), unrealizedPnl: String(upnl),
        returnOnEquity: String(margin ? upnl / margin : 0), liquidationPx: p.liquidation_price, marginUsed: String(margin),
        leverage: { type: p.isolated ? 'isolated' : 'cross', value: lev }, cumFunding: { sinceOpen: p.funding },
      } });
    }
    const eq = acct ? +acct.account_equity : 0;
    return {
      st: {
        marginSummary: { accountValue: String(eq) }, withdrawable: String(acct ? +acct.available_to_spend : 0),
        crossMarginSummary: { accountValue: String(acct ? +(acct.cross_account_equity ?? acct.account_equity) : 0), totalNtlPos: String(ntl) },
        crossMaintenanceMarginUsed: String(acct ? +acct.cross_mmr || 0 : 0), assetPositions,
        venueNote: acct ? null : 'no Pacifica account yet: deposit USDC to open one',
      },
      orders: (orders || []).map((o) => ({
        coin: o.symbol, oid: o.order_id, side: o.side === 'bid' ? 'B' : 'A',
        sz: String(+o.initial_amount - +o.filled_amount - +o.cancelled_amount), limitPx: o.price ?? o.stop_price,
        orderType: ORDER_TYPES[o.order_type] || o.order_type, reduceOnly: !!o.reduce_only,
        isTrigger: o.stop_price != null, triggerPx: o.stop_price, timestamp: o.created_at,
      })),
      fills,
      fees: acct ? { taker: +acct.taker_fee, maker: +acct.maker_fee } : null,
    };
  }

  async function order({ coin, isBuy, sz, type = 'market', px, slippage = 1, reduceOnly = false, tif = 'GTC', tp, sl }) {
    const info = await mkt(coin);
    if (!info) throw new Error(`Pacifica has no ${coin} market`);
    const amount = toStep(+sz, info.lot_size);
    if (!(+amount > 0)) throw new Error(`size rounds to zero (lot ${info.lot_size} ${coin})`);
    const data = { symbol: coin, amount, side: isBuy ? 'bid' : 'ask', reduce_only: !!reduceOnly, client_order_id: uuid() };
    if (tp) data.take_profit = { stop_price: toStep(+tp, info.tick_size, 'round') };
    if (sl) data.stop_loss = { stop_price: toStep(+sl, info.tick_size, 'round') };
    let res;
    if (type === 'market') res = await post('/orders/create_market', 'create_market_order', { ...data, slippage_percent: String(slippage) });
    else res = await post('/orders/create', 'create_order', { ...data, price: toStep(+px, info.tick_size, 'round'), tif: tif === 'Alo' ? 'ALO' : tif === 'Ioc' ? 'IOC' : 'GTC' });
    return { ok: true, id: res?.order_id, msg: `order ${res?.order_id ?? ''} placed` };
  }
  const cancel = (coin, oid, isTrigger = false) => (isTrigger
    ? post('/orders/stop/cancel', 'cancel_stop_order', { symbol: coin, order_id: +oid })
    : post('/orders/cancel', 'cancel_order', { symbol: coin, order_id: +oid }));
  const cancelAll = () => post('/orders/cancel_all', 'cancel_all_orders', { all_symbols: true, exclude_reduce_only: false });
  async function setLeverage(coin, lev, cross) {
    const info = await mkt(coin);
    const settings = await get(`/account/settings?account=${address}`).catch(() => ({}));
    const cur = (settings?.margin_settings || []).find((s) => s.symbol === coin);
    const wantIso = !cross || !!info?.isolated_only;
    if (cur ? !!cur.isolated !== wantIso : wantIso) await post('/account/margin', 'update_margin_mode', { symbol: coin, is_isolated: wantIso });
    if (!cur || +cur.leverage !== lev) await post('/account/leverage', 'update_leverage', { symbol: coin, leverage: Math.round(lev) });
  }
  async function setTpsl(coin, { tp, sl, long }) {
    const info = await mkt(coin);
    const data = { symbol: coin, side: long ? 'ask' : 'bid' };
    if (tp) data.take_profit = { stop_price: toStep(+tp, info.tick_size, 'round'), client_order_id: uuid() };
    if (sl) data.stop_loss = { stop_price: toStep(+sl, info.tick_size, 'round'), client_order_id: uuid() };
    return post('/positions/tpsl', 'set_position_tpsl', data);
  }

  /// USDC from this wallet into Pacifica: an on-chain Solana transaction to
  /// Pacifica's program (instruction `deposit`, amount in 6-decimal units).
  async function deposit(amount, rpcUrl) {
    if (!(amount >= MIN_DEPOSIT)) throw new Error(`Pacifica's minimum deposit is ${MIN_DEPOSIT} USDC`);
    const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } = await import('@solana/web3.js');
    const kp = Keypair.fromSecretKey(bs58.decode(String(secretB58).trim()));
    const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const prog = new PublicKey(PACIFICA_PROGRAM), mint = new PublicKey(USDC_MINT);
    const userAta = PublicKey.findProgramAddressSync([kp.publicKey.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
    const [eventAuth] = PublicKey.findProgramAddressSync([new TextEncoder().encode('__event_authority')], prog);
    const disc = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('global:deposit'))).slice(0, 8);
    const data = new Uint8Array(16); data.set(disc, 0);
    new DataView(data.buffer).setBigUint64(8, BigInt(Math.round(amount * 1e6)), true);
    const key = (pubkey, w = false, s = false) => ({ pubkey, isWritable: w, isSigner: s });
    const ix = new TransactionInstruction({ programId: prog, data: Buffer.from(data), keys: [
      key(kp.publicKey, true, true), key(userAta, true), key(new PublicKey(PACIFICA_CENTRAL_STATE), true), key(new PublicKey(PACIFICA_VAULT), true),
      key(TOKEN), key(ATA), key(mint), key(SystemProgram.programId), key(eventAuth), key(prog),
    ] });
    const conn = new Connection(rpcUrl, 'confirmed');
    const tx = new Transaction().add(ix);
    tx.feePayer = kp.publicKey;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    const sim = await conn.simulateTransaction(tx, [kp]);
    if (sim.value.err) throw new Error('deposit would fail: ' + ((sim.value.logs || []).find((l) => /Error|insufficient/i.test(l)) || JSON.stringify(sim.value.err)));
    tx.sign(kp);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
  }

  return { address, state, order, cancel, cancelAll, setLeverage, setTpsl, deposit, pollMs: 3000, post };
}

export const pacifica = {
  id: 'pacifica', name: 'Pacifica', site: 'https://app.pacifica.fi', collateral: 'USDC', defaultCoin: 'BP',
  fees: { taker: 0.0004, maker: 0.00015 },   // the base tier, until the account's own rates load
  key: { kind: 'sol', label: 'Solana private key (base58)', help: 'Pacifica signs with your Solana wallet. Deposit USDC (10 minimum) to open an account.' },
  markets, watchPrices, candles, subCandles, subBook, subTrades, connect,
};
