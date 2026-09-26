import {
  Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage,
  VersionedTransaction, ComputeBudgetProgram, SystemProgram,
} from '@solana/web3.js';
import {
  pumpMigrateAccounts, migrateV2Ix, readPumpCurve, keypairFrom,
  PUMP_AMM,
} from './pumpMigrate.js';

// ---------------------------------------------------------------------------
// Being the first buy off a pump.fun migration.
//
// The buy goes in the SAME TRANSACTION as migrate_v2, not in a Jito bundle
// beside it, because same-transaction is strictly the stronger guarantee here:
// the pool does not exist until our own migrate instruction creates it, so there
// is no slot, no bundle boundary and no ordering assumption in which anybody can
// buy ahead of us. A bundle would only give us adjacency between two
// transactions, and it would cost a tip to get it. There is nothing a bundle
// buys that atomicity does not already give.
//
// It does not fit in a legacy transaction: migrate_v2 alone is 1078 of the 1232
// bytes available, and the buy adds thirteen more accounts. So this compiles a
// v0 transaction against pump's own public address lookup table
// (Hyif6eWb...), which already contains 17 of the 18 shared accounts - every
// program, both global accounts, both event authorities, the fee config, the fee
// recipients and the buyback vaults. Only the rent sysvar is missing.
//
// WHAT HAPPENS IF SOMEBODY ELSE MIGRATES FIRST: migrate_v2 does not fail on an
// already-migrated curve, it logs and returns success. So our transaction would
// carry on into the buy and we would be a late buyer at a worse price rather
// than the first at the opening one. That is what min_base_amount_out is for,
// and why this uses buy_exact_quote_in rather than buy: the floor is computed
// from the pool the migration is ABOUT to create, so if the price has already
// moved the whole transaction reverts and we pay only the fee. Losing the race
// costs nothing but gas; it never silently buys the top.
//
// The account shapes here were read off live transactions, not the IDLs, which
// are behind the deployed programs in both cases:
//   buy / buy_exact_quote_in declare 23 accounts and need TWENTY-SIX. The
//   missing three are pool_v2, the buyback vault and the vault's quote account;
//   without them the program answers InvalidPoolV2 (6062), "pool_v2 remaining
//   account is missing or invalid". Proven by simulating both shapes against a
//   live pool: 23 fails with 6062, 26 succeeds.
// ---------------------------------------------------------------------------

const PFEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

/// pump's own lookup table, permanently active (its deactivation slot is u64
/// max). Their frontend compiles against it and so does this - without it the
/// migrate and the buy cannot share a transaction.
export const PUMP_LOOKUP_TABLE = new PublicKey('Hyif6eWb8x88RVrvjPfabsgRYnwkVnyByEXTVTXbUcyP');

const BUY_EXACT_QUOTE_IN = Buffer.from('c62e1552b4d9e870', 'hex');

// GlobalConfig, from the field order the AMM IDL declares
const GC_LP_FEE_BPS = 40;
const GC_PROTOCOL_FEE_BPS = 48;
const GC_PROTOCOL_FEE_RECIPIENTS = 57;      // [pubkey; 8]
const GC_COIN_CREATOR_FEE_BPS = 313;
const GC_BUYBACK_FEE_RECIPIENTS = 643;      // [pubkey; 8], index-matched to the above
const GC_BUYBACK_BPS = 899;

// Pool
const POOL_BASE_TOKEN_ACCOUNT = 139;
const POOL_QUOTE_TOKEN_ACCOUNT = 171;
const POOL_COIN_CREATOR = 211;

// an SPL token account keeps its amount as a u64 at offset 64
const TOKEN_ACCOUNT_AMOUNT = 64;

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
// (mint, owner) - the order every call site here uses. The seeds are still
// [owner, program, mint]; getting the two the wrong way round silently derives a
// valid-looking address that belongs to nobody.
const ataOf = (mint, owner, tokenProgram) => pda(
  [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM,
);
const key = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const ZERO = new PublicKey('11111111111111111111111111111111').toBase58();

export const ammGlobalConfig = () => pda([Buffer.from('global_config')], PUMP_AMM);
/// Required by buy, declared nowhere, keyed by the BASE MINT rather than the pool.
export const poolV2For = (baseMint) => pda([Buffer.from('pool-v2'), new PublicKey(baseMint).toBuffer()], PUMP_AMM);
export const coinCreatorVaultFor = (coinCreator) => pda(
  [Buffer.from('creator_vault'), new PublicKey(coinCreator).toBuffer()], PUMP_AMM,
);
export const userVolumeAccumulatorFor = (user) => pda(
  [Buffer.from('user_volume_accumulator'), new PublicKey(user).toBuffer()], PUMP_AMM,
);

/// The AMM's fee schedule and a matched (fee recipient, buyback vault) pair.
///
/// The pairing is positional: protocol_fee_recipients[i] is served by
/// buyback_fee_recipients[i]. Checked against two live buys that happened to use
/// different indices - index 0 and index 6 - and both lined up.
export async function ammConfig(connection) {
  const info = await connection.getAccountInfo(ammGlobalConfig(), 'confirmed');
  if (!info) throw new Error("PumpSwap's global config is missing");
  const d = info.data;
  const at = (base, i) => new PublicKey(d.subarray(base + 32 * i, base + 32 * (i + 1)));

  let index = -1;
  for (let i = 0; i < 8; i++) {
    if (at(GC_PROTOCOL_FEE_RECIPIENTS, i).toBase58() !== ZERO && at(GC_BUYBACK_FEE_RECIPIENTS, i).toBase58() !== ZERO) {
      index = i; break;
    }
  }
  if (index < 0) throw new Error('no usable protocol fee recipient / buyback vault pair in the global config');

  return {
    lpFeeBps: d.readBigUInt64LE(GC_LP_FEE_BPS),
    protocolFeeBps: d.readBigUInt64LE(GC_PROTOCOL_FEE_BPS),
    coinCreatorFeeBps: d.readBigUInt64LE(GC_COIN_CREATOR_FEE_BPS),
    buybackBps: d.readBigUInt64LE(GC_BUYBACK_BPS),
    feeIndex: index,
    protocolFeeRecipient: at(GC_PROTOCOL_FEE_RECIPIENTS, index),
    buybackVault: at(GC_BUYBACK_FEE_RECIPIENTS, index),
  };
}

/// Total fee the buyer pays on the quote going in.
export const totalBuyFeeBps = (cfg) => cfg.lpFeeBps + cfg.protocolFeeBps + cfg.coinCreatorFeeBps;

// There is deliberately no pricing formula here.
//
// The obvious one - constant product against the pool's two vault balances, fee
// off the input - is wrong on PumpSwap, and not slightly: measured against a live
// pool it predicted 42.9e12 base for a buy that actually returned 2.57e12, too
// high by a factor of 16.7. Whatever pool_v2 does to the price curve, it is not
// x*y=k over the vaults, and a floor computed from that model would either
// reject every good fill or wave through a terrible one.
//
// So nothing here models the AMM. measureFirstBuy() runs the real buy in a
// simulation with the floor set to 1 and reads how much base actually arrives;
// that number comes from the program itself and needs no theory to be correct.

function createAtaIdempotentIx(payer, owner, mint, tokenProgram) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.from([1]),
    keys: [
      key(payer, true, true), key(ataOf(mint, owner, tokenProgram), true), key(owner),
      key(mint), key(SystemProgram.programId), key(tokenProgram),
    ],
  });
}

/// The 26 accounts buy_exact_quote_in really takes.
function buyAccounts({ pool, user, cfg, baseMint, quoteMint, baseTokenProgram, quoteTokenProgram, poolBase, poolQuote, coinCreator }) {
  const ccAuthority = coinCreatorVaultFor(coinCreator);
  return [
    key(pool, true),
    key(user, true, true),
    key(ammGlobalConfig()),
    key(baseMint),
    key(quoteMint),
    key(ataOf(baseMint, user, baseTokenProgram), true),
    key(ataOf(quoteMint, user, quoteTokenProgram), true),
    key(poolBase, true),
    key(poolQuote, true),
    key(cfg.protocolFeeRecipient),
    key(ataOf(quoteMint, cfg.protocolFeeRecipient, quoteTokenProgram), true),
    key(baseTokenProgram),
    key(quoteTokenProgram),
    key(SystemProgram.programId),
    key(ATA_PROGRAM),
    key(pda([Buffer.from('__event_authority')], PUMP_AMM)),
    key(PUMP_AMM),
    key(ataOf(quoteMint, ccAuthority, quoteTokenProgram), true),
    key(ccAuthority),
    key(pda([Buffer.from('global_volume_accumulator')], PUMP_AMM), true),
    key(userVolumeAccumulatorFor(user), true),
    key(pda([Buffer.from('fee_config'), PUMP_AMM.toBuffer()], PFEE_PROGRAM)),
    key(PFEE_PROGRAM),
    // the three the IDL does not declare
    key(poolV2For(baseMint), true),
    key(cfg.buybackVault, true),
    key(ataOf(quoteMint, cfg.buybackVault, quoteTokenProgram), true),
  ];
}

function buyExactQuoteInIx(metas, spendableQuoteIn, minBaseAmountOut, trackVolume) {
  // track_volume is pump's OptionBool: a struct wrapping one bool, so always a
  // single byte - not a Rust Option, which would be one or two
  const data = Buffer.concat([
    BUY_EXACT_QUOTE_IN, u64(spendableQuoteIn), u64(minBaseAmountOut),
    Buffer.from([trackVolume ? 1 : 0]),
  ]);
  return new TransactionInstruction({ programId: PUMP_AMM, data, keys: metas });
}

/// What the pool will hold the instant it opens.
///
/// Before migration the pool does not exist, and pump's split of the raised
/// quote between the pool and its boost vault is the program's own arithmetic -
/// so rather than model it, this runs the migration in a simulation and reads
/// the resulting vault balances. The chain answers the question it is the
/// authority on.
export async function predictPoolReserves(connection, mint, probeUser) {
  const built = await pumpMigrateAccounts(connection, mint, probeUser);
  const poolInfo = await connection.getAccountInfo(built.pool, 'confirmed');

  if (poolInfo) {
    // already migrated: read the real thing
    const poolBase = new PublicKey(poolInfo.data.subarray(POOL_BASE_TOKEN_ACCOUNT, POOL_BASE_TOKEN_ACCOUNT + 32));
    const poolQuote = new PublicKey(poolInfo.data.subarray(POOL_QUOTE_TOKEN_ACCOUNT, POOL_QUOTE_TOKEN_ACCOUNT + 32));
    const [b, q] = await Promise.all([
      connection.getAccountInfo(poolBase, 'confirmed'), connection.getAccountInfo(poolQuote, 'confirmed'),
    ]);
    if (!b || !q) throw new Error('the pool exists but its vaults do not - refusing to guess its reserves');
    return {
      alreadyMigrated: true, pool: built.pool, poolBase, poolQuote,
      baseReserve: b.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT),
      quoteReserve: q.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT),
      coinCreator: new PublicKey(poolInfo.data.subarray(POOL_COIN_CREATOR, POOL_COIN_CREATOR + 32)),
    };
  }

  // not migrated: the vaults are the pool's associated accounts, which
  // migrate_v2 creates. Simulate the migration and read them out of the result.
  const poolBase = ataOf(new PublicKey(mint), built.pool, built.baseTokenProgram);
  const poolQuote = ataOf(built.quoteMint, built.pool, built.quoteTokenProgram);

  const msg = new TransactionMessage({
    payerKey: new PublicKey(probeUser),
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), migrateV2Ix(built.metas)],
  }).compileToV0Message([await lookupTable(connection)]);
  const sim = await connection.simulateTransaction(new VersionedTransaction(msg), {
    sigVerify: false, replaceRecentBlockhash: true,
    accounts: { encoding: 'base64', addresses: [poolBase.toBase58(), poolQuote.toBase58()] },
  });
  if (sim.value.err) {
    throw new Error('cannot price the first buy: the migration itself does not simulate ('
      + JSON.stringify(sim.value.err) + ')');
  }
  const amountAt = (i) => {
    const raw = sim.value.accounts?.[i]?.data?.[0];
    if (!raw) throw new Error('the migration simulation did not return the new pool vaults');
    return Buffer.from(raw, 'base64').readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT);
  };
  return {
    alreadyMigrated: false, pool: built.pool, poolBase, poolQuote,
    baseReserve: amountAt(0), quoteReserve: amountAt(1),
    coinCreator: built.curve.creator,
  };
}

let cachedTable = null;
async function lookupTable(connection) {
  if (cachedTable) return cachedTable;
  const res = await connection.getAddressLookupTable(PUMP_LOOKUP_TABLE);
  if (!res.value) throw new Error('pump lookup table not found: ' + PUMP_LOOKUP_TABLE.toBase58());
  cachedTable = res.value;
  return cachedTable;
}

/// Build the one transaction that migrates the coin and buys from the pool it
/// just created. Returns the unsigned transaction so it can be sized, simulated
/// and diffed without a key.
export async function buildMigrateAndBuy({
  connection, mint, buyer, spendQuote, slippageBps = 500, trackVolume = false,
  priorityMicroLamports = 1_000_000, computeUnits = 900_000, blockhash,
  closeWrappedSol = false, minBaseOut = null,
}) {
  const user = new PublicKey(buyer);
  const built = await pumpMigrateAccounts(connection, mint, user);
  const cfg = await ammConfig(connection);
  const reserves = await predictPoolReserves(connection, mint, buyer);

  const spend = BigInt(spendQuote);
  if (spend <= 0n) throw new Error('the dev buy needs a positive amount of the quote token');
  // The floor is always supplied by the caller, measured rather than modelled.
  // It can never be zero either way: the program answers ZeroBaseAmount to a
  // floor of nothing, which is a confusing way to learn you asked for no minimum.
  if (minBaseOut == null) throw new Error('buildMigrateAndBuy needs a minBaseOut - measure it with measureFirstBuy()');
  const minOut = BigInt(minBaseOut);
  if (minOut <= 0n) throw new Error('the minimum-out floor has to be at least 1; the program rejects zero');

  const isNativeQuote = built.quoteMint.equals(WSOL);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    migrateV2Ix(built.metas),
  ];

  // Only create the token accounts that are actually missing. This is a size
  // optimisation, not a correctness one: the whole thing lands at ~1210 of the
  // 1232 bytes a transaction may be, and each skipped create is another ten
  // bytes of headroom for a coin whose shape needs one more account.
  const baseAta = ataOf(new PublicKey(mint), user, built.baseTokenProgram);
  const quoteAta = ataOf(built.quoteMint, user, built.quoteTokenProgram);
  const [baseAtaInfo, quoteAtaInfo] = await Promise.all([
    connection.getAccountInfo(baseAta, 'confirmed'), connection.getAccountInfo(quoteAta, 'confirmed'),
  ]);
  if (!baseAtaInfo) instructions.push(createAtaIdempotentIx(user, user, new PublicKey(mint), built.baseTokenProgram));
  if (!quoteAtaInfo) instructions.push(createAtaIdempotentIx(user, user, built.quoteMint, built.quoteTokenProgram));

  // a SOL-quoted pool trades wrapped SOL, so the lamports have to be wrapped in
  // the same transaction - there is no earlier one to do it in
  const userQuoteAta = quoteAta;
  if (isNativeQuote) {
    instructions.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userQuoteAta, lamports: spend }));
    instructions.push(new TransactionInstruction({
      programId: built.quoteTokenProgram, data: Buffer.from([17]), keys: [key(userQuoteAta, true)],
    }));   // SyncNative
  }

  instructions.push(buyExactQuoteInIx(buyAccounts({
    pool: reserves.pool, user, cfg,
    baseMint: new PublicKey(mint), quoteMint: built.quoteMint,
    baseTokenProgram: built.baseTokenProgram, quoteTokenProgram: built.quoteTokenProgram,
    poolBase: reserves.poolBase, poolQuote: reserves.poolQuote,
    coinCreator: reserves.coinCreator,
  }), spend, minOut, trackVolume));

  // Closing the wrapped-SOL account hands back the unspent remainder and the
  // rent, but it costs bytes in a transaction that has about twenty spare, and
  // buy_exact_quote_in spends what we wrapped. Off by default; the account stays
  // and gets reused next time.
  if (isNativeQuote && closeWrappedSol) {
    instructions.push(new TransactionInstruction({
      programId: built.quoteTokenProgram, data: Buffer.from([9]),
      keys: [key(userQuoteAta, true), key(user, true), key(user, false, true)],
    }));   // CloseAccount
  }

  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash || (await connection.getLatestBlockhash('confirmed')).blockhash,
    instructions,
  }).compileToV0Message([await lookupTable(connection)]);

  const tx = new VersionedTransaction(message);
  return {
    tx, instructions, reserves, cfg,
    minBaseOut: minOut,
    feeBps: totalBuyFeeBps(cfg),
    isNativeQuote,
    quoteMint: built.quoteMint,
    baseTokenProgram: built.baseTokenProgram,
    quoteTokenProgram: built.quoteTokenProgram,
    bytes: tx.serialize().length,
  };
}

/// How much base the first buy really returns, taken from the program rather
/// than from a model of it.
///
/// Builds the whole migrate-and-buy with the floor set to 1 - the lowest value
/// the program accepts - simulates it, and reads the buyer's token account out of
/// the simulation's post-state. That is the same arithmetic the real transaction
/// will do, on the same reserves, including whatever pool_v2 contributes.
export async function measureFirstBuy({ connection, mint, buyer, spendQuote }) {
  const built = await buildMigrateAndBuy({ connection, mint, buyer, spendQuote, minBaseOut: 1 });
  const userBaseAta = ataOf(new PublicKey(mint), new PublicKey(buyer), built.baseTokenProgram);
  const sim = await connection.simulateTransaction(built.tx, {
    sigVerify: false, replaceRecentBlockhash: true,
    accounts: { encoding: 'base64', addresses: [userBaseAta.toBase58()] },
  });
  if (sim.value.err) {
    const why = (sim.value.logs || []).filter((l) => /AnchorError|failed/.test(l)).slice(-2).join(' | ');
    throw new Error('cannot measure the first buy: ' + JSON.stringify(sim.value.err) + (why ? ' - ' + why : ''));
  }
  const raw = sim.value.accounts?.[0]?.data?.[0];
  if (!raw) throw new Error('the simulation did not return the buyer token account, so the fill cannot be measured');
  const after = Buffer.from(raw, 'base64').readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT);
  // whatever the buyer already held has to come off, or a wallet that already
  // owns the coin reads as a larger fill than it gets
  const before = await connection.getAccountInfo(userBaseAta, 'confirmed')
    .then((i) => (i ? i.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT) : 0n)).catch(() => 0n);
  const filled = after - before;
  if (filled <= 0n) throw new Error('the simulated buy filled nothing');
  return { filled, reserves: built.reserves, cfg: built.cfg, bytes: built.bytes, unitsConsumed: sim.value.unitsConsumed };
}

/// Price the snipe without sending it: what the pool opens at, what the buy
/// actually fills, and what share of the supply that is.
export async function previewSnipe({ rpcUrl, mint, buyer, spendQuote, slippageBps = 500, connection: conn }) {
  const connection = conn || new Connection(rpcUrl, 'confirmed');
  if (!buyer) throw new Error('previewSnipe needs the buyer address: the fill is measured by simulating their buy');
  const curve = await readPumpCurve(connection, mint);
  if (!curve) throw new Error('no pump.fun bonding curve exists for this mint');

  const m = await measureFirstBuy({ connection, mint, buyer, spendQuote });
  const baseDecimals = 6;
  const floor = m.filled - (m.filled * BigInt(Math.round(slippageBps))) / 10_000n;
  return {
    openingBaseReserve: m.reserves.baseReserve.toString(),
    openingQuoteReserve: m.reserves.quoteReserve.toString(),
    alreadyMigrated: m.reserves.alreadyMigrated,
    filled: m.filled.toString(),
    minBaseOut: (floor > 0n ? floor : 1n).toString(),
    tokens: Number(m.filled) / 10 ** baseDecimals,
    pctOfSupply: (Number(m.filled) / Number(curve.tokenTotalSupply)) * 100,
    bytes: m.bytes,
    unitsConsumed: m.unitsConsumed,
  };
}

// ---------------------------------------------------------------------------
// The Jito fallback.
//
// One transaction is the better instrument and is what this uses by default, but
// it lands at about 1210 of the 1232 bytes a transaction may be - roughly twenty
// spare. A coin whose shape needs one more account does not fit, and then the
// only way to keep the buy adjacent to the migration is a bundle: two
// transactions, executed in order, in one slot, all or nothing. Nobody gets
// inserted between them there either.
//
// The tip accounts are fetched from the block engine rather than hardcoded. Jito
// rotates them, and a tip to a stale address is a tip to nobody, which quietly
// turns the bundle into an ordinary pair of transactions. One of the eight,
// 3AVi9Tg9..., is the same account pump's own boost bot tips.
// ---------------------------------------------------------------------------

export const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

async function jitoRpc(endpoint, method, params) {
  const res = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error('Jito ' + method + ': ' + (body.error.message || JSON.stringify(body.error)));
  return body.result;
}

let cachedTips = null;
export async function jitoTipAccounts(endpoint = JITO_ENDPOINTS[0]) {
  if (cachedTips) return cachedTips;
  const list = await jitoRpc(endpoint, 'getTipAccounts', []);
  if (!Array.isArray(list) || !list.length) throw new Error('Jito returned no tip accounts');
  cachedTips = list.map((a) => new PublicKey(a));
  return cachedTips;
}

export async function sendJitoBundle(endpoint, signedTxs) {
  const encoded = signedTxs.map((t) => Buffer.from(t.serialize()).toString('base64'));
  return jitoRpc(endpoint, 'sendBundle', [encoded, { encoding: 'base64' }]);
}

export async function jitoBundleStatus(endpoint, bundleId) {
  const r = await jitoRpc(endpoint, 'getBundleStatuses', [[bundleId]]);
  return r?.value?.[0] ?? null;
}

/// Migrate in one transaction and buy in the next, as a bundle. Used when the
/// combined transaction does not fit, and selectable on purpose.
export async function snipeViaBundle({
  rpcUrl, secretKey, mint, spendQuote, slippageBps = 500, trackVolume = false,
  tipLamports = 1_000_000, endpoint = JITO_ENDPOINTS[0], priorityMicroLamports = 1_000_000,
  onStatus,
}) {
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = keypairFrom(secretKey);
  const user = payer.publicKey;

  say('measuring what the first buy fills...');
  const built = await pumpMigrateAccounts(connection, mint, user);
  const cfg = await ammConfig(connection);
  const spend = BigInt(spendQuote);
  const measured = await measureFirstBuy({ connection, mint, buyer: user.toBase58(), spendQuote });
  const reserves = measured.reserves;
  const expectedOut = measured.filled;
  const floor = expectedOut - (expectedOut * BigInt(Math.round(slippageBps))) / 10_000n;
  const minOut = floor > 0n ? floor : 1n;

  const tips = await jitoTipAccounts(endpoint);
  const tip = tips[Math.floor(Math.random() * tips.length)];
  const table = await lookupTable(connection);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const v0 = (instructions) => {
    const tx = new VersionedTransaction(
      new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions }).compileToV0Message([table]),
    );
    tx.sign([payer]);
    return tx;
  };

  const migrateTx = v0([
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    migrateV2Ix(built.metas),
  ]);

  const isNativeQuote = built.quoteMint.equals(WSOL);
  const quoteAta = ataOf(built.quoteMint, user, built.quoteTokenProgram);
  const buyIxs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAtaIdempotentIx(user, user, new PublicKey(mint), built.baseTokenProgram),
    createAtaIdempotentIx(user, user, built.quoteMint, built.quoteTokenProgram),
  ];
  if (isNativeQuote) {
    buyIxs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: quoteAta, lamports: spend }));
    buyIxs.push(new TransactionInstruction({
      programId: built.quoteTokenProgram, data: Buffer.from([17]), keys: [key(quoteAta, true)],
    }));
  }
  buyIxs.push(buyExactQuoteInIx(buyAccounts({
    pool: reserves.pool, user, cfg,
    baseMint: new PublicKey(mint), quoteMint: built.quoteMint,
    baseTokenProgram: built.baseTokenProgram, quoteTokenProgram: built.quoteTokenProgram,
    poolBase: reserves.poolBase, poolQuote: reserves.poolQuote,
    coinCreator: reserves.coinCreator,
  }), spend, minOut, trackVolume));
  // the tip rides in the last transaction; a bundle is all-or-nothing, so it is
  // only ever paid alongside a buy that worked
  buyIxs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: tip, lamports: Number(tipLamports) }));

  const buyTx = v0(buyIxs);

  say('bundling: migrate (' + migrateTx.serialize().length + ' bytes) + buy ('
    + buyTx.serialize().length + ' bytes), tip ' + Number(tipLamports) / 1e9 + ' SOL');
  const bundleId = await sendJitoBundle(endpoint, [migrateTx, buyTx]);
  say('bundle submitted: ' + bundleId);

  // Jito accepting a bundle is not Jito landing one. Poll, and say which
  // happened rather than reporting submission as success.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await jitoBundleStatus(endpoint, bundleId).catch(() => null);
    if (st?.confirmation_status === 'confirmed' || st?.confirmation_status === 'finalized') {
      return {
        bundleId, landed: true, slot: st.slot, sigs: st.transactions || [],
        filled: expectedOut.toString(), minBaseOut: minOut.toString(),
        tip: tip.toBase58(), tipLamports: Number(tipLamports),
      };
    }
    if (st?.err && st.err.Ok !== null && st.err.Ok !== undefined) {
      throw new Error('the bundle failed on-chain: ' + JSON.stringify(st.err));
    }
  }
  return {
    bundleId, landed: false,
    reason: 'Jito accepted the bundle but it had not landed after 30 seconds, most likely dropped for '
      + 'a low tip. Nothing was spent beyond the transaction fees.',
    filled: expectedOut.toString(), minBaseOut: minOut.toString(),
    tip: tip.toBase58(), tipLamports: Number(tipLamports),
  };
}

/// Migrate and be the first buy, in one transaction. Simulates first and refuses
/// on anything but a clean run.
export async function snipeMigration({
  rpcUrl, secretKey, mint, spendQuote, slippageBps = 500, trackVolume = false,
  priorityMicroLamports = 1_000_000, dryRun = false, onStatus,
  route = 'auto', tipLamports = 1_000_000, endpoint,
}) {
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = keypairFrom(secretKey);

  say('measuring what the first buy fills...');
  const measured = await measureFirstBuy({
    connection, mint, buyer: payer.publicKey.toBase58(), spendQuote,
  });
  const floorRaw = measured.filled - (measured.filled * BigInt(Math.round(slippageBps))) / 10_000n;
  const floor = floorRaw > 0n ? floorRaw : 1n;
  const built = await buildMigrateAndBuy({
    connection, mint, buyer: payer.publicKey.toBase58(),
    spendQuote, trackVolume, priorityMicroLamports, minBaseOut: floor,
  });

  // One transaction when it fits, a bundle when it does not. The margin is about
  // twenty bytes, so this is a decision that has to be made per coin rather than
  // once - and made by measuring, not by guessing which shapes are big.
  const MAX_TX_BYTES = 1232;
  const tooBig = built.bytes > MAX_TX_BYTES;
  if (route === 'bundle' || (route === 'auto' && tooBig)) {
    if (tooBig) {
      say(`the combined transaction is ${built.bytes} bytes, over the ${MAX_TX_BYTES} limit — bundling instead`);
    }
    if (dryRun) {
      return { dryRun: true, route: 'bundle', bytes: built.bytes, wouldBundle: true,
        filled: measured.filled.toString(), minBaseOut: floor.toString() };
    }
    return {
      route: 'bundle',
      ...await snipeViaBundle({
        rpcUrl, secretKey, mint, spendQuote, slippageBps, trackVolume,
        tipLamports, endpoint, priorityMicroLamports, onStatus,
      }),
    };
  }
  say('opening pool: ' + built.reserves.quoteReserve + ' quote / ' + built.reserves.baseReserve
    + ' base — fills ' + measured.filled + ', floor ' + built.minBaseOut);

  say('simulating the whole transaction...');
  built.tx.sign([payer]);
  const sim = await connection.simulateTransaction(built.tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    const why = (sim.value.logs || []).filter((l) => /AnchorError|Error|failed/.test(l)).slice(-3).join(' | ');
    throw new Error('migrate + buy does not simulate: ' + JSON.stringify(sim.value.err) + (why ? ' - ' + why : ''));
  }

  if (dryRun) {
    say(`simulation passed (${sim.value.unitsConsumed} CU, ${built.bytes} bytes)`);
    return {
      dryRun: true, bytes: built.bytes, unitsConsumed: sim.value.unitsConsumed,
      filled: measured.filled.toString(), minBaseOut: built.minBaseOut.toString(),
      logs: sim.value.logs || [],
    };
  }

  // re-sign against a fresh blockhash: pricing and simulating cost time, and a
  // snipe is the last place to send a stale one
  say('sending...');
  const fresh = await buildMigrateAndBuy({
    connection, mint, buyer: payer.publicKey.toBase58(),
    spendQuote, trackVolume, priorityMicroLamports, minBaseOut: floor,
    blockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
  });
  fresh.tx.sign([payer]);
  const sig = await connection.sendTransaction(fresh.tx, { skipPreflight: true, maxRetries: 3 });
  say('waiting for confirmation...');
  const bh = await connection.getLatestBlockhash('confirmed');
  const done = await connection.confirmTransaction({
    signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight,
  }, 'confirmed');
  if (done.value.err) throw new Error('the transaction landed but failed: ' + JSON.stringify(done.value.err));

  return {
    sig,
    pool: fresh.reserves.pool.toBase58(),
    filled: measured.filled.toString(),
    minBaseOut: fresh.minBaseOut.toString(),
    bytes: fresh.bytes,
  };
}
