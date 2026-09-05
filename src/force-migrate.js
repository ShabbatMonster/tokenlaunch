import {
  createPublicClient, createWalletClient, http, defineChain, isAddress, getAddress, formatEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Force Migrate — for Pons v2 (bonding-curve) tokens that reached their
// graduation threshold but never got swept into their Uniswap v4 pool because
// Pons's own graduationExecutor bot didn't pick them up.
//
// Contract facts below were reverse-engineered directly from the live,
// deployed PonsV2LaunchFactory bytecode on Robinhood chain (Blockscout is
// Cloudflare-gated, so no verified-source UI was available) — selectors
// resolved via the public 4byte/openchain signature databases, then verified
// by reading real values off a real launch. See git history for how.
//
//   PonsV2LaunchFactory (0x7eD598…C7e)
//     createGraduatedPool(token)     — normal path once a curve is ready;
//                                      likely restricted to graduationExecutor.
//     forceSweptGraduation(token)    — the permissionless rescue path, opens
//                                      up GRADUATION_RESCUE_DELAY (7 days,
//                                      read live below) after the curve
//                                      became ready, if nobody swept it.
//     rescueSweptGraduation(token,x) — a further manual-recovery path with an
//                                      ambiguous second argument; NOT wired to
//                                      a button here (see README below) —
//                                      surfaced as a diagnostic pointer only.
//   PonsV2Curve (per-token clone, address discovered via the factory's
//   TokenLaunched event)
//     graduated() / readyToGraduate() / graduationThreshold() / quoteReserve()
//
// Both candidate migration calls are simulated (eth_call) before anything is
// ever shown as clickable — if neither simulates successfully, no button is
// shown, only the decoded revert reasons. Nothing here bypasses a contract
// permission; it only calls functions that are already meant to be
// permissionless once their gating condition is met.
// ---------------------------------------------------------------------------

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const FACTORY_START_BLOCK = 23011563n; // floor for event-log discovery

const CHAIN = defineChain({
  id: 4663, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

// Real signature confirmed against the live topic0 hash via openchain.xyz's
// signature database (TokenLaunched(address,address,address,address,uint256,uint256))
// — do not "simplify" this back down without re-checking the hash, a wrong
// signature computes a different topic0 and silently matches nothing, ever.
const TOKEN_LAUNCHED_EVENT = {
  type: 'event', name: 'TokenLaunched',
  inputs: [
    { name: 'token', type: 'address', indexed: true },
    { name: 'curve', type: 'address', indexed: true },
    { name: 'creator', type: 'address', indexed: true },
    { name: 'pairToken', type: 'address', indexed: false },
    { name: 'initialBuy', type: 'uint256', indexed: false },
    { name: 'graduationThreshold', type: 'uint256', indexed: false },
  ],
};

const FACTORY_ABI = [
  TOKEN_LAUNCHED_EVENT,
  { type: 'function', name: 'graduationExecutor', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'GRADUATION_RESCUE_DELAY', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'poolManager', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'positionManager', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'memeHook', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'createGraduatedPool', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'forceSweptGraduation', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'rescueSweptGraduation', inputs: [{ name: 'token', type: 'address' }, { name: 'recipient', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'error', name: 'GraduationRescueTooEarly', inputs: [{ type: 'uint256' }] },
  { type: 'error', name: 'GraduationStillViable', inputs: [] },
  { type: 'error', name: 'GraduationSeedNotViable', inputs: [] },
  { type: 'error', name: 'GraduationExecutorNotSet', inputs: [] },
  { type: 'error', name: 'CurveNotQuotable', inputs: [] },
  { type: 'error', name: 'SqrtPriceOutOfBounds', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'OwnableUnauthorizedAccount', inputs: [{ type: 'address' }] },
];

const CURVE_ABI = [
  { type: 'function', name: 'token', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'pairToken', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'graduated', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'readyToGraduate', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'graduationThreshold', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'quoteReserve', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'realQuoteReserve', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'isNativeQuote', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'launchedAt', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'error', name: 'AlreadyGraduated', inputs: [] },
];

const ERC20_ABI = [
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });

// keys are stored in plaintext (shared with the launcher: keys.v1) — private/
// local tool, no password, no login gate
const KEYS_KEY = 'keys.v1';
const loadKeys = () => { try { return JSON.parse(localStorage.getItem(KEYS_KEY) || 'null'); } catch { return null; } };

let account = null;
let wallet = null;

let walletBsc = null;

function useKey(pk) {
  account = privateKeyToAccount(pk);
  wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
  walletBsc = createWalletClient({ account, chain: BSC_CHAIN, transport: http(BSC_RPC) });
  $('walletAddr').textContent = account.address.slice(0, 6) + '…' + account.address.slice(-4);
}

// ---------------------------------------------------------------------------
// curve discovery — factory's TokenLaunched event, filtered by indexed token.
// A topic-filtered getLogs call is cheap for the RPC regardless of block
// range (measured: the entire ~29M-block factory history resolves in ~120ms)
// — no chunking needed. What actually broke this before wasn't range size,
// it was an unverified guess at the event's parameter types (see the ABI
// comment above); a wrong signature computes a different topic0 and matches
// nothing at any range, which looks exactly like "not found" but isn't.
// ---------------------------------------------------------------------------
async function findCurve(token, onProgress) {
  onProgress?.('scanning for the launch event…');
  let logs;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      logs = await pub.getLogs({ address: FACTORY, event: TOKEN_LAUNCHED_EVENT, args: { token }, fromBlock: FACTORY_START_BLOCK, toBlock: 'latest' });
      break;
    } catch (e) {
      if (attempt === 2) throw new Error(`log scan failed: ${e.shortMessage || e.message} — paste the curve address manually instead`);
    }
  }
  return logs.length ? getAddress(logs[logs.length - 1].args.curve) : null;
}


// ---------------------------------------------------------------------------
// OpenFour (four.meme) on BNB Chain — the second thing this page can unstick.
//
// Their Core exposes a permissionless `migrate(address token)`: after each buy
// Core evaluates the migrate module itself, but if nobody trades again a fully
// funded curve can sit there un-migrated. Anyone may then call migrate().
//
// Confirmed against the live deployment rather than the docs alone: their
// published IOpenFourCore ABI does NOT list migrate(), but calling it returns
// the custom error CoreErrBadPhase() (0xc4e60bf5) whereas a nonexistent
// function returns empty revert data — so the function is really there, and it
// failed on business logic, not on authorisation.
// ---------------------------------------------------------------------------
const BSC_RPC = 'https://bsc-dataseed.bnbchain.org';
const BSC_EXPLORER = 'https://bscscan.com';
const OF_REGISTRY = '0x912CEf0C3aE9Ab6eB3Ec87cab69371cFb317Ab94';
const BSC_CHAIN = defineChain({
  id: 56, name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [BSC_RPC] } },
});
const bsc = createPublicClient({ chain: BSC_CHAIN, transport: http(BSC_RPC) });

// vault.phase() — migration only means anything before it reaches Migrated
const OF_PHASES = ['Created', 'Trading', 'MigratePending', 'Migrated', 'Terminal', 'SoldOut'];

const OF_REGISTRY_ABI = [
  { type: 'function', name: 'openFourCore', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];
const OF_CORE_ABI = [
  { type: 'function', name: 'migrate', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
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
  { type: 'error', name: 'CoreErrZeroRegistry', inputs: [] },
  { type: 'error', name: 'CoreErrZeroWrappedNative', inputs: [] },
  { type: 'error', name: 'CoreErrZeroFeeRouter', inputs: [] },
  { type: 'error', name: 'CoreErrZeroToken', inputs: [] },
  { type: 'error', name: 'CoreErrTokenNotFound', inputs: [] },
  { type: 'error', name: 'CoreErrBadConfig', inputs: [] },
  { type: 'error', name: 'CoreErrBadToken', inputs: [] },
  { type: 'error', name: 'CoreErrDuplicateToken', inputs: [] },
  { type: 'error', name: 'CoreErrRequestExpired', inputs: [] },
  { type: 'error', name: 'CoreErrRequestAlreadyUsed', inputs: [] },
  { type: 'error', name: 'CoreErrTokenPaused', inputs: [] },
  { type: 'error', name: 'CoreErrPresetInactive', inputs: [] },
  { type: 'error', name: 'CoreErrPresetCreateDisabled', inputs: [] },
  { type: 'error', name: 'CoreErrBadPhase', inputs: [] },
  { type: 'error', name: 'CoreErrQuoteMustBeERC20', inputs: [] },
  { type: 'error', name: 'CoreErrCurveRejected', inputs: [] },
  { type: 'error', name: 'CoreErrTradeRejected', inputs: [] },
  { type: 'error', name: 'CoreErrSlippage', inputs: [] },
  { type: 'error', name: 'CoreErrTradeMax', inputs: [] },
  { type: 'error', name: 'CoreErrTradeMin', inputs: [] },
  { type: 'error', name: 'CoreErrBadTax', inputs: [] },
  { type: 'error', name: 'CoreErrBudgetNotExecutable', inputs: [] },
  { type: 'error', name: 'CoreErrNativeOnlyWrapped', inputs: [] },
  { type: 'error', name: 'CoreErrInsufficientNative', inputs: [] },
  { type: 'error', name: 'CoreErrNativeRefundFailed', inputs: [] },
  { type: 'error', name: 'CoreErrPresetValidatorNotFound', inputs: [] },
  { type: 'error', name: 'CoreErrPresetTokenImplNotFound', inputs: [] },
  { type: 'error', name: 'DeployErrFounderProbeUnderfunded', inputs: [] },
  { type: 'error', name: 'DeployErrFounderCannotReceiveNative', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrFeeDistributeFailed', inputs: [{ type: 'bytes' }] },
  { type: 'error', name: 'LikwidMigrateErrAddLiquidityFailed', inputs: [{ type: 'bytes' }] },
  { type: 'error', name: 'LikwidMigrateErrZeroVault', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrZeroToken', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrZeroQuote', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrUnsupportedChain', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrZeroPairPosition', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrZeroQuoteLiquidity', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrIdenticalCurrency', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrOnlyFourCore', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrAlreadyInitialized', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrZeroFourCore', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrZeroFeeRouter', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrParamsNotEmpty', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrExistingPoolLiquidity', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrNotInitialized', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrWrongToken', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrZeroVaultBalance', inputs: [] },
  { type: 'error', name: 'LikwidMigrateErrNoTokenLiquidity', inputs: [] },
];
const OF_VAULT_ABI = [
  { type: 'function', name: 'phase', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'totalRaised', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'remainingForSale', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'isSoldOut', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
];


// Proving a migration really landed: phase == Migrated is NOT sufficient on its
// own (their own docs say so), so when a token reports Migrated we go and read
// the external pair and its reserves. A funded pair is the actual evidence.
const OF_STRATEGY_ABI = [
  { type: 'function', name: 'taxStrategy', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'listaV2Factory', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'listaV2Router', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];
const OF_PAIR_ABI = [
  { type: 'function', name: 'getPair', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'getReserves', inputs: [], outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }], stateMutability: 'view' },
  { type: 'function', name: 'token0', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];

/// best-effort: returns { pair, tokenReserve, quoteReserve } for a migrated
/// token, or null when this preset does not expose a Lista-style strategy
async function findMigratedPair(token, quoteAsset) {
  try {
    const strategy = await bsc.readContract({ address: token, abi: OF_STRATEGY_ABI, functionName: 'taxStrategy' });
    const factory = await bsc.readContract({ address: strategy, abi: OF_STRATEGY_ABI, functionName: 'listaV2Factory' });
    const pair = await bsc.readContract({ address: factory, abi: OF_PAIR_ABI, functionName: 'getPair', args: [token, quoteAsset] });
    if (/^0x0+$/i.test(pair)) return null;
    const [reserves, token0] = await Promise.all([
      bsc.readContract({ address: pair, abi: OF_PAIR_ABI, functionName: 'getReserves' }),
      bsc.readContract({ address: pair, abi: OF_PAIR_ABI, functionName: 'token0' }),
    ]);
    const tokenIs0 = getAddress(token0) === getAddress(token);
    return {
      pair,
      tokenReserve: tokenIs0 ? reserves[0] : reserves[1],
      quoteReserve: tokenIs0 ? reserves[1] : reserves[0],
    };
  } catch {
    return null;
  }
}

let ofCore = null;
async function openFourCore() {
  if (!ofCore) ofCore = await bsc.readContract({ address: OF_REGISTRY, abi: OF_REGISTRY_ABI, functionName: 'openFourCore' });
  return ofCore;
}

/// returns null when the address is not an OpenFour token
async function loadOpenFour(token) {
  const core = await openFourCore();
  const cfg = await bsc.readContract({ address: core, abi: OF_CORE_ABI, functionName: 'tokens', args: [token] });
  if (!cfg[17]) return null;
  const vault = getAddress(cfg[10]);
  const [phase, totalRaised, remaining, soldOut] = await Promise.all([
    bsc.readContract({ address: vault, abi: OF_VAULT_ABI, functionName: 'phase' }).catch(() => null),
    bsc.readContract({ address: vault, abi: OF_VAULT_ABI, functionName: 'totalRaised' }).catch(() => 0n),
    bsc.readContract({ address: vault, abi: OF_VAULT_ABI, functionName: 'remainingForSale' }).catch(() => 0n),
    bsc.readContract({ address: vault, abi: OF_VAULT_ABI, functionName: 'isSoldOut' }).catch(() => null),
  ]);
  return { core, token, cfg, vault, phase, totalRaised, remaining, soldOut };
}

async function renderOpenFour(info) {
  const { core, token, cfg, vault, phase, totalRaised, remaining, soldOut } = info;
  $('resultCard').classList.remove('hidden');
  $('progressBar').classList.add('hidden');
  const actionBtn = $('actionBtn');
  actionBtn.classList.add('hidden');

  const raise = cfg[8];
  const pct = raise > 0n ? Number((totalRaised * 10000n) / raise) / 100 : 0;
  $('details').innerHTML =
    `<dt>token</dt><dd>${esc(cfg[5])} · <a href="${BSC_EXPLORER}/token/${token}" target="_blank" rel="noopener">${esc(token)}</a></dd>` +
    `<dt>venue</dt><dd>OpenFour (four.meme) · BNB Chain</dd>` +
    `<dt>vault</dt><dd><a href="${BSC_EXPLORER}/address/${vault}" target="_blank" rel="noopener">${esc(vault)}</a></dd>` +
    `<dt>phase</dt><dd>${phase === null ? '?' : `${OF_PHASES[phase] ?? phase} (${phase})`}</dd>` +
    `<dt>raised</dt><dd>${pct.toFixed(1)}% of target</dd>` +
    `<dt>sold out</dt><dd>${soldOut === null ? '?' : soldOut}</dd>`;

  const dev = [
    `core             = ${core}`,
    `tokens().exists  = ${cfg[17]}`,
    `vault            = ${vault}`,
    `vault.phase()    = ${phase} (${OF_PHASES[phase] ?? '?'})`,
    `totalRaised      = ${totalRaised.toString()}`,
    `raiseAmount      = ${raise.toString()}`,
    `remainingForSale = ${remaining.toString()}`,
    `isSoldOut()      = ${soldOut}`,
    '',
    'simulating core.migrate(token):',
  ];

  if (phase === 3) {
    $('statusBadge').innerHTML = badge('ALREADY MIGRATED', 'done');
    dev.push('  skipped — the vault is already in the Migrated phase');
    // "Migrated" on its own is not proof, so go find the pool and its reserves
    const mp = await findMigratedPair(token, getAddress(cfg[9]));
    if (mp) {
      const qsym = await bsc.readContract({ address: getAddress(cfg[9]), abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'quote');
      $('details').innerHTML +=
        `<dt>pool</dt><dd><a href="${BSC_EXPLORER}/address/${mp.pair}" target="_blank" rel="noopener">${esc(mp.pair)}</a></dd>` +
        `<dt>pool liq</dt><dd>${(+formatEther(mp.tokenReserve)).toLocaleString()} ${esc(cfg[5])} + ` +
        `${(+formatEther(mp.quoteReserve)).toLocaleString()} ${esc(qsym)}</dd>`;
      dev.push('',
        'Migration completed and the external pool is funded:',
        `  pair          = ${mp.pair}`,
        `  token reserve = ${mp.tokenReserve.toString()}`,
        `  quote reserve = ${mp.quoteReserve.toString()}`,
        '',
        'The OpenFour internal market is closed by design once a token migrates —',
        'that is not a stuck state. Trade it on the external pool above.');
    } else {
      dev.push('',
        'Phase says Migrated but no funded external pair was found for this token.',
        'That IS worth investigating — their docs are explicit that phase alone does',
        'not prove the pool is live.');
    }
    $('devDetails').textContent = dev.join('\n');
    return;
  }

  // trust the simulation over our own reading of the phase
  try {
    await bsc.simulateContract({
      address: core, abi: OF_CORE_ABI, functionName: 'migrate', args: [token],
      account: account?.address ?? '0x0000000000000000000000000000000000000001',
    });
    dev.push('  migrate(token) -> OK (simulated successfully)');
    $('statusBadge').innerHTML = badge('MIGRATION AVAILABLE', 'ready');
    actionBtn.textContent = 'MIGRATE NOW';
    actionBtn.className = 'btn';
    actionBtn.classList.remove('hidden');
    actionBtn.disabled = !account;
    actionBtn.onclick = () => runOpenFourMigration(core, token);
    if (!account) dev.push('', 'Unlock a wallet in the launcher to send this transaction.');
  } catch (e) {
    dev.push(`  migrate(token) -> REVERTS: ${fmtErr(e)}`);
    $('statusBadge').innerHTML = badge('MIGRATION BLOCKED', 'blocked');
    dev.push('',
      'CoreErrBadPhase means the vault is not in a phase Core will migrate from.',
      'OpenFour normally migrates by itself during a buy, since Core evaluates the',
      'migrate module after each trade. A curve that is funded but idle is exactly',
      'the case where calling migrate() directly does the job.');
  }
  $('devDetails').textContent = dev.join('\n');
}

async function runOpenFourMigration(core, token) {
  const btn = $('actionBtn');
  const status = $('actionStatus');
  btn.disabled = true;
  status.textContent = 'simulating once more before sending…';
  try {
    if (!walletBsc) throw new Error('wallet is locked');
    await bsc.simulateContract({ address: core, abi: OF_CORE_ABI, functionName: 'migrate', args: [token], account: account.address });
    status.textContent = 'sending transaction…';
    const hash = await walletBsc.writeContract({ address: core, abi: OF_CORE_ABI, functionName: 'migrate', args: [token] });
    status.innerHTML = `tx sent: <a href="${BSC_EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 10)}…</a><br>waiting for confirmation…`;
    const r = await bsc.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('transaction reverted on-chain');
    status.innerHTML = `<span class="ok">MIGRATED ✓</span><br>` +
      `<a href="${BSC_EXPLORER}/tx/${hash}" target="_blank" rel="noopener">tx</a> · ` +
      `<a href="${BSC_EXPLORER}/token/${token}" target="_blank" rel="noopener">token</a>`;
    btn.classList.add('hidden');
  } catch (e) {
    status.innerHTML = `<span class="err">${esc(fmtErr(e))}</span>`;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------
function fmtErr(e) {
  return e?.shortMessage || e?.message || String(e);
}

function badge(label, cls) {
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

async function analyze() {
  const tokenRaw = $('tokenInput').value.trim();
  const curveRaw = $('curveInput').value.trim();
  $('resultCard').classList.add('hidden');
  $('actionBtn').classList.add('hidden');
  $('progressBar').classList.add('hidden');
  const status = $('analyzeStatus');
  status.textContent = '';

  if (!isAddress(tokenRaw)) { status.innerHTML = '<span class="err">enter a valid token address</span>'; return; }
  const token = getAddress(tokenRaw);

  $('analyzeBtn').disabled = true;
  try {
    // OpenFour tokens live on BNB Chain and identify themselves in one call, so
    // check that before falling back to the Pons v2 curve hunt on Robinhood.
    if (!curveRaw) {
      status.textContent = 'checking OpenFour (BNB Chain)…';
      const of = await loadOpenFour(token).catch(() => null);
      if (of) { status.textContent = ''; await renderOpenFour(of); return; }
    }

    let curve;
    if (curveRaw) {
      if (!isAddress(curveRaw)) { status.innerHTML = '<span class="err">curve address is not a valid address</span>'; return; }
      curve = getAddress(curveRaw);
    } else {
      status.textContent = 'looking up the launch event…';
      curve = await findCurve(token, (m) => { status.textContent = m; });
      if (!curve) {
        status.innerHTML = '<span class="err">no Pons v2 launch event found for this token — it may not be a Pons v2 (bonding-curve) ' +
          'token, or if you already know its bonding curve address, paste it above and analyze again</span>';
        return;
      }
    }

    status.textContent = 'reading curve + factory state…';
    const [curveToken, pairToken, graduated, readyToGraduate, threshold, quoteReserve, isNativeQuote, launchedAt,
      graduationExecutor, rescueDelay] = await Promise.all([
      pub.readContract({ address: curve, abi: CURVE_ABI, functionName: 'token' }),
      pub.readContract({ address: curve, abi: CURVE_ABI, functionName: 'pairToken' }),
      pub.readContract({ address: curve, abi: CURVE_ABI, functionName: 'graduated' }),
      pub.readContract({ address: curve, abi: CURVE_ABI, functionName: 'readyToGraduate' }),
      pub.readContract({ address: curve, abi: CURVE_ABI, functionName: 'graduationThreshold' }),
      pub.readContract({ address: curve, abi: CURVE_ABI, functionName: 'quoteReserve' }),
      pub.readContract({ address: curve, abi: CURVE_ABI, functionName: 'isNativeQuote' }),
      pub.readContract({ address: curve, abi: CURVE_ABI, functionName: 'launchedAt' }),
      pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'graduationExecutor' }),
      pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'GRADUATION_RESCUE_DELAY' }),
    ]);

    if (getAddress(curveToken) !== token) {
      status.innerHTML = `<span class="err">that curve belongs to a different token (${esc(curveToken)}) — double-check the address</span>`;
      return;
    }

    const quoteSymbol = isNativeQuote ? 'ETH' : await pub.readContract({ address: pairToken, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '???');
    status.textContent = '';
    render({ token, curve, pairToken, quoteSymbol, graduated, readyToGraduate, threshold, quoteReserve, launchedAt, graduationExecutor, rescueDelay });
  } catch (e) {
    status.innerHTML = `<span class="err">${esc(fmtErr(e))}</span>`;
  } finally {
    $('analyzeBtn').disabled = false;
  }
}

async function render(info) {
  const { token, curve, pairToken, quoteSymbol, graduated, readyToGraduate, threshold, quoteReserve, launchedAt, graduationExecutor, rescueDelay } = info;
  $('resultCard').classList.remove('hidden');

  const kv = $('details');
  const ageDays = (Date.now() / 1000 - Number(launchedAt)) / 86400;
  kv.innerHTML = `
    <dt>token</dt><dd><a href="${EXPLORER}/token/${token}" target="_blank" rel="noopener">${esc(token)}</a></dd>
    <dt>curve</dt><dd><a href="${EXPLORER}/address/${curve}" target="_blank" rel="noopener">${esc(curve)}</a></dd>
    <dt>quote</dt><dd>${esc(quoteSymbol)}</dd>
    <dt>launched</dt><dd>${ageDays.toFixed(1)} days ago</dd>
    <dt>rescue delay</dt><dd>${(Number(rescueDelay) / 86400).toFixed(1)} days after ready</dd>
    <dt>executor</dt><dd>${esc(graduationExecutor)}</dd>
  `;

  const devLines = [
    `token()          = ${token}`,
    `curve            = ${curve}`,
    `pairToken()      = ${pairToken}`,
    `graduated()      = ${graduated}`,
    `readyToGraduate()= ${readyToGraduate}`,
    `graduationThreshold() = ${threshold.toString()} (${formatEther(threshold)} ${quoteSymbol})`,
    `quoteReserve()   = ${quoteReserve.toString()} (${formatEther(quoteReserve)} ${quoteSymbol})`,
    `factory          = ${FACTORY}`,
    `graduationExecutor() = ${graduationExecutor}`,
    `GRADUATION_RESCUE_DELAY() = ${rescueDelay.toString()}s`,
  ];

  const actionBtn = $('actionBtn');
  actionBtn.classList.add('hidden');
  $('progressBar').classList.add('hidden');

  if (!readyToGraduate && !graduated) {
    $('statusBadge').innerHTML = badge('BONDING ACTIVE', 'active');
    const pct = threshold > 0n ? Math.min(100, Number((quoteReserve * 10000n) / threshold) / 100) : 0;
    $('progressBar').classList.remove('hidden');
    $('progressFill').style.width = `${pct}%`;
    devLines.push('', `${pct.toFixed(1)}% of the way to the graduation threshold — nothing to force yet.`);
  } else {
    // graduated() only means the bonding curve itself closed — it does NOT
    // mean a pool exists. createGraduatedPool can still be genuinely callable
    // (and simulate successfully) after graduated() is already true, which is
    // exactly the "closed but never got a pool" stuck state. So: never trust
    // the graduated flag alone — always let simulation be the source of truth.
    $('statusBadge').innerHTML = badge(graduated ? 'CURVE CLOSED — CHECKING POOL' : 'GRADUATION THRESHOLD REACHED', 'ready') + ' — simulating…';
    devLines.push('', `readyToGraduate()=${readyToGraduate}, graduated()=${graduated} — simulating both candidate migration calls:`);

    const attempts = [
      { fn: 'createGraduatedPool', label: 'MIGRATE NOW', cls: '' },
      { fn: 'forceSweptGraduation', label: 'FORCE MIGRATE', cls: 'force' },
    ];
    let chosen = null;
    for (const a of attempts) {
      try {
        await pub.simulateContract({ address: FACTORY, abi: FACTORY_ABI, functionName: a.fn, args: [token], account: account?.address });
        devLines.push(`  ${a.fn}(token) -> OK (simulated successfully)`);
        if (!chosen) chosen = a;
      } catch (e) {
        devLines.push(`  ${a.fn}(token) -> REVERTS: ${fmtErr(e)}`);
      }
    }

    if (chosen) {
      $('statusBadge').innerHTML = badge('MIGRATION AVAILABLE', 'ready');
      actionBtn.textContent = chosen.label;
      actionBtn.className = `btn ${chosen.cls}`;
      actionBtn.classList.remove('hidden');
      actionBtn.disabled = !account;
      actionBtn.onclick = () => runMigration(token, chosen.fn);
      if (!account) devLines.push('', 'Unlock a wallet in the launcher to send this transaction.');
    } else if (graduated) {
      $('statusBadge').innerHTML = badge('ALREADY GRADUATED', 'done');
      devLines.push('', 'graduated() is true and neither migration call simulates — most likely its Uniswap v4 pool already exists. ' +
        'See the revert reasons above if you want to confirm exactly why.');
    } else {
      $('statusBadge').innerHTML = badge('MIGRATION BLOCKED', 'blocked');
      devLines.push('', 'Neither call simulates successfully right now — see the reasons above.',
        'Common causes: createGraduatedPool is restricted to the graduationExecutor bot, and forceSweptGraduation ' +
        'only opens up GRADUATION_RESCUE_DELAY after the curve became ready (shown above) — it may just not be old enough yet.');
    }
  }

  $('devDetails').textContent = devLines.join('\n');
}

async function runMigration(token, fnName) {
  const btn = $('actionBtn');
  const status = $('actionStatus');
  btn.disabled = true;
  status.textContent = 'simulating once more before sending…';
  try {
    await pub.simulateContract({ address: FACTORY, abi: FACTORY_ABI, functionName: fnName, args: [token], account: account.address });
    status.textContent = 'sending transaction…';
    const hash = await wallet.writeContract({ address: FACTORY, abi: FACTORY_ABI, functionName: fnName, args: [token] });
    status.innerHTML = `tx sent: <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 10)}…</a><br>waiting for confirmation…`;
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('transaction reverted on-chain');
    status.innerHTML = `<span class="ok">MIGRATED ✓</span><br>` +
      `<a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">tx</a> · ` +
      `<a href="${EXPLORER}/token/${token}" target="_blank" rel="noopener">token</a>`;
    btn.classList.add('hidden');
  } catch (e) {
    status.innerHTML = `<span class="err">${esc(fmtErr(e))}</span>`;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function start() {
  $('appRoot').style.display = '';
  const keys = loadKeys();
  if (keys?.evm) {
    try { useKey(keys.evm); } catch { /* leave locked, analysis still works read-only */ }
  }
  $('analyzeBtn').onclick = analyze;
  $('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });
}

start();
