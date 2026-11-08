// Montra (montramarkets.xyz): a LaunchFactory on Elysium that opens each coin in
// a Uniswap v4 pool against native HYPE, through its own hook. Read off the live
// frontend's bundle (the factory's full ABI) and the chain, 2026-11-08.
//
// What a launch picks is a CONFIG: 40 are live, every pairing of
//   - a trading fee: 1%, 2%, 3%, 5% or 10% (each decaying to a floor), and
//   - an anti-snipe window: none, 5s, 10s, 30s, 60s, 5m, 15m or 30m, during
//     which early buys pay up to 99%.
// They are read from the chain, not hardcoded, so a new one shows up as is.
// Fees go to the creator, to holders (the HOLDERS sentinel 0x…01, streamed out
// over an hour), or split across wallets. A first buy rides in the launch, its
// minimum out worked out exactly from the lens's seed geometry.
import { parseAbi, getAddress } from 'viem';
import { buyToken1Out, parseAmount, isAddress, ELYSIUM_EXPLORER } from './elysium.js';

export const MONTRA_REGISTRY = getAddress('0xf1e2fa75422f889e565f3142bdbf60b28dce2aa7');
export const MONTRA_FACTORY = getAddress('0x38d3ef3a06d18fa3286fb5deafe611be725fcd15');
export const MONTRA_LENS = getAddress('0xb4c202910c40c3a83f6c55683460790aaec487d4');
export const MONTRA_HOLDERS = getAddress('0x0000000000000000000000000000000000000001');
export const MONTRA_MIN_SUPPLY = 1_000_000_000n;
export const MONTRA_MAX_SUPPLY = 1_000_000_000_000_000n;
export const montraCoinUrl = (t) => `https://montramarkets.xyz/token/${t}`;
export const montraTxUrl = (h) => `${ELYSIUM_EXPLORER}/tx/${h}`;

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

/// Every live config, with what it means in plain terms.
export async function montraConfigs(pub) {
  const n = Number(await pub.readContract({ address: MONTRA_FACTORY, abi: MONTRA_ABI, functionName: 'configCount' }));
  const all = await Promise.all([...Array(n)].map((_, id) => pub.readContract({ address: MONTRA_FACTORY, abi: MONTRA_ABI, functionName: 'getConfig', args: [BigInt(id)] })
    .then((cfg) => ({ id, ...cfg }))));
  return all.filter((c) => c.exists && c.enabled).map((c) => ({
    id: c.id, quote: c.quote, feePct: c.totalFeePips / 10000, feeFloorPct: c.totalFeeMinPips / 10000,
    antiSnipeSeconds: c.earlyBuyFeeStartPips > 0 ? c.earlyBuyFeeWindow : 0, antiSnipeStartPct: c.earlyBuyFeeStartPips / 10000,
    totalFeePips: c.totalFeePips, baseSupply: c.baseSupply,
  }));
}

/// The config for a fee and an anti-snipe window, or why there is none.
export function montraPickConfig(configs, { feePct, antiSnipeSeconds = 0 }) {
  const c = configs.find((x) => x.feePct === Number(feePct) && x.antiSnipeSeconds === Number(antiSnipeSeconds) && x.quote === getAddress('0x0000000000000000000000000000000000000000'));
  if (!c) throw new Error(`Montra has no config with a ${feePct}% fee and ${antiSnipeSeconds ? antiSnipeSeconds + 's anti-snipe' : 'no anti-snipe'}`);
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
    if (split.length < 2) throw new Error('a split needs at least two recipients');
    return { feeRecipients: split.map((s) => s.wallet), feeShares: split.map((s) => s.bps) };
  }
  throw new Error(`unknown fee recipient mode "${mode}"`);
}

const randomSalt = () => {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

/// The launch, ready to simulate and send.
export async function montraPlan(pub, o) {
  if (!o.name || !o.symbol) throw new Error('the coin needs a name and a ticker');
  const enabled = await pub.readContract({ address: MONTRA_FACTORY, abi: MONTRA_ABI, functionName: 'launchEnabled' });
  if (!enabled) throw new Error('Montra has launches switched off right now');
  const [configs, launchFee] = await Promise.all([montraConfigs(pub), pub.readContract({ address: MONTRA_FACTORY, abi: MONTRA_ABI, functionName: 'launchFee' })]);
  const cfg = montraPickConfig(configs, o);
  const whole = BigInt(String(o.supply || '1000000000').replace(/[,_\s]/g, ''));
  if (whole < MONTRA_MIN_SUPPLY || whole > MONTRA_MAX_SUPPLY) throw new Error('Montra supply is 1,000,000,000 to 1,000,000,000,000,000 whole tokens');
  const supply = whole * 10n ** 18n;
  const firstBuyAmount = parseAmount(o.firstBuyHype || '0', 18);
  let firstBuyMinOut = 0n, expectedOut = 0n;
  if (firstBuyAmount > 0n) {
    // the first buy pays the config's full fee, not the anti-snipe one
    const [startTick, seed] = await pub.readContract({ address: MONTRA_LENS, abi: LENS_ABI, functionName: 'seedPreview', args: [MONTRA_FACTORY, BigInt(cfg.id), supply] });
    expectedOut = buyToken1Out({ amountIn: firstBuyAmount, feePips: cfg.totalFeePips, liquidity: seed.liquidity, startTick: Number(startTick), tickLower: Number(seed.tickLower) });
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
    request: { address: MONTRA_FACTORY, abi: MONTRA_ABI, functionName: 'launch', args: [p], value: launchFee + firstBuyAmount },
    config: cfg, launchFee, expectedOut, firstBuyMinOut, configs,
  };
}
