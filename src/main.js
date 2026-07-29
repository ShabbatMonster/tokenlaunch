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

// ---------------------------------------------------------------------------
// Pons v2 (docs.ponsfamily.com/v2) — different family from Noxa. Launches go
// through launchToken(params, launchConfigId, pairToken) with an economics pin
// read from previewLaunchEconomics() to stop config front-running. No initial
// buy in the launch tx — dev buys are a separate buy() on the returned curve.
// Fees accrue per-recipient in the Fee Escrow: claim() native, claimToken(erc20).
// ABI transcribed from the docs; verify against the published ABI on deploy.
// ---------------------------------------------------------------------------
const PONS_FACTORY_ABI = [
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
              { name: 'twitter', type: 'string' },
              { name: 'telegram', type: 'string' },
              { name: 'discord', type: 'string' },
              { name: 'website', type: 'string' },
              { name: 'farcaster', type: 'string' },
            ],
          },
          { name: 'creatorFeeRecipient', type: 'address' },
          { name: 'creatorTaxBps', type: 'uint16' },
          { name: 'buybackEnabled', type: 'bool' },
          { name: 'expectedEconomics', type: 'bytes32' },
        ],
      },
      { name: 'launchConfigId', type: 'uint256' },
      { name: 'pairToken', type: 'address' },
    ],
    outputs: [{ name: 'token', type: 'address' }, { name: 'curve', type: 'address' }],
  },
  { type: 'function', name: 'launchFee', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'launchEnabled', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'maxCreatorTaxBps', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function', name: 'previewLaunchEconomics', stateMutability: 'view',
    inputs: [{ name: 'configId', type: 'uint256' }, { name: 'pairToken', type: 'address' }],
    outputs: [{ type: 'bytes32' }],
  },
];

const PONS_CURVE_ABI = [
  {
    type: 'function', name: 'buy', stateMutability: 'payable',
    inputs: [
      { name: 'quoteIn', type: 'uint256' },
      { name: 'minTokensOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'tokensOut', type: 'uint256' }],
  },
  {
    type: 'function', name: 'sell', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokensIn', type: 'uint256' },
      { name: 'minQuoteOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'quoteOut', type: 'uint256' }],
  },
];

const PONS_ESCROW_ABI = [
  { type: 'function', name: 'claim', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimToken', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
];

// ---------------------------------------------------------------------------
// Rialto (varo.rialto.xyz) — chain 4663, same chain as our other pads, but a
// PERMISSIONED launchpad: launches are Rialto-signed intents, not open factory
// calls. Flow reverse-engineered from the live web app bundle + a live launch:
//
//   1. SIWE-authenticate the wallet  POST /auth/challenge {wallet}
//                                     -> sign message, POST /auth/verify -> JWT
//   2. Upload the image             POST /assets/images (multipart) -> { url }
//   3. Ask Rialto to build+sign the intent
//                          POST /intents/create-token {name,symbol,image_uri,
//                          quote_token,fee_recipients,request_id}
//      -> { params, authorization, signature, transaction }. The pool economics
//         (tick, sqrtPrice, supply) are computed server-side from the chosen
//         quote token and baked into the signed intent; authorized by Rialto's
//         backend signer and valid ~6 min.
//   4. Submit the returned transaction (to = intent executor) from the wallet.
//      On-chain: executeLaunch(params, authorization, signature) -> (token, locker).
//
// A launch CANNOT be produced without Rialto co-signing — unlike the
// permissionless Noxa/Pons factories.
// ---------------------------------------------------------------------------
const RIALTO_API = 'https://varo.rialto.xyz/api/v1';
const TRANSFER_TOPIC = keccak256(stringToBytes('Transfer(address,address,uint256)'));

// executeLaunch(params, authorization, bytes signature) -> (token, locker).
// Kept for pre-send eth_call (to read the launched token) and reference; the
// actual submission relays Rialto's own pre-built calldata verbatim.
const RIALTO_EXECUTOR_ABI = [
  {
    type: 'function', name: 'executeLaunch', stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params', type: 'tuple', components: [
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
          { name: 'imageURI', type: 'string' },
          { name: 'creator', type: 'address' },
          { name: 'saltNonce', type: 'uint32' },
          { name: 'feeWallets', type: 'address[]' },     // creator-fee split targets
          { name: 'feeSharesBps', type: 'uint16[]' },     // bps, sums to 10000
          { name: 'supply', type: 'uint256' },
          { name: 'initialTick', type: 'int24' },
          { name: 'initialSqrtPriceX96', type: 'uint160' },
          { name: 'protocolFeeBps', type: 'uint16' },
          { name: 'quoteAsset', type: 'address' },        // WETH / USDG / NVDA / SPCX …
        ],
      },
      {
        name: 'authorization', type: 'tuple', components: [
          { name: 'authorizer', type: 'address' },
          { name: 'validAfter', type: 'uint48' },
          { name: 'validBefore', type: 'uint48' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'token', type: 'address' }, { name: 'locker', type: 'address' }],
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

// Solana / Meteora DBC config (chain logic lives in the lazy-loaded solana.js).
// Defined before PADS because the meteora pad references SOL_RPC.
const SOL_RPC = 'https://mainnet.helius-rpc.com/?api-key=3fb08d49-71d7-492b-84f1-9ff0e3eb95ea';
const SOL_QUOTES = {
  SOL:  { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL',  decimals: 9, defaultThreshold: 85 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, defaultThreshold: 17000 },
};
const SOL_FEE_WALLET = 'H5GAYEieNUyTmHFD4foJEKSpkggEDHBV9ffGebrD6wAW';
const SOL_CUSTOM_DEFAULT = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump'; // prefill for custom quote
const SOL_CUSTOM_THRESHOLD = 1000000; // default migration threshold for custom quotes

const PADS = [
  {
    // our own factory — contracts/LaunchFactory.sol, deployed 2026-07-12.
    // factory is also the locker (claimFees lives on it). 100% fees ->
    // protocol wallet 0xbE8a…04dA, owner = deployer, 0 launch fee, any supply.
    // NOTE: plain-token version (no max-wallet cap). The 2% cap build (0x5251)
    // is retired — reverted per request; plain tokens read cleaner on scanners.
    id: 'ours-robinhood', label: 'Ours · Robinhood', vm: 'evm', enabled: true,
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: '0x159331ec96486EC926403e504E6FCf217d6008AB',
    locker: '0x159331ec96486EC926403e504E6FCf217d6008AB',
    claimFn: 'claimFees', startBlock: 8242608n,
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
  {
    // Pons v2 — configured per docs.ponsfamily.com/v2 (2026-07-26). Addresses
    // are NOT published yet ("v2 addresses are not published yet … audits in
    // progress") and the docs say to treat v2 as unaudited until reports land.
    // To go live: fill factory + escrow (locker = escrow so claimPad works),
    // confirm chainId/rpc (docs imply Ethereum + Uniswap v4), set startBlock,
    // diff PONS_FACTORY_ABI against the published ABI, then enabled: true.
    // shown but disabled ("soon") — addresses unpublished / audits in progress
    id: 'pons-v2', label: 'Pons v2', vm: 'evm', enabled: false, family: 'pons-v2',
    chainId: 1, rpc: '',
    factory: '', escrow: '', locker: '',
    launchConfigId: 0n,                                     // from getLaunchConfig / launchConfigCount
    pairToken: '0x0000000000000000000000000000000000000000', // zero = native ETH pair
    creatorTaxBps: 0,                                        // optional extra tax, capped by maxCreatorTaxBps()
    buybackEnabled: false,
    startBlock: 0n,
    explorer: 'https://etherscan.io',
    site: (t) => `https://etherscan.io/token/${t}`,
    nativeSymbol: 'ETH',
    curve: null, // bonding-curve params unpublished — no dev-buy preview yet
  },
  {
    // Rialto · Robinhood — pair your token against a stock/ETF (NVDA, SPCX, …)
    // or WETH/USDG. Addresses from GET https://varo.rialto.xyz/api/v1/config.
    // Permissioned: launches are Rialto-signed intents — see launchRialto().
    id: 'rialto-robinhood', label: 'Rialto · Stocks', vm: 'evm', enabled: true, family: 'rialto',
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    executor: '0x1FaE6f162355cF77Bf7f23cb919130962dAd4Ecb',   // intent executor (tx target)
    launchpad: '0x851153fe84239C2dC55fa191aC2f099e20a6d0b8',
    configUrl: `${RIALTO_API}/config`,
    startBlock: 20800000n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://varo.rialto.xyz/launches/${t}`,
    nativeSymbol: 'ETH',
    curve: null,                 // economics are server-computed per quote token
    quoteToken: null,            // chosen from the pair-token dropdown (config.quotes)
  },
  { id: 'noxa-monad',    label: 'Noxa · Monad',   vm: 'evm', enabled: false, chainId: 143,  rpc: '', factory: '0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85', nativeSymbol: 'MON' },
  { id: 'noxa-megaeth',  label: 'Noxa · MegaETH', vm: 'evm', enabled: false, chainId: 4326, rpc: '', factory: '0xAc303930F2f7A78BBB037f3f4622Bd02f5545B9a', nativeSymbol: 'ETH' },
  {
    // Meteora Dynamic Bonding Curve on Solana mainnet. Permissionless: we build
    // a config (binds the quote mint) + create the pool client-side and sign
    // with the stored SOL key. Quote can be SOL, USDC, or any SPL/Token-2022
    // mint (e.g. the pump token). See src/solana.js (lazy-loaded bundle).
    id: 'meteora-sol', label: 'Meteora · SOL', vm: 'sol', enabled: true, family: 'meteora',
    rpc: SOL_RPC,
    explorer: 'https://solscan.io',
    site: (t) => `https://solscan.io/token/${t}`,
    nativeSymbol: 'SOL',
    quoteSel: 'SOL',           // SOL | USDC | CUSTOM (from the dropdown)
    quoteMint: null,           // resolved from quoteSel / custom input
  },
];
let activePad = PADS.find((p) => p.id === 'ours-robinhood') || PADS.find((p) => p.enabled);

const IPFS_ADD = 'https://api.thegraph.com/ipfs/api/v0/add';
const IPFS_GW = (hash) => `https://ipfs.io/ipfs/${hash}`;
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

// session unlock cache — after the first password unlock, the decrypted keys
// live in sessionStorage so navigating between pages / reloading doesn't
// re-prompt. Cleared when the tab closes (like the login gate). Shared across
// the launcher, trade, and fees pages via the same key.
const SESSION_KEYS = 'session.keys.v1';
const loadSession = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEYS) || 'null'); } catch { return null; } };
const saveSession = (obj) => sessionStorage.setItem(SESSION_KEYS, JSON.stringify({ ...(loadSession() || {}), ...obj }));

// unlocked session state (memory only)
let account = null;        // viem account
let evmPk = null;          // raw decrypted EVM private key (for the session cache)
let solKeyB58 = null;      // decrypted SOL key (base58 / json array)

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
// full base58 decode/encode — enough to derive the SOL pubkey (last 32 bytes of
// the 64-byte secret) and show the address without loading the heavy solana bundle
function base58Decode(s) {
  const bytes = [0];
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('bad base58 char');
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
function solSecretBytes(secret) {
  const s = secret.trim();
  const b = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : base58Decode(s);
  if (b.length !== 64) throw new Error('SOL key must be 64 bytes');
  return b;
}
const solPubkeyFromSecret = (secret) => base58Encode(solSecretBytes(secret).slice(32, 64));

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

  // Solana / Meteora path — separate stack, doesn't touch the EVM branch below
  if (pad.vm === 'sol') {
    await launchSol(pad, { name, symbol, description, twitter, website });
    return;
  }

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

  // Rialto hosts + hashes its own image, so it skips the IPFS upload entirely
  if (pad.family === 'rialto') {
    const { token, pub, wallet } = await launchRialto(pad, {
      name, symbol, description, twitter, website, feeRecipient,
    });
    if (token && dists.length) await runDistributions(pad, pub, wallet, token, dists, $('status'));
    refreshBalance();
    renderTokenList();
    return;
  }

  setStatus('uploading image to IPFS...');
  const logo = await uploadToIpfs(logoBlob);

  if (pad.family === 'pons-v2') {
    const { token, pub, wallet } = await launchPonsV2(pad, {
      name, symbol, logo, description, twitter, website, feeRecipient, devBuy,
    });
    if (token && dists.length) await runDistributions(pad, pub, wallet, token, dists, $('status'));
    refreshBalance();
    renderTokenList();
    return;
  }

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
// Rialto
// ---------------------------------------------------------------------------
let rialtoConfig = null; // cached GET /config (quote tokens, executor, fees)

async function loadRialtoConfig(pad) {
  if (rialtoConfig) return rialtoConfig;
  const r = await fetch(pad.configUrl, { headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`Rialto config unavailable (${r.status})`);
  rialtoConfig = await r.json();
  return rialtoConfig;
}

// SIWE: challenge -> sign with the in-app key -> verify -> bearer JWT. Fits the
// app's model — the key signs the login message client-side, nothing leaves the
// device but the signature.
async function rialtoAuth(pad) {
  const base = RIALTO_API;
  const ch = await (await fetch(`${base}/auth/challenge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: account.address }),
  })).json();
  if (!ch.message || !ch.nonce) throw new Error('Rialto auth challenge failed');
  const signature = await account.signMessage({ message: ch.message });
  const vr = await fetch(`${base}/auth/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: account.address, signature, nonce: ch.nonce }),
  });
  if (!vr.ok) throw new Error(`Rialto auth failed (${vr.status})`);
  const { token } = await vr.json();
  if (!token) throw new Error('Rialto auth returned no token');
  return token;
}

// Upload the logo to Rialto's asset store (they host + hash it); returns the URL
// used as image_uri in the intent request.
async function rialtoUploadImage(jwt, blob) {
  const fd = new FormData();
  fd.append('image', new File([blob], 'logo.' + (blob.type === 'image/gif' ? 'gif' : 'png'), { type: blob.type }));
  const r = await fetch(`${RIALTO_API}/assets/images`, {
    method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: fd,
  });
  if (!r.ok) throw new Error(`Rialto image upload failed (${r.status})`);
  const { url } = await r.json();
  if (!url) throw new Error('Rialto image upload returned no url');
  return url;
}

// Ask Rialto to build + sign the launch intent. Returns
// { params, authorization, signature, transaction } where transaction is the
// ready-to-send executeLaunch calldata (to = intent executor, value = 0).
async function rialtoCreateLaunch(jwt, body) {
  const r = await fetch(`${RIALTO_API}/intents/create-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `Rialto launch build failed (${r.status})`;
    try { const e = await r.json(); if (e.message) msg = e.message; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return r.json();
}

async function launchRialto(pad, inp) {
  if (!pad.quoteToken) throw new Error('pick a token to pair against first');
  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  setStatus('authenticating with Rialto (signing login message)...');
  const jwt = await rialtoAuth(pad);

  setStatus('uploading image to Rialto...');
  const imageUrl = await rialtoUploadImage(jwt, logoBlob);

  setStatus('requesting signed launch intent from Rialto...');
  const built = await rialtoCreateLaunch(jwt, {
    request_id: crypto.randomUUID(),
    name: inp.name,
    symbol: inp.symbol,
    image_uri: imageUrl,
    quote_token: pad.quoteToken,
    fee_recipients: [{ wallet: inp.feeRecipient, share_bps: 10000 }],
  });
  const tx = built.transaction;
  if (!tx?.to || !tx?.data) throw new Error('Rialto returned no launch transaction');
  if (tx.to.toLowerCase() !== pad.executor.toLowerCase()) {
    throw new Error('Rialto launch target is not the expected intent executor');
  }

  // read the token/locker the launch will mint via a pre-send eth_call
  let token;
  try {
    const { data } = await pub.call({ to: tx.to, data: tx.data, account });
    if (data && data.length >= 66) token = '0x' + data.slice(26, 66);
  } catch { /* fall back to log parsing after the receipt */ }

  setStatus('sending launch tx...');
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
  setStatus(`tx sent: ${hash}\nwaiting for confirmation...`);
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('tx reverted: ' + hash);

  // if the pre-send call didn't yield the token, recover it from the mint log
  // (the ERC-20 Transfer from the zero address in this receipt)
  if (!token) {
    const ZERO_TOPIC = '0x' + '0'.repeat(64);
    const mint = receipt.logs.find((l) =>
      l.topics[0] === TRANSFER_TOPIC && l.topics[1] === ZERO_TOPIC);
    token = mint?.address;
  }
  if (token) rememberLaunch(pad, token, inp.symbol);

  const el = $('status');
  el.innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${token || ''}<br>` +
    (token && pad.site ? `<a href="${pad.site(token)}" target="_blank" rel="noopener">view on Rialto</a> · ` : '') +
    `<a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx on explorer</a>`;
  return { token, pub, wallet };
}

// populate the pair-against dropdown from Rialto's enabled quote tokens
async function refreshRialtoQuotes(pad) {
  const sel = $('quoteSelect');
  const hint = $('quoteHint');
  sel.innerHTML = '<option>loading…</option>';
  hint.textContent = '';
  try {
    const cfg = await loadRialtoConfig(pad);
    const quotes = (cfg.quotes || []).filter((q) => q.enabled);
    sel.innerHTML = '';
    for (const q of quotes) {
      const o = document.createElement('option');
      o.value = q.address;
      o.textContent = q.symbol + (q.usd_price ? ` (~$${(+q.usd_price).toLocaleString()})` : '');
      sel.appendChild(o);
    }
    // default to the first stock-like quote if present, else config default
    const def = cfg.default_quote || (quotes[0] && quotes[0].address);
    sel.value = pad.quoteToken || def || '';
    pad.quoteToken = sel.value;
    updateRialtoHint(pad);
  } catch (e) {
    sel.innerHTML = '<option>unavailable</option>';
    hint.textContent = e.message;
  }
}

function updateRialtoHint(pad) {
  const cfg = rialtoConfig;
  const q = cfg && (cfg.quotes || []).find((x) => x.address === pad.quoteToken);
  if (!q) { $('quoteHint').textContent = ''; return; }
  const fdv = q.target_initial_fdv_quote_units
    ? (Number(q.target_initial_fdv_quote_units) / 10 ** q.decimals) : null;
  $('quoteHint').textContent =
    `pooled with ${q.symbol}` + (fdv ? ` · starting FDV ≈ ${fdv.toLocaleString()} ${q.symbol}` : '');
}

// ---------------------------------------------------------------------------
// Solana / Meteora DBC (chain logic lazy-loaded from ./solana.js)
// ---------------------------------------------------------------------------
const isSolAddress = (s) => { try { return base58Decode(s).length === 32; } catch { return false; } };

async function uploadJsonToIpfs(obj) {
  const fd = new FormData();
  fd.append('file', new File([JSON.stringify(obj)], 'metadata.json', { type: 'application/json' }));
  const r = await fetch(IPFS_ADD, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('IPFS metadata upload failed (' + r.status + ')');
  const { Hash } = await r.json();
  if (!Hash) throw new Error('IPFS metadata upload returned no hash');
  return Hash;
}

// resolve the selected quote mint (SOL / USDC / custom) to its address
function solQuoteMint(pad) {
  const sel = pad.quoteSel;
  if (sel === 'CUSTOM') {
    const m = $('solCustomMint').value.trim();
    if (!isSolAddress(m)) throw new Error('enter a valid custom quote mint address');
    return m;
  }
  return SOL_QUOTES[sel].mint;
}

function solParamsFromUI(pad) {
  const num = (id, name) => {
    const v = +($(id).value.trim().replace(/,/g, ''));
    if (!(v > 0)) throw new Error(`${name} must be a positive number`);
    return v;
  };
  const feeWallet = $('solFeeWallet').value.trim();
  if (!isSolAddress(feeWallet)) throw new Error('fee wallet is not a valid Solana address');
  const migRaw = $('solMigThreshold').value.trim().replace(/,/g, '');
  let migrationThreshold = +migRaw;
  if (!migRaw) {
    const def = SOL_QUOTES[pad.quoteSel]?.defaultThreshold;
    if (!def) throw new Error('set a migration threshold (in quote tokens)');
    migrationThreshold = def;
  }
  if (!(migrationThreshold > 0)) throw new Error('migration threshold must be positive');
  return {
    totalSupply: num('solSupply', 'total supply'),
    baseDecimals: 6,
    feeBps: num('solFeeBps', 'fee bps'),
    pctSupplyOnMigration: num('solMigPct', '% on migration'),
    migrationThreshold,
    feeClaimer: feeWallet,
  };
}

async function launchSol(pad, inp) {
  if (!solKeyB58) throw new Error('no SOL key stored — re-import your wallet with a SOL private key');
  const quoteMint = solQuoteMint(pad);
  const params = solParamsFromUI(pad);

  setStatus('uploading image + metadata to IPFS...');
  const imgHash = (await uploadToIpfs(logoBlob)).replace('ipfs://', '');
  const metaHash = await uploadJsonToIpfs({
    name: inp.name, symbol: inp.symbol, description: inp.description,
    image: IPFS_GW(imgHash),
    ...(inp.twitter || inp.website ? { extensions: { twitter: inp.twitter, website: inp.website } } : {}),
  });
  const uri = IPFS_GW(metaHash);

  setStatus('loading Solana module...');
  const { launchMeteora } = await import('./solana.js');

  const res = await launchMeteora({
    rpcUrl: pad.rpc, secretKey: solKeyB58, quoteMint,
    name: inp.name, symbol: inp.symbol, uri, params,
    onStatus: (m) => setStatus(m),
  });

  rememberLaunch(pad, res.mint, inp.symbol);
  $('status').innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${res.mint}<br>` +
    `<a href="${pad.site(res.mint)}" target="_blank" rel="noopener">token on solscan</a> · ` +
    `<a href="${pad.explorer}/tx/${res.poolSig}" target="_blank" rel="noopener">pool tx</a>`;
  refreshBalance();
  renderTokenList();
}

// pons v2 launch: pre-launch checks -> economics pin -> launchToken -> dev buy
// on the returned curve (v2 has no initial-buy param in the launch tx itself)
async function launchPonsV2(pad, inp) {
  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  setStatus('running pre-launch checks...');
  const [enabled, fee, maxTax] = await Promise.all([
    pub.readContract({ address: pad.factory, abi: PONS_FACTORY_ABI, functionName: 'launchEnabled' }),
    pub.readContract({ address: pad.factory, abi: PONS_FACTORY_ABI, functionName: 'launchFee' }),
    pub.readContract({ address: pad.factory, abi: PONS_FACTORY_ABI, functionName: 'maxCreatorTaxBps' }),
  ]);
  if (!enabled) throw new Error('pons v2 launches are currently paused');
  const creatorTaxBps = Math.min(pad.creatorTaxBps || 0, Number(maxTax));

  // economics pin — makes the tx revert if the protocol changes fee economics
  // between this read and inclusion (the docs' front-running protection)
  const expectedEconomics = await pub.readContract({
    address: pad.factory, abi: PONS_FACTORY_ABI,
    functionName: 'previewLaunchEconomics', args: [pad.launchConfigId, pad.pairToken],
  });

  const value = fee + inp.devBuy;
  const bal = await pub.getBalance({ address: account.address });
  if (bal < value) throw new Error(`insufficient balance: need ${formatEther(value)}+gas, have ${formatEther(bal)} ${pad.nativeSymbol}`);

  const params = {
    name: inp.name, symbol: inp.symbol, logo: inp.logo, description: inp.description,
    socials: { twitter: inp.twitter, telegram: '', discord: '', website: inp.website, farcaster: '' },
    creatorFeeRecipient: inp.feeRecipient,
    creatorTaxBps,
    buybackEnabled: !!pad.buybackEnabled,
    expectedEconomics,
  };
  const args = [params, pad.launchConfigId, pad.pairToken];

  // simulate first: surfaces reverts with a readable message and gives us the
  // (token, curve) return values, which writeContract alone can't
  setStatus('simulating launch...');
  const { result: [token, curve] } = await pub.simulateContract({
    address: pad.factory, abi: PONS_FACTORY_ABI, functionName: 'launchToken',
    args, value: fee, account,
  });

  setStatus('sending launch tx...');
  const hash = await wallet.writeContract({
    address: pad.factory, abi: PONS_FACTORY_ABI, functionName: 'launchToken', args, value: fee,
  });
  setStatus(`tx sent: ${hash}\nwaiting for confirmation...`);
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('tx reverted: ' + hash);
  rememberLaunch(pad, token, inp.symbol);

  let buyNote = '';
  if (inp.devBuy > 0n) {
    setStatus('launched — sending dev buy on the curve...');
    try {
      // native pair: quoteIn must equal sent value; minTokensOut 0 is safe as
      // the first buy on a fresh curve
      const buyHash = await wallet.writeContract({
        address: curve, abi: PONS_CURVE_ABI, functionName: 'buy',
        args: [inp.devBuy, 0n, account.address], value: inp.devBuy,
      });
      const buyRcpt = await pub.waitForTransactionReceipt({ hash: buyHash, confirmations: 1 });
      buyNote = buyRcpt.status === 'success'
        ? ' · dev buy ✓'
        : ' · <span class="err">dev buy reverted</span>';
    } catch (e) {
      buyNote = ` · <span class="err">dev buy failed (${e.shortMessage || e.message})</span>`;
    }
  }

  const el = $('status');
  el.innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${token}${buyNote}<br>` +
    `<a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx on explorer</a>`;
  return { token, curve, pub, wallet };
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
  // pads without published curve params (pons v2) fall back to 1e9 so
  // %-based distributions still resolve to something sane
  if (!pad.customSupply) return pad.curve?.supply ?? 1e9;
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
  // pons v2's TokenLaunched field layout isn't published yet — rely on the
  // local launch memory until the ABI lands and this can filter logs too
  if (pad.family === 'pons-v2') return [];
  // Rialto has no per-token locker in this app; discovery is via its API, and
  // fee claiming isn't wired — fall back to local memory only
  if (pad.family === 'rialto') return [];
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
  // pons v2 escrow aggregates all fees per recipient — one claim() covers
  // every launch, no per-token loop needed
  if (pad.family === 'pons-v2') { await claimFees(pad, null, btn); return; }
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
    // pons v2: native fees via escrow.claim(); pass a token address to claim
    // ERC-20 balances (custom pairs / released buyback vests) instead
    const hash = pad.family === 'pons-v2'
      ? await wallet.writeContract(token
        ? { address: pad.escrow, abi: PONS_ESCROW_ABI, functionName: 'claimToken', args: [token] }
        : { address: pad.escrow, abi: PONS_ESCROW_ABI, functionName: 'claim' })
      : await wallet.writeContract({
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
      applyPadUI(pad);
      renderPads(); renderBuyChips(); refreshFeeNote(); refreshBalance(); renderTokenList();
    };
    box.appendChild(b);
  }
}

// show/hide the per-pad input sections + wallet for the active pad
function applyPadUI(pad) {
  const sol = pad.vm === 'sol';
  $('supplyRow').classList.toggle('hidden', !pad.customSupply || sol);
  $('quoteRow').classList.toggle('hidden', pad.family !== 'rialto');
  $('solRow').classList.toggle('hidden', !sol);
  $('devBuyBlock').classList.toggle('hidden', sol); // dev buy / distro are EVM-only
  $('distroBlock').classList.toggle('hidden', sol);
  if (pad.family === 'rialto') refreshRialtoQuotes(pad);
  if (sol) updateSolQuoteUI(pad);
  updateWalletChip(pad);
}

// Solana quote dropdown -> custom-mint field + default migration threshold
function updateSolQuoteUI(pad) {
  const sel = $('solQuoteSelect').value;
  pad.quoteSel = sel;
  const custom = sel === 'CUSTOM';
  $('solCustomMint').classList.toggle('hidden', !custom);
  if (custom && !$('solCustomMint').value.trim()) $('solCustomMint').value = SOL_CUSTOM_DEFAULT;
  const q = SOL_QUOTES[sel];
  const thr = $('solMigThreshold');
  if (!thr.value.trim()) thr.value = q ? q.defaultThreshold : SOL_CUSTOM_THRESHOLD;
  $('solQuoteHint').textContent = custom
    ? 'any SPL or Token-2022 mint (metadata-only extensions)'
    : `token pooled against ${q.symbol} · threshold in ${q.symbol}`;
}

function updateWalletChip(pad) {
  if (pad.vm === 'sol') {
    if (!solKeyB58) { $('walletAddr').textContent = 'no SOL key'; $('walletChip').title = 'import a SOL key to launch here'; return; }
    const a = solPubkeyFromSecret(solKeyB58);
    $('walletAddr').textContent = a.slice(0, 4) + '…' + a.slice(-4);
    $('walletChip').title = a + ' (SOL — click to copy)';
  } else if (account) {
    $('walletAddr').textContent = account.address.slice(0, 6) + '…' + account.address.slice(-4);
    $('walletChip').title = account.address + ' (click to copy)';
  }
}

async function refreshFeeNote() {
  if (!activePad.enabled) return;
  if (activePad.family === 'rialto') {
    const bps = rialtoConfig?.initial_protocol_fee_bps ?? 3000;
    $('feeNote').textContent = `Rialto protocol fee ${(bps / 100).toFixed(1)}% on trades + gas`;
    return;
  }
  try {
    const fee = await publicClientFor(activePad).readContract({
      address: activePad.factory, abi: FACTORY_ABI, functionName: 'launchFee',
    });
    $('feeNote').textContent = `launch fee ${formatEther(fee)} ${activePad.nativeSymbol} + dev buy + gas`;
  } catch { $('feeNote').textContent = ''; }
}

async function refreshBalance() {
  if (!activePad.enabled) return;
  if (activePad.vm === 'sol') {
    if (!solKeyB58) { $('walletBal').textContent = ''; return; }
    try {
      const a = solPubkeyFromSecret(solKeyB58);
      const r = await fetch(activePad.rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [a] }),
      });
      const j = await r.json();
      $('walletBal').textContent = (j.result.value / 1e9).toFixed(4) + ' SOL';
    } catch { /* rpc hiccup, ignore */ }
    return;
  }
  if (!account) return;
  try {
    const bal = await publicClientFor(activePad).getBalance({ address: account.address });
    $('walletBal').textContent = (+formatEther(bal)).toFixed(4) + ' ' + activePad.nativeSymbol;
  } catch { /* rpc hiccup, ignore */ }
}

function onUnlocked() {
  $('setupOverlay').classList.add('hidden');
  $('unlockOverlay').classList.add('hidden');
  $('walletDot').classList.add('on');
  $('feeRecipient').placeholder = account.address + ' (default)';
  // cache the decrypted keys for the session so other pages / reloads don't re-prompt
  if (evmPk) saveSession({ evm: evmPk, sol: solKeyB58 || undefined });
  updateWalletChip(activePad);
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
    evmPk = pk;
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
    evmPk = pk;
    account = privateKeyToAccount(pk);
    $('unlockPass').value = '';
    onUnlocked();
  } catch (e) { $('unlockErr').textContent = e.message; }
}

// silent unlock from the session cache (set on a previous unlock this session)
function trySessionUnlock() {
  const s = loadSession();
  if (!s?.evm) return false;
  try {
    evmPk = s.evm;
    account = privateKeyToAccount(s.evm);
    if (s.sol) solKeyB58 = s.sol;
    onUnlocked();
    return true;
  } catch { return false; }
}

// add or replace a key in an existing vault (no full reset needed)
async function doImportKeys() {
  try {
    $('importErr').textContent = '';
    const pass = $('importPass').value;
    const vault = loadVault();
    if (!vault) throw new Error('no wallet yet — use the setup screen first');
    // verify the password by decrypting the current EVM key
    const curEvmPk = await decryptSecret(pass, vault.evm).catch(() => { throw new Error('wrong password'); });

    const solRaw = $('importSolKey').value.trim();
    const evmRaw = $('importEvmKey').value.trim();
    if (!solRaw && !evmRaw) throw new Error('enter a SOL or EVM key to import');

    const next = { ...vault };
    if (solRaw) {
      solKeyB58 = validateSolKey(solRaw);
      next.sol = await encryptSecret(pass, solKeyB58);
    }
    evmPk = evmRaw ? normalizeEvmKey(evmRaw) : curEvmPk;
    if (evmRaw) next.evm = await encryptSecret(pass, evmPk);
    account = privateKeyToAccount(evmPk);
    saveVault(next);
    saveSession({ evm: evmPk, sol: solKeyB58 || undefined });

    $('importSolKey').value = ''; $('importEvmKey').value = ''; $('importPass').value = '';
    $('keysOverlay').classList.add('hidden');
    updateWalletChip(activePad);
    refreshBalance();
    renderTokenList();
    setStatus('keys updated ✓');
  } catch (e) { $('importErr').textContent = e.message; }
}

function init() {
  renderPads();
  renderBuyChips();
  refreshFeeNote();
  applyPadUI(activePad);
  $('supply').addEventListener('input', updateBuyPreview);
  $('quoteSelect').addEventListener('change', () => {
    activePad.quoteToken = $('quoteSelect').value;
    updateRialtoHint(activePad);
  });
  $('solQuoteSelect').addEventListener('change', () => updateSolQuoteUI(activePad));

  $('distToggle').onclick = toggleDistro;
  $('distAdd').onclick = () => $('distRows').appendChild(distRow());
  $('distSave').onclick = saveDistSet;
  $('distDelete').onclick = deleteDistSet;

  $('chipAdd').onclick = () => $('chipEditRows').appendChild(chipEditRow(''));
  $('chipSave').onclick = saveChipEditor;
  $('chipCancel').onclick = () => $('chipsOverlay').classList.add('hidden');

  $('keysLink').onclick = () => { $('importErr').textContent = ''; $('keysOverlay').classList.remove('hidden'); };
  $('importBtn').onclick = doImportKeys;
  $('importCancel').onclick = () => $('keysOverlay').classList.add('hidden');

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

  if (loadVault()) { if (!trySessionUnlock()) $('unlockOverlay').classList.remove('hidden'); }
  else $('setupOverlay').classList.remove('hidden');

  $('setupBtn').onclick = doSetup;
  $('unlockBtn').onclick = doUnlock;
  $('unlockPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  $('resetVault').onclick = () => {
    if (confirm('Delete the stored (encrypted) key from this browser?')) {
      localStorage.removeItem(VAULT_KEY);
      sessionStorage.removeItem(SESSION_KEYS);
      location.reload();
    }
  };

  $('walletChip').onclick = () => {
    const addr = activePad.vm === 'sol' ? (solKeyB58 && solPubkeyFromSecret(solKeyB58)) : account?.address;
    if (addr) navigator.clipboard.writeText(addr);
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

// ---------------------------------------------------------------------------
// login gate — users create their own username + password on first visit; it
// is stored (PBKDF2-hashed, never plaintext) in this browser. NOTE: the page is
// static and its source is public, so this is a per-device lock, not
// server-grade multi-user auth. Only a hash + random salt live in localStorage.
// ---------------------------------------------------------------------------
const GATE_CRED = 'gate.cred.v1';
const GATE_FLAG = 'gate.ok.v1';
const GATE_ITER = 150000;

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function gateHash(username, password, saltBytes) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(username + '\n' + password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: GATE_ITER, hash: 'SHA-256' },
    keyMat, 256,
  );
  return toHex(bits);
}

const loadGateCred = () => JSON.parse(localStorage.getItem(GATE_CRED) || 'null');

function enterApp() {
  $('gateOverlay').classList.add('hidden');
  $('appRoot').style.display = '';
  init();
}

function initGate() {
  if (sessionStorage.getItem(GATE_FLAG) === '1') { enterApp(); return; }
  const creating = !loadGateCred();

  $('gateTitle').textContent = creating ? 'CREATE LOGIN' : 'LOGIN';
  $('gateSub').textContent = creating
    ? 'Pick a username and password to lock this launcher on this device.'
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
      const hash = await gateHash(u, p, salt);
      localStorage.setItem(GATE_CRED, JSON.stringify({ username: u, salt: toHex(salt), hash }));
    } else {
      const cred = loadGateCred();
      const saltBytes = Uint8Array.from(cred.salt.match(/../g).map((h) => parseInt(h, 16)));
      const hash = await gateHash(u, p, saltBytes);
      if (hash !== cred.hash) { $('gateErr').textContent = 'wrong username or password'; return; }
    }

    sessionStorage.setItem(GATE_FLAG, '1');
    $('gatePass').value = '';
    if ($('gatePass2')) $('gatePass2').value = '';
    enterApp();
  };

  $('gateBtn').onclick = submit;
  const onEnter = (e) => { if (e.key === 'Enter') submit(); };
  $('gatePass').addEventListener('keydown', onEnter);
  $('gatePass2').addEventListener('keydown', onEnter);
  $('gateUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gatePass').focus(); });
  $('gateUser').focus();
}

initGate();
