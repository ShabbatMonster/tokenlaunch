// Montra (montramarkets.xyz): a LaunchFactory on Elysium that opens each coin in
// a Uniswap v4 pool through its own hook. Read off the live frontend's bundle
// (the factory's full ABI, its first-buy maths) and the chain.
//
// What a launch picks is a CONFIG, and each config names its pair. As of
// 2026-11-11 there were 180 across eight pairs, and growing:
//   HYPE (native) and KNTQ: a 1/2/3/5/10% fee x 8 anti-snipe windows
//     (none, 5s, 10s, 30s, 1m, 5m, 15m, 30m - early buys pay up to 99%)
//   wNVDAx, wSPYx: the same 40; wQQQx, EQSPCX, EQTSLA, xyz:NVDA3L: the five
//     fees with no anti-snipe.
// They are read from the chain, not hardcoded, so a new pair or config shows
// up as is. Fees go to the creator, to holders (the HOLDERS sentinel 0x…01,
// streamed out over an hour), or split across wallets.
//
// A first buy rides in the launch. With HYPE it is sent as value; with a token
// pair it is approved to the factory and the launch carries no HYPE at all
// (any value reverts). Its minimum out comes from the chain itself: simulated
// with an impossible minimum, the factory reverts FirstBuySlippage(out, min)
// naming the exact output - whichever side of its pair the coin lands on.
import { parseAbi, getAddress } from 'viem';
import { buyToken1Out, parseAmount, isAddress, ELYSIUM_EXPLORER, NATIVE } from './elysium.js';

export const MONTRA_REGISTRY = getAddress('0xf1e2fa75422f889e565f3142bdbf60b28dce2aa7');
export const MONTRA_FACTORY = getAddress('0x38d3ef3a06d18fa3286fb5deafe611be725fcd15');
export const MONTRA_LENS = getAddress('0xb4c202910c40c3a83f6c55683460790aaec487d4');
export const MONTRA_HOLDERS = getAddress('0x0000000000000000000000000000000000000001');
export const MONTRA_MIN_SUPPLY = 1_000_000_000n;
export const MONTRA_MAX_SUPPLY = 1_000_000_000_000_000n;
export const montraCoinUrl = (t) => `https://montramarkets.xyz/token/${t}`;
export const montraTxUrl = (h) => `${ELYSIUM_EXPLORER}/tx/${h}`;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const CONFIG = '(uint256 moduleSetId, address quote, uint256 baseSupply, int24 tickSpacing, int24 startTick, uint24 graduationTicks, uint24 lpLineTicks, uint24 totalFeePips, uint24 totalFeeMinPips, uint24 protocolFeePips, uint24 lpFeePips, uint24 earlyBuyFeeStartPips, uint32 earlyBuyFeeWindow, address liquidityPolicy, bool liquiditySealed, uint32 streamDuration, uint16 pushBountyBps, uint128 pushFloor, bool enabled, bool exists)';
export const MONTRA_ABI = parseAbi([
  'function launch((string name, string symbol, string metadataURI, (string logo, string description, (string telegram, string twitter, string discord, string website, string extra) socials) profile, uint256 configId, uint256 supply, bytes32 salt, address[] feeRecipients, uint16[] feeShares, uint256 firstBuyAmount, uint256 firstBuyMinOut, (uint256 deadline, uint8 v, bytes32 r, bytes32 s) permit) p) payable returns (address token, bytes32 poolId)',
  'function configCount() view returns (uint256)',
  `function getConfig(uint256 id) view returns (${CONFIG})`,
  'function launchEnabled() view returns (bool)',
  'function launchFee() view returns (uint256)',
  'error FirstBuySlippage(uint256 out, uint256 minOut)',
  'error SupplyOutOfRange(uint256 supply)', 'error SupplyNotWholeCoins(uint256 supply)',
]);
const LENS_ABI = parseAbi(['function seedPreview(address factory, uint256 configId, uint256 supply) view returns (int24 startTick, (int24 tickLower, int24 tickUpper, uint128 liquidity) seed)']);
export const MONTRA_ERC20_ABI = parseAbi([
  'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
]);
const isNative = (q) => getAddress(q) === NATIVE;

/// Every live config, with what it means in plain terms - read in multicall
/// batches (one call per config gets rate-limited past ~100).
export async function montraConfigs(pub) {
  const n = Number(await pub.readContract({ address: MONTRA_FACTORY, abi: MONTRA_ABI, functionName: 'configCount' }));
  const raw = [];
  for (let i = 0; i < n; i += 60) {
    const ids = [...Array(Math.min(60, n - i))].map((_, k) => i + k);
    const res = await pub.multicall({
      multicallAddress: MULTICALL3, allowFailure: false,
      contracts: ids.map((id) => ({ address: MONTRA_FACTORY, abi: MONTRA_ABI, functionName: 'getConfig', args: [BigInt(id)] })),
    });
    res.forEach((cfg, k) => raw.push({ id: ids[k], ...cfg }));
  }
  return raw.filter((c) => c.exists && c.enabled).map((c) => ({
    id: c.id, quote: getAddress(c.quote), feePct: c.totalFeePips / 10000, feeFloorPct: c.totalFeeMinPips / 10000,
    antiSnipeSeconds: c.earlyBuyFeeStartPips > 0 ? c.earlyBuyFeeWindow : 0, antiSnipeStartPct: c.earlyBuyFeeStartPips / 10000,
    totalFeePips: c.totalFeePips, lpFeePips: c.lpFeePips, lpLineTicks: c.lpLineTicks, baseSupply: c.baseSupply,
  }));
}

/// The pairs the live configs offer, each with its symbol, decimals, and the
/// fees and anti-snipe windows it comes with. HYPE first.
export async function montraPairs(pub, configs) {
  configs ||= await montraConfigs(pub);
  const quotes = [...new Set(configs.map((c) => c.quote))];
  const tokens = quotes.filter((q) => !isNative(q));
  const meta = tokens.length ? await pub.multicall({
    multicallAddress: MULTICALL3, allowFailure: true,
    contracts: tokens.flatMap((q) => [{ address: q, abi: MONTRA_ERC20_ABI, functionName: 'symbol' }, { address: q, abi: MONTRA_ERC20_ABI, functionName: 'decimals' }]),
  }) : [];
  const info = new Map(tokens.map((q, i) => [q, { symbol: meta[2 * i].result ?? q.slice(0, 8), decimals: Number(meta[2 * i + 1].result ?? 18) }]));
  return quotes.map((q) => {
    const cs = configs.filter((c) => c.quote === q);
    const m = isNative(q) ? { symbol: 'HYPE', decimals: 18 } : info.get(q);
    return {
      quote: q, native: isNative(q), ...m,
      fees: [...new Set(cs.map((c) => c.feePct))].sort((a, b) => a - b),
      windows: [...new Set(cs.map((c) => c.antiSnipeSeconds))].sort((a, b) => a - b),
    };
  }).sort((a, b) => (b.native - a.native) || a.symbol.localeCompare(b.symbol));
}

/// The config for a pair, a fee and an anti-snipe window, or why there is none.
export function montraPickConfig(configs, { quote = NATIVE, feePct, antiSnipeSeconds = 0 }) {
  const q = getAddress(quote);
  const c = configs.find((x) => x.quote === q && x.feePct === Number(feePct) && x.antiSnipeSeconds === Number(antiSnipeSeconds));
  if (!c) {
    const forPair = configs.filter((x) => x.quote === q);
    if (!forPair.length) throw new Error(`Montra has no live configs paired with ${q}`);
    throw new Error(`Montra has no config for this pair with a ${feePct}% fee and ${antiSnipeSeconds ? antiSnipeSeconds + 's anti-snipe' : 'no anti-snipe'}`
      + ` (it offers ${[...new Set(forPair.map((x) => x.feePct))].join('/')}% with ${[...new Set(forPair.map((x) => x.antiSnipeSeconds))].map((s) => (s ? s + 's' : 'none')).join(', ')})`);
  }
  return c;
}

/// Who the fees go to: the creator (default), holders, one wallet, or a split.
export function montraFeeRecipients({ mode = 'creator', wallet, split = [] }) {
  if (mode === 'creator') return { feeRecipients: [], feeShares: [] };
  if (mode === 'holders') return { feeRecipients: [MONTRA_HOLDERS], feeShares: [10000] };
  if (mode === 'wallet') {
    if (!isAddress(wallet)) throw new Error('the fee wallet is not an address');
    return { feeRecipients: [wallet], feeShares: [10000] };
  }
  if (mode === 'split') {
    if (split.length < 2 || split.length > 4) throw new Error('a split has two to four recipients');
    return { feeRecipients: split.map((s) => s.wallet), feeShares: split.map((s) => s.bps) };
  }
  throw new Error(`unknown fee recipient mode "${mode}"`);
}

/// The first buy's output by Montra's own maths: the hook takes its share of the
/// fee from the input, the pool its LP fee (none once the LP line is set), and
/// the rest trades down the seed range. Integer, so it can differ from the
/// chain by a few wei; the launch uses the chain's own figure (montraChainOut).
export function montraFirstBuyOut({ amountIn, config, startTick, seed }) {
  const lp = BigInt(config.lpLineTicks ? 0 : config.lpFeePips);
  const hook = (BigInt(amountIn) * (BigInt(config.totalFeePips) - lp)) / 1_000_000n;
  const afterLp = ((BigInt(amountIn) - hook) * (1_000_000n - lp)) / 1_000_000n;
  return buyToken1Out({ amountIn: afterLp, feePips: 0, liquidity: seed.liquidity, startTick: Number(startTick), tickLower: Number(seed.tickLower) });
}

/// The exact first-buy output, from the chain: simulated with an impossible
/// minimum, the launch reverts FirstBuySlippage(out, min). Needs the funds (and,
/// for a token pair, the allowance) in place; null if it reverts otherwise.
export async function montraChainOut(pub, request, account) {
  const p = { ...request.args[0], firstBuyMinOut: 2n ** 255n };
  try {
    await pub.simulateContract({ ...request, args: [p], account });
    return null;
  } catch (e) {
    for (let x = e; x; x = x.cause) if (x.data?.errorName === 'FirstBuySlippage') return x.data.args[0];
    return null;
  }
}

const randomSalt = () => {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

/// The launch, ready to simulate and send.
///   o.quote: NATIVE / 'HYPE' (default) or a pair token's address
///   o.firstBuy: in the pair's own units (o.firstBuyHype still works for HYPE)
export async function montraPlan(pub, o) {
  if (!o.name || !o.symbol) throw new Error('the coin needs a name and a ticker');
  const enabled = await pub.readContract({ address: MONTRA_FACTORY, abi: MONTRA_ABI, functionName: 'launchEnabled' });
  if (!enabled) throw new Error('Montra has launches switched off right now');
  const [configs, launchFee] = await Promise.all([montraConfigs(pub), pub.readContract({ address: MONTRA_FACTORY, abi: MONTRA_ABI, functionName: 'launchFee' })]);
  const quote = !o.quote || o.quote === 'HYPE' ? NATIVE : getAddress(o.quote);
  const cfg = montraPickConfig(configs, { ...o, quote });
  const native = isNative(quote);
  const [symbol, decimals] = native ? ['HYPE', 18] : await Promise.all([
    pub.readContract({ address: quote, abi: MONTRA_ERC20_ABI, functionName: 'symbol' }).catch(() => quote.slice(0, 8)),
    pub.readContract({ address: quote, abi: MONTRA_ERC20_ABI, functionName: 'decimals' }).then(Number),
  ]);
  const whole = BigInt(String(o.supply || '1000000000').replace(/[,_\s]/g, ''));
  if (whole < MONTRA_MIN_SUPPLY || whole > MONTRA_MAX_SUPPLY) throw new Error('Montra supply is 1,000,000,000 to 1,000,000,000,000,000 whole tokens');
  const supply = whole * 10n ** 18n;
  const firstBuyAmount = parseAmount(o.firstBuy ?? o.firstBuyHype ?? '0', decimals);
  let firstBuyMinOut = 0n, expectedOut = 0n;
  if (firstBuyAmount > 0n) {
    // the first buy pays the config's full fee, not the anti-snipe one
    const [startTick, seed] = await pub.readContract({ address: MONTRA_LENS, abi: LENS_ABI, functionName: 'seedPreview', args: [MONTRA_FACTORY, BigInt(cfg.id), supply] });
    expectedOut = montraFirstBuyOut({ amountIn: firstBuyAmount, config: cfg, startTick, seed });
    firstBuyMinOut = (expectedOut * 99n) / 100n;   // the site's 1%
  }
  const { feeRecipients, feeShares } = montraFeeRecipients(o.fees || {});
  const p = {
    name: o.name, symbol: o.symbol, metadataURI: o.metadataURI,
    profile: { logo: o.logo || '', description: o.description || '', socials: { telegram: o.telegram || '', twitter: o.twitter || '', discord: o.discord || '', website: o.website || '', extra: '' } },
    configId: BigInt(cfg.id), supply, salt: randomSalt(), feeRecipients, feeShares, firstBuyAmount, firstBuyMinOut,
    permit: { deadline: 0n, v: 0, r: '0x' + '00'.repeat(32), s: '0x' + '00'.repeat(32) },
  };
  return {
    request: { address: MONTRA_FACTORY, abi: MONTRA_ABI, functionName: 'launch', args: [p], value: native ? launchFee + firstBuyAmount : launchFee },
    config: cfg, launchFee, expectedOut, firstBuyMinOut, configs,
    pair: { quote, native, symbol, decimals }, firstBuyAmount,
    /// the same launch with another minimum out
    withMinOut: (min) => ({ address: MONTRA_FACTORY, abi: MONTRA_ABI, functionName: 'launch', args: [{ ...p, firstBuyMinOut: min }], value: native ? launchFee + firstBuyAmount : launchFee }),
  };
}

/// What a token-pair first buy needs first: the token in the wallet and an
/// allowance for the factory. HYPE needs nothing.
export async function montraFirstBuyNeeds(pub, account, plan) {
  if (plan.pair.native || plan.firstBuyAmount <= 0n) return { ok: true, steps: [], short: 0n };
  const [bal, allow] = await Promise.all([
    pub.readContract({ address: plan.pair.quote, abi: MONTRA_ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    pub.readContract({ address: plan.pair.quote, abi: MONTRA_ERC20_ABI, functionName: 'allowance', args: [account, MONTRA_FACTORY] }),
  ]);
  const steps = allow < plan.firstBuyAmount
    ? [{ kind: 'approve', amount: plan.firstBuyAmount, request: { address: plan.pair.quote, abi: MONTRA_ERC20_ABI, functionName: 'approve', args: [MONTRA_FACTORY, plan.firstBuyAmount] } }]
    : [];
  return { ok: bal >= plan.firstBuyAmount && !steps.length, short: bal < plan.firstBuyAmount ? plan.firstBuyAmount - bal : 0n, balance: bal, steps };
}
