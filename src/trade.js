// Trade page: buy/sell a Meteora DBC token with SOL via the router in
// ./solana.js (Jupiter leg + DBC curve leg). Reuses the launcher's vault
// (vault.v1) and gate (gate.cred.v1). Browser-native here; the heavy web3.js +
// SDK come from the lazily-imported solana.js bundle.
const SOL_RPC = 'https://mainnet.helius-rpc.com/?api-key=3fb08d49-71d7-492b-84f1-9ff0e3eb95ea';
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// vault (shared scheme with the launcher)
// ---------------------------------------------------------------------------
const VAULT_KEY = 'vault.v1';
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function deriveAesKey(password, salt) {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
async function decryptSecret(password, blob) {
  const key = await deriveAesKey(password, unb64(blob.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
  return new TextDecoder().decode(pt);
}
const loadVault = () => JSON.parse(localStorage.getItem(VAULT_KEY) || 'null');

// ---------------------------------------------------------------------------
// base58 -> SOL pubkey (to show the address without loading the heavy bundle)
// ---------------------------------------------------------------------------
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
// gate (shared credential with the launcher)
// ---------------------------------------------------------------------------
const GATE_CRED = 'gate.cred.v1';
const GATE_FLAG = 'gate.ok.v1';
const GATE_ITER = 150000;
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function gateHash(username, password, saltBytes) {
  const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(username + '\n' + password), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: GATE_ITER, hash: 'SHA-256' }, keyMat, 256));
}
const loadGateCred = () => JSON.parse(localStorage.getItem(GATE_CRED) || 'null');

function initGate(onPass) {
  if (sessionStorage.getItem(GATE_FLAG) === '1') { onPass(); return; }
  const creating = !loadGateCred();
  $('gateTitle').textContent = creating ? 'CREATE LOGIN' : 'LOGIN';
  $('gateSub').textContent = creating
    ? 'Pick a username and password to lock this page on this device.'
    : 'Enter your username and password.';
  $('gateConfirmRow').classList.toggle('hidden', !creating);
  $('gateBtn').textContent = creating ? 'CREATE' : 'ENTER';
  const submit = async () => {
    $('gateErr').textContent = '';
    const u = $('gateUser').value.trim();
    const p = $('gatePass').value;
    if (creating) {
      if (u.length < 3) { $('gateErr').textContent = 'username needs 3+ characters'; return; }
      if (p.length < 6) { $('gateErr').textContent = 'password needs 6+ characters'; return; }
      if (p !== $('gatePass2').value) { $('gateErr').textContent = 'passwords do not match'; return; }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      localStorage.setItem(GATE_CRED, JSON.stringify({ username: u, salt: toHex(salt), hash: await gateHash(u, p, salt) }));
    } else {
      const cred = loadGateCred();
      const saltBytes = Uint8Array.from(cred.salt.match(/../g).map((h) => parseInt(h, 16)));
      if ((await gateHash(u, p, saltBytes)) !== cred.hash) { $('gateErr').textContent = 'wrong username or password'; return; }
    }
    sessionStorage.setItem(GATE_FLAG, '1');
    $('gateOverlay').classList.add('hidden');
    onPass();
  };
  $('gateBtn').onclick = submit;
  const onEnter = (e) => { if (e.key === 'Enter') submit(); };
  $('gatePass').addEventListener('keydown', onEnter);
  $('gatePass2').addEventListener('keydown', onEnter);
  $('gateUser').focus();
}

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

async function doUnlock() {
  $('unlockErr').textContent = '';
  const vault = loadVault();
  if (!vault?.sol) { $('unlockErr').textContent = 'no SOL key in this wallet — add one in the launcher (🔑 keys)'; return; }
  try {
    solSecret = await decryptSecret($('unlockPass').value, vault.sol);
    solAddr = solPubkey(solSecret);
    $('unlockPass').value = '';
    $('unlockOverlay').classList.add('hidden');
    $('walletAddr').textContent = solAddr.slice(0, 4) + '…' + solAddr.slice(-4);
    refreshSolBalance();
  } catch {
    $('unlockErr').textContent = 'wrong password';
  }
}

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
      : `DBC pool · priced in <b>${tokenInfo.quoteSymbol}</b>`;
    runPreview();
  } catch (e) {
    $('tokinfo').innerHTML = `<span class="err">${e.message}</span>`;
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
    if (side === 'buy') {
      $('preview').innerHTML =
        `<span class="route">route: SOL → ${tokenInfo.quoteSymbol} → token</span><br>` +
        `≈ <b>${fmt(p.quoteOut, p.quoteDecimals)}</b> ${tokenInfo.quoteSymbol} → ` +
        `you receive ≈ <b>${fmt(p.tokensOut, p.baseDecimals)}</b> tokens`;
    } else {
      $('preview').innerHTML =
        `<span class="route">route: token → ${tokenInfo.quoteSymbol} → SOL</span><br>` +
        `≈ <b>${fmt(p.quoteOut, p.quoteDecimals)}</b> ${tokenInfo.quoteSymbol} → ` +
        `you receive ≈ <b>${fmt(p.solOut, 9)}</b> SOL`;
    }
    $('go').disabled = false;
  } catch (e) {
    $('preview').innerHTML = `<span class="err">${e.message}</span>`;
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
  if (!solSecret) { $('unlockOverlay').classList.remove('hidden'); return; }
  const mint = $('token').value.trim();
  const amt = $('amount').value.trim();
  const btn = $('go');
  btn.disabled = true;
  const st = $('status');
  const say = (m) => { st.innerHTML = m; };
  try {
    const mod = await loadRouter();
    const opts = { rpcUrl: SOL_RPC, secretKey: solSecret, tokenMint: mint, slippageBps: slippageBps(), onStatus: say };
    let res;
    if (side === 'buy') res = await mod.routerBuy({ ...opts, uiSol: amt });
    else res = await mod.routerSell({ ...opts, uiTokens: amt });

    const link = (sig, label) => `<a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">${label}</a>`;
    st.innerHTML = side === 'buy'
      ? `<span class="ok">BOUGHT ✓</span> ≈ <b>${fmt(res.tokensOut, res.baseDecimals)}</b> tokens<br>${link(res.jupSig, 'leg 1 (Jupiter)')} · ${link(res.dbcSig, 'leg 2 (DBC)')}`
      : `<span class="ok">SOLD ✓</span> ≈ <b>${fmt(res.solOut, 9)}</b> SOL<br>${link(res.dbcSig, 'leg 1 (DBC)')} · ${link(res.jupSig, 'leg 2 (Jupiter)')}`;
    refreshSolBalance();
  } catch (e) {
    st.innerHTML = `<span class="err">${e.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function start() {
  $('appRoot').style.display = '';
  if (!loadVault()) { $('noVault').hidden = false; $('main').style.display = 'none'; return; }
  $('unlockOverlay').classList.remove('hidden');
  $('unlockBtn').onclick = doUnlock;
  $('unlockPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  $('unlockPass').focus();

  $('buyTab').onclick = () => setSide('buy');
  $('sellTab').onclick = () => setSide('sell');
  $('token').addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(resolveTokenInfo, 400); });
  $('amount').addEventListener('input', schedulePreview);
  $('slippage').addEventListener('input', schedulePreview);
  $('go').onclick = go;
}

initGate(start);
