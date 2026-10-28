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

import { previewSwapIntoQuote, quoteHoldings, swapIntoQuote, devBuyShortfall } from '../../src/solana.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const RPC = 'https://api.mainnet-beta.solana.com';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Backpack's tokenised SNAP: a 6-decimal Token-2022 quote that carries its own
// ticker and is badged by Meteora
const SNAP_MINT = 'SNAPcESrvnH8yUdgeMF6xm1hym9b6hW6s8YeqeHdZFz';
const BURNER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';

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

// --- a dev buy the wallet cannot cover ---------------------------------------
//
// The old message read "dev buy needs 1000000000 of the quote token in base
// units and the wallet holds 102562083", which is the same two numbers with the
// decimal point left out - on a 6-decimal quote that is 1,000 against 102.56.
{
  const msg = devBuyShortfall({
    needed: '1000000000', held: '102562083', decimals: 6, symbol: 'SNAP',
    mint: 'SNAPcESrvnH8yUdgeMF6xm1hym9b6hW6s8YeqeHdZFz',
  });
  check(/1,000 SNAP/.test(msg) && /holds 102\.562083 SNAP/.test(msg),
    "a dev buy short of the quote is said in whole tokens, with the quote's own ticker", msg.slice(0, 80));
  check(/897\.437917 short/.test(msg), 'and names the shortfall, which is the number that decides what to do next');
  check(/funded in SNAP, not SOL/.test(msg), 'and says what funds it, since the header balance is SOL');
  const unnamed = devBuyShortfall({ needed: '1000000000', held: '0', decimals: 6, mint: 'SNAPcESrvnH8yUdgeMF6xm1hym9b6hW6s8YeqeHdZFz' });
  check(/of the quote token \(SNAPcE…\)/.test(unnamed) && !/undefined|null/.test(unnamed),
    'a quote with no ticker on chain is named by its mint instead', unnamed.slice(0, 70));
}

// A Token-2022 quote carries its own ticker, so a pasted mint can be labelled
// in what it spends rather than in the word QUOTE.
{
  const h = await quoteHoldings({ rpcUrl: RPC, owner: BURNER, quoteMint: SNAP_MINT }).catch((e) => ({ err: e.message }));
  check(h.symbol === 'SNAP' && h.decimals === 6,
    'a pasted Token-2022 quote is read with its ticker and decimals', h.err || `${h.symbol} / ${h.decimals}dp`);
}

console.log('');
process.exit(fails.length ? 1 : 0);
