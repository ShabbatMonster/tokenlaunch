// Aster venue adapter (src/venues/aster.js) against the live API.
// No funds are needed. A fresh wallet approves its API wallet (that works
// before any deposit), the API wallet's signed query is answered, and its
// signed order is refused only for having no deposit. Tampered requests are
// refused: the wallet's approval as "Signature check failed", the API
// wallet's query no longer answered. The API wallet is revoked at the end.
//   node test/js/aster.test.mjs
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { aster, asterQuery, asterAccount, asterAgentKey, signAsterMsg, signAsterMain, ASTER_API, ASTER_MAIN_CHAIN } from '../../src/venues/aster.js';
import { toStep, stepDecimals } from '../../src/venues/util.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + String(detail).slice(0, 220) : '')); if (!ok) fails.push(label); };
const raw = async (method, path, q) => {
  const r = method === 'GET' ? await fetch(`${ASTER_API}${path}?${q}`)
    : await fetch(ASTER_API + path, { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: q });
  return `${r.status} ${(await r.text()).replace(/\s+/g, ' ').slice(0, 200)}`;
};

check(toStep(0.0123, '0.001') === '0.012' && toStep(65432.17, '0.1', 'round') === '65432.2' && stepDecimals('0.000001') === 6, 'steps: lots floor, ticks round');
check(asterQuery({ symbol: 'BTCUSDT', quantity: '0.001', reduceOnly: undefined, user: '0xab', nonce: 1 }) === 'symbol=BTCUSDT&quantity=0.001&user=0xab&nonce=1', 'query: in order, empty fields left out');

// --- market data ---
const ms = await aster.markets();
const btc = ms.find((m) => m.coin === 'BTCUSDT');
check(ms.length > 100 && btc && btc.mid > 0 && btc.mark > 0 && btc.tick === '0.1' && btc.lot === '0.001' && btc.szDecimals === 3 && btc.minNotional > 0,
  'markets: BTCUSDT listed with a live price and its filters', btc && `${ms.length} markets · BTC ${btc.mid} mark ${btc.mark} · tick ${btc.tick} lot ${btc.lot} · min $${btc.minNotional}`);
check(Math.abs(btc.funding) < 0.001 && btc.volume > 1e6 && ms.every((m) => m.coin && m.label && m.dex === ''), 'markets: funding per hour, 24h volume in USD', `funding ${(btc.funding * 100).toFixed(5)}%/h · vol $${(btc.volume / 1e6).toFixed(0)}M`);
const cs = await aster.candles('BTCUSDT', '1h', Date.now() - 48 * 3600e3, Date.now());
check(cs.length >= 47 && cs.every((c, i) => !i || c.t > cs[i - 1].t) && cs.at(-1).c > 0, 'candles: 48h of BTC 1h bars, oldest first', cs.length);
const long = await aster.candles('BTCUSDT', '1m', Date.now() - 50 * 3600e3, Date.now());
check(long.length > 2900 && long.every((c, i) => !i || c.t > long[i - 1].t), 'candles: 50h of 1m bars paged past the 1500 cap', long.length);
const book = await new Promise((ok) => { const stop = aster.subBook('BTCUSDT', (b) => { stop(); ok(b); }); setTimeout(() => ok(null), 8000); });
check(book && book.levels[0].length && book.levels[1].length && +book.levels[0][0].px < +book.levels[1][0].px && +book.levels[0][0].px > +book.levels[0][1].px,
  'book: bids below asks, best first', book && `${book.levels[0][0].px} / ${book.levels[1][0].px}`);
const bar = await new Promise((ok) => { const stop = aster.subCandles('BTCUSDT', '1m', (k) => { stop(); ok(k); }); setTimeout(() => ok(null), 30000); });
check(bar && bar.t > Date.now() - 120e3 && bar.c > 0, 'stream: a live 1m candle (comes with the next trade)', bar && JSON.stringify(bar));

// --- keys ---
const key = generatePrivateKey();
const wallet = privateKeyToAccount(key);
check(asterAccount(key).account.address === wallet.address && asterAccount(key.slice(2)).account.address === wallet.address, 'address from an EVM key, with or without 0x');
let bad = false; try { asterAccount('0x1234'); } catch { bad = true; }
check(bad, 'a short key is refused');
const s = aster.connect(key);
check(s.address === wallet.address && s.signer !== s.address && aster.connect(key).signer === s.signer && privateKeyToAccount(asterAgentKey(key)).address === s.signer,
  'API wallet: derived from the key, the same every time', s.signer);

// --- the wallet's own signature: approving an API wallet ---
// tampered: sign one name, send another
const other = privateKeyToAccount(generatePrivateKey());
const p = { agentName: 'tamper', agentAddress: other.address, ipWhitelist: '', expired: Date.now() + 30 * 86400e3, canSpotTrade: false, canPerpTrade: true, canWithdraw: false, asterChain: 'Mainnet', user: wallet.address, nonce: Date.now() * 1000 };
const sig = await signAsterMain(wallet, p, 'ApproveAgent');
const tamperedApprove = await raw('POST', '/fapi/v3/approveAgent', asterQuery({ ...p, agentName: 'tampered', signature: sig, signatureChainId: ASTER_MAIN_CHAIN }));
// unapproved: the API wallet before approval
const before = await s.agents().then(() => 'answered?!', (e) => e.message);

// polling only checks: before setup, state() says what to do and signs nothing that changes the account
const pre = await s.state();
check(/approve/i.test(pre.st.venueNote || '') && pre.st.assetPositions.length === 0, 'before setup: state() changes nothing and says how to set up', pre.st.venueNote);
// setup (the page's button, or the first order) approves the API wallet; then the deposit gate
await s.setupApiKey();
const st = await s.state();
check(st.st.assetPositions.length === 0 && st.orders.length === 0 && +st.st.marginSummary.accountValue === 0 && /deposit/i.test(st.st.venueNote || ''),
  'a fresh wallet: API wallet approved, empty state, told to deposit', st.st.venueNote);
console.log('       before approval →', before);
console.log('       tampered approval →', tamperedApprove);
check(/no agent/i.test(before) && /signature check failed/i.test(tamperedApprove), 'wallet signing: our approval is accepted; a tampered one fails the signature check');

// --- the API wallet's signature: requests ---
const list = await s.agents();
const mine = list.find((a) => a.agentAddress.toLowerCase() === s.signer.toLowerCase());
check(mine && mine.canPerpTrade && !mine.canWithdraw && mine.expired > Date.now() + 100 * 86400e3, 'API wallet: approved for perps, no withdrawals, ~180 days', mine && `${mine.agentName} until ${new Date(mine.expired).toISOString().slice(0, 10)}`);
// the same query, signed then tampered (nonce +1), and signed by a key that isn't the API wallet
const agent = privateKeyToAccount(asterAgentKey(key));
const q = asterQuery({ user: wallet.address, signer: s.signer, nonce: Date.now() * 1000 + 7 });
const qsig = await signAsterMsg(agent, q);
const good = await raw('GET', '/fapi/v3/agent', `${q}&signature=${qsig}`);
const tampered = await raw('GET', '/fapi/v3/agent', `${q.replace(/nonce=(\d+)/, (_, n) => 'nonce=' + (+n + 1))}&signature=${qsig}`);
const q2 = asterQuery({ user: wallet.address, signer: s.signer, nonce: Date.now() * 1000 + 9 });
const wrongKey = await raw('GET', '/fapi/v3/agent', `${q2}&signature=${await signAsterMsg(other, q2)}`);
console.log('       signed query   →', good.slice(0, 90));
console.log('       tampered query →', tampered);
console.log('       wrong signer   →', wrongKey);
check(good.startsWith('200 [') && !tampered.startsWith('200') && !wrongKey.startsWith('200'), 'request signing: our query is answered; tampered or wrongly signed ones are refused');

let orderErr = '';
try { await s.order({ coin: 'BTCUSDT', isBuy: true, sz: 0.002, type: 'limit', px: Math.round(btc.mark * 0.5) }); orderErr = 'accepted?!'; } catch (e) { orderErr = e.message; }
const oq = asterQuery({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.002', price: String(Math.round(btc.mark * 0.5)), user: wallet.address, signer: s.signer, nonce: Date.now() * 1000 + 11 });
const osig = await signAsterMsg(agent, oq);
const tamperedOrder = await raw('POST', '/fapi/v3/order', `${oq.replace('quantity=0.002', 'quantity=0.003')}&signature=${osig}`);
console.log('       signed order   →', orderErr);
console.log('       tampered order →', tamperedOrder, '(Aster checks the deposit before the signature on trading endpoints)');
check(/after deposit/i.test(orderErr) && !/signature|agent/i.test(orderErr), 'order: passes the API wallet checks, refused only for no deposit');

// --- revoke ---
const rv = await s.revokeSigner().then(() => 'ok', (e) => e.message);
const after = await s.agents().then(() => 'answered?!', (e) => e.message);
check(rv === 'ok' && /no agent/i.test(after), 'API wallet revoked by the wallet', after);

console.log('');
process.exit(fails.length ? 1 : 0);
