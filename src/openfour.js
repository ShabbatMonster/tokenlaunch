import {
  createPublicClient, createWalletClient, http, defineChain, isAddress, getAddress,
  formatEther, parseEther, formatUnits, parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// OpenFour (four.meme's modular launch engine) — bonding-curve trading on BNB
// Chain. Buying and selling on the internal market is fully permissionless:
// Core.buyByBudget / Core.sell, priced by OpenFourTools estimates.
//
// Creating a token is NOT permissionless — core.createToken(createArg,
// signature) needs a signature from four.meme's backend, so launching is not
// wired up here. Trading needs nothing but an RPC.
//
// Addresses are discovered from the Registry rather than hardcoded, which is
// what their integration guide asks for: Core/Tools can be swapped by
// governance while the Registry address stays put.
//   Registry (BSC) -> openFourCore() / openFourTool()
// Verified live: Core 0xebe7b6C1…27f3, Tools 0x97DA82f5…E905, quote WBNB.
//
// The estimate functions are deliberately non-view (they may call a V3 quoter),
// so every quote goes through eth_call via simulateContract. Their guide is
// explicit that integrators should price off these rather than reimplementing
// curve/fee/anti-sniper maths, so that is exactly what this does — and if an
// estimate returns tokenAmount == 0 the token is not tradable and the button
// stays disabled.
// ---------------------------------------------------------------------------

const RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
];
const EXPLORER = 'https://bscscan.com';
const REGISTRY = '0x912CEf0C3aE9Ab6eB3Ec87cab69371cFb317Ab94';

const CHAIN = defineChain({
  id: 56, name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: RPCS } },
});

const REGISTRY_ABI = [
  { type: 'function', name: 'openFourCore', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'openFourTool', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];

// tokens() returns the full runtime config; field order matters and is taken
// straight from their published IOpenFourCore ABI
const CORE_ABI = [
  { type: 'function', name: 'wrappedNative', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  {
    type: 'function', name: 'tokens', stateMutability: 'view',
    inputs: [{ name: 'token_', type: 'address' }],
    outputs: [
      { name: 'version', type: 'uint32' }, { name: 'creator', type: 'address' },
      { name: 'presetId', type: 'uint256' }, { name: 'token', type: 'address' },
      { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
      { name: 'maxSupply', type: 'uint256' }, { name: 'saleAmount', type: 'uint256' },
      { name: 'raiseAmount', type: 'uint256' }, { name: 'quoteAsset', type: 'address' },
      { name: 'vault', type: 'address' }, { name: 'curveModule', type: 'address' },
      { name: 'tradeModule', type: 'address' }, { name: 'migrateModule', type: 'address' },
      { name: 'tokenModule', type: 'address' }, { name: 'customData', type: 'address' },
      { name: 'createBlock', type: 'uint256' }, { name: 'exists', type: 'bool' },
      { name: 'paused', type: 'bool' }, { name: 'antiSniperEnabled', type: 'bool' },
    ],
  },
  {
    type: 'function', name: 'buyByBudget', stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' }, { name: 'maxPayAmount', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' }, { name: 'options', type: 'uint256' },
      { name: 'proof', type: 'bytes' },
    ], outputs: [],
  },
  {
    type: 'function', name: 'sell', stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
      { name: 'minReceiveAmount', type: 'uint256' }, { name: 'options', type: 'uint256' },
      { name: 'proof', type: 'bytes' },
    ], outputs: [],
  },
];

const ESTIMATE_OUT = [{
  type: 'tuple', components: [
    { name: 'curveQuote', type: 'uint256' }, { name: 'totalFee', type: 'uint256' },
    { name: 'userPays', type: 'uint256' }, { name: 'userReceives', type: 'uint256' },
    { name: 'tokenAmount', type: 'uint256' }, { name: 'executionPrice', type: 'uint256' },
  ],
}];
const TOOLS_ABI = [
  {
    type: 'function', name: 'estimateBuyByBudget', stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' }, { name: 'trader', type: 'address' },
      { name: 'maxPayAmount', type: 'uint256' }, { name: 'options', type: 'uint256' }, { name: 'proof', type: 'bytes' },
    ], outputs: ESTIMATE_OUT,
  },
  {
    type: 'function', name: 'estimateSell', stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' }, { name: 'trader', type: 'address' },
      { name: 'amount', type: 'uint256' }, { name: 'options', type: 'uint256' }, { name: 'proof', type: 'bytes' },
    ], outputs: ESTIMATE_OUT,
  },
  {
    type: 'function', name: 'getCurveLiquiditySnapshot', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{
      type: 'tuple', components: [
        { name: 'available', type: 'bool' },
        { name: 'initialQuoteLiquidity', type: 'uint256' }, { name: 'initialTokenLiquidity', type: 'uint256' },
        { name: 'currentQuoteLiquidity', type: 'uint256' }, { name: 'currentTokenLiquidity', type: 'uint256' },
        { name: 'remainingForSale', type: 'uint256' }, { name: 'totalRaised', type: 'uint256' },
        { name: 'lastPrice', type: 'uint256' },
      ],
    }],
  },
];

const VAULT_ABI = [
  { type: 'function', name: 'phase', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'totalRaised', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'remainingForSale', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'isSoldOut', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
];

const ERC20 = [
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];

// vault.phase() — only Trading is tradable on the internal market
const PHASES = ['Created', 'Trading', 'MigratePending', 'Migrated', 'Terminal', 'SoldOut'];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pub = createPublicClient({ chain: CHAIN, transport: http(RPCS[0]) });

const KEYS_KEY = 'keys.v1';
const loadKeys = () => { try { return JSON.parse(localStorage.getItem(KEYS_KEY) || 'null'); } catch { return null; } };

let account = null;
let wallet = null;
let addrs = null;   // { core, tools, wrappedNative }
let ctx = null;     // { token, cfg, symbol, decimals, quoteSymbol, quoteDecimals, isNativeQuote, phase }
let mode = 'buy';

const fmtErr = (e) => e?.shortMessage || e?.message || String(e);

async function resolveAddresses() {
  if (addrs) return addrs;
  const [core, tools] = await Promise.all([
    pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'openFourCore' }),
    pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'openFourTool' }),
  ]);
  const wrappedNative = await pub.readContract({ address: core, abi: CORE_ABI, functionName: 'wrappedNative' });
  addrs = { core, tools, wrappedNative };
  return addrs;
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------
async function loadToken() {
  const raw = $('tokenInput').value.trim();
  const st = $('loadStatus');
  $('tradeCard').classList.add('hidden');
  st.textContent = '';
  if (!isAddress(raw)) { st.innerHTML = '<span class="err">enter a valid token address</span>'; return; }
  const token = getAddress(raw);

  $('loadBtn').disabled = true;
  try {
    st.textContent = 'resolving OpenFour addresses…';
    const { core, tools, wrappedNative } = await resolveAddresses();

    st.textContent = 'reading token config…';
    const cfg = await pub.readContract({ address: core, abi: CORE_ABI, functionName: 'tokens', args: [token] });
    if (!cfg[17]) {
      st.innerHTML = '<span class="err">not an OpenFour token — core.tokens(addr).exists is false</span>';
      return;
    }

    const quoteAsset = getAddress(cfg[9]);
    const isNativeQuote = quoteAsset === getAddress(wrappedNative);
    const [decimals, quoteSymbol, quoteDecimals] = await Promise.all([
      pub.readContract({ address: token, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
      isNativeQuote ? Promise.resolve('BNB') : pub.readContract({ address: quoteAsset, abi: ERC20, functionName: 'symbol' }).catch(() => '???'),
      isNativeQuote ? Promise.resolve(18) : pub.readContract({ address: quoteAsset, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
    ]);

    const vault = getAddress(cfg[10]);
    const [phase, totalRaised, remaining] = await Promise.all([
      pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'phase' }).catch(() => null),
      pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'totalRaised' }).catch(() => 0n),
      pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'remainingForSale' }).catch(() => 0n),
    ]);

    ctx = {
      token, core, tools, vault, quoteAsset, isNativeQuote,
      name: cfg[4], symbol: cfg[5], decimals, quoteSymbol, quoteDecimals,
      raiseAmount: cfg[8], paused: cfg[18], phase,
    };

    const pct = cfg[8] > 0n ? Number((totalRaised * 10000n) / cfg[8]) / 100 : 0;
    $('poolInfo').innerHTML =
      `<dt>token</dt><dd>${esc(cfg[5])} · <a href="${EXPLORER}/token/${token}" target="_blank" rel="noopener">${esc(token)}</a></dd>` +
      `<dt>name</dt><dd>${esc(cfg[4])}</dd>` +
      `<dt>quote</dt><dd>${esc(quoteSymbol)}${isNativeQuote ? ' (native)' : ''}</dd>` +
      `<dt>phase</dt><dd>${phase === null ? '?' : `${PHASES[phase] ?? phase} (${phase})`}${cfg[18] ? ' · PAUSED' : ''}</dd>` +
      `<dt>raised</dt><dd>${formatUnits(totalRaised, quoteDecimals)} / ${formatUnits(cfg[8], quoteDecimals)} ${esc(quoteSymbol)} (${pct.toFixed(1)}%)</dd>` +
      `<dt>unsold</dt><dd>${(+formatUnits(remaining, decimals)).toLocaleString()} ${esc(cfg[5])}</dd>` +
      `<dt>preset</dt><dd>#${cfg[2].toString()}</dd>`;

    $('tradeCard').classList.remove('hidden');
    // A migrated token is not dead — it just trades on the external pair now.
    if (phase === 3) {
      ctx.lista = await findListaRoute(token, quoteAsset);
      if (ctx.lista) {
        $('phaseWarn').innerHTML = `<span class="ok">migrated — routing through the Lista V2 pool</span> ` +
          `(<a href="${EXPLORER}/address/${ctx.lista.pair}" target="_blank" rel="noopener">pair</a>). ` +
          `This is a tax token, so swaps use the fee-on-transfer route and quotes are shown pre-tax — keep slippage generous.`;
      } else {
        $('phaseWarn').innerHTML = '<span class="err">migrated, but no external Lista pair was found — nothing to route through</span>';
      }
    } else if (phase !== 1) {
      $('phaseWarn').innerHTML = `<span class="err">internal market is not open (phase ${PHASES[phase] ?? phase}) — trading is disabled</span>`;
    } else if (cfg[18]) {
      $('phaseWarn').innerHTML = '<span class="err">this token is paused by Core — trading is disabled</span>';
    } else {
      $('phaseWarn').textContent = '';
    }
    st.textContent = '';
    setMode('buy');
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(fmtErr(e))}</span>`;
  } finally {
    $('loadBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// quote + trade
// ---------------------------------------------------------------------------
// tradable on the internal market, OR migrated with an external pair to use
const tradable = () => !!ctx && !ctx.paused && (ctx.phase === 1 || (ctx.phase === 3 && !!ctx.lista));
const viaLista = () => !!ctx && ctx.phase === 3 && !!ctx.lista;

function amountInRaw() {
  const v = $('amountInput').value.trim();
  if (!(+v > 0)) return 0n;
  return mode === 'buy' ? parseUnits(v, ctx.quoteDecimals) : parseUnits(v, ctx.decimals);
}

// their estimates are non-view on purpose, so they are always eth_call'd
async function estimate(amountIn) {
  const fn = mode === 'buy' ? 'estimateBuyByBudget' : 'estimateSell';
  const { result } = await pub.simulateContract({
    address: ctx.tools, abi: TOOLS_ABI, functionName: fn,
    args: [ctx.token, account.address, amountIn, 0n, '0x'],
    account: account.address,
  });
  return result;
}

function minOutFor(v) {
  const slip = +($('slippage').value.trim() || '5');
  return v - (v * BigInt(Math.round(slip * 100))) / 10_000n;
}

async function refreshQuote() {
  const q = $('quote');
  if (!ctx || !account) return;
  if (!tradable()) { q.textContent = ''; return; }
  const amountIn = amountInRaw();
  if (amountIn === 0n) { q.textContent = ''; return; }
  q.textContent = 'quoting…';
  try {
    if (viaLista()) {
      const out = await listaQuote(amountIn);
      $('swapBtn').disabled = false;
      const shown = mode === 'buy'
        ? `${(+formatUnits(out, ctx.decimals)).toLocaleString()} ${ctx.symbol}`
        : `${formatUnits(out, ctx.quoteDecimals)} ${ctx.quoteSymbol}`;
      q.innerHTML = `you get about <b>${esc(shown)}</b> <span style="opacity:.7">(before transfer tax)</span>`;
      return;
    }
    const est = await estimate(amountIn);
    if (est.tokenAmount === 0n) {
      q.innerHTML = '<span class="err">not tradable right now (estimate returned 0)</span>';
      $('swapBtn').disabled = true;
      return;
    }
    $('swapBtn').disabled = false;
    const out = mode === 'buy'
      ? `${(+formatUnits(est.tokenAmount, ctx.decimals)).toLocaleString()} ${ctx.symbol}`
      : `${formatUnits(est.userReceives, ctx.quoteDecimals)} ${ctx.quoteSymbol}`;
    const fee = formatUnits(est.totalFee, ctx.quoteDecimals);
    q.innerHTML = `you get <b>${esc(out)}</b> · fees <b>${esc(fee)} ${esc(ctx.quoteSymbol)}</b>`;
  } catch (e) {
    q.innerHTML = `<span class="err">${esc(fmtErr(e))}</span>`;
  }
}

async function doTrade() {
  const st = $('swapStatus');
  if (!account) { st.innerHTML = '<span class="err">wallet is locked</span>'; return; }
  if (!tradable()) { st.innerHTML = '<span class="err">internal market is closed for this token</span>'; return; }
  const amountIn = amountInRaw();
  if (amountIn === 0n) { st.innerHTML = '<span class="err">enter an amount</span>'; return; }

  if (viaLista()) { await doListaTrade(); return; }

  $('swapBtn').disabled = true;
  try {
    st.textContent = 'estimating…';
    const est = await estimate(amountIn);
    if (est.tokenAmount === 0n) throw new Error('token is not tradable right now');

    let hash;
    if (mode === 'buy') {
      // an ERC20 quote has to be approved to Core; a native quote rides as value
      if (!ctx.isNativeQuote) {
        const allowed = await pub.readContract({
          address: ctx.quoteAsset, abi: ERC20, functionName: 'allowance', args: [account.address, ctx.core],
        });
        if (allowed < amountIn) {
          st.textContent = `approving ${ctx.quoteSymbol}…`;
          const ah = await wallet.writeContract({
            address: ctx.quoteAsset, abi: ERC20, functionName: 'approve', args: [ctx.core, 2n ** 256n - 1n],
          });
          await pub.waitForTransactionReceipt({ hash: ah, confirmations: 1 });
        }
      }
      st.textContent = 'sending buy…';
      hash = await wallet.writeContract({
        address: ctx.core, abi: CORE_ABI, functionName: 'buyByBudget',
        args: [ctx.token, amountIn, minOutFor(est.tokenAmount), 0n, '0x'],
        value: ctx.isNativeQuote ? amountIn : 0n,
      });
    } else {
      const allowed = await pub.readContract({
        address: ctx.token, abi: ERC20, functionName: 'allowance', args: [account.address, ctx.core],
      });
      if (allowed < amountIn) {
        st.textContent = `approving ${ctx.symbol}…`;
        const ah = await wallet.writeContract({
          address: ctx.token, abi: ERC20, functionName: 'approve', args: [ctx.core, 2n ** 256n - 1n],
        });
        await pub.waitForTransactionReceipt({ hash: ah, confirmations: 1 });
      }
      st.textContent = 'sending sell…';
      hash = await wallet.writeContract({
        address: ctx.core, abi: CORE_ABI, functionName: 'sell',
        args: [ctx.token, amountIn, minOutFor(est.userReceives), 0n, '0x'],
      });
    }

    st.innerHTML = `tx sent: <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 10)}…</a><br>waiting…`;
    const r = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (r.status !== 'success') throw new Error('trade reverted on-chain');
    st.innerHTML = `<span class="ok">DONE ✓</span> <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">tx</a>`;
    loadToken();
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(fmtErr(e))}</span>`;
  } finally {
    $('swapBtn').disabled = false;
  }
}


// ---------------------------------------------------------------------------
// Post-migration routing.
//
// Once a token migrates, OpenFour closes its internal market for good — that is
// by design, not a fault. Trading moves to the external Lista V2 pair, and this
// is where people get stuck: these are TAX tokens, so the ordinary
// swapExactTokensForTokens reverts with "ListaV2: K" every time (fewer tokens
// arrive than were sent, so the constant-product check fails). The
// SupportingFeeOnTransferTokens variant is the one that works. Verified against
// the live Moolah/lisUSD pair: plain method reverts, FoT method simulates fine.
//
// getAmountsOut is a PRE-tax number, so the real received amount is lower.
// Slippage has to cover the transfer tax as well as price movement.
// ---------------------------------------------------------------------------
const LISTA_STRATEGY_ABI = [
  { type: 'function', name: 'taxStrategy', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'listaV2Router', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'listaV2Factory', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];
const LISTA_ROUTER_ABI = [
  { type: 'function', name: 'getAmountsOut', inputs: [{ type: 'uint256' }, { type: 'address[]' }], outputs: [{ type: 'uint256[]' }], stateMutability: 'view' },
  {
    type: 'function', name: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' },
    ], outputs: [],
  },
];
const LISTA_FACTORY_ABI = [
  { type: 'function', name: 'getPair', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
];

/// discovers the external Lista V2 route for a migrated token, or null
async function findListaRoute(token, quoteAsset) {
  try {
    const strategy = await pub.readContract({ address: token, abi: LISTA_STRATEGY_ABI, functionName: 'taxStrategy' });
    const [router, factory] = await Promise.all([
      pub.readContract({ address: strategy, abi: LISTA_STRATEGY_ABI, functionName: 'listaV2Router' }),
      pub.readContract({ address: strategy, abi: LISTA_STRATEGY_ABI, functionName: 'listaV2Factory' }),
    ]);
    const pair = await pub.readContract({ address: factory, abi: LISTA_FACTORY_ABI, functionName: 'getPair', args: [token, quoteAsset] });
    if (/^0x0+$/i.test(pair)) return null;
    return { router, factory, pair };
  } catch {
    return null;
  }
}

function listaPath() {
  return mode === 'buy' ? [ctx.quoteAsset, ctx.token] : [ctx.token, ctx.quoteAsset];
}

async function listaQuote(amountIn) {
  const out = await pub.readContract({
    address: ctx.lista.router, abi: LISTA_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, listaPath()],
  });
  return out[out.length - 1];
}

async function doListaTrade() {
  const st = $('swapStatus');
  const amountIn = amountInRaw();
  if (amountIn === 0n) { st.innerHTML = '<span class="err">enter an amount</span>'; return; }
  $('swapBtn').disabled = true;
  try {
    const spend = mode === 'buy' ? ctx.quoteAsset : ctx.token;
    const spendSym = mode === 'buy' ? ctx.quoteSymbol : ctx.symbol;
    const allowed = await pub.readContract({
      address: spend, abi: ERC20, functionName: 'allowance', args: [account.address, ctx.lista.router],
    });
    if (allowed < amountIn) {
      st.textContent = `approving ${spendSym} to the Lista router…`;
      const ah = await wallet.writeContract({
        address: spend, abi: ERC20, functionName: 'approve', args: [ctx.lista.router, 2n ** 256n - 1n],
      });
      await pub.waitForTransactionReceipt({ hash: ah, confirmations: 1 });
    }

    st.textContent = 'quoting…';
    const quoted = await listaQuote(amountIn);
    const minOut = minOutFor(quoted);

    st.textContent = 'sending swap…';
    const hash = await wallet.writeContract({
      address: ctx.lista.router, abi: LISTA_ROUTER_ABI,
      functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
      args: [amountIn, minOut, listaPath(), account.address, BigInt(Math.floor(Date.now() / 1000) + 1200)],
    });
    st.innerHTML = `tx sent: <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 10)}…</a><br>waiting…`;
    const r = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (r.status !== 'success') throw new Error('swap reverted on-chain');
    st.innerHTML = `<span class="ok">SWAPPED ✓</span> <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">tx</a>`;
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
  $('amountLabel').textContent = m === 'buy'
    ? `${ctx ? ctx.quoteSymbol : 'QUOTE'} TO SPEND`
    : `${ctx ? ctx.symbol : 'TOKEN'} TO SELL`;
  $('swapBtn').className = m === 'buy' ? 'btn' : 'btn sell';
  $('swapBtn').textContent = m === 'buy' ? 'BUY' : 'SELL';
  $('amountInput').value = '';
  $('quote').textContent = '';
  $('swapStatus').textContent = '';
  $('chips').innerHTML = '';
  for (const c of (m === 'buy' ? ['0.01', '0.05', '0.1', '0.5', '1'] : ['25%', '50%', '100%'])) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = m === 'buy' ? `${c} ${ctx ? ctx.quoteSymbol : ''}` : c;
    b.onclick = () => applyChip(c);
    $('chips').appendChild(b);
  }
  refreshBalances();
}

async function applyChip(c) {
  if (mode === 'buy') { $('amountInput').value = c; refreshQuote(); return; }
  const bal = await pub.readContract({ address: ctx.token, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
  $('amountInput').value = formatUnits((bal * BigInt(parseInt(c, 10))) / 100n, ctx.decimals);
  refreshQuote();
}

async function refreshBalances() {
  if (!account || !ctx) return;
  try {
    if (mode === 'buy') {
      const b = ctx.isNativeQuote
        ? await pub.getBalance({ address: account.address })
        : await pub.readContract({ address: ctx.quoteAsset, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
      $('balanceOut').value = `${(+formatUnits(b, ctx.quoteDecimals)).toFixed(5)} ${ctx.quoteSymbol}`;
    } else {
      const b = await pub.readContract({ address: ctx.token, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
      $('balanceOut').value = `${(+formatUnits(b, ctx.decimals)).toLocaleString()} ${ctx.symbol}`;
    }
  } catch { /* balance display is best-effort */ }
}

function useKey(pk) {
  account = privateKeyToAccount(pk);
  wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPCS[0]) });
  $('walletAddr').textContent = account.address.slice(0, 6) + '…' + account.address.slice(-4);
}

function start() {
  $('appRoot').style.display = '';
  const keys = loadKeys();
  if (keys?.evm) { try { useKey(keys.evm); } catch { $('noVault').hidden = false; } }
  else $('noVault').hidden = false;

  $('loadBtn').onclick = loadToken;
  $('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadToken(); });
  $('tabBuy').onclick = () => setMode('buy');
  $('tabSell').onclick = () => setMode('sell');
  $('swapBtn').onclick = doTrade;

  let t;
  const debounced = () => { clearTimeout(t); t = setTimeout(refreshQuote, 400); };
  $('amountInput').addEventListener('input', debounced);
  $('slippage').addEventListener('input', debounced);

  const pre = new URLSearchParams(location.search).get('token');
  if (pre) { $('tokenInput').value = pre; loadToken(); }
}

start();
