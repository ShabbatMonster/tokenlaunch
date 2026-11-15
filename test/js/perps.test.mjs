// Hyperliquid perps page (docs/perps.html, src/perps.js, src/hyperliquid.js).
//
// Live and harmless: market data is read from Hyperliquid's public info API,
// and every signed action is sent from a fresh, empty wallet. Hyperliquid
// recovers the signer from the signature and refuses with "User or API Wallet
// <address> does not exist" - so the address it names proves the signature is
// right for that action, without any account or money involved.
//   node test/js/perps.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { SymbolConverter } from '@nktkas/hyperliquid/utils';
import { HttpTransport } from '@nktkas/hyperliquid';
import {
  hlClients, hlMarkets, buildOrders, closeOrder, sizeForUsd, marketPrice, orderOutcome, hlError,
  mergeBook, partialCloseOrder, positionTpslOrders,
} from '../../src/hyperliquid.js';
import { cardFromPosition, closedTrades, closedRoe } from '../../src/pnlCard.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'perps.html'), 'utf8');
const BUILD = fs.readFileSync(path.join(ROOT, 'build.mjs'), 'utf8');

// --- the page --------------------------------------------------------------------
check(['mSearch', 'dexTabs', 'mList', 'chart', 'bookAsks', 'bookBids', 'bBody', 'sLong', 'sShort', 'oType', 'size', 'lev', 'tp', 'sl', 'reduce', 'slip', 'goBtn', 'keyModal', 'bookTabs', 'bookGroup', 'bookLive', 'tradeTape', 'posTool', 'toasts', 'tNext']
  .every((id) => HTML.includes(`id="${id}"`)), 'page: markets, chart, book, positions and the order ticket are all there');
check(/entryPoints: \['src\/perps\.js'\]/.test(BUILD) && fs.existsSync(path.join(ROOT, 'docs', 'perps.js')), 'page: built into docs/perps.js');
for (const f of fs.readdirSync(path.join(ROOT, 'docs')).filter((x) => x.endsWith('.html'))) {
  const h = fs.readFileSync(path.join(ROOT, 'docs', f), 'utf8');
  if (h.includes('class="menubar"') && !h.includes('href="perps.html"')) check(false, `nav: ${f} links to Perps`);
}
check(true, 'nav: every page with the menu bar links to Perps');

// --- markets -----------------------------------------------------------------------
const { info } = hlClients({ ws: false });
const markets = await hlMarkets(info);
const live = markets.filter((m) => !m.delisted);
const dexes = new Set(live.map((m) => m.dex));
check(live.length > 300 && dexes.has('') && dexes.has('xyz') && dexes.size >= 4,
  'every live market loads, from the main exchange and the HIP-3 exchanges', `${live.length} live of ${markets.length} · ${dexes.size} exchanges`);
check(['BTC', 'ETH', 'HYPE', 'xyz:NVDA', 'xyz:TSLA'].every((c) => live.some((m) => m.coin === c)), 'BTC, ETH, HYPE and the XYZ stock perps are tradeable');
const conv = await SymbolConverter.create({ transport: new HttpTransport(), dexs: true });
const wrongIds = markets.filter((m) => conv.getAssetId(m.coin) !== undefined && conv.getAssetId(m.coin) !== m.asset);
check(wrongIds.length === 0 && markets.filter((m) => conv.getAssetId(m.coin) !== undefined).length > 300,
  'every asset id matches the SDK\'s own converter (main and HIP-3)', wrongIds.slice(0, 3).map((m) => `${m.coin} ${m.asset}≠${conv.getAssetId(m.coin)}`).join(', ') || `${markets.length} checked`);
check(live.every((m) => m.mid > 0 && m.maxLeverage >= 1 && Number.isInteger(m.szDecimals)), 'every live market has a price, a leverage cap and a lot size');

// --- order maths ---------------------------------------------------------------------
const btc = live.find((m) => m.coin === 'BTC');
const nvda = live.find((m) => m.coin === 'xyz:NVDA');
const sigFigs = (p) => p.replace('.', '').replace(/^0+/, '').length;
const okPx = (p, m) => /^\d+(\.\d+)?$/.test(p) && (sigFigs(p) <= 5 || !p.includes('.')) && ((p.split('.')[1] || '').length <= 6 - m.szDecimals);
{
  const s = sizeForUsd(100, btc.mid, btc.szDecimals);
  check(s > 0 && s * btc.mid <= 100 && Math.round(s * 10 ** btc.szDecimals) === s * 10 ** btc.szDecimals, '$100 of BTC rounds down to the lot size', `${s} BTC`);
  const tiny = (() => { try { sizeForUsd(0.0001, btc.mid, btc.szDecimals); return 'taken'; } catch (e) { return e.message; } })();
  check(/smallest size/.test(tiny), 'an amount under one lot is refused, naming the minimum', tiny);
}
for (const m of [btc, nvda, live.find((x) => x.mid < 0.01) || btc]) {
  const buy = marketPrice(m.mid, true, 1, m.szDecimals), sell = marketPrice(m.mid, false, 1, m.szDecimals);
  check(okPx(buy, m) && okPx(sell, m) && +buy > m.mid && +sell < m.mid, `${m.coin}: market prices land past the mid and inside Hyperliquid's tick rules`, `mid ${m.mid} · buy ${buy} · sell ${sell}`);
}
{
  const o = buildOrders({ market: btc, isBuy: true, size: 0.001, tp: btc.mid * 1.1, sl: btc.mid * 0.9 });
  const [e, tp, sl] = o.orders;
  check(o.grouping === 'normalTpsl' && e.t.limit.tif === 'Ioc' && !e.r && tp.r && sl.r && !tp.b && !sl.b && tp.t.trigger.tpsl === 'tp' && sl.t.trigger.tpsl === 'sl',
    'a long with TP/SL: IOC entry plus two reduce-only sells grouped as normalTpsl');
  const bad = (() => { try { buildOrders({ market: btc, isBuy: true, size: 0.001, tp: btc.mid * 0.9 }); return 'taken'; } catch (x) { return x.message; } })();
  check(/take-profit must be above the entry for a long/.test(bad), 'a take-profit on the wrong side is refused in words', bad);
  const lim = buildOrders({ market: nvda, isBuy: false, size: 1, type: 'limit', limitPx: nvda.mid * 1.05 });
  check(lim.orders[0].t.limit.tif === 'Gtc' && lim.orders[0].a === nvda.asset && okPx(lim.orders[0].p, nvda), 'a limit short on xyz:NVDA rests GTC on its HIP-3 asset id', `a ${nvda.asset} @ ${lim.orders[0].p}`);
  const cl = closeOrder(btc, '-0.002');
  check(cl.orders[0].b === true && cl.orders[0].r === true && cl.orders[0].s === '0.002', 'closing a short buys back its whole size, reduce-only');
  check(orderOutcome({ response: { data: { statuses: [{ filled: { totalSz: '0.001', avgPx: '68000' } }, { error: 'Insufficient margin' }] } } }).map((x) => x.ok).join() === 'true,false',
    'fills and refusals are each reported per order');
}

// --- errors: never "[object Object]" -----------------------------------------------
{
  const bulk = { response: { status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Order must have minimum value of $10.' }] } } } };
  const t1 = hlError(bulk);
  check(!/object Object/.test(t1) && /minimum value of \$10/.test(t1) && /raise the size/.test(t1), 'an order refusal reads as its reason, not [object Object]', t1);
  check(hlError({ response: { status: 'err', response: 'Insufficient margin to place order. asset=0' } }).includes('lower the size'), 'a top-level refusal gets a hint too');
  check(hlError(new Error('plain')) === 'plain' && hlError({ weird: 1 }) === '{"weird":1}', 'anything else is still text');
  const tooSmall = (() => { try { buildOrders({ market: btc, isBuy: true, size: 0.00005 }); return 'taken'; } catch (e) { return e.message; } })();
  check(/refuses orders under \$10/.test(tooSmall), 'an order under $10 is refused before signing', tooSmall);
}

// --- the order book ------------------------------------------------------------------
{
  const L = (...p) => p.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 }));
  const deep = [L([99, 1], [98, 2], [97, 3], [96, 4], [95, 5], [94, 6]), L([101, 1], [102, 2], [103, 3], [104, 4], [105, 5], [106, 6])];
  const fast = [L([100, 7], [99, 1], [98, 2]), L([101, 1], [102, 2], [103, 3])];
  const [b1, a1] = mergeBook({ deep, fast });
  check(b1.map((l) => l.px).join() === '100,99,98,97,96,95,94' && a1.map((l) => l.px).join() === '101,102,103,104,105,106',
    'book: the fast top levels lead and the deep snapshot fills in below them');
  const [b2, a2] = mergeBook({ deep, fast, bbo: [{ px: '99.5', sz: '9' }, { px: '102', sz: '4' }] });
  check(b2[0].px === 99.5 && b2[0].sz === 9 && b2[1].px === 99 && a2[0].px === 102 && a2[0].sz === 4 && !a2.some((l) => l.px === 101),
    'book: a newer best bid/ask replaces the levels it has overtaken');
}
{
  const pos = '0.01';
  const half = partialCloseOrder(btc, pos, 0.5), all = partialCloseOrder(btc, '-0.0137', 1);
  check(half.orders[0].s === '0.005' && half.orders[0].b === false && half.orders[0].r && all.orders[0].s === '0.0137' && all.orders[0].b === true,
    'closing 50% of a long sells half, reduce-only; 100% of a short buys all of it back');
  const t = positionTpslOrders(btc, pos, { tp: btc.mark * 1.2, sl: btc.mark * 0.8 });
  check(t.grouping === 'positionTpsl' && t.orders.length === 2 && t.orders.every((o) => o.r && !o.b && o.s === '0.01'),
    'TP/SL on an open long: two reduce-only sells grouped to follow the position');
  const wrong = (() => { try { positionTpslOrders(btc, '-0.01', { tp: btc.mark * 1.2 }); return 'taken'; } catch (e) { return e.message; } })();
  check(/take-profit must be below the mark/.test(wrong), 'a TP above the mark on a short is refused', wrong);
}

// --- PnL cards -------------------------------------------------------------------------
{
  const PAGE = fs.readFileSync(path.join(ROOT, 'src', 'perps.js'), 'utf8');
  check(['cardModal', 'cardCanvas', 'cardStyle', 'cardImg', 'cardAccent', 'cardUsd', 'cardPrices', 'cardSize', 'cardLev', 'cardBrand', 'cardHandle', 'cardCaption', 'cardSave', 'cardCopy']
    .every((id) => HTML.includes(`id="${id}"`)) && /data-card="pos\|/.test(PAGE) && /data-card="fill\|/.test(PAGE),
  'cards: the editor is on the page, with a CARD button on positions and on closing fills');
  const pos = cardFromPosition({ coin: 'ETH', szi: '-2', entryPx: '1900', unrealizedPnl: '160', returnOnEquity: '0.842', leverage: { value: 10 } }, 1820);
  check(!pos.long && pos.size === 2 && pos.roe === 84.2 && pos.lev === 10 && pos.exit === 1820, 'cards: an open short carries its side, size, ROE, leverage and mark');
  // two fills of one closing order, one flip, one opening fill (no PnL)
  const fl = [
    { coin: 'BTC', oid: 7, side: 'B', dir: 'Close Short', sz: '0.2', px: '66100', closedPnl: '-412.4', fee: '5.9', time: 2, startPosition: '-0.3' },
    { coin: 'BTC', oid: 7, side: 'B', dir: 'Close Short', sz: '0.1', px: '66140', closedPnl: '-210.2', fee: '3', time: 3, startPosition: '-0.1' },
    { coin: 'SOL', oid: 9, side: 'A', dir: 'Long > Short', sz: '15', px: '80', closedPnl: '50', fee: '0.5', time: 4, startPosition: '10' },
    { coin: 'SOL', oid: 8, side: 'B', dir: 'Open Long', sz: '10', px: '75', closedPnl: '0', fee: '0.3', time: 1, startPosition: '0' },
  ];
  const ts = closedTrades(fl);
  const btcT = ts.find((x) => x.coin === 'BTC'), solT = ts.find((x) => x.coin === 'SOL');
  const exitV = (0.2 * 66100 + 0.1 * 66140) / 0.3;
  check(ts.length === 2 && !btcT.long && Math.abs(btcT.size - 0.3) < 1e-12 && Math.abs(btcT.exit - exitV) < 1e-6 && Math.abs(btcT.pnl + 622.6) < 1e-9
    && Math.abs((btcT.entry - btcT.exit) * btcT.size - btcT.pnl) < 1e-6,
  'cards: an order\'s fills make one closed trade, its entry the one its realised PnL implies', `entry ${btcT.entry.toFixed(2)} exit ${btcT.exit.toFixed(2)}`);
  check(solT.long && solT.size === 10 && solT.entry === 75 && ts[0].coin === 'SOL',
    'cards: a flip counts only the size it closed, and the newest trade comes first');
  check(Math.abs(closedRoe(solT, 5) - 50 / (75 * 10 / 5) * 100) < 1e-9, 'cards: a closed trade\'s ROE is its PnL over the margin at the leverage given');
}

// --- signing, live -----------------------------------------------------------------
const wallet = privateKeyToAccount(generatePrivateKey());
const { exchange } = hlClients({ wallet, ws: false });
const named = (e) => hlError(e).toLowerCase().includes(wallet.address.toLowerCase());
for (const [label, fn] of [
  ['a BTC market long with TP/SL', () => exchange.order(buildOrders({ market: btc, isBuy: true, size: 0.001, tp: btc.mid * 1.1, sl: btc.mid * 0.9 }))],
  ['an xyz:NVDA (HIP-3) short', () => exchange.order(buildOrders({ market: nvda, isBuy: false, size: 1 }))],
  ['a leverage change', () => exchange.updateLeverage({ asset: btc.asset, isCross: true, leverage: 5 })],
  ['a cancel', () => exchange.cancel({ cancels: [{ a: btc.asset, o: 1 }] })],
  ['the unified-account switch', () => exchange.userSetAbstraction({ user: wallet.address, abstraction: 'unifiedAccount' })],
]) {
  const r = await fn().then(() => null, (e) => e);
  check(r && named(r), `signing: Hyperliquid recovers our own address from ${label}`, r ? hlError(r).slice(0, 90) : 'it was ACCEPTED from an empty wallet?');
}

console.log('');
process.exit(fails.length ? 1 : 0);
