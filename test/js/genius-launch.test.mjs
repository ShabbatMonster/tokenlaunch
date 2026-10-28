// Genius.fun on BNB Chain: Pons v2's factory with its own fees.
//
// DefiLlama's adapter calls it Pons v2 adapted for BSC, and it is - the same
// launchToken / launchAndBuy ABI drives it, which is why the pad reuses
// launchPonsV2. What differs is the fee regime, all of it set by the factory:
//   0.002 BNB to launch
//   2% on every curve trade  (1% destination / 0.5% platform / 0.25% creator / 0.25% buyback)
//   2% in the PancakeSwap Infinity pool after graduation
//   maxCreatorTaxBps 0, so no creator tax can be added
//   buybackEnabled must be true, or the launch reverts
// The launcher's real choice is the pair: 465 approved tokens plus native BNB,
// each with its own graduation threshold.
// Live checks need a BSC RPC; the rest always run.
//   node test/js/genius-launch.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import { createPublicClient, http, keccak256, stringToBytes, parseEther, formatEther } from 'viem';
import { bsc } from 'viem/chains';
import { GENIUS_PAIRS, GENIUS_SUPPLY, GENIUS_CURVE_FEE_BPS } from '../../src/geniusPairs.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');

const FACTORY = '0x37eE8AeE29C5efd3C1A7edA6dF3F510779928a37';
const FORWARDER = '0xd8b71b46498A36A4607EAb5C735BeE1DAb7F263d';
const NATIVE = '0x0000000000000000000000000000000000000000';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const FROM = '0x8894E0a0c962CB723c1976a4421c95949bE2D4E3';   // funded with BNB; every call is read-only

// --- the pad -------------------------------------------------------------------
const pad = MAIN.slice(MAIN.indexOf("id: 'genius-bnb'"), MAIN.indexOf("id: 'genius-bnb'") + 1800);
check(pad.length > 100 && /family: 'pons-v2'/.test(pad), 'the Genius pad reuses the Pons v2 family, so it shares the launch path');
check(pad.includes(FACTORY) && pad.includes(FORWARDER), 'and points at the m4.2 factory and its launchAndBuy router');
check(/chainId: 56/.test(pad) && /nativeSymbol: 'BNB'/.test(pad), 'on BNB Chain');
check(/forceBuyback: true/.test(pad) && /maxCreatorTaxBps: 0/.test(pad), 'with the buyback pinned on and the creator tax capped at 0');
check(/const forwarder = pad\.forwarder \|\| PONS_V2_FORWARDER_ADDR/.test(MAIN)
  && !/address: PONS_V2_FORWARDER_ADDR/.test(MAIN), 'the dev-buy forwarder is per-pad now, not hardcoded to Pons');
check(/buybackEnabled: pad\.forceBuyback \? true :/.test(MAIN), 'a launch cannot go out with the buyback off');
check(/maxCreatorTaxBps is 0/.test(MAIN), 'and a creator tax it would reject is refused with the reason');
check(HTML.includes('id="geniusFees"') && /paintGeniusFees/.test(MAIN), 'the pad shows the fee breakdown');
// everything genius.fun/create offers, which the pad left out at first
for (const id of ['ponsTelegram', 'ponsDiscord', 'ponsFarcaster', 'ponsBuyRecipient', 'ponsExempt']) {
  check(HTML.includes(`id="${id}"`), `UI has #${id}`);
}
check(/telegram: inp\.telegram \|\| ''/.test(MAIN) && /discord: inp\.discord \|\| ''/.test(MAIN) && /farcaster: inp\.farcaster \|\| ''/.test(MAIN),
  'all five socials reach the launch, not just twitter and website');
check(/const buyTo = inp\.buyRecipient \|\| account\.address/.test(MAIN), 'the first buy can be sent to a different address');
check(/\.\.\.\(inp\.exemptExtra \|\| \[\]\)\.map/.test(MAIN), 'and the creator can declare extra sniper-tax exemptions');
check(/function readPonsExtras/.test(MAIN) && /is not a valid address/.test(MAIN), 'with the addresses validated before anything is sent');
check(GENIUS_SUPPLY === 1_000_000_000 && GENIUS_CURVE_FEE_BPS === 200, 'the supply and curve fee come from the manifest', `${GENIUS_SUPPLY} / ${GENIUS_CURVE_FEE_BPS}bps`);
check(GENIUS_PAIRS.filter((p) => p.address !== 'custom').every((p) => p.phantom > 0), 'every pair carries its phantom reserve, so the opening price can be shown');
{
  const bnb = GENIUS_PAIRS[0];
  check(bnb.phantom === 6 && bnb.grad === 15, 'BNB opens against a 6 BNB phantom reserve and graduates at 15', `${bnb.phantom} / ${bnb.grad}`);
}

// --- the bundled pair list -------------------------------------------------------
check(GENIUS_PAIRS.length === 467, 'the pair list has 465 approved tokens + native BNB + custom', `${GENIUS_PAIRS.length} entries`);
check(GENIUS_PAIRS[0].symbol === 'BNB' && GENIUS_PAIRS[0].address === NATIVE, 'native BNB is first');
check(GENIUS_PAIRS[GENIUS_PAIRS.length - 1].address === 'custom', 'and a custom paste option is last');
check(new Set(GENIUS_PAIRS.map((p) => p.address)).size === GENIUS_PAIRS.length, 'no duplicate pair addresses');
check(GENIUS_PAIRS.filter((p) => p.address !== 'custom').every((p) => /^0x[0-9a-fA-F]{40}$/.test(p.address)), 'every pair address is well formed');
check(GENIUS_PAIRS.filter((p) => p.address !== 'custom').every((p) => p.grad > 0), 'and every pair carries its graduation threshold');
{
  const usdt = GENIUS_PAIRS.find((p) => p.symbol === 'USDT');
  check(usdt?.address === USDT && usdt.grad === 10000, 'USDT graduates at 10,000', String(usdt?.grad));
}

const RPC = process.env.BSC_RPC || 'https://bsc-dataseed.bnbchain.org';
const c = createPublicClient({ chain: bsc, transport: http(RPC) });
if (!(await c.getBlockNumber().catch(() => null))) { console.log('SKIP  no BSC RPC reachable'); process.exit(fails.length ? 1 : 0); }

// --- the live factory ------------------------------------------------------------
const PARAMS = [{ name: 'params', type: 'tuple', components: [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'logo', type: 'string' }, { name: 'description', type: 'string' },
  { name: 'socials', type: 'tuple', components: [{ name: 'twitter', type: 'string' }, { name: 'telegram', type: 'string' }, { name: 'discord', type: 'string' }, { name: 'website', type: 'string' }, { name: 'farcaster', type: 'string' }] },
  { name: 'creatorFeeRecipient', type: 'address' }, { name: 'creatorTaxBps', type: 'uint16' },
  { name: 'buybackEnabled', type: 'bool' }, { name: 'expectedEconomics', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }] }];
const ABI = [
  { type: 'function', name: 'launchEnabled', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'launchFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxCreatorTaxBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approvedPairTokens', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'previewLaunchEconomics', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'launchToken', stateMutability: 'payable', inputs: [...PARAMS, { name: 'launchConfigId', type: 'uint256' }, { name: 'pairToken', type: 'address' }, { name: 'snipeTaxExemptions', type: 'address[]' }], outputs: [{ name: 'token', type: 'address' }, { name: 'curve', type: 'address' }] },
];
const FWD = [{ type: 'function', name: 'launchAndBuy', stateMutability: 'payable', inputs: [...PARAMS, { name: 'launchConfigId', type: 'uint256' }, { name: 'pairToken', type: 'address' }, { name: 'quoteIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' }, { name: 'recipient', type: 'address' }, { name: 'snipeTaxExemptions', type: 'address[]' }], outputs: [{ name: 'token', type: 'address' }, { name: 'curve', type: 'address' }, { name: 'tokensOut', type: 'uint256' }] }];

const [enabled, fee, maxTax] = await Promise.all([
  c.readContract({ address: FACTORY, abi: ABI, functionName: 'launchEnabled' }),
  c.readContract({ address: FACTORY, abi: ABI, functionName: 'launchFee' }),
  c.readContract({ address: FACTORY, abi: ABI, functionName: 'maxCreatorTaxBps' }),
]);
check(enabled, 'the factory is open for launches');
check(formatEther(fee) === '0.002', 'the launch fee is 0.002 BNB, as the pad states', formatEther(fee) + ' BNB');
check(Number(maxTax) === 0, 'and maxCreatorTaxBps is 0, so the pad is right to refuse a creator tax', String(maxTax));

async function sim(label, { pair, buyback = true, creatorTaxBps = 0, devBuy = 0n, value, econBad = false, socials, exemptions, buyRecipient }) {
  const econ = econBad ? '0x' + '11'.repeat(32) : await c.readContract({ address: FACTORY, abi: ABI, functionName: 'previewLaunchEconomics', args: [0n, pair] });
  const p = {
    name: 'Genius test', symbol: 'GTEST', logo: 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
    description: 'wiring check', socials: socials ?? { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
    creatorFeeRecipient: FROM, creatorTaxBps, buybackEnabled: buyback, expectedEconomics: econ,
    salt: keccak256(stringToBytes('g-' + label + Date.now() + Math.random())),
  };
  try {
    if (devBuy > 0n) {
      const { result } = await c.simulateContract({ address: FORWARDER, abi: FWD, functionName: 'launchAndBuy', args: [p, 0n, pair, devBuy, 0n, buyRecipient ?? FROM, exemptions ?? [FROM]], account: FROM, value: value ?? fee + devBuy });
      return { ok: true, token: result[0], out: result[2] };
    }
    const { result } = await c.simulateContract({ address: FACTORY, abi: ABI, functionName: 'launchToken', args: [p, 0n, pair, exemptions ?? [FROM]], account: FROM, value: value ?? fee });
    return { ok: true, token: result[0] };
  } catch (e) {
    const d = e.details || e.shortMessage || e.message || '';
    return { ok: false, why: String((d.match(/execution reverted:?\s*(.*)/) || [, d])[1]).slice(0, 80) };
  }
}

for (const [label, sym] of [['native BNB', 'BNB'], ['USDT', 'USDT'], ['a bStock (AAPLB)', 'AAPLB'], ['an xStock (NVDAon)', 'NVDAon']]) {
  const pair = GENIUS_PAIRS.find((p) => p.symbol === sym);
  const r = await sim(label, { pair: pair.address });
  check(r.ok, `a launch against ${label} goes through`, r.ok ? r.token : r.why);
}
{
  const r = await sim('devbuy', { pair: NATIVE, devBuy: parseEther('0.05') });
  check(r.ok && r.out > 0n, 'an atomic launch + dev buy goes through the router', r.ok ? `${(Number(r.out) / 1e18).toLocaleString()} tokens for 0.05 BNB` : r.why);
}
for (const [label, opts] of [
  ['with the buyback turned off', { pair: USDT, buyback: false }],
  ['with a 1% creator tax', { pair: USDT, creatorTaxBps: 100 }],
  ['without paying the launch fee', { pair: USDT, value: 0n }],
  ['with stale expected economics', { pair: USDT, econBad: true }],
]) {
  const r = await sim(label, opts);
  check(!r.ok, `the factory rejects a launch ${label}`, r.ok ? 'it was ACCEPTED' : r.why || 'reverted');
}

// --- the options the create page exposes, each proven on chain -------------------
{
  const FULL = { twitter: '@geniuscat', telegram: 't.me/geniuscat', discord: 'discord.gg/geniuscat', website: 'https://genius.cat', farcaster: '@geniuscat' };
  const DEAD = '0x000000000000000000000000000000000000dEaD';
  let r = await sim('all five socials', { pair: NATIVE, socials: FULL });
  check(r.ok, 'a launch carrying all five socials goes through', r.ok ? r.token : r.why);
  r = await sim('declared exemptions', { pair: NATIVE, socials: FULL, exemptions: [FROM, DEAD] });
  check(r.ok, 'and one declaring extra sniper-tax exemptions', r.ok ? r.token : r.why);
  r = await sim('first buy to another wallet', { pair: NATIVE, socials: FULL, devBuy: parseEther('0.05'), buyRecipient: DEAD });
  check(r.ok && r.out > 0n, 'a first buy can be sent to a different address', r.ok ? `${(Number(r.out) / 1e18).toLocaleString()} tokens to 0x…dEaD` : r.why);
}
// the bundled list still matches the chain (spot check, the full 465 took one pass)
{
  const sample = ['USDT', 'USDC', 'AAPLB', 'NVDAon', 'TSLAon', 'GMEon', 'SPYon'];
  let allOk = true;
  for (const sym of sample) {
    const p = GENIUS_PAIRS.find((x) => x.symbol === sym);
    if (!p) { allOk = false; break; }
    if (!(await c.readContract({ address: FACTORY, abi: ABI, functionName: 'approvedPairTokens', args: [p.address] }))) { allOk = false; break; }
  }
  check(allOk, 'the bundled pairs still read back as approved on chain', sample.join(', '));
}
console.log('');
process.exit(fails.length ? 1 : 0);
