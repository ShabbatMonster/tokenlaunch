// Lighter venue adapter (src/venues/lighter.js) against the live API, with
// Lighter's own wasm signer. No funds are needed for the signing proof: on
// testnet (sendTx is refused from restricted regions on mainnet, testnet is
// not), a ChangePubKey for an existing account, signed by a fresh API key and
// a fresh EVM key, gets past the API-key signature check and is refused only
// because that EVM key does not own the account; the same transaction with one
// bit of the signature flipped, or with a signed field changed, is refused as
// an invalid signature. The difference proves the signer's output is what
// Lighter verifies. Nothing is ever accepted, so nothing changes on testnet.
//   node test/js/lighter.test.mjs
import fs from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { lighter, loadSigner, signerCall, newApiKey, sendTx, lighterAddress, LIGHTER_API, SIGNER } from '../../src/venues/lighter.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + String(detail).slice(0, 220) : '')); if (!ok) fails.push(label); };
const tryErr = async (f) => { try { await f(); return 'accepted?!'; } catch (e) { return `${e.code ?? ''} ${e.message}`.trim(); } };

// --- market data -------------------------------------------------------------------
const ms = await lighter.markets();
const eth = ms.find((m) => m.coin === 'ETH'), btc = ms.find((m) => m.coin === 'BTC');
check(ms.length > 100 && eth && btc && eth.mid > 0 && btc.mark > 0 && eth.maxLeverage >= 10 && eth.lot === '0.0001' && eth.tick === '0.01' && eth.szDecimals === 4,
  'markets: perps listed with live prices', eth && `${ms.length} markets · ETH ${eth.mid} mark ${eth.mark} · ${eth.maxLeverage}x · lot ${eth.lot} tick ${eth.tick} · min $${eth.minNotional}`);
check(ms.every((m) => Math.abs(m.funding) < 0.01) && ms.filter((m) => m.funding).length > 50 && eth.oi > 0 && eth.volume > 0,
  'markets: hourly funding, OI in coins, 24h volume', `ETH funding ${(eth.funding * 100).toFixed(5)}%/h · OI ${eth.oi.toFixed(0)} ETH · vol $${(eth.volume / 1e6).toFixed(1)}M · ${eth.change.toFixed(2)}%`);
check(!ms.some((m) => m.coin.includes('/')), 'markets: no spot pairs');

const ordered = (cs) => cs.every((c, i) => !i || c.t > cs[i - 1].t);
const now = Date.now();
const c1h = await lighter.candles('ETH', '1h', now - 48 * 3600e3, now);
check(c1h.length >= 47 && ordered(c1h) && c1h.at(-1).c > 0 && c1h.every((c) => c.h >= c.l), 'candles: 48h of ETH 1h bars, oldest first', c1h.length);
const c2h = await lighter.candles('ETH', '2h', now - 48 * 3600e3, now);
check(c2h.length >= 23 && c2h.length <= 25 && ordered(c2h) && c2h.every((c) => c.t % 72e5 === 0), 'candles: 2h built from 1h bars', c2h.length);
const c1m = await lighter.candles('BTC', '1m', now - 1200 * 6e4, now);
check(c1m.length >= 1100 && ordered(c1m), 'candles: 1200 1m bars paged back past the 500-bar cap', c1m.length);
const c1w = await lighter.candles('BTC', '1w', now - 20 * 6048e5, now);
check(c1w.length >= 15 && ordered(c1w) && new Date(c1w.at(-1).t).getUTCDay() === 1, 'candles: weekly bars built from days, opening Monday', c1w.length);

const book = await new Promise((ok) => {
  let n = 0;
  const stop = lighter.subBook('ETH', (b) => { if (++n >= 3) { stop(); ok(b); } });   // past the REST paint, into the stream
  setTimeout(() => { stop(); ok(null); }, 10000);
});
check(book && book.levels[0].length > 5 && book.levels[1].length > 5 && +book.levels[0][0].px < +book.levels[1][0].px
  && book.levels[0].every((l, i, a) => !i || +l.px < +a[i - 1].px) && book.levels[1].every((l, i, a) => !i || +l.px > +a[i - 1].px),
  'book: streamed, best first, bids below asks', book && `${book.levels[0][0].px} / ${book.levels[1][0].px}`);
const live = await new Promise((ok) => { const stop = lighter.subCandles('ETH', '1m', (c) => { stop(); ok(c); }); setTimeout(() => { stop(); ok(null); }, 10000); });
check(live && live.t % 6e4 === 0 && live.c > 0, 'candles: live 1m bar from the stream', live && JSON.stringify(live));
const priced = await new Promise((ok) => { const stop = lighter.watchPrices(ms, () => { stop(); ok(true); }); setTimeout(() => { stop(); ok(false); }, 10000); });
check(priced && eth.mid > 0, 'prices: market stats stream updates the list', `ETH mid ${eth.mid} · funding ${(eth.funding * 100).toFixed(5)}%/h`);

// --- the signer ----------------------------------------------------------------------
const wasm = fs.readFileSync(new URL('../../docs/vendor/lighter/main.wasm.gz', import.meta.url));
await loadSigner(wasm);
check(globalThis._signerVersion === 2, 'signer: the official wasm loads (checksum ' + SIGNER.sha256.slice(0, 12) + '…)');
const k = await newApiKey(777, 4);
const again = await signerCall('_createClientByPrv', k.prv, 304, 777, 0, 4);
check(k.pub.length === 80 && k.prv.length === 80 && again.pk === k.pub, 'signer: a fresh API key, reloaded from its stored private key', k.pub.slice(0, 16) + '…');
const o = await signerCall('_signCreateOrder', 777, 0, 5, '1000', '180000', 0, 1, 0, 0, '0', 0, 9);
const oi = JSON.parse(o.txInfo);
check(oi.AccountIndex === 777 && oi.ApiKeyIndex === 4 && oi.BaseAmount === 1000 && oi.Price === 180000 && oi.Type === 1 && oi.Nonce === 9 && Buffer.from(oi.Sig, 'base64').length === 80,
  'signer: signs an order (80-byte Schnorr signature)', o.txHash.slice(0, 16) + '…');

// --- a fresh EVM key: no account ---------------------------------------------------------
const evmKey = generatePrivateKey();
check(lighterAddress(evmKey) === privateKeyToAccount(evmKey).address, 'address from an EVM key');
let bad = false; try { lighter.connect('0x1234'); } catch { bad = true; }
check(bad, 'a short key is refused');
const store = new Map();
const kv = { get: (key, d) => (store.has(key) ? store.get(key) : d), set: (key, v) => store.set(key, v) };
const s = lighter.connect(evmKey, { store: kv });
const st = await s.state();
check(/no Lighter account/.test(st.st.venueNote) && !st.st.assetPositions.length && !st.orders.length, 'a fresh wallet: "no account" state', st.st.venueNote);
const orderErr = await tryErr(() => s.order({ coin: 'ETH', isBuy: true, sz: 0.01, type: 'market' }));
const setupErr = await tryErr(() => s.setupApiKey());
check(/no Lighter account/.test(orderErr) && /no Lighter account/.test(setupErr) && !store.size, 'a fresh wallet: order and key setup refused clearly, nothing stored', orderErr);

// --- signature proof on testnet ------------------------------------------------------------
const T = 'https://testnet.zklighter.elliot.ai/api/v1';
const A = 1000, IDX = 200;                     // an existing testnet account we do not own
const evm = privateKeyToAccount(generatePrivateKey());
await newApiKey(A, IDX, 300);                  // testnet's chain id is 300
const n = (await (await fetch(`${T}/nextNonce?account_index=${A}&api_key_index=${IDX}`)).json()).nonce;
const { body } = await signerCall('_getChangePubKeyTransaction', A, n, IDX);
const l1 = await evm.signMessage({ message: body });
check(/^Register Lighter Account/.test(body) && (await recoverMessageAddress({ message: body, signature: l1 })) === evm.address, 'key setup: the EVM key signs Lighter\'s registration text (EIP-191)', JSON.stringify(body.split('\n')[0]));
const signed = JSON.parse((await signerCall('_signChangePubKey', A, l1, n, IDX)).txInfo);
const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[5] ^= 1; return b.toString('base64'); };
const goodErr = await tryErr(() => sendTx(8, JSON.stringify(signed), T));
const badSigErr = await tryErr(() => sendTx(8, JSON.stringify({ ...signed, Sig: flip(signed.Sig) }), T));
const badFieldErr = await tryErr(() => sendTx(8, JSON.stringify({ ...signed, Nonce: signed.Nonce + 1 }), T));
console.log('       signed ChangePubKey      →', goodErr);
console.log('       one signature bit flipped →', badSigErr);
console.log('       a signed field changed    →', badFieldErr);
check(/l1 signature/i.test(goodErr) && !/invalid signature/i.test(goodErr) && /invalid signature/i.test(badSigErr) && /invalid signature/i.test(badFieldErr),
  'signing (testnet): our API-key signature passes Lighter\'s check, refused only for not owning the account; tampered ones fail it');

// mainnet sendTx from here: refused by region or reached? (informational)
const mainErr = await tryErr(() => sendTx(14, '{}', LIGHTER_API));
console.log('       mainnet sendTx from this machine →', mainErr);

console.log('');
process.exit(fails.length ? 1 : 0);
