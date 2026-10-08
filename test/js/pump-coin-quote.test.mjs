// Pairing a new pump coin against another pump coin.
//
// From pump's 2026-10-07 update: "New Pump coins can be paired with any
// previously created Pump coin that are paired with SOL, USDC or one of the
// mints in the quote control PDA."
//
// The quote control PDA turns out to be the account this repo already calls
// PUMP_QUOTE_REGISTRY - both are pda(['quote-control']) - so the registry is the
// base case and a pump coin is a new recursive one. That is asserted below
// rather than assumed, because it is the sort of coincidence worth checking.
//
// Everything else was decoded off the two live examples rather than read out of
// the announcement:
//
//   EXgYtzKh...pump  quoted in GDz2tXD7...pump, which is quoted in SOL
//   E4q7cAYJ...pump  quoted in 9yPESNHi...pump, which is quoted in 9cRCn9rG...pump
//
// so the chain runs deeper than one. Both are still create_v2 - same
// discriminator - carrying 24 accounts instead of 20.
//
// Run: node test/js/pump-coin-quote.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  pumpCurve, pumpCoinQuoteAccounts, pumpProbe, pumpStatus, PUMP_QUOTE_REGISTRY,
} from '../../src/pump.js';
import { healthyRpc } from '../../src/rpc.js';

const RPC = await healthyRpc({ scanning: true });
const c = new Connection(RPC, 'confirmed');
const PAYER = 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT';

const LIVE_A = 'E4q7cAYJQ8ai5hBjwyNXatby6MLTTzvRjh93qpE3pump';
const LIVE_B = 'EXgYtzKhUNGjW35bitKaet8haHAiCjKzci3oaS4spump';
const QUOTE_B = 'GDz2tXD7DG2hBRe9fJcmFqWYTmkp4svedN5uKG5Epump';   // migrated, quoted in SOL
const QUOTE_A = '9yPESNHi6EzA8tvc94pqSuwLsmyx8FFnujZN2BpEpump';   // migrated, quoted in a pump coin
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the quote control PDA is the registry ------------------------------------
const [quoteControl] = PublicKey.findProgramAddressSync([Buffer.from('quote-control')], PUMP_PROGRAM);
check(quoteControl.equals(PUMP_QUOTE_REGISTRY),
  "the announcement's quote control PDA is the registry this repo already passes",
  quoteControl.toBase58());

// --- the live pairs are what the announcement describes ------------------------
for (const [label, coin, expectedQuote] of [['B', LIVE_B, QUOTE_B], ['A', LIVE_A, QUOTE_A]]) {
  const curve = await pumpCurve(c, coin);
  check(!!curve && curve.quoteMint.toBase58() === expectedQuote,
    `${label} is a pump coin quoted in another pump coin`, curve?.quoteMint.toBase58());
}
// A's quote is quoted in ANOTHER pump coin, which reads like a two-deep chain.
// It is not: that third link is itself a quote-control mint, so the rule is the
// one level the announcement states. An earlier version of this test asserted
// the recursion and passed, because the third link really is a pump coin - it
// just happens to be a registry one too, which is the fact that decides it.
const innerA = await pumpCurve(c, QUOTE_A);
const registryMints = new Set(((await pumpStatus(RPC)).whitelistedQuotes || []).map((q) => q.mint));
check(!!innerA && registryMints.has(innerA.quoteMint.toBase58()),
  "A's quote is paired with a quote-control mint - one level of indirection, not a chain",
  innerA?.quoteMint.toBase58());
check(registryMints.size > 50, 'and that registry is the one read off chain', `${registryMints.size} mints`);

// --- the four extra accounts ---------------------------------------------------
const acc = await pumpCoinQuoteAccounts(c, QUOTE_B);
check(!!acc, 'a pump coin quote resolves to its own liquidity accounts');
check(acc.complete, 'which requires it to have migrated - before that there is no pool');
check(acc.pool.toBase58() === '6AxyN8NUxe6bJS1gHRPvtQVDEFEtfagDpPHzjQjsVZGm',
  'the pool matches the one the live create_v2 passed', acc.pool.toBase58());
check(acc.poolBaseVault.toBase58() === 'zv464vngByqTejnVtQTZrDfGnpG1QvtC2daPHsiBGUP'
  && acc.poolQuoteVault.toBase58() === '4VvDbGft8yTRz9j3o5b3jsbK1YofNtzFttGnNdMR4Tjt',
  'and so do both of its vaults');
check(acc.curve.toBase58() === '5RwMp4RHcKLCZ1YF6HaYiHxTL9aRKfNaPZQR887sRWwE',
  "plus the quote's own bonding curve");

// the curve stores native SOL as the all-zero pubkey while the pool holds WSOL,
// so the pairing has to be translated rather than copied across
check(acc.innerQuote.toBase58() === 'So11111111111111111111111111111111111111112',
  'native SOL is translated to wrapped SOL for the pool pairing', acc.innerQuote.toBase58());

// --- not everything with that PDA is a curve ------------------------------------
//
// Probing every quote this way made pumpCurve read pda(['bonding-curve', USDC]),
// a real but unrelated account, and reading reserves off it threw
// ERR_BUFFER_OUT_OF_BOUNDS instead of answering "not a pump coin".
const notACoin = await pumpCoinQuoteAccounts(c, USDC);
check(notACoin === null, 'an ordinary mint resolves to null rather than throwing');
const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'pump.js'), 'utf8');
check(/info\.owner\.equals\(PUMP_PROGRAM\) \|\| info\.data\.length < 81/.test(SRC),
  'because pumpCurve checks the owner and length before decoding');

// --- the instruction carries them only when it should ---------------------------
check(/quote\.pumpCoin \? \[/.test(SRC),
  'create_v2 appends the four extra accounts only for a pump-coin quote');
// Sliced from the START of createV2Ix, not from the first PUMP_QUOTE_REGISTRY in
// the file - that one is the constant's own declaration near the top, so the
// slice ended before the function began and both lookups returned -1. The
// assertion then compared -1 < -1 and failed while the code was correct.
const fnAt = SRC.indexOf('function createV2Ix');
const ix = SRC.slice(fnAt, SRC.indexOf('\n}', fnAt));
const atReg = ix.indexOf('PUMP_QUOTE_REGISTRY');
const atCurve = ix.indexOf('pumpCoin.curve');
check(atReg > -1 && atCurve > -1 && atReg < atCurve,
  'and after the quote control PDA, which is the order the live transaction used',
  `registry@${atReg} < curve@${atCurve}`);
check(ix.indexOf('pumpCoin.pool') < ix.indexOf('pumpCoin.poolBaseVault')
  && ix.indexOf('pumpCoin.poolBaseVault') < ix.indexOf('pumpCoin.poolQuoteVault'),
  'with the pool before its vaults, base before quote, as [21][22][23] were');

// --- and it simulates -----------------------------------------------------------
const probe = async (quoteMint) => pumpProbe({
  rpcUrl: RPC, payerPubkey: PAYER, name: 'Pair Test', symbol: 'PAIR',
  uri: 'https://example.com/m.json', devBuySol: 0, quoteMint,
});
for (const [label, q] of [['a SOL-quoted pump coin', QUOTE_B], ['a pump-coin-quoted pump coin', QUOTE_A]]) {
  const r = await probe(q);
  check(r.ready && r.whitelisted, `a launch against ${label} simulates clean`,
    r.ready ? 'ready' : (r.reason || (r.blockers || []).join('; ')));
}

// the controls: nothing that worked before may have changed shape
for (const [label, q] of [['USDC', USDC], ['native SOL', undefined]]) {
  const r = await probe(q);
  check(r.ready, `and ${label} still launches, so the 20-account path is untouched`, r.reason || '');
}

// --- the registry is still the other way in -------------------------------------
const g = await pumpStatus(RPC);
check((g.whitelistedQuotes || []).length > 50,
  'the quote registry is still read and still large, so this adds a route rather than replacing one',
  `${g.whitelistedQuotes.length} admitted`);
check(/inRegistry \|\| asPumpCoin/.test(SRC),
  'and pairability is reported as either route, not just the registry');

console.log('');
process.exit(fails.length ? 1 : 0);
