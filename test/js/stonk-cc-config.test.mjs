// What actually earns StonkFun's "community coin" badge.
//
// The first version of this test got it wrong in an instructive way. It
// compared ONE badged coin (8svf3G1X..., quoted in the Token-2022 stock
// AMC1qwR9..., 300 bps transfer fee) against one typical coin (5Mv6c7ta...,
// classic SPL quote, no fee) and concluded that CC meant "Token-2022 quote plus
// a 300 bps fee". Every assertion passed. The conclusion was still wrong,
// because a difference between two samples is not a cause.
//
// What settles it is a byte-diff of the two PlatformConfigs. They are 944 bytes
// and differ in exactly two places: `epoch` (when each was last written) and
// offset 832, which is 1 on the badged platform and 0 on the ordinary one.
// Offset 832 is the first byte of what the SDK's bundled layout still calls
// padding, so it is a field the deployed program grew and the layout has not
// caught up with.
//
// Two more badged platforms exist, and they are the counterexamples that kill
// the original theory: FALKLANDS and VISIONARY both quote plain WSOL with
// classic-SPL, zero-fee mints, and carry the flag anyway.
//
// Run: node test/js/stonk-cc-config.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { LAUNCHPAD_PROGRAM, LaunchpadPool, getPdaLaunchpadConfigId } from '@raydium-io/raydium-sdk-v2';
import {
  STONK_CC_PLATFORM_ID, STONK_CC_PLATFORM_IDS, STONK_CC_TRANSFER_FEE_BPS,
  PLATFORM_COMMUNITY_FLAG_OFFSET, PLATFORM_CONFIG_SIZE, readPlatformConfig,
  LAUNCHLAB_CURVE_RATIOS, PUMP_RAISE_SOL,
} from '../../src/solana.js';
import { parseMintExtensions } from '../../src/pump.js';

const RPC = 'https://mainnet.helius-rpc.com/?api-key=ae11f74a-b518-408b-bc88-524c277da375';
const c = new Connection(RPC, 'confirmed');

const CC = '8svf3G1X4mnAX3Xm71jFXgiHydbvc5XKQKicbnokRUky';       // the badged reference
const TYPICAL = '5Mv6c7taXXkKn4byivDALNJJZ5NGu3aB9WJVXgSVFt3p';  // an ordinary one
const AMC = 'AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc';
const WSOL = 'So11111111111111111111111111111111111111112';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TRANSFER_FEE_EXT = 1;

// the ordinary storefronts, which hold essentially all the volume
const REGULAR = [
  '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt',
  '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7',
];

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

const POOL_PLATFORM_OFFSET = 173;
const POOL_MINT_OFFSET = 205;
async function poolFor(mint) {
  const hits = await c.getProgramAccounts(LAUNCHPAD_PROGRAM, {
    filters: [{ dataSize: 429 }, { memcmp: { offset: POOL_MINT_OFFSET, bytes: mint } }],
  });
  return hits.length ? LaunchpadPool.decode(hits[0].account.data) : null;
}

const cc = await poolFor(CC);
const typ = await poolFor(TYPICAL);
check(!!cc && !!typ, 'both reference coins still have live LaunchLab pools');

// --- the flag, which is the whole mechanism ----------------------------------
const cfg = Object.fromEntries(await Promise.all(
  [...STONK_CC_PLATFORM_IDS, ...REGULAR].map(async (p) => [p, (await c.getAccountInfo(new PublicKey(p))).data]),
));

check(Object.values(cfg).every((d) => d.length === PLATFORM_CONFIG_SIZE),
  'every PlatformConfig is the same 944 bytes, so offsets are comparable');

const flag = (p) => cfg[p][PLATFORM_COMMUNITY_FLAG_OFFSET];
const nameOf = (p) => cfg[p].slice(112, 176).toString('utf8').replace(/\0+$/, '').trim();

check(STONK_CC_PLATFORM_IDS.every((p) => flag(p) === 1),
  'all three badged platforms have the flag byte SET',
  STONK_CC_PLATFORM_IDS.map((p) => `${nameOf(p)}=${flag(p)}`).join(' '));
check(REGULAR.every((p) => flag(p) === 0),
  'both ordinary storefronts have it CLEAR',
  REGULAR.map((p) => `${p.slice(0, 8)}…=${flag(p)}`).join(' '));
check(STONK_CC_PLATFORM_IDS.includes(cc.platformId.toBase58()),
  'the live badged coin launched under one of them', cc.platformId.toBase58());
check(REGULAR.includes(typ.platformId.toBase58()),
  'and the ordinary coin did not', typ.platformId.toBase58());

// Nothing ELSE differs. This is the assertion that makes the flag the cause
// rather than one of several candidates: diff the two configs byte by byte and
// only `epoch` (offset 8..15) and the flag may come back different.
const diff = [];
for (let i = 0; i < PLATFORM_CONFIG_SIZE; i++) {
  if (cfg[STONK_CC_PLATFORM_ID][i] !== cfg[REGULAR[0]][i]) diff.push(i);
}
const EPOCH = [8, 16];
const unexplained = diff.filter((i) => !(i >= EPOCH[0] && i < EPOCH[1]) && i !== PLATFORM_COMMUNITY_FLAG_OFFSET);
check(unexplained.length === 0,
  'a CC config and a regular one differ ONLY in epoch and that one flag byte',
  `${diff.length} bytes differ, ${unexplained.length} unexplained`);

// --- the counterexamples ------------------------------------------------------
//
// If CC meant "Token-2022 quote with a transfer fee", these two could not exist.
for (const p of STONK_CC_PLATFORM_IDS.filter((x) => x !== STONK_CC_PLATFORM_ID)) {
  const hits = await c.getProgramAccounts(LAUNCHPAD_PROGRAM, {
    filters: [{ dataSize: 429 }, { memcmp: { offset: POOL_PLATFORM_OFFSET, bytes: p } }],
  });
  if (!hits.length) { console.log(`SKIP  ${nameOf(p)} has no pool any more`); continue; }
  const pool = LaunchpadPool.decode(hits[0].account.data);
  const mintInfo = await c.getAccountInfo(pool.mintA);
  const isT22 = mintInfo.owner.toBase58() === T22;
  check(pool.mintB.toBase58() === WSOL && !isT22,
    `${nameOf(p)} is badged while quoting plain WSOL with a classic-SPL mint`,
    `${pool.mintA.toBase58().slice(0, 8)}… quote ${pool.mintB.toBase58().slice(0, 8)}…`);
}

// --- and nothing gates launching under one ------------------------------------
//
// No curve rule exists for any badged platform, while both ordinary ones have
// one - and a rule is what pins the curve params and the fee tier. So on a CC
// platform the raise and the transfer fee are free to set, and on a regular one
// they are not.
const ruleFor = (platform, config) => PublicKey.findProgramAddressSync(
  [Buffer.from('platform_curve_rule'), new PublicKey(platform).toBuffer(), new PublicKey(config).toBuffer()],
  LAUNCHPAD_PROGRAM,
)[0];
const wsolConfig = getPdaLaunchpadConfigId(LAUNCHPAD_PROGRAM, new PublicKey(WSOL), 0, 0).publicKey;
const rules = await Promise.all(
  [...STONK_CC_PLATFORM_IDS, ...REGULAR].map((p) => c.getAccountInfo(ruleFor(p, wsolConfig))),
);
const ccRules = rules.slice(0, STONK_CC_PLATFORM_IDS.length);
const regRules = rules.slice(STONK_CC_PLATFORM_IDS.length);
check(ccRules.every((r) => !r),
  'no platform_curve_rule exists for any badged platform, so nothing is pinned');
check(regRules.every((r) => !!r),
  'both ordinary storefronts DO have one, which is what pins their fee tier',
  regRules.map((r) => r.data.length + 'B').join(' '));

// the initialize transactions prove it is permissionless: creator + mint only
const ccPoolKey = (await c.getProgramAccounts(LAUNCHPAD_PROGRAM, {
  filters: [{ dataSize: 429 }, { memcmp: { offset: POOL_MINT_OFFSET, bytes: CC } }],
}))[0].pubkey;
const sigs = await c.getSignaturesForAddress(ccPoolKey, { limit: 1000 });
const init = await c.getTransaction(sigs[sigs.length - 1].signature, { maxSupportedTransactionVersion: 0 });
const keys = init.transaction.message.getAccountKeys({ accountKeysFromLookups: init.meta.loadedAddresses });
const signers = Array.from({ length: init.transaction.message.header.numRequiredSignatures }, (_, i) => keys.get(i).toBase58());
check(signers.length === 2 && signers.includes(CC) && !signers.includes(STONK_CC_PLATFORM_ID),
  'the badged launch was signed by the creator and the new mint only - no platform admin',
  signers.map((s) => s.slice(0, 8) + '…').join(' + '));

// --- the reader the launcher uses ---------------------------------------------
const readCC = await readPlatformConfig(RPC, STONK_CC_PLATFORM_ID);
const readReg = await readPlatformConfig(RPC, REGULAR[0]);
check(readCC.community === true && readReg.community === false,
  'readPlatformConfig reports the badge for both, so the page can show it before signing',
  `${readCC.name}=${readCC.community} / ${readReg.name}=${readReg.community}`);

// --- the pads ------------------------------------------------------------------
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
const padBlock = (id) => {
  const at = MAIN.indexOf(`id: '${id}'`);
  return at < 0 ? '' : MAIN.slice(at, MAIN.indexOf('\n  },', at));
};
const ccPad = padBlock('stonk-cc-sol');
const regPad = padBlock('stonk-sol');
check(STONK_CC_PLATFORM_IDS.some((p) => ccPad.includes(p)),
  'the CC pad launches under a badged platform id');
check(!STONK_CC_PLATFORM_IDS.some((p) => regPad.includes(p)),
  'and the ordinary pad does not, so the two pads are genuinely different');
check(/transferFeeChoices:\s*\[\s*0\s*,/.test(ccPad),
  'the CC pad offers a 0 bps tier, since no rule pins the fee there');
check(/token2022:\s*false/.test(MAIN) && /transferFeeBps:/.test(MAIN),
  'and a 0 tier sends token2022: false rather than a zero-fee extension');

// --- the traits that turned out to be incidental -------------------------------
//
// Still recorded, because they are what the pad defaults to - just no longer
// asserted as the cause of anything.
const quoteInfo = await c.getAccountInfo(cc.mintB);
check(getPdaLaunchpadConfigId(LAUNCHPAD_PROGRAM, new PublicKey(AMC), 0, 0).publicKey.equals(cc.configId),
  'the config still follows from the quote, so picking AMC picks it', cc.configId.toBase58());
const ccExt = parseMintExtensions((await c.getAccountInfo(cc.mintA)).data);
const ccFeeBps = ccExt[TRANSFER_FEE_EXT]
  ? Buffer.from(ccExt[TRANSFER_FEE_EXT]).readUInt16LE(Buffer.from(ccExt[TRANSFER_FEE_EXT]).length - 2)
  : null;
check(ccFeeBps === STONK_CC_TRANSFER_FEE_BPS,
  'the reference CC carries 300 bps - the pad default, not a requirement', String(ccFeeBps));

// --- the curve is pump's -------------------------------------------------------
const ratios = (p, quoteDecimals) => {
  const vA = Number(p.virtualA.toString()) / 1e6;
  const vB = Number(p.virtualB.toString()) / 10 ** quoteDecimals;
  const raise = Number(p.totalFundRaisingB.toString()) / 10 ** quoteDecimals;
  const supply = Number(p.supply.toString()) / 1e6;
  const sold = Number(p.totalSellA.toString()) / 1e6;
  return {
    virtual: vB / raise,
    startMcap: (vB / vA) * supply / raise,
    finalMcap: ((vB + raise) / (vA - sold)) * supply / raise,
  };
};
const typQuoteInfo = await c.getAccountInfo(typ.mintB);
const rCC = ratios(cc, quoteInfo.data.readUInt8(44));
const rTyp = ratios(typ, typQuoteInfo.data.readUInt8(44));
console.log(`\nCC  ratios: virtual ${rCC.virtual.toFixed(6)}  start ${rCC.startMcap.toFixed(6)}  final ${rCC.finalMcap.toFixed(4)}`);
console.log(`TYP ratios: virtual ${rTyp.virtual.toFixed(6)}  start ${rTyp.startMcap.toFixed(6)}  final ${rTyp.finalMcap.toFixed(4)}`);

const near = (a, b, tol) => Math.abs(a - b) <= tol;
check(near(rCC.virtual, rTyp.virtual, 1e-5),
  'the curve shape is identical across two different quotes and decimals');
check(near(rCC.virtual, 30 / 85, 1e-4),
  "the virtual reserve is pump's 30/85 ratio", `${rCC.virtual.toFixed(6)} vs ${(30 / 85).toFixed(6)}`);
check(near(rCC.virtual, LAUNCHLAB_CURVE_RATIOS.virtualPerRaise, 1e-5)
  && near(rCC.startMcap, LAUNCHLAB_CURVE_RATIOS.startMcapPerRaise, 1e-5)
  && near(rCC.finalMcap, LAUNCHLAB_CURVE_RATIOS.finalMcapPerRaise, 1e-3),
  'the constants the launcher shows match what the live pools do');

// --- and what 85 buys ----------------------------------------------------------
const r = LAUNCHLAB_CURVE_RATIOS;
const virtual = PUMP_RAISE_SOL * r.virtualPerRaise;
const open = PUMP_RAISE_SOL * r.startMcapPerRaise;
const final = PUMP_RAISE_SOL * r.finalMcapPerRaise;
console.log(`\na raise of ${PUMP_RAISE_SOL}: virtual ${virtual.toFixed(3)}, opens at ${open.toFixed(3)}, migrates at ${final.toFixed(2)}`);
check(near(virtual, 30, 0.01), 'a raise of 85 puts the virtual reserve at 30', virtual.toFixed(4));
check(near(open, 27.96, 0.02), 'but the OPENING MARKET CAP is 27.96, not 30', open.toFixed(4));
check(Math.abs(open - 30) > 1.5,
  'the two differ enough that calling the open "30" is wrong by ~7%',
  `${(100 * (30 - open) / open).toFixed(1)}%`);

console.log('');
process.exit(fails.length ? 1 : 0);
