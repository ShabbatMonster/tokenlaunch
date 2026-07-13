import {
  createPublicClient, createWalletClient, http, defineChain,
  formatEther, parseEventLogs, getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// fee sweeper — scans EVERY token launched on our factory and claims the ones
// that have accrued trading fees. The protocol share routes to the fee
// recipient (set on the factory) automatically; claiming is permissionless, so
// the unlocked wallet only pays gas.
// ---------------------------------------------------------------------------
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const FACTORY = '0x5251BA272d759B5757983D928AC89B47a64b7d8e';
const START_BLOCK = 8274231n;
const CHAIN = defineChain({
  id: 4663, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const ABI = [
  { type: 'function', name: 'claimFees', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'protocolFeeRecipient', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'protocolFeeBps', inputs: [], outputs: [{ type: 'uint16' }], stateMutability: 'view' },
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
  {
    type: 'event', name: 'FeesClaimed', inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'devWallet', type: 'address', indexed: true },
      { name: 'wethToDev', type: 'uint256', indexed: false },
      { name: 'tokenToDev', type: 'uint256', indexed: false },
      { name: 'wethToProtocol', type: 'uint256', indexed: false },
      { name: 'tokenToProtocol', type: 'uint256', indexed: false },
    ],
  },
];
const ERC20_SYMBOL = [{ type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' }];

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// vault (shared with the launcher: same localStorage key + scheme)
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
// login gate (shared credential with the launcher: gate.cred.v1 / gate.ok.v1)
// ---------------------------------------------------------------------------
const GATE_CRED = 'gate.cred.v1';
const GATE_FLAG = 'gate.ok.v1';
const GATE_ITER = 150000;
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function gateHash(username, password, saltBytes) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(username + '\n' + password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: GATE_ITER, hash: 'SHA-256' }, keyMat, 256);
  return toHex(bits);
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
// wallet unlock (pays gas; fees still route to the recipient)
// ---------------------------------------------------------------------------
let account = null;
let wallet = null;

async function doUnlock() {
  $('unlockErr').textContent = '';
  const vault = loadVault();
  try {
    const pk = await decryptSecret($('unlockPass').value, vault.evm);
    account = privateKeyToAccount(pk);
    wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
    $('unlockPass').value = '';
    $('unlockOverlay').classList.add('hidden');
    $('walletAddr').textContent = account.address.slice(0, 6) + '…' + account.address.slice(-4);
    scan();
  } catch {
    $('unlockErr').textContent = 'wrong password';
  }
}

// ---------------------------------------------------------------------------
// scan + claim
// ---------------------------------------------------------------------------
let recipient = '';
let claimable = [];

async function scan() {
  $('scanStatus').textContent = 'scanning factory for tokens with fees…';
  $('claimBtn').disabled = true;
  try {
    const [recip, bps, logs] = await Promise.all([
      pub.readContract({ address: FACTORY, abi: ABI, functionName: 'protocolFeeRecipient' }),
      pub.readContract({ address: FACTORY, abi: ABI, functionName: 'protocolFeeBps' }),
      pub.getLogs({ address: FACTORY, event: ABI.find((f) => f.name === 'TokenLaunched'), fromBlock: START_BLOCK, toBlock: 'latest' }),
    ]);
    recipient = getAddress(recip);
    $('recipient').innerHTML = `fees route to <a href="${EXPLORER}/address/${recipient}" target="_blank" rel="noopener">${recipient}</a> · protocol share <b>${bps / 100}%</b>`;

    const tokens = [...new Set(logs.map((l) => l.args.token.toLowerCase()))];
    // find which have claimable fees by simulating claimFees on each
    const results = await Promise.all(tokens.map((token) =>
      pub.simulateContract({ address: FACTORY, abi: ABI, functionName: 'claimFees', args: [token], account: account.address })
        .then(() => token).catch(() => null),
    ));
    claimable = results.filter(Boolean);

    const box = $('list');
    if (!tokens.length) { box.innerHTML = '<div class="empty">no tokens launched on this factory yet</div>'; $('scanStatus').textContent = ''; return; }
    box.innerHTML = '';
    for (const token of claimable) {
      const sym = await pub.readContract({ address: token, abi: ERC20_SYMBOL, functionName: 'symbol' }).catch(() => '?');
      const row = document.createElement('div');
      row.className = 'token-row';
      row.innerHTML = `<span class="sym">${sym}</span><span class="addr"><a href="${EXPLORER}/token/${token}" target="_blank" rel="noopener">${token}</a></span><span class="ready">ready</span>`;
      box.appendChild(row);
    }
    $('scanStatus').textContent = `${tokens.length} token${tokens.length > 1 ? 's' : ''} scanned · ${claimable.length} with fees to claim`;
    if (!claimable.length) box.innerHTML = '<div class="empty">nothing to claim right now (fees accrue as tokens trade)</div>';
    $('claimBtn').disabled = claimable.length === 0;
    $('claimBtn').textContent = claimable.length ? `CLAIM ALL (${claimable.length})` : 'NOTHING TO CLAIM';
  } catch (e) {
    $('scanStatus').innerHTML = `<span class="err">scan failed: ${e.shortMessage || e.message}</span>`;
  }
}

async function claimAll() {
  if (!claimable.length) return;
  $('claimBtn').disabled = true;
  const out = $('claimStatus');
  out.innerHTML = `claiming ${claimable.length}…`;
  try {
    let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const hashes = [];
    for (const token of claimable) {
      hashes.push(await wallet.writeContract({ address: FACTORY, abi: ABI, functionName: 'claimFees', args: [token], nonce: nonce++ }));
    }
    const receipts = await Promise.all(hashes.map((h) =>
      pub.waitForTransactionReceipt({ hash: h, confirmations: 1 }).then((r) => r).catch(() => null),
    ));
    let wethProt = 0n, tokProt = 0n, ok = 0;
    for (const r of receipts) {
      if (!r || r.status !== 'success') continue;
      ok++;
      const evs = parseEventLogs({ abi: ABI, eventName: 'FeesClaimed', logs: r.logs });
      for (const ev of evs) { wethProt += ev.args.wethToProtocol; tokProt += ev.args.tokenToProtocol; }
    }
    out.innerHTML =
      `<span class="ok">SWEPT ${ok}/${claimable.length} ✓</span><br>` +
      `to ${recipient.slice(0, 6)}…${recipient.slice(-4)}: <b>${formatEther(wethProt)} WETH</b>` +
      (tokProt > 0n ? ` + tokens` : '');
    scan();
  } catch (e) {
    out.innerHTML = `<span class="err">${e.shortMessage || e.message}</span>`;
    $('claimBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function start() {
  $('appRoot').style.display = '';
  if (!loadVault()) {
    $('noVault').classList.remove('hidden');
    return;
  }
  $('unlockOverlay').classList.remove('hidden');
  $('unlockBtn').onclick = doUnlock;
  $('unlockPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  $('unlockPass').focus();
  $('claimBtn').onclick = claimAll;
  $('rescan').onclick = scan;
}

initGate(start);
