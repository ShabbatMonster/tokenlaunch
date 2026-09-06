import {
  createPublicClient, createWalletClient, http, defineChain, isAddress, getAddress,
  formatEther, formatUnits, parseUnits, keccak256, encodeAbiParameters, parseAbiParameters,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Swap — trades any token on Robinhood chain that has a pool on either of the
// two venues that actually exist here, against whatever that pool is quoted in.
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

const fmtErr = (e) => e?.shortMessage || e?.message || String(e);
const pool = () => ctx?.pools[sel];
/// a pool whose quote side is spendable as native ETH, so no approval is needed
/// (abyss wraps WETH for you; v4 uses address(0) as the native currency)
const isNativePool = () => {
  const p = pool();
  if (!p) return false;
  return p.venue === 'v4' ? p.quote === ZERO : p.quote === WETH;
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
  [500, 10], [100, 1], [0, 8], [30000, 200], [DYNAMIC_FEE, 60], [DYNAMIC_FEE, 200],
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

async function findV4Pools(token) {
  const hints = await launchpadHints(token);

  // NB: `.map(getAddress)` would hand the array index to viem as an EIP-1191
  // chainId and blow up on the second element — always wrap it.
  const norm = (a) => getAddress(a);
  const hooks = [...new Set([hints.hook, ...KNOWN_HOOKS, ZERO].filter(Boolean).map(norm))];
  const quotes = [...new Set([hints.pairToken, ZERO, WETH].filter(Boolean).map(norm))];

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
async function findPools(token) {
  const [abyss, v4] = await Promise.all([
    findAbyssPools(token).catch(() => []),
    findV4Pools(token).catch(() => []),
  ]);
  const out = [...abyss, ...v4];
  // deepest first, so the default selection is the most tradable one
  out.sort((x, y) => (y.liquidity > x.liquidity ? 1 : y.liquidity < x.liquidity ? -1 : 0));
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
    st.textContent = 'looking up pools (Abyss + Uniswap v4)…';
    const pools = await findPools(token);
    if (!pools.length) { st.innerHTML = '<span class="err">no Abyss or Uniswap v4 pool found for this token</span>'; return; }

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
    z ? MIN_SQRT : MAX_SQRT,
    BigInt(Math.floor(Date.now() / 1000) + 1200),
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
    args: [V4_SWAP, [input], BigInt(Math.floor(Date.now() / 1000) + 1200)],
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
    const out = await quote();
    const slip = +($('slippage').value.trim() || '5');
    q.innerHTML = `you get <b>${esc(showAmount(out))}</b> · min after ${slip}% slippage <b>${esc(showAmount(minOutFor(out)))}</b>`;
  } catch (e) {
    q.innerHTML = `<span class="err">${esc(fmtErr(e))}</span>`;
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
    st.innerHTML = `<span class="err">${esc(fmtErr(e))}</span>`;
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
