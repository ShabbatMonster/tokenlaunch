// StonkFun changed their default launch, and what changed is the pairing.
//
// Their earlier launches paired against a stablecoin or a tokenised stock and
// raised a few thousand units of it (2uBW1oWE... raised 3,653 AMC;
// 5Mv6c7ta... raised 41,935 STONK). The new ones pair against WSOL and raise
// exactly 85 - pump's shape, with a virtual quote reserve of 30.0008.
//
// The pad's default raise was a single quote-agnostic unit count, 3,274.601594,
// lifted from a letsbonk.fun launch. That number cannot be right across assets
// worth $1 and assets worth $200: scaled to 9 decimals it comes out at 3,274
// SOL, which is not a launch anybody intends. It would not have been REJECTED -
// the rule leaves the raise free - just absurd, which is the worse failure.
//
// Reference: 9bHxUoXsy6qoV4o9z5joMYoPts7bqR3mPokRw66dHHaU
//
// Run: node test/js/stonk-default-launch.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { LAUNCHPAD_PROGRAM, LaunchpadPool } from '@raydium-io/raydium-sdk-v2';
import { launchRaydium, readPlatformCurveRule, WSOL_MINT } from '../../src/solana.js';
import { parseMintExtensions } from '../../src/pump.js';
import { healthyRpc } from '../../src/rpc.js';

// Chosen rather than hardcoded. Every suite in this repo pinned the same key,
// so when it hit its quota they all died at once on "429 max usage reached" -
// a test failure that said nothing about the code. scanning: true keeps this
// off the public endpoint, which cannot serve getProgramAccounts.
const RPC = await healthyRpc({ scanning: true });
const c = new Connection(RPC, 'confirmed');

const REF = '9bHxUoXsy6qoV4o9z5joMYoPts7bqR3mPokRw66dHHaU';
const PLATFORM = '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt';
const WSOL_CONFIG = '6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX';
const PAYER = 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the reference launch -----------------------------------------------------
const hits = await c.getProgramAccounts(LAUNCHPAD_PROGRAM, {
  filters: [{ dataSize: 429 }, { memcmp: { offset: 205, bytes: REF } }],
});
check(hits.length === 1, 'the reference launch still has a LaunchLab pool');
const ref = LaunchpadPool.decode(hits[0].account.data);

check(ref.platformId.toBase58() === PLATFORM,
  'it went out on the ordinary StonkFun storefront, not a community platform', ref.platformId.toBase58());
check(ref.mintB.toBase58() === WSOL_MINT && ref.configId.toBase58() === WSOL_CONFIG,
  'and it pairs against WSOL - the change', ref.configId.toBase58());
check(ref.totalFundRaisingB.toString() === '85000000000',
  'raising exactly 85 SOL', ref.totalFundRaisingB.toString());

// the 85 is pump's: the virtual quote reserve lands on 30
const virtualB = Number(ref.virtualB.toString()) / 1e9;
check(Math.abs(virtualB - 30) < 0.01,
  'which puts the virtual quote reserve at 30, so the shape is pump 30/85', virtualB.toFixed(6));

// the base mint is Token-2022 with a 100 bps fee, as before
const mintInfo = await c.getAccountInfo(ref.mintA);
const ext = parseMintExtensions(mintInfo.data);
const feeBuf = ext[1] ? Buffer.from(ext[1]) : null;
check(mintInfo.owner.toBase58() === T22 && feeBuf?.readUInt16LE(feeBuf.length - 2) === 100,
  'the base mint is still Token-2022 at 100 bps, so that part did not change');

// --- what the rule actually pins ---------------------------------------------
//
// The interesting part is what it does NOT pin. Field 5 is the raise, and it is
// absent from both groups, which is why 85 is a CHOICE rather than something
// the chain would have corrected.
const rule = await readPlatformCurveRule(RPC, PLATFORM, WSOL_CONFIG);
check(rule?.groups?.length === 2,
  'the platform rule decodes to two groups', `${rule?.size} bytes -> ${rule?.groups?.length} groups`);
const [g1, g2] = rule.groups;
check(g1 && !g1.totalFundRaisingB && !g2.totalFundRaisingB,
  'neither group constrains the raise - an absent field is an unconstrained one');
check(g1.supply.value === '1000000000000000' && g1.totalSellA.value === '793100000000000',
  'both pin the supply and the amount sold on the curve');
const tiers = rule.groups.map((g) => g.transferFeeBps?.value);
check(tiers.includes('100') && tiers.includes('300'),
  'and they differ only in the transfer-fee tier, which IS pinned', tiers.join(' / '));
check(JSON.stringify(g1.fields) === JSON.stringify(g2.fields),
  'the two groups constrain the same field set', g1.fields.join(','));

// --- the pad's defaults -------------------------------------------------------
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
const pad = MAIN.slice(MAIN.indexOf("id: 'stonk-sol'"), MAIN.indexOf('\n  },', MAIN.indexOf("id: 'stonk-sol'")));
check(/defaultQuote: 'SOL'/.test(pad),
  'the pad now defaults to the SOL pairing rather than whatever sorts first');
check(/transferFeeBps: 100/.test(pad) && /transferFeeChoices: \[100, 300\]/.test(pad),
  'and offers exactly the two tiers the rule allows');
const quotes = MAIN.slice(MAIN.indexOf('const STONK_QUOTES = ['), MAIN.indexOf('];', MAIN.indexOf('const STONK_QUOTES = [')));
check(quotes.indexOf("symbol: 'SOL'") < quotes.indexOf("symbol: 'SKR'"),
  'SOL is first in the list too, so the dropdown agrees with the default');

// --- the launch our pad would send, against the real thing --------------------
const dry = await launchRaydium({
  rpcUrl: RPC, dryRun: true, ownerPubkey: PAYER,
  quoteMint: WSOL_MINT, platformId: PLATFORM,
  name: 'Fit Test', symbol: 'FIT', uri: 'https://example.com/x.json',
  buyAmountUi: '0', migrateType: 'cpmm', token2022: true, transferFeeBps: 100,
});
check(dry.ok, 'the pad defaults simulate clean on the live platform',
  dry.ok ? `${dry.unitsConsumed} CU` : (dry.anchorError || JSON.stringify(dry.err)));

const diffs = [
  ['supply', dry.curve.supply, ref.supply.toString()],
  ['totalSellA', dry.curve.totalSellA, ref.totalSellA.toString()],
  ['totalFundRaisingB', dry.curve.totalFundRaisingB, ref.totalFundRaisingB.toString()],
  ['quoteMint', dry.curve.quoteMint, ref.mintB.toBase58()],
  ['configId', dry.curve.configId, ref.configId.toBase58()],
  ['platformId', dry.platformId, ref.platformId.toBase58()],
  ['migrateType', dry.curve.migrateType === 'cpmm' ? 1 : 0, ref.migrateType],
].filter(([, a, b]) => String(a) !== String(b));
check(diffs.length === 0,
  'and every curve field it would write matches the reference launch',
  diffs.length ? diffs.map(([k, a, b]) => `${k}: ${a} != ${b}`).join('; ') : '8 fields');

// --- the other tier is allowed, and nothing else is ---------------------------
const at300 = await launchRaydium({
  rpcUrl: RPC, dryRun: true, ownerPubkey: PAYER, quoteMint: WSOL_MINT, platformId: PLATFORM,
  name: 'Fit Test', symbol: 'FIT', uri: 'https://example.com/x.json',
  buyAmountUi: '0', migrateType: 'cpmm', token2022: true, transferFeeBps: 300,
});
check(at300.ok, 'the 300 bps tier simulates too, since the rule lists it',
  at300.ok ? `${at300.unitsConsumed} CU` : (at300.anchorError || JSON.stringify(at300.err)));

// A tier the rule does not list has to be refused up front, by name, rather
// than coming back as an opaque 6025 after the transaction is paid for.
for (const [label, opts] of [
  ['a 0 bps tier', { token2022: true, transferFeeBps: 0 }],
  ['a plain SPL mint', { token2022: false }],
]) {
  let refused = null;
  try {
    await launchRaydium({
      rpcUrl: RPC, dryRun: true, ownerPubkey: PAYER, quoteMint: WSOL_MINT, platformId: PLATFORM,
      name: 'Fit Test', symbol: 'FIT', uri: 'https://example.com/x.json',
      buyAmountUi: '0', migrateType: 'cpmm', ...opts,
    });
  } catch (e) { refused = e.message; }
  check(!!refused && /100 or 300 bps/.test(refused) && /this launch is/.test(refused),
    `${label} is refused while building, naming what the rule accepts and what this is`,
    refused ? refused.slice(0, 96) + '…' : 'it built anyway');
}

// --- the default is quote-aware, which is the actual fix ----------------------
//
// 85 applies to SOL. A non-SOL quote keeps the old fallback, because 85 SOL in
// another asset needs a price, which is what the pad's ECONOMICS button is for.
const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'solana.js'), 'utf8');
const fn = SRC.slice(SRC.indexOf('function curveRaiseTargetRaw'), SRC.indexOf('/// Human quote amount -> raw'));
check(/if \(quoteMint === WSOL_MINT\) return CURVE_RAISE_SOL;/.test(fn),
  'the raise default takes the quote into account instead of scaling one number by decimals');
check(/CURVE_RAISE_SOL = new BN\('85000000000'\)/.test(SRC),
  'and the SOL default is 85 SOL exactly');
check(/curveRaiseTargetRaw\(mintBInfo\.decimals, configInfo\.mintB\.toBase58\(\)\)/.test(SRC),
  'the call site actually passes the quote, or the default silently stays the old one');

console.log('');
process.exit(fails.length ? 1 : 0);
