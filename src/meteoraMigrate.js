import { Connection, Keypair, PublicKey, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

// ---------------------------------------------------------------------------
// Migrating a Meteora DBC coin - the third venue, after Pons and pump.fun.
//
// A DBC curve that fills does not migrate itself. Meteora's keeper normally
// cranks it, and when the keeper does not, the coin sits there with everything
// it raised locked in the virtual pool. Two of the launcher's own pools were
// found in exactly that state while this was written: stuck at
// migration_progress 2, one holding 85.000001 of its quote.
//
// Unlike the pump path, this does NOT hand-roll the instruction. Meteora's SDK
// is already a dependency and ships migrateToDammV2, and its account list was
// checked against a real migration rather than trusted: the SDK builds 26
// accounts, and the one the program's own IDL does not declare - index 25 - is
// the DAMM v2 migration fee config for the pool's migrationFeeOption, which is
// exactly what the real transaction passed. The real transaction carried two
// further accounts the SDK omits; simulating without them succeeds, so they are
// not required.
//
// PERMISSIONLESS, and proven rather than assumed: the migration simulates clean
// from an address that is neither the creator nor the fee claimer. That matters
// because the sibling venue is not - see raydiumMigrate.js for why Raydium
// LaunchLab cannot be done at all.
//
// What this does NOT do yet is attach a first buy. The pool a DBC migration
// creates is DAMM v2, a different program from PumpSwap with its own swap
// encoding, so the pump snipe does not carry over. Migration only, for now.
// ---------------------------------------------------------------------------

export const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
export const DAMM_V2_PROGRAM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

// VirtualPool, from the field order the on-chain IDL declares. Read off live
// accounts to confirm: base_mint at 136 and is_migrated at 305 both check out
// against pools known to be migrated and known not to be.
const VP_SIZE = 424;
const VP_CONFIG = 72;
const VP_CREATOR = 104;
const VP_BASE_MINT = 136;
const VP_QUOTE_RESERVE = 240;
const VP_IS_MIGRATED = 305;
const VP_MIGRATION_PROGRESS = 308;
const VP_FINISH_CURVE_TS = 344;

/// migration_progress, as the live pools use it: 0 while trading, 2 once the
/// curve has finished and the metadata exists, 3 once the DAMM pool is open.
/// A pool sitting at 2 is the one this tool is for.
export const PROGRESS = { TRADING: 0, READY: 2, DONE: 3 };

export function keypairFrom(secret) {
  const s = String(secret).trim();
  if (s.startsWith('[')) {
    const arr = Uint8Array.from(JSON.parse(s));
    if (arr.length !== 64) throw new Error('SOL key array must be 64 bytes');
    return Keypair.fromSecretKey(arr);
  }
  return Keypair.fromSecretKey(bs58.decode(s));
}

/// The virtual pool for a base mint, found by its stored base_mint rather than
/// by deriving an address - the derivation needs the config, which is the thing
/// we are trying to find.
export async function findVirtualPool(connection, mint) {
  const hits = await connection.getProgramAccounts(DBC_PROGRAM, {
    filters: [{ dataSize: VP_SIZE }, { memcmp: { offset: VP_BASE_MINT, bytes: new PublicKey(mint).toBase58() } }],
  });
  if (!hits.length) return null;
  const { pubkey, account } = hits[0];
  const d = account.data;
  return {
    address: pubkey,
    config: new PublicKey(d.subarray(VP_CONFIG, VP_CONFIG + 32)),
    creator: new PublicKey(d.subarray(VP_CREATOR, VP_CREATOR + 32)),
    baseMint: new PublicKey(d.subarray(VP_BASE_MINT, VP_BASE_MINT + 32)),
    quoteReserve: d.readBigUInt64LE(VP_QUOTE_RESERVE),
    isMigrated: d.readUInt8(VP_IS_MIGRATED) !== 0,
    migrationProgress: d.readUInt8(VP_MIGRATION_PROGRESS),
    finishCurveTimestamp: d.readBigUInt64LE(VP_FINISH_CURVE_TS),
  };
}

async function dammConfigFor(client, virtualPool) {
  const rawCfg = await client.state.getPoolConfig(virtualPool.config);
  const cfg = rawCfg?.poolConfig ?? rawCfg;
  const option = cfg?.migrationFeeOption;
  if (option == null) throw new Error('could not read the pool config migrationFeeOption');
  const address = DAMM_V2_MIGRATION_FEE_ADDRESS[option];
  if (!address) throw new Error('unknown migrationFeeOption ' + option);
  return { option, address, quoteMint: cfg.quoteMint, feeClaimer: cfg.feeClaimer };
}

/// What state this DBC coin is in and, by simulating, whether migrating it
/// would work. Read-only, and usable with no key.
export async function inspectMeteoraMigration({ rpcUrl, mint, user, connection: conn }) {
  const connection = conn || new Connection(rpcUrl, 'confirmed');
  const vp = await findVirtualPool(connection, mint);
  if (!vp) {
    return { venue: 'meteora', isMeteoraCoin: false, state: 'not-a-meteora-coin',
      reason: 'No Meteora DBC virtual pool exists for this mint.' };
  }

  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const damm = await dammConfigFor(client, vp);
  const quoteDecimals = (await connection.getParsedAccountInfo(damm.quoteMint))
    .value?.data?.parsed?.info?.decimals ?? null;

  const common = {
    venue: 'meteora', isMeteoraCoin: true,
    virtualPool: vp.address.toBase58(),
    config: vp.config.toBase58(),
    creator: vp.creator.toBase58(),
    quoteMint: damm.quoteMint.toBase58(),
    quoteDecimals,
    raisedQuote: vp.quoteReserve.toString(),
    migrationProgress: vp.migrationProgress,
    migrationFeeOption: damm.option,
    isNativeQuote: damm.quoteMint.toBase58() === 'So11111111111111111111111111111111111111112',
  };

  if (vp.isMigrated || vp.migrationProgress >= PROGRESS.DONE) {
    return { ...common, state: 'migrated', reason: 'This curve has already migrated to DAMM v2.' };
  }
  if (vp.finishCurveTimestamp === 0n) {
    return { ...common, state: 'on-curve',
      reason: 'The curve has not filled yet, so there is nothing to migrate.' };
  }

  // finished but not migrated: simulate rather than assume
  const probe = user ? new PublicKey(user) : new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
  const sim = await simulateMigration(connection, client, vp.address, damm.address, probe);
  return {
    ...common,
    state: sim.ok ? 'migratable' : 'blocked',
    reason: sim.ok ? null : 'It does not simulate cleanly: ' + sim.error + (sim.why ? ' - ' + sim.why : ''),
    simulation: { unitsConsumed: sim.unitsConsumed },
  };
}

async function simulateMigration(connection, client, pool, dammConfig, payer) {
  const res = await client.migration.migrateToDammV2({ payer, pool, dammConfig });
  const tx = res.transaction;
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const sim = await connection.simulateTransaction(tx, undefined);
  const logs = sim.value.logs || [];
  return {
    ok: !sim.value.err,
    error: sim.value.err ? JSON.stringify(sim.value.err) : null,
    why: logs.find((l) => /AnchorError/.test(l))?.replace(/^Program log: /, '') || null,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    logs,
  };
}

/// Migrate a stuck DBC curve into its DAMM v2 pool. Simulates first and refuses
/// on anything but a clean run - this opens a pool and moves everything the
/// curve raised.
export async function migrateMeteora({ rpcUrl, secretKey, mint, priorityMicroLamports = 200_000, onStatus }) {
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = keypairFrom(secretKey);
  const client = new DynamicBondingCurveClient(connection, 'confirmed');

  say('reading the curve...');
  const vp = await findVirtualPool(connection, mint);
  if (!vp) throw new Error('no Meteora DBC virtual pool exists for this mint');
  if (vp.isMigrated || vp.migrationProgress >= PROGRESS.DONE) {
    throw new Error('this curve has already migrated to DAMM v2');
  }
  if (vp.finishCurveTimestamp === 0n) throw new Error('the curve has not filled yet, so there is nothing to migrate');
  const damm = await dammConfigFor(client, vp);

  say('simulating...');
  const check = await simulateMigration(connection, client, vp.address, damm.address, payer.publicKey);
  if (!check.ok) throw new Error('the migration does not simulate: ' + check.error + (check.why ? ' - ' + check.why : ''));

  // Build again for sending: the position NFT mints are fresh keypairs, and the
  // pair that was simulated should not be the pair that is signed - a simulated
  // mint that then lands twice is a confusing failure.
  say('migrating...');
  const res = await client.migration.migrateToDammV2({
    payer: payer.publicKey, pool: vp.address, dammConfig: damm.address,
  });
  const tx = res.transaction;
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));
  const sig = await sendAndConfirmTransaction(
    connection, tx, [payer, res.firstPositionNftKeypair, res.secondPositionNftKeypair],
    { commitment: 'confirmed' },
  );

  return {
    venue: 'meteora', sig,
    virtualPool: vp.address.toBase58(),
    quoteMint: damm.quoteMint.toBase58(),
    raisedQuote: vp.quoteReserve.toString(),
    firstPositionNft: res.firstPositionNftKeypair.publicKey.toBase58(),
    secondPositionNft: res.secondPositionNftKeypair.publicKey.toBase58(),
  };
}

/// Every DBC pool this wallet created that has finished its curve and never
/// migrated. The launcher had two.
export async function findStuckMeteoraPools({ rpcUrl, creator, connection: conn }) {
  const connection = conn || new Connection(rpcUrl, 'confirmed');
  const hits = await connection.getProgramAccounts(DBC_PROGRAM, {
    filters: [{ dataSize: VP_SIZE }, { memcmp: { offset: VP_CREATOR, bytes: new PublicKey(creator).toBase58() } }],
  });
  return hits
    .map(({ pubkey, account }) => ({
      address: pubkey.toBase58(),
      baseMint: new PublicKey(account.data.subarray(VP_BASE_MINT, VP_BASE_MINT + 32)).toBase58(),
      quoteReserve: account.data.readBigUInt64LE(VP_QUOTE_RESERVE).toString(),
      isMigrated: account.data.readUInt8(VP_IS_MIGRATED) !== 0,
      migrationProgress: account.data.readUInt8(VP_MIGRATION_PROGRESS),
      finishCurveTimestamp: account.data.readBigUInt64LE(VP_FINISH_CURVE_TS).toString(),
    }))
    .filter((p) => !p.isMigrated && p.finishCurveTimestamp !== '0' && p.migrationProgress < PROGRESS.DONE);
}
