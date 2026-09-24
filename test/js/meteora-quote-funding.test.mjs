// Funding the quote side of a Meteora launch through Jupiter.
//
// A curve quoted in anything but SOL is funded in that thing: the dev buy
// spends the quote token, and so does every trade on the curve. A wallet
// holding nothing but SOL cannot buy its own launch, and the SOL balance in the
// header does not say so.
//
// The one that bites: Jupiter's lite API reports NO decimals for the output
// mint - not at the top level, not inside routePlan - so an amount read off a
// route and divided by a guessed 10^9 is wrong by a thousand on a USDC route.
// Decimals are read from the mint instead. This test pins that, because the
// field disappearing again would be silent.
//
// Run: node test/js/meteora-quote-funding.test.mjs

import { previewSwapIntoQuote, quoteHoldings, swapIntoQuote } from '../../src/solana.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const RPC = 'https://api.mainnet-beta.solana.com';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the decimals trap ------------------------------------------------------
const raw = await (await fetch('https://lite-api.jup.ag/swap/v1/quote?' + new URLSearchParams({
  inputMint: SOL, outputMint: USDC, amount: '500000000', slippageBps: '100',
}))).json();
const jupSaysDecimals = raw.outputMintDecimals
  ?? raw.routePlan?.[raw.routePlan.length - 1]?.swapInfo?.outputMintDecimals;
console.log('Jupiter reports outputMintDecimals:', jupSaysDecimals ?? 'no');

const p = await previewSwapIntoQuote({ rpcUrl: RPC, quoteMint: USDC, uiSol: '0.5' });
console.log(`0.5 SOL -> ${p.out} USDC (${p.decimals}dp) via ${p.route.join(' -> ')}`);

check(p.decimals === 6, 'USDC is scaled at six decimals, read from the mint', String(p.decimals));
// A thousandfold scaling error is the failure mode, so the band is wide on
// purpose: it catches the bug without pretending to know the SOL price.
check(p.out > 5 && p.out < 5000, 'half a SOL comes out as a plausible number of USDC', String(p.out));
check(p.route.length > 0, 'the route is named rather than hidden', p.route.join(' -> '));

// --- holdings ---------------------------------------------------------------
const owner = 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT';
const sol = await quoteHoldings({ rpcUrl: RPC, owner, quoteMint: SOL });
const usdc = await quoteHoldings({ rpcUrl: RPC, owner, quoteMint: USDC });
console.log(`${owner.slice(0, 8)}… holds ${sol.ui} SOL and ${usdc.ui} USDC`);
check(sol.isNative && sol.decimals === 9, 'a SOL quote reads the native balance, not a token account');
check(!usdc.isNative && usdc.decimals === 6, 'a USDC quote reads its token account at six decimals');

// --- refusals ---------------------------------------------------------------
let refused = null;
try { await previewSwapIntoQuote({ rpcUrl: RPC, quoteMint: SOL, uiSol: '1' }); }
catch (e) { refused = e.message; }
check(!!refused, 'swapping SOL into SOL is refused rather than routed', refused ?? 'not refused');

// The launch is still paid for in SOL - rent for the mint, two vaults and the
// metadata account - so a swap that empties the wallet has to be stopped.
const broke = Keypair.generate();
let headroom = null;
try {
  await swapIntoQuote({ rpcUrl: RPC, secretKey: bs58.encode(broke.secretKey), quoteMint: USDC, uiSol: '1' });
} catch (e) { headroom = e.message; }
check(/leave too little behind/.test(headroom || ''),
  'a swap that would leave nothing for the launch is stopped before signing', headroom ?? 'not stopped');

console.log('');
process.exit(fails.length ? 1 : 0);
