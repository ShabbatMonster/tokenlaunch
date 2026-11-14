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
import { hlClients, hlMarkets, buildOrders, closeOrder, sizeForUsd, marketPrice, orderOutcome, hlError } from '../../src/hyperliquid.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'perps.html'), 'utf8');
const BUILD = fs.readFileSync(path.join(ROOT, 'build.mjs'), 'utf8');

// --- the page --------------------------------------------------------------------
check(['mSearch', 'dexTabs', 'mList', 'chart', 'bookAsks', 'bookBids', 'bBody', 'sLong', 'sShort', 'oType', 'size', 'lev', 'tp', 'sl', 'reduce', 'slip', 'goBtn', 'keyModal']
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
