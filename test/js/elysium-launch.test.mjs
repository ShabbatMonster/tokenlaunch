// Launches on Elysium (Kinetiq's chain 99901): Volta, Montra and Ascend,
// checked against the live contracts.
//
// None of the three publishes an ABI; all three come from their own frontends'
// bundles. The strongest checks are the ones against real launches - Ascend's
// ABI rebuilds e/acc's launch byte for byte, the dev-buy maths reproduces Blob's
// and HYPEY's real outputs to the wei - and every launch shape the pads build
// is simulated against the contracts from a stand-in wallet (state overrides
// give it HYPE, and the quote plus an allowance for a dev buy).
//   node test/js/elysium-launch.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import { createPublicClient, http, fallback, decodeFunctionData, encodeFunctionData, pad, numberToHex, getAddress, formatUnits } from 'viem';
import { ELYSIUM_CHAIN_ID, ELYSIUM_RPCS, KNTQ, parseFeeSplit, elysiumChain } from '../../src/elysium.js';
import { voltaPlan, voltaCheck, voltaPremine, VOLTA_LIMITS, VOLTA_PAIRS, VOLTA_TOKEN } from '../../src/volta.js';
import { montraPlan, montraConfigs, montraPickConfig, montraPairs, montraChainOut, montraFirstBuyNeeds, MONTRA_ABI, MONTRA_HOLDERS, MONTRA_FACTORY } from '../../src/montra.js';
import { ascendDevBuyOut, ascendPlan, ascendQuote, ascendSeat, ascendDevBuyNeeds, ASCEND_QUOTES, ASCEND_SEAT_ABI, ASCEND_ERC20_ABI, WHYPE } from '../../src/ascend.js';
const fmt = (raw) => Number(formatUnits(raw, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 });

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

// the storage slots behind a token's balanceOf / allowance, found by trying each slot the call touches
const slotFor = async (token, call) => {
  const data = encodeFunctionData(call);
  const al = await pub.request({ method: 'eth_createAccessList', params: [{ from: WHYPE, to: token, data }, 'latest'] });
  for (const { address, storageKeys } of al.accessList) for (const k of storageKeys) {
    const r = await pub.call({ to: token, data, stateOverride: [{ address, stateDiff: [{ slot: k, value: pad(numberToHex(10n ** 30n)) }] }] }).catch(() => null);
    if (r?.data && BigInt(r.data) === 10n ** 30n) return { address: getAddress(address), slot: k };
  }
  throw new Error('no slot for ' + call.functionName);
};
const funded = async (token, spender) => {
  const xs = [await slotFor(token, { abi: ASCEND_ERC20_ABI, functionName: 'balanceOf', args: [FROM] }), await slotFor(token, { abi: ASCEND_ERC20_ABI, functionName: 'allowance', args: [FROM, spender] })];
  const by = {}; for (const x of xs) (by[x.address] ||= []).push({ slot: x.slot, value: pad(numberToHex(10n ** 30n)) });
  return [...rich, ...Object.entries(by).map(([address, stateDiff]) => ({ address, stateDiff }))];
};

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
  const run = (req, ov = rich) => pub.call({ account: FROM, ...req, gas: 30_000_000n, stateOverride: ov }).then((r) => '0x' + r.data.slice(26, 66), (e) => 'ERR ' + why(e));

  const eacc = await pub.getTransaction({ hash: '0xb89c3ee665ffb373a1a8ddc1cf0cf5d0d676f190ae615bb0383fac08b21bff24' });
  const d = decodeFunctionData({ abi: ASCEND_SEAT_ABI, data: eacc.input });
  check(d.functionName === 'launchChecked' && encodeFunctionData({ abi: ASCEND_SEAT_ABI, functionName: d.functionName, args: d.args }) === eacc.input,
    "Ascend: the SeatFactory ABI from Ascend's own app rebuilds the real e/acc launch byte for byte");
  check(d.args[1].holderBpsQuote === 10000 && d.args[1].holderBpsToken === 10000 && d.args[0].fee === 10000,
    'Ascend: and reads e/acc as a Holder Rewards coin — 100% of its creator fees to holders, 1% trade fee');
  check(ascendDevBuyOut({ quoteIn: 220n * 10n ** 18n, startTick: -117400, tokenIs0: true }).tokensOut === 26851265031092631154437968n,
    "Ascend: a 220 KNTQ dev buy gets exactly Blob's real 26,851,265 coins — the launch's own buy pays no fee");

  const ticks = { HYPE: -168600, KNTQ: -117400, USDC: -400600 };
  for (const q of ASCEND_QUOTES) {
    const live = await ascendQuote(pub, q.key).catch((e) => ({ err: e.message }));
    check(!live.err && live.startTick === ticks[q.key], `Ascend: ${q.key} is a live pair on Ascend's launchpad`, live.err || `opens at tick ${live.startTick}`);
  }
  const notQuote = await ascendQuote(pub, VOLTA_TOKEN).then(() => 'taken', (e) => e.message);
  check(/does not take/.test(notQuote), 'Ascend: a token the launchpad does not allow is refused as a pair', notQuote);

  // every pair x every coin type: the coin lands where predicted, the dev buy exactly as worked out
  const buys = { HYPE: '0.5', KNTQ: '100', USDC: '25' };
  const types = [
    ['Vanilla', { type: 'vanilla' }], ['Holder Rewards 100%', { type: 'holders', holdersQuotePct: '100', holdersTokenPct: '100' }],
    ['Holder Rewards 50/50', { type: 'holders', holdersQuotePct: '50', holdersTokenPct: '50' }], ['Buyback (burned)', { type: 'buyback', burn: true }],
    ['Custom 40/40/20', { type: 'custom', holdersPct: '40', buybackPct: '40', creatorPct: '20', burn: false }],
  ];
  for (const q of ASCEND_QUOTES) {
    const orderings = new Set();
    for (const [label, t] of types) {
      const plan = await ascendPlan(pub, { account: FROM, name: 'Wire Test', symbol: 'WIRE', quote: q.key, feePct: '2', devBuy: buys[q.key], ...t });
      orderings.add(plan.tokenIs0);
      const ov = await funded(q.token, plan.target);
      const exact = await run(plan.withMinOut(plan.expectedOut), ov);
      const over = await run(plan.withMinOut(plan.expectedOut + 1n), ov);
      check(exact.toLowerCase() === plan.token.toLowerCase() && /873e2c9a/.test(over),
        `Ascend: ${q.key} · ${label} with a ${buys[q.key]} ${q.key} dev buy launches where predicted, its output exact to the wei`,
        exact.startsWith('ERR') ? exact : `${fmt(plan.expectedOut)} coins, coin ${plan.tokenIs0 ? 'below' : 'above'} the quote`);
    }
    // both sides of the quote, since the coin's address decides the price direction
    for (let i = 0; i < 12 && orderings.size < 2; i++) {
      const plan = await ascendPlan(pub, { account: FROM, name: 'Wire Test', symbol: 'WIRE', quote: q.key, feePct: '2', devBuy: buys[q.key] });
      if (orderings.has(plan.tokenIs0)) continue;
      orderings.add(plan.tokenIs0);
      const ov = await funded(q.token, plan.target);
      const ok = (await run(plan.withMinOut(plan.expectedOut), ov)).toLowerCase() === plan.token.toLowerCase() && /873e2c9a/.test(await run(plan.withMinOut(plan.expectedOut + 1n), ov));
      check(ok, `Ascend: ${q.key} · the dev buy is exact with the coin ${plan.tokenIs0 ? 'below' : 'above'} the quote too`);
    }
  }

  const bare = await ascendPlan(pub, { account: FROM, name: 'Wire Test', symbol: 'WIRE', quote: 'HYPE', feePct: '10' });
  check((await run(bare.request)).toLowerCase() === bare.token.toLowerCase(), 'Ascend: a HYPE pair with a 10% fee and no dev buy launches (only gas)');
  const fees = await Promise.all(['0.99', '10.01', '2.555'].map((f) => ascendPlan(pub, { account: FROM, name: 'x', symbol: 'x', feePct: f }).then(() => 'taken', (e) => e.message)));
  check(fees.every((m) => /1%–10%/.test(m)), 'Ascend: a fee under 1%, over 10% or with three decimals is refused');
  const noPlan = await ascendPlan(pub, { account: FROM, name: 'Big', symbol: 'BIG', quote: 'KNTQ', devBuy: '3000' }).then(() => 'taken', (e) => e.message);
  check(/allocation plan/.test(noPlan), 'Ascend: a dev buy over 10% of supply asks for an allocation plan, as Ascend does');
  const big = await ascendPlan(pub, { account: FROM, name: 'Big', symbol: 'BIG', quote: 'KNTQ', devBuy: '3000', plan: 'held for a community airdrop' });
  check((await run(big.request, await funded(KNTQ, big.target))).toLowerCase() === big.token.toLowerCase(), 'Ascend: and with one it launches, the plan disclosed after the call', `${fmt(big.expectedOut)} coins`);

  const seatErr = (o) => { try { ascendSeat(o); return 'taken'; } catch (e) { return e.message; } };
  check(/add up to 90%/.test(seatErr({ type: 'custom', holdersPct: '50', buybackPct: '20', creatorPct: '20', payees: [{ wallet: FROM, bps: 10000 }] })), 'Ascend: a custom mix that does not make 100% is refused');
  check(/add up to 100%/.test(seatErr({ type: 'holders', payees: [{ wallet: FROM, bps: 6000 }] })), 'Ascend: payees that do not make 100% are refused');
  check(/at most 10/.test(seatErr({ type: 'holders', payees: [...Array(11)].map(() => ({ wallet: FROM, bps: 909 })) })), 'Ascend: more than 10 payees is refused');
  check(/burn address/.test(seatErr({ type: 'holders', payees: [{ wallet: '0x000000000000000000000000000000000000dEaD', bps: 10000 }] })), 'Ascend: the burn address cannot be a payee');
  // a HYPE dev buy from a wallet holding native HYPE but no WHYPE: wrap first, then approve
  const hypeBuy = await ascendPlan(pub, { account: FROM, name: 'Wire Test', symbol: 'WIRE', quote: 'HYPE', devBuy: '0.5' });
  const rpc = createPublicClient({ chain: elysiumChain, transport: http('https://rpc.volta.family') });
  const holder = getAddress('0x0000000000000000000000000000000000000000');
  const steps = await ascendDevBuyNeeds({ ...rpc, getBalance: async () => 10n ** 21n, readContract: (a) => rpc.readContract(a) }, holder, hypeBuy).catch((e) => ({ err: e.message }));
  check(!steps.err && steps.steps.map((s) => s.kind).join() === 'wrap,approve', 'Ascend: a HYPE dev buy wraps the HYPE, then approves WHYPE to the factory it calls', steps.err || steps.steps.map((s) => s.kind).join(', '));
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
  const pairs = await montraPairs(pub, configs);
  const syms = pairs.map((p) => p.symbol);
  check(['HYPE', 'KNTQ', 'wNVDAx', 'wSPYx', 'wQQQx', 'EQSPCX', 'EQTSLA', 'xyz:NVDA3L'].every((x) => syms.includes(x)) && pairs[0].native,
    'Montra: the live configs offer every pair on its launch page, HYPE first', syms.join(' / '));
  const htmlPairs = [...(HTML.match(/<select id="montraPair">([\s\S]*?)<\/select>/)?.[1] || '').matchAll(/value="(0x[0-9a-fA-F]{40})"/g)].map((x) => getAddress(x[1]));
  check(pairs.every((p) => htmlPairs.includes(p.quote)), 'UI: Montra lists every live pair even before the chain is read', `${htmlPairs.length} in the form`);
  // every pair: a first buy launches, its minimum out from the chain's own figure
  for (const pr of pairs) {
    const one = pr.native ? '0.01' : '1';
    const plan = await montraPlan(pub, { account: FROM, name: 'Wire Test', symbol: 'WIRE', metadataURI: 'ipfs://x', quote: pr.quote, feePct: 2, antiSnipeSeconds: 0, firstBuy: one });
    const ov = pr.native ? rich : await funded(pr.quote, MONTRA_FACTORY);
    const viaOv = { ...pub, simulateContract: (args) => pub.simulateContract({ ...args, stateOverride: ov, gas: 30_000_000n }) };
    const exact = await montraChainOut(viaOv, plan.request, FROM);
    const rel = exact ? Math.abs(Number(exact - plan.expectedOut)) / Number(exact) : 1;
    const go = exact ? await viaOv.simulateContract({ ...plan.withMinOut(exact * 99n / 100n), account: FROM }).then((x) => 'OK ' + x.result[0], (e) => 'ERR ' + why(e)) : 'no figure';
    const tooMuch = exact ? await viaOv.simulateContract({ ...plan.withMinOut(exact + 1n), account: FROM }).then(() => 'taken', (e) => why(e)) : '';
    check(go.startsWith('OK') && rel < 1e-9 && /FirstBuySlippage/.test(tooMuch) && (pr.native || plan.request.value === plan.launchFee),
      `Montra: ${pr.symbol} · a ${one} ${pr.symbol} first buy launches at the chain's exact figure${pr.native ? '' : ', no HYPE sent'}`,
      go.startsWith('OK') ? `${fmt(exact)} coins, maths within ${rel.toExponential(1)}` : go);
  }
  // Montra adds configs as it goes (146 to 180 in one afternoon), so the pair
  // missing a window is whichever one is missing it today
  const lacking = pairs.find((p) => !p.windows.includes(5));
  if (lacking) {
    const stockSnipe = await montraPlan(pub, { account: FROM, name: 'x', symbol: 'x', metadataURI: 'ipfs://x', quote: lacking.quote, feePct: 2, antiSnipeSeconds: 5 }).then(() => 'taken', (e) => e.message);
    check(/no config for this pair/.test(stockSnipe), `Montra: an anti-snipe window a pair does not have (${lacking.symbol}) is refused, naming what it offers`, stockSnipe.slice(0, 90));
  }
  const rpc = createPublicClient({ chain: elysiumChain, transport: http('https://rpc.volta.family') });
  const kntq = await montraPlan(rpc, { account: FROM, name: 'x', symbol: 'x', metadataURI: 'ipfs://x', quote: KNTQ, feePct: 2, antiSnipeSeconds: 5, firstBuy: '5' });
  const kneeds = await montraFirstBuyNeeds(rpc, FROM, kntq);
  check(kneeds.steps.map((x) => x.kind).join() === 'approve' && kneeds.steps[0].request.args[0] === MONTRA_FACTORY, 'Montra: a KNTQ first buy approves KNTQ to the factory first');
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
  const chainFig = await montraChainOut({ ...pub, simulateContract: (x) => pub.simulateContract({ ...x, stateOverride: rich, gas: 30_000_000n }) }, p.request, FROM);
  check(chainFig !== null && chainFig - p.expectedOut <= 2n && p.expectedOut - chainFig <= 2n, 'Montra: and the maths lands within 2 wei of the chain\'s own figure', `chain ${chainFig}, maths ${p.expectedOut}`);
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
  'montraRow', 'montraPair', 'montraBuySym', 'montraFee', 'montraSnipe', 'montraSupply', 'montraBuy', 'montraFeesTo', 'montraSplit',
  'ascendRow', 'ascendQuote', 'ascendQuoteCustom', 'ascendFee', 'ascendDevBuy', 'ascendType', 'ascendCreator', 'ascendHoldersQuote', 'ascendHoldersToken',
  'ascendMixHolders', 'ascendMixBuyback', 'ascendMixCreator', 'ascendBurn', 'ascendSplit', 'ascendDevBuyTo', 'ascendPlan']) {
  check(HTML.includes(`id="${id}"`), `UI has #${id}`);
}

// --- every pair each contract allows is in the form ------------------------------------
{
  const opts = (id) => {
    const m = HTML.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`));
    return m ? [...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]) : [];
  };
  const asc = opts('ascendQuote'), vol = opts('voltaPair');
  check(ASCEND_QUOTES.every((q) => asc.includes(q.key)) && asc.includes('custom'), 'UI: Ascend offers every live pair (HYPE, KNTQ, USDC) and any other its launchpad allows', asc.join(' / '));
  check(VOLTA_PAIRS.every((p) => vol.includes(p.key)), 'UI: Volta offers every pair its registry approves (HYPE, KNTQ, VOLTA)', vol.join(' / '));
  check(['vanilla', 'holders', 'buyback', 'custom'].every((t) => opts('ascendType').includes(t)), 'UI: Ascend offers all four coin types, Holder Rewards among them');
  check(opts('montraFeesTo').includes('holders'), 'UI: Montra can send fees to holders');
}

console.log('');
process.exit(fails.length ? 1 : 0);
