import {
  createPublicClient, createWalletClient, http, defineChain,
  getAddress, keccak256, encodeAbiParameters, formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Fees on a Doppler v4 coin (long.xyz and anything else on the same Airlock).
//
// These do not work like the fees on our own LaunchFactory tokens, where the
// pool pays the creator directly. A Doppler coin's fees are taken by its hook
// and then split according to a matrix set at launch, and the interesting part
// is that the split is what decides whether you ever see them:
//
//   - the "buyback" share is spent buying one side of the pair and forwarded to
//     the pool's buybackDst. On a long.xyz coin that share is 100% and the
//     thing bought is the paired stock. Nobody claims it - it is pushed out.
//   - the "beneficiary" share accrues per address inside the hook.
//   - a protocol cut accrues as airlockOwnerFees and only the Airlock owner can
//     take it.
//
// Verified against FROGE (0x990FB9...1E18), which has real fees through it: its
// buybackDst holds 21,413 OPENAIx1L that the hook bought and sent, while
// 15.3M FROGE sits in the hook itself as the Airlock owner's unclaimed cut.
//
// Someone has to call collectFees to move a pool's earned fees through that
// split. It is permissionless - anyone can pay the gas, the money still goes
// where the matrix says - so this page offers it for any coin, not just yours.
// ---------------------------------------------------------------------------

const CHAIN_ID = 4663;
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';
const CHAIN = defineChain({
  id: CHAIN_ID, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const AIRLOCK = '0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
// the initializer every long.xyz coin is created through; it is also the hook
// named in the pool key, while the Rehype hook is a separate per-pool contract
const DOPPLER_HOOK_INITIALIZER = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544';
const ZERO = '0x0000000000000000000000000000000000000000';
const DYNAMIC_FEE = 0x800000;

const STATE_ABI = [{
  type: 'function', name: 'getState', stateMutability: 'view',
  inputs: [{ name: 'asset', type: 'address' }],
  outputs: [
    { name: 'numeraire', type: 'address' },
    { name: 'totalTokensOnBondingCurve', type: 'uint256' },
    { name: 'dopplerHook', type: 'address' },
    { name: 'graduationDopplerHookCalldata', type: 'bytes' },
    { name: 'status', type: 'uint8' },
    { name: 'poolKey', type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
      { name: 'hooks', type: 'address' },
    ] },
    { name: 'farTick', type: 'int24' },
  ],
}];

const HOOK_READ_ABI = [
  { type: 'function', name: 'getPoolInfo', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'asset', type: 'address' }, { name: 'numeraire', type: 'address' }, { name: 'buybackDst', type: 'address' }] },
  { type: 'function', name: 'getFeeSchedule', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'startingTime', type: 'uint32' }, { name: 'startFee', type: 'uint24' },
      { name: 'endFee', type: 'uint24' }, { name: 'lastFee', type: 'uint24' }, { name: 'durationSeconds', type: 'uint32' }] },
  { type: 'function', name: 'getFeeDistributionInfo', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'assetFeesToAssetBuybackWad', type: 'uint256' }, { name: 'assetFeesToNumeraireBuybackWad', type: 'uint256' },
      { name: 'assetFeesToBeneficiaryWad', type: 'uint256' }, { name: 'assetFeesToLpWad', type: 'uint256' },
      { name: 'numeraireFeesToAssetBuybackWad', type: 'uint256' }, { name: 'numeraireFeesToNumeraireBuybackWad', type: 'uint256' },
      { name: 'numeraireFeesToBeneficiaryWad', type: 'uint256' }, { name: 'numeraireFeesToLpWad', type: 'uint256' }] },
  { type: 'function', name: 'getHookFees', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'fees0', type: 'uint128' }, { name: 'fees1', type: 'uint128' },
      { name: 'beneficiaryFees0', type: 'uint128' }, { name: 'beneficiaryFees1', type: 'uint128' },
      { name: 'airlockOwnerFees0', type: 'uint128' }, { name: 'airlockOwnerFees1', type: 'uint128' },
      { name: 'customFee', type: 'uint24' }] },
];

// collectFees lives on the INITIALIZER, not on the Rehype hook. Calling the
// hook's own collectFees directly reverts with no data - it expects to be
// driven by the initializer. Verified on FROGE: the initializer's version runs
// from an address with no relationship to the coin at all and returns real
// amounts, while the hook's version reverts for everyone.
const COLLECT_BY_POOL_ABI = [{
  type: 'function', name: 'collectFees', stateMutability: 'nonpayable',
  inputs: [{ name: 'poolId', type: 'bytes32' }],
  outputs: [{ name: 'fees0', type: 'uint128' }, { name: 'fees1', type: 'uint128' }],
}];
// any address will do for a read-only probe of a permissionless call
const PROBE = '0x000000000000000000000000000000000000dEaD';
const CLAIM_OWNER_ABI = [{
  type: 'function', name: 'claimAirlockOwnerFees', stateMutability: 'nonpayable',
  inputs: [{ name: 'asset', type: 'address' }],
  outputs: [{ name: 'fees0', type: 'uint128' }, { name: 'fees1', type: 'uint128' }],
}];

const EXTSLOAD_ABI = [{
  type: 'function', name: 'extsload', stateMutability: 'view',
  inputs: [{ name: 'slot', type: 'bytes32' }], outputs: [{ type: 'bytes32' }],
}];
const OWNER_ABI = [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC, { retryCount: 6, retryDelay: 700 }) });

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
];

export function poolIdOf(poolKey) {
  return keccak256(encodeAbiParameters([{ type: 'tuple', components: POOL_KEY_COMPONENTS }], [poolKey]));
}

// A v4 pool has no contract of its own; its state lives in the PoolManager's
// `_pools` mapping at slot 6. slot0 is packed (lpFee in the top 24 bits) and
// the two fee-growth accumulators sit one and two slots in. Reading those is
// how we can say a pool has earned nothing without waiting on an event scan.
async function readPoolState(poolId) {
  const base = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n])));
  const at = (off) => pub.readContract({
    address: getAddress(POOL_MANAGER), abi: EXTSLOAD_ABI, functionName: 'extsload',
    args: ['0x' + (base + off).toString(16).padStart(64, '0')],
  });
  const [slot0, fg0, fg1, liq] = await Promise.all([at(0n), at(1n), at(2n), at(3n)]);
  const s = BigInt(slot0);
  return {
    sqrtPriceX96: s & ((1n << 160n) - 1n),
    lpFee: Number((s >> 184n) & 0xffffffn),
    feeGrowthGlobal0: BigInt(fg0),
    feeGrowthGlobal1: BigInt(fg1),
    liquidity: BigInt(liq),
  };
}

/// The fee a swap pays right now. A long.xyz pool opens at a punishing rate and
/// decays to its resting fee over a few seconds, so the launch value alone is
/// misleading - this is what someone trading this second actually pays.
export function currentFee(schedule, nowSeconds) {
  const { startingTime, startFee, endFee, durationSeconds } = schedule;
  if (!durationSeconds) return endFee;
  if (nowSeconds <= startingTime) return startFee;
  if (nowSeconds >= startingTime + durationSeconds) return endFee;
  const elapsed = nowSeconds - startingTime;
  return Math.round(startFee - (startFee - endFee) * (elapsed / durationSeconds));
}

/// v4 fees are in pips - millionths - so 11200 is 1.12%, not 112%.
export const feePercent = (pips) => (Number(pips) / 10000);

async function tokenMeta(address) {
  const a = getAddress(address);
  const [symbol, decimals] = await Promise.all([
    pub.readContract({ address: a, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '?'),
    pub.readContract({ address: a, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
  ]);
  return { address: a, symbol, decimals: Number(decimals) };
}

/// Everything worth knowing about one Doppler coin's fees.
///
/// Returns `claimable: false` with a plain reason when there is nothing to do,
/// which is the common case and the one most worth being explicit about: a pool
/// launched without a Rehype hook has a static zero fee and has never earned
/// anything at all.
export async function dopplerFeeReport(assetAddress, viewer) {
  const asset = getAddress(assetAddress);

  let state;
  try {
    state = await pub.readContract({
      address: getAddress(DOPPLER_HOOK_INITIALIZER), abi: STATE_ABI,
      functionName: 'getState', args: [asset],
    });
  } catch {
    return { asset, found: false, claimable: false,
      reason: 'this token was not launched through the Doppler hook initializer, so it has no Doppler fees' };
  }

  const poolKey = {
    currency0: state[5].currency0, currency1: state[5].currency1,
    fee: Number(state[5].fee), tickSpacing: Number(state[5].tickSpacing), hooks: state[5].hooks,
  };
  if (poolKey.currency0 === ZERO && poolKey.currency1 === ZERO) {
    return { asset, found: false, claimable: false,
      reason: 'this token was not launched through the Doppler hook initializer, so it has no Doppler fees' };
  }

  const poolId = poolIdOf(poolKey);
  const hook = state[2];
  const hasHook = hook.toLowerCase() !== ZERO;
  const numeraire = state[0];
  const [pool, assetMeta, numMeta] = await Promise.all([
    readPoolState(poolId), tokenMeta(asset), tokenMeta(numeraire),
  ]);

  const base = {
    asset, found: true, poolId, poolKey, hook, hasHook, numeraire,
    status: Number(state[4]), pool, assetMeta, numMeta,
    dynamicFee: poolKey.fee === DYNAMIC_FEE,
  };

  // No hook means no fee was ever charged. Say so with the evidence rather than
  // sending someone looking for a claim button that cannot exist.
  if (!hasHook) {
    const never = pool.feeGrowthGlobal0 === 0n && pool.feeGrowthGlobal1 === 0n;
    return {
      ...base, claimable: false,
      reason: never
        ? `this pool was created with a static ${feePercent(pool.lpFee)}% fee and no fee hook, so it has never `
          + 'charged a fee on a single trade - there are no fees to claim here, and none will accrue. '
          + 'The pool config is fixed at launch, so this cannot be turned on afterwards.'
        : 'this pool has no fee hook, so there is no Doppler fee split to claim from.',
    };
  }

  const [poolInfo, sched, dist, hookFees, block] = await Promise.all([
    pub.readContract({ address: getAddress(hook), abi: HOOK_READ_ABI, functionName: 'getPoolInfo', args: [poolId] }),
    pub.readContract({ address: getAddress(hook), abi: HOOK_READ_ABI, functionName: 'getFeeSchedule', args: [poolId] }),
    pub.readContract({ address: getAddress(hook), abi: HOOK_READ_ABI, functionName: 'getFeeDistributionInfo', args: [poolId] }),
    pub.readContract({ address: getAddress(hook), abi: HOOK_READ_ABI, functionName: 'getHookFees', args: [poolId] }),
    pub.getBlock(),
  ]);

  const schedule = {
    startingTime: Number(sched[0]), startFee: Number(sched[1]),
    endFee: Number(sched[2]), lastFee: Number(sched[3]), durationSeconds: Number(sched[4]),
  };
  const fees = {
    fees0: hookFees[0], fees1: hookFees[1],
    beneficiaryFees0: hookFees[2], beneficiaryFees1: hookFees[3],
    airlockOwnerFees0: hookFees[4], airlockOwnerFees1: hookFees[5],
  };
  const distribution = {
    assetToAssetBuyback: dist[0], assetToNumeraireBuyback: dist[1],
    assetToBeneficiary: dist[2], assetToLp: dist[3],
    numeraireToAssetBuyback: dist[4], numeraireToNumeraireBuyback: dist[5],
    numeraireToBeneficiary: dist[6], numeraireToLp: dist[7],
  };

  const buybackDst = getAddress(poolInfo[2]);
  const airlockOwner = await pub.readContract({ address: getAddress(AIRLOCK), abi: OWNER_ABI, functionName: 'owner' })
    .then(getAddress).catch(() => null);

  // currency0/currency1 ordering is not the same as asset/numeraire ordering,
  // so work out which side of the fee pair is which before showing amounts.
  const assetIsCurrency0 = getAddress(poolKey.currency0) === asset;
  const side = (v0, v1) => (assetIsCurrency0 ? { asset: v0, numeraire: v1 } : { asset: v1, numeraire: v0 });

  const you = viewer ? getAddress(viewer) : null;
  const ownerFees = side(fees.airlockOwnerFees0, fees.airlockOwnerFees1);
  const pending = side(fees.fees0, fees.fees1);
  const beneficiary = side(fees.beneficiaryFees0, fees.beneficiaryFees1);

  // Whether there is anything to collect is not something to infer from fee
  // growth - a graduated pool can show plenty of historical growth and still
  // have nothing left to pull. Ask the chain instead: the call is
  // permissionless, so simulating it from a burn address both proves it would
  // work and tells us the exact amounts, for free and without a signature.
  let collectable = null;
  let collectError = null;
  try {
    const probe = await pub.simulateContract({
      address: getAddress(poolKey.hooks), abi: COLLECT_BY_POOL_ABI,
      functionName: 'collectFees', args: [poolId], account: getAddress(PROBE),
    });
    const [c0, c1] = probe.result ?? [0n, 0n];
    collectable = side(c0, c1);
  } catch (e) {
    collectError = e?.shortMessage || e?.message || String(e);
  }
  const hasSomething = !!collectable && (collectable.asset > 0n || collectable.numeraire > 0n);

  return {
    ...base,
    buybackDst, airlockOwner, schedule, distribution,
    currentFee: currentFee(schedule, Number(block.timestamp)),
    assetIsCurrency0,
    ownerFees, pending, beneficiary, collectable, collectError,
    youAreBuybackDst: !!you && you === buybackDst,
    youAreAirlockOwner: !!you && !!airlockOwner && you === airlockOwner,
    claimable: hasSomething,
    reason: hasSomething ? null
      : (collectable
        ? 'the pool has no uncollected fees right now - they accrue as it trades'
        : 'there is nothing to collect from this pool right now'),
  };
}

export function formatAmount(raw, meta) {
  const n = Number(formatUnits(raw, meta.decimals));
  if (n === 0) return '0';
  if (n < 0.0001) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 });
}

function walletFor(privateKey) {
  const account = privateKeyToAccount(privateKey);
  return { account, wallet: createWalletClient({ account, chain: CHAIN, transport: http(RPC) }) };
}

/// Push a pool's earned fees through its split. Permissionless - the caller
/// pays gas and the money goes where the fee matrix sends it, which on a
/// long.xyz coin means buying the paired stock for the pool's buybackDst.
export async function collectDopplerFees({ privateKey, asset, onStatus }) {
  const say = (m) => onStatus && onStatus(m);
  const report = await dopplerFeeReport(asset);
  if (!report.found) throw new Error(report.reason);
  if (!report.hasHook) throw new Error(report.reason);

  const { account, wallet } = walletFor(privateKey);
  say('simulating collectFees...');
  const sim = await pub.simulateContract({
    address: getAddress(report.poolKey.hooks), abi: COLLECT_BY_POOL_ABI,
    functionName: 'collectFees', args: [report.poolId], account: account.address,
  });

  say('sending...');
  const hash = await wallet.writeContract(sim.request);
  say('waiting for confirmation...');
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('collectFees reverted: ' + hash);

  const [f0, f1] = sim.result ?? [0n, 0n];
  const collected = report.assetIsCurrency0 ? { asset: f0, numeraire: f1 } : { asset: f1, numeraire: f0 };
  return { hash, collected, buybackDst: report.buybackDst, report };
}

/// The Airlock owner's cut. Only they can take it - offered so the page can say
/// so honestly rather than showing a button that always reverts.
export async function claimAirlockOwnerFees({ privateKey, asset, onStatus }) {
  const say = (m) => onStatus && onStatus(m);
  const report = await dopplerFeeReport(asset);
  if (!report.hasHook) throw new Error(report.reason);

  const { account, wallet } = walletFor(privateKey);
  if (report.airlockOwner && account.address !== report.airlockOwner) {
    throw new Error(`only the Airlock owner (${report.airlockOwner}) can claim that share`);
  }
  say('simulating claimAirlockOwnerFees...');
  const sim = await pub.simulateContract({
    address: getAddress(report.hook), abi: CLAIM_OWNER_ABI,
    functionName: 'claimAirlockOwnerFees', args: [getAddress(asset)], account: account.address,
  });
  say('sending...');
  const hash = await wallet.writeContract(sim.request);
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('claimAirlockOwnerFees reverted: ' + hash);
  return { hash };
}
