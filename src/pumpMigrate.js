import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SystemProgram, SYSVAR_RENT_PUBKEY, sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Migrating a pump.fun coin - the same job force-migrate.js does for Pons v2.
//
// A pump curve stops trading the moment it fills ("complete"), and the coin is
// dead until somebody calls migrate_v2, which drains the curve into a fresh
// PumpSwap pool. pump's own bot normally does it within seconds; when it does
// not, the coin sits there un-tradeable with everything it raised locked in the
// curve. This calls it.
//
// The instruction takes NO arguments - just the 8-byte discriminator - so the
// whole job is the account list, and the account list is where the traps are.
//
// TRAP 1: the IDL is behind the deployed program. pump publishes an on-chain
// Anchor IDL (AYgC53tU...) declaring 27 accounts for migrate_v2. Every real
// migration passes TWENTY-NINE. The two extra ones are PumpSwap's boost vault
// and its quote account - the program sends part of the raised quote into them,
// which PumpSwap later spends in BoostBuyAndBurn - and they appear in no IDL at
// all. Read off real migrations: 3J95FU1yfxWk... (SOL-quoted) and
// 5s1H5vwTzMpf... (CbcyNo7m-quoted).
//
// TRAP 2: `user_pool_token_account` is not the user's. Despite the name it is
// the POOL AUTHORITY's associated account for the LP mint, which is where the LP
// is minted and then burnt. Deriving it from the signer - which is what the name
// invites - gives a wrong address on every migration. It also means migrating
// somebody else's coin hands you no LP: the liquidity is locked, not collected.
//
// TRAP 3: the quote mint is not always wrapped SOL, and its token program is not
// always the classic one. A paired coin (GacgmKku...) quotes against a
// Token-2022 mint, so base_token_program and quote_token_program differ from
// each other and from what a SOL-only build would hardcode.
//
// Every one of the 29 accounts is derived from the mint alone, and the
// derivation is checked against both real migrations in
// test/js/pump-migrate-accounts.test.mjs.
//
// Nothing here bypasses a permission: migrate_v2 is the same call pump's own bot
// makes, and the curve still has to have completed. The page simulates before it
// offers a button, so an unmigratable coin shows a reason instead.
// ---------------------------------------------------------------------------

export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
/// A curve with no paired quote stores the all-zero key, which means wrapped SOL.
const NATIVE_SENTINEL = new PublicKey('11111111111111111111111111111111');

/// migrate_v2. The legacy `migrate` (9beae792ec9ea21e) is the SOL-only path and
/// is not used here: live coins, paired or not, migrate through v2.
const MIGRATE_V2_DISC = Buffer.from('bbcb121fceedfe29', 'hex');

// Global, at the offsets the IDL's own field order gives:
//   113 withdraw_authority   145 enable_migrate   146 pool_migration_fee
const GLOBAL_WITHDRAW_AUTHORITY = 113;
const GLOBAL_ENABLE_MIGRATE = 145;
const GLOBAL_POOL_MIGRATION_FEE = 146;

// BondingCurve
const CURVE_VIRTUAL_TOKEN = 8;
const CURVE_VIRTUAL_QUOTE = 16;
const CURVE_REAL_TOKEN = 24;
const CURVE_REAL_QUOTE = 32;
const CURVE_TOTAL_SUPPLY = 40;
const CURVE_COMPLETE = 48;
const CURVE_CREATOR = 49;
const CURVE_QUOTE_MINT = 83;

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
const ataOf = (owner, mint, tokenProgram) => pda(
  [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM,
);
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const key = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

export const pumpGlobal = () => pda([Buffer.from('global')], PUMP_PROGRAM);
export const pumpCurveAddress = (mint) => pda([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM);
/// Not a PumpSwap PDA: the pool's own `creator` field is this pump-side authority.
export const poolAuthorityFor = (mint) => pda([Buffer.from('pool-authority'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM);
export const pumpPoolAddress = (poolAuthority, baseMint, quoteMint) => pda(
  [Buffer.from('pool'), u16le(0), poolAuthority.toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()], PUMP_AMM,
);
export const lpMintFor = (pool) => pda([Buffer.from('pool_lp_mint'), pool.toBuffer()], PUMP_AMM);
/// Where migrate_v2 sends the slice of raised quote that PumpSwap later spends
/// in BoostBuyAndBurn. Undeclared in either program's IDL.
export const boostVaultFor = (pool) => pda([Buffer.from('boost_vault'), pool.toBuffer()], PUMP_AMM);

async function ownerProgramOf(connection, mint) {
  const info = await connection.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error('mint not found on-chain: ' + String(mint));
  return info.owner.equals(TOKEN_2022) ? TOKEN_2022 : TOKEN_PROGRAM;
}

/// The curve as the program stores it. Null when this mint never was a pump coin.
export async function readPumpCurve(connection, mint) {
  const address = pumpCurveAddress(mint);
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info) return null;
  const d = info.data;
  const storedQuote = d.length >= CURVE_QUOTE_MINT + 32
    ? new PublicKey(d.subarray(CURVE_QUOTE_MINT, CURVE_QUOTE_MINT + 32))
    : NATIVE_SENTINEL;
  const isNativeQuote = storedQuote.equals(NATIVE_SENTINEL);
  return {
    address,
    virtualTokenReserves: d.readBigUInt64LE(CURVE_VIRTUAL_TOKEN),
    virtualQuoteReserves: d.readBigUInt64LE(CURVE_VIRTUAL_QUOTE),
    realTokenReserves: d.readBigUInt64LE(CURVE_REAL_TOKEN),
    realQuoteReserves: d.readBigUInt64LE(CURVE_REAL_QUOTE),
    tokenTotalSupply: d.readBigUInt64LE(CURVE_TOTAL_SUPPLY),
    complete: d.readUInt8(CURVE_COMPLETE) !== 0,
    creator: new PublicKey(d.subarray(CURVE_CREATOR, CURVE_CREATOR + 32)),
    // the sentinel means SOL, and SOL on the curve means the wrapped mint
    isNativeQuote,
    quoteMint: isNativeQuote ? WSOL : storedQuote,
    lamports: info.lamports,
  };
}

/// Whether pump has migration switched on at all, and what it charges. The fee
/// comes out of the curve's own balance, not the caller's.
export async function pumpMigrateTerms(connection) {
  const info = await connection.getAccountInfo(pumpGlobal(), 'confirmed');
  if (!info) throw new Error('the pump global account is missing');
  const d = info.data;
  return {
    withdrawAuthority: new PublicKey(d.subarray(GLOBAL_WITHDRAW_AUTHORITY, GLOBAL_WITHDRAW_AUTHORITY + 32)),
    enableMigrate: d.readUInt8(GLOBAL_ENABLE_MIGRATE) !== 0,
    poolMigrationFee: d.readBigUInt64LE(GLOBAL_POOL_MIGRATION_FEE),
  };
}

/// All twenty-nine accounts, in order, derived from the mint and the signer.
export async function pumpMigrateAccounts(connection, mintAddress, userAddress) {
  const baseMint = new PublicKey(mintAddress);
  const user = new PublicKey(userAddress);
  const curve = await readPumpCurve(connection, baseMint);
  if (!curve) throw new Error('no pump.fun bonding curve exists for this mint');
  const terms = await pumpMigrateTerms(connection);

  const quoteMint = curve.quoteMint;
  const [baseTokenProgram, quoteTokenProgram] = await Promise.all([
    ownerProgramOf(connection, baseMint), ownerProgramOf(connection, quoteMint),
  ]);

  const poolAuthority = poolAuthorityFor(baseMint);
  const pool = pumpPoolAddress(poolAuthority, baseMint, quoteMint);
  const lpMint = lpMintFor(pool);
  const boostVaultAuthority = boostVaultFor(pool);

  const metas = [
    key(pumpGlobal()),
    key(terms.withdrawAuthority, true),
    key(baseMint),
    key(quoteMint),
    key(curve.address, true),
    key(ataOf(curve.address, baseMint, baseTokenProgram), true),
    key(ataOf(curve.address, quoteMint, quoteTokenProgram), true),
    key(user, true, true),
    key(SystemProgram.programId),
    key(PUMP_AMM),
    key(pool, true),
    key(poolAuthority, true),
    key(ataOf(poolAuthority, baseMint, baseTokenProgram), true),
    key(ataOf(poolAuthority, quoteMint, quoteTokenProgram), true),
    key(pda([Buffer.from('global_config')], PUMP_AMM)),
    key(lpMint, true),
    // the IDL calls this user_pool_token_account; it belongs to the pool authority
    key(ataOf(poolAuthority, lpMint, TOKEN_2022), true),
    key(ataOf(pool, baseMint, baseTokenProgram), true),
    key(ataOf(pool, quoteMint, quoteTokenProgram), true),
    key(baseTokenProgram),
    key(quoteTokenProgram),
    key(TOKEN_2022),
    key(ATA_PROGRAM),
    key(pda([Buffer.from('__event_authority')], PUMP_AMM)),
    key(SYSVAR_RENT_PUBKEY),
    key(pda([Buffer.from('__event_authority')], PUMP_PROGRAM)),
    key(PUMP_PROGRAM),
    // the two the IDL does not declare
    key(boostVaultAuthority, true),
    key(ataOf(boostVaultAuthority, quoteMint, quoteTokenProgram), true),
  ];

  return {
    metas, curve, terms, pool, poolAuthority, lpMint, quoteMint,
    baseTokenProgram, quoteTokenProgram, boostVaultAuthority,
  };
}

export function migrateV2Ix(metas) {
  return new TransactionInstruction({ programId: PUMP_PROGRAM, data: MIGRATE_V2_DISC, keys: metas });
}

async function simulateMigrate(connection, metas, payer) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
  tx.add(migrateV2Ix(metas));
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const sim = await connection.simulateTransaction(tx);
  const logs = sim.value.logs || [];
  // An already-migrated coin does NOT fail: the program logs this and returns
  // success, so "the simulation passed" on its own would put a green button on a
  // transaction that does nothing but burn a fee. Checked as well as the pool
  // account, so a drifting pool derivation cannot turn into a silent no-op.
  const noop = logs.some((l) => /already migrated/i.test(l));
  return {
    ok: !sim.value.err && !noop,
    noop,
    error: sim.value.err ? JSON.stringify(sim.value.err)
      : (noop ? 'the program reports the curve as already migrated' : null),
    logs,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    bytes: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length,
  };
}

/// What state this coin is in and - by simulating - whether migrating it would
/// actually work. Read-only, and usable with the wallet locked.
export async function inspectPumpMigration({ rpcUrl, mint, user, connection: conn }) {
  const connection = conn || new Connection(rpcUrl, 'confirmed');
  const curve = await readPumpCurve(connection, mint);
  if (!curve) {
    return {
      isPumpCoin: false, state: 'not-a-pump-coin',
      reason: 'No pump.fun bonding curve exists for this mint.',
    };
  }
  const terms = await pumpMigrateTerms(connection);
  // the probe only decides what to show, and never signs, so a burn address is
  // enough - which is what keeps this page readable with no key loaded
  const probe = user || 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
  const built = await pumpMigrateAccounts(connection, mint, probe);
  const poolInfo = await connection.getAccountInfo(built.pool, 'confirmed');
  const quoteDecimals = (await connection.getParsedAccountInfo(built.quoteMint))
    .value?.data?.parsed?.info?.decimals ?? null;

  const common = {
    isPumpCoin: true, curve, terms, quoteDecimals,
    probedAs: probe,
    pool: built.pool.toBase58(),
    poolAuthority: built.poolAuthority.toBase58(),
    lpMint: built.lpMint.toBase58(),
    quoteMint: built.quoteMint.toBase58(),
    isNativeQuote: curve.isNativeQuote,
    accounts: built.metas.map((m) => m.pubkey.toBase58()),
  };

  if (poolInfo) return { ...common, state: 'migrated', reason: 'This coin already has a PumpSwap pool.' };
  if (!curve.complete) {
    return {
      ...common, state: 'on-curve',
      reason: 'The curve has not filled yet, so there is nothing to migrate - migrate_v2 '
        + 'only works on a completed curve.',
    };
  }
  if (!terms.enableMigrate) {
    return { ...common, state: 'blocked', reason: 'pump has migration switched off globally (enable_migrate is false).' };
  }

  // complete with no pool: simulate rather than assume
  const sim = await simulateMigrate(connection, built.metas, new PublicKey(probe));
  return {
    ...common,
    state: sim.ok ? 'migratable' : 'blocked',
    reason: sim.ok ? null : 'It does not simulate cleanly: ' + sim.error + '. '
      + explainSimLogs(sim.logs),
    simulation: sim,
  };
}

/// Pull the program's own complaint out of the logs. Its Anchor errors name the
/// source file and the reason, which beats a bare 0x1776 every time.
function explainSimLogs(logs) {
  const anchor = (logs || []).find((l) => /AnchorError/.test(l));
  if (anchor) return anchor.replace(/^Program log: /, '');
  const last = (logs || []).filter((l) => /Error|failed/i.test(l)).slice(-1)[0];
  return last ? last.replace(/^Program log: /, '') : '';
}

export function keypairFrom(secret) {
  const s = String(secret).trim();
  if (s.startsWith('[')) {
    const arr = Uint8Array.from(JSON.parse(s));
    if (arr.length !== 64) throw new Error('SOL key array must be 64 bytes');
    return Keypair.fromSecretKey(arr);
  }
  return Keypair.fromSecretKey(bs58.decode(s));
}

/// Migrate the coin. Simulates first and refuses on anything but a clean run:
/// this creates a pool and moves every unit the curve raised, so it is not a
/// call to send hopefully.
export async function migratePump({ rpcUrl, secretKey, mint, priorityMicroLamports = 200_000, onStatus }) {
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = keypairFrom(secretKey);

  say('reading the curve...');
  const built = await pumpMigrateAccounts(connection, mint, payer.publicKey);
  if (!built.curve.complete) throw new Error('this curve has not filled yet, so there is nothing to migrate');
  if (!built.terms.enableMigrate) throw new Error('pump has migration switched off globally');
  if (await connection.getAccountInfo(built.pool, 'confirmed')) {
    throw new Error('this coin already has a PumpSwap pool at ' + built.pool.toBase58());
  }

  say('simulating...');
  const sim = await simulateMigrate(connection, built.metas, payer.publicKey);
  if (!sim.ok) {
    const why = sim.logs.filter((l) => /Error|error|failed/.test(l)).slice(-3).join(' | ');
    throw new Error('migrate_v2 simulates as a failure: ' + sim.error + (why ? ' - ' + why : ''));
  }

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({
    units: Math.min(1_400_000, Math.ceil((sim.unitsConsumed || 400_000) * 1.3)),
  }));
  tx.add(migrateV2Ix(built.metas));

  say('migrating...');
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
  return {
    sig,
    pool: built.pool.toBase58(),
    lpMint: built.lpMint.toBase58(),
    quoteMint: built.quoteMint.toBase58(),
    raisedQuote: built.curve.realQuoteReserves.toString(),
  };
}
