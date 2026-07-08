import {
  createPublicClient, createWalletClient, http, defineChain,
  parseEther, formatEther, keccak256, stringToBytes, parseEventLogs,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// launchpad registry — flip `enabled` to light up more pads (same Noxa ABI)
// ---------------------------------------------------------------------------
const FACTORY_ABI = [
  {
    type: 'function', name: 'launchToken', stateMutability: 'payable',
    inputs: [
      {
        name: 'params', type: 'tuple', components: [
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
          { name: 'logo', type: 'string' },
          { name: 'description', type: 'string' },
          {
            name: 'socials', type: 'tuple', components: [
              { name: 'telegram', type: 'string' },
              { name: 'twitter', type: 'string' },
              { name: 'discord', type: 'string' },
              { name: 'website', type: 'string' },
              { name: 'farcaster', type: 'string' },
            ],
          },
          { name: 'devWallet', type: 'address' },
        ],
      },
      { name: 'launchConfigId', type: 'uint256' },
      { name: 'dexId', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [{ name: 'token', type: 'address' }, { name: 'positionId', type: 'uint256' }],
  },
  { type: 'function', name: 'launchFee', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'launchEnabled', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  {
    type: 'event', name: 'TokenLaunched', inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'deployer', type: 'address', indexed: true },
      { name: 'dexFactory', type: 'address', indexed: true },
      { name: 'pairToken', type: 'address', indexed: false },
      { name: 'pool', type: 'address', indexed: false },
      { name: 'dexId', type: 'uint256', indexed: false },
      { name: 'launchConfigId', type: 'uint256', indexed: false },
      { name: 'positionId', type: 'uint256', indexed: false },
      { name: 'restrictionsEndBlock', type: 'uint256', indexed: false },
      { name: 'initialBuyAmount', type: 'uint256', indexed: false },
    ],
  },
];

const LOCKER_ABI = [
  { type: 'function', name: 'collectFees', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'deployerTokens', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
];
const ERC20_ABI = [
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
];

const PADS = [
  {
    id: 'noxa-robinhood', label: 'Noxa · Robinhood', vm: 'evm', enabled: true,
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: '0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB',
    locker: '0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85',
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://fun.noxa.fi/robinhood/token/${t}`,
    nativeSymbol: 'ETH',
  },
  { id: 'noxa-monad',    label: 'Noxa · Monad',   vm: 'evm', enabled: false, chainId: 143,  rpc: '', factory: '0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85', nativeSymbol: 'MON' },
  { id: 'noxa-megaeth',  label: 'Noxa · MegaETH', vm: 'evm', enabled: false, chainId: 4326, rpc: '', factory: '0xAc303930F2f7A78BBB037f3f4622Bd02f5545B9a', nativeSymbol: 'ETH' },
  { id: 'pump-sol',      label: 'Pump · SOL',     vm: 'sol', enabled: false },
];
let activePad = PADS[0];

const IPFS_ADD = 'https://api.thegraph.com/ipfs/api/v0/add';
const DEFAULT_DESC = 'aaaaaaaaaa';

// ---------------------------------------------------------------------------
// vault — PBKDF2(password) -> AES-256-GCM, ciphertext in localStorage only
// ---------------------------------------------------------------------------
const VAULT_KEY = 'vault.v1';
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveAesKey(password, salt) {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function encryptSecret(password, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

async function decryptSecret(password, blob) {
  const key = await deriveAesKey(password, unb64(blob.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
  return new TextDecoder().decode(pt);
}

const loadVault = () => JSON.parse(localStorage.getItem(VAULT_KEY) || 'null');
const saveVault = (v) => localStorage.setItem(VAULT_KEY, JSON.stringify(v));

// unlocked session state (memory only)
let account = null;        // viem account
let solKeyB58 = null;      // held for future SOL pads

// ---------------------------------------------------------------------------
// key validation
// ---------------------------------------------------------------------------
function normalizeEvmKey(input) {
  let k = input.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error('EVM key must be 64 hex chars');
  return '0x' + k.toLowerCase();
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58DecodeLen(s) {
  let bytes = [0];
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('bad base58 char');
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of s) { if (c === '1') bytes.push(0); else break; }
  return bytes.length;
}
function validateSolKey(input) {
  const k = input.trim();
  if (k.startsWith('[')) {
    const arr = JSON.parse(k);
    if (!Array.isArray(arr) || arr.length !== 64) throw new Error('SOL key array must have 64 numbers');
    return k;
  }
  if (base58DecodeLen(k) !== 64) throw new Error('SOL key must decode to 64 bytes');
  return k;
}

// ---------------------------------------------------------------------------
// clients
// ---------------------------------------------------------------------------
function chainFor(pad) {
  return defineChain({
    id: pad.chainId,
    name: pad.label,
    nativeCurrency: { name: pad.nativeSymbol, symbol: pad.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [pad.rpc] } },
  });
}
const publicClientFor = (pad) => createPublicClient({ chain: chainFor(pad), transport: http(pad.rpc) });

// ---------------------------------------------------------------------------
// image: pick / drop / paste -> square resize -> blob (GIFs pass through)
// ---------------------------------------------------------------------------
let logoBlob = null;

async function setImage(fileOrBlob) {
  if (!fileOrBlob || !fileOrBlob.type.startsWith('image/')) return;
  if (fileOrBlob.type === 'image/gif') {
    if (fileOrBlob.size > 4.4 * 1024 * 1024) { setStatus('GIF too big (max ~4.5MB)', true); return; }
    logoBlob = fileOrBlob;
  } else {
    logoBlob = await squareResize(fileOrBlob, 512);
  }
  const url = URL.createObjectURL(logoBlob);
  const drop = document.getElementById('drop');
  drop.classList.add('has');
  drop.innerHTML = `<img src="${url}" alt="logo">`;
  setStatus('');
}

async function squareResize(blob, size) {
  const img = await createImageBitmap(blob);
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

async function uploadToIpfs(blob) {
  const fd = new FormData();
  fd.append('file', new File([blob], 'logo.' + (blob.type === 'image/gif' ? 'gif' : 'png'), { type: blob.type }));
  const r = await fetch(IPFS_ADD, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('IPFS upload failed (' + r.status + ')');
  const { Hash } = await r.json();
  if (!Hash) throw new Error('IPFS upload returned no hash');
  return 'ipfs://' + Hash;
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------
async function launch() {
  const pad = activePad;
  if (!pad.enabled) throw new Error('that launchpad is not live yet');
  if (!account) throw new Error('unlock your wallet first');
  const name = document.getElementById('name').value.trim();
  const symbol = document.getElementById('symbol').value.trim().toUpperCase();
  if (!name || !symbol) throw new Error('name and ticker required');
  if (!logoBlob) throw new Error('image required');
  const description = document.getElementById('desc').value.trim() || DEFAULT_DESC;
  const twitter = document.getElementById('twitter').value.trim();
  const website = document.getElementById('website').value.trim();
  const devBuy = selectedBuyAmount();

  setStatus('uploading image to IPFS...');
  const logo = await uploadToIpfs(logoBlob);

  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  setStatus('reading launch fee...');
  const fee = await pub.readContract({ address: pad.factory, abi: FACTORY_ABI, functionName: 'launchFee' });
  const value = fee + devBuy;

  const bal = await pub.getBalance({ address: account.address });
  if (bal < value) throw new Error(`insufficient balance: need ${formatEther(value)}+gas, have ${formatEther(bal)} ${pad.nativeSymbol}`);

  const args = [
    {
      name, symbol, logo, description,
      socials: { telegram: '', twitter, discord: '', website, farcaster: '' },
      devWallet: account.address,
    },
    0n, // launchConfigId
    0n, // dexId
    keccak256(stringToBytes(`${name}-${symbol}-${Date.now()}`)),
  ];

  setStatus('sending launch tx...');
  let gas;
  try {
    gas = await pub.estimateContractGas({ address: pad.factory, abi: FACTORY_ABI, functionName: 'launchToken', args, value, account });
    gas = (gas * 120n) / 100n;
  } catch { /* let the node estimate */ }

  const hash = await wallet.writeContract({ address: pad.factory, abi: FACTORY_ABI, functionName: 'launchToken', args, value, gas });
  setStatus(`tx sent: ${hash}\nwaiting for confirmation...`);

  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('tx reverted: ' + hash);

  const [ev] = parseEventLogs({ abi: FACTORY_ABI, eventName: 'TokenLaunched', logs: receipt.logs });
  const token = ev?.args?.token;
  if (token) rememberLaunch(pad, token, symbol);
  const el = document.getElementById('status');
  el.innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${token || ''}<br>` +
    (token && pad.site ? `<a href="${pad.site(token)}" target="_blank" rel="noopener">view on noxa</a> · ` : '') +
    `<a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx on explorer</a>`;
  refreshBalance();
  renderTokenList();
}

// ---------------------------------------------------------------------------
// dev-buy chips — editable presets, persisted
// ---------------------------------------------------------------------------
const CHIPS_KEY = 'buyChips.v1';
let buyChips = JSON.parse(localStorage.getItem(CHIPS_KEY) || 'null') || ['0.001', '0.005', '0.01', '0.05'];
let selectedChip = -1; // -1 = none
let editingChips = false;

function selectedBuyAmount() {
  return selectedChip >= 0 ? parseEther(buyChips[selectedChip]) : 0n;
}

function renderBuyChips() {
  const box = $('buyChips');
  box.innerHTML = '';

  const none = document.createElement('button');
  none.className = 'pad' + (selectedChip === -1 ? ' active' : '');
  none.textContent = 'none';
  none.disabled = editingChips;
  none.onclick = () => { selectedChip = -1; renderBuyChips(); };
  box.appendChild(none);

  buyChips.forEach((amt, i) => {
    const b = document.createElement('button');
    b.className = 'pad' + (!editingChips && selectedChip === i ? ' active' : '');
    if (editingChips) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = amt;
      input.dataset.chip = i;
      input.onkeydown = (e) => { if (e.key === 'Enter') saveChips(); };
      b.appendChild(input);
      b.onclick = () => input.focus();
    } else {
      b.textContent = amt + ' ' + activePad.nativeSymbol;
      b.onclick = () => { selectedChip = i; renderBuyChips(); };
    }
    box.appendChild(b);
  });

  const pencil = document.createElement('button');
  pencil.className = 'pad edit' + (editingChips ? ' active' : '');
  pencil.title = editingChips ? 'save' : 'edit amounts';
  pencil.textContent = editingChips ? '✓' : '✎';
  pencil.onclick = () => { editingChips ? saveChips() : (editingChips = true, renderBuyChips()); };
  box.appendChild(pencil);
}

function saveChips() {
  const inputs = $('buyChips').querySelectorAll('input[data-chip]');
  for (const input of inputs) {
    const v = input.value.trim();
    if (v && !isNaN(+v) && +v > 0) buyChips[+input.dataset.chip] = v;
  }
  localStorage.setItem(CHIPS_KEY, JSON.stringify(buyChips));
  editingChips = false;
  renderBuyChips();
}

// ---------------------------------------------------------------------------
// my tokens + claim fees (Noxa locker)
// ---------------------------------------------------------------------------
const LAUNCHES_KEY = 'launches.v1';
const loadLaunches = () => JSON.parse(localStorage.getItem(LAUNCHES_KEY) || '[]');
function rememberLaunch(pad, token, symbol) {
  const all = loadLaunches();
  if (!all.some((l) => l.token.toLowerCase() === token.toLowerCase())) {
    all.push({ pad: pad.id, token, symbol });
    localStorage.setItem(LAUNCHES_KEY, JSON.stringify(all));
  }
}

async function discoverMyTokens(pad) {
  // locker.deployerTokens(wallet, i) until it reverts
  const pub = publicClientFor(pad);
  const found = [];
  for (let i = 0; i < 100; i++) {
    try {
      const t = await pub.readContract({
        address: pad.locker, abi: LOCKER_ABI, functionName: 'deployerTokens',
        args: [account.address, BigInt(i)],
      });
      found.push(t);
    } catch { break; }
  }
  return found;
}

async function renderTokenList() {
  const box = $('tokenList');
  if (!account) { box.innerHTML = '<div class="empty">unlock wallet to load your launches</div>'; return; }
  const pad = PADS.find((p) => p.enabled && p.locker);
  box.innerHTML = '<div class="empty">loading…</div>';
  try {
    const pub = publicClientFor(pad);
    const onchain = await discoverMyTokens(pad);
    const local = loadLaunches().filter((l) => l.pad === pad.id).map((l) => l.token);
    const tokens = [...new Set([...onchain, ...local].map((t) => t.toLowerCase()))];
    if (!tokens.length) { box.innerHTML = '<div class="empty">no launches from this wallet yet</div>'; return; }
    box.innerHTML = '';
    for (const token of tokens) {
      const row = document.createElement('div');
      row.className = 'token-row';
      const known = loadLaunches().find((l) => l.token.toLowerCase() === token);
      let sym = known?.symbol || '';
      if (!sym) {
        sym = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '?');
      }
      row.innerHTML =
        `<span class="sym">${sym}</span>` +
        `<span class="addr"><a href="${pad.site(token)}" target="_blank" rel="noopener">${token}</a></span>`;
      const btn = document.createElement('button');
      btn.className = 'mini';
      btn.textContent = 'CLAIM';
      btn.onclick = () => claimFees(pad, token, btn);
      row.appendChild(btn);
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = `<div class="empty">couldn't load tokens: ${e.shortMessage || e.message}</div>`;
  }
}

async function claimFees(pad, token, btn) {
  const out = $('claimStatus');
  const say = (m, err) => { out.innerHTML = err ? `<span class="err">${m}</span>` : m; };
  if (!account) { say('unlock wallet first', true); return; }
  if (btn) btn.disabled = true;
  try {
    const pub = publicClientFor(pad);
    const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });
    say('claiming fees…');
    const hash = await wallet.writeContract({
      address: pad.locker, abi: LOCKER_ABI, functionName: 'collectFees', args: [token],
    });
    say(`tx sent: ${hash}\nwaiting…`);
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error('tx reverted');
    say(`<span style="color:var(--accent)">FEES CLAIMED ✓</span> <a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx</a>`);
    refreshBalance();
  } catch (e) {
    const msg = e.shortMessage || e.message;
    say(/NoFeesToCollect/i.test(msg) ? 'nothing to claim yet' : msg, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function setStatus(msg, isErr = false) {
  $('status').innerHTML = isErr ? `<span class="err">${msg}</span>` : msg;
}

function renderPads() {
  const box = $('pads');
  box.innerHTML = '';
  for (const pad of PADS) {
    const b = document.createElement('button');
    b.className = 'pad' + (pad === activePad ? ' active' : '');
    b.textContent = pad.enabled ? pad.label : pad.label + ' (soon)';
    b.disabled = !pad.enabled;
    b.onclick = () => { activePad = pad; renderPads(); renderBuyChips(); refreshFeeNote(); };
    box.appendChild(b);
  }
}

async function refreshFeeNote() {
  if (!activePad.enabled) return;
  try {
    const fee = await publicClientFor(activePad).readContract({
      address: activePad.factory, abi: FACTORY_ABI, functionName: 'launchFee',
    });
    $('feeNote').textContent = `launch fee ${formatEther(fee)} ${activePad.nativeSymbol} + dev buy + gas`;
  } catch { $('feeNote').textContent = ''; }
}

async function refreshBalance() {
  if (!account || !activePad.enabled) return;
  try {
    const bal = await publicClientFor(activePad).getBalance({ address: account.address });
    $('walletBal').textContent = (+formatEther(bal)).toFixed(4) + ' ' + activePad.nativeSymbol;
  } catch { /* rpc hiccup, ignore */ }
}

function onUnlocked() {
  $('setupOverlay').classList.add('hidden');
  $('unlockOverlay').classList.add('hidden');
  $('walletDot').classList.add('on');
  $('walletAddr').textContent = account.address.slice(0, 6) + '…' + account.address.slice(-4);
  $('walletChip').title = account.address + ' (click to copy)';
  refreshBalance();
  renderTokenList();
}

async function doSetup() {
  try {
    $('setupErr').textContent = '';
    const pk = normalizeEvmKey($('setupKey').value);
    const pass = $('setupPass').value;
    if (pass.length < 4) throw new Error('password too short');
    const solRaw = $('setupSolKey').value.trim();
    const vault = { evm: await encryptSecret(pass, pk) };
    if (solRaw) {
      solKeyB58 = validateSolKey(solRaw);
      vault.sol = await encryptSecret(pass, solKeyB58);
    }
    saveVault(vault);
    account = privateKeyToAccount(pk);
    $('setupKey').value = ''; $('setupPass').value = ''; $('setupSolKey').value = '';
    onUnlocked();
  } catch (e) { $('setupErr').textContent = e.message; }
}

async function doUnlock() {
  try {
    $('unlockErr').textContent = '';
    const pass = $('unlockPass').value;
    const vault = loadVault();
    const pk = await decryptSecret(pass, vault.evm).catch(() => { throw new Error('wrong password'); });
    if (vault.sol) solKeyB58 = await decryptSecret(pass, vault.sol).catch(() => null);
    account = privateKeyToAccount(pk);
    $('unlockPass').value = '';
    onUnlocked();
  } catch (e) { $('unlockErr').textContent = e.message; }
}

function init() {
  renderPads();
  renderBuyChips();
  refreshFeeNote();

  $('refreshTokens').onclick = renderTokenList;
  $('claimAddrBtn').onclick = () => {
    const addr = $('claimAddr').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      $('claimStatus').innerHTML = '<span class="err">not a valid token address</span>';
      return;
    }
    claimFees(PADS.find((p) => p.enabled && p.locker), addr, $('claimAddrBtn'));
  };

  if (loadVault()) $('unlockOverlay').classList.remove('hidden');
  else $('setupOverlay').classList.remove('hidden');

  $('setupBtn').onclick = doSetup;
  $('unlockBtn').onclick = doUnlock;
  $('unlockPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  $('resetVault').onclick = () => {
    if (confirm('Delete the stored (encrypted) key from this browser?')) {
      localStorage.removeItem(VAULT_KEY);
      location.reload();
    }
  };

  $('walletChip').onclick = () => {
    if (account) navigator.clipboard.writeText(account.address);
  };

  // image: click / drop / paste
  const drop = $('drop'), file = $('file');
  drop.onclick = () => file.click();
  file.onchange = () => setImage(file.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); setImage(e.dataTransfer.files[0]); };
  document.addEventListener('paste', (e) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) { setImage(item.getAsFile()); break; }
    }
  });

  $('launchBtn').onclick = async () => {
    const btn = $('launchBtn');
    btn.disabled = true;
    try { await launch(); }
    catch (e) { setStatus(e.shortMessage || e.message, true); }
    finally { btn.disabled = false; }
  };

  setInterval(refreshBalance, 30000);
}

init();
