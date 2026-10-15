// Solana Mimic: launch a coin with the same curve as one you can see.
//
// Paste a mint. If it came from Raydium LaunchLab (raydium.io, bonk.fun,
// StonkFun - one program) or Meteora's Dynamic Bonding Curve, its curve is
// read off the chain and handed to the launch paths that already exist:
//
//   LaunchLab  the curve is per-launch - supply, the amount sold on the curve,
//              the raise, decimals, vesting, the migration target - and the
//              pool keeps all of it. It is passed to launchRaydium verbatim,
//              under the same platform and quote (or another platform you pick).
//
//   DBC        the curve lives in a config account the pool points at, not in
//              the launch. Two ways to copy it:
//                clone  translate their config into create_config parameters
//                       and create one of your own - same curve, same fees,
//                       same migration, but the fee claimer is you
//                reuse  open your pool on THEIR config - nothing to create,
//                       but their config decides who claims the fees
//
// The EVM Mimic recovers a whole call because a factory call is one opaque
// blob; here the two programs are known, so their own layouts do the work and
// nothing is guessed.

import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, unpackMint, getTransferFeeConfig, getTokenMetadata, getExtensionTypes, ExtensionType } from '@solana/spl-token';
import BN from 'bn.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { findLaunchpadPool, readPlatformConfig, solTokenMetadata } from './solana.js';

const conn = (rpc) => (typeof rpc === 'string' ? new Connection(rpc, 'confirmed') : rpc);
const str = (v) => (v == null ? '0' : BN.isBN(v) ? v.toString() : String(v));

/// Name, ticker and URI from Metaplex, or from the mint itself for Token-2022.
async function metadataOf(connection, mint, mintInfo) {
  const mp = await solTokenMetadata(mint, connection.rpcEndpoint).catch(() => null);
  if (mp?.name) return mp;
  if (mintInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID)) {
    const m = await getTokenMetadata(connection, new PublicKey(mint), 'confirmed', TOKEN_2022_PROGRAM_ID).catch(() => null);
    if (m) return { name: m.name, symbol: m.symbol, uri: m.uri };
  }
  return null;
}

// --- DBC: a pool config as create_config parameters --------------------------
//
// PoolConfig (what the program stores) and ConfigParameters (what create_config
// takes) are the same numbers in two layouts. Field by field, from the IDL:
// the base fee drops its padding, the dynamic fee becomes an Option keyed on
// `initialized`, the curve is the non-zero prefix of a fixed 20-slot array,
// the supply is an Option keyed on fixed_token_supply_flag, and the migrated
// pool's market-cap fee scheduler sits packed in 16 raw bytes.
export function configParamsFromPoolConfig(cfg) {
  const bf = cfg.poolFees.baseFee;
  const df = cfg.poolFees.dynamicFee;
  const lv = cfg.lockedVestingConfig;
  const vest = (v) => ({
    vestingPercentage: v.vestingPercentage,
    bpsPerPeriod: v.bpsPerPeriod,
    numberOfPeriods: v.numberOfPeriods,
    cliffDurationFromMigrationTime: v.cliffDurationFromMigrationTime,
    frequency: v.frequency,
  });
  const sched = Buffer.from(cfg.migratedPoolBaseFeeBytes || new Array(16).fill(0));
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: bf.cliffFeeNumerator,
        firstFactor: bf.firstFactor,
        secondFactor: bf.secondFactor,
        thirdFactor: bf.thirdFactor,
        baseFeeMode: bf.baseFeeMode,
      },
      dynamicFee: df.initialized ? {
        binStep: df.binStep,
        binStepU128: df.binStepU128,
        filterPeriod: df.filterPeriod,
        decayPeriod: df.decayPeriod,
        reductionFactor: df.reductionFactor,
        maxVolatilityAccumulator: df.maxVolatilityAccumulator,
        variableFeeControl: df.variableFeeControl,
      } : null,
    },
    collectFeeMode: cfg.collectFeeMode,
    migrationOption: cfg.migrationOption,
    activationType: cfg.activationType,
    tokenType: cfg.tokenType,
    tokenDecimal: cfg.tokenDecimal,
    partnerLiquidityPercentage: cfg.partnerLiquidityPercentage,
    partnerPermanentLockedLiquidityPercentage: cfg.partnerPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: cfg.creatorLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: cfg.creatorPermanentLockedLiquidityPercentage,
    migrationQuoteThreshold: cfg.migrationQuoteThreshold,
    sqrtStartPrice: cfg.sqrtStartPrice,
    lockedVesting: {
      amountPerPeriod: lv.amountPerPeriod,
      cliffDurationFromMigrationTime: lv.cliffDurationFromMigrationTime,
      frequency: lv.frequency,
      numberOfPeriod: lv.numberOfPeriod,
      cliffUnlockAmount: lv.cliffUnlockAmount,
    },
    migrationFeeOption: cfg.migrationFeeOption,
    tokenSupply: cfg.fixedTokenSupplyFlag
      ? { preMigrationTokenSupply: cfg.preMigrationTokenSupply, postMigrationTokenSupply: cfg.postMigrationTokenSupply }
      : null,
    creatorTradingFeePercentage: cfg.creatorTradingFeePercentage,
    tokenUpdateAuthority: cfg.tokenUpdateAuthority,
    migrationFee: { feePercentage: cfg.migrationFeePercentage, creatorFeePercentage: cfg.creatorMigrationFeePercentage },
    migratedPoolFee: {
      collectFeeMode: cfg.migratedCollectFeeMode,
      dynamicFee: cfg.migratedDynamicFee,
      poolFeeBps: cfg.migratedPoolFeeBps,
    },
    poolCreationFee: cfg.poolCreationFee,
    partnerLiquidityVestingInfo: vest(cfg.partnerLiquidityVestingInfo),
    creatorLiquidityVestingInfo: vest(cfg.creatorLiquidityVestingInfo),
    migratedPoolBaseFeeMode: cfg.migratedPoolBaseFeeMode,
    migratedPoolMarketCapFeeSchedulerParams: {
      numberOfPeriod: sched.readUInt16LE(0),
      sqrtPriceStepBps: sched.readUInt16LE(2),
      schedulerExpirationDuration: sched.readUInt32LE(4),
      reductionFactor: new BN(sched.subarray(8, 16), 'le'),
    },
    enableFirstSwapWithMinFee: !!cfg.enableFirstSwapWithMinFee,
    compoundingFeeBps: cfg.migratedCompoundingFeeBps,
    padding: [0, 0],
    curve: cfg.curve.filter((p) => !new BN(p.sqrtPrice).isZero()).map((p) => ({ sqrtPrice: p.sqrtPrice, liquidity: p.liquidity })),
  };
}

// Everything in a config that makes the curve and its economics, as strings -
// what a clone must reproduce. The fee claimer and leftover receiver are left
// out on purpose: those are the two things a clone changes.
const CURVE_FIELDS = [
  'quoteMint', 'collectFeeMode', 'migrationOption', 'activationType', 'tokenDecimal', 'tokenType',
  'partnerPermanentLockedLiquidityPercentage', 'partnerLiquidityPercentage',
  'creatorPermanentLockedLiquidityPercentage', 'creatorLiquidityPercentage', 'migrationFeeOption',
  'fixedTokenSupplyFlag', 'creatorTradingFeePercentage', 'tokenUpdateAuthority', 'migrationFeePercentage',
  'creatorMigrationFeePercentage', 'swapBaseAmount', 'migrationQuoteThreshold', 'migrationBaseThreshold',
  'migrationSqrtPrice', 'preMigrationTokenSupply', 'postMigrationTokenSupply', 'migratedCollectFeeMode',
  'migratedDynamicFee', 'migratedPoolFeeBps', 'migratedPoolBaseFeeMode', 'enableFirstSwapWithMinFee',
  'migratedCompoundingFeeBps', 'poolCreationFee', 'sqrtStartPrice',
];
const flat = (v) => JSON.stringify(v, (k, x) => (BN.isBN(x) ? x.toString() : x instanceof PublicKey ? x.toBase58() : x));

/// The fields where two configs differ, curve and fees included; [] = same curve.
export function diffPoolConfigs(a, b) {
  const out = [];
  for (const f of CURVE_FIELDS) if (flat(a[f]) !== flat(b[f])) out.push(f);
  for (const f of ['poolFees', 'lockedVestingConfig', 'partnerLiquidityVestingInfo', 'creatorLiquidityVestingInfo', 'curve', 'migratedPoolBaseFeeBytes']) {
    if (flat(a[f]) !== flat(b[f])) out.push(f);
  }
  return out;
}

// --- what a coin was launched on ---------------------------------------------

/// A quote's ticker, wherever its metadata lives.
async function symbolOf(connection, mint) {
  if (String(mint) === 'So11111111111111111111111111111111111111112') return 'SOL';
  const pk = new PublicKey(mint);
  const info = await connection.getAccountInfo(pk).catch(() => null);
  const m = info ? await metadataOf(connection, pk, info).catch(() => null) : null;
  return m?.symbol || String(mint).slice(0, 6) + '…';
}

/// Read a Solana coin's launch: which program, which curve, which quote. Returns
///   { kind: 'launchlab' | 'dbc', ... }   or   { kind: null, reason }
export async function inspectSolCoin(rpc, mintAddress, { onProgress } = {}) {
  const connection = conn(rpc);
  const say = (m) => onProgress?.(m);
  const mint = new PublicKey(mintAddress);
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error('no account at that address on Solana');
  let unpacked = null;
  try { unpacked = unpackMint(mint, mintInfo, mintInfo.owner); } catch { /* not a mint */ }
  if (!unpacked) throw new Error('that address is not a token mint');
  const meta = await metadataOf(connection, mint, mintInfo);
  const token2022 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
  const fee = token2022 ? getTransferFeeConfig(unpacked) : null;
  const transferFeeBps = fee ? fee.newerTransferFee.transferFeeBasisPoints : 0;
  const maxTransferFee = fee ? fee.newerTransferFee.maximumFee.toString() : null;
  const base = {
    mint: mint.toBase58(), name: meta?.name ?? null, symbol: meta?.symbol ?? null, uri: meta?.uri ?? null,
    decimals: unpacked.decimals, supply: unpacked.supply.toString(), token2022, transferFeeBps, maxTransferFee,
  };

  // LaunchLab: the pool PDA is (mint, quote); try every quote that has a config
  say('looking for a LaunchLab pool…');
  const ll = await findLaunchpadPool(connection, mint).catch(() => null);
  if (ll) {
    const p = ll.poolInfo;
    const platform = await readPlatformConfig(connection, p.platformId).catch(() => null);
    return {
      ...base,
      kind: 'launchlab',
      program: 'Raydium LaunchLab',
      pool: ll.poolId.toBase58(),
      quoteMint: p.mintB.toBase58(),
      quoteSymbol: await symbolOf(connection, p.mintB),
      quoteDecimals: p.mintDecimalsB,
      configId: p.configId.toBase58(),
      platformId: p.platformId.toBase58(),
      platformName: platform?.name || null,
      platformCommunity: !!platform?.community,
      creator: p.creator.toBase58(),
      graduated: p.status !== 0,
      migrateType: p.migrateType === 0 ? 'amm' : 'cpmm',
      creatorFeeOn: p.cpmmCreatorFeeOn,
      curve: {
        supply: str(p.supply),
        totalSellA: str(p.totalSellA),
        totalFundRaisingB: str(p.totalFundRaisingB),
        totalLockedAmount: str(p.vestingSchedule?.totalLockedAmount),
        cliffPeriod: str(p.vestingSchedule?.cliffPeriod),
        unlockPeriod: str(p.vestingSchedule?.unlockPeriod),
        decimals: p.mintDecimalsA,
      },
    };
  }

  // DBC: one pool per base mint, found by the program's own index
  say('looking for a Meteora DBC pool…');
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const dp = await client.state.getPoolByBaseMint(mint).catch(() => null);
  const state = dp?.account?.poolState || dp?.account;
  if (dp && state?.config) {
    const configKey = state.config;
    const cfg = await client.state.getPoolConfig(configKey);
    if (!cfg) throw new Error(`its DBC config ${configKey.toBase58()} could not be read`);
    const hooked = token2022 && unpacked.tlvData?.length && getExtensionTypes(unpacked.tlvData).includes(ExtensionType.TransferHook);
    if (hooked) {
      return { ...base, kind: null, reason: 'this DBC coin uses a transfer hook, which Mimic does not copy yet' };
    }
    const quoteInfo = await connection.getAccountInfo(cfg.quoteMint);
    return {
      ...base,
      kind: 'dbc',
      quoteDecimals: quoteInfo ? quoteInfo.data[44] : null,
      quoteSymbol: await symbolOf(connection, cfg.quoteMint),
      program: 'Meteora DBC',
      pool: dp.publicKey.toBase58(),
      config: configKey.toBase58(),
      quoteMint: cfg.quoteMint.toBase58(),
      creator: state.creator?.toBase58?.() ?? null,
      feeClaimer: cfg.feeClaimer.toBase58(),
      leftoverReceiver: cfg.leftoverReceiver.toBase58(),
      graduated: !!state.isMigrated,
      baseToken2022: cfg.tokenType === 1,
      poolConfig: cfg,
      configParams: configParamsFromPoolConfig(cfg),
      summary: {
        tokenDecimal: cfg.tokenDecimal,
        supply: cfg.fixedTokenSupplyFlag ? cfg.preMigrationTokenSupply.toString() : null,
        migrationQuoteThreshold: cfg.migrationQuoteThreshold.toString(),
        curvePoints: cfg.curve.filter((x) => !new BN(x.sqrtPrice).isZero()).length,
        creatorTradingFeePercentage: cfg.creatorTradingFeePercentage,
        poolCreationFee: cfg.poolCreationFee.toString(),
      },
    };
  }

  const pumpish = /pump$/.test(mint.toBase58());
  return {
    ...base,
    kind: null,
    reason: pumpish
      ? 'this looks like a pump.fun coin - use the pump.fun pad, which already launches the same curve'
      : 'no Raydium LaunchLab or Meteora DBC pool found for this mint - Solana Mimic copies those two today',
  };
}
