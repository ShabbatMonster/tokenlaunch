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
  // Noxa lockers use collectFees, RobinFun's fork renamed it claimFees —
  // pick via pad.claimFn. Both are permissionless; fees route to devWallet.
  { type: 'function', name: 'collectFees', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimFees', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
];
const TOKEN_LAUNCHED_EVENT = FACTORY_ABI.find((f) => f.type === 'event' && f.name === 'TokenLaunched');
const ERC20_ABI = [
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];

// launch-buy curve: tokens_out = supply * x / (cap + x), x in ETH.
// cap fitted exactly (0.0000% err) against historical launchToken txs on
// Noxa/RobinFun; our factory uses the same starting valuation by design.
const ROBINHOOD_CURVE = { cap: 1.36935, supply: 1e9 };
const OUR_CURVE = { cap: 1.36929 }; // supply comes from the SUPPLY input

// our factory's launchToken takes one extra params field: totalSupply
const OUR_FACTORY_ABI = (() => {
  const base = JSON.parse(JSON.stringify(FACTORY_ABI));
  base.find((f) => f.name === 'launchToken').inputs[0].components.push({ name: 'totalSupply', type: 'uint256' });
  return base;
})();

const PADS = [
  {
    // our own factory — see contracts/LaunchFactory.sol. enabled + factory
    // address get filled in at deployment.
    id: 'ours-robinhood', label: 'Ours · Robinhood', vm: 'evm', enabled: false,
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: '', locker: '',
    claimFn: 'claimFees', startBlock: 0n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://robinhoodchain.blockscout.com/token/${t}`,
    nativeSymbol: 'ETH',
    curve: OUR_CURVE, customSupply: true,
  },
  {
    id: 'robinfun-robinhood', label: 'RobinFun · Robinhood', vm: 'evm', enabled: true,
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: '0x52453b4289a6c3a70bb8b4682bcd3d8731267e28',
    locker: '0x173d8370B4F67535D406F2F46168ec48aa03d26E',
    claimFn: 'claimFees', startBlock: 8147000n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://robinfun.live/token/${t}`,
    nativeSymbol: 'ETH',
    curve: ROBINHOOD_CURVE,
  },
  {
    id: 'noxa-robinhood', label: 'Noxa · Robinhood', vm: 'evm', enabled: true,
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: '0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB',
    locker: '0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85',
    claimFn: 'collectFees', startBlock: 61688n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://fun.noxa.fi/robinhood/token/${t}`,
    nativeSymbol: 'ETH',
    curve: ROBINHOOD_CURVE,
  },
  { id: 'noxa-monad',    label: 'Noxa · Monad',   vm: 'evm', enabled: false, chainId: 143,  rpc: '', factory: '0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85', nativeSymbol: 'MON' },
  { id: 'noxa-megaeth',  label: 'Noxa · MegaETH', vm: 'evm', enabled: false, chainId: 4326, rpc: '', factory: '0xAc303930F2f7A78BBB037f3f4622Bd02f5545B9a', nativeSymbol: 'ETH' },
  { id: 'pump-sol',      label: 'Pump · SOL',     vm: 'sol', enabled: false },
];
let activePad = PADS.find((p) => p.enabled);

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

  const feeRecipientRaw = document.getElementById('feeRecipient').value.trim();
  if (feeRecipientRaw && !/^0x[0-9a-fA-F]{40}$/.test(feeRecipientRaw)) throw new Error('fee recipient is not a valid address');
  const feeRecipient = feeRecipientRaw || account.address;

  const supplyTokens = padSupply(pad);
  if (pad.customSupply && !(supplyTokens >= 1 && supplyTokens <= 1e18)) throw new Error('supply must be between 1 and 1e18 tokens');

  const dists = distroOn ? parseDistributions(supplyTokens) : [];
  if (dists.length && pad.curve && selectedChip >= 0) {
    const x = +buyChips[selectedChip];
    const expected = parseEther(Math.floor((supplyTokens * x) / (pad.curve.cap + x)).toString());
    const total = dists.reduce((s, d) => s + d.amount, 0n);
    if (total > expected) throw new Error('distribution total exceeds what your dev buy gets you — bump the dev buy or lower amounts');
  }
  if (dists.length && selectedChip < 0) throw new Error('distribution needs a dev buy (that is where the tokens come from)');

  setStatus('uploading image to IPFS...');
  const logo = await uploadToIpfs(logoBlob);

  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  setStatus('reading launch fee...');
  const fee = await pub.readContract({ address: pad.factory, abi: FACTORY_ABI, functionName: 'launchFee' });
  const value = fee + devBuy;

  const bal = await pub.getBalance({ address: account.address });
  if (bal < value) throw new Error(`insufficient balance: need ${formatEther(value)}+gas, have ${formatEther(bal)} ${pad.nativeSymbol}`);

  const params = {
    name, symbol, logo, description,
    socials: { telegram: '', twitter, discord: '', website, farcaster: '' },
    devWallet: feeRecipient,
  };
  if (pad.customSupply) params.totalSupply = parseEther(supplyTokens.toLocaleString('fullwide', { useGrouping: false }));
  const abi = pad.customSupply ? OUR_FACTORY_ABI : FACTORY_ABI;
  const args = [
    params,
    0n, // launchConfigId
    0n, // dexId
    keccak256(stringToBytes(`${name}-${symbol}-${Date.now()}`)),
  ];

  setStatus('sending launch tx...');
  let gas;
  try {
    gas = await pub.estimateContractGas({ address: pad.factory, abi, functionName: 'launchToken', args, value, account });
    gas = (gas * 120n) / 100n;
  } catch { /* let the node estimate */ }

  const hash = await wallet.writeContract({ address: pad.factory, abi, functionName: 'launchToken', args, value, gas });
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
  if (token && dists.length) await runDistributions(pad, pub, wallet, token, dists, el);
  refreshBalance();
  renderTokenList();
}

// ---------------------------------------------------------------------------
// dev-buy chips — editable presets, persisted
// ---------------------------------------------------------------------------
const CHIPS_KEY = 'buyChips.v1';
let buyChips = JSON.parse(localStorage.getItem(CHIPS_KEY) || 'null') || ['0.001', '0.005', '0.01', '0.05'];
let selectedChip = -1; // -1 = none

function selectedBuyAmount() {
  return selectedChip >= 0 ? parseEther(buyChips[selectedChip]) : 0n;
}

function padSupply(pad) {
  if (!pad.customSupply) return pad.curve.supply;
  const raw = +($('supply').value.trim().replace(/,/g, '')) || 1e9;
  return raw;
}

function updateBuyPreview() {
  const el = $('buyPreview');
  const curve = activePad.curve;
  if (selectedChip < 0 || !curve) { el.innerHTML = ''; return; }
  const x = +buyChips[selectedChip];
  const supply = padSupply(activePad);
  const tokens = (supply * x) / (curve.cap + x);
  const pct = (x / (curve.cap + x)) * 100;
  el.innerHTML = `you'd get ≈ <b>${Math.round(tokens).toLocaleString('en-US')}</b> tokens · <b>${pct.toFixed(2)}%</b> of supply`;
}

function renderBuyChips() {
  const box = $('buyChips');
  box.innerHTML = '';

  const none = document.createElement('button');
  none.className = 'pad' + (selectedChip === -1 ? ' active' : '');
  none.textContent = 'none';
  none.onclick = () => { selectedChip = -1; renderBuyChips(); };
  box.appendChild(none);

  buyChips.forEach((amt, i) => {
    const b = document.createElement('button');
    b.className = 'pad' + (selectedChip === i ? ' active' : '');
    b.textContent = amt + ' ' + activePad.nativeSymbol;
    b.onclick = () => { selectedChip = i; renderBuyChips(); };
    box.appendChild(b);
  });

  const pencil = document.createElement('button');
  pencil.className = 'pad';
  pencil.title = 'edit amounts';
  pencil.textContent = '✎';
  pencil.onclick = openChipEditor;
  box.appendChild(pencil);
  updateBuyPreview();
}

function chipEditRow(value) {
  const row = document.createElement('div');
  row.className = 'chip-edit-row';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = 'any';
  input.placeholder = '0.01';
  input.value = value;
  const x = document.createElement('button');
  x.className = 'x';
  x.textContent = '×';
  x.title = 'remove';
  x.onclick = () => row.remove();
  row.append(input, x);
  return row;
}

function openChipEditor() {
  const rows = $('chipEditRows');
  rows.innerHTML = '';
  for (const amt of buyChips) rows.appendChild(chipEditRow(amt));
  $('chipsOverlay').classList.remove('hidden');
}

function saveChipEditor() {
  const values = [...$('chipEditRows').querySelectorAll('input')]
    .map((i) => i.value.trim())
    .filter((v) => v && !isNaN(+v) && +v > 0);
  if (values.length) {
    buyChips = values;
    localStorage.setItem(CHIPS_KEY, JSON.stringify(buyChips));
  }
  if (selectedChip >= buyChips.length) selectedChip = -1;
  $('chipsOverlay').classList.add('hidden');
  renderBuyChips();
}

// ---------------------------------------------------------------------------
// distribute supply on launch
// ---------------------------------------------------------------------------
function distRow(addr = '', amt = '') {
  const row = document.createElement('div');
  row.className = 'chip-edit-row';
  const a = document.createElement('input');
  a.type = 'text'; a.placeholder = '0x wallet address'; a.value = addr;
  a.spellcheck = false; a.className = 'dist-addr';
  const m = document.createElement('input');
  m.type = 'text'; m.placeholder = 'tokens or %'; m.value = amt;
  m.style.flex = '0 0 110px'; m.className = 'dist-amt';
  const x = document.createElement('button');
  x.className = 'x'; x.textContent = '×'; x.title = 'remove';
  x.onclick = () => row.remove();
  row.append(a, m, x);
  return row;
}

function parseDistributions(supply) {
  const out = [];
  for (const row of $('distRows').querySelectorAll('.chip-edit-row')) {
    const addr = row.querySelector('.dist-addr').value.trim();
    const raw = row.querySelector('.dist-amt').value.trim().replace(/,/g, '');
    if (!addr && !raw) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`distribution: bad address "${addr.slice(0, 14)}…"`);
    let tokens;
    if (raw.endsWith('%')) {
      const pct = +raw.slice(0, -1);
      if (!(pct > 0 && pct <= 100)) throw new Error(`distribution: bad % "${raw}"`);
      tokens = (supply * pct) / 100;
    } else {
      tokens = +raw;
      if (!(tokens > 0)) throw new Error(`distribution: bad amount "${raw}"`);
    }
    out.push({ addr, amount: parseEther(tokens.toString()) });
  }
  return out;
}

async function runDistributions(pad, pub, wallet, token, dists, statusEl) {
  statusEl.innerHTML += `<br>distributing to ${dists.length} wallet${dists.length > 1 ? 's' : ''}…`;
  // one gas estimate reused for all, txs fired back-to-back with pipelined
  // nonces, receipts awaited together — no per-transfer round trips
  let gas = 150000n;
  try {
    gas = await pub.estimateContractGas({
      address: token, abi: ERC20_ABI, functionName: 'transfer',
      args: [dists[0].addr, dists[0].amount], account,
    });
    gas = (gas * 130n) / 100n;
  } catch { /* fall back to flat limit */ }

  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const sent = [];
  for (const d of dists) {
    const tag = `${d.addr.slice(0, 6)}…${d.addr.slice(-4)}`;
    try {
      const hash = await wallet.writeContract({
        address: token, abi: ERC20_ABI, functionName: 'transfer',
        args: [d.addr, d.amount], gas, nonce: nonce++,
      });
      sent.push({ tag, hash });
    } catch (e) {
      statusEl.innerHTML += `<br>${tag} <span class="err">failed to send (${e.shortMessage || e.message})</span>`;
    }
  }

  const results = await Promise.all(sent.map((s) =>
    pub.waitForTransactionReceipt({ hash: s.hash, confirmations: 1 })
      .then((r) => ({ ...s, ok: r.status === 'success' }))
      .catch(() => ({ ...s, ok: false })),
  ));
  for (const r of results) {
    statusEl.innerHTML += `<br>${r.tag} ${r.ok ? '✓' : '<span class="err">reverted</span>'}`;
  }
  statusEl.innerHTML += `<br>distribution done: ${results.filter((r) => r.ok).length}/${dists.length} sent`;
}

// saved wallet sets for distribution
const DIST_SETS_KEY = 'distSets.v1';
const DIST_LAST_KEY = 'distSets.last';
const loadDistSets = () => JSON.parse(localStorage.getItem(DIST_SETS_KEY) || '{}');
let distroOn = false;
let activeDistSet = localStorage.getItem(DIST_LAST_KEY) || '';

function currentDistRows() {
  const rows = [];
  for (const row of $('distRows').querySelectorAll('.chip-edit-row')) {
    const addr = row.querySelector('.dist-addr').value.trim();
    const amt = row.querySelector('.dist-amt').value.trim();
    if (addr || amt) rows.push({ addr, amt });
  }
  return rows;
}

function setDistRows(rows) {
  const box = $('distRows');
  box.innerHTML = '';
  for (const r of rows) box.appendChild(distRow(r.addr, r.amt));
  if (!rows.length) box.appendChild(distRow());
}

function renderDistSetChips() {
  const box = $('distSetChips');
  box.innerHTML = '';
  const sets = loadDistSets();
  for (const name of Object.keys(sets)) {
    const b = document.createElement('button');
    b.className = 'pad' + (name === activeDistSet ? ' active' : '');
    b.textContent = name;
    b.onclick = () => {
      activeDistSet = name;
      localStorage.setItem(DIST_LAST_KEY, name);
      setDistRows(sets[name]);
      renderDistSetChips();
    };
    box.appendChild(b);
  }
}

function toggleDistro() {
  distroOn = !distroOn;
  const t = $('distToggle');
  t.textContent = distroOn ? 'on' : 'off';
  t.classList.toggle('active', distroOn);
  $('distPanel').classList.toggle('hidden', !distroOn);
  if (distroOn) {
    // pre-load the last-used (or only) saved set
    const sets = loadDistSets();
    const names = Object.keys(sets);
    if (!currentDistRows().length && names.length) {
      if (!sets[activeDistSet]) activeDistSet = names[0];
      setDistRows(sets[activeDistSet]);
    }
    if (!$('distRows').children.length) $('distRows').appendChild(distRow());
    renderDistSetChips();
  }
}

function saveDistSet() {
  const rows = currentDistRows();
  if (!rows.length) { setStatus('nothing to save — add wallets first', true); return; }
  const name = prompt('name this wallet set:', activeDistSet || 'set 1');
  if (!name) return;
  const sets = loadDistSets();
  sets[name] = rows;
  localStorage.setItem(DIST_SETS_KEY, JSON.stringify(sets));
  activeDistSet = name;
  localStorage.setItem(DIST_LAST_KEY, name);
  renderDistSetChips();
}

function deleteDistSet() {
  if (!activeDistSet) return;
  const sets = loadDistSets();
  delete sets[activeDistSet];
  localStorage.setItem(DIST_SETS_KEY, JSON.stringify(sets));
  activeDistSet = Object.keys(sets)[0] || '';
  renderDistSetChips();
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
  // TokenLaunched has deployer indexed — one filtered getLogs finds all ours
  const pub = publicClientFor(pad);
  const logs = await pub.getLogs({
    address: pad.factory, event: TOKEN_LAUNCHED_EVENT,
    args: { deployer: account.address },
    fromBlock: pad.startBlock, toBlock: 'latest',
  });
  return logs.map((l) => l.args.token);
}

const claimPad = () => (activePad.enabled && activePad.locker ? activePad : PADS.find((p) => p.enabled && p.locker));

async function getMyTokens(pad) {
  const onchain = await discoverMyTokens(pad);
  const local = loadLaunches().filter((l) => l.pad === pad.id).map((l) => l.token);
  return [...new Set([...onchain, ...local].map((t) => t.toLowerCase()))];
}

async function renderTokenList() {
  const box = $('tokenList');
  if (!account) { box.innerHTML = '<div class="empty">unlock wallet to load your launches</div>'; return; }
  const pad = claimPad();
  box.innerHTML = '<div class="empty">loading…</div>';
  try {
    const pub = publicClientFor(pad);
    const tokens = await getMyTokens(pad);
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

async function claimAllFees(btn) {
  const out = $('claimStatus');
  const say = (m, err) => { out.innerHTML = err ? `<span class="err">${m}</span>` : m; };
  if (!account) { say('unlock wallet first', true); return; }
  const pad = claimPad();
  btn.disabled = true;
  try {
    const pub = publicClientFor(pad);
    const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });
    say('checking which tokens have fees…');
    const tokens = await getMyTokens(pad);
    if (!tokens.length) { say('no launches from this wallet yet', true); return; }

    // simulate collectFees for every token in parallel — only claim the ones
    // that wouldn't revert (NoFeesToCollect etc.)
    const claimable = (await Promise.all(tokens.map((token) =>
      pub.simulateContract({
        address: pad.locker, abi: LOCKER_ABI, functionName: pad.claimFn,
        args: [token], account,
      }).then(() => token).catch(() => null),
    ))).filter(Boolean);

    if (!claimable.length) { say(`nothing to claim across ${tokens.length} token${tokens.length > 1 ? 's' : ''}`); return; }
    say(`claiming ${claimable.length} of ${tokens.length}…`);

    let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const hashes = [];
    for (const token of claimable) {
      hashes.push(await wallet.writeContract({
        address: pad.locker, abi: LOCKER_ABI, functionName: pad.claimFn,
        args: [token], nonce: nonce++,
      }));
    }
    const results = await Promise.all(hashes.map((hash) =>
      pub.waitForTransactionReceipt({ hash, confirmations: 1 })
        .then((r) => r.status === 'success').catch(() => false),
    ));
    const ok = results.filter(Boolean).length;
    say(`<span style="color:var(--accent)">CLAIMED ${ok}/${claimable.length} ✓</span> (${tokens.length - claimable.length} had nothing)`);
    refreshBalance();
  } catch (e) {
    say(e.shortMessage || e.message, true);
  } finally {
    btn.disabled = false;
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
      address: pad.locker, abi: LOCKER_ABI, functionName: pad.claimFn, args: [token],
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
    b.onclick = () => {
      activePad = pad;
      $('supplyRow').classList.toggle('hidden', !pad.customSupply);
      renderPads(); renderBuyChips(); refreshFeeNote(); refreshBalance(); renderTokenList();
    };
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
  $('feeRecipient').placeholder = account.address + ' (default)';
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
  $('supplyRow').classList.toggle('hidden', !activePad.customSupply);
  $('supply').addEventListener('input', updateBuyPreview);

  $('distToggle').onclick = toggleDistro;
  $('distAdd').onclick = () => $('distRows').appendChild(distRow());
  $('distSave').onclick = saveDistSet;
  $('distDelete').onclick = deleteDistSet;

  $('chipAdd').onclick = () => $('chipEditRows').appendChild(chipEditRow(''));
  $('chipSave').onclick = saveChipEditor;
  $('chipCancel').onclick = () => $('chipsOverlay').classList.add('hidden');

  $('refreshTokens').onclick = renderTokenList;
  $('claimAll').onclick = () => claimAllFees($('claimAll'));
  $('claimAddrBtn').onclick = () => {
    const addr = $('claimAddr').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      $('claimStatus').innerHTML = '<span class="err">not a valid token address</span>';
      return;
    }
    claimFees(claimPad(), addr, $('claimAddrBtn'));
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
