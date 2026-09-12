import { createPublicClient, createWalletClient, http, defineChain, parseEther, getAddress } from 'viem';
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

// The Rehype hook. FROGE's own state names 0x6f02324d...0F77, but that is the
// per-pool hook instance the initializer produced for FROGE - naming it here
// reverts with no data. The address to pass is the chain's Rehype hook module,
// which the initializer clones per pool. An earlier note in this file claimed
// the Rehype modules were NotWhitelisted on this Airlock; that is no longer
// true, and a launch naming this one simulates clean.
export const LONG_REHYPE_HOOK = ADDRESSES[4663].rehypeDopplerHook;

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

// The multicurve shape. Three things about it were established by simulating
// against the live Airlock rather than by reading anything:
//
//  - the shares must sum to exactly 1e18. Short of that the SDK quietly appends
//    a fallback curve running out to tick 887272, and the create reverts.
//  - the set needs the deep tail band underneath the opening tick. A set that
//    starts at the opening tick with nothing below it reverts every time.
//  - the opening tick has a ceiling somewhere between 64000 and 84100 for a 1B
//    supply; 64000 is the highest round value that simulates clean.
//
// FROGE itself opens around tick 84100 and its liquidity ran out past 887200,
// but its curves cannot be copied directly: it has already graduated, so those
// positions are burned and its pool retains only three initialized ticks. This
// is the widest shape the contract actually accepts. The old values here topped
// out at 39088, which is why a coin launched with them ran out of curve after
// roughly a 50x and priced strangely on the way there.
const OPENING_TICK = 64000;
const FLOOR_TICK = -887264;
const LONG_CURVE_BANDS = [
  { near: FLOOR_TICK, far: OPENING_TICK, numPositions: 1, shares: parseEther('0.35') },
  { near: OPENING_TICK, far: 120000, numPositions: 11, shares: parseEther('0.25') },
  { near: 90000, far: 200000, numPositions: 11, shares: parseEther('0.20') },
  { near: 120000, far: 348144, numPositions: 11, shares: parseEther('0.20') },
];

const TICK_SPACING = 8;
const DEFAULT_SUPPLY = parseEther('1000000000');

// The ticks are given in price space - distance above the opening price - and
// the initializer converts them into the pool's own tick space itself, which is
// why every pool launched this way reads back a negative current tick whichever
// side of the numeraire the new token lands on. They are passed as written.
//
// farTick is deliberately not set here. Left alone the SDK derives it from the
// curves, which is what the launches that simulate clean do; FROGE's stored
// +887256 belongs to a curve set that no longer exists on chain.
function longCurves() {
  return LONG_CURVE_BANDS.map(({ near, far, numPositions, shares }) => ({
    tickLower: near,
    tickUpper: far,
    numPositions,
    shares,
  }));
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
  say(`curve opens at tick ${OPENING_TICK} and runs out at ${LONG_CURVE_BANDS[LONG_CURVE_BANDS.length - 1].far}`);

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
    // fee is left at 0 here on purpose: naming a Rehype hook makes the pool a
    // dynamic-fee pool, and both the SDK and the initializer set the flag
    // themselves. FROGE's pool key reads back fee = 0x800000.
    .poolConfig({ fee: 0, tickSpacing: TICK_SPACING, curves, beneficiaries })
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

  // simulate before spending anything, and use the predicted token address
  say('simulating launch...');
  const sim = await sdk.factory.simulateCreateMulticurve(params);
  const predicted = sim?.tokenAddress ?? null;
  if (dryRun) {
    say(`simulation passed - would launch ${predicted}`);
    return { token: predicted, hash: null, dryRun: true };
  }

  say('sending launch tx...');
  const res = await sdk.factory.createMulticurve(params);
  const hash = typeof res === 'string' ? res : (res?.hash ?? res?.transactionHash ?? null);

  if (hash) {
    say('waiting for confirmation...');
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error('launch tx reverted: ' + hash);
  }

  return { token: res?.tokenAddress ?? predicted, hash };
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
  const expectedReach = LONG_CURVE_BANDS[LONG_CURVE_BANDS.length - 1].far;
  if (Math.abs(state.farTick) < expectedReach - TICK_SPACING) {
    problems.push(`curve only reaches tick ${state.farTick} - it should reach about ${expectedReach}`);
  }

  return { ...state, looksLikeLong: problems.length === 0, problems };
}
