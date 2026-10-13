// Pairing a new pump coin against another pump coin, at any depth.
//
// Every bonding curve stores a `depth`: 0 for a coin paired with SOL, USDC or a
// listed quote mint, and the quote's depth plus one for a coin paired with a
// pump coin. pump caps it with Global.max_curve_depth and refuses more than 5
// whatever that says. Depth 2 went live on 2026-10-13.
//
// This file first asserted the opposite - that pump allowed "one level of
// indirection, not a chain" - and passed, because the evidence it had was:
//
//   EXgYtzKh...pump  quoted in GDz2tXD7...pump, which is quoted in SOL
//   E4q7cAYJ...pump  quoted in 9yPESNHi...pump, which is quoted in 9cRCn9rG...pump
//
// and 9cRCn9rG, which looks like a third link, is a quote-control mint. Both of
// those coins really are depth 1 and really do carry one account group. What the
// evidence showed was where a chain ENDS, not that chains were forbidden, and
// the two readings are only told apart by a coin that is genuinely two deep.
//
// There is one now, which is what this suite is pinned to:
//
//   EJUe9f9b...pump  depth 2, quoted in GHYTsT2B...pump (on its curve),
//                    which is quoted in 8kDWbhFy...pump (migrated), on SOL
//
// Its create_v2 carries 25 accounts - the 16 fixed ones, then nine. Those nine
// are the ground truth below, including the packing: because GHYTsT2B is still
// on its curve, its group is five slots, not eight, and the next coin's curve
// sits at index 5 rather than 8.
//
// Run: node test/js/pump-coin-quote.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  pumpCurve, pumpQuoteChain, pumpQuoteChainAccounts, pumpCoinQuoteAccounts,
  pumpProbe, pumpStatus, PUMP_QUOTE_REGISTRY, MAX_CURVE_DEPTH,
} from '../../src/pump.js';
import { healthyRpc } from '../../src/rpc.js';

const RPC = await healthyRpc({ scanning: true });
const c = new Connection(RPC, 'confirmed');
const PAYER = 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT';

const D2 = 'EJUe9f9buQVzEFu2YwBorVzY63mEf4BLoJTLJxsfpump';         // depth 2
const D2_QUOTE = 'GHYTsT2BNZBc3xdvqFor331LcUWoLLRhoQuwWzH8pump';   // depth 1, on its curve
const D2_BOTTOM = '8kDWbhFyZBEu1yYRZ1PNKRyQhTJ7zYdHAz8rYkFWpump';  // depth 0, migrated, SOL
const LIVE_A = 'E4q7cAYJQ8ai5hBjwyNXatby6MLTTzvRjh93qpE3pump';     // depth 1
const LIVE_B = 'EXgYtzKhUNGjW35bitKaet8haHAiCjKzci3oaS4spump';     // depth 1
const QUOTE_B = 'GDz2tXD7DG2hBRe9fJcmFqWYTmkp4svedN5uKG5Epump';    // depth 0, migrated, SOL
const QUOTE_A = '9yPESNHi6EzA8tvc94pqSuwLsmyx8FFnujZN2BpEpump';    // depth 0, migrated, listed quote
const BOTH = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump';       // pump coin AND listed quote
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

const g = await pumpStatus(RPC);
const listed = g.registry;
const listedMints = new Set(listed.map((r) => r.mint));

// --- the cap is read, not assumed ---------------------------------------------
const [quoteControl] = PublicKey.findProgramAddressSync([Buffer.from('quote-control')], PUMP_PROGRAM);
check(quoteControl.equals(PUMP_QUOTE_REGISTRY),
  "the quote control PDA is the registry this repo already passes", quoteControl.toBase58());
check(typeof g.maxCurveDepth === 'number' && g.maxCurveDepth >= 1,
  'Global.max_curve_depth is decoded off the end of the account', String(g.maxCurveDepth));
check(g.maxCurveDepth >= 2,
  'and it reads 2 or more, which is what pump enabling depth 2 on 13 Oct 2026 looks like on chain',
  String(g.maxCurveDepth));
check(MAX_CURVE_DEPTH === 5, "the program's own ceiling is exported as 5, independent of that");

// --- the stored depth and the walked depth agree -------------------------------
//
// Two independent derivations: one reads BondingCurve.depth straight off the
// account, the other follows each curve's stored quote_mint until it reaches
// something listed. They have to land on the same number, or the account list is
// the wrong shape.
for (const [label, mint, expect] of [
  ['8kDWbhFy (SOL)', D2_BOTTOM, 0],
  ['9yPESNHi (listed quote)', QUOTE_A, 0],
  ['GDz2tXD7 (SOL, migrated)', QUOTE_B, 0],
  ['GHYTsT2B', D2_QUOTE, 1],
  ['EXgYtzKh', LIVE_B, 1],
  ['E4q7cAYJ', LIVE_A, 1],
  ['EJUe9f9b', D2, 2],
]) {
  const curve = await pumpCurve(c, mint);
  check(!!curve && curve.depth === expect, `${label} records depth ${expect} on its curve`,
    curve ? `depth ${curve.depth}` : 'no curve');
}
for (const [label, mint] of [['GHYTsT2B', D2_QUOTE], ['EXgYtzKh', LIVE_B], ['GDz2tXD7', QUOTE_B]]) {
  const chain = await pumpQuoteChain(c, mint, listed);
  check(!!chain && chain.depth === chain.storedDepth,
    `walking ${label}'s chain lands on the depth its curve records`,
    chain ? `walked ${chain.depth}, stored ${chain.storedDepth}` : 'null');
}
// A short curve account has no depth byte at all - the field is only written
// once a nested coin exists - and absent has to mean 0, not a read past the end.
const short = await pumpCurve(c, D2_BOTTOM);
check(!!short && short.depth === 0, 'a curve account too short to hold the byte reads as depth 0');

// --- a listed mint is depth 0 for its children, chain or not --------------------
//
// 9cRCn9rG is both a pump coin and a quote-control mint. The program counts it as
// depth 0 whatever its own depth and does not read the extra accounts for it, so
// the walker has to refuse it rather than treat it as a nested quote - which is
// what it would do if "is it a pump coin" were the only question asked.
check(!!(await pumpCurve(c, BOTH)), '9cRCn9rG really is a pump coin');
check(listedMints.has(BOTH), 'and really is a listed quote mint');
check((await pumpQuoteChain(c, BOTH, listed)) === null,
  'so it resolves to no chain at all - listed wins, and none of these accounts are read for it');

// --- not everything with that PDA is a curve -----------------------------------
//
// Probing every quote this way made pumpCurve read pda(['bonding-curve', USDC]),
// a real but unrelated account, and reading reserves off it threw
// ERR_BUFFER_OUT_OF_BOUNDS instead of answering "not a pump coin".
check((await pumpCoinQuoteAccounts(c, USDC)) === null,
  'an ordinary mint resolves to null rather than throwing');
const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'pump.js'), 'utf8');
check(/info\.owner\.equals\(PUMP_PROGRAM\) \|\| info\.data\.length < 81/.test(SRC),
  'because pumpCurve checks the owner and length before decoding');

// --- the depth-1 account group, still what the live transaction carried ---------
const d1 = await pumpQuoteChain(c, QUOTE_B, listed);
check(!!d1 && d1.links.length === 1, 'a depth-0 quote walks to one group');
check(!!d1 && d1.migrated, 'GDz2tXD7 has migrated, so its group carries the pool trio');
const d1acc = pumpQuoteChainAccounts(d1).map((a) => a.toBase58());
check(d1acc.length === 4, 'four accounts from slot 4: curve, pool, base vault, quote vault',
  `${d1acc.length}`);
check(d1acc[0] === '5RwMp4RHcKLCZ1YF6HaYiHxTL9aRKfNaPZQR887sRWwE'
  && d1acc[1] === '6AxyN8NUxe6bJS1gHRPvtQVDEFEtfagDpPHzjQjsVZGm'
  && d1acc[2] === 'zv464vngByqTejnVtQTZrDfGnpG1QvtC2daPHsiBGUP'
  && d1acc[3] === '4VvDbGft8yTRz9j3o5b3jsbK1YofNtzFttGnNdMR4Tjt',
  'and they are the four the live depth-1 create_v2 passed', d1acc.join(' '));
// the curve stores native SOL as the all-zero pubkey while the pool holds WSOL,
// so the pairing has to be translated rather than copied across
check(d1.innerQuote.toBase58() === 'So11111111111111111111111111111111111111112',
  'native SOL is translated to wrapped SOL for the pool pairing', d1.innerQuote.toBase58());

// --- the depth-2 account groups, against the live transaction ------------------
//
// This is the assertion the earlier version of this file could not have made.
// create_v2 for EJUe9f9b carried 25 accounts; these are remaining accounts 4
// through 8, read off the confirmed transaction
// FcuwLoTADtfkE442MNQzoVStwWPXQYZUSmkhCGBm4PiTFzgngBu8H43sQyjbZjAuccnpmMh7jT4WumTyX27xws5
const LIVE_D2 = [
  'BugDeaXXAkeZjAXkWvQCLMJLhTHVFbDGFesd23uCSesa',  // [20] GHYTsT2B's curve
  'FjNnRkTpyVphk9iTvvzedGgWh2niez1KGZfDrjepM99S',  // [21] 8kDWbhFy's curve
  'SS75mths5DEhVBmP86DoXQbaX4drAY58fiP1wBqBF9q',   // [22] 8kDWbhFy's pool
  '7HcbutJh5RhiwPGikdLEHV53KhT8HcFF5dxhfLTegxZx',  // [23] that pool's base vault
  'B4m7JTe9WZRvHnGqRh93zjWMWELrGyyYaRdTbfasgFHo',  // [24] that pool's quote vault
];
const d2 = await pumpQuoteChain(c, D2_QUOTE, listed);
check(!!d2 && d2.links.length === 2, 'a depth-1 quote walks to two groups',
  d2 ? `${d2.links.length}` : 'null');
check(!!d2 && d2.links[0].mint.toBase58() === D2_QUOTE && d2.links[1].mint.toBase58() === D2_BOTTOM,
  'nearest coin first, down to the depth-0 coin');
check(!!d2 && d2.newDepth === 2, 'and a coin created against it would be depth 2', `${d2?.newDepth}`);
check(!!d2 && d2.bottomEligible, "whose chain bottoms out on SOL, so it is eligible");
const d2acc = pumpQuoteChainAccounts(d2).map((a) => a.toBase58());
check(d2acc.length === LIVE_D2.length && d2acc.every((a, i) => a === LIVE_D2[i]),
  'all five remaining accounts match the live depth-2 create_v2, in order',
  d2acc.join(' '));

// The packing is the part that is easy to get wrong: appending a fixed four per
// coin would put 8kDWbhFy's curve at index 8 instead of 5, because GHYTsT2B has
// NOT migrated and contributes five slots rather than eight. Slots are
// positional, so that is a different instruction, not a padded one.
check(!!d2 && d2.links[0].migrated === false,
  'GHYTsT2B is still on its curve, so it contributes no pool accounts');
check(!!d2 && d2.links[1].migrated === true, 'and 8kDWbhFy has migrated, so it contributes all four');
check(d2acc.length === 5, 'which packs to five accounts, not eight', `${d2acc.length}`);
check(d2acc[1] === LIVE_D2[1],
  "so the next coin's curve sits at index 5 - the packed position, as the live tx had it");

// --- the two earlier live coins are depth 1, as they always were ----------------
for (const [label, coin, expectedQuote] of [['EXgYtzKh', LIVE_B, QUOTE_B], ['E4q7cAYJ', LIVE_A, QUOTE_A]]) {
  const curve = await pumpCurve(c, coin);
  check(!!curve && curve.quoteMint.toBase58() === expectedQuote,
    `${label} is a pump coin quoted in another pump coin`, curve?.quoteMint.toBase58());
}
const innerA = await pumpCurve(c, QUOTE_A);
check(!!innerA && listedMints.has(innerA.quoteMint.toBase58()),
  "E4q7cAYJ's quote is paired with a quote-control mint, which is where its chain ends",
  innerA?.quoteMint.toBase58());
check(listedMints.size > 50, 'and that registry is the one read off chain', `${listedMints.size} mints`);

// --- the instruction builds the list rather than spelling it out ----------------
const fnAt = SRC.indexOf('function createV2Ix');
const ix = SRC.slice(fnAt, SRC.indexOf('\n}', fnAt));
check(/pumpQuoteChainAccounts\(quote\.pumpChain\)/.test(ix),
  'create_v2 appends whatever the walker returns, so the packing lives in one place');
const atReg = ix.indexOf('PUMP_QUOTE_REGISTRY');
const atChain = ix.indexOf('pumpQuoteChainAccounts');
check(atReg > -1 && atChain > -1 && atReg < atChain,
  'after the quote control PDA, which is the order every live transaction used',
  `registry@${atReg} < chain@${atChain}`);
// The two refusals this file used to encode, both of which the 2026-10-13 spec
// contradicts: a quote may sit on its own curve, and a chain is allowed.
check(!/has not migrated yet, so it has no PumpSwap pool/.test(SRC),
  'the "quote must have migrated" blocker is gone - a quote on its curve is legal, '
  + 'it just passes five slots instead of eight');
check(!/one level of indirection, not a chain/.test(SRC),
  'and so is the "not a chain" blocker');
// what replaced them, each named after the error the program actually returns
for (const [needle, label] of [
  ['QuoteBondingCurveNotEligible', 'an ineligible chain bottom is reported as 6100'],
  ['QuoteCurveAwaitingMigration', 'a sold-out curve with no pool yet is reported as 6107, and called retryable'],
  ['CurveDepthExceeded', 'and too deep is reported as 6105, against the live cap'],
]) {
  check(SRC.includes(needle), label);
}

// --- and every depth simulates --------------------------------------------------
const probe = async (quoteMint) => pumpProbe({
  rpcUrl: RPC, payerPubkey: PAYER, name: 'Depth Test', symbol: 'DEEP',
  uri: 'https://example.com/m.json', devBuySol: 0, quoteMint,
});
for (const [label, q] of [
  ['depth 1, against a migrated SOL-quoted coin', QUOTE_B],
  ['depth 1, against a migrated listed-quote coin', QUOTE_A],
  ['depth 2, against a coin still on its curve over a migrated SOL coin', D2_QUOTE],
  ['depth 2, against EXgYtzKh', LIVE_B],
  ['depth 2, against E4q7cAYJ', LIVE_A],
]) {
  const r = await probe(q);
  check(r.ready && r.whitelisted, `a launch at ${label} simulates clean`,
    r.ready ? `${r.unitsConsumed} units` : (r.reason || (r.blockers || []).join('; ')));
}

// the controls: nothing that worked before may have changed shape
for (const [label, q] of [['USDC', USDC], ['native SOL', undefined]]) {
  const r = await probe(q);
  check(r.ready, `and ${label} still launches, so the 20-account path is untouched`, r.reason || '');
}

// --- the registry is still the other way in -------------------------------------
check((g.whitelistedQuotes || []).length > 50,
  'the quote registry is still read and still large, so this adds a route rather than replacing one',
  `${g.whitelistedQuotes.length} admitted`);
check(/inRegistry \|\| asPumpCoin/.test(SRC),
  'and pairability is reported as either route, not just the registry');
// Pairability must NOT require the quote to have migrated any more - that was the
// old rule, and reading it off `complete` would quietly refuse a legal pairing.
check(/asPumpCoin = !!quote\?\.pumpChain\?\.bottomEligible/.test(SRC),
  'pairable now means "its chain bottoms out somewhere listed", not "it has migrated"');

console.log('');
process.exit(fails.length ? 1 : 0);
