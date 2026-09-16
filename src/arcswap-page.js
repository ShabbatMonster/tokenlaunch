import { isAddress, getAddress, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  findArcPools, estimateArcSwap, arcSwap, arcTokenInfo, ARC_V3_ROUTER,
} from './arcswap.js';

// ---------------------------------------------------------------------------
// The Arc swap page. Same EVM key the launcher stores - an Ethereum key is the
// same address on Arc - and the same keys.v1 slot, so nothing new is asked for.
// Gas on Arc is paid in USDC, so the wallet needs a little USDC even to sell.
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EXPLORER = 'https://arcscan.app';
const loadKeys = () => { try { return JSON.parse(localStorage.getItem('keys.v1') || 'null'); } catch { return null; } };

let pk = null;
let address = null;
let ctx = null;          // { token, info, pools }
let mode = 'buy';

const fmt = (raw, decimals, max = 6) => {
  const n = Number(formatUnits(raw ?? 0n, decimals));
  if (n === 0) return '0';
  if (n < 1e-6) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? max : 4 });
};

async function refreshBalances() {
  if (!ctx || !address) return;
  const info = await arcTokenInfo(ctx.token, address);
  ctx.info = info;
  $('balUsdc').textContent = fmt(info.usdcBalance, 6) + ' USDC';
  $('balToken').textContent = fmt(info.balance, info.decimals) + ' ' + info.symbol;
}

async function loadToken() {
  const raw = $('tokenInput').value.trim();
  const st = $('loadStatus');
  $('tradeCard').classList.add('hidden');
  if (!isAddress(raw)) { st.innerHTML = '<span class="err">enter a valid token address</span>'; return; }
  const token = getAddress(raw);
  $('loadBtn').disabled = true;
  st.textContent = 'looking for a USDC pool on Arc’s V3 DEX…';
  try {
    const [pools, info] = await Promise.all([findArcPools(token), arcTokenInfo(token, address)]);
    if (!pools.length) {
      st.innerHTML = '<span class="err">no USDC pool for this token on Arc’s V3 DEX</span>';
      return;
    }
    ctx = { token, info, pools };
    const p = pools[0];
    $('pair').innerHTML = `<b>${esc(info.symbol || '???')}</b> / USDC`;
    $('poolInfo').innerHTML =
      `${esc(info.name || '')} &middot; ${(p.fee / 10000).toFixed(2)}% pool &middot; `
      + `<a href="${EXPLORER}/address/${p.pool}" target="_blank" rel="noopener">${p.pool.slice(0, 6)}…${p.pool.slice(-4)}</a>`
      + (pools.length > 1 ? ` &middot; deepest of ${pools.length} pools` : '');
    st.textContent = '';
    $('tradeCard').classList.remove('hidden');
    history.replaceState(null, '', '?token=' + token);
    await refreshBalances();
    setMode(mode);
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(e.shortMessage || e.message)}</span>`;
  } finally {
    $('loadBtn').disabled = false;
  }
}

function setMode(m) {
  mode = m;
  $('tabBuy').classList.toggle('active', m === 'buy');
  $('tabSell').classList.toggle('active', m === 'sell');
  $('amountLabel').textContent = m === 'buy' ? 'USDC TO SPEND' : `${ctx?.info?.symbol || 'TOKENS'} TO SELL`;
  $('swapBtn').textContent = m === 'buy' ? 'BUY' : 'SELL';
  $('swapBtn').className = m === 'buy' ? 'btn' : 'btn sell';
  refreshQuote();
}

let quoteSeq = 0;
async function refreshQuote() {
  const q = $('quote');
  const amt = $('amountInput').value.trim();
  if (!ctx || !amt || !(Number(amt) > 0)) { q.textContent = ''; return; }
  const seq = ++quoteSeq;
  q.textContent = 'quoting…';
  try {
    const est = await estimateArcSwap({ token: ctx.token, side: mode, amount: amt });
    if (seq !== quoteSeq) return;
    const outSym = mode === 'buy' ? (ctx.info.symbol || 'tokens') : 'USDC';
    q.innerHTML = est.amountOut > 0n
      ? `≈ <b>${esc(Number(est.amountOutUi).toLocaleString(undefined, { maximumFractionDigits: 6 }))} ${esc(outSym)}</b>`
        + ' <span class="dim">(before slippage; the exact amount is simulated when you swap)</span>'
      : '<span class="dim">no in-range estimate for this size &mdash; it crosses a liquidity range. '
        + 'The exact amount is still simulated before anything is sent.</span>';
  } catch (e) {
    if (seq === quoteSeq) q.innerHTML = `<span class="err">${esc(e.shortMessage || e.message)}</span>`;
  }
}

function applyMax() {
  if (!ctx?.info) return;
  $('amountInput').value = mode === 'buy'
    ? formatUnits(ctx.info.usdcBalance ?? 0n, 6)
    : formatUnits(ctx.info.balance ?? 0n, ctx.info.decimals);
  refreshQuote();
}

async function doSwap() {
  const st = $('swapStatus');
  if (!pk) { st.innerHTML = '<span class="err">no EVM key in this browser &mdash; import it in the launcher</span>'; return; }
  const amt = $('amountInput').value.trim();
  if (!ctx || !(Number(amt) > 0)) { st.innerHTML = '<span class="err">enter an amount</span>'; return; }
  const slip = Math.round(Number($('slippage').value || '5') * 100);
  $('swapBtn').disabled = true;
  try {
    const res = await arcSwap({
      privateKey: pk, token: ctx.token, side: mode, amount: amt, slippageBps: slip,
      onStatus: (m) => { st.textContent = m; },
    });
    st.innerHTML = `<span class="ok">${mode === 'buy' ? 'BOUGHT' : 'SOLD'} ✓</span> `
      + `~${esc(Number(res.expectedOutUi).toLocaleString(undefined, { maximumFractionDigits: 6 }))} ${esc(res.outSymbol)} `
      + `&middot; <a href="${EXPLORER}/tx/${res.hash}" target="_blank" rel="noopener">tx</a>`;
    await refreshBalances();
    refreshQuote();
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(e.shortMessage || e.message)}</span>`;
  } finally {
    $('swapBtn').disabled = false;
  }
}

function start() {
  $('appRoot').style.display = '';
  $('routerAddr').textContent = ARC_V3_ROUTER;
  const keys = loadKeys();
  if (keys?.evm) {
    try {
      pk = keys.evm;
      address = privateKeyToAccount(pk).address;
      $('walletAddr').textContent = address.slice(0, 6) + '…' + address.slice(-4);
    } catch { pk = null; $('noVault').hidden = false; }
  } else {
    $('noVault').hidden = false;
  }

  $('loadBtn').onclick = loadToken;
  $('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadToken(); });
  $('tabBuy').onclick = () => setMode('buy');
  $('tabSell').onclick = () => setMode('sell');
  $('swapBtn').onclick = doSwap;
  $('maxBtn').onclick = applyMax;
  let t;
  const debounced = () => { clearTimeout(t); t = setTimeout(refreshQuote, 350); };
  $('amountInput').addEventListener('input', debounced);

  const pre = new URLSearchParams(location.search).get('token');
  if (pre) { $('tokenInput').value = pre; loadToken(); }
}

start();
