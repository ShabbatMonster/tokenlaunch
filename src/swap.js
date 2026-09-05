import {
  createPublicClient, createWalletClient, http, defineChain, isAddress, getAddress,
  formatEther, formatUnits, parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Swap — trades any token that has an Abyss pool on Robinhood chain, against
// whatever that pool is quoted in. Modelled on the reference trade:
//
//   tx 0x7c6277f6…c7a9d -> router.exactInputSingleFromETH(key, …) with the ETH
//   attached as value; the router wraps to WETH and swaps the v3-style pool.
//
// WETH is NOT the only quote here — of the pools on this factory, USDG is
// actually the most common one, and several pairs (TENDIES/USDG, RIVN/DIESEL,
// USDG/OUROBOROS) never touch WETH at all. So this discovers every pool that
// contains the token, whatever the other side is, and routes accordingly:
//
//   quote is WETH  -> exactInputSingleFromETH / exactInputSingleToETH, so the
//                     user just spends and receives native ETH
//   anything else  -> exactInputSingle, with an approval on whichever token is
//                     being spent
//
// The pool "key" the router wants is (currency0, currency1, uint8 profile,
// uint24 fee, bool flag, bytes32 extra). profile/flag/extra are NOT derivable
// from the pair — live pools use profiles 0..3 with differing flags — so they
// are read off the factory creation event rather than guessed.
// ---------------------------------------------------------------------------

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const ROUTER = '0xF2a3Afb36768950eb2c7F04583328C09AEC0C366';
const V3_FACTORY = '0xe7feF2BC860B25bbdEB6F6AB96d88bAAa77ddad7';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

// v3 sqrt price bounds; a swap passes the far bound to mean "no price limit"
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;

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

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });

const KEYS_KEY = 'keys.v1';
const loadKeys = () => { try { return JSON.parse(localStorage.getItem(KEYS_KEY) || 'null'); } catch { return null; } };

let account = null;
let wallet = null;
let ctx = null;      // { token, symbol, decimals, pools: [...] }
let sel = 0;         // index into ctx.pools
let mode = 'buy';

const fmtErr = (e) => e?.shortMessage || e?.message || String(e);
const pool = () => ctx?.pools[sel];
/// a WETH-quoted pool can be traded with native ETH, which needs no approval
const isNativePool = () => pool() && getAddress(pool().quote) === getAddress(WETH);

// ---------------------------------------------------------------------------
// pool discovery — every pool containing the token, any counterparty
// ---------------------------------------------------------------------------
async function findPools(token) {
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
      pool: a.pool, quote, quoteSymbol, quoteDecimals, tokenIs0, fee: a.fee, liquidity,
      key: {
        currency0: token0, currency1: token1,
        profile: a.profile, fee: a.fee, flag: a.flag, extra: a.extra,
      },
    });
  }
  // deepest first, so the default selection is the most tradable one
  out.sort((x, y) => (y.liquidity > x.liquidity ? 1 : y.liquidity < x.liquidity ? -1 : 0));
  return out;
}

async function loadToken() {
  const raw = $('tokenInput').value.trim();
  const st = $('loadStatus');
  $('tradeCard').classList.add('hidden');
  st.textContent = '';
  if (!isAddress(raw)) { st.innerHTML = '<span class="err">enter a valid token address</span>'; return; }
  const token = getAddress(raw);

  $('loadBtn').disabled = true;
  try {
    st.textContent = 'looking up pools…';
    const pools = await findPools(token);
    if (!pools.length) { st.innerHTML = '<span class="err">no Abyss pool found for this token</span>'; return; }

    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: token, abi: ERC20, functionName: 'symbol' }).catch(() => '???'),
      pub.readContract({ address: token, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
    ]);
    ctx = { token, symbol, decimals, pools };
    sel = 0;

    const ps = $('poolSelect');
    ps.innerHTML = pools.map((p, i) =>
      `<option value="${i}">${esc(symbol)} / ${esc(p.quoteSymbol)} · ${Number(p.fee) / 10000}%${p.liquidity === 0n ? ' · EMPTY' : ''}</option>`).join('');
    ps.value = '0';
    $('poolRow').classList.toggle('hidden', pools.length < 2);

    st.textContent = '';
    $('tradeCard').classList.remove('hidden');
    renderPool();
    setMode('buy');
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(fmtErr(e))}</span>`;
  } finally {
    $('loadBtn').disabled = false;
  }
}

async function renderPool() {
  const p = pool();
  const slot0 = await pub.readContract({ address: p.pool, abi: POOL_ABI, functionName: 'slot0' }).catch(() => null);
  $('poolInfo').innerHTML =
    `<dt>token</dt><dd>${esc(ctx.symbol)} · <a href="${EXPLORER}/token/${ctx.token}" target="_blank" rel="noopener">${esc(ctx.token)}</a></dd>` +
    `<dt>quote</dt><dd>${esc(p.quoteSymbol)}${isNativePool() ? ' (traded as native ETH)' : ''} · ${p.quoteDecimals}dp</dd>` +
    `<dt>pool</dt><dd><a href="${EXPLORER}/address/${p.pool}" target="_blank" rel="noopener">${esc(p.pool)}</a></dd>` +
    `<dt>fee</dt><dd>${Number(p.fee) / 10000}%</dd>` +
    `<dt>liquidity</dt><dd>${p.liquidity.toString()}${p.liquidity === 0n ? ' — this pool is empty' : ''}</dd>` +
    (slot0 ? `<dt>tick</dt><dd>${slot0[1]}</dd>` : '');
}

// ---------------------------------------------------------------------------
// quoting + swapping
// ---------------------------------------------------------------------------
/// which router entrypoint applies, given the pool quote and trade direction
function routerFn() {
  if (!isNativePool()) return 'exactInputSingle';
  return mode === 'buy' ? 'exactInputSingleFromETH' : 'exactInputSingleToETH';
}

function swapArgs(amountIn, amountOutMin) {
  const p = pool();
  // buying spends the quote for the token; selling goes the other way
  const zeroForOne = mode === 'buy' ? !p.tokenIs0 : p.tokenIs0;
  return [
    p.key, account.address, zeroForOne, amountIn, amountOutMin,
    zeroForOne ? MIN_SQRT : MAX_SQRT,
    BigInt(Math.floor(Date.now() / 1000) + 1200),
  ];
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
  const { result } = await pub.simulateContract({
    address: ROUTER, abi: ROUTER_ABI, functionName: routerFn(),
    args: swapArgs(amountIn, 0n),
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

async function doSwap() {
  const st = $('swapStatus');
  if (!account) { st.innerHTML = '<span class="err">wallet is locked</span>'; return; }
  const amountIn = amountInRaw();
  if (amountIn === 0n) { st.innerHTML = '<span class="err">enter an amount</span>'; return; }
  $('swapBtn').disabled = true;
  try {
    // everything except a native-ETH buy is pulled via transferFrom, so the
    // router needs an allowance on whichever token is being spent
    const nativeBuy = mode === 'buy' && isNativePool();
    if (!nativeBuy) {
      const spend = mode === 'buy' ? pool().quote : ctx.token;
      const allowed = await pub.readContract({
        address: spend, abi: ERC20, functionName: 'allowance', args: [account.address, ROUTER],
      });
      if (allowed < amountIn) {
        st.textContent = `approving ${inSymbol()}…`;
        const ah = await wallet.writeContract({
          address: spend, abi: ERC20, functionName: 'approve', args: [ROUTER, 2n ** 256n - 1n],
        });
        await pub.waitForTransactionReceipt({ hash: ah, confirmations: 1 });
      }
    }

    st.textContent = 'simulating…';
    const out = await quote();
    const minOut = minOutFor(out);

    st.textContent = 'sending swap…';
    const hash = await wallet.writeContract({
      address: ROUTER, abi: ROUTER_ABI, functionName: routerFn(),
      args: swapArgs(amountIn, minOut),
      value: nativeBuy ? amountIn : 0n,
    });
    st.innerHTML = `tx sent: <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 10)}…</a><br>waiting…`;
    const r = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (r.status !== 'success') throw new Error('swap reverted on-chain');

    st.innerHTML = `<span class="ok">SWAPPED ✓</span> ~${esc(showAmount(out))}<br>` +
      `<a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">tx on explorer</a>`;
    refreshBalances();
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
  wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
  $('walletAddr').textContent = account.address.slice(0, 6) + '…' + account.address.slice(-4);
}

function start() {
  $('appRoot').style.display = '';
  $('routerAddr').textContent = ROUTER;
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
