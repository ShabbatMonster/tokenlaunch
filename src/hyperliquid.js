// Hyperliquid perps: every market on the main exchange and on every HIP-3
// builder exchange (XYZ's stocks, Felix, Ventuals, Kinetiq, ...), and the
// order maths. Signing and transport are @nktkas/hyperliquid's; this file only
// decides what to send. Used by the perps page (src/perps.js) and the tests.
//
// Asset ids: a main-exchange perp is its index in `meta.universe`; a perp on
// the HIP-3 exchange listed k-th by perpDexs (k >= 1) is
// 100000 + k * 10000 + index. Coin names on those carry the exchange prefix
// ("xyz:NVDA").
//
// A market order is what Hyperliquid's own app sends: an IOC limit order priced
// a slippage band past the mid, which fills against the book at the best prices
// available and cancels whatever it could not fill.
import { HttpTransport, WebSocketTransport, InfoClient, ExchangeClient, SubscriptionClient } from '@nktkas/hyperliquid';
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';

export { formatPrice, formatSize };

export function hlClients({ wallet = null, ws = true } = {}) {
  const http = new HttpTransport();
  const info = new InfoClient({ transport: http });
  const exchange = wallet ? new ExchangeClient({ transport: http, wallet }) : null;
  const subs = ws ? new SubscriptionClient({ transport: new WebSocketTransport() }) : null;
  return { info, exchange, subs };
}

export const assetId = (dexIndex, index) => (dexIndex === 0 ? index : 100000 + dexIndex * 10000 + index);

/// Every perp market, live: [{ coin, label, dex, dexName, asset, szDecimals,
/// maxLeverage, onlyIsolated, delisted, collateral, mark, mid, prevDay,
/// change, funding, oi, volume }], busiest first.
export async function hlMarkets(info) {
  const [dexs, spot] = await Promise.all([info.perpDexs(), info.spotMeta().catch(() => null)]);
  const tokenName = (i) => spot?.tokens?.find((t) => t.index === i)?.name ?? (i === 0 ? 'USDC' : `token ${i}`);
  const list = await Promise.all(dexs.map(async (d, k) => {
    const name = d?.name ?? '';
    const [meta, ctxs] = await info.metaAndAssetCtxs(name ? { dex: name } : undefined);
    return meta.universe.map((u, i) => ({
      ...marketFromCtx(u, ctxs[i]),
      dex: name, dexName: k === 0 ? 'Hyperliquid' : (d.fullName || name), dexIndex: k,
      asset: assetId(k, i), collateral: tokenName(meta.collateralToken ?? 0),
    }));
  }));
  return list.flat().sort((a, b) => b.volume - a.volume);
}

function marketFromCtx(u, c = {}) {
  const num = (x) => (x == null ? null : Number(x));
  const mark = num(c.markPx), prevDay = num(c.prevDayPx);
  return {
    coin: u.name, label: u.name.includes(':') ? u.name.split(':')[1] : u.name,
    szDecimals: u.szDecimals, maxLeverage: u.maxLeverage,
    onlyIsolated: !!u.onlyIsolated, delisted: !!u.isDelisted,
    mark, mid: num(c.midPx) ?? mark, prevDay,
    change: mark && prevDay ? (mark / prevDay - 1) * 100 : 0,
    funding: num(c.funding) ?? 0, oi: num(c.openInterest) ?? 0, volume: num(c.dayNtlVlm) ?? 0,
  };
}

/// Fold a live allDexsAssetCtxs event into the market list (prices, funding, volume).
export function applyCtxs(markets, event) {
  const byDex = new Map(event.ctxs);
  const idx = new Map();
  for (const m of markets) {
    const ctxs = byDex.get(m.dex);
    if (!ctxs) continue;
    const i = m.asset - (m.dexIndex === 0 ? 0 : 100000 + m.dexIndex * 10000);
    const c = ctxs[i];
    if (!c) continue;
    const mark = Number(c.markPx), prevDay = Number(c.prevDayPx);
    m.mark = mark; m.mid = c.midPx == null ? mark : Number(c.midPx); m.prevDay = prevDay;
    m.change = mark && prevDay ? (mark / prevDay - 1) * 100 : 0;
    m.funding = Number(c.funding ?? 0); m.oi = Number(c.openInterest ?? 0); m.volume = Number(c.dayNtlVlm ?? 0);
    idx.set(m.coin, m);
  }
  return idx;
}

/// Size in coins for a USD amount at a price, rounded down to the market's lot.
export function sizeForUsd(usd, price, szDecimals) {
  if (!(usd > 0) || !(price > 0)) throw new Error('enter an amount');
  const f = 10 ** szDecimals;
  const sz = Math.floor((usd / price) * f) / f;
  if (!(sz > 0)) throw new Error(`that is less than the smallest size this market takes (${1 / f})`);
  return sz;
}

/// The IOC price for a market order: the mid pushed `slippagePct` against us,
/// then cut to the market's tick rules.
export function marketPrice(mid, isBuy, slippagePct, szDecimals) {
  if (!(mid > 0)) throw new Error('no price for this market right now');
  const px = mid * (isBuy ? 1 + slippagePct / 100 : 1 - slippagePct / 100);
  return formatPrice(px.toPrecision(12), szDecimals);
}

/// The orders for one ticket: the entry (market or limit), plus optional
/// take-profit / stop-loss as reduce-only trigger-market orders on the same
/// size. Returns what `exchange.order` takes.
export function buildOrders({ market, isBuy, size, type = 'market', limitPx, slippagePct = 1, reduceOnly = false, tp, sl }) {
  const sz = formatSize(String(size), market.szDecimals);
  const value = Number(sz) * (type === 'limit' ? Number(limitPx) : market.mid);
  if (!reduceOnly && value < MIN_ORDER_USD) {
    throw new Error(`that order is worth $${value.toFixed(2)}, and Hyperliquid refuses orders under $${MIN_ORDER_USD}`);
  }
  const entry = type === 'limit'
    ? { a: market.asset, b: isBuy, p: formatPrice(String(limitPx), market.szDecimals), s: sz, r: reduceOnly, t: { limit: { tif: 'Gtc' } } }
    : { a: market.asset, b: isBuy, p: marketPrice(market.mid, isBuy, slippagePct, market.szDecimals), s: sz, r: reduceOnly, t: { limit: { tif: 'Ioc' } } };
  const orders = [entry];
  const ref = type === 'limit' ? Number(limitPx) : market.mid;
  const trigger = (px, kind) => {
    const p = Number(px);
    if (!(p > 0)) return;
    // a TP sits on the profitable side of entry, an SL on the losing side
    const wrongSide = kind === 'tp' ? (isBuy ? p <= ref : p >= ref) : (isBuy ? p >= ref : p <= ref);
    if (wrongSide) throw new Error(`the ${kind === 'tp' ? 'take-profit' : 'stop-loss'} must be ${(kind === 'tp') === isBuy ? 'above' : 'below'} the entry for a ${isBuy ? 'long' : 'short'}`);
    orders.push({
      a: market.asset, b: !isBuy,
      // the worst price it may fill at once triggered: 10% past the trigger
      p: formatPrice((p * (isBuy ? 0.9 : 1.1)).toPrecision(12), market.szDecimals),
      s: sz, r: true,
      t: { trigger: { isMarket: true, triggerPx: formatPrice(String(p), market.szDecimals), tpsl: kind } },
    });
  };
  if (!reduceOnly) { trigger(tp, 'tp'); trigger(sl, 'sl'); }
  return { orders, grouping: orders.length > 1 ? 'normalTpsl' : 'na' };
}

/// Closing a position: reduce-only market order for its whole size.
export function closeOrder(market, szi, slippagePct = 1) {
  const n = Number(szi);
  if (!n) throw new Error('no position to close');
  const isBuy = n < 0;
  return {
    orders: [{
      a: market.asset, b: isBuy, p: marketPrice(market.mid, isBuy, slippagePct, market.szDecimals),
      s: formatSize(String(Math.abs(n)), market.szDecimals), r: true, t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  };
}

/// What an order response says, in words: filled / resting / the error.
export function orderOutcome(res) {
  const statuses = res?.response?.data?.statuses || [];
  return statuses.map((s) => {
    if (s.filled) return { ok: true, text: `filled ${s.filled.totalSz} @ ${s.filled.avgPx}` };
    if (s.resting) return { ok: true, text: `resting (order ${s.resting.oid})` };
    if (s.error) return { ok: false, text: s.error };
    if (s === 'waitingForTrigger' || s === 'waitingForFill') return { ok: true, text: s === 'waitingForTrigger' ? 'TP/SL armed' : 'waiting for fill' };
    return { ok: true, text: typeof s === 'string' ? s : JSON.stringify(s) };
  });
}

/// The reason inside whatever the SDK threw, as text. An order refusal comes
/// back as { response: { type: 'order', data: { statuses: [...] } } } - an
/// object, which is what used to show up as "[object Object]".
export function hlError(e) {
  const r = e?.response;
  let m;
  if (typeof r?.response === 'string') m = r.response;
  else if (Array.isArray(r?.response?.data?.statuses)) m = orderOutcome(r).filter((o) => !o.ok).map((o) => o.text).join('; ');
  else if (typeof r?.response?.data?.status?.error === 'string') m = r.response.data.status.error;
  if (!m) m = typeof e?.message === 'string' ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
  return explain(String(m).replace(/^Cannot process API request: /, ''));
}

/// Hyperliquid's terser refusals, with what to do about them.
function explain(m) {
  if (/minimum value of \$10/i.test(m)) return m + ' Hyperliquid refuses orders under $10 - raise the size.';
  if (/insufficient margin/i.test(m)) return m + ' Not enough free margin for this size at this leverage - lower the size, raise the leverage, or deposit.';
  if (/does not exist/i.test(m) && /User or API Wallet/i.test(m)) return m + ' This wallet has never deposited to Hyperliquid - deposit USDC at app.hyperliquid.xyz first.';
  if (/Must deposit before performing actions/i.test(m)) return m + ' Deposit USDC at app.hyperliquid.xyz first.';
  if (/could not immediately match/i.test(m)) return m + ' Nothing in the book within your slippage - raise the slippage or use a limit order.';
  if (/reduce only order would increase position/i.test(m)) return m + ' There is no position on that side to reduce.';
  return m;
}

/// Hyperliquid's floor for an order's value (it refuses anything smaller,
/// except reduce-only orders that close what is left of a position).
export const MIN_ORDER_USD = 10;

/// The order book shown on the page, merged from three streams:
///  - `deep`: 20 levels a side, fetched every 2 s (an info l2Book request),
///  - `fast`: 5 levels a side, every 0.5 s (l2Book with fast: true),
///  - `bbo`:  best bid / ask, pushed the moment either changes.
/// Each side takes the freshest source near the top and the deep snapshot
/// below it, so the levels people actually trade at are never seconds old.
export function mergeBook({ deep, fast, bbo }) {
  const side = (i) => {
    const isBid = i === 0;
    const worse = (a, b) => (isBid ? a < b : a > b);      // a is further from the mid than b
    let top = (fast?.[i] || []).map((l) => ({ px: +l.px, sz: +l.sz }));
    const best = bbo?.[i];
    if (best) {
      const bpx = +best.px;
      top = top.filter((l) => !worse(bpx, l.px) || l.px === bpx);   // drop levels the BBO says are gone
      if (top[0]?.px === bpx) top[0] = { px: bpx, sz: +best.sz };
      else top.unshift({ px: bpx, sz: +best.sz });
    }
    const edge = top.length ? top[top.length - 1].px : null;
    const rest = (deep?.[i] || []).map((l) => ({ px: +l.px, sz: +l.sz }))
      .filter((l) => (edge == null ? !best || !worse(+best.px, l.px) : worse(l.px, edge)));
    return [...top, ...rest];
  };
  return [side(0), side(1)];
}

/// Reduce-only market order for part of a position (fraction 0-1].
export function partialCloseOrder(market, szi, fraction, slippagePct = 1) {
  const n = Math.abs(Number(szi)) * fraction;
  const f = 10 ** market.szDecimals;
  const sz = fraction >= 1 ? Math.abs(Number(szi)) : Math.floor(n * f) / f;
  if (!(sz > 0)) throw new Error('that is less than one lot of this market');
  return closeOrder(market, Number(szi) < 0 ? -sz : sz, slippagePct);
}

/// Take-profit and/or stop-loss on a position already open: reduce-only
/// trigger-market orders for its size, grouped as positionTpsl so they follow
/// the position (Hyperliquid resizes / cancels them with it).
export function positionTpslOrders(market, szi, { tp, sl } = {}) {
  const n = Number(szi);
  if (!n) throw new Error('no position');
  const isLong = n > 0;
  const sz = formatSize(String(Math.abs(n)), market.szDecimals);
  const orders = [];
  for (const [px, kind] of [[tp, 'tp'], [sl, 'sl']]) {
    const p = Number(px);
    if (!(p > 0)) continue;
    const wrong = kind === 'tp' ? (isLong ? p <= market.mark : p >= market.mark) : (isLong ? p >= market.mark : p <= market.mark);
    if (wrong) throw new Error(`the ${kind === 'tp' ? 'take-profit' : 'stop-loss'} must be ${(kind === 'tp') === isLong ? 'above' : 'below'} the mark price (${market.mark}) for a ${isLong ? 'long' : 'short'}`);
    orders.push({
      a: market.asset, b: !isLong,
      p: formatPrice((p * (isLong ? 0.9 : 1.1)).toPrecision(12), market.szDecimals),
      s: sz, r: true,
      t: { trigger: { isMarket: true, triggerPx: formatPrice(String(p), market.szDecimals), tpsl: kind } },
    });
  }
  if (!orders.length) throw new Error('enter a take-profit or a stop-loss price');
  return { orders, grouping: 'positionTpsl' };
}
