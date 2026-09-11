// Trade page: buy/sell a Meteora DBC token with SOL via the router in
// ./solana.js (Jupiter leg + DBC curve leg). Private/local tool — no login gate,
// no password: the SOL key is read from the plaintext local store (keys.v1,
// shared with the launcher). The heavy web3.js + SDK come from the lazily-
// imported solana.js bundle.
const SOL_RPC = 'https://mainnet.helius-rpc.com/?api-key=3fb08d49-71d7-492b-84f1-9ff0e3eb95ea';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const KEYS_KEY = 'keys.v1';
const loadKeys = () => { try { return JSON.parse(localStorage.getItem(KEYS_KEY) || 'null'); } catch { return null; } };

// base58 -> SOL pubkey (to show the address without loading the heavy bundle)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s) {
  const bytes = [0];
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('bad base58');
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  for (const c of s) { if (c === '1') zeros++; else break; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}
function base58Encode(bytes) {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const b of bytes) { if (b === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
function solPubkey(secret) {
  const s = secret.trim();
  const b = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : base58Decode(s);
  if (b.length !== 64) throw new Error('bad SOL key');
  return base58Encode(b.slice(32, 64));
}
const isSolAddress = (s) => { try { return base58Decode(s.trim()).length === 32; } catch { return false; } };

// ---------------------------------------------------------------------------
// trade state
// ---------------------------------------------------------------------------
let solSecret = null;
let solAddr = null;
let side = 'buy';
let tokenInfo = null;   // { quoteSymbol, quoteDecimals, baseDecimals, isMigrated }
let router = null;      // lazily imported ./solana.js

const loadRouter = async () => (router ||= await import('./solana.js'));
const slippageBps = () => Math.max(1, Math.round((+$('slippage').value || 1.5) * 100));

async function refreshSolBalance() {
  if (!solAddr) return;
  const short = solAddr.slice(0, 4) + '…' + solAddr.slice(-4);
  try {
    const r = await fetch(SOL_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [solAddr] }),
    });
    const j = await r.json();
    $('walletAddr').textContent = short + ' · ' + (j.result.value / 1e9).toFixed(3) + ' SOL';
  } catch { $('walletAddr').textContent = short; }
}

const fmt = (raw, dec) => (Number(raw) / 10 ** dec).toLocaleString('en-US', { maximumFractionDigits: 6 });

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 400);
}

async function resolveTokenInfo() {
  tokenInfo = null;
  $('tokinfo').textContent = '';
  const mint = $('token').value.trim();
  if (!isSolAddress(mint)) { $('go').disabled = true; return; }
  $('tokinfo').textContent = 'resolving pool…';
  try {
    const { resolveToken } = await loadRouter();
    tokenInfo = await resolveToken({ rpcUrl: SOL_RPC, tokenMint: mint });
    $('tokinfo').innerHTML = tokenInfo.isMigrated
      ? '<span class="err">graduated off the curve — trade on the migrated pool</span>'
      : `DBC pool · priced in <b>${esc(tokenInfo.quoteSymbol)}</b>`;
    runPreview();
  } catch (e) {
    $('tokinfo').innerHTML = `<span class="err">${esc(e.message)}</span>`;
    $('go').disabled = true;
  }
}

async function runPreview() {
  const mint = $('token').value.trim();
  const amt = $('amount').value.trim();
  $('go').disabled = true;
  if (!tokenInfo || tokenInfo.isMigrated || !isSolAddress(mint) || !(+amt > 0)) { $('preview').textContent = ''; return; }
  $('preview').textContent = 'quoting…';
  try {
    const { routerPreview } = await loadRouter();
    const p = await routerPreview({ rpcUrl: SOL_RPC, tokenMint: mint, side, uiAmount: amt, slippageBps: slippageBps() });
    const sym = esc(tokenInfo.quoteSymbol);
    if (side === 'buy') {
      $('preview').innerHTML =
        `<span class="route">route: SOL → ${sym} → token</span><br>` +
        `≈ <b>${fmt(p.quoteOut, p.quoteDecimals)}</b> ${sym} → you receive ≈ <b>${fmt(p.tokensOut, p.baseDecimals)}</b> tokens`;
    } else {
      $('preview').innerHTML =
        `<span class="route">route: token → ${sym} → SOL</span><br>` +
        `≈ <b>${fmt(p.quoteOut, p.quoteDecimals)}</b> ${sym} → you receive ≈ <b>${fmt(p.solOut, 9)}</b> SOL`;
    }
    $('go').disabled = false;
  } catch (e) {
    $('preview').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
}

function setSide(s) {
  side = s;
  $('buyTab').classList.toggle('active', s === 'buy');
  $('sellTab').classList.toggle('active', s === 'sell');
  $('amtLabel').textContent = s === 'buy' ? 'YOU PAY (SOL)' : 'YOU SELL (TOKENS)';
  $('amount').placeholder = s === 'buy' ? '0.1' : '1000000';
  $('go').textContent = s === 'buy' ? 'BUY WITH SOL' : 'SELL FOR SOL';
  runPreview();
}

async function go() {
  if (!solSecret) return;
  const mint = $('token').value.trim();
  const amt = $('amount').value.trim();
  const btn = $('go');
  btn.disabled = true;
  const st = $('status');
  const say = (m) => { st.innerHTML = esc(m); };
  try {
    const mod = await loadRouter();
    // one router, four venues — pump.fun and LaunchLab curves trade in their own
    // quote (a stock, for a stock-paired launch), Meteora routes through Jupiter
    const res = await mod.solanaTrade({
      rpcUrl: SOL_RPC, secretKey: solSecret, mint, side, amountUi: amt,
      slippageBps: slippageBps(), onStatus: say,
    });

    const link = (sig, label) => `<a href="https://solscan.io/tx/${esc(sig)}" target="_blank" rel="noopener">${label}</a>`;
    const venue = { pump: 'pump.fun curve', launchlab: 'LaunchLab curve', dbc: 'Meteora DBC' }[res.venue] || res.venue;
    const legs = res.jupSig && res.dbcSig
      ? `${link(res.jupSig, 'Jupiter leg')} · ${link(res.dbcSig, 'curve leg')}`
      : (res.sig ? link(res.sig, 'tx on solscan') : '');
    st.innerHTML = `<span class="ok">${side === 'buy' ? 'BOUGHT' : 'SOLD'} ✓</span> `
      + `<span class="hint">via ${esc(venue)}</span><br>${legs}`;
    refreshSolBalance();
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// boot — no gate, no password: read the SOL key from the plaintext store
// ---------------------------------------------------------------------------
function start() {
  $('appRoot').style.display = '';
  const keys = loadKeys();
  if (!keys?.sol) { $('noVault').hidden = false; $('main').style.display = 'none'; return; }
  try {
    solSecret = keys.sol;
    solAddr = solPubkey(solSecret);
    $('walletAddr').textContent = solAddr.slice(0, 4) + '…' + solAddr.slice(-4);
    refreshSolBalance();
  } catch {
    $('noVault').hidden = false; $('main').style.display = 'none'; return;
  }
  $('buyTab').onclick = () => setSide('buy');
  $('sellTab').onclick = () => setSide('sell');
  $('token').addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(resolveTokenInfo, 400); });
  $('amount').addEventListener('input', schedulePreview);
  $('slippage').addEventListener('input', schedulePreview);
  $('go').onclick = go;
}

start();
