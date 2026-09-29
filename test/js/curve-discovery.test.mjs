// Finding a bonding curve that has not graduated yet.
//
// Two curve shapes answer to graduated(): the Pons-style one, which exposes
// getReserves() and pairToken(), and our own AnyQuoteCurve, which exposes
// quoteReserve(), tokenReserve() and quoteToken() separately. buy() and sell()
// are identical on both, so only DISCOVERY has to know the difference.
//
// It did not, and the consequence was quiet: a null getReserves() was read as
// "this is not a curve", so a coin launched on our own factory could not be
// traded on our own swap page. The coin was fine; the reader was looking for a
// getter that was never there. This test drives a real launched curve through
// the same reads the page does.
//
// Run: node test/js/curve-discovery.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, http, getAddress, formatUnits } from 'viem';
import { ROBINHOOD } from '../../src/rhPrice.js';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const pub = createPublicClient({ chain: ROBINHOOD, transport: http(RPC, { retryCount: 6, retryDelay: 700 }) });

// Ribbit, launched on the AnyQuoteCurve factory and quoted in TIBBIR
const TOKEN = getAddress('0x8FCaF34444D5662867B0F83C5E4dA8805e80255A');
const CURVE = getAddress('0x8f3A75E53c11c0B0A66A788984a363dDF1448ee1');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

const TOKEN_ABI = [{ type: 'function', name: 'curve', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }];
const CURVE_ABI = [
  { type: 'function', name: 'graduated', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'getReserves', inputs: [], outputs: [{ type: 'uint256' }, { type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pairToken', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'quoteReserve', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'tokenReserve', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'quoteToken', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'quoteBuy', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }], stateMutability: 'view' },
];
const rd = async (fn, args) => pub.readContract({ address: CURVE, abi: CURVE_ABI, functionName: fn, args }).catch(() => null);

// --- the token points at its curve -------------------------------------------
const curve = await pub.readContract({ address: TOKEN, abi: TOKEN_ABI, functionName: 'curve' });
check(getAddress(curve) === CURVE, 'the token names its curve, which is how the page finds it', curve);

// --- the shape that broke it --------------------------------------------------
const [graduated, reserves, pairToken] = await Promise.all([rd('graduated'), rd('getReserves'), rd('pairToken')]);
check(graduated === false, 'this curve has not graduated, so the curve is still the venue');
check(reserves === null && pairToken === null,
  'AnyQuoteCurve has NO getReserves() and NO pairToken() - the old reader stopped here');

const [qr, tr, qt] = await Promise.all([rd('quoteReserve'), rd('tokenReserve'), rd('quoteToken')]);
check(qr != null && tr != null && qt != null,
  'it exposes the reserves and the quote as separate getters instead',
  `${formatUnits(qr, 18)} quote / ${Number(formatUnits(tr, 18)).toLocaleString()} tokens`);

// --- and the page now uses them ----------------------------------------------
const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'swap.js'), 'utf8');
const fn = SRC.slice(SRC.indexOf('async function findCurvePool'), SRC.indexOf('/// live, per-address snipe tax'));
check(!/if \(graduated !== false \|\| !reserves\) return \[\];/.test(fn),
  'discovery no longer treats a missing getReserves() as "not a curve"');
check(/quoteReserve/.test(fn) && /tokenReserve/.test(fn) && /quoteToken/.test(fn),
  'it falls back to the AnyQuoteCurve getters');
check(/if \(qr == null \|\| tr == null\) return \[\]/.test(fn),
  'and still refuses something that is neither shape, rather than inventing reserves');

// --- it can actually be traded ------------------------------------------------
const q = await rd('quoteBuy', [10n * 10n ** 18n]);
check(Array.isArray(q) && q[0] > 0n,
  'the curve quotes a real buy, so the page has something to trade against',
  q ? `10 quote -> ${Number(formatUnits(q[0], 18)).toLocaleString()} tokens` : 'no quote');

// --- what a sell can actually pay out -----------------------------------------
// The quote reserve is mostly virtual. What the curve can really pay is what it
// holds, and showing the virtual figure as exit liquidity would promise an exit
// that is not there.
const ERC20 = [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }];
const held = await pub.readContract({ address: qt, abi: ERC20, functionName: 'balanceOf', args: [CURVE] }).catch(() => 0n);
check(held < qr, 'the real balance is well under the (largely virtual) quote reserve',
  `holds ${formatUnits(held, 18)} vs a reserve of ${formatUnits(qr, 18)}`);
check(/exitLiquidity/.test(fn), 'the page reports that real balance as the exit liquidity');

console.log('');
process.exit(fails.length ? 1 : 0);
