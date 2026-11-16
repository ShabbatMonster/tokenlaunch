// Pacifica venue adapter (src/venues/pacifica.js) against the live API.
// No funds are needed: a fresh wallet's correctly signed order is refused for
// having no account / balance, while a tampered one is refused as a bad
// signature - the difference proves the signing matches Pacifica's.
//   node test/js/pacifica.test.mjs
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { pacifica, pacificaMessage, pacificaAddress, PACIFICA_API } from '../../src/venues/pacifica.js';
import { toStep, stepDecimals } from '../../src/venues/util.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + String(detail).slice(0, 220) : '')); if (!ok) fails.push(label); };

check(toStep(12.37, '0.1') === '12.3' && toStep(1.0274, '0.0001', 'round') === '1.0274' && toStep(0.00049, '0.0001') === '0.0004' && stepDecimals('0.0001') === 4 && stepDecimals('1') === 0 && stepDecimals(1e-5) === 5,
  'steps: lots floor, ticks round, decimals from the step');
check(pacificaMessage('create_order', 1, 5000, { side: 'bid', amount: '1', tp: { b: 1, a: 2 } }) === '{"data":{"amount":"1","side":"bid","tp":{"a":2,"b":1}},"expiry_window":5000,"timestamp":1,"type":"create_order"}',
  'message: every key sorted, compact JSON');

const ms = await pacifica.markets();
const bp = ms.find((m) => m.coin === 'BP');
check(ms.length > 40 && bp && bp.maxLeverage >= 1 && bp.mid > 0 && bp.lot === '0.1' && bp.szDecimals === 1, 'markets: BP listed with a live price', bp && `${ms.length} markets · BP ${bp.mid} · ${bp.maxLeverage}x · lot ${bp.lot}`);
const cs = await pacifica.candles('BP', '1h', Date.now() - 48 * 3600e3, Date.now());
check(cs.length >= 24 && cs.every((c, i) => !i || c.t > cs[i - 1].t) && cs.at(-1).c > 0, 'candles: 48h of BP 1h bars, oldest first', cs.length);
const book = await new Promise((ok) => { const stop = pacifica.subBook('BP', (b) => { stop(); ok(b); }); setTimeout(() => ok(null), 8000); });
check(book && book.levels[0].length && book.levels[1].length && +book.levels[0][0].px < +book.levels[1][0].px, 'book: bids below asks', book && `${book.levels[0][0].px} / ${book.levels[1][0].px}`);

const kp = Keypair.generate();
const secret = bs58.encode(kp.secretKey);
check(pacificaAddress(secret) === kp.publicKey.toBase58(), 'address from a Solana secret key');
let bad = false; try { pacificaAddress(bs58.encode(kp.secretKey.slice(0, 32))); } catch { bad = true; }
check(bad, 'a 32-byte key is refused');

const s = pacifica.connect(secret);
const st = await s.state();
check(st.st.assetPositions.length === 0 && st.orders.length === 0 && +st.st.marginSummary.accountValue === 0, 'a fresh wallet: empty account state', st.st.venueNote || 'account exists');

let goodErr = '';
try { await s.order({ coin: 'BP', isBuy: true, sz: 20, type: 'market', slippage: 1 }); goodErr = 'accepted?!'; } catch (e) { goodErr = e.message; }
// a tampered request: sign 20, send 21
const ts = Date.now();
const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(pacificaMessage('create_market_order', ts, 30000, { symbol: 'BP', amount: '20.0', side: 'bid', reduce_only: false, slippage_percent: '1', client_order_id: '00000000-0000-4000-8000-000000000000' })), kp.secretKey.slice(0, 32)));
const r = await fetch(PACIFICA_API + '/orders/create_market', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: kp.publicKey.toBase58(), signature: sig, timestamp: ts, expiry_window: 30000, symbol: 'BP', amount: '21.0', side: 'bid', reduce_only: false, slippage_percent: '1', client_order_id: '00000000-0000-4000-8000-000000000000' }) });
const tamperedErr = (await r.text()).slice(0, 200);
console.log('       signed order →', goodErr);
console.log('       tampered     →', r.status, tamperedErr);
check(!/signature/i.test(goodErr) && /signature|verif/i.test(tamperedErr), 'signing: our order passes the signature check (refused only for funds); a tampered one fails it');

console.log('');
process.exit(fails.length ? 1 : 0);
