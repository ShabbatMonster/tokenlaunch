// Elysium: Kinetiq's Arbitrum Orbit L2 on Hyperliquid (chain 99901), with HYPE
// as gas. Not Vulcan Forged's older "Elysium" (chain 1339, LAVA) - the two
// share a name and nothing else. Read off the launchpads' own frontends and the
// chain itself, 2026-11-08: their bundles name the chain, its RPCs and its
// Uniswap v4 deployment.
//
// Three launchpads run here, each its own pad (src/volta.js, src/montra.js,
// src/ascend.js); this file holds what they share - the chain, its v4 pool
// manager, KNTQ, and the v4 maths the launch previews need.
import { getAddress } from 'viem';

export const ELYSIUM_CHAIN_ID = 99901;
/// Public RPCs the launchpads themselves run; all answer chain 99901. Volta's
/// is first because it serves eth_call state overrides and access lists.
export const ELYSIUM_RPCS = [
  'https://rpc.volta.family', 'https://rpc.montramarkets.xyz', 'https://rpc.thekleos.pro/rpc',
  'https://rpc.stockium.fun', 'https://rpc-live.elysp.com',
];
export const ELYSIUM_EXPLORER = 'https://explorer.volta.family';
export const ELYSIUM_POOL_MANAGER = getAddress('0xe2e105d3f7209a9da11f83ccf3e7398a753823f1');
export const ELYSIUM_PERMIT2 = getAddress('0x000000000022d473030f116ddee9f6b43ac78ba3');
/// Kinetiq's governance token, the quote both Ascend and Volta's routed pairs use.
export const KNTQ = getAddress('0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0');
export const NATIVE = getAddress('0x0000000000000000000000000000000000000000');

export const elysiumChain = {
  id: ELYSIUM_CHAIN_ID, name: 'Elysium',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: ELYSIUM_RPCS } },
  blockExplorers: { default: { name: 'Elysium Explorer', url: ELYSIUM_EXPLORER } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
};

// --- v4 maths -----------------------------------------------------------------
// Ascend and Montra both open a coin as ONE liquidity range at a fixed starting
// price, so what a launch-time buy gets is exact arithmetic, not a quote: the
// buy is in the same transaction that opens the pool, so nothing can trade in
// between. Both are checked against real launches to the wei (test/js).
const Q96 = 2n ** 96n;

/// Uniswap TickMath.getSqrtRatioAtTick.
export function sqrtPriceAtTick(tick) {
  const abs = BigInt(Math.abs(tick));
  let r = (abs & 1n) ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const m = [
    0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
    0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
    0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
    0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
    0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
    0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n,
    0x48a170391f7dc42444e8fa2n,
  ];
  for (let i = 0; i < m.length; i++) if (abs & (1n << BigInt(i + 1))) r = (r * m[i]) >> 128n;
  if (tick > 0) r = ((1n << 256n) - 1n) / r;
  return (r >> 32n) + ((r % (1n << 32n)) === 0n ? 0n : 1n);
}

/// The coin is currency0 and the quote currency1: a buy pushes the price UP.
/// The price starts below the range, so it first jumps the empty gap free.
export function buyToken0Out({ amountIn, feePips = 0, liquidity, tickLower }) {
  const inAfter = BigInt(amountIn) * (1_000_000n - BigInt(feePips)) / 1_000_000n;
  const L = BigInt(liquidity);
  const lo = sqrtPriceAtTick(tickLower);
  const hi = lo + (inAfter * Q96) / L;
  return (L * Q96 * (hi - lo)) / (lo * hi);
}

/// The quote is currency0 (native HYPE always sorts first) and the coin
/// currency1: a buy pushes the price DOWN, never below the range's lower tick.
export function buyToken1Out({ amountIn, feePips = 0, liquidity, startTick, tickLower }) {
  const inAfter = BigInt(amountIn) * (1_000_000n - BigInt(feePips)) / 1_000_000n;
  const L = BigInt(liquidity);
  const s0 = sqrtPriceAtTick(startTick);
  const lo = sqrtPriceAtTick(tickLower);
  let s1 = (L * Q96 * s0) / (L * Q96 + inAfter * s0);
  if (s1 < lo) s1 = lo;
  return (L * (s0 - s1)) / Q96;
}

/// Amounts typed in the pad, as raw units.
export function parseAmount(ui, decimals = 18) {
  const s = String(ui ?? '0').trim().replace(/,/g, '') || '0';
  if (!/^\d*\.?\d*$/.test(s)) throw new Error(`"${ui}" is not an amount`);
  const [w, f = ''] = s.split('.');
  return BigInt((w || '0') + f.padEnd(decimals, '0').slice(0, decimals));
}

export const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');

/// Fee recipients typed one per line as "address percent", shares to 10,000.
export function parseFeeSplit(text, { holdersSentinel = null } = {}) {
  const out = [];
  for (const raw of String(text || '').split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s+([\d.]+)\s*%?$/);
    if (!m) throw new Error(`"${line}" should be an address and a percentage, like "0xabc… 40"`);
    let who = m[1];
    if (holdersSentinel && /^holders$/i.test(who)) who = holdersSentinel;
    if (!isAddress(who)) throw new Error(`"${m[1]}" is not an address${holdersSentinel ? ' (or "holders")' : ''}`);
    const bps = Math.round(Number(m[2]) * 100);
    if (!(bps > 0 && bps <= 10000)) throw new Error(`"${line}": the share has to be more than 0% and at most 100%`);
    out.push({ wallet: who, bps });
  }
  const total = out.reduce((s, r) => s + r.bps, 0);
  if (out.length && total !== 10000) throw new Error(`the fee shares add up to ${total / 100}%; they have to make 100%`);
  return out;
}
