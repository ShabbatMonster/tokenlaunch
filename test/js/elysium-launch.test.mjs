// Launches on Elysium (Kinetiq's chain 99901): Volta, Montra and Ascend,
// checked against the live contracts.
//
// None of the three publishes an ABI. Volta's and Montra's come from their own
// frontends; Ascend's was worked out from two real launches and simulation. So
// the strongest checks are the ones against real launches: Ascend's encoder
// rebuilds e/acc's launch byte for byte, the dev-buy maths reproduces Blob's
// and HYPEY's real outputs to the wei, and every launch shape the pads build is
// simulated against the contracts from a stand-in wallet (state overrides give
// it HYPE, and KNTQ plus an allowance for Ascend's dev buy).
//   node test/js/elysium-launch.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import { createPublicClient, http, fallback, decodeFunctionData, pad, numberToHex, getAddress } from 'viem';
import { ELYSIUM_CHAIN_ID, ELYSIUM_RPCS, KNTQ, parseFeeSplit, elysiumChain } from '../../src/elysium.js';
import { voltaPlan, voltaCheck, voltaPremine, VOLTA_LIMITS, VOLTA_PAIRS } from '../../src/volta.js';
import { montraPlan, montraConfigs, montraPickConfig, MONTRA_ABI, MONTRA_HOLDERS } from '../../src/montra.js';
import { ascendCalldata, ascendDevBuyOut, ascendPlan, ASCEND_FACTORY, ASCEND_SEED } from '../../src/ascend.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const MAIN = read(path.join(ROOT, 'src', 'main.js'));
const HTML = read(path.join(ROOT, 'docs', 'index.html'));
const why = (e) => { const d = e?.cause?.cause?.data || e?.cause?.data || e?.data; return (d?.errorName ? d.errorName + JSON.stringify(d.args ?? [], (k, x) => (typeof x === 'bigint' ? x.toString() : x)) : String(e?.cause?.cause?.data || e?.shortMessage || e?.message || e)).slice(0, 140); };

const pub = createPublicClient({ chain: elysiumChain, transport: fallback(ELYSIUM_RPCS.slice(0, 4).map((u) => http(u, { retryCount: 3, retryDelay: 800 }))) });
// a stand-in wallet; overrides give it HYPE (and, for Ascend, KNTQ + an allowance)
const FROM = '0x1111111111111111111111111111111111111111';
const rich = [{ address: FROM, balance: 10n ** 22n }];
// KNTQ's balance / allowance slots for FROM, found with eth_createAccessList
const KNTQ_BAL = '0x8df201bd27f2966348a2a146b04f0d259c4e6d127bc13c15dc7ac7298c950197';
const KNTQ_ALLOW = '0xf6bcc57364d09afc5100cedb209ea7a55e7819b17a80789c123bc618bd59eeee';

// --- the chain -----------------------------------------------------------------------
{
  const id = await pub.getChainId().catch(() => null);
  if (id !== ELYSIUM_CHAIN_ID) { console.log('SKIP  Elysium RPC unreachable'); process.exit(1); }
  check(true, 'the RPCs answer as Elysium, chain 99901');
  const s = parseFeeSplit('0x1111111111111111111111111111111111111111 60\nholders 40', { holdersSentinel: MONTRA_HOLDERS });
  check(s.length === 2 && s[1].wallet === MONTRA_HOLDERS && s[0].bps === 6000, 'fee splits read as "address percent", with "holders" where a pad supports it');
  let bad = ''; try { parseFeeSplit('0x1111111111111111111111111111111111111111 60'); } catch (e) { bad = e.message; }
  check(/add up to 60%/.test(bad), 'and a split that does not make 100% is refused');
}

// --- Ascend ----------------------------------------------------------------------------
{
  const eacc = await pub.getTransaction({ hash: '0xb89c3ee665ffb373a1a8ddc1cf0cf5d0d676f190ae615bb0383fac08b21bff24' });
  const salt = '0x' + eacc.input.slice(10 + 64 * 2, 10 + 64 * 3);
  check(ascendCalldata({ name: 'e/acc', symbol: 'e/acc', salt, recipients: [eacc.from], shares: [10000n] }) === eacc.input,
    'Ascend: the encoder rebuilds the real e/acc launch byte for byte');
  check(ascendDevBuyOut(220n * 10n ** 18n) === 26851265031092631154437968n,
    "Ascend: a 220 KNTQ dev buy gets exactly Blob's real 26,851,265 tokens — the launch's own buy pays no fee");
  const plan = await ascendPlan(pub, { account: FROM, name: 'Wire Test', symbol: 'WIRE' }).catch((e) => ({ err: why(e) }));
  check(!plan.err && BigInt(plan.token) < BigInt(KNTQ), 'Ascend: a fresh launch simulates, its coin sorting below KNTQ', plan.err || plan.token);
  const ov = (amt) => [{ address: KNTQ, stateDiff: [{ slot: KNTQ_BAL, value: pad(numberToHex(amt)) }, { slot: KNTQ_ALLOW, value: pad(numberToHex(amt)) }] }, ...rich];
  const buy = await ascendPlan(pub, { account: FROM, name: 'Wire Test', symbol: 'WIRE', devBuyKntq: '220' });
  const ok = await pub.call({ account: FROM, ...buy.request, gas: 30_000_000n, stateOverride: ov(500n * 10n ** 18n) }).then(() => 'OK').catch(why);
  check(ok === 'OK' && buy.devBuyMinOut === buy.expectedOut * 99n / 100n, 'Ascend: a 220 KNTQ dev buy simulates, its minimum out 1% under the exact figure', ok);
  const greedy = { ...buy.request, data: ascendCalldata({ name: 'Wire Test', symbol: 'WIRE', devBuy: buy.devBuy, devBuyMinOut: buy.expectedOut + 10n ** 18n, salt: buy.salt, recipients: buy.recipients, shares: buy.shares }) };
  const r = await pub.call({ account: FROM, ...greedy, gas: 30_000_000n, stateOverride: ov(500n * 10n ** 18n) }).then(() => 'OK').catch(why);
  check(/873e2c9a/.test(r), 'Ascend: and a minimum out above the exact figure is refused by the chain — so the figure is the real one');
  const noAllow = await pub.call({ account: FROM, ...buy.request, gas: 30_000_000n, stateOverride: rich }).then(() => 'OK').catch(why);
  check(noAllow !== 'OK', 'Ascend: without KNTQ and an allowance the dev buy cannot go through');
  const split = await ascendPlan(pub, { account: FROM, name: 'Wire Test', symbol: 'WIRE', split: parseFeeSplit(`${FROM} 70\n0x000000000000000000000000000000000000dEaD 30`) }).catch((e) => ({ err: why(e) }));
  check(!split.err && split.recipients.length === 2, 'Ascend: fees can be split across wallets', split.err || '70/30');
  check(ASCEND_SEED.startTick === -117600 && ASCEND_SEED.tickLower === -117400, 'Ascend: the seed range is the one the real launches opened with');
}

// --- Montra ----------------------------------------------------------------------------
{
  const hypey = await pub.getTransaction({ hash: '0x6cead4c8a5fd31f5bf01fef1b9498306473a20056ca9f71303edeb7daa6b1cbf' });
  const real = decodeFunctionData({ abi: MONTRA_ABI, data: hypey.input }).args[0];
  check(real.symbol === 'HYPEY' && real.configId === 6n, "Montra: the factory ABI decodes a real launch (HYPEY, config 6)");
  const configs = await montraConfigs(pub);
  const fees = [...new Set(configs.map((c) => c.feePct))].sort((a, b) => a - b);
  const windows = [...new Set(configs.map((c) => c.antiSnipeSeconds))].sort((a, b) => a - b);
  check(configs.length >= 40 && fees.join(',') === '1,2,3,5,10' && windows.includes(0) && windows.includes(1800),
    'Montra: the live configs read as 5 fee tiers by 8 anti-snipe windows', `fees ${fees.join('/')}% · windows ${windows.join('/')}s`);
  check(montraPickConfig(configs, { feePct: 2, antiSnipeSeconds: 5 }).id === 6, 'Montra: 2% with a 5s anti-snipe is config 6, the one HYPEY used');
  const sim = async (label, o) => {
    const plan = await montraPlan(pub, { account: FROM, name: 'Wire Test', symbol: 'WIRE', metadataURI: 'ipfs://bafkreitest', logo: 'ipfs://bafkreilogo', feePct: 2, antiSnipeSeconds: 5, ...o });
    const r = await pub.simulateContract({ ...plan.request, account: FROM, stateOverride: rich, gas: 30_000_000n }).then((x) => ({ ok: true, token: x.result[0] })).catch((e) => ({ ok: false, why: why(e) }));
    return { plan, r };
  };
  const a = await sim('no first buy', {});
  check(a.r.ok, 'Montra: a launch simulates', a.r.why || a.r.token);
  const b = await sim('first buy', { firstBuyHype: '0.002' });
  // Montra's site works the minimum out in floating point; this is exact, so it
  // agrees with HYPEY's real one to float precision and with the chain to the wei
  const rel = Math.abs(Number(b.plan.firstBuyMinOut - 45901062742766526073405n)) / 45901062742766526073405;
  check(b.r.ok && b.plan.firstBuyMinOut === b.plan.expectedOut * 99n / 100n && rel < 1e-9,
    "Montra: a 0.002 HYPE first buy simulates, its minimum out HYPEY's real one to float precision", `off by ${rel.toExponential(1)}`);
  const p = await montraPlan(pub, { account: FROM, name: 'Wire Test', symbol: 'WIRE', metadataURI: 'ipfs://x', feePct: 2, antiSnipeSeconds: 5, firstBuyHype: '0.002' });
  p.request.args[0].firstBuyMinOut = p.expectedOut + 1n;
  const tight = await pub.simulateContract({ ...p.request, account: FROM, stateOverride: rich, gas: 30_000_000n }).then(() => 'OK').catch(why);
  check(tight.startsWith(`FirstBuySlippage["${p.expectedOut}"`), 'Montra: and the chain reports the exact output the maths predicts', tight.slice(0, 60));
  const h = await sim('holders', { fees: { mode: 'holders' } });
  check(h.r.ok && h.plan.request.args[0].feeRecipients[0] === MONTRA_HOLDERS, 'Montra: fees can go to holders');
  const s = await sim('split', { fees: { mode: 'split', split: parseFeeSplit(`${FROM} 60\n0x000000000000000000000000000000000000dEaD 40`) } });
  check(s.r.ok, 'Montra: or be split across wallets', s.r.why || '60/40');
  const t = await sim('trillion', { supply: '1000000000000', feePct: 1, antiSnipeSeconds: 0 });
  check(t.r.ok, 'Montra: a trillion-token supply at 1% with no anti-snipe launches', t.r.why || '');
  let bad = ''; try { await montraPlan(pub, { account: FROM, name: 'x', symbol: 'x', supply: '999999999', feePct: 2, antiSnipeSeconds: 5 }); } catch (e) { bad = e.message; }
  check(/1,000,000,000 to/.test(bad), 'Montra: a supply under 1B is refused before Montra is asked');
}

// --- Volta -----------------------------------------------------------------------------
{
  const L = VOLTA_LIMITS;
  const refuses = (o, re, label) => { let m = ''; try { voltaCheck({ name: 'x', symbol: 'x', ...o }); } catch (e) { m = e.message; } check(re.test(m), label, m.slice(0, 80) || 'ACCEPTED'); };
  refuses({ swapFeePct: 6 }, /1%–5%/, 'Volta: a 6% swap fee is refused (the contract caps it at 5%)');
  refuses({ split: { creator: 50, buyback: 50, holders: 10 } }, /add up to 100%/, 'Volta: a fee split over 100% is refused');
  refuses({ antiSnipe: { startPct: 31, minutes: 5 } }, /between .* and 30%/, 'Volta: an anti-snipe over 30% is refused');
  refuses({ antiSnipe: { startPct: 20, minutes: 16 } }, /1–15 minutes/, 'Volta: an anti-snipe over 15 minutes is refused');
  refuses({ flaunchAt: new Date(Date.now() + 31 * 86400e3).toISOString() }, /30 days/, 'Volta: scheduling more than 30 days out is refused');
  refuses({ pair: 'KNTQ', devBuyHype: '0' }, /needs a dev buy/, 'Volta: a KNTQ pair without a dev buy is refused (the router needs HYPE to swap)');
  check(voltaPremine(10n ** 18n, 40n * 10n ** 18n) === L.totalSupply * 10n ** 18n * 985n / (41n * 10n ** 18n * 1000n), "Volta: the dev buy's tokens follow the site's own formula");
  const sim = async (o) => {
    const plan = await voltaPlan(pub, { account: FROM, name: 'Wire Test', symbol: 'WIRE', tokenUri: 'ipfs://bafkreitest', ...o });
    const r = await pub.simulateContract({ ...plan.request, account: FROM, stateOverride: rich, gas: 30_000_000n }).then((x) => ({ ok: true, token: x.result })).catch((e) => ({ ok: false, why: why(e) }));
    return { plan, r };
  };
  for (const pair of VOLTA_PAIRS.map((p) => p.key)) {
    const x = await sim({ pair, devBuyHype: '0.1' });
    check(x.r.ok && x.plan.premineAmount > 0n, `Volta: a ${pair}-paired launch with a 0.1 HYPE dev buy simulates`, x.r.why || `${(Number(x.plan.premineAmount) / 1e18).toLocaleString()} tokens`);
  }
  const all = await sim({ pair: 'HYPE', devBuyHype: '0.05', swapFeePct: 5, split: { creator: 0, buyback: 100, holders: 0 }, antiSnipe: { startPct: 30, minutes: 15 }, flaunchAt: new Date(Date.now() + 86400e3).toISOString() });
  check(all.r.ok, 'Volta: every option at its limit — 5% fee, 100% buyback, 30% anti-snipe for 15 min, scheduled a day out — simulates', all.r.why || '');
  const none = await sim({ pair: 'HYPE' });
  check(none.r.ok, 'Volta: a HYPE-paired launch with no dev buy simulates too');
}

// --- the pads ------------------------------------------------------------------------------
for (const [id, fam] of [['volta-elysium', 'volta'], ['montra-elysium', 'montra'], ['ascend-elysium', 'ascend']]) {
  check(MAIN.includes(`id: '${id}'`) && MAIN.includes(`family: '${fam}'`), `main.js has the ${fam} pad`);
}
for (const id of ['voltaRow', 'voltaPair', 'voltaFee', 'voltaSplitCreator', 'voltaSplitBuyback', 'voltaSplitHolders', 'voltaDevBuy', 'voltaSnipe', 'voltaSnipeStart', 'voltaSnipeMinutes', 'voltaSchedule', 'voltaCreator',
  'montraRow', 'montraFee', 'montraSnipe', 'montraSupply', 'montraBuy', 'montraFeesTo', 'montraSplit',
  'ascendRow', 'ascendDevBuy', 'ascendSplit']) {
  check(HTML.includes(`id="${id}"`), `UI has #${id}`);
}

console.log('');
process.exit(fails.length ? 1 : 0);
