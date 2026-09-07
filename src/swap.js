import {
  createPublicClient, createWalletClient, http, defineChain, isAddress, getAddress,
  formatEther, formatUnits, parseUnits, keccak256, encodeAbiParameters, parseAbiParameters,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Swap — trades any token on Robinhood chain, across every venue that exists
// here, against whatever that venue is quoted in. Five are searched: the
// bonding curve a poz.fun / Pons v2 token sits on before it graduates, a
// lightoor.fun curve (and its USDG zap), a long.xyz zap, Abyss, and Uniswap v4.
//
//   venue "abyss" — a v3-style DEX. Modelled on the reference trade
//     tx 0x7c6277f6…c7a9d -> router.exactInputSingleFromETH(key, …) with the
//     ETH attached as value; the router wraps to WETH and swaps the pool.
//     WETH is NOT the only quote: of the pools on this factory USDG is the
//     most common, and several pairs (TENDIES/USDG, RIVN/DIESEL,
//     USDG/OUROBOROS) never touch WETH at all. So every pool containing the
//     token is discovered, whatever the other side is, and routed as:
//       quote is WETH  -> exactInputSingleFromETH / exactInputSingleToETH, so
//                         the user just spends and receives native ETH
//       anything else  -> exactInputSingle, with an approval on the token
//                         being spent
//     The pool "key" the router wants is (currency0, currency1, uint8 profile,
//     uint24 fee, bool flag, bytes32 extra). profile/flag/extra are NOT
//     derivable from the pair — live pools use profiles 0..3 with differing
//     flags — so they are read off the factory creation event, not guessed.
//
//   venue "v4" — Uniswap v4, where the bonding-curve launchpads (Pons v2 and
//     its forks, e.g. poz.fun) put a token once it graduates. See the v4
//     discovery section below for why the pool has to be found by deriving
//     PoolKeys rather than by reading logs.
// ---------------------------------------------------------------------------

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const ROUTER = getAddress('0xf2a3afb36768950eb2c7f04583328c09aec0c366');
const V3_FACTORY = getAddress('0xe7fef2bc860b25bbdeb6f6ab96d88baaa77ddad7');
const WETH = getAddress('0x0bd7d308f8e1639fab988df18a8011f41eacad73');
const ZERO = '0x0000000000000000000000000000000000000000';

// v3 sqrt price bounds; a swap passes the far bound to mean "no price limit"
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;

// --- Uniswap v4 -------------------------------------------------------------
// Addresses are written lowercase and normalised through getAddress() on
// purpose: a hand-typed EIP-55 checksum that is one character off is rejected
// by viem at call time with a useless "Address is invalid", and it has bitten
// this repo twice. Lowercase always checksums correctly.
const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
const UNIVERSAL_ROUTER = getAddress('0x8876789976decbfcbbbe364623c63652db8c0904');
const PERMIT2 = getAddress('0x000000000022d473030f116ddee9f6b43ac78ba3');
const V4_QUOTER = getAddress('0x8dc178efb8111bb0973dd9d722ebeff267c98f94');
const MULTICALL3 = getAddress('0xca11bde05977b3631167028862be2a173976ca11');

// long.xyz runs a Doppler Airlock. Its assets are registered there, which is how
// their numeraire and pool hook get discovered rather than guessed.
const AIRLOCK = getAddress('0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862');

// Known launchpad hooks, used only as a fallback when a token does not name its
// own factory. Pons v2 and poz.fun run byte-identical factories, but each mines
// its own hook address, so the hook differs per pad.
const KNOWN_HOOKS = [
  getAddress('0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'), // Pons v2
  getAddress('0x57387759ea3a3116330f4bd2cae48b03091a2044'), // poz.fun
];

// PoolManager keeps every pool in `mapping(PoolId => Pool.State) _pools` at
// slot 6. Pool.State starts with the packed slot0 and holds `liquidity` three
// slots in; both are read with extsload(bytes32).
const POOLS_SLOT = 6n;

const CHAIN = defineChain({
  id: 4663, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

// The real event name is AbyssPoolCreated, NOT PoolCreated (the factory emits a
// second, classic-shaped PoolCreated too, but that one omits the profile/flag/
// extra fields this router needs). Verified against topic0
// 0x50d43e7e…0ed6 — a guessed name computes a different topic0 and silently
// matches nothing at any block range.
const POOL_CREATED = {
  type: 'event', name: 'AbyssPoolCreated',
  inputs: [
    { name: 'token0', type: 'address', indexed: true },
    { name: 'token1', type: 'address', indexed: true },
    { name: 'fee', type: 'uint24', indexed: true },
    { name: 'profile', type: 'uint8', indexed: false },
    { name: 'flag', type: 'bool', indexed: false },
    { name: 'extra', type: 'bytes32', indexed: false },
    { name: 'pool', type: 'address', indexed: false },
  ],
};

const KEY_TUPLE = {
  name: 'key', type: 'tuple', components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
    { name: 'profile', type: 'uint8' }, { name: 'fee', type: 'uint24' },
    { name: 'flag', type: 'bool' }, { name: 'extra', type: 'bytes32' },
  ],
};
const SWAP_INPUTS = [
  KEY_TUPLE,
  { name: 'recipient', type: 'address' }, { name: 'zeroForOne', type: 'bool' },
  { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' },
  { name: 'sqrtPriceLimitX96', type: 'uint160' }, { name: 'deadline', type: 'uint256' },
];
const ROUTER_ABI = [
  { type: 'function', name: 'exactInputSingle', inputs: SWAP_INPUTS, outputs: [{ type: 'uint256' }], stateMutability: 'payable' },
  { type: 'function', name: 'exactInputSingleFromETH', inputs: SWAP_INPUTS, outputs: [{ type: 'uint256' }], stateMutability: 'payable' },
  { type: 'function', name: 'exactInputSingleToETH', inputs: SWAP_INPUTS, outputs: [{ type: 'uint256' }], stateMutability: 'payable' },
  { type: 'error', name: 'SlippageExceeded', inputs: [] },
  { type: 'error', name: 'DeadlineExpired', inputs: [] },
  { type: 'error', name: 'TokenTransferFailed', inputs: [] },
  { type: 'error', name: 'NonCanonicalPoolKey', inputs: [] },
  { type: 'error', name: 'EmptyRoute', inputs: [] },
];
const ERC20 = [
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];
const POOL_ABI = [
  { type: 'function', name: 'liquidity', inputs: [], outputs: [{ type: 'uint128' }], stateMutability: 'view' },
  { type: 'function', name: 'slot0', inputs: [], outputs: [
    { type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' },
  ], stateMutability: 'view' },
];

// launchpad token -> its curve -> the quote it was paired against, and
// token -> its factory -> the v4 hook that factory mines for its pools
const LAUNCH_TOKEN_ABI = [
  { type: 'function', name: 'curve', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'launchFactory', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];
const LAUNCH_CURVE_ABI = [
  { type: 'function', name: 'pairToken', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];
const LAUNCH_FACTORY_ABI = [
  { type: 'function', name: 'memeHook', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];

// The bonding curve itself, for tokens that have NOT graduated yet. Signatures
// resolved from the deployed clone's bytecode (selector scan -> openchain) and
// then confirmed against the live contract: buy() is
// buy(quoteAmountIn, minTokensOut, recipient) and returns the tokens out, which
// was verified by simulating all three plausible argument orders — the other
// two revert. Both directions were simulated end to end before being wired up.
const CURVE_ABI = [
  { type: 'function', name: 'buy', stateMutability: 'payable', outputs: [{ type: 'uint256' }],
    inputs: [{ name: 'quoteAmountIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' }, { name: 'recipient', type: 'address' }] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', outputs: [{ type: 'uint256' }],
    inputs: [{ name: 'tokenAmountIn', type: 'uint256' }, { name: 'minQuoteOut', type: 'uint256' }, { name: 'recipient', type: 'address' }] },
  { type: 'function', name: 'getReserves', inputs: [], outputs: [{ type: 'uint256' }, { type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'graduated', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'readyToGraduate', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'pairToken', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'isNativeQuote', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'feeBps', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'creatorTaxBps', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'snipeTaxStartBps', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'snipeTaxSeconds', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'currentSnipeTaxBps', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'graduationThreshold', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'realQuoteReserve', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'error', name: 'SlippageExceeded', inputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'error', name: 'AlreadyGraduated', inputs: [] },
  { type: 'error', name: 'InsufficientLiquidity', inputs: [] },
  { type: 'error', name: 'InsufficientInputAmount', inputs: [] },
  { type: 'error', name: 'InsufficientOutputAmount', inputs: [] },
  { type: 'error', name: 'MinimumOutputRequired', inputs: [] },
  { type: 'error', name: 'UnexpectedNativeValue', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
];

const AIRLOCK_ABI = [{
  type: 'function', name: 'getAssetData', stateMutability: 'view',
  inputs: [{ name: 'asset', type: 'address' }],
  outputs: [
    { name: 'numeraire', type: 'address' }, { name: 'timelock', type: 'address' },
    { name: 'governance', type: 'address' }, { name: 'liquidityMigrator', type: 'address' },
    { name: 'poolInitializer', type: 'address' }, { name: 'pool', type: 'address' },
    { name: 'migrationPool', type: 'address' }, { name: 'numTokensToSell', type: 'uint256' },
    { name: 'totalSupply', type: 'uint256' }, { name: 'integrator', type: 'address' },
  ],
}];

// A long.xyz coin paired against a basket vault ships its own zap router: the
// vault names it as minter(), and it exposes buy()/sell() straight against
// native ETH. Signatures resolved from the deployed implementation and
// confirmed live — buy() is buy(minAmountOut, deadline) payable, verified by
// simulating every plausible argument order (the others revert).
const ZAP_ABI = [
  { type: 'function', name: 'buy', stateMutability: 'payable', outputs: [{ type: 'uint256' }],
    inputs: [{ name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', outputs: [{ type: 'uint256' }],
    inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  { type: 'function', name: 'coin', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'VAULT', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'configured', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'error', name: 'InsufficientAllowance', inputs: [] },
  { type: 'error', name: 'Insufficient', inputs: [] },
  { type: 'error', name: 'BadArgs', inputs: [] },
];
const VAULT_ABI = [
  { type: 'function', name: 'minter', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];

// lightoor.fun: a bonding-curve launchpad whose tokens are quoted in whatever
// the creator picked — including its own 5x leveraged tokens, which have no
// market anywhere else. Addresses come from the app's own config object.
const LIGHTOOR_PAD = getAddress('0xf64a44b7cf15d5368defcef0b0693a862dacb099');
const LIGHTOOR_ZAP = getAddress('0xfb5d9b9ae724efbff002b5897447c0d0750ad12c');
const USDG = getAddress('0x5fc5360d0400a0fd4f2af552add042d716f1d168');

const LIGHTOOR_CURVE = [
  { name: 'creator', type: 'address' }, { name: 'quoteToken', type: 'address' },
  { name: 'pool', type: 'address' }, { name: 'virtualQuote', type: 'uint128' },
  { name: 'virtualToken', type: 'uint128' }, { name: 'realQuote', type: 'uint128' },
  { name: 'tokenReserve', type: 'uint128' }, { name: 'graduationQuote', type: 'uint128' },
  { name: 'createdAt', type: 'uint64' }, { name: 'graduated', type: 'bool' },
];
const LIGHTOOR_PAD_ABI = [
  { type: 'function', name: 'getToken', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'curve', type: 'tuple', components: LIGHTOOR_CURVE },
      { name: 'meta', type: 'tuple', components: [
        { name: 'image', type: 'string' }, { name: 'description', type: 'string' },
        { name: 'twitter', type: 'string' }, { name: 'telegram', type: 'string' }, { name: 'website', type: 'string' }] },
      { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }] },
  { type: 'function', name: 'previewBuy', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }, { name: 'quoteIn', type: 'uint256' }],
    outputs: [{ name: 'tokensOut', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' },
              { name: 'creatorFee', type: 'uint256' }, { name: 'willGraduate', type: 'bool' }] },
  { type: 'function', name: 'previewSell', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }, { name: 'tokenIn', type: 'uint256' }],
    outputs: [{ name: 'quoteOut', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }, { name: 'creatorFee', type: 'uint256' }] },
  { type: 'function', name: 'buy', stateMutability: 'payable', outputs: [{ type: 'uint256' }],
    inputs: [{ name: 'token', type: 'address' }, { name: 'quoteIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' }] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', outputs: [{ type: 'uint256' }],
    inputs: [{ name: 'token', type: 'address' }, { name: 'tokenIn', type: 'uint256' }, { name: 'minQuoteOut', type: 'uint256' }] },
  { type: 'function', name: 'protocolFeeBps', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'creatorFeeBps', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];
// the zap wraps the same curve but settles in USDG, minting/redeeming the
// leveraged quote token for you. It is the only public caller the LT factory
// accepts (everything else gets NotZap()), so for an LT-quoted token this is
// the only way in or out that does not require already holding the LT.
const LIGHTOOR_ZAP_ABI = [
  { type: 'function', name: 'previewBuyUsdg', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }, { name: 'usdgIn', type: 'uint256' }],
    outputs: [{ name: 'tokensOut', type: 'uint256' }, { name: 'ltIn', type: 'uint256' }] },
  { type: 'function', name: 'previewSellUsdg', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }, { name: 'tokenIn', type: 'uint256' }],
    outputs: [{ name: 'usdgOut', type: 'uint256' }, { name: 'ltOut', type: 'uint256' }] },
  { type: 'function', name: 'buy', stateMutability: 'nonpayable', outputs: [{ type: 'uint256' }],
    inputs: [{ name: 'token', type: 'address' }, { name: 'usdgIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' }] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', outputs: [{ type: 'uint256' }],
    inputs: [{ name: 'token', type: 'address' }, { name: 'tokenIn', type: 'uint256' }, { name: 'minUsdgOut', type: 'uint256' }] },
];

const V4_POOL_KEY = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
];
const EXTSLOAD_ABI = [
  { type: 'function', name: 'extsload', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
];
const V4_QUOTER_ABI = [{
  type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'poolKey', type: 'tuple', components: V4_POOL_KEY },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'exactAmount', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
}];
const UNIVERSAL_ROUTER_ABI = [{
  type: 'function', name: 'execute', stateMutability: 'payable',
  inputs: [
    { name: 'commands', type: 'bytes' },
    { name: 'inputs', type: 'bytes[]' },
    { name: 'deadline', type: 'uint256' },
  ],
  outputs: [],
}];
const PERMIT2_ABI = [
  { type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint160' }, { type: 'uint48' }],
    outputs: [] },
];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// This RPC rate-limits hard and answers 429 "Too Many Requests" rather than
// queueing, so back off generously — viem retries 429s, but its default 150ms
// delay is far too fast to get out from under this limiter.
const transport = () => http(RPC, { retryCount: 6, retryDelay: 700 });
const pub = createPublicClient({ chain: CHAIN, transport: transport() });

const KEYS_KEY = 'keys.v1';
const loadKeys = () => { try { return JSON.parse(localStorage.getItem(KEYS_KEY) || 'null'); } catch { return null; } };

let account = null;
let wallet = null;
let ctx = null;      // { token, symbol, decimals, pools: [...] }
let sel = 0;         // index into ctx.pools
let mode = 'buy';
let quoteNote = '';  // extra warning shown under the quote (e.g. live snipe tax)

const fmtErr = (e) => e?.shortMessage || e?.message || String(e);
/// A curve that is asked to pay out more quote than it actually holds reverts
/// with a bare arithmetic panic rather than a named error, which reads as a bug
/// when it is really just "this is more than the curve can buy back".
const describeErr = (e) => {
  const m = fmtErr(e);
  const v = pool()?.venue;
  if ((v === 'curve' || v === 'lightoor' || v === 'lightoor-usdg') && /underflow|overflow|InsufficientQuote|exceeds/i.test(m)) {
    const p = pool();
    const sym = p.curveQuoteSymbol ?? p.quoteSymbol;
    const dec = p.curveQuoteSymbol ? 18 : p.quoteDecimals;
    return `more than the curve can pay out — it only holds ${formatUnits(p.exitLiquidity, dec)} ${sym}. Sell a smaller amount.`;
  }
  return m;
};
const pool = () => ctx?.pools[sel];
/// a pool whose quote side is spendable as native ETH, so no approval is needed
/// (abyss wraps WETH for you; v4 uses address(0) as the native currency)
const isNativePool = () => {
  const p = pool();
  if (!p) return false;
  if (p.venue === 'abyss') return p.quote === WETH;
  return p.quote === ZERO; // v4 and curve both use address(0) for native ETH
};

// ---------------------------------------------------------------------------
// abyss pool discovery — every pool containing the token, any counterparty
// ---------------------------------------------------------------------------
async function findAbyssPools(token) {
  const [asToken0, asToken1] = await Promise.all([
    pub.getLogs({ address: V3_FACTORY, event: POOL_CREATED, args: { token0: token }, fromBlock: 0n, toBlock: 'latest' }).catch(() => []),
    pub.getLogs({ address: V3_FACTORY, event: POOL_CREATED, args: { token1: token }, fromBlock: 0n, toBlock: 'latest' }).catch(() => []),
  ]);

  const out = [];
  for (const l of [...asToken0, ...asToken1]) {
    const a = l.args;
    const token0 = getAddress(a.token0);
    const token1 = getAddress(a.token1);
    const tokenIs0 = token0 === getAddress(token);
    const quote = tokenIs0 ? token1 : token0;
    const [quoteSymbol, quoteDecimals, liquidity] = await Promise.all([
      pub.readContract({ address: quote, abi: ERC20, functionName: 'symbol' }).catch(() => '???'),
      pub.readContract({ address: quote, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
      pub.readContract({ address: a.pool, abi: POOL_ABI, functionName: 'liquidity' }).catch(() => 0n),
    ]);
    out.push({
      venue: 'abyss', label: 'Abyss',
      pool: a.pool, quote, quoteSymbol, quoteDecimals, tokenIs0, fee: a.fee, liquidity,
      key: {
        currency0: token0, currency1: token1,
        profile: a.profile, fee: a.fee, flag: a.flag, extra: a.extra,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Uniswap v4 pool discovery
//
// v4 has no per-pool contract and no factory event to filter on — a pool is
// just the keccak of its PoolKey inside the PoolManager singleton. The obvious
// route (scan the PoolManager's Initialize event) does not work here: this
// chain's RPC rate-limits eth_getLogs hard enough that even a 100-block window
// comes back "Too Many Requests", so a multi-million-block scan is out.
//
// So the PoolKey gets reconstructed instead. For a launchpad token only two of
// its five fields are actually unknown — the rest come off the token itself:
//
//   currency0/1     token + curve.pairToken(), sorted. pairToken is
//                   address(0) when the token launched against native ETH,
//                   and address(0) always sorts first.
//   hooks           token.launchFactory().memeHook()
//   fee/tickSpacing swept over the shapes below
//
// Every candidate is hashed to a PoolId and its slot0 read straight out of the
// PoolManager's storage with extsload, batched through Multicall3 — one RPC
// round trip for the whole sweep. An uninitialised pool reads back zero, so a
// non-zero sqrtPriceX96 is proof the pool exists rather than a guess that it
// might. (poz.fun's PEZ, for the record, turned out to be fee 0 / tickSpacing
// 200, which is not a combination worth guessing blind.)
// ---------------------------------------------------------------------------
const DYNAMIC_FEE = 0x800000;
const V4_SHAPES = [
  [0, 200], [10000, 200], [0, 60], [3000, 60], [10000, 60], [2500, 25],
  [500, 10], [100, 1], [0, 8], [30000, 200],
  // long.xyz / Doppler multicurve pools are dynamic-fee on tickSpacing 8
  [DYNAMIC_FEE, 8], [DYNAMIC_FEE, 60], [DYNAMIC_FEE, 200],
];

const v4PoolId = (k) => keccak256(encodeAbiParameters(V4_POOL_KEY, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
const v4StateSlot = (id) => keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint256'), [id, POOLS_SLOT]));
const addSlot = (slot, n) => `0x${(BigInt(slot) + BigInt(n)).toString(16).padStart(64, '0')}`;

/// read the launchpad breadcrumbs a graduated token leaves on itself
async function launchpadHints(token) {
  const [curve, factory] = await Promise.all([
    pub.readContract({ address: token, abi: LAUNCH_TOKEN_ABI, functionName: 'curve' }).catch(() => null),
    pub.readContract({ address: token, abi: LAUNCH_TOKEN_ABI, functionName: 'launchFactory' }).catch(() => null),
  ]);
  const [pairToken, hook] = await Promise.all([
    curve ? pub.readContract({ address: curve, abi: LAUNCH_CURVE_ABI, functionName: 'pairToken' }).catch(() => null) : null,
    factory ? pub.readContract({ address: factory, abi: LAUNCH_FACTORY_ABI, functionName: 'memeHook' }).catch(() => null) : null,
  ]);
  return { curve, factory, pairToken, hook };
}

async function findV4Pools(token, dop) {
  const hints = await launchpadHints(token);

  // NB: `.map(getAddress)` would hand the array index to viem as an EIP-1191
  // chainId and blow up on the second element — always wrap it.
  const norm = (a) => getAddress(a);
  // a Doppler pool's hook IS its poolInitializer (the address carries the v4
  // permission bits), and its quote is the Airlock-registered numeraire
  const hooks = [...new Set([hints.hook, dop?.poolInitializer, ...KNOWN_HOOKS, ZERO].filter(Boolean).map(norm))];
  const quotes = [...new Set([hints.pairToken, dop?.numeraire, ZERO, WETH].filter(Boolean).map(norm))];

  // build every candidate key, with the currencies in v4's canonical order
  const cands = [];
  for (const hooksAddr of hooks) {
    for (const quote of quotes) {
      if (quote === token) continue;
      const tokenIs0 = token.toLowerCase() < quote.toLowerCase();
      const currency0 = tokenIs0 ? token : quote;
      const currency1 = tokenIs0 ? quote : token;
      for (const [fee, tickSpacing] of V4_SHAPES) {
        const key = { currency0, currency1, fee, tickSpacing, hooks: hooksAddr };
        cands.push({ key, quote, tokenIs0, id: v4PoolId(key) });
      }
    }
  }

  // one batched pass for slot0; anything non-zero is a real, initialised pool
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
    const packed = BigInt(r.result);
    const sqrtPriceX96 = packed & ((1n << 160n) - 1n);
    if (sqrtPriceX96 === 0n) continue;
    let tick = Number((packed >> 160n) & 0xffffffn);
    if (tick >= 0x800000) tick -= 0x1000000;
    hits.push({ ...cands[i], sqrtPriceX96, tick });
  }
  if (!hits.length) return [];

  // second batched pass for the live liquidity of the pools that do exist
  const liqs = await pub.multicall({
    multicallAddress: MULTICALL3, allowFailure: true, batchSize: 0,
    contracts: hits.map((h) => ({
      address: POOL_MANAGER, abi: EXTSLOAD_ABI, functionName: 'extsload', args: [addSlot(v4StateSlot(h.id), 3)],
    })),
  });

  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const liquidity = liqs[i].status === 'success' ? (BigInt(liqs[i].result) & ((1n << 128n) - 1n)) : 0n;
    const [quoteSymbol, quoteDecimals] = h.quote === ZERO
      ? ['ETH', 18]
      : await Promise.all([
        pub.readContract({ address: h.quote, abi: ERC20, functionName: 'symbol' }).catch(() => '???'),
        pub.readContract({ address: h.quote, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
      ]);
    out.push({
      venue: 'v4', label: 'Uniswap v4',
      poolId: h.id, key: h.key, quote: h.quote, quoteSymbol, quoteDecimals,
      tokenIs0: h.tokenIs0, fee: h.key.fee, tickSpacing: h.key.tickSpacing,
      hooks: h.key.hooks, tick: h.tick, sqrtPriceX96: h.sqrtPriceX96, liquidity,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// lightoor.fun discovery
//
// A third shape of "no market". These tokens sit on a bonding curve like
// poz.fun's, but the curve is quoted in whatever the creator chose — and that
// is often one of lightoor's own leveraged tokens (LIGER is quoted in xLIT5L,
// "LIT 5x Long"). Those LTs have no pool on any DEX, cannot be minted or
// redeemed by you directly — the factory answers NotZap() to everyone except
// the zap — and so a token quoted in one looks completely unreachable.
//
// Two routes are offered. The launchpad itself, if you already hold the quote
// token; and the zap, which settles the same curve in USDG and mints or
// redeems the leveraged quote token for you inside the call. For an LT-quoted
// token the zap is the only way in or out, so it is listed first.
//
// Quotes are exact and need no allowance: previewBuy / previewSell are plain
// view functions on the launchpad, so a number shows before you approve
// anything.
// ---------------------------------------------------------------------------
async function findLightoor(token) {
  const g = await pub.readContract({
    address: LIGHTOOR_PAD, abi: LIGHTOOR_PAD_ABI, functionName: 'getToken', args: [token],
  }).catch(() => null);
  const c = g?.[0];
  if (!c || getAddress(c.creator) === ZERO) return [];
  // once it graduates the curve is done and the pool it names is the venue,
  // which the v4 / Abyss sweeps already cover
  if (c.graduated) return [];

  const quote = getAddress(c.quoteToken);
  const [quoteSymbol, quoteDecimals] = quote === ZERO
    ? ['ETH', 18]
    : await Promise.all([
      pub.readContract({ address: quote, abi: ERC20, functionName: 'symbol' }).catch(() => '???'),
      pub.readContract({ address: quote, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
    ]);
  const [protocolFeeBps, creatorFeeBps] = await Promise.all([
    pub.readContract({ address: LIGHTOOR_PAD, abi: LIGHTOOR_PAD_ABI, functionName: 'protocolFeeBps' }).catch(() => 0n),
    pub.readContract({ address: LIGHTOOR_PAD, abi: LIGHTOOR_PAD_ABI, functionName: 'creatorFeeBps' }).catch(() => 0n),
  ]);

  const shared = {
    label: 'lightoor.fun', curve: c, token,
    feeBps: protocolFeeBps ?? 0n, creatorTaxBps: creatorFeeBps ?? 0n,
    fee: Number((protocolFeeBps ?? 0n) + (creatorFeeBps ?? 0n)) * 100,
    raised: c.realQuote, threshold: c.graduationQuote,
    // a sell can only be paid out of the quote the curve really holds
    exitLiquidity: c.realQuote,
  };

  const out = [];
  // does the USDG zap accept this token? ask it rather than assume.
  const zapOk = await pub.readContract({
    address: LIGHTOOR_ZAP, abi: LIGHTOOR_ZAP_ABI, functionName: 'previewBuyUsdg',
    args: [token, 1_000_000n],
  }).catch(() => null);
  if (zapOk) {
    out.push({
      ...shared, venue: 'lightoor-usdg', label: 'lightoor.fun (USDG)',
      quote: USDG, quoteSymbol: 'USDG', quoteDecimals: 6,
      curveQuoteSymbol: quoteSymbol, liquidity: c.realQuote,
    });
  }
  out.push({
    ...shared, venue: 'lightoor',
    quote, quoteSymbol, quoteDecimals, curveQuoteSymbol: quoteSymbol,
    liquidity: c.realQuote,
  });
  return out;
}

// ---------------------------------------------------------------------------
// Doppler / long.xyz discovery
//
// The other case terminals miss, for the opposite reason to a bonding curve:
// the pool exists and is deep, but it is not quoted in anything you hold. A
// long.xyz coin is paired against its own numeraire — for LONGfolio that is
// L8NG, an 8-token basket vault that itself has no pool against ETH anywhere.
// So "swap in" looks impossible: there is no ETH route, and routers that only
// know ETH-quoted pools find nothing.
//
// There is a route. The vault names a minter(), which is really a zap router
// carrying the pool's v4 hook, and it exposes buy()/sell() straight against
// native ETH — it wraps, mints the vault token and swaps the v4 pool in one
// call. So the zap is offered as the venue, and the underlying v4 pool is
// offered too for anyone already holding the numeraire.
//
// Everything here is derived and then checked, never assumed: the Airlock
// names the numeraire and the pool initializer (whose address carries the v4
// hook permission bits), the numeraire names the zap, and the zap is only
// trusted once coin() and VAULT() point back at this exact token and numeraire.
// ---------------------------------------------------------------------------
async function dopplerHints(token) {
  const d = await pub.readContract({
    address: AIRLOCK, abi: AIRLOCK_ABI, functionName: 'getAssetData', args: [token],
  }).catch(() => null);
  if (!d || getAddress(d[0]) === ZERO) return null;
  return { numeraire: getAddress(d[0]), poolInitializer: getAddress(d[4]) };
}

async function findZapPool(token, hints) {
  if (!hints) return [];
  const minter = await pub.readContract({
    address: hints.numeraire, abi: VAULT_ABI, functionName: 'minter',
  }).catch(() => null);
  if (!minter || getAddress(minter) === ZERO) return [];
  const zap = getAddress(minter);

  // only trust it if it points back at this token and this numeraire
  const [coin, vault, configured] = await Promise.all([
    pub.readContract({ address: zap, abi: ZAP_ABI, functionName: 'coin' }).catch(() => null),
    pub.readContract({ address: zap, abi: ZAP_ABI, functionName: 'VAULT' }).catch(() => null),
    pub.readContract({ address: zap, abi: ZAP_ABI, functionName: 'configured' }).catch(() => null),
  ]);
  if (!coin || getAddress(coin) !== token) return [];
  if (!vault || getAddress(vault) !== hints.numeraire) return [];
  if (configured === false) return [];

  const numeraireSymbol = await pub.readContract({
    address: hints.numeraire, abi: ERC20, functionName: 'symbol',
  }).catch(() => '???');

  return [{
    venue: 'zap', label: 'long.xyz zap (ETH)', zap,
    quote: ZERO, quoteSymbol: 'ETH', quoteDecimals: 18,
    numeraire: hints.numeraire, numeraireSymbol,
    fee: 0, liquidity: 0n,
  }];
}

// ---------------------------------------------------------------------------
// bonding-curve discovery
//
// The case the DEX terminals miss. A poz.fun / Pons v2 token spends the first
// part of its life with NO pool at all — the only liquidity is the launch
// curve itself, which holds the whole float and quotes against a virtual
// reserve (phantomQuote = graduationThreshold * 2/5). Anything that discovers
// markets by scanning DEX factories therefore sees nothing and calls the token
// untradeable, right up until it graduates.
//
// It is perfectly tradeable: the curve has buy()/sell() and will fill you
// immediately. So when the token names a curve that has not graduated, offer
// the curve as a venue directly.
//
// Watch the snipe tax. These curves start with a punitive tax (99% observed)
// that decays to zero over the first few seconds after launch, so a buy landing
// in that window is nearly a total loss. It is read live, per-address, and
// surfaced rather than silently priced in.
// ---------------------------------------------------------------------------
async function findCurvePool(token) {
  const curve = await pub.readContract({ address: token, abi: LAUNCH_TOKEN_ABI, functionName: 'curve' }).catch(() => null);
  if (!curve || getAddress(curve) === ZERO) return [];

  const rd = (fn, args) => pub.readContract({ address: curve, abi: CURVE_ABI, functionName: fn, args }).catch(() => null);
  const [graduated, reserves, pairToken] = await Promise.all([rd('graduated'), rd('getReserves'), rd('pairToken')]);
  // once it has graduated the curve is empty and the v4 pool is the real venue
  if (graduated !== false || !reserves) return [];

  const [feeBps, creatorTaxBps, snipeStart, snipeSecs, threshold, realQuote] = await Promise.all([
    rd('feeBps'), rd('creatorTaxBps'), rd('snipeTaxStartBps'), rd('snipeTaxSeconds'),
    rd('graduationThreshold'), rd('realQuoteReserve'),
  ]);
  const quote = pairToken ? getAddress(pairToken) : ZERO;
  const [quoteSymbol, quoteDecimals] = quote === ZERO
    ? ['ETH', 18]
    : await Promise.all([
      pub.readContract({ address: quote, abi: ERC20, functionName: 'symbol' }).catch(() => '???'),
      pub.readContract({ address: quote, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
    ]);

  // What the curve can actually pay out on a sell is bounded by the quote it
  // really holds, NOT by its (largely virtual) quoteReserve — the reserve is
  // seeded with a phantom balance so the price starts sane. Selling past this
  // reverts, so show it as the real exit liquidity.
  const exitLiquidity = quote === ZERO
    ? await pub.getBalance({ address: getAddress(curve) }).catch(() => 0n)
    : await pub.readContract({ address: quote, abi: ERC20, functionName: 'balanceOf', args: [getAddress(curve)] }).catch(() => 0n);

  return [{
    venue: 'curve', label: 'bonding curve', curve: getAddress(curve), exitLiquidity,
    quote, quoteSymbol, quoteDecimals,
    quoteReserve: reserves[0], tokenReserve: reserves[1],
    feeBps: feeBps ?? 0n, creatorTaxBps: creatorTaxBps ?? 0n,
    snipeStartBps: snipeStart ?? 0n, snipeSeconds: snipeSecs ?? 0n,
    threshold: threshold ?? 0n, raised: realQuote ?? 0n,
    fee: Number((feeBps ?? 0n) + (creatorTaxBps ?? 0n)) * 100, // bps -> the 1e6 scale feeLabel expects
    liquidity: reserves[0],
  }];
}

/// live, per-address snipe tax — decays to zero a few seconds after launch
async function snipeTaxBps(p, who) {
  const v = await pub.readContract({
    address: p.curve, abi: CURVE_ABI, functionName: 'currentSnipeTaxBps', args: [who],
  }).catch(() => 0n);
  return v ?? 0n;
}

/// closed-form curve output, used only when a simulation is not possible yet
/// (selling before the curve has an allowance). Verified against the live
/// contract: 0.01 ETH -> 5,798,829 by this formula vs 5,798,828 simulated.
function curveEstimate(p, amountIn, taxBps) {
  const eff = (amountIn * (10_000n - taxBps)) / 10_000n;
  if (eff <= 0n) return 0n;
  return mode === 'buy'
    ? (p.tokenReserve * eff) / (p.quoteReserve + eff)
    : (p.quoteReserve * eff) / (p.tokenReserve + eff);
}

// ---------------------------------------------------------------------------
async function findPools(token) {
  // one Airlock lookup, shared by the v4 sweep and the zap check
  const dop = await dopplerHints(token).catch(() => null);
  const [abyss, v4, curve, zap, lightoor] = await Promise.all([
    findAbyssPools(token).catch(() => []),
    findV4Pools(token, dop).catch(() => []),
    findCurvePool(token).catch(() => []),
    findZapPool(token, dop).catch(() => []),
    findLightoor(token).catch(() => []),
  ]);
  // the zap goes first when present: it is the only route that takes plain ETH
  const out = [...zap, ...lightoor, ...abyss, ...v4, ...curve];
  // deepest first, so the default selection is the most tradable one — except
  // the zap, which stays on top because it is the only ETH-denominated route
  const routed = (p) => p.venue === 'zap' || p.venue === 'lightoor-usdg';
  out.sort((x, y) => {
    if (routed(x) !== routed(y)) return routed(x) ? -1 : 1;
    return y.liquidity > x.liquidity ? 1 : y.liquidity < x.liquidity ? -1 : 0;
  });
  return out;
}

const feeLabel = (p) => (p.fee === DYNAMIC_FEE ? 'dynamic fee' : `${Number(p.fee) / 10000}%`);

async function loadToken() {
  const raw = $('tokenInput').value.trim();
  const st = $('loadStatus');
  $('tradeCard').classList.add('hidden');
  st.textContent = '';
  if (!isAddress(raw)) { st.innerHTML = '<span class="err">enter a valid token address</span>'; return; }
  const token = getAddress(raw);

  $('loadBtn').disabled = true;
  try {
    st.textContent = 'looking up venues (bonding curve + Abyss + Uniswap v4)…';
    const pools = await findPools(token);
    if (!pools.length) { st.innerHTML = '<span class="err">no bonding curve, Abyss pool or Uniswap v4 pool found for this token</span>'; return; }

    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: token, abi: ERC20, functionName: 'symbol' }).catch(() => '???'),
      pub.readContract({ address: token, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
    ]);
    ctx = { token, symbol, decimals, pools };
    sel = 0;

    const ps = $('poolSelect');
    ps.innerHTML = pools.map((p, i) =>
      `<option value="${i}">${esc(p.label)} · ${esc(symbol)} / ${esc(p.quoteSymbol)} · ${feeLabel(p)}${p.liquidity === 0n ? ' · EMPTY' : ''}</option>`).join('');
    ps.value = '0';
    $('poolRow').classList.toggle('hidden', pools.length < 2);

    st.textContent = '';
    $('tradeCard').classList.remove('hidden');
    await renderPool();
    setMode('buy');
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(fmtErr(e))}</span>`;
  } finally {
    $('loadBtn').disabled = false;
  }
}

async function renderPool() {
  const p = pool();
  const head =
    `<dt>token</dt><dd>${esc(ctx.symbol)} · <a href="${EXPLORER}/token/${ctx.token}" target="_blank" rel="noopener">${esc(ctx.token)}</a></dd>` +
    `<dt>venue</dt><dd>${esc(p.label)}</dd>` +
    `<dt>quote</dt><dd>${esc(p.quoteSymbol)}${isNativePool() ? ' (traded as native ETH)' : ''} · ${p.quoteDecimals}dp</dd>`;

  if (p.venue === 'lightoor' || p.venue === 'lightoor-usdg') {
    const viaZap = p.venue === 'lightoor-usdg';
    const q = (v) => formatUnits(v, p.quoteDecimals);
    const cq = (v) => formatUnits(v, 18);
    const pct = (bps) => `${(Number(bps) / 100).toFixed(2)}%`;
    $('poolInfo').innerHTML = head +
      `<dt>${viaZap ? 'zap' : 'launchpad'}</dt><dd><a href="${EXPLORER}/address/${viaZap ? LIGHTOOR_ZAP : LIGHTOOR_PAD}" target="_blank" rel="noopener">${esc(viaZap ? LIGHTOOR_ZAP : LIGHTOOR_PAD)}</a></dd>` +
      `<dt>status</dt><dd>on the curve — no DEX pool yet, graduates at ${esc(cq(p.threshold))} ${esc(p.curveQuoteSymbol)}</dd>` +
      `<dt>raised</dt><dd>${esc(cq(p.raised))} / ${esc(cq(p.threshold))} ${esc(p.curveQuoteSymbol)}</dd>` +
      (viaZap
        ? `<dt>route</dt><dd>USDG &rarr; ${esc(p.curveQuoteSymbol)} &rarr; ${esc(ctx.symbol)}, in one call — the zap mints and redeems the quote token for you</dd>`
        : `<dt>route</dt><dd>direct, spending ${esc(p.quoteSymbol)} — you must already hold it</dd>`) +
      `<dt>fees</dt><dd>${pct(p.feeBps)} protocol + ${pct(p.creatorTaxBps)} creator</dd>` +
      `<dt>exit liquidity</dt><dd>${esc(cq(p.exitLiquidity))} ${esc(p.curveQuoteSymbol)} — the most the curve can pay back right now</dd>`;
    return;
  }

  if (p.venue === 'zap') {
    $('poolInfo').innerHTML = head +
      `<dt>zap</dt><dd><a href="${EXPLORER}/address/${p.zap}" target="_blank" rel="noopener">${esc(p.zap)}</a></dd>` +
      `<dt>numeraire</dt><dd>${esc(p.numeraireSymbol)} · <a href="${EXPLORER}/token/${p.numeraire}" target="_blank" rel="noopener">${esc(p.numeraire)}</a></dd>` +
      `<dt>route</dt><dd>ETH &rarr; ${esc(p.numeraireSymbol)} &rarr; ${esc(ctx.symbol)}, in one call. The pool is quoted in ` +
      `${esc(p.numeraireSymbol)}, which has no ETH pool of its own — this is the way in with plain ETH.</dd>`;
    return;
  }

  if (p.venue === 'curve') {
    const tax = await snipeTaxBps(p, account?.address ?? ZERO);
    const pct = (bps) => `${(Number(bps) / 100).toFixed(2)}%`;
    const q = (v) => formatUnits(v, p.quoteDecimals);
    $('poolInfo').innerHTML = head +
      `<dt>curve</dt><dd><a href="${EXPLORER}/address/${p.curve}" target="_blank" rel="noopener">${esc(p.curve)}</a></dd>` +
      `<dt>status</dt><dd>on the curve — no DEX pool yet, graduates at ${esc(q(p.threshold))} ${esc(p.quoteSymbol)}</dd>` +
      `<dt>raised</dt><dd>${esc(q(p.raised))} / ${esc(q(p.threshold))} ${esc(p.quoteSymbol)}</dd>` +
      `<dt>fees</dt><dd>${pct(p.feeBps)} protocol + ${pct(p.creatorTaxBps)} creator</dd>` +
      (tax > 0n
        ? `<dt>snipe tax</dt><dd class="err">${pct(tax)} RIGHT NOW — decays to 0 over ${p.snipeSeconds}s from launch. Wait it out.</dd>`
        : `<dt>snipe tax</dt><dd>0% — window closed (starts at ${pct(p.snipeStartBps)}, ${p.snipeSeconds}s)</dd>`) +
      `<dt>reserves</dt><dd>${esc(q(p.quoteReserve))} ${esc(p.quoteSymbol)} (mostly virtual) / ${esc((+formatUnits(p.tokenReserve, ctx.decimals)).toLocaleString())} ${esc(ctx.symbol)}</dd>` +
      `<dt>exit liquidity</dt><dd>${esc(q(p.exitLiquidity))} ${esc(p.quoteSymbol)} — the most that can be sold back right now</dd>`;
    return;
  }

  if (p.venue === 'v4') {
    $('poolInfo').innerHTML = head +
      `<dt>pool id</dt><dd>${esc(p.poolId)}</dd>` +
      `<dt>hook</dt><dd><a href="${EXPLORER}/address/${p.hooks}" target="_blank" rel="noopener">${esc(p.hooks)}</a></dd>` +
      `<dt>fee</dt><dd>${feeLabel(p)} · tickSpacing ${p.tickSpacing}</dd>` +
      `<dt>liquidity</dt><dd>${p.liquidity.toString()}${p.liquidity === 0n ? ' — this pool is empty' : ''}</dd>` +
      `<dt>tick</dt><dd>${p.tick}</dd>`;
    return;
  }

  const slot0 = await pub.readContract({ address: p.pool, abi: POOL_ABI, functionName: 'slot0' }).catch(() => null);
  $('poolInfo').innerHTML = head +
    `<dt>pool</dt><dd><a href="${EXPLORER}/address/${p.pool}" target="_blank" rel="noopener">${esc(p.pool)}</a></dd>` +
    `<dt>fee</dt><dd>${feeLabel(p)}</dd>` +
    `<dt>liquidity</dt><dd>${p.liquidity.toString()}${p.liquidity === 0n ? ' — this pool is empty' : ''}</dd>` +
    (slot0 ? `<dt>tick</dt><dd>${slot0[1]}</dd>` : '');
}

// ---------------------------------------------------------------------------
// quoting + swapping
// ---------------------------------------------------------------------------
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 1200);

/// buying spends the quote for the token; selling goes the other way
const zeroForOne = () => (mode === 'buy' ? !pool().tokenIs0 : pool().tokenIs0);

/// which abyss router entrypoint applies, given the pool quote and direction
function routerFn() {
  if (!isNativePool()) return 'exactInputSingle';
  return mode === 'buy' ? 'exactInputSingleFromETH' : 'exactInputSingleToETH';
}

function abyssArgs(amountIn, amountOutMin) {
  const p = pool();
  const z = zeroForOne();
  return [
    p.key, account.address, z, amountIn, amountOutMin,
    z ? MIN_SQRT : MAX_SQRT, deadline(),
  ];
}

// v4 goes through the Universal Router: one V4_SWAP command carrying three
// actions — swap, settle what we owe, take what we are owed. Both directions
// were verified against the live PoolManager before this was wired up (a
// native buy by plain eth_call, and a Permit2 sell simulated with storage
// overrides for the balance and both allowances).
const V4_SWAP = '0x10';
const V4_ACTIONS = '0x060c0f'; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
const EXACT_IN_SINGLE_PARAMS = [{ type: 'tuple', components: [
  { name: 'poolKey', type: 'tuple', components: V4_POOL_KEY },
  { name: 'zeroForOne', type: 'bool' },
  { name: 'amountIn', type: 'uint128' },
  { name: 'amountOutMinimum', type: 'uint128' },
  { name: 'hookData', type: 'bytes' },
] }];

function v4Plan(amountIn, minOut) {
  const p = pool();
  const z = zeroForOne();
  const currencyIn = z ? p.key.currency0 : p.key.currency1;
  const currencyOut = z ? p.key.currency1 : p.key.currency0;
  const params = [
    encodeAbiParameters(EXACT_IN_SINGLE_PARAMS, [{
      poolKey: p.key, zeroForOne: z, amountIn, amountOutMinimum: minOut, hookData: '0x',
    }]),
    encodeAbiParameters(parseAbiParameters('address, uint256'), [currencyIn, amountIn]),
    encodeAbiParameters(parseAbiParameters('address, uint256'), [currencyOut, minOut]),
  ];
  const input = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [V4_ACTIONS, params]);
  return {
    currencyIn,
    args: [V4_SWAP, [input], deadline()],
    value: currencyIn === ZERO ? amountIn : 0n,
  };
}

/// the side being spent — decimals differ per pool (USDG is 6dp, not 18)
const inDecimals = () => (mode === 'buy' ? pool().quoteDecimals : ctx.decimals);
const outDecimals = () => (mode === 'buy' ? ctx.decimals : pool().quoteDecimals);
const inSymbol = () => (mode === 'buy' ? (isNativePool() ? 'ETH' : pool().quoteSymbol) : ctx.symbol);
const outSymbol = () => (mode === 'buy' ? ctx.symbol : (isNativePool() ? 'ETH' : pool().quoteSymbol));

function amountInRaw() {
  const v = $('amountInput').value.trim();
  if (!(+v > 0)) return 0n;
  return parseUnits(v, inDecimals());
}

async function quote() {
  const amountIn = amountInRaw();
  if (amountIn === 0n) return null;
  const p = pool();

  // previewBuy / previewSell are views, so these quote correctly with no
  // allowance and before the wallet holds anything
  if (p.venue === 'lightoor') {
    const r = await pub.readContract({
      address: LIGHTOOR_PAD, abi: LIGHTOOR_PAD_ABI,
      functionName: mode === 'buy' ? 'previewBuy' : 'previewSell', args: [ctx.token, amountIn],
    });
    return r[0];
  }
  if (p.venue === 'lightoor-usdg') {
    const r = await pub.readContract({
      address: LIGHTOOR_ZAP, abi: LIGHTOOR_ZAP_ABI,
      functionName: mode === 'buy' ? 'previewBuyUsdg' : 'previewSellUsdg', args: [ctx.token, amountIn],
    });
    return r[0];
  }

  if (p.venue === 'zap') {
    const { result } = await pub.simulateContract({
      address: p.zap, abi: ZAP_ABI, functionName: mode === 'buy' ? 'buy' : 'sell',
      args: mode === 'buy' ? [0n, deadline()] : [amountIn, 0n, deadline()],
      value: mode === 'buy' ? amountIn : 0n,
      account: account.address,
    });
    return result;
  }

  if (p.venue === 'curve') {
    const tax = await snipeTaxBps(p, account.address);
    quoteNote = tax > 0n
      ? `snipe tax is ${(Number(tax) / 100).toFixed(2)}% right now — it decays to 0 over ${p.snipeSeconds}s from launch`
      : '';
    try {
      const { result } = await pub.simulateContract({
        address: p.curve, abi: CURVE_ABI, functionName: mode === 'buy' ? 'buy' : 'sell',
        args: [amountIn, 0n, account.address],
        value: (mode === 'buy' && isNativePool()) ? amountIn : 0n,
        account: account.address,
      });
      return result;
    } catch {
      // selling before the curve has an allowance cannot be simulated; fall
      // back to the closed form so a number still shows. doSwap() approves and
      // then re-simulates for real before anything is sent.
      quoteNote = [quoteNote, 'estimated from reserves (approve to get an exact quote)'].filter(Boolean).join(' · ');
      return curveEstimate(p, amountIn, p.feeBps + p.creatorTaxBps + tax);
    }
  }

  if (p.venue === 'v4') {
    const { result } = await pub.simulateContract({
      address: V4_QUOTER, abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle',
      args: [{ poolKey: p.key, zeroForOne: zeroForOne(), exactAmount: amountIn, hookData: '0x' }],
      account: account.address,
    });
    return result[0];
  }

  const { result } = await pub.simulateContract({
    address: ROUTER, abi: ROUTER_ABI, functionName: routerFn(),
    args: abyssArgs(amountIn, 0n),
    value: (mode === 'buy' && isNativePool()) ? amountIn : 0n,
    account: account.address,
  });
  return result;
}

const showAmount = (v) => `${(+formatUnits(v, outDecimals())).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${outSymbol()}`;

function minOutFor(out) {
  const slip = +($('slippage').value.trim() || '5');
  return out - (out * BigInt(Math.round(slip * 100))) / 10_000n;
}

async function refreshQuote() {
  const q = $('quote');
  if (!ctx || !account) return;
  if (amountInRaw() === 0n) { q.textContent = ''; return; }
  q.textContent = 'quoting…';
  try {
    quoteNote = '';
    const out = await quote();
    const slip = +($('slippage').value.trim() || '5');
    q.innerHTML = `you get <b>${esc(showAmount(out))}</b> · min after ${slip}% slippage <b>${esc(showAmount(minOutFor(out)))}</b>`
      + (quoteNote ? `<br><span class="err">${esc(quoteNote)}</span>` : '');
  } catch (e) {
    q.innerHTML = `<span class="err">${esc(describeErr(e))}</span>`;
  }
}

/// v4 pulls the input token through Permit2, which needs two one-time
/// approvals: the ERC-20 approving Permit2, then Permit2 approving the router.
const MAX_UINT160 = (1n << 160n) - 1n;
async function ensurePermit2(tokenIn, amountIn, say) {
  const allowed = await pub.readContract({
    address: tokenIn, abi: ERC20, functionName: 'allowance', args: [account.address, PERMIT2],
  });
  if (allowed < amountIn) {
    say(`approving Permit2 for ${inSymbol()}…`);
    const h = await wallet.writeContract({
      address: tokenIn, abi: ERC20, functionName: 'approve', args: [PERMIT2, 2n ** 256n - 1n],
    });
    await pub.waitForTransactionReceipt({ hash: h, confirmations: 1 });
  }
  const [amount, expiration] = await pub.readContract({
    address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance',
    args: [account.address, tokenIn, UNIVERSAL_ROUTER],
  });
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(amount) < amountIn || Number(expiration) <= now + 60) {
    say('approving the router on Permit2…');
    const h = await wallet.writeContract({
      address: PERMIT2, abi: PERMIT2_ABI, functionName: 'approve',
      args: [tokenIn, UNIVERSAL_ROUTER, MAX_UINT160, now + 30 * 86400],
    });
    await pub.waitForTransactionReceipt({ hash: h, confirmations: 1 });
  }
}

async function settle(hash, out, st) {
  st.innerHTML = `tx sent: <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 10)}…</a><br>waiting…`;
  const r = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (r.status !== 'success') throw new Error('swap reverted on-chain');
  st.innerHTML = `<span class="ok">SWAPPED ✓</span> ~${esc(showAmount(out))}<br>` +
    `<a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">tx on explorer</a>`;
  refreshBalances();
}

async function doSwap() {
  const st = $('swapStatus');
  const say = (m) => { st.textContent = m; };
  if (!account) { st.innerHTML = '<span class="err">wallet is locked</span>'; return; }
  const amountIn = amountInRaw();
  if (amountIn === 0n) { st.innerHTML = '<span class="err">enter an amount</span>'; return; }
  $('swapBtn').disabled = true;
  try {
    const p = pool();

    if (p.venue === 'lightoor' || p.venue === 'lightoor-usdg') {
      const viaZap = p.venue === 'lightoor-usdg';
      const target = viaZap ? LIGHTOOR_ZAP : LIGHTOOR_PAD;
      const abi = viaZap ? LIGHTOOR_ZAP_ABI : LIGHTOOR_PAD_ABI;
      // a native-quote buy sends value; everything else is pulled by the
      // contract, so it needs an allowance on whatever is being spent
      const nativeBuy = mode === 'buy' && !viaZap && isNativePool();
      if (!nativeBuy) {
        const spend = mode === 'buy' ? p.quote : ctx.token;
        const allowed = await pub.readContract({
          address: spend, abi: ERC20, functionName: 'allowance', args: [account.address, target],
        });
        if (allowed < amountIn) {
          say(`approving ${inSymbol()}…`);
          const ah = await wallet.writeContract({
            address: spend, abi: ERC20, functionName: 'approve', args: [target, 2n ** 256n - 1n],
          });
          await pub.waitForTransactionReceipt({ hash: ah, confirmations: 1 });
        }
      }

      say('simulating…');
      const out = await quote();
      const minOut = minOutFor(out);
      await pub.simulateContract({
        address: target, abi, functionName: mode === 'buy' ? 'buy' : 'sell',
        args: [ctx.token, amountIn, minOut], value: nativeBuy ? amountIn : 0n,
        account: account.address,
      });

      say('sending…');
      const hash = await wallet.writeContract({
        address: target, abi, functionName: mode === 'buy' ? 'buy' : 'sell',
        args: [ctx.token, amountIn, minOut], value: nativeBuy ? amountIn : 0n,
      });
      await settle(hash, out, st);
      return;
    }

    if (p.venue === 'zap') {
      // buying sends ETH; selling hands the coin to the zap, so it needs an allowance
      if (mode === 'sell') {
        const allowed = await pub.readContract({
          address: ctx.token, abi: ERC20, functionName: 'allowance', args: [account.address, p.zap],
        });
        if (allowed < amountIn) {
          say(`approving ${inSymbol()}…`);
          const ah = await wallet.writeContract({
            address: ctx.token, abi: ERC20, functionName: 'approve', args: [p.zap, 2n ** 256n - 1n],
          });
          await pub.waitForTransactionReceipt({ hash: ah, confirmations: 1 });
        }
      }

      say('simulating…');
      const out = await quote();
      const minOut = minOutFor(out);

      say('sending…');
      const hash = await wallet.writeContract({
        address: p.zap, abi: ZAP_ABI, functionName: mode === 'buy' ? 'buy' : 'sell',
        args: mode === 'buy' ? [minOut, deadline()] : [amountIn, minOut, deadline()],
        value: mode === 'buy' ? amountIn : 0n,
      });
      await settle(hash, out, st);
      return;
    }

    if (p.venue === 'curve') {
      // a native buy sends value; every other direction is pulled by the curve
      // via transferFrom, so it needs an allowance on what is being spent
      const nativeBuy = mode === 'buy' && isNativePool();
      if (!nativeBuy) {
        const spend = mode === 'buy' ? p.quote : ctx.token;
        const allowed = await pub.readContract({
          address: spend, abi: ERC20, functionName: 'allowance', args: [account.address, p.curve],
        });
        if (allowed < amountIn) {
          say(`approving ${inSymbol()}…`);
          const ah = await wallet.writeContract({
            address: spend, abi: ERC20, functionName: 'approve', args: [p.curve, 2n ** 256n - 1n],
          });
          await pub.waitForTransactionReceipt({ hash: ah, confirmations: 1 });
        }
      }

      say('simulating…');
      const out = await quote();
      const minOut = minOutFor(out);

      say('sending…');
      const hash = await wallet.writeContract({
        address: p.curve, abi: CURVE_ABI, functionName: mode === 'buy' ? 'buy' : 'sell',
        args: [amountIn, minOut, account.address],
        value: nativeBuy ? amountIn : 0n,
      });
      await settle(hash, out, st);
      return;
    }

    if (p.venue === 'v4') {
      const { currencyIn } = v4Plan(amountIn, 0n);
      if (currencyIn !== ZERO) await ensurePermit2(currencyIn, amountIn, say);

      say('simulating…');
      const out = await quote();
      const plan = v4Plan(amountIn, minOutFor(out));
      await pub.simulateContract({
        address: UNIVERSAL_ROUTER, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute',
        args: plan.args, value: plan.value, account: account.address,
      });

      say('sending swap…');
      const hash = await wallet.writeContract({
        address: UNIVERSAL_ROUTER, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute',
        args: plan.args, value: plan.value,
      });
      await settle(hash, out, st);
      return;
    }

    // everything except a native-ETH buy is pulled via transferFrom, so the
    // router needs an allowance on whichever token is being spent
    const nativeBuy = mode === 'buy' && isNativePool();
    if (!nativeBuy) {
      const spend = mode === 'buy' ? p.quote : ctx.token;
      const allowed = await pub.readContract({
        address: spend, abi: ERC20, functionName: 'allowance', args: [account.address, ROUTER],
      });
      if (allowed < amountIn) {
        say(`approving ${inSymbol()}…`);
        const ah = await wallet.writeContract({
          address: spend, abi: ERC20, functionName: 'approve', args: [ROUTER, 2n ** 256n - 1n],
        });
        await pub.waitForTransactionReceipt({ hash: ah, confirmations: 1 });
      }
    }

    say('simulating…');
    const out = await quote();
    const minOut = minOutFor(out);

    say('sending swap…');
    const hash = await wallet.writeContract({
      address: ROUTER, abi: ROUTER_ABI, functionName: routerFn(),
      args: abyssArgs(amountIn, minOut),
      value: nativeBuy ? amountIn : 0n,
    });
    await settle(hash, out, st);
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(describeErr(e))}</span>`;
  } finally {
    $('swapBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// ui
// ---------------------------------------------------------------------------
function setMode(m) {
  mode = m;
  $('tabBuy').classList.toggle('active', m === 'buy');
  $('tabSell').classList.toggle('active', m === 'sell');
  $('amountLabel').textContent = `${inSymbol()} TO ${m === 'buy' ? 'SPEND' : 'SELL'}`;
  $('swapBtn').className = m === 'buy' ? 'btn' : 'btn sell';
  $('swapBtn').textContent = m === 'buy' ? 'BUY' : 'SELL';
  $('amountInput').value = '';
  $('quote').textContent = '';
  $('swapStatus').textContent = '';

  // sane preset amounts depend on what is being spent
  $('chips').innerHTML = '';
  let chips;
  if (m === 'sell') chips = ['25%', '50%', '100%'];
  else if (isNativePool()) chips = ['0.001', '0.01', '0.1', '0.5', '1'];
  else chips = ['1', '5', '25', '100'];
  for (const c of chips) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = c.endsWith('%') ? c : `${c} ${inSymbol()}`;
    b.onclick = () => applyChip(c);
    $('chips').appendChild(b);
  }
  refreshBalances();
}

async function applyChip(c) {
  if (!c.endsWith('%')) { $('amountInput').value = c; refreshQuote(); return; }
  const bal = await pub.readContract({ address: ctx.token, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
  $('amountInput').value = formatUnits((bal * BigInt(parseInt(c, 10))) / 100n, ctx.decimals);
  refreshQuote();
}

async function refreshBalances() {
  if (!account || !ctx) return;
  try {
    if (mode === 'sell') {
      const b = await pub.readContract({ address: ctx.token, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
      $('balanceOut').value = `${(+formatUnits(b, ctx.decimals)).toLocaleString()} ${ctx.symbol}`;
    } else if (isNativePool()) {
      const b = await pub.getBalance({ address: account.address });
      $('balanceOut').value = `${(+formatEther(b)).toFixed(5)} ETH`;
    } else {
      const p = pool();
      const b = await pub.readContract({ address: p.quote, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
      $('balanceOut').value = `${(+formatUnits(b, p.quoteDecimals)).toLocaleString()} ${p.quoteSymbol}`;
    }
  } catch { /* balance display is best-effort */ }
}

function useKey(pk) {
  account = privateKeyToAccount(pk);
  wallet = createWalletClient({ account, chain: CHAIN, transport: transport() });
  $('walletAddr').textContent = account.address.slice(0, 6) + '…' + account.address.slice(-4);
}

function start() {
  $('appRoot').style.display = '';
  $('routerAddr').textContent = ROUTER;
  $('urAddr').textContent = UNIVERSAL_ROUTER;
  const keys = loadKeys();
  if (keys?.evm) { try { useKey(keys.evm); } catch { $('noVault').hidden = false; } }
  else $('noVault').hidden = false;

  $('loadBtn').onclick = loadToken;
  $('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadToken(); });
  $('tabBuy').onclick = () => setMode('buy');
  $('tabSell').onclick = () => setMode('sell');
  $('swapBtn').onclick = doSwap;
  $('poolSelect').addEventListener('change', async (e) => {
    sel = +e.target.value;
    await renderPool();
    setMode(mode);
  });

  let t;
  const debounced = () => { clearTimeout(t); t = setTimeout(refreshQuote, 400); };
  $('amountInput').addEventListener('input', debounced);
  $('slippage').addEventListener('input', debounced);

  // deep link: swap.html?token=0x…
  const pre = new URLSearchParams(location.search).get('token');
  if (pre) { $('tokenInput').value = pre; loadToken(); }
}

start();
