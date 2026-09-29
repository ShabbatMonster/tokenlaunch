import {
  createPublicClient, http, defineChain, getAddress, keccak256,
  encodeAbiParameters, parseAbiParameters,
} from 'viem';

// ---------------------------------------------------------------------------
// What a token is worth in ETH on Robinhood Chain.
//
// This exists so the v4 curve pad can do what the Meteora pad does: state the
// economics once, in one asset, and convert them into whatever quote is
// selected. On Solana that conversion is a Jupiter quote. There is no Jupiter
// here, so the price comes off the chain itself.
//
// It is read from Uniswap v4 by reconstructing PoolKeys rather than by scanning
// logs, for the reason swap.js records: this RPC rate-limits eth_getLogs hard
// enough that even a 100-block window answers 429, so a pool hunt by events is
// not available. A PoolId is just the keccak of its PoolKey, and every pool's
// slot0 can be read straight out of the PoolManager's storage with extsload -
// so the whole sweep is two batched multicalls and no logs at all.
//
// An uninitialised pool reads back zero, which is what makes this honest: a
// non-zero sqrtPriceX96 is proof the pool exists rather than a guess that it
// might. Where several pools exist the deepest one wins, because a price off a
// pool with no liquidity in it is a number, not a rate.
// ---------------------------------------------------------------------------

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const ROBINHOOD = defineChain({
  id: 4663, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
const MULTICALL3 = getAddress('0xca11bde05977b3631167028862be2a173976ca11');
export const WETH = getAddress('0x0bd7d308f8e1639fab988df18a8011f41eacad73');
const ZERO = '0x0000000000000000000000000000000000000000';

/// PoolManager keeps every pool in `mapping(PoolId => Pool.State) _pools` at
/// slot 6; Pool.State starts with the packed slot0 and holds liquidity three
/// slots later.
const POOLS_SLOT = 6n;
const DYNAMIC_FEE = 0x800000;

/// The fee/tickSpacing shapes actually seen on this chain. Pons graduations are
/// 0/200; Doppler multicurve pools are dynamic-fee on tickSpacing 8.
const V4_SHAPES = [
  [0, 200], [10000, 200], [0, 60], [3000, 60], [10000, 60], [2500, 25],
  [500, 10], [100, 1], [0, 8], [30000, 200],
  [DYNAMIC_FEE, 8], [DYNAMIC_FEE, 60], [DYNAMIC_FEE, 200],
];
const KNOWN_HOOKS = [
  getAddress('0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'), // Pons v2
  getAddress('0x57387759ea3a3116330f4bd2cae48b03091a2044'), // poz.fun
  ZERO,
];

const V4_POOL_KEY = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
];
const EXTSLOAD_ABI = [
  { type: 'function', name: 'extsload', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
];
const ERC20 = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
];

const v4PoolId = (k) => keccak256(encodeAbiParameters(V4_POOL_KEY, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
const v4StateSlot = (id) => keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint256'), [id, POOLS_SLOT]));
const addSlot = (slot, n) => `0x${(BigInt(slot) + BigInt(n)).toString(16).padStart(64, '0')}`;

export const publicClient = () => createPublicClient({
  chain: ROBINHOOD,
  // this RPC answers 429 rather than queueing, and viem's default 150ms retry
  // is far too fast to get out from under it
  transport: http(RPC, { retryCount: 6, retryDelay: 700 }),
});

const Q96 = 2n ** 96n;

/// Every initialised v4 pool pairing `token` with native ETH or WETH.
async function ethPools(pub, token) {
  const t = getAddress(token);
  const cands = [];
  for (const hooks of KNOWN_HOOKS) {
    for (const quote of [ZERO, WETH]) {
      if (quote === t) continue;
      const tokenIs0 = t.toLowerCase() < quote.toLowerCase();
      const currency0 = tokenIs0 ? t : quote;
      const currency1 = tokenIs0 ? quote : t;
      for (const [fee, tickSpacing] of V4_SHAPES) {
        const key = { currency0, currency1, fee, tickSpacing, hooks };
        cands.push({ key, quote, tokenIs0, id: v4PoolId(key) });
      }
    }
  }

  const slot0s = await pub.multicall({
    multicallAddress: MULTICALL3, allowFailure: true, batchSize: 0,
    contracts: cands.map((c) => ({
      address: POOL_MANAGER, abi: EXTSLOAD_ABI, functionName: 'extsload', args: [v4StateSlot(c.id)],
    })),
  });

  const hits = [];
  for (let i = 0; i < cands.length; i++) {
    const r = slot0s[i];
    if (r.status !== 'success' || !r.result) continue;
    const sqrtPriceX96 = BigInt(r.result) & ((1n << 160n) - 1n);
    if (sqrtPriceX96 === 0n) continue;   // uninitialised reads back zero
    hits.push({ ...cands[i], sqrtPriceX96 });
  }
  if (!hits.length) return [];

  const liqs = await pub.multicall({
    multicallAddress: MULTICALL3, allowFailure: true, batchSize: 0,
    contracts: hits.map((h) => ({
      address: POOL_MANAGER, abi: EXTSLOAD_ABI, functionName: 'extsload', args: [addSlot(v4StateSlot(h.id), 3)],
    })),
  });
  return hits.map((h, i) => ({
    ...h,
    liquidity: liqs[i].status === 'success' ? (BigInt(liqs[i].result) & ((1n << 128n) - 1n)) : 0n,
  }));
}

/// How many raw units of `token` one whole ETH is worth.
///
/// Returned as a bigint in the token's own units so the caller never has to
/// round-trip through a float - a memecoin priced at 1e-9 ETH would lose its
/// low digits, and that is the number a threshold gets built from.
export async function tokenPerEth({ token, decimals, connection: pc }) {
  const pub = pc || publicClient();
  const t = token === ZERO || token == null ? ZERO : getAddress(token);

  // native ETH and its wrapper are one-for-one, and there is no pool to read
  if (t === ZERO || t === WETH) {
    return { perEth: 10n ** 18n, decimals: 18, source: t === ZERO ? 'native' : 'wrapped', liquidity: null };
  }

  const dec = decimals ?? await pub.readContract({ address: t, abi: ERC20, functionName: 'decimals' });
  const pools = await ethPools(pub, t);
  if (!pools.length) {
    throw new Error(
      'no Uniswap v4 pool pairs this token with ETH on Robinhood Chain, so there is no rate to convert at. '
      + 'Type the threshold in the quote token directly.',
    );
  }
  // deepest wins: a price off an empty pool is a number, not a rate
  pools.sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0));
  const p = pools[0];

  // sqrtPriceX96 is sqrt(price of currency1 in currency0) scaled by 2^96, both
  // sides in raw units. Squaring in bigint and dividing at the end keeps every
  // digit; doing it in floats loses the small ones, which is exactly where a
  // memecoin's price lives.
  const num = p.sqrtPriceX96 * p.sqrtPriceX96;
  const ONE_ETH = 10n ** 18n;
  // token is currency1 => 1 currency0 (ETH) buys num/2^192 of currency1
  // token is currency0 => 1 currency1 (ETH) buys 2^192/num of currency0
  const perEth = p.tokenIs0
    ? (ONE_ETH * Q96 * Q96) / num
    : (ONE_ETH * num) / (Q96 * Q96);

  if (perEth <= 0n) throw new Error('the ETH pool for this token prices it at zero - refusing to build a threshold from that');
  return { perEth, decimals: Number(dec), source: 'v4', liquidity: p.liquidity, poolId: p.id, fee: p.key.fee, tickSpacing: p.key.tickSpacing };
}

/// The launch shape, stated once in ETH and converted into whatever the curve
/// is quoted in. The Meteora pad does the same thing through Jupiter; this is
/// the Robinhood Chain half of the same idea.
export const RH_ECONOMICS = {
  graduateEth: 4.2,
  openEth: 1.3,
};

const ethToRaw = (eth, perEth) => {
  // eth is a human number like 4.2; scale it to wei first so the multiply is
  // exact in bigint rather than rounded through a float
  const wei = BigInt(Math.round(eth * 1e9)) * 10n ** 9n;
  return (wei * perEth) / 10n ** 18n;
};

/// What to put in the threshold and opening-market-cap boxes for `quoteToken`.
export async function rhEconomicsFor({ quoteToken, decimals, economics = RH_ECONOMICS, connection }) {
  const { perEth, decimals: dec, source, liquidity } = await tokenPerEth({ token: quoteToken, decimals, connection });
  return {
    perEth: perEth.toString(),
    decimals: dec,
    source,
    liquidity: liquidity == null ? null : liquidity.toString(),
    graduationThreshold: ethToRaw(economics.graduateEth, perEth).toString(),
    startMarketCap: ethToRaw(economics.openEth, perEth).toString(),
    graduateEth: economics.graduateEth,
    openEth: economics.openEth,
  };
}
