// Watched wallets (src/walletWatch.js): fills -> feed events, the kind of each
// move, its wording, and Pacifica's public rows in Hyperliquid's shape.
//   node test/js/wallet-watch.test.mjs
import { groupFills, kindOf, describe, sideOf, venueForAddress, pacificaFills, pacificaPositions } from '../../src/walletWatch.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

check(venueForAddress('0x' + 'a'.repeat(40)) === 'hl' && venueForAddress('GZo6AR2ax279XSpPejp9TufZx6Sn5g4ZoV6XjRvQLo58') === 'pacifica' && venueForAddress('hello') === null && venueForAddress('0x123') === null,
  'addresses: 0x… is Hyperliquid, base58 is Pacifica, junk is neither');

{
  // one order filled in two pieces, from flat
  const ev = groupFills([
    { coin: 'BTC', px: '65000', sz: '1', side: 'B', time: 2, dir: 'Open Long', closedPnl: '0', oid: 7, startPosition: '0.5' },
    { coin: 'BTC', px: '64000', sz: '1', side: 'B', time: 1, dir: 'Open Long', closedPnl: '0', oid: 7, startPosition: '0' },
  ], { addr: '0xabc' });
  const e = ev[0];
  check(ev.length === 1 && e.sz === 2 && near(e.px, 64500) && e.ntl === 129000 && e.time === 2, 'an order filled in pieces is one move, at its average price', `${e.sz} @ ${e.px}`);
  check(e.startPosition === 0 && e.after === 2 && e.kind === 'open', 'from flat, sized by the first piece: an open, now long 2');
  check(describe(e) === 'opened LONG 2 BTC @ 64500', 'wording', describe(e));
}
{
  const ev = groupFills([
    { coin: 'ETH', px: '2000', sz: '3', side: 'A', time: 5, dir: 'Close Long', closedPnl: '150', oid: 1, startPosition: '3' },
    { coin: 'ETH', px: '2010', sz: '1', side: 'A', time: 6, dir: 'Close Long', closedPnl: '40', oid: 2, startPosition: '5' },
  ]);
  const close = ev.find((e) => e.oid === 1), cut = ev.find((e) => e.oid === 2);
  check(close.kind === 'close' && close.after === 0 && close.closedPnl === 150 && sideOf(close) === 'LONG', 'selling the whole long: closed, PnL carried');
  check(cut.kind === 'reduce' && cut.after === 4 && describe(cut) === 'cut LONG 1 ETH @ 2010', 'selling part of it: cut', describe(cut));
  check(ev[0].oid === 2, 'newest first');
}
check(kindOf('Open Short', -2, -5) === 'add' && kindOf('Long > Short', 1, -1) === 'flip' && kindOf('Open Long', -1, 2) === 'flip' && kindOf('Liquidated Close Long', 2, 0) === 'liquidated',
  'add to a short, both flip forms, a liquidation');
check(sideOf({ kind: 'flip', after: -1, dir: 'Long > Short' }) === 'SHORT', 'a flip is named after the side it ends on');

{
  const f = pacificaFills([{ symbol: 'BP', price: '1.15', amount: '100', created_at: 9, order_id: 3, side: 'open_short', cause: 'normal', pnl: '0' },
    { symbol: 'BP', price: '1.10', amount: '40', created_at: 10, order_id: 4, side: 'close_short', cause: 'market_liquidation', pnl: '-12' }]);
  check(f[0].side === 'A' && f[0].dir === 'Open Short' && f[1].side === 'B' && /^Liquidated/.test(f[1].dir) && f[1].closedPnl === '-12', 'Pacifica history: open_short sells, a liquidation is marked');
  const ev = groupFills(f, { venue: 'pacifica' });
  check(ev.find((e) => e.oid === 4).kind === 'liquidated' && ev.find((e) => e.oid === 3).kind === 'open', 'Pacifica moves get kinds too (no start position: from the direction)');
  const ps = pacificaPositions([{ symbol: 'BP', side: 'ask', amount: '100', entry_price: '1.2', liquidation_price: '2.4' }], () => 1.1);
  check(ps[0].szi === -100 && near(ps[0].unrealizedPnl, 10) && near(ps[0].positionValue, 110), 'Pacifica positions: a short in profit, valued at the mark');
}
console.log('');
process.exit(fails.length ? 1 : 0);
