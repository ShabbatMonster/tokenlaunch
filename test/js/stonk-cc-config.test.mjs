// StonkFun's "community coin" shape, and what a raise target actually buys.
//
// Two live coins, decoded rather than described: the CC at 8svf3G1X...
// ("Commie Coin", quoted in AMC) and the typical one at 5Mv6c7ta...
// ("Stonkinator", quoted in a classic SPL token). Everything that matters is
// measured off them.
//
// The interesting result is that LaunchLab's curve IS pump.fun's. The virtual
// quote reserve is 0.3529x the raise - pump's 30/85 is 0.352941 - and that holds
// across both coins despite different quotes and different decimals. So the raise
// is the only dial, and "spawns at 30, migrates at 85" is just a raise of 85.
//
// It also pins the thing most likely to be got wrong: the 30 is the VIRTUAL
// RESERVE, not the opening market cap. The opening market cap of an 85 raise is
// 27.96. Quoting one as the other misstates where a coin opens by 7%.
//
// Run: node test/js/stonk-cc-config.test.mjs

import { Connection, PublicKey } from '@solana/web3.js';
import { LAUNCHPAD_PROGRAM, LaunchpadPool, getPdaLaunchpadConfigId } from '@raydium-io/raydium-sdk-v2';
import { STONK_CC_PLATFORM_ID, STONK_CC_TRANSFER_FEE_BPS, LAUNCHLAB_CURVE_RATIOS, PUMP_RAISE_SOL } from '../../src/solana.js';
import { parseMintExtensions } from '../../src/pump.js';

const RPC = 'https://mainnet.helius-rpc.com/?api-key=ae11f74a-b518-408b-bc88-524c277da375';
const c = new Connection(RPC, 'confirmed');

const CC = '8svf3G1X4mnAX3Xm71jFXgiHydbvc5XKQKicbnokRUky';
const TYPICAL = '5Mv6c7taXXkKn4byivDALNJJZ5NGu3aB9WJVXgSVFt3p';
const AMC = 'AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TRANSFER_FEE_EXT = 1;

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

async function poolFor(mint) {
  const hits = await c.getProgramAccounts(LAUNCHPAD_PROGRAM, {
    filters: [{ dataSize: 429 }, { memcmp: { offset: 205, bytes: mint } }],
  });
  if (!hits.length) return null;
  return LaunchpadPool.decode(hits[0].account.data);
}

const cc = await poolFor(CC);
const typ = await poolFor(TYPICAL);
check(!!cc && !!typ, 'both reference coins still have live LaunchLab pools');

// --- what CC actually is ------------------------------------------------------
check(cc.platformId.toBase58() === STONK_CC_PLATFORM_ID,
  'the CC platform id is the one the live community coin launched under', cc.platformId.toBase58());
check(typ.platformId.toBase58() !== STONK_CC_PLATFORM_ID,
  'the typical coin used a different platform id', typ.platformId.toBase58());

// the config is not a separate choice - it is the per-quote PDA
const derived = getPdaLaunchpadConfigId(LAUNCHPAD_PROGRAM, new PublicKey(AMC), 0, 0).publicKey;
check(derived.equals(cc.configId),
  'the config follows from the quote, so picking AMC picks it', cc.configId.toBase58());

// the quote is Token-2022, which is why the token-program slot has to be patched
const quoteInfo = await c.getAccountInfo(cc.mintB);
const typQuoteInfo = await c.getAccountInfo(typ.mintB);
check(quoteInfo.owner.toBase58() === T22 && typQuoteInfo.owner.toBase58() !== T22,
  'the CC quote is Token-2022 and the typical one is classic SPL',
  `${quoteInfo.owner.toBase58().slice(0, 8)}… vs ${typQuoteInfo.owner.toBase58().slice(0, 8)}…`);

// and the transfer fee differs: the typical coin has NO fee extension at all
const ccExt = parseMintExtensions((await c.getAccountInfo(cc.mintA)).data);
const typExt = parseMintExtensions((await c.getAccountInfo(typ.mintA)).data);
const ccFeeBps = ccExt[TRANSFER_FEE_EXT]
  ? Buffer.from(ccExt[TRANSFER_FEE_EXT]).readUInt16LE(Buffer.from(ccExt[TRANSFER_FEE_EXT]).length - 2)
  : null;
check(ccFeeBps === STONK_CC_TRANSFER_FEE_BPS,
  'the CC mint carries a 300 bps transfer fee', String(ccFeeBps));
check(!typExt[TRANSFER_FEE_EXT],
  'the typical mint carries no transfer-fee extension at all - not a different tier, none');

// --- the curve is pump's ------------------------------------------------------
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

// --- and what 85 buys ---------------------------------------------------------
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
