// The trailing accounts LaunchLab's initialize pops, and why the count is not
// fixed.
//
// A CC launch failed on chain with 6018 NotEnoughRemainingAccounts while the
// identical code had just succeeded on the ordinary StonkFun platform. Both
// passed exactly one trailing account - the platform_curve_rule PDA - so the
// count was not the obvious thing to doubt.
//
// Strings pulled out of the deployed program explain it. There are two utils
// that read trailing accounts, and the panic paths name them:
//
//   programs/launchpad/src/utils/platform_allow_config.rs
//   programs/launchpad/src/utils/platform_curve_rule.rs
//
// along with two distinct errors, "Invalid platform allow config account" and
// "Invalid platform curve rule account". The program advances its cursor only
// for the ones a platform actually uses, so the list is positional AND
// variable-length:
//
//   ordinary platform  -> [curve_rule]
//   allow-config one   -> [allow_config, curve_rule]
//
// Passing one account to a platform that wants two is 6018. Passing two to a
// platform that wants one is 6024, because the allow config gets read as the
// curve rule. So the count has to follow the platform, and the flag byte at
// offset 832 of the PlatformConfig is what says which it is - the same byte
// that marks the three community-coin platforms.
//
// Run: node test/js/launchlab-allow-config.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import {
  Connection, PublicKey, VersionedTransaction, TransactionMessage,
} from '@solana/web3.js';
import { LAUNCHPAD_PROGRAM } from '@raydium-io/raydium-sdk-v2';
import { PLATFORM_COMMUNITY_FLAG_OFFSET, STONK_CC_PLATFORM_IDS, platformAllowWindow, readPlatformCurveRule } from '../../src/solana.js';
import { healthyRpc } from '../../src/rpc.js';

// Chosen rather than hardcoded. Every suite in this repo pinned the same key,
// so when it hit its quota they all died at once on "429 max usage reached" -
// a test failure that said nothing about the code. scanning: true keeps this
// off the public endpoint, which cannot serve getProgramAccounts.
const RPC = await healthyRpc({ scanning: true });
const c = new Connection(RPC, 'confirmed');

// the launch that failed, and the two live ones that did not
const FAILED = 'kGvfSr2t8cgayQxZBzA1TtpVPNzj9D8WfdLae9rS8qZgLwZv87kNVeTrCX9agzdqd6h2PxZqwvD9WJvCYjgYvph';
const LIVE = [
  { name: 'CC', platform: 'CUqSiwPs6C4WyntMgaFazLp7wYQfaLp5URbjUP9V7SNi', config: '7j4zuEkWm3QWPS1qhZfcFvwCALvMmrpN5xy9NweDEiZU', allow: 'GGJG5qQSMEaQL548fBU1KaT36KLetY7P4BqGveB5JFqC', quote: 'AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc' },
  { name: 'FALKLANDS', platform: 'BFYnA6ouETD2m9tGEjtyU6TV6BmqdVT2YDUMmgp9Yjv3', config: '6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX', allow: '5AfEcZtLkM1eh24ommS4YhRo5EfiLGsXFdTB87KPE94k', quote: 'So11111111111111111111111111111111111111112' },
];
const REGULAR = '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

const pda = (seed, platform, config) => PublicKey.findProgramAddressSync(
  [Buffer.from(seed), new PublicKey(platform).toBuffer(), new PublicKey(config).toBuffer()],
  LAUNCHPAD_PROGRAM,
)[0];

// --- the derivation, against both live launches -------------------------------
for (const l of LIVE) {
  check(pda('platform_allow_config', l.platform, l.config).toBase58() === l.allow,
    `the allow config is pda(platform_allow_config, platform, config) — matches ${l.name}`, l.allow);
}

// --- the flag is what decides whether it is wanted ----------------------------
const cfgData = Object.fromEntries(await Promise.all(
  [...STONK_CC_PLATFORM_IDS, REGULAR].map(async (p) => [p, (await c.getAccountInfo(new PublicKey(p))).data]),
));
check(STONK_CC_PLATFORM_IDS.every((p) => cfgData[p][PLATFORM_COMMUNITY_FLAG_OFFSET] === 1)
  && cfgData[REGULAR][PLATFORM_COMMUNITY_FLAG_OFFSET] === 0,
  'the allow-config platforms are exactly the ones with the flag byte set');

// Both of these PDAs come and go - StonkFun opens and closes allow configs per
// launch, and has since added a curve rule to the community platform that was
// not there at all when this was written. So what gets pinned is the RULE, not
// the state: the launcher's view of a window must agree with the chain, both
// ways round. An earlier version asserted "neither exists", which was a true
// observation and a worthless test - it failed the moment they opened a window.
const windows = [];
for (const l of LIVE) {
  const live = !!(await c.getAccountInfo(new PublicKey(l.allow)));
  const seen = await platformAllowWindow(RPC, l.platform, l.quote);
  windows.push({ ...l, live, seen: seen.open });
  check(seen.allowConfig === l.allow && seen.open === live,
    `platformAllowWindow agrees with the chain for ${l.name}`,
    live ? 'window OPEN' : 'window shut');
}

// --- replay the failed launch with the account it was missing ------------------
//
// The decisive test: take the transaction that failed on chain, insert the
// allow config ahead of the curve rule, and simulate. Nothing else changes.
const failed = await c.getTransaction(FAILED, { maxSupportedTransactionVersion: 0 });
check(!!failed && failed.meta.err?.InstructionError?.[1]?.Custom === 6018,
  'the failed launch is still on chain and still failed with 6018',
  JSON.stringify(failed?.meta?.err));

const keys = failed.transaction.message.getAccountKeys({ accountKeysFromLookups: failed.meta.loadedAddresses });
const ixs = failed.transaction.message.compiledInstructions;
const labIx = ixs.findIndex((ix) => keys.get(ix.programIdIndex).equals(LAUNCHPAD_PROGRAM));
const platform = keys.get(ixs[labIx].accountKeyIndexes[3]).toBase58();
const config = keys.get(ixs[labIx].accountKeyIndexes[2]).toBase58();
check(platform === LIVE[0].platform,
  'it went out under the CC platform, so an allow config was required', platform);

const allowConfig = pda('platform_allow_config', platform, config);
const curveRule = pda('platform_curve_rule', platform, config);
const tail = ixs[labIx].accountKeyIndexes.slice(-1).map((i) => keys.get(i).toBase58());
check(tail[0] === curveRule.toBase58(),
  'and it passed the curve rule as its ONLY trailing account - the slot the program reads as the allow config',
  tail[0]);

// rebuild the same transaction with the allow config inserted before the rule
const rebuilt = ixs.map((ix, n) => {
  const metas = ix.accountKeyIndexes.map((i) => ({
    pubkey: keys.get(i),
    isSigner: failed.transaction.message.isAccountSigner(i),
    isWritable: failed.transaction.message.isAccountWritable(i),
  }));
  if (n === labIx) {
    metas.pop(); // the lone curve rule
    metas.push({ pubkey: allowConfig, isSigner: false, isWritable: false });
    metas.push({ pubkey: curveRule, isSigner: false, isWritable: false });
  }
  return { programId: keys.get(ix.programIdIndex), keys: metas, data: Buffer.from(ix.data) };
});

const payer = keys.get(0);
const msg = new TransactionMessage({
  payerKey: payer,
  recentBlockhash: (await c.getLatestBlockhash()).blockhash,
  instructions: rebuilt,
}).compileToV0Message();
const sim = await c.simulateTransaction(new VersionedTransaction(msg), {
  sigVerify: false, replaceRecentBlockhash: true,
});

const logs = sim.value.logs || [];
const err = sim.value.err;
console.log('\n--- simulated with the allow config attached ---');
for (const l of logs.filter((x) => /Instruction:|AnchorError|Error|success|failed/.test(x))) console.log('   ' + l);

const ranInit = logs.some((l) => /Instruction: Initialize/.test(l));
const notEnough = logs.some((l) => /NotEnoughRemainingAccounts/.test(l));
check(ranInit && !notEnough,
  'the initialize no longer reports NotEnoughRemainingAccounts',
  err ? `now fails later with ${JSON.stringify(err)}` : 'whole transaction simulates clean');
// What happens AFTER the initialize is not this test's business, and pinning it
// was a mistake. This replays a transaction from a day ago: the wallet's balances
// have moved, the window has opened and shut, and a curve rule has appeared that
// was not there at all when it was written. At one point the assertion below read
// "3012 because the allow config does not exist" and passed for the wrong reason
// entirely - the 3012 had moved to instruction 4, a later instruction failing for
// an unrelated reason. So: assert only that the initialize itself got past the
// trailing-account problem, and report the rest.
const initFailed = err && err.InstructionError && err.InstructionError[0] === labIx;
check(!initFailed,
  'the initialize instruction itself no longer fails at all',
  err ? `a later instruction (${err.InstructionError?.[0]}) stops it instead, which is not what this pins`
    : 'whole transaction simulates clean');

// The asymmetry that IS the gate: an empty curve-rule slot is accepted, an empty
// allow config is not. Stated against whatever exists now rather than assuming.
const ruleExists = !!(await c.getAccountInfo(curveRule));
const allowExists = !!(await c.getAccountInfo(allowConfig));
console.log(`   rule ${ruleExists ? 'exists' : 'absent'} · allow config ${allowExists ? 'exists' : 'absent'}`);
check(allowExists === (await platformAllowWindow(RPC, platform, LIVE[0].quote)).open,
  'and the window the launcher reports is the existence of that allow config, nothing else');

// --- who can open the window --------------------------------------------------
//
// Only the platform admin, because a platform id IS a PDA of the admin's key.
// That is what makes this a gate rather than an inconvenience.
const [adminPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('platform_config'), new PublicKey('8sLEFiHRNEUUVyJrkigdhC6QR9XAt3u1eM9QDdasCP23').toBuffer()],
  LAUNCHPAD_PROGRAM,
);
check(adminPda.toBase58() === LIVE[0].platform,
  'the CC platform id is pda(platform_config, 8sLEFiHR…), so that key alone controls it', adminPda.toBase58());

// the window really was opened and closed around the one launch
const hist = await c.getSignaturesForAddress(new PublicKey(LIVE[0].allow), { limit: 20 });
const kinds = [];
for (const h of hist.slice().reverse()) {
  const t = await c.getTransaction(h.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (!t) continue;
  const ins = (t.meta.logMessages || []).filter((l) => /Instruction: (Create|Close)PlatformAllowConfig/.test(l));
  if (ins.length) kinds.push(ins[0].replace('Program log: Instruction: ', '') + '@' + new Date(h.blockTime * 1000).toISOString().slice(11, 16));
}
check(kinds.some((k) => k.startsWith('CreatePlatformAllowConfig')) && kinds.some((k) => k.startsWith('ClosePlatformAllowConfig')),
  'the allow config was created and then closed again, which is why the launch window shut',
  kinds.join(' -> '));

// --- the launcher refuses up front rather than paying for 3012 ----------------
const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'solana.js'), 'utf8');
const block = SRC.slice(SRC.indexOf('--- the trailing accounts'), SRC.indexOf('sequentially:false skips'));
check(/\[allowConfigId, curveRuleId\]/.test(block),
  'launchRaydium pushes the allow config BEFORE the curve rule, the order the program pops them');
const pre = SRC.slice(SRC.indexOf('const platformInfo = platformId'), SRC.indexOf('// A raise target stated by the caller'));
check(/platform_allow_config/.test(pre) && /PLATFORM_COMMUNITY_FLAG_OFFSET\]\s*===\s*1/.test(pre),
  'it derives the allow config only when the platform flag asks for one');
check(/throw new Error\(/.test(pre) && /only the platform admin can create it/.test(pre),
  'and throws before building when no window is open, instead of paying for a doomed transaction');

const w = await platformAllowWindow(RPC, LIVE[0].platform, 'So11111111111111111111111111111111111111112');
check(w.open === false && w.allowConfig,
  'platformAllowWindow reports the window shut, which is what the pad shows before you sign',
  w.allowConfig);

console.log('');
process.exit(fails.length ? 1 : 0);
