// Backpack venue adapter (src/venues/backpack.js) against the live API.
// No funds and no real key are needed: a freshly generated ED25519 key is not
// registered with Backpack, yet Backpack checks the signature against the
// X-API-Key header before it looks the key up. So a correctly signed request
// gets past the signature check (and fails, if at all, for having no account),
// while a tampered one is refused as "Invalid signature" - the difference
// proves the signing string and headers match Backpack's.
//   node test/js/backpack.test.mjs
import { ed25519 } from '@noble/curves/ed25519';
import {
  backpack, backpackSigningString, backpackKeys, backpackHeaders, backpackSigned, backpackBase, parseUtc, toB64, fromB64,
} from '../../src/venues/backpack.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + String(detail).slice(0, 220) : '')); if (!ok) fails.push(label); };

// --- the signing string, against the docs' own examples ---------------------------
check(backpackSigningString('orderCancel', { symbol: 'BTC_USDT', orderId: 28 }, 1614550000000, 5000) === 'instruction=orderCancel&orderId=28&symbol=BTC_USDT&timestamp=1614550000000&window=5000',
  'signing string: the docs\' orderCancel example');
check(backpackSigningString('orderExecute', [
  { symbol: 'SOL_USDC_PERP', side: 'Bid', orderType: 'Limit', price: '141', quantity: '12' },
  { symbol: 'SOL_USDC_PERP', side: 'Bid', orderType: 'Limit', price: '140', quantity: '11' },
], 1750793021519, 5000) === 'instruction=orderExecute&orderType=Limit&price=141&quantity=12&side=Bid&symbol=SOL_USDC_PERP&instruction=orderExecute&orderType=Limit&price=140&quantity=11&side=Bid&symbol=SOL_USDC_PERP&timestamp=1750793021519&window=5000',
  'signing string: the docs\' batch example');
check(backpackSigningString('balanceQuery', {}, 1, 5000) === 'instruction=balanceQuery&timestamp=1&window=5000'
  && backpackSigningString('fillHistoryQueryAll', { marketType: ['SPOT', 'PERP'], limit: 5, x: undefined, reduceOnly: true }, 1, 5000) === 'instruction=fillHistoryQueryAll&limit=5&marketType=SPOT&marketType=PERP&reduceOnly=true&timestamp=1&window=5000',
  'signing string: no fields, repeated fields, booleans, empty fields dropped');
check(parseUtc('2026-11-16 19:00:00') === Date.UTC(2026, 10, 16, 19) && parseUtc('2024-09-11T12:00:00.123456') === Date.UTC(2024, 8, 11, 12, 0, 0, 123) && parseUtc(1694687692980000) === 1694687692980,
  'timestamps: naive UTC strings and microseconds to ms');

// --- keys ----------------------------------------------------------------------------
const seed = ed25519.utils.randomPrivateKey();     // fresh, never registered anywhere
const secret = toB64(seed), pub = toB64(ed25519.getPublicKey(seed));
const k = backpackKeys(secret);
check(k.apiKey === pub && backpackKeys(`${pub}:${secret}`).apiKey === pub && backpackKeys(`${secret}:${pub}`).apiKey === pub,
  'keys: the API Key is derived from the API Secret; "key:secret" either way round');
const refused = (s) => { try { backpackKeys(s); return ''; } catch (e) { return e.message; } };
const other = toB64(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
check(refused('') && refused('not base64 at all!') && /32 bytes/.test(refused(toB64(seed.slice(0, 20)))) && /does not belong/.test(refused(`${other}:${secret}`)),
  'keys: empty, junk, short and mismatched keys are refused with a reason', refused(toB64(seed.slice(0, 20))));
check(toB64(fromB64(secret)) === secret, 'base64 round trip without Buffer');

// --- live market data ------------------------------------------------------------------
console.log('       REST base', backpackBase());
const ms = await backpack.markets();
const bp = ms.find((m) => m.coin === 'BP_USDC'), sol = ms.find((m) => m.coin === 'SOL_USDC_PERP');
const perps = ms.filter((m) => !m.spot), spots = ms.filter((m) => m.spot);
check(bp && bp.spot && bp.maxLeverage === 1 && bp.funding === 0 && bp.mid > 0 && bp.label === 'BP/USDC' && +bp.lot > 0,
  'markets: BP_USDC listed as spot with a live price', bp && `BP ${bp.mid} · lot ${bp.lot} · tick ${bp.tick} · 24h ${bp.change.toFixed(2)}% · $${Math.round(bp.volume)}`);
check(perps.length >= 50 && sol && !sol.spot && sol.maxLeverage > 1 && sol.mark > 0 && sol.label === 'SOL' && Math.abs(sol.funding) < 0.01 && sol.oi > 0,
  'markets: perps listed with mark, funding/hour and open interest', sol && `${perps.length} perps + ${spots.length} spot · SOL ${sol.mark} · ${sol.maxLeverage}x · funding ${(sol.funding * 100).toFixed(5)}%/h · oi ${sol.oi}`);

const cs = await backpack.candles('BP_USDC', '1h', Date.now() - 48 * 3600e3, Date.now());
check(cs.length >= 24 && cs.every((c, i) => !i || c.t > cs[i - 1].t) && cs.at(-1).c > 0 && cs.at(-1).t > Date.now() - 2 * 3600e3 && cs[0].t % 3600e3 === 0,
  'candles: 48h of BP 1h bars, ms on the hour, oldest first', `${cs.length} bars, last ${new Date(cs.at(-1).t).toISOString()}`);
const cm = await backpack.candles('SOL_USDC_PERP', '1m', Date.now() - 2500 * 60e3, Date.now());
check(cm.length > 2000 && cm.every((c, i) => !i || c.t - cm[i - 1].t === 60e3 || c.t > cm[i - 1].t), 'candles: 2500 1m bars arrive in pieces (Backpack caps a range near 2000)', cm.length);

const firstBook = (coin) => new Promise((ok) => { let stop = null; stop = backpack.subBook(coin, (b) => { if (b.levels[0].length && b.levels[1].length) { setTimeout(() => stop(), 0); ok(b); } }); setTimeout(() => { stop?.(); ok(null); }, 10000); });
for (const coin of ['BP_USDC', 'SOL_USDC_PERP']) {
  const book = await firstBook(coin);
  const [b, a] = book ? book.levels : [[], []];
  check(book && +b[0].px < +a[0].px && b.every((l, i) => !i || +l.px < +b[i - 1].px) && a.every((l, i) => !i || +l.px > +a[i - 1].px),
    `book ${coin}: bids below asks, each side best first`, book && `${b[0].px} / ${a[0].px} · ${b.length}+${a.length} levels`);
}
const trades = await new Promise((ok) => { const stop = backpack.subTrades('BP_USDC', (ts) => { stop(); ok(ts); }); setTimeout(() => ok(null), 8000); });
check(trades && trades.length && trades.every((t) => +t.px > 0 && /^[AB]$/.test(t.side)) && trades.every((t, i) => !i || t.time >= trades[i - 1].time),
  'trades: BP prints with an aggressor side, oldest first', trades && `${trades.length} · last ${trades.at(-1).side} ${trades.at(-1).sz} @ ${trades.at(-1).px}`);

// --- the signing proof -----------------------------------------------------------------
const s = backpack.connect(secret);
check(s.address === pub, 'session: the address is the API public key');
const st = await s.state();
check(st.st.assetPositions.length === 0 && st.orders.length === 0 && +st.st.marginSummary.accountValue === 0 && Array.isArray(st.spot.balances),
  'state: an unregistered key reads as an empty account', st.st.venueNote || 'account exists');

// one request, signed right or with one bit flipped in the signature
async function raw(method, path, instruction, params, tamper) {
  const h = backpackHeaders(k, instruction, params);
  if (tamper) { const sig = fromB64(h['X-Signature']); sig[7] ^= 1; h['X-Signature'] = toB64(sig); }
  const q = method === 'GET' ? Object.keys(params).sort().map((x) => `${x}=${params[x]}`).join('&') : '';
  const r = await fetch(backpackBase() + path + (q ? '?' + q : ''), { method, headers: { ...h, 'content-type': 'application/json; charset=utf-8' }, body: method === 'GET' ? undefined : JSON.stringify(params) });
  return `${r.status} ${(await r.text()).slice(0, 160)}`;
}
const cases = [
  ['GET', '/api/v1/capital', 'balanceQuery', {}],
  ['GET', '/wapi/v1/history/fills', 'fillHistoryQueryAll', { limit: 100, sortDirection: 'Desc' }],
  ['DELETE', '/api/v1/order', 'orderCancel', { orderId: '28', symbol: 'BP_USDC' }],
];
for (const [method, path, ins, params] of cases) {
  const good = await raw(method, path, ins, params, false), bad = await raw(method, path, ins, params, true);
  console.log(`       ${ins.padEnd(20)} signed   → ${good}`);
  console.log(`       ${''.padEnd(20)} tampered → ${bad}`);
  check(!/signature/i.test(good) && /invalid signature/i.test(bad), `signing (${ins}, ${Object.keys(params).length ? 'fields in the ' + (method === 'GET' ? 'query' : 'body') : 'no fields'}): ours passes the signature check, a tampered one fails it`);
}
// the adapter's own path: an order is refused for the unknown key, not the signature
let orderErr = '';
try { await s.order({ coin: 'BP_USDC', isBuy: true, sz: 10, type: 'limit', px: bp.mid * 0.5 }); orderErr = 'accepted?!'; } catch (e) { orderErr = e.message; }
const ts = Date.now(), body = { orderType: 'Limit', price: '0.5', quantity: '10', side: 'Bid', symbol: 'BP_USDC', timeInForce: 'GTC' };
const h = backpackHeaders(k, 'orderExecute', { ...body, quantity: '11' }, ts);
const r = await fetch(backpackBase() + '/api/v1/order', { method: 'POST', headers: { ...h, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
const tamperedOrder = `${r.status} ${(await r.text()).slice(0, 160)}`;
console.log('       orderExecute         signed   →', orderErr);
console.log('                            tampered →', tamperedOrder);
check(orderErr && orderErr !== 'accepted?!' && !/signature/i.test(orderErr), 'order: refused without a signature complaint (POST /order looks the key up first, so a tampered one reads the same)');
let levErr = '';
try { await s.setLeverage('SOL_USDC_PERP', 5, false); } catch (e) { levErr = e.message; }
check(/subaccount/.test(levErr), 'leverage: isolated is refused with a reason', levErr);
// backpackSigned itself (the adapter's request path) on a signed GET with fields
const viaAdapter = await backpackSigned(k, 'GET', '/wapi/v1/history/fills', 'fillHistoryQueryAll', { limit: 5, sortDirection: 'Desc' }).then(() => 'ok', (e) => e.message);
check(!/signature/i.test(viaAdapter), 'backpackSigned: a signed GET with query fields passes the signature check', viaAdapter);

console.log('');
process.exit(fails.length ? 1 : 0);
