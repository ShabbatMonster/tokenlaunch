// Abyss / Black Market launches on Robinhood Chain, driven by the project's own
// SDK. Every live case plans the launch and then eth_calls the transaction the
// SDK builds, so a pass means the launch would actually execute.
//
// The three rules that cause almost every rejection are each covered:
//   * fee rows unique + ascending, summing to 10000bps per asset
//   * rewardMode must agree with whether any row pays holders
//   * no interior tick gaps, ticks aligned to the tier's spacing
// Plus the one that is easy to miss: the launched token has to sort ABOVE the
// pair token or the one-sided ladder is upside down (TOPOLOGY_OPENING_GAP).
//   node test/js/abyss-launch.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import { createProtocolPublicClient, getAddresses } from '@black-market/sdk';
import {
  abyssPlan, abyssPlanDraft, abyssGeometry, abyssQuotes, abyssTier, abyssAddresses, resolveAbyssQuote,
  ABYSS_FEE_TIER_LIST, ABYSS_PROFILES, ABYSS_PRESETS, ABYSS_CHAIN_ID,
  LifecycleRewardMode, LifecycleTokenKind,
} from '../../src/abyssLaunch.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
const RPC = process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const E = 10n ** 18n;

// --- wiring -------------------------------------------------------------------
check(ABYSS_CHAIN_ID === 4663, 'the pad is on Robinhood Chain');
check(abyssAddresses().launchOrchestrator.toLowerCase() === '0x91560876033d568d25cde98c78c33ff8fc43962c',
  'and points at LaunchOrchestratorV1 from the SDK, not a hardcoded guess');
check(ABYSS_FEE_TIER_LIST.length === 8 && ABYSS_FEE_TIER_LIST.some((t) => t.label === '0.01%') && ABYSS_FEE_TIER_LIST.some((t) => t.label === '15%'),
  'all 8 fee tiers are offered, including the ones the site does not advertise', ABYSS_FEE_TIER_LIST.map((t) => t.label).join(' '));
check(ABYSS_PROFILES.length === 4 && ABYSS_PROFILES.every((p) => typeof p.poolProfile === 'number' && typeof p.oracle === 'boolean'),
  'each pool profile carries its config byte and whether it takes an oracle');
const pad = MAIN.slice(MAIN.indexOf("id: 'abyss-robinhood'"), MAIN.indexOf("id: 'abyss-robinhood'") + 700);
check(pad.length > 100 && /family: 'abyss'/.test(pad) && /chainId: 4663/.test(pad), 'main.js has the Abyss pad');
for (const id of ['abyssQuote', 'abyssCap', 'abyssFee', 'abyssRewardMode', 'abyssShare', 'abyssBurn', 'abyssPreset', 'abyssPositions', 'abyssProfile', 'abyssKind', 'abyssDevBuy', 'abyssSummary']) {
  check(HTML.includes(`id="${id}"`), `UI has #${id}`);
}
check(/STARTING MARKET CAP \(<span id="abyssCapSym">/.test(HTML), 'the starting market cap is a field, priced in the pair token');
check(HTML.includes('id="abyssQuoteCustom"') && /'custom…'/.test(MAIN), 'and any ERC-20 can be pasted as the pair token');
check(/resolveAbyssCustomQuote/.test(MAIN) && /abyssSelectedQuote/.test(MAIN), 'a pasted pair token is resolved off chain, not assumed');
check(/for \(const pre of built\.planned\.prerequisites/.test(MAIN), 'an ERC-20 dev buy approves the funding escrow first');
check(/async function launchAbyss/.test(MAIN) && /abyssPlan\(client, \{ \.\.\.f, metadataURI \}\)/.test(MAIN), 'and the launch goes through the SDK plan');

// --- the geometry, no RPC -------------------------------------------------------
{
  const [eth] = abyssQuotes();
  check(eth.symbol === 'ETH', 'ETH is the default pair');
  const usdg = abyssQuotes().find((q) => q.symbol === 'USDG');
  check(usdg.decimals === 6 && usdg.address === '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    'USDG is carried as 6 decimals with a valid checksum (18 would be wrong by 1e12)');
  // the opening market cap is what sets the price
  const g = (cap) => abyssGeometry({ supply: 1_000_000_000n * E, openingValuationQuote: cap, feePips: 20000, positions: 6, preset: 'staircase' });
  const a = g(10n * E), b = g(100n * E);
  // the launched token is the pool's token1, so a higher token price is a LOWER
  // tick - the direction matters when reading these numbers
  check(b.recipe.launchTick < a.recipe.launchTick, 'a higher opening market cap prices the token higher (lower tick, since it is token1)', `${a.recipe.launchTick} -> ${b.recipe.launchTick}`);
  check(a.ranges.positions.length === 6 && a.ranges.tokenAmountMaximum === 1_000_000_000n * E,
    'the whole supply goes into the ladder, nothing pre-sold', `${(Number(a.ranges.tokenAmountMaximum) / 1e18).toLocaleString()} tokens`);
  check(a.ranges.positions.every((p, i, all) => i === 0 || all[i - 1].tickLower === p.tickUpper),
    'the bands are contiguous, which is what the orchestrator demands');
  check(abyssTier(20000).tickSpacing === 400 && a.ranges.positions.every((p) => p.tickLower % 400 === 0 || p.tickLower === -887200),
    'and aligned to the fee tier\'s tick spacing');
  let threw = '';
  try { abyssTier(1234); } catch (e) { threw = e.message; }
  check(/not an Abyss fee tier/.test(threw), 'an invalid fee tier is refused with the valid list');
}

// --- the rules the orchestrator enforces, refused up front ------------------------
{
  const [eth] = abyssQuotes();
  const base = { creator: '0x7cb44b8693b3c350a2bcd4b681af85365aa27783', name: 'A', symbol: 'A', supply: 1_000_000_000n * E, quote: eth, feePips: 20000, positions: 6, preset: 'staircase', openingValuationQuote: 10n * E };
  const refuses = (o, re, label) => {
    let msg = '';
    try { abyssPlanDraft({ ...base, ...o }); } catch (e) { msg = e.message; }
    check(re.test(msg), label, msg.slice(0, 85) || 'it was ACCEPTED');
  };
  refuses({ rewardsBps: 5000 }, /reward mode set to staking or dividends/, 'a holders\' share without a reward mode is refused');
  refuses({ rewardMode: LifecycleRewardMode.Dividends }, /need a share of the fees pointed at holders/, 'dividends with no holders\' share is refused');
  refuses({ tokenKind: LifecycleTokenKind.ERC404 }, /needs a unit size/, 'an ERC-404 with no unit size is refused');
  refuses({ preset: 'nope' }, /not an Abyss liquidity preset/, 'an unknown liquidity preset is refused');
  refuses({ positions: 0 }, /between 1 and 16/, 'zero positions is refused');
}

const client = createProtocolPublicClient({ chainId: ABYSS_CHAIN_ID });
if (!(await client.getBlockNumber().catch(() => null))) { console.log('SKIP  Robinhood RPC unreachable'); process.exit(fails.length ? 1 : 0); }

// --- live: plan it, then prove the built transaction executes ----------------------
const CREATOR = '0x7cb44b8693b3c350a2bcd4b681af85365aa27783';   // funded on RH chain; read-only
const [ETHQ, USDGQ] = abyssQuotes();
const base = { creator: CREATOR, name: 'Abyss Wire', symbol: 'AWIRE', supply: 1_000_000_000n * E, quote: ETHQ, feePips: 20000, positions: 6, preset: 'staircase', openingValuationQuote: 10n * E };
// a generous gas cap: these launches mint several liquidity positions and the
// node's default eth_call cap is far below what 6+ bands need
const exec = async (tx) => (await (await fetch(RPC, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: CREATOR, to: tx.to, data: tx.data, value: '0x' + BigInt(tx.value ?? 0n).toString(16), gas: '0x3b9aca00' }, 'latest'] }),
})).json());

async function live(label, o, extra) {
  try {
    const r = await abyssPlan(client, { ...base, ...o });
    const x = await exec(r.tx);
    check(!!x.result, label, x.result ? (extra ? extra(r) : `token ${r.token.slice(0, 10)}… tick ${r.recipe.launchTick}`)
      : 'revert ' + JSON.stringify(x.error?.data ?? x.error?.message).slice(0, 60));
    return r;
  } catch (e) { check(false, label, 'ERR ' + (e.message || '').split('\n')[0].slice(0, 80)); return null; }
}

const first = await live('a launch executes: 1B supply, ETH pair, 2% fee', {});
if (first) {
  check(BigInt(first.token) > BigInt(ETHQ.address), 'the launched token sorts above the pair token, so the ladder is the right way up');
  check(first.plan.feeAssets.length === 2
    && BigInt(first.plan.feeAssets[0].asset) < BigInt(first.plan.feeAssets[1].asset)
    && first.plan.feeAssets.every((f) => f.ownerBps + f.rewardsBps + f.burnBps === 10000),
    'the fee rows are unique, ascending, and each sums to 100%');
}
for (const cap of [1n * E, 50n * E, 250n * E]) {
  await live(`the opening market cap is editable: ${Number(cap) / 1e18} ETH`, { openingValuationQuote: cap },
    (r) => `tick ${r.recipe.launchTick}`);
}
for (const t of ABYSS_FEE_TIER_LIST) await live(`fee tier ${t.label} launches`, { feePips: t.feePips });
await live('a USDG pair launches (6 decimals)', { quote: USDGQ, openingValuationQuote: 20000n * 10n ** 6n });
await live('dividends to holders launches', { rewardMode: LifecycleRewardMode.Dividends, rewardsBps: 7500 });
await live('staking rewards launch', { rewardMode: LifecycleRewardMode.Staking, rewardsBps: 5000 });
await live('burning part of the token fees launches', { burnBps: 1000 });
for (const p of ABYSS_PRESETS) await live(`the ${p} liquidity shape launches`, { preset: p, positions: 4 });
for (const prof of ABYSS_PROFILES) await live(`pool profile ${prof.key} launches`, { profileKey: prof.key });
await live('an atomic dev buy launches', { devBuyRaw: 5n * 10n ** 16n }, (r) => `${r.plan.buys.length} buy, ${Number(r.tx.value) / 1e18} ETH attached`);

// --- a custom pair token ----------------------------------------------------------
{
  const custom = await resolveAbyssQuote(client, '0x15f3385625D7e364C5a6216FBbceadf10fa90e7d');   // the ABYSS token
  check(custom.symbol === 'ABYSS' && custom.decimals === 18 && custom.custom === true,
    'a pasted pair token is read off chain for its symbol and decimals', `${custom.symbol} / ${custom.decimals}dp`);
  for (const bad of ['0xdeadbeef', '']) {
    let msg = '';
    try { await resolveAbyssQuote(client, bad); } catch (e) { msg = e.message; }
    check(/paste a pair token address/.test(msg), `a malformed pair token address is refused (${bad || 'empty'})`, msg.slice(0, 60));
  }
  {
    let msg = '';
    try { await resolveAbyssQuote(client, '0x000000000000000000000000000000000000dEaD'); } catch (e) { msg = e.message; }
    check(/not a contract/.test(msg), 'and an address with no contract behind it is refused', msg.slice(0, 60));
  }
  for (const prof of ABYSS_PROFILES) {
    await live(`a custom pair token launches on ${prof.key}`, { quote: custom, quoteDecimals: 18, openingValuationQuote: 100n * E, profileKey: prof.key });
  }
  const r = await live('a custom pair token with a dev buy plans', { quote: custom, quoteDecimals: 18, openingValuationQuote: 100n * E, devBuyRaw: 10n * E },
    (x) => `prerequisite spender ${x.planned.prerequisites[0]?.spender?.slice(0, 10)}…`);
  if (r) check(r.planned.prerequisites.length === 1 && !!r.planned.prerequisites[0].spender,
    'and names the escrow that needs the approval', r.planned.prerequisites[0]?.spender);
}
console.log('');
process.exit(fails.length ? 1 : 0);
