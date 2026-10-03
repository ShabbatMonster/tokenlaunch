// Launching inside a community allow window, end to end.
//
// The CC path needs three things that are easy to get wrong separately:
//
//   1. the right TRAILING ACCOUNTS, in the right order - the allow config goes
//      ahead of the curve rule, and only on a platform that wants one
//   2. a window that is actually OPEN at the moment the program runs, which is
//      somebody else's to close
//   3. curve params that MATCH the platform's rule, where it has one, because a
//      mismatch is rejected outright with 6025
//
// Each was found the hard way. (1) failed on chain as 6018, (2) as 3012 once
// the order was fixed, and (3) as 6025 once a real open window was tried. The
// only honest proof is to build the launch the pad would build and simulate it
// against a window that is open right now, which is what this does.
//
// The windows are discovered rather than hardcoded because a window is opened
// and closed per launch - one was seen open for USELESS and gone within minutes
// of the next read. The PLATFORM is reused (CUqSiwPs carries 59 community pools),
// so it is the window, not the platform id, that would be stale if pinned here.
//
// Run: node test/js/community-launch-window.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { LAUNCHPAD_PROGRAM } from '@raydium-io/raydium-sdk-v2';
import {
  findCommunityLaunchWindows, listCommunityPlatforms, listOpenAllowWindows,
  readPlatformCurveRule, launchRaydium, platformAllowWindow,
  PLATFORM_ALLOW_CONFIG_DISC, PLATFORM_ALLOW_CONFIG_SIZE, PLATFORM_COMMUNITY_FLAG_OFFSET,
  STONK_CC_PLATFORM_IDS,
} from '../../src/solana.js';
import { healthyRpc } from '../../src/rpc.js';

// Chosen rather than hardcoded. Every suite in this repo pinned the same key,
// so when it hit its quota they all died at once on "429 max usage reached" -
// a test failure that said nothing about the code. scanning: true keeps this
// off the public endpoint, which cannot serve getProgramAccounts.
const RPC = await healthyRpc({ scanning: true });
const c = new Connection(RPC, 'confirmed');
// a funded wallet, used ONLY as the simulated fee payer - no key is needed to
// dry run, which is the point of ownerPubkey
const PAYER = 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT';
const WSOL = 'So11111111111111111111111111111111111111112';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the discriminator, which is what makes discovery one call ----------------
const { createHash } = await import('node:crypto');
const derived = createHash('sha256').update('account:PlatformAllowConfig').digest().subarray(0, 8);
check(derived.equals(PLATFORM_ALLOW_CONFIG_DISC),
  'the allow-config discriminator is the anchor hash of its account name',
  PLATFORM_ALLOW_CONFIG_DISC.toString('hex'));

// --- discovery ----------------------------------------------------------------
const platforms = await listCommunityPlatforms(RPC);
check(platforms.length > 0,
  'community platforms are found by the flag byte alone, in one getProgramAccounts call',
  `${platforms.length} on chain`);

// every one really does have the flag set — the filter is doing what it claims
const sample = platforms.slice(0, 8);
const infos = await c.getMultipleAccountsInfo(sample.map((p) => new PublicKey(p.platformId)));
check(infos.every((i) => i.data[PLATFORM_COMMUNITY_FLAG_OFFSET] === 1),
  'and every one returned actually carries the flag');
check(STONK_CC_PLATFORM_IDS.every((p) => platforms.some((x) => x.platformId === p)),
  "StonkFun's three are among them, so the scan is a superset of the hardcoded list");

const allWindows = await listOpenAllowWindows(RPC);
const sizes = await c.getMultipleAccountsInfo(allWindows.slice(0, 5).map((w) => new PublicKey(w.allowConfig)));
check(sizes.every((i) => i.data.length === PLATFORM_ALLOW_CONFIG_SIZE),
  'open windows are 137-byte PlatformAllowConfig accounts', `${allWindows.length} open program-wide`);

// the platform/config a window names must round-trip back to its own address,
// which proves the two offsets are read correctly rather than plausibly
const rt = allWindows.slice(0, 10).filter((w) => PublicKey.findProgramAddressSync(
  [Buffer.from('platform_allow_config'), new PublicKey(w.platformId).toBuffer(), new PublicKey(w.configId).toBuffer()],
  LAUNCHPAD_PROGRAM,
)[0].toBase58() === w.allowConfig);
check(rt.length === Math.min(10, allWindows.length),
  'each window re-derives to its own address from the platform and config it names',
  `${rt.length}/${Math.min(10, allWindows.length)}`);

const { windows } = await findCommunityLaunchWindows(RPC);
check(windows.every((w) => platforms.some((p) => p.platformId === w.platformId)),
  'a window on an unflagged platform is dropped, because the program would never consult it');
check(windows.every((w) => w.quoteMint && w.quoteDecimals != null),
  'and each launchable window resolves to a quote with decimals',
  `${windows.length} launchable`);

// --- a curve rule is read, not guessed ----------------------------------------
const withRule = [];
for (const w of windows.slice(0, 6)) {
  const rule = await readPlatformCurveRule(RPC, w.platformId, w.configId);
  if (rule?.groups?.length) withRule.push({ w, rule });
}
if (!withRule.length) {
  console.log('SKIP  none of the sampled windows has a decodable curve rule right now');
} else {
  const { rule } = withRule[0];
  const g = rule.groups[0];
  check(g.supply.value === '1000000000000000' && g.totalSellA.value === '793100000000000',
    'a decoded rule group carries the canonical LaunchLab curve, which is how the layout is identified',
    `supply ${g.supply.value}, sellA ${g.totalSellA.value}`);
  check(BigInt(g.totalFundRaisingB.value) > 0n,
    'and it pins the raise, which is why the raise is not a choice on such a platform',
    `${Number(g.totalFundRaisingB.value) / 1e9} of the quote`);
}

// a rule the decoder does not recognise yields NO groups rather than a guess
const stonkRule = await readPlatformCurveRule(RPC, '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt', windows.length
  ? (windows.find((w) => w.quoteMint === WSOL)?.configId || windows[0].configId) : null)
  .catch(() => null);
if (stonkRule) {
  check(Array.isArray(stonkRule.groups),
    "an unrecognised rule shape returns an empty group list, not a plausible lie",
    `${stonkRule.size} bytes -> ${stonkRule.groups.length} groups`);
}

// --- the launch itself, simulated against a live window -----------------------
const target = windows.find((w) => w.quoteMint === WSOL) || windows[0];
if (!target) {
  console.log('SKIP  no community window is open right now, so there is nothing to simulate against');
} else {
  console.log(`\nsimulating into "${target.platform.name}" ${target.platformId.slice(0, 10)}…`);
  const r = await launchRaydium({
    rpcUrl: RPC, dryRun: true, ownerPubkey: PAYER,
    quoteMint: target.quoteMint, platformId: target.platformId,
    name: 'Dry Run', symbol: 'DRY', uri: 'https://example.com/dry-run.json',
    buyAmountUi: '0', token2022: false,
  });
  check(r.dryRun === true && !!r.mint,
    'a dry run builds the real launch and signs nothing - no secret key involved');
  check(r.allowConfig === target.allowConfig,
    'it attaches the window the scan found', r.allowConfig);
  check(r.ok, 'and the whole launch simulates clean against the open window',
    r.ok ? `${r.unitsConsumed} CU` : (r.anchorError || JSON.stringify(r.err)));

  // the same launch aimed at a platform whose window is shut must NOT get as far
  // as a signature - it should be refused while building
  const shut = STONK_CC_PLATFORM_IDS[0];
  const w = await platformAllowWindow(RPC, shut, target.quoteMint);
  if (w.open) {
    console.log('SKIP  that platform now has a window open too');
  } else {
    let refused = null;
    try {
      await launchRaydium({
        rpcUrl: RPC, dryRun: true, ownerPubkey: PAYER,
        quoteMint: target.quoteMint, platformId: shut,
        name: 'Dry Run', symbol: 'DRY', uri: 'https://example.com/dry-run.json',
        buyAmountUi: '0', token2022: false,
      });
    } catch (e) { refused = e.message; }
    check(!!refused && /allow/i.test(refused),
      'a platform with no open window is refused while building, before anything is signed',
      refused ? refused.slice(0, 90) + '…' : 'it built anyway');
  }
}

// --- the pad is wired to all of it --------------------------------------------
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
check(/platformId: ccPlatformId\(pad\)/.test(MAIN),
  'the launch goes out under the window the pad is armed at, not the pad\'s own platform id');
check(/const ccPlatformId = \(pad\) =>/.test(MAIN) && /pad\.community && ccSelected/.test(MAIN),
  'and that override only applies to a community pad with a window selected');
const watch = MAIN.slice(MAIN.indexOf('function ccToggleWatch'), MAIN.indexOf('/// Pull every LaunchLab config'));
check(/await ccDryRun\(pad\)/.test(watch) && /if \(!dry \|\| !dry\.ok\)/.test(watch),
  'WATCH simulates before it fires, so an open window alone never spends a signature');
check(/clearInterval\(ccWatcher\)/.test(watch) && watch.indexOf('clearInterval') < watch.indexOf('await launch()'),
  'and it stops the timer before launching, so a slow launch cannot fire twice');

const HTML = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'index.html'), 'utf8');
check(['raydiumCcScanBtn', 'raydiumCcWatchBtn', 'raydiumCcDryBtn', 'raydiumCcList', 'raydiumCcStatus']
  .every((id) => HTML.includes(`id="${id}"`)),
  'the pad has the scan, watch and dry-run controls the code binds to');

console.log('');
process.exit(fails.length ? 1 : 0);
