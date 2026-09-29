// Pricing the launch shape into any quote on Robinhood Chain.
//
// The Meteora pad states its economics once and converts them into whatever
// quote is selected, using a live Jupiter quote. There is no Jupiter on this
// chain, so the rate is read off Uniswap v4 directly - and that read is the
// thing worth testing, because every number the launcher then shows is built
// from it.
//
// Two properties matter more than any single figure:
//
//   - an UNINITIALISED pool reads back zero, which is what makes "we found a
//     pool" a fact rather than a guess. A wrong PoolKey finds nothing rather
//     than finding a plausible wrong price.
//   - prices taken from different pools have to agree with each other. ETH
//     priced in a stable and ETH priced in a tokenised stock give a share price
//     when divided, and that share price is checkable against the real world.
//     This is the assertion that would catch a squared/inverted/misscaled
//     sqrtPriceX96, which a single-token test never would.
//
// Run: node test/js/rh-economics.test.mjs

import { formatUnits } from 'viem';
import { tokenPerEth, rhEconomicsFor, RH_ECONOMICS, WETH } from '../../src/rhPrice.js';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';   // 6dp stable
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';   // 18dp tokenised equity
const ZERO = '0x0000000000000000000000000000000000000000';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};
const ui = (raw, dec) => Number(formatUnits(BigInt(raw), dec));

// --- ETH is its own unit ------------------------------------------------------
const nativeR = await rhEconomicsFor({ quoteToken: ZERO, decimals: 18 });
check(ui(nativeR.graduationThreshold, 18) === RH_ECONOMICS.graduateEth
  && ui(nativeR.startMarketCap, 18) === RH_ECONOMICS.openEth,
  'a native-ETH curve gets the numbers unchanged, with no pool read at all',
  `${ui(nativeR.graduationThreshold, 18)} / ${ui(nativeR.openEth === undefined ? nativeR.startMarketCap : nativeR.startMarketCap, 18)}`);

const wrapped = await tokenPerEth({ token: WETH, decimals: 18 });
check(wrapped.perEth === 10n ** 18n && wrapped.source === 'wrapped',
  'WETH is one-for-one with ETH, and says so rather than hunting a pool', wrapped.source);

// --- real pools ---------------------------------------------------------------
const usdg = await tokenPerEth({ token: USDG, decimals: 6 });
const nvda = await tokenPerEth({ token: NVDA, decimals: 18 });
const ethUsd = ui(usdg.perEth, 6);
const nvdaPerEth = ui(nvda.perEth, 18);
console.log(`1 ETH = ${ethUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDG`);
console.log(`1 ETH = ${nvdaPerEth.toLocaleString(undefined, { maximumFractionDigits: 4 })} NVDA`);

check(usdg.source === 'v4' && nvda.source === 'v4', 'both prices come from a real, initialised v4 pool');
check(ethUsd > 200 && ethUsd < 100000, 'ETH prices in a plausible range against a dollar stable', String(Math.round(ethUsd)));

// The cross-check. Dividing the two gives NVDA's share price in dollars, and
// that is a number with a right answer outside this codebase. A squared or
// inverted sqrtPriceX96 would still produce two self-consistent-looking prices
// but would not produce a real share price here.
const nvdaUsd = ethUsd / nvdaPerEth;
console.log(`=> implied NVDA share price: $${nvdaUsd.toFixed(2)}`);
check(nvdaUsd > 20 && nvdaUsd < 2000,
  'the two pools agree: ETH/USDG divided by ETH/NVDA is a real share price',
  '$' + nvdaUsd.toFixed(2));

// --- the conversion itself -----------------------------------------------------
const r = await rhEconomicsFor({ quoteToken: USDG, decimals: 6 });
const gradUi = ui(r.graduationThreshold, 6);
const openUi = ui(r.startMarketCap, 6);
console.log(`graduate at ${gradUi.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDG, open at ${openUi.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
check(Math.abs(gradUi - RH_ECONOMICS.graduateEth * ethUsd) / gradUi < 1e-6,
  'the threshold is exactly 4.2 ETH worth of the quote');
check(Math.abs(openUi - RH_ECONOMICS.openEth * ethUsd) / openUi < 1e-6,
  'the opening cap is exactly 1.3 ETH worth of the quote');
check(Math.abs(gradUi / openUi - RH_ECONOMICS.graduateEth / RH_ECONOMICS.openEth) < 1e-6,
  'and the ratio between them survives the conversion, whatever the quote is',
  (gradUi / openUi).toFixed(6));

// --- a token with no ETH pool --------------------------------------------------
// Refusing is the point: inventing a rate would produce a threshold that looks
// fine and is meaningless.
let refused = null;
try { await tokenPerEth({ token: '0xcA11bde05977b3631167028862bE2a173976CA11', decimals: 18 }); }
catch (e) { refused = e.message; }
check(/no Uniswap v4 pool/.test(refused || ''),
  'a token with no ETH pool is refused rather than given an invented rate',
  (refused || 'it returned a price anyway').slice(0, 60) + '…');

console.log('');
process.exit(fails.length ? 1 : 0);
