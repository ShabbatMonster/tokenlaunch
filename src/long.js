import {
  createPublicClient, createWalletClient, http, defineChain, parseEther, getAddress,
  encodeAbiParameters,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DopplerSDK, ADDRESSES,
  getAirlockOwner, createAirlockBeneficiary, sortBeneficiaries,
  DEFAULT_AIRLOCK_BENEFICIARY_SHARES, WAD,
} from '@whetstone-research/doppler-sdk/evm';

// ---------------------------------------------------------------------------
// long.xyz - a Doppler v4 launchpad on Robinhood Chain that pairs new tokens
// against tokenized stocks instead of ETH.
//
// Launching goes through the Doppler Airlock, which is permissionless as long
// as every module you name is whitelisted on it. Verified on-chain:
//
//   Airlock            0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862
//   tokenFactory       DopplerERC20V1Factory      whitelisted
//   poolInitializer    DopplerHookInitializer     whitelisted
//   governanceFactory  NoOpGovernanceFactory      whitelisted
//   liquidityMigrator  NoOpMigrator               whitelisted
//
// Everything below is copied from a live, healthy long.xyz launch rather than
// guessed. The reference is FROGE:
//
//   asset      0x990FB9D2986458788e3cB71AB4b3AD49213E1E18
//   numeraire  0xfe09Fb328bE1c286B4f597eD34764b7472ae72c5  (OPENAIx1L)
//
// read back out of DopplerHookInitializer.getState(asset) and out of the
// Rehype hook's own per-pool getters. A launch that skips any of this still
// "succeeds" on-chain but produces a pool that does not behave like a long.xyz
// coin at all - that was the bug this file used to have.
// ---------------------------------------------------------------------------

const CHAIN_ID = 4663;
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN = defineChain({
  id: CHAIN_ID, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

// The Rehype hook every long.xyz coin runs behind. Both FROGE and PDOOM
// (0x4c3A5652...) name this same address, so it is the shared hook, not a
// per-pool instance - an earlier guess here that it was per-pool, and that the
// SDK's rehypeDopplerHook should be used instead, was wrong and produced pools
// that were not long.xyz coins.
export const LONG_REHYPE_HOOK = '0x6f02324d20CC679d0E585290CAa6b16baCbC0F77';

// the Airlock every long.xyz coin is created through
const AIRLOCK = '0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862';

// FROGE's live fee schedule: an 80% tax on the first trade decaying to 1.12%
// over ten seconds. 800000 is the protocol's maximum start fee.
const REHYPE_START_FEE = 800000;
const REHYPE_END_FEE = 11200;
const REHYPE_DECAY_SECONDS = 10;

// FROGE's live fee split, in wad. Every fee collected, on both sides of the
// pool, is spent buying the paired stock - that is the whole point of long.xyz,
// and it is what the zero-fee pools this file used to make were missing.
const REHYPE_FEES_ALL_TO_STOCK = {
  assetFeesToAssetBuybackWad: 0n,
  assetFeesToNumeraireBuybackWad: 10n ** 18n,
  assetFeesToBeneficiaryWad: 0n,
  assetFeesToLpWad: 0n,
  numeraireFeesToAssetBuybackWad: 0n,
  numeraireFeesToNumeraireBuybackWad: 10n ** 18n,
  numeraireFeesToBeneficiaryWad: 0n,
  numeraireFeesToLpWad: 0n,
};

// The curve, copied from a long.xyz launch rather than worked out from first
// principles - which is what went wrong before. PDOOM (p(doom), 0x4c3A5652...)
// was launched through long.xyz's own router on 2026-09-12, and its Airlock
// call carries exactly this:
//
//   fee 2000, tickSpacing 8, farTick 887256
//   curves: [-108088, 2344]  1 position  40%
//           [  2344, 887264] 1 position  60%
//
// Two curves, ONE position each. That last part matters: this file previously
// used eleven positions per band, which packs enough liquidity into each to
// break the uint128 limit near the top of the range - which is why reaching
// 887264 looked impossible and the curve got capped at 348144 instead. With a
// single position per curve it reaches the full range comfortably.
//
// The fee is 2000, not 0. The pool still reads back as a dynamic-fee pool
// because the hook owns the rate, but 2000 is the value long.xyz passes and the
// lpFee FROGE's pool reports.
const LONG_CURVES = [
  { tickLower: -108088, tickUpper: 2344, numPositions: 1, shares: parseEther('0.40') },
  { tickLower: 2344, tickUpper: 887264, numPositions: 1, shares: parseEther('0.60') },
];

// Passed as written; the initializer flips the sign itself when the new token
// sorts above the numeraire. PDOOM passes +887256 and reads back -887256.
const LONG_FAR_TICK = 887256;
const LONG_POOL_FEE = 2000;

const TICK_SPACING = 8;
const DEFAULT_SUPPLY = parseEther('1000000000');

// The initializer's own argument blob. Encoded here rather than by the SDK
// because the SDK and the deployed contracts disagree about one field.
const POOL_INITIALIZER_DATA_ABI = [{ type: 'tuple', components: [
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'farTick', type: 'int24' },
  { name: 'curves', type: 'tuple[]', components: [
    { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' },
    { name: 'numPositions', type: 'uint16' }, { name: 'shares', type: 'uint256' },
  ] },
  { name: 'beneficiaries', type: 'tuple[]', components: [
    { name: 'beneficiary', type: 'address' }, { name: 'shares', type: 'uint96' },
  ] },
  { name: 'dopplerHook', type: 'address' },
  { name: 'onInitializationDopplerHookCalldata', type: 'bytes' },
  { name: 'graduationDopplerHookCalldata', type: 'bytes' },
] }];

// The live hook reads fifteen flat words. The SDK's encoder wraps them in a
// tuple with a feeBeneficiaries array on the end, which adds a leading offset
// word and two array words - three extra words that shift every offset after
// them, so the hook reads the wrong fields. PDOOM's calldata is 480 bytes; the
// SDK's is 576. Encoded by hand to match the chain.
const REHYPE_CALLDATA_ABI = [
  { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'uint24' },
  { type: 'uint32' }, { type: 'uint32' }, { type: 'uint8' },
  { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
  { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
];

function encodeRehypeCalldata(numeraire, buybackDst) {
  const d = REHYPE_FEES_ALL_TO_STOCK;
  return encodeAbiParameters(REHYPE_CALLDATA_ABI, [
    numeraire, buybackDst,
    REHYPE_START_FEE, REHYPE_END_FEE, REHYPE_DECAY_SECONDS,
    0, 0,
    d.assetFeesToAssetBuybackWad, d.assetFeesToNumeraireBuybackWad,
    d.assetFeesToBeneficiaryWad, d.assetFeesToLpWad,
    d.numeraireFeesToAssetBuybackWad, d.numeraireFeesToNumeraireBuybackWad,
    d.numeraireFeesToBeneficiaryWad, d.numeraireFeesToLpWad,
  ]);
}

function encodePoolInitializerData(numeraire, buybackDst, beneficiaries) {
  return encodeAbiParameters(POOL_INITIALIZER_DATA_ABI, [{
    fee: LONG_POOL_FEE,
    tickSpacing: TICK_SPACING,
    farTick: LONG_FAR_TICK,
    curves: longCurves(),
    beneficiaries,
    dopplerHook: getAddress(LONG_REHYPE_HOOK),
    onInitializationDopplerHookCalldata: encodeRehypeCalldata(numeraire, buybackDst),
    graduationDopplerHookCalldata: '0x',
  }]);
}

const AIRLOCK_CREATE_ABI = [{
  type: 'function', name: 'create', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'initialSupply', type: 'uint256' }, { name: 'numTokensToSell', type: 'uint256' },
    { name: 'numeraire', type: 'address' }, { name: 'tokenFactory', type: 'address' },
    { name: 'tokenFactoryData', type: 'bytes' }, { name: 'governanceFactory', type: 'address' },
    { name: 'governanceFactoryData', type: 'bytes' }, { name: 'poolInitializer', type: 'address' },
    { name: 'poolInitializerData', type: 'bytes' }, { name: 'liquidityMigrator', type: 'address' },
    { name: 'liquidityMigratorData', type: 'bytes' }, { name: 'integrator', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ] }],
  outputs: [
    { name: 'asset', type: 'address' }, { name: 'pool', type: 'address' },
    { name: 'governance', type: 'address' }, { name: 'timelock', type: 'address' },
    { name: 'migrationPool', type: 'address' },
  ],
}];

function longCurves() {
  return LONG_CURVES.map((c) => ({ ...c }));
}

/// Launch a token on long.xyz's Airlock, paired against `numeraire`.
/// Returns { token, hash }.
export async function launchLong(opts) {
  const {
    privateKey, name, symbol, tokenURI,
    numeraire, supplyTokens, buybackDestination, dryRun, onStatus,
  } = opts;
  const say = (m) => onStatus && onStatus(m);

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });

  const quote = getAddress(numeraire);
  const initialSupply = supplyTokens ? parseEther(String(supplyTokens)) : DEFAULT_SUPPLY;
  // FROGE puts its entire supply on the curve. Holding part of it back leaves a
  // premined block sitting outside the pool and shifts the opening price.
  const numTokensToSell = initialSupply;

  const curves = longCurves();
  say(`curve runs ${curves[0].tickLower} to ${curves[curves.length - 1].tickUpper}, far tick ${LONG_FAR_TICK}`);

  say('loading Doppler SDK...');
  const sdk = new DopplerSDK({ publicClient, walletClient, chainId: CHAIN_ID });
  const addrs = ADDRESSES[CHAIN_ID];

  // The no-op migrator will not accept a pool with no beneficiaries: nothing
  // would be able to claim the position once the curve is exhausted, and the
  // migrate() call would revert with the whole launch. The Airlock owner has to
  // be on the list and takes the protocol's 5%; the remainder is yours. None of
  // this is where the trading fees go - the Rehype split above sends 100% of
  // those into the stock - this only decides who owns the position itself.
  say('resolving pool beneficiaries...');
  const airlockOwner = await getAirlockOwner(publicClient);
  const beneficiaries = sortBeneficiaries([
    createAirlockBeneficiary(getAddress(airlockOwner)),
    { beneficiary: account.address, shares: WAD - DEFAULT_AIRLOCK_BENEFICIARY_SHARES },
  ]);

  say('building launch params (mining the v4 hook salt)...');
  const params = sdk.buildMulticurveAuction()
    .tokenConfig({ name, symbol, tokenURI: tokenURI || '' })
    .saleConfig({ initialSupply, numTokensToSell, numeraire: quote })
    .poolConfig({ fee: LONG_POOL_FEE, tickSpacing: TICK_SPACING, curves, beneficiaries })
    .withDopplerHookInitializer(addrs.dopplerHookInitializer)
    .withRehypeDopplerHookInitializer({
      hookAddress: getAddress(LONG_REHYPE_HOOK),
      startFee: REHYPE_START_FEE,
      endFee: REHYPE_END_FEE,
      durationSeconds: REHYPE_DECAY_SECONDS,
      feeRoutingMode: 'directBuyback',
      feeDistributionInfo: REHYPE_FEES_ALL_TO_STOCK,
      // whoever this is controls the fee split afterwards and receives the
      // bought-back stock, so it defaults to you rather than to the launchpad.
      buybackDestination: getAddress(buybackDestination || account.address),
      farTick: LONG_FAR_TICK,
    })
    // FROGE never graduates out: its liquidity stays in the v4 multicurve pool
    // and the Rehype hook keeps recycling fees into the stock. Migrating into a
    // Uniswap v2 pair instead - which is what this used to do - drains the
    // curve into a plain constant-product pool and kills the buyback. FROGE's
    // Airlock record names the no-op migrator and a dead migration pool.
    .withMigration({ type: 'noOp' })
    .withGovernance({ type: 'noOp' })
    .withUserAddress(account.address)
    .withIntegrator(account.address)
    .build();

  // The SDK is used for everything that is not the initializer blob - the token
  // factory data, the governance data, and the mined salt - and then its
  // poolInitializerData is replaced with one encoded here. Its own encoder
  // disagrees with the deployed hook about the Rehype calldata layout, which is
  // the difference between a long.xyz coin and whatever this file made before.
  say('encoding the launch...');
  const createParams = await sdk.factory.encodeCreateMulticurveParams(params);
  const built = { ...(createParams.createParams ?? createParams) };
  built.poolInitializerData = encodePoolInitializerData(
    quote, getAddress(buybackDestination || account.address), beneficiaries,
  );
  built.integrator = account.address;

  say('simulating launch...');
  const { result } = await publicClient.simulateContract({
    address: getAddress(AIRLOCK), abi: AIRLOCK_CREATE_ABI,
    functionName: 'create', args: [built], account,
  });
  const predicted = Array.isArray(result) ? result[0] : result?.asset ?? null;

  if (dryRun) {
    say(`simulation passed - would launch ${predicted}`);
    return { token: predicted, hash: null, dryRun: true, poolInitializerData: built.poolInitializerData };
  }

  say('sending launch tx...');
  const hash = await walletClient.writeContract({
    address: getAddress(AIRLOCK), abi: AIRLOCK_CREATE_ABI,
    functionName: 'create', args: [built], account,
  });

  say('waiting for confirmation...');
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('launch tx reverted: ' + hash);

  return { token: predicted, hash };
}

// ---------------------------------------------------------------------------
// After the fact: read a long.xyz coin's pool back and say whether it came out
// shaped like FROGE. Worth having, because a misconfigured launch does not
// revert - it just quietly produces a pool nobody can trade properly.
// ---------------------------------------------------------------------------

const INITIALIZER_STATE_ABI = [{
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

const DYNAMIC_FEE = 0x800000;
const ZERO = '0x0000000000000000000000000000000000000000';

/// Inspect a launched token and report how it differs from a long.xyz coin.
export async function inspectLong(tokenAddress) {
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC) });
  const addrs = ADDRESSES[CHAIN_ID];
  const asset = getAddress(tokenAddress);

  const s = await publicClient.readContract({
    address: getAddress(addrs.dopplerHookInitializer),
    abi: INITIALIZER_STATE_ABI, functionName: 'getState', args: [asset],
  });

  const state = {
    numeraire: s[0],
    tokensOnCurve: s[1],
    dopplerHook: s[2],
    poolFee: Number(s[5].fee),
    tickSpacing: Number(s[5].tickSpacing),
    farTick: Number(s[6]),
  };

  const problems = [];
  if (state.dopplerHook.toLowerCase() === ZERO) {
    problems.push('no Rehype hook - trading fees are not being recycled into the paired stock');
  }
  if (state.poolFee !== DYNAMIC_FEE) {
    problems.push(`pool fee is static (${state.poolFee}) - a long.xyz coin uses a dynamic fee`);
  }
  if (Math.abs(state.farTick) !== LONG_FAR_TICK) {
    problems.push(`far tick is ${state.farTick} - a long.xyz coin reads back plus or minus ${LONG_FAR_TICK}`);
  }

  return { ...state, looksLikeLong: problems.length === 0, problems };
}
