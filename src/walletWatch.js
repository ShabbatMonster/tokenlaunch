// Watched wallets for the perps page: turn a wallet's fills into feed events
// ("opened LONG 2.5 BTC @ 65,120") and its positions into one list. Pure
// logic only - the page (src/perps.js) owns the sockets, polling and DOM - so
// it can be tested in node (test/js/wallet-watch.test.mjs).
//
// Hyperliquid wallets stream: a userFills subscription per wallet (fills
// come aggregated by time, so one order's partial fills arrive together) and
// allDexsClearinghouseState for positions on every Hyperliquid exchange.
// Pacifica wallets are polled: its trade history is public by account.

export const isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim());
export const isSol = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || '').trim());
/// which venue an address belongs to: 0x… is Hyperliquid, base58 is Pacifica
export const venueForAddress = (a) => (isEvm(a) ? 'hl' : isSol(a) ? 'pacifica' : null);
export const shortAddr = (a) => (a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-4) : a);

/// Fills -> one event per order (an order filled in pieces is one move).
/// Fills: { coin, px, sz, side 'B'|'A', time, dir, closedPnl, oid, startPosition?, hash? }
export function groupFills(fills, { addr = '', venue = 'hl' } = {}) {
  const by = new Map();
  for (const f of fills) {
    const k = `${f.coin}|${f.oid ?? f.hash ?? f.time}|${f.dir || f.side}`;
    const g = by.get(k) || { addr, venue, coin: f.coin, dir: f.dir || (f.side === 'B' ? 'Buy' : 'Sell'), side: f.side, sz: 0, ntl: 0, closedPnl: 0, time: 0, startPosition: null, oid: f.oid };
    const sz = Math.abs(+f.sz), px = +f.px;
    g.sz += sz; g.ntl += sz * px; g.closedPnl += +f.closedPnl || 0;
    g.time = Math.max(g.time, +f.time);
    // the position before the first piece of this order
    if (f.startPosition != null && (g.startPosition == null || +f.time <= g.firstTime)) { g.startPosition = +f.startPosition; g.firstTime = +f.time; }
    g.firstTime ??= +f.time;
    by.set(k, g);
  }
  return [...by.values()].map((g) => {
    const px = g.sz ? g.ntl / g.sz : 0;
    const signed = g.side === 'B' ? g.sz : -g.sz;
    const after = g.startPosition == null ? null : g.startPosition + signed;
    return { ...g, px, after, id: `${venue}|${addr}|${g.coin}|${g.oid ?? g.time}|${g.dir}`, kind: kindOf(g.dir, g.startPosition, after) };
  }).sort((a, b) => b.time - a.time);
}

/// open / add / reduce / close / flip, from the fill's direction text and the sizes
export function kindOf(dir, before, after) {
  const d = String(dir || '').toLowerCase();
  if (/>/.test(d) || (before != null && after != null && Math.sign(before) && Math.sign(after) && Math.sign(before) !== Math.sign(after))) return 'flip';
  if (/liquidat/.test(d)) return 'liquidated';
  if (/^close|close /.test(d)) return after != null && Math.abs(after) > 1e-12 ? 'reduce' : 'close';
  if (/^open|open /.test(d)) return before != null && Math.abs(before) > 1e-12 ? 'add' : 'open';
  return d.includes('buy') ? 'buy' : d.includes('sell') ? 'sell' : 'trade';
}

const VERB = { open: 'opened', add: 'added to', reduce: 'cut', close: 'closed', flip: 'flipped', liquidated: 'was liquidated on', buy: 'bought', sell: 'sold', trade: 'traded' };
/// the side a move is about: the position it opened, added to, cut or closed
export function sideOf(e) {
  const d = String(e.dir || '').toLowerCase();
  if (e.kind === 'flip') return e.after > 0 ? 'LONG' : 'SHORT';
  if (/long/.test(d)) return 'LONG';
  if (/short/.test(d)) return 'SHORT';
  return e.side === 'B' ? 'LONG' : 'SHORT';
}
/// "opened LONG 2.5 BTC @ 65,120"  (the page adds who, value and PnL)
export function describe(e, { label = (c) => c, fmt = (n) => String(n), size = (n) => String(+n.toFixed(6)) } = {}) {
  const verb = VERB[e.kind] || 'traded';
  return `${verb} ${sideOf(e)} ${size(e.sz)} ${label(e.coin)} @ ${fmt(e.px)}`;
}

/// Pacifica's public trade history rows -> fills in Hyperliquid's shape
export function pacificaFills(rows) {
  const DIR = { open_long: 'Open Long', open_short: 'Open Short', close_long: 'Close Long', close_short: 'Close Short' };
  return (rows || []).map((t) => ({
    coin: t.symbol, px: t.price, sz: t.amount, time: t.created_at, oid: t.order_id,
    side: /open_long|close_short/.test(t.side) ? 'B' : 'A',
    dir: /liquidation/.test(t.cause || '') ? 'Liquidated ' + (DIR[t.side] || t.side) : DIR[t.side] || t.side,
    closedPnl: t.pnl ?? '0', hid: t.history_id,
  }));
}
/// Pacifica's public positions -> Hyperliquid-shaped positions (marks from `markOf`)
export function pacificaPositions(rows, markOf = () => null) {
  return (rows || []).map((p) => {
    const szi = (p.side === 'bid' ? 1 : -1) * +p.amount;
    const mark = markOf(p.symbol) || +p.entry_price;
    return { coin: p.symbol, szi, entryPx: +p.entry_price, positionValue: Math.abs(szi) * mark, unrealizedPnl: szi * (mark - +p.entry_price), liquidationPx: p.liquidation_price == null ? null : +p.liquidation_price, lev: null };
  });
}
