import {
  createPublicClient, createWalletClient, http, fallback, getAddress, parseUnits, formatUnits,
  encodeFunctionData, decodeFunctionResult, maxUint256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ARC, ARC_USDC } from './argus.js';

// ---------------------------------------------------------------------------
// Swapping on Arc.
//
// Arc's main DEX is a Uniswap V3 deployment, found by following ARCADE
// (0x8b838fd5...), which trades against USDC through it. None of it is in a
// registry, so every address below was read off live transactions:
//
//   factory   0xF5ca74989E4ecb2fC0BFFB42E1783526A85F0E80   getPool() works
//   router    0x4d50662F41AE9e2717A40669c9b92Fc45A9F3A87
//   positions 0xAF956F0a6556Bb7AAeADC54569BA41B496f9f3d2   WETH9() is zero
//
// Two things about it differ from stock Uniswap and matter:
//
//  - the router's exactInputSingle takes FLAT arguments, not the usual tuple:
//      exactInputSingle(tokenIn, tokenOut, fee, recipient, amountIn,
//                       amountOutMinimum, deadline) -> amountOut
//    selector 0x122194c5, confirmed on every buy read.
//  - there is no WETH. USDC is the gas token, but the pools and the router use
//    it as a plain ERC-20 at 0x3600...0000 (6 decimals). A buy sends no value;
//    the router pulls USDC by allowance, the same as any other token.
//
// It also ships no Quoter, so quotes come from the pool itself and the amount
// that is actually enforced comes from simulating the exact swap first.
// ---------------------------------------------------------------------------

export const ARC_V3_FACTORY = '0xF5ca74989E4ecb2fC0BFFB42E1783526A85F0E80';
export const ARC_V3_ROUTER = '0x4d50662F41AE9e2717A40669c9b92Fc45A9F3A87';
export const ARC_V3_FEE_TIERS = [100, 500, 3000, 10000];
// Arc mainnet is not in any public registry yet, so these were found by probing.
// drpc's public tier rate-limits hard under load - it cut this module's own
// testing off mid-run - so they sit behind a fallback transport.
//
// arc.gateway.tenderly.co also answers chain 5042 and is the fastest to respond,
// and it is deliberately NOT here: it was ~3,550 blocks behind the others, from
// before ARCADE existed, and answered getPool with the zero address rather than
// an error. A fallback only moves on after an error, so a stale node at the front
// of the list does not fail over - it just quietly reports that no pool exists.
export const ARC_RPCS = [
  'https://5042.rpc.thirdweb.com',
  'https://arc-rpc.publicnode.com',
  'https://arc.drpc.org',
];
const Q96 = 2n ** 96n;

const arcTransport = () => fallback(
  ARC_RPCS.map((url) => http(url, { retryCount: 1, retryDelay: 300, timeout: 12_000 })),
  { rank: false, retryCount: 2 },
);

const ERC20 = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const FACTORY_ABI = [{ type: 'function', name: 'getPool', stateMutability: 'view',
  inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], outputs: [{ type: 'address' }] }];
const POOL_ABI = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  { type: 'function', name: 'slot0', stateMutability: 'view', inputs: [], outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
    { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' }] },
];
const ROUTER_ABI = [{ type: 'function', name: 'exactInputSingle', stateMutability: 'nonpayable',
  inputs: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' },
    { name: 'recipient', type: 'address' }, { name: 'amountIn', type: 'uint256' },
    { name: 'amountOutMinimum', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
  outputs: [{ name: 'amountOut', type: 'uint256' }] }];

const ZERO = '0x0000000000000000000000000000000000000000';

export function arcClients(privateKey) {
  const publicClient = createPublicClient({ chain: ARC, transport: arcTransport() });
  if (!privateKey) return { publicClient, account: null, walletClient: null };
  const account = privateKeyToAccount(privateKey);
  return { publicClient, account, walletClient: createWalletClient({ account, chain: ARC, transport: arcTransport() }) };
}

/// Every USDC pool this token has, deepest first. Found through the factory
/// rather than by scanning logs - getPool is exact and costs one read per tier.
export async function findArcPools(tokenAddress, { quote = ARC_USDC, blockNumber } = {}) {
  const { publicClient } = arcClients(null);
  const token = getAddress(tokenAddress);
  const q = getAddress(quote);
  const at = blockNumber ? { blockNumber } : {};

  // A token that is not there cannot have a pool, and saying "no pool" for it
  // would hide the real problem - usually a node that is behind.
  const code = await publicClient.getCode({ address: token, ...at });
  if (!code || code === '0x') {
    throw new Error('no contract at that address on Arc (or the RPC answering is behind)');
  }

  const pools = [];
  for (const fee of ARC_V3_FEE_TIERS) {
    // No catch here on purpose. A zero address means there is no pool at this
    // tier; a failed call is a failed call, and turning it into "no pool" is how
    // a flaky node ends up telling you a live token is untradeable.
    const pool = await publicClient.readContract({
      address: getAddress(ARC_V3_FACTORY), abi: FACTORY_ABI, functionName: 'getPool', args: [token, q, fee], ...at,
    });
    if (!pool || pool === ZERO) continue;
    const [token0, liquidity, slot0] = await Promise.all([
      publicClient.readContract({ address: pool, abi: POOL_ABI, functionName: 'token0', ...at }),
      publicClient.readContract({ address: pool, abi: POOL_ABI, functionName: 'liquidity', ...at }),
      publicClient.readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0', ...at }),
    ]);
    pools.push({
      pool: getAddress(pool), fee, token, quote: q,
      token0: getAddress(token0), liquidity, sqrtPriceX96: slot0[0], tick: Number(slot0[1]),
    });
  }
  pools.sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0));
  return pools;
}

/// Constant-liquidity V3 swap: what `amountIn` buys inside the current range.
///
/// Exact as long as the trade does not cross an initialized tick, which is the
/// normal case for a launch pool - they are seeded full range. It is shown as
/// the estimate; the number the swap actually enforces as its minimum comes
/// from simulating the real call, so a tick crossing can never let a worse fill
/// through.
export function quoteInRange({ sqrtPriceX96, liquidity, fee, zeroForOne, amountIn }) {
  const L = BigInt(liquidity);
  const P = BigInt(sqrtPriceX96);
  if (L === 0n || P === 0n) return 0n;
  const afterFee = (BigInt(amountIn) * BigInt(1_000_000 - fee)) / 1_000_000n;
  if (zeroForOne) {
    // token0 in, price falls: sqrtP' = L*sqrtP / (L + in*sqrtP/Q96)
    const next = (L * P * Q96) / (L * Q96 + afterFee * P);
    return (L * (P - next)) / Q96;
  }
  // token1 in, price rises: sqrtP' = sqrtP + in*Q96/L, token0 out = L*(sqrtP'-sqrtP)*Q96/(sqrtP'*sqrtP)
  const next = P + (afterFee * Q96) / L;
  return (L * (next - P) * Q96) / (next * P);
}

export async function arcTokenInfo(tokenAddress, owner) {
  const { publicClient } = arcClients(null);
  const token = getAddress(tokenAddress);
  const read = (fn, args = []) => publicClient.readContract({ address: token, abi: ERC20, functionName: fn, args }).catch(() => null);
  const [name, symbol, decimals] = await Promise.all([read('name'), read('symbol'), read('decimals')]);
  const out = { token, name, symbol, decimals: decimals == null ? 18 : Number(decimals) };
  if (owner) {
    const o = getAddress(owner);
    const [bal, usdc] = await Promise.all([
      read('balanceOf', [o]),
      publicClient.readContract({ address: getAddress(ARC_USDC), abi: ERC20, functionName: 'balanceOf', args: [o] }).catch(() => 0n),
    ]);
    out.balance = bal ?? 0n;
    out.usdcBalance = usdc ?? 0n;
  }
  return out;
}

/// An estimate for the swap page before anything is approved.
export async function estimateArcSwap({ token, side, amount }) {
  const pools = await findArcPools(token);
  if (!pools.length) throw new Error('no USDC pool for that token on Arc\'s V3 DEX');
  const p = pools[0];
  const info = await arcTokenInfo(token);
  const buying = side === 'buy';
  const tokenIn = buying ? getAddress(ARC_USDC) : p.token;
  const inDecimals = buying ? 6 : info.decimals;
  const outDecimals = buying ? info.decimals : 6;
  const amountIn = parseUnits(String(amount), inDecimals);
  const zeroForOne = tokenIn === p.token0;
  const out = quoteInRange({ ...p, zeroForOne, amountIn });
  return {
    pool: p.pool, fee: p.fee, amountIn, amountOut: out,
    amountOutUi: formatUnits(out, outDecimals), symbol: info.symbol,
  };
}

/// Buy with USDC or sell for USDC.
///
/// Order of operations is chosen so nothing is spent on a swap that would fail:
/// read the pool, approve only if the allowance is short, simulate the exact
/// call to learn the real output, then send with the slippage floor derived
/// from that simulation rather than from the estimate.
export async function arcSwap(opts) {
  const {
    privateKey, token: tokenAddress, side, amount, slippageBps = 500,
    approveMax = true, deadlineSeconds = 300, onStatus,
  } = opts;
  const say = (m) => onStatus && onStatus(m);
  const { publicClient, account, walletClient } = arcClients(privateKey);
  if (!account) throw new Error('no EVM key - the same key the launcher uses works on Arc');
  if (side !== 'buy' && side !== 'sell') throw new Error('side must be buy or sell');

  say('finding the pool…');
  const pools = await findArcPools(tokenAddress);
  if (!pools.length) throw new Error('no USDC pool for that token on Arc\'s V3 DEX');
  const p = pools[0];
  const info = await arcTokenInfo(tokenAddress, account.address);

  const buying = side === 'buy';
  const tokenIn = buying ? getAddress(ARC_USDC) : p.token;
  const tokenOut = buying ? p.token : getAddress(ARC_USDC);
  const inDecimals = buying ? 6 : info.decimals;
  const outDecimals = buying ? info.decimals : 6;
  const amountIn = parseUnits(String(amount), inDecimals);
  if (amountIn <= 0n) throw new Error('amount must be above zero');

  const have = buying ? info.usdcBalance : info.balance;
  if (have < amountIn) {
    throw new Error(`not enough ${buying ? 'USDC' : info.symbol}: have ${formatUnits(have, inDecimals)}, `
      + `need ${formatUnits(amountIn, inDecimals)}`);
  }

  const router = getAddress(ARC_V3_ROUTER);
  const allowance = await publicClient.readContract({
    address: tokenIn, abi: ERC20, functionName: 'allowance', args: [account.address, router],
  });
  if (allowance < amountIn) {
    say(`approving ${buying ? 'USDC' : info.symbol} for the router…`);
    const approveHash = await walletClient.writeContract({
      address: tokenIn, abi: ERC20, functionName: 'approve', args: [router, approveMax ? maxUint256 : amountIn],
    });
    const r = await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
    if (r.status !== 'success') throw new Error('approval reverted: ' + approveHash);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const args = (minOut) => [tokenIn, tokenOut, p.fee, account.address, amountIn, minOut, deadline];

  say('simulating…');
  const sim = await publicClient.call({
    account, to: router,
    data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: args(0n) }),
  });
  const expected = decodeFunctionResult({ abi: ROUTER_ABI, functionName: 'exactInputSingle', data: sim.data });
  if (expected <= 0n) throw new Error('the pool would return nothing for that amount');
  const minOut = (expected * BigInt(10_000 - slippageBps)) / 10_000n;
  say(`expecting ${formatUnits(expected, outDecimals)} ${buying ? info.symbol : 'USDC'}, `
    + `accepting no less than ${formatUnits(minOut, outDecimals)}`);

  say('sending…');
  const hash = await walletClient.writeContract({
    address: router, abi: ROUTER_ABI, functionName: 'exactInputSingle', args: args(minOut),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('swap reverted: ' + hash);

  return {
    hash, pool: p.pool, fee: p.fee,
    amountIn, expectedOut: expected, minOut,
    expectedOutUi: formatUnits(expected, outDecimals),
    outSymbol: buying ? info.symbol : 'USDC',
  };
}
