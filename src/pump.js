import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// pump.fun
//
// Every account and argument below was read off the deployed program's own
// on-chain Anchor IDL and then checked against a live launch: all 18 derived
// addresses matched a real create_v2 + buy transaction exactly before any of
// this was written. Nothing here is guessed.
//
// The current launch shape, as pump.fun's own frontend sends it:
//
//   ComputeBudget x2
//   create_v2(name, symbol, uri, creator, is_mayhem_mode, is_cashback_enabled)
//   createIdempotent ATA        (the creator's token account)
//   buy(amount, max_sol_cost, track_volume)      <- the dev buy
//
// create_v2 mints the token under TOKEN-2022, not SPL Token. The older
// `create` still exists but is not what the site uses any more.
//
// No vanity mint grinding. pump.fun's "...pump" suffix costs 58^4 = 11.3M
// keypairs on average (~45 minutes single-threaded) and they grind it
// server-side; doing it inline just burned the blockhash validity window and
// expired launches. It is cosmetic - the mint, curve and trades are identical
// without it - so the keypair is simply generated.
// ---------------------------------------------------------------------------

export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const PUMP_MAYHEM_PROGRAM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
// create_v2 + buy_v2 is 43 accounts across two instructions and does not fit in a
// 1232-byte transaction on its own. pump.fun's frontend compiles it against this
// public, permanently-active lookup table (165 of their static accounts), and so
// does this. Read off their own launches rather than assumed.
export const PUMP_LOOKUP_TABLE = new PublicKey('Hyif6eWb8x88RVrvjPfabsgRYnwkVnyByEXTVTXbUcyP');

// The quote registry. pump redeployed on 2026-09-09 and moved the list of
// pairable quotes out of Global (which still only names USDC) into this account,
// which create_v2 now takes as a fourth remaining account. Entries are 40 bytes:
// a 32-byte mint followed by that quote's initial virtual reserve.
//
// Read off a live stock launch rather than derived — it is not a PDA of any seed
// worth guessing, and pumpQuoteRegistry() re-reads it every time so a newly added
// stock appears without a code change.
export const PUMP_QUOTE_REGISTRY = new PublicKey('6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP');
const REGISTRY_FIRST_ENTRY = 228;
const REGISTRY_ENTRY_LEN = 40;

/// Every quote pump will currently pair against, with its virtual reserve.
export async function pumpQuoteRegistry(connection) {
  const info = await connection.getAccountInfo(PUMP_QUOTE_REGISTRY);
  if (!info) return [];
  const zero = NATIVE_QUOTE.toBase58();
  const out = [];
  for (let o = REGISTRY_FIRST_ENTRY; o + REGISTRY_ENTRY_LEN <= info.data.length; o += REGISTRY_ENTRY_LEN) {
    const mint = new PublicKey(info.data.subarray(o, o + 32));
    if (mint.toBase58() === zero) continue;
    out.push({ mint: mint.toBase58(), virtualQuoteReserves: info.data.readBigUInt64LE(o + 32) });
  }
  return out;
}
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYS = SystemProgram.programId;
/// pump stores a curve's quote as the all-zero pubkey when it is native SOL
const NATIVE_QUOTE = new PublicKey('11111111111111111111111111111111');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

const pda = (seeds, program = PUMP_PROGRAM) => PublicKey.findProgramAddressSync(seeds, program)[0];
const ataOf = (owner, mint, tokenProgram) =>
  pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);

const PUMP_GLOBAL = pda([Buffer.from('global')]);
const PUMP_EVENT_AUTHORITY = pda([Buffer.from('__event_authority')]);
const PUMP_MINT_AUTHORITY = pda([Buffer.from('mint-authority')]);
const PUMP_GLOBAL_VOLUME = pda([Buffer.from('global_volume_accumulator')]);
const PUMP_FEE_CONFIG = pda([Buffer.from('fee_config'), PUMP_PROGRAM.toBuffer()], PUMP_FEE_PROGRAM);

// anchor discriminators: sha256("global:<name>")[0..8], hardcoded so the browser
// bundle does not need a hashing dependency. Verified against live txs.
const IX = {
  create_v2: Buffer.from('d6904cec5f8b31b4', 'hex'),
  buy_v2: Buffer.from('b817ee6167c5d33d', 'hex'),
  // exact QUOTE in, min tokens out - what live stock launches use
  buy_exact_quote_in_v2: Buffer.from('c2ab1c46684d5b2f', 'hex'),
  sell_v2: Buffer.from('5df6823ce7e940b2', 'hex'),
};

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const str = (s) => {
  const d = Buffer.from(String(s), 'utf8');
  const l = Buffer.alloc(4); l.writeUInt32LE(d.length);
  return Buffer.concat([l, d]);
};
const key = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

// ---------------------------------------------------------------------------
// Global config — the live source of truth for fees, curve constants, and which
// non-SOL quote mints pump has whitelisted.
//
// `whitelisted_quote_mints` is the field to watch. It is an array of ONE, set by
// the admin-only add_quote_mint instruction, and today it holds USDC. If pump
// ships stock pairs, this is where they appear, which is why the launcher reads
// it live instead of shipping a hardcoded list.
// ---------------------------------------------------------------------------
export async function pumpStatus(rpcUrl) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const info = await connection.getAccountInfo(PUMP_GLOBAL);
  if (!info) throw new Error('pump.fun global config not found');
  const d = info.data;
  let o = 8;
  const bool = () => { const v = d.readUInt8(o) !== 0; o += 1; return v; };
  const pk = () => { const v = new PublicKey(d.subarray(o, o + 32)); o += 32; return v; };
  const num = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
  const pkArr = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(pk()); return a; };

  const g = {};
  g.initialized = bool();
  g.authority = pk();
  g.feeRecipient = pk();
  g.initialVirtualTokenReserves = num();
  g.initialVirtualSolReserves = num();
  g.initialRealTokenReserves = num();
  g.tokenTotalSupply = num();
  g.feeBasisPoints = num();
  g.withdrawAuthority = pk();
  g.enableMigrate = bool();
  g.poolMigrationFee = num();
  g.creatorFeeBasisPoints = num();
  g.feeRecipients = pkArr(7);
  g.setCreatorAuthority = pk();
  g.adminSetCreatorAuthority = pk();
  g.createV2Enabled = bool();
  g.whitelistPda = pk();
  g.reservedFeeRecipient = pk();
  g.mayhemModeEnabled = bool();
  g.reservedFeeRecipients = pkArr(7);
  g.isCashbackEnabled = bool();
  g.buybackFeeRecipients = pkArr(8);
  g.buybackBasisPoints = num();
  g.initialVirtualQuoteReserves = num();
  g.whitelistedQuoteMints = pkArr(1);
  // the switches that decide whether a custom creator fee is allowed at all,
  // and how high it may go
  g.creatorFeeConfigurable = bool();
  g.maxConfigurableCreatorFeeBps = num();
  g.holderRewardClaimAuthority = pk();
  g.isHolderRewardEnabled = bool();
  // The cap on how deep a new coin may be nested. 1 while only one level of
  // indirection was allowed, 2 since 2026-10-13. The program's own ceiling is
  // 5 whatever this says. Read rather than assumed - it is the switch that
  // decides whether a triple-stacked launch is possible today.
  g.maxCurveDepth = d.length > o ? d.readUInt8(o) : 1;
  o += 1;

  const zero = NATIVE_QUOTE.toBase58();
  // Global's own array is legacy (USDC only); the registry is the live list.
  // Every mint's decimals and token program are read in batches of 100, not one
  // request each: the registry passed 200 entries, and reading them one at a
  // time took 40s on a rate-limited key - long enough that a launch looked hung
  // on "reading pump.fun config".
  const registry = await pumpQuoteRegistry(connection).catch(() => []);
  const legacy = g.whitelistedQuoteMints.map((q) => q.toBase58()).filter((m) => m !== zero);
  const mints = [...new Set([...legacy, ...registry.map((r) => r.mint)])];
  const infos = [];
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100).map((m) => new PublicKey(m));
    const got = await connection.getMultipleAccountsInfo(chunk).catch(() => chunk.map(() => null));
    infos.push(...got);
  }
  const reserves = new Map(registry.map((r) => [r.mint, r.virtualQuoteReserves]));
  const quotes = mints.map((mint, i) => {
    const mi = infos[i];
    return {
      mint,
      decimals: mi ? mi.data[44] : null,
      tokenProgram: mi ? mi.owner.toBase58() : null,
      ...(reserves.has(mint) && !legacy.includes(mint)
        ? { virtualQuoteReserves: reserves.get(mint), fromRegistry: true }
        : {}),
    };
  });
  return { ...g, whitelistedQuotes: quotes, registry };
}

/// Tokens out for a given SOL in, on the constant-product curve pump seeds every
/// launch with. Fees are charged on top of the SOL you send, so they do not enter
/// this term — they are covered by the max_sol_cost headroom instead.
export function pumpTokensForSol(global, solLamports, quote = null) {
  const vTok = BigInt(global.initialVirtualTokenReserves);
  // a non-SOL curve is seeded from initial_virtual_quote_reserves instead
  // each registered quote carries its own virtual reserve; fall back to the
  // global one, then to the SOL reserve
  const vSol = quote
    ? BigInt(quote.virtualQuoteReserves ?? global.initialVirtualQuoteReserves ?? global.initialVirtualSolReserves)
    : BigInt(global.initialVirtualSolReserves);
  const inLamports = BigInt(solLamports);
  if (inLamports <= 0n) return 0n;
  const out = (vTok * inLamports) / (vSol + inLamports);
  const realCap = BigInt(global.initialRealTokenReserves);
  return out > realCap ? realCap : out;
}

// is_cashback_enabled is the last create_v2 arg (an OptionBool, one byte). It
// marks the curve as a cashback coin, which is what lets traders claim back a
// share of fees later through claim_cashback / claim_cashback_v2 against their
// user_volume_accumulator. Live launches use both values; it defaults ON here.
// pump's own Global.is_cashback_enabled must also be true, and it is.
//
// A non-SOL pairing is created by passing THREE remaining accounts to create_v2:
// the quote mint, the bonding curve's associated account for that quote, and the
// quote's token program. The IDL declares only 16 accounts and says nothing about
// them, which is why this looked impossible until a real USDC launch was decoded
// (tx 29trp9sX…, create_v2 with 19 accounts). Pass nothing extra and you get a
// native-SOL curve, exactly as before.
// Fees to holders instead of the creator is an ELEVENTH trailing byte on
// create_v2, set to 1. Everything else about the two launches is identical —
// same 20 accounts, byte-identical bonding curves afterwards — the only
// difference on chain is that one extra byte:
//
//   fees to creator   00 00 [u64 0]        10 trailing bytes
//   fees to holders   00 00 [u64 0] 01     11 trailing bytes
//
// It is not in the IDL, which has not been republished since May and predates
// both this and the quote registry. Simulating both shapes shows the flagged one
// costing ~1,500 more compute units, so the program reads it and acts on it
// rather than ignoring a stray byte.
function createV2Ix({ mint, user, name, symbol, uri, creator, isMayhem = false, cashback = false, quote = null, feesToHolders = false, creatorFeeBps = 0 }) {
  const solVault = pda([Buffer.from('sol-vault')], PUMP_MAYHEM_PROGRAM);
  const mayhemState = pda([Buffer.from('mayhem-state'), mint.toBuffer()], PUMP_MAYHEM_PROGRAM);
  const bondingCurve = pda([Buffer.from('bonding-curve'), mint.toBuffer()]);
  // create_v2's full argument list, from pump's published IDL:
  //
  //   name, symbol, uri, creator, is_mayhem_mode: bool,
  //   is_cashback_enabled: OptionBool, creator_fee_bps: OptionU64,
  //   is_holder_reward: OptionBool
  //
  // The three Option types are structs wrapping a value, not Rust Options, so
  // each is just its payload - one byte, eight bytes, one byte - and they are
  // trailing optionals, meaning a later one cannot be sent without the earlier
  // ones. That is why the fee is always written even when it is zero.
  //
  // This u64 used to be hardcoded to zero here, described as "observed zero".
  // It is the per-coin creator fee, and it is what sets a holder-rewards coin's
  // payout rate. Zero means "fall back to the market-cap tier table", whose top
  // band is 95 bps - which is why 1% looked like the ceiling. Set it explicitly
  // and the limit is instead Global.max_configurable_creator_fee_bps, currently
  // 300 bps.
  const data = Buffer.concat([
    IX.create_v2, str(name), str(symbol), str(uri), creator.toBuffer(),
    Buffer.from([isMayhem ? 1 : 0]), Buffer.from([cashback ? 1 : 0]),
    u64(Math.round(Number(creatorFeeBps) || 0)),
    ...(feesToHolders ? [Buffer.from([1])] : []),
  ]);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    data,
    keys: [
      key(mint, true, true),
      key(PUMP_MINT_AUTHORITY),
      key(bondingCurve, false, true),
      key(ataOf(bondingCurve, mint, TOKEN_2022), false, true),
      key(PUMP_GLOBAL),
      key(user, true, true),
      key(SYS),
      key(TOKEN_2022),
      key(ATA_PROGRAM),
      key(PUMP_MAYHEM_PROGRAM, false, true),
      key(pda([Buffer.from('global-params')], PUMP_MAYHEM_PROGRAM)),
      key(solVault, false, true),
      key(mayhemState, false, true),
      key(ataOf(solVault, mint, TOKEN_2022), false, true),
      key(PUMP_EVENT_AUTHORITY),
      key(PUMP_PROGRAM),
      ...(quote ? [
        key(quote.mint),
        key(ataOf(bondingCurve, quote.mint, quote.tokenProgram), false, true),
        key(quote.tokenProgram),
        key(PUMP_QUOTE_REGISTRY),
        // Pairing against another pump coin needs one group per coin on its
        // chain: that coin's curve, and its pool and two vaults if it has
        // migrated. Packed and positional, so the list is built by the walker
        // rather than spelled out here - see pumpQuoteChainAccounts. A registry
        // quote has no curve and no pool, and keeps the 20-account shape every
        // launch here has used.
        ...(quote.pumpChain
          ? pumpQuoteChainAccounts(quote.pumpChain).map((a) => key(a, false, true))
          : []),
      ] : []),
    ],
  });
}

// The dev buy goes through buy_v2, not the classic `buy`.
//
// `buy` needs two undeclared REMAINING accounts that live launches pass — one is
// a rotating buyback fee recipient, the other an account that changes every
// launch and is not derivable from the IDL — and omitting them fails with
// BuybackFeeRecipientMissing. buy_v2 declares everything it needs, including the
// buyback recipient and its associated account, so nothing has to be guessed.
// Every one of its 27 accounts was checked against a live create_v2 + buy_v2.
//
// A native-SOL launch still uses WSOL as the quote here: the curve records its
// quote as the all-zero pubkey, but the trade path settles in wrapped SOL.
function buyIx({ mint, user, creator, feeRecipient, buybackFeeRecipient, amountTokens, maxSolCost, quote }) {
  const bondingCurve = pda([Buffer.from('bonding-curve'), mint.toBuffer()]);
  const creatorVault = pda([Buffer.from('creator-vault'), creator.toBuffer()]);
  const userVolume = pda([Buffer.from('user_volume_accumulator'), user.toBuffer()]);
  const qMint = quote ? quote.mint : WSOL;
  const qProgram = quote ? quote.tokenProgram : TOKEN_PROGRAM;
  const q = (owner) => ataOf(owner, qMint, qProgram);
  // For a paired launch, spend an exact amount of the quote instead of asking for
  // an exact number of tokens — the same instruction the live stock launches use,
  // and it removes the slippage guesswork from sizing a dev buy.
  const data = quote
    ? Buffer.concat([IX.buy_exact_quote_in_v2, u64(maxSolCost), u64(amountTokens)])
    : Buffer.concat([IX.buy_v2, u64(amountTokens), u64(maxSolCost)]);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    data,
    keys: [
      key(PUMP_GLOBAL),
      key(mint),
      key(qMint),
      key(TOKEN_2022),
      key(qProgram),
      key(ATA_PROGRAM),
      key(feeRecipient, false, true),
      key(q(feeRecipient), false, true),
      key(buybackFeeRecipient, false, true),
      key(q(buybackFeeRecipient), false, true),
      key(bondingCurve, false, true),
      key(ataOf(bondingCurve, mint, TOKEN_2022), false, true),
      key(q(bondingCurve), false, true),
      key(user, true, true),
      key(ataOf(user, mint, TOKEN_2022), false, true),
      key(q(user), false, true),
      key(creatorVault, false, true),
      key(q(creatorVault), false, true),
      key(pda([Buffer.from('sharing-config'), mint.toBuffer()], PUMP_FEE_PROGRAM)),
      key(PUMP_GLOBAL_VOLUME),
      key(userVolume, false, true),
      key(q(userVolume), false, true),
      key(PUMP_FEE_CONFIG),
      key(PUMP_FEE_PROGRAM),
      key(SYS),
      key(PUMP_EVENT_AUTHORITY),
      key(PUMP_PROGRAM),
      // an active transfer hook expects its extra accounts on every transfer
      ...(quote?.hookAccounts ?? []),
    ],
  });
}

/// createIdempotent on the associated-token program — instruction tag 1, the
/// same one pump.fun's own launch tx uses for the creator's token account.
function createAtaIdempotentIx(payer, owner, mint, tokenProgram) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.from([1]),
    keys: [
      key(payer, true, true),
      key(ataOf(owner, mint, tokenProgram), false, true),
      key(owner),
      key(mint),
      key(SYS),
      key(tokenProgram),
    ],
  });
}

/// The creator pump will record on a new coin's curve - what its creator_vault
/// is seeded by. A holder-rewards coin gets a per-mint address whose
/// derivation pump does not publish (seen 2026-10-21: a different address for
/// every mint, none of the obvious seeds), so it is read off a simulated
/// create of this exact mint rather than guessed.
export async function curveCreatorAfterCreate(opts) {
  const { connection, mint } = opts;
  const tx = await buildPumpLaunch({ ...opts, devBuySol: 0, buyCreator: undefined });
  const bc = pda([Buffer.from('bonding-curve'), mint.publicKey.toBuffer()]);
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    accounts: { addresses: [bc.toBase58()], encoding: 'base64' },
  });
  const data = sim.value.accounts?.[0]?.data?.[0];
  if (sim.value.err || !data) throw new Error('could not work out the coin\'s creator for the dev buy: ' + JSON.stringify(sim.value.err));
  return new PublicKey(Buffer.from(data, 'base64').subarray(49, 81));   // BondingCurve.creator
}

/// Build the launch transaction without sending it. Split out so the same code
/// can be simulated, dry-run, or fired by the watcher.
export async function buildPumpLaunch(opts) {
  const {
    connection, payer, mint, name, symbol, uri,
    devBuySol = 0, slippageBps = 1000, priorityMicroLamports = 200000, computeUnits = 600000,
    global, quote = null, cashback = false, feesToHolders = false, creatorFeeBps = 0,
    // see launchPump: create_v2 takes `creator` as an argument and that address
    // never signs, so the fees can be routed anywhere. Unset it is the payer.
    creatorAddress,
  } = opts;
  const g = global ?? await pumpStatus(connection.rpcEndpoint);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
    createV2Ix({
      mint: mint.publicKey, user: payer.publicKey, name, symbol, uri,
      creator: creatorAddress ? new PublicKey(creatorAddress) : payer.publicKey,
      quote, cashback, feesToHolders, creatorFeeBps,
    }),
  ];

  const lamports = quoteUiToRaw(devBuySol, quote);
  if (lamports > 0n) {
    // pump charges its fee on top of the swap, so the cap has to allow for it
    // pump's own fee, plus anything a Token-2022 transfer fee withholds on the way
    const feeBps = BigInt(g.feeBasisPoints ?? 0n) + BigInt(g.creatorFeeBasisPoints ?? 0n)
      + BigInt(quote?.transferFeeBps ?? 0);
    let withFee = lamports + (lamports * feeBps) / 10_000n;
    if (quote?.maxTransferFee) {
      const capped = lamports + BigInt(quote.maxTransferFee);
      if (capped < withFee) withFee = capped;
    }
    const maxSolCost = withFee + (withFee * BigInt(slippageBps)) / 10_000n;
    // ask for slightly fewer tokens than the spot quote so ordinary drift
    // between build and land cannot trip the slippage guard
    const spot = pumpTokensForSol(g, lamports, quote);
    const amountTokens = spot - (spot * BigInt(slippageBps)) / 10_000n;
    const zero = NATIVE_QUOTE.toBase58();
    const pick = (list, fallback) => {
      const live = (list || []).filter((r) => r.toBase58() !== zero);
      // pump rotates these per launch; any live entry is accepted
      return live.length ? live[Math.floor(Math.random() * live.length)] : fallback;
    };
    const feeRecipient = pick(g.feeRecipients, g.feeRecipient);
    const buybackFeeRecipient = pick(g.buybackFeeRecipients, feeRecipient);
    ixs.push(createAtaIdempotentIx(payer.publicKey, payer.publicKey, mint.publicKey, TOKEN_2022));
    ixs.push(createAtaIdempotentIx(
      payer.publicKey, payer.publicKey,
      quote ? quote.mint : WSOL, quote ? quote.tokenProgram : TOKEN_PROGRAM,
    ));
    // The buy's creator_vault is seeded by the creator the CURVE records, which
    // is not always the payer: a creator address puts that address there, and a
    // holder-rewards coin gets a per-mint address pump derives itself. Using the
    // payer for either failed the dev buy with ConstraintSeeds (2006) on
    // creator_vault.
    const buyCreator = opts.buyCreator
      ?? (feesToHolders
        ? await curveCreatorAfterCreate({ ...opts, global: g })
        : (creatorAddress ? new PublicKey(creatorAddress) : payer.publicKey));
    ixs.push(buyIx({
      mint: mint.publicKey, user: payer.publicKey, creator: buyCreator,
      feeRecipient, buybackFeeRecipient, amountTokens, maxSolCost, quote,
    }));
  }

  const lut = opts.lookupTable ?? await connection.getAddressLookupTable(PUMP_LOOKUP_TABLE);
  // for callers that sign the launch themselves (the slot launcher): the launch
  // instructions without the compute budget, plus the lookup table
  if (opts.returnIxs) return { instructions: ixs.slice(2), lookupTable: lut?.value || null };

  // 'confirmed', not 'finalized': a finalized hash is ~32 slots (13s+) old the
  // moment you get it, which throws away a third of the ~60s validity window and
  // is a large part of why launches were dying on "block height exceeded".
  const blockhash = opts.blockhash
    ?? (await connection.getLatestBlockhash('confirmed')).blockhash;
  const msg = new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message(lut?.value ? [lut.value] : []);
  const tx = new VersionedTransaction(msg);
  // dry runs build with only a pubkey for the payer, and simulate with
  // sigVerify off — real launches pass a Keypair and get a signed tx
  if (payer.secretKey) tx.sign([payer, mint]); else tx.sign([mint]);
  return tx;
}

// ---------------------------------------------------------------------------
// Token-2022 quote support
//
// pump's quote path rejects Token-2022 today (InvalidQuoteTokenProgram), but the
// tokenised equities everyone wants to pair against are all Token-2022, so this
// is built and ready for the moment that flips. It is written against what those
// mints actually carry, read off chain rather than assumed — NVDAx and NVDAon
// were the reference.
//
// Four extensions change how a launch has to be built:
//
//   ScaledUiAmount    the UI amount is raw * multiplier / 10^decimals, NOT the
//                     plain decimal shift. NVDAx sits at 1.0001 and NVDAon at
//                     1.00093, and the multiplier moves on a schedule, so a dev
//                     buy typed in UI units has to be divided by it or you spend
//                     the wrong amount.
//   TransferFeeConfig a fee is withheld on transfer, so the curve receives less
//                     than you send and the cap needs headroom. Neither
//                     reference mint has one; handled anyway.
//   TransferHook      an active hook needs its ExtraAccountMetaList appended to
//                     every transfer. Both reference mints declare the extension
//                     with the System Program as the hook, which means none.
//   DefaultAccountState  if new accounts default to Frozen, the curve's quote
//                     account is born frozen and the launch cannot work at all.
//
// Pausable and PermanentDelegate do not change the transaction but do change
// whether you want to launch against the thing, so they are surfaced too.
// ---------------------------------------------------------------------------
const EXT_TRANSFER_FEE = 1;
const EXT_DEFAULT_ACCOUNT_STATE = 6;
const EXT_PERMANENT_DELEGATE = 12;
const EXT_TRANSFER_HOOK = 14;
const EXT_SCALED_UI_AMOUNT = 25;
const EXT_PAUSABLE = 26;
const MINT_BASE_LEN = 82;
const EXT_START = 166; // 82-byte base mint, padding to 165, then account-type byte

/// Parse the extension TLVs a Token-2022 mint carries. SPL Token mints have none.
export function parseMintExtensions(data) {
  const out = {};
  if (data.length <= EXT_START) return out;
  let o = EXT_START;
  while (o + 4 <= data.length) {
    const type = data.readUInt16LE(o);
    const len = data.readUInt16LE(o + 2);
    if (type === 0 && len === 0) break;
    if (o + 4 + len > data.length) break;
    out[type] = data.subarray(o + 4, o + 4 + len);
    o += 4 + len;
  }
  return out;
}

/// Everything about a quote mint that changes how the launch is built, plus the
/// things that should stop you launching at all.
export async function inspectMint(connection, mintAddress) {
  const mint = new PublicKey(mintAddress);
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`quote mint ${mintAddress} does not exist on chain`);
  const program = info.owner;
  const isSpl = program.equals(TOKEN_PROGRAM);
  const isT22 = program.equals(TOKEN_2022);
  if (!isSpl && !isT22) throw new Error(`${mintAddress} is not a token mint (owned by ${program.toBase58()})`);

  const q = {
    mint, tokenProgram: program, isToken2022: isT22,
    decimals: info.data[MINT_BASE_LEN - 38], // byte 44
    uiMultiplier: 1,
    transferFeeBps: 0, maxTransferFee: 0n,
    transferHookProgram: null,
    defaultFrozen: false, paused: false, permanentDelegate: null,
    blockers: [], warnings: [],
  };
  if (!isT22) return q;

  const ext = parseMintExtensions(info.data);

  // ScaledUiAmount: authority(32) multiplier(f64) effectiveTs(i64) newMultiplier(f64)
  const scaled = ext[EXT_SCALED_UI_AMOUNT];
  if (scaled && scaled.length >= 56) {
    const current = scaled.readDoubleLE(32);
    const effectiveTs = Number(scaled.readBigInt64LE(40));
    const next = scaled.readDoubleLE(48);
    const now = Math.floor(Date.now() / 1000);
    q.uiMultiplier = (effectiveTs && now >= effectiveTs && next > 0) ? next : (current > 0 ? current : 1);
    if (q.uiMultiplier !== 1) {
      q.warnings.push(`scaled UI amount: 1 token = ${q.uiMultiplier} raw units of value — amounts are converted for you`);
    }
  }

  // TransferFeeConfig: two authorities (64), withheld (8), then older/newer
  // TransferFee records of {epoch u64, maximumFee u64, basisPoints u16}
  const fee = ext[EXT_TRANSFER_FEE];
  if (fee && fee.length >= 72 + 18) {
    const newer = fee.subarray(fee.length - 18);
    q.maxTransferFee = newer.readBigUInt64LE(8);
    q.transferFeeBps = newer.readUInt16LE(16);
    if (q.transferFeeBps > 0) {
      q.warnings.push(`transfer fee ${q.transferFeeBps / 100}% is withheld on every move of this quote`);
    }
  }

  const hook = ext[EXT_TRANSFER_HOOK];
  if (hook && hook.length >= 64) {
    const prog = new PublicKey(hook.subarray(32, 64));
    // the System Program here means the extension exists but no hook is set
    if (!prog.equals(SYS)) q.transferHookProgram = prog;
  }

  const state = ext[EXT_DEFAULT_ACCOUNT_STATE];
  if (state && state.length >= 1 && state.readUInt8(0) === 2) {
    q.defaultFrozen = true;
    q.blockers.push('new token accounts for this mint are frozen by default, so the curve\'s quote account would be unusable');
  }

  const pausable = ext[EXT_PAUSABLE];
  if (pausable && pausable.length >= 33 && pausable.readUInt8(32) === 1) {
    q.paused = true;
    q.blockers.push('this mint is currently PAUSED — no transfers can settle');
  } else if (pausable) {
    q.warnings.push('mint is pausable: the issuer can halt all transfers, including trading on your curve');
  }

  const delegate = ext[EXT_PERMANENT_DELEGATE];
  if (delegate && delegate.length >= 32) {
    q.permanentDelegate = new PublicKey(delegate.subarray(0, 32));
    q.warnings.push(`permanent delegate ${q.permanentDelegate.toBase58().slice(0, 8)}… can move this quote out of any account at will`);
  }

  return q;
}

/// A transfer hook wants its ExtraAccountMetaList appended to every transfer.
///
/// Fixed addresses in that list can be passed straight through. Entries that are
/// derived from the instruction's own data need the full transfer-hook interface
/// resolution, and rather than guess at those this reports them so the launch can
/// refuse honestly instead of failing on chain.
export async function resolveTransferHookAccounts(connection, hookProgram, mint) {
  const listPda = PublicKey.findProgramAddressSync(
    [Buffer.from('extra-account-metas'), mint.toBuffer()], hookProgram,
  )[0];
  const info = await connection.getAccountInfo(listPda);
  if (!info) return { accounts: [], unresolved: 0, listPda };

  // ExtraAccountMetaList: 8 disc, u32 length, u32 count, then 35-byte metas of
  // { discriminator u8, addressConfig [32], isSigner bool, isWritable bool }
  const count = info.data.readUInt32LE(12);
  const accounts = [{ pubkey: hookProgram, isSigner: false, isWritable: false },
    { pubkey: listPda, isSigner: false, isWritable: false }];
  let unresolved = 0;
  for (let i = 0; i < count; i++) {
    const at = 16 + i * 35;
    if (at + 35 > info.data.length) break;
    const kind = info.data.readUInt8(at);
    const cfg = info.data.subarray(at + 1, at + 33);
    const isSigner = info.data.readUInt8(at + 33) === 1;
    const isWritable = info.data.readUInt8(at + 34) === 1;
    if (kind === 0) {
      accounts.push({ pubkey: new PublicKey(cfg), isSigner, isWritable });
    } else {
      unresolved++; // PDA derived from instruction data — not resolvable here
    }
  }
  return { accounts, unresolved, listPda };
}

/// Resolve a quote mint into what the instructions need.
///
/// Deliberately does NOT check pump's whitelist. Whether a pairing is allowed is
/// the program's call, and asking it costs nothing (see pumpProbe) — refusing
/// here would make it impossible to stage a launch against a contract before
/// pump enables it, which is the entire point of arming one.
async function resolveQuote(connection, quoteMint, { global = null, forCreate = false } = {}) {
  if (!quoteMint || quoteMint === NATIVE_QUOTE.toBase58()) return null;
  const q = await inspectMint(connection, quoteMint);
  const registry = global?.registry ?? await pumpQuoteRegistry(connection).catch(() => []);
  const entry = registry.find((r) => r.mint === q.mint.toBase58());
  if (entry) q.virtualQuoteReserves = entry.virtualQuoteReserves;
  if (q.transferHookProgram) {
    const hook = await resolveTransferHookAccounts(connection, q.transferHookProgram, q.mint);
    q.hookAccounts = hook.accounts;
    if (hook.unresolved > 0) {
      q.blockers.push(
        `transfer hook ${q.transferHookProgram.toBase58().slice(0, 8)}… needs ${hook.unresolved} `
        + 'dynamically-derived account(s) that cannot be resolved here',
      );
    } else {
      q.warnings.push(`transfer hook active: ${hook.accounts.length} extra account(s) attached to each trade`);
    }
  }
  // A nested quote is allowed to sit anywhere on its own chain, so what matters
  // is the whole chain: whether its bottom is eligible, whether anything on it
  // is mid-migration, and how deep the new coin would land. The walker collects
  // all three; none of them is a property of the quote coin alone.
  q.pumpChain = forCreate ? await pumpQuoteChain(connection, q.mint, registry).catch(() => null) : null;
  if (q.pumpChain) {
    q.blockers.push(...q.pumpChain.blockers);
    q.depth = q.pumpChain.newDepth;
    // The walk and the program should agree about how deep the quote already
    // is. They are derived two different ways - one by following stored
    // quote_mints, one read straight off the curve - so a mismatch means the
    // walk stopped somewhere the program would not, and the accounts would be
    // the wrong shape. Worth saying out loud rather than discovering in a
    // QuoteChainAccountsRequired.
    if (q.pumpChain.storedDepth !== q.pumpChain.depth) {
      q.warnings.push(
        `this quote's chain walks ${q.pumpChain.depth} deep but its curve records depth `
        + `${q.pumpChain.storedDepth} - the account list may not match what the program expects`,
      );
    }
    // The cap, read live. 1 until 2026-10-13, 2 after it, and the program
    // refuses more than 5 whatever Global says. Checked here so an over-deep
    // pairing is named rather than returned as CurveDepthExceeded.
    const cap = global ? Math.min(Number(global.maxCurveDepth ?? 1), MAX_CURVE_DEPTH) : MAX_CURVE_DEPTH;
    if (q.depth > cap) {
      q.blockers.push(
        `this pairing would make the new coin depth ${q.depth}; pump allows ${cap} today `
        + '(CurveDepthExceeded)',
      );
    }
  }
  return q;
}

// --- pairing against another pump coin, at any depth -------------------------
//
// Every bonding curve stores a `depth`: 0 for a coin paired with SOL, USDC or a
// listed quote mint, and the quote coin's depth plus one for a coin paired with
// a pump coin. So for SOL -> A -> B -> C, A is 0, B is 1 and C is 2. pump caps
// it with `Global.max_curve_depth` (1 at first, 2 since 2026-10-13) and the
// program refuses more than 5 whatever that says.
//
// A coin pump LISTS as a quote mint counts as depth 0 for its children whatever
// its own depth, and none of the accounts below are read for it. That is the
// distinction this file first got wrong: the two live examples,
//
//   EXgYtzKh...pump  quoted in GDz2tXD7...pump, which is quoted in SOL
//   E4q7cAYJ...pump  quoted in 9yPESNHi...pump, which is quoted in 9cRCn9rG...pump
//
// read like one chain of two and one of three, and 9cRCn9rG really is a pump
// coin - but it is also a registry mint, so it terminates the chain. Both coins
// carried 24 accounts, one group, depth 1. Reading that as proof that chains
// were forbidden was the mistake; it only ever proved where a chain ENDS.
//
// Both are still create_v2 - same discriminator, no new instruction - carrying
// the 16 fixed accounts and then one group for the quote coin:
//
//   [0] the quote mint                    [4] the quote's bonding curve
//   [1] the new curve's account for it    [5] the quote's PumpSwap pool
//   [2] the quote's token program         [6] that pool's base vault
//   [3] quote_control (the registry)      [7] that pool's quote vault
//
// then four more slots for each coin BELOW the quote, nearest first, down to
// the depth-0 coin: its curve, pool, base vault, quote vault.
//
// The pool slots exist only for a coin that has MIGRATED - before that there is
// no pool and those three accounts do not exist. Groups are packed, so the next
// curve sits at index 5 when the quote is still on its curve and at index 8
// when it has migrated. Appending a fixed four per coin is wrong the moment any
// coin on the chain is still on its curve.
const PUMP_AMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/// The program's own ceiling, whatever Global allows today.
export const MAX_CURVE_DEPTH = 5;

/// Where one coin on the chain keeps its liquidity.
///
/// `migrated` is read off the chain - the pool account either exists or it does
/// not - rather than inferred from `complete`. The two come apart for exactly
/// the window the program names QuoteCurveAwaitingMigration (6107): a curve that
/// has sold out but whose migrate_v2 has not run yet.
async function chainLink(connection, mint) {
  const curve = await pumpCurve(connection, mint);
  if (!curve) return null;

  // The curve records native SOL as the all-zero pubkey while the pool holds
  // wrapped SOL, so the pool's pairing has to be translated, not copied.
  const native = curve.quoteMint.equals(NATIVE_QUOTE);
  const inner = native ? WSOL_MINT : curve.quoteMint;

  const poolAuthority = pda([Buffer.from('pool-authority'), mint.toBuffer()]);
  const pool = pda(
    [Buffer.from('pool'), Buffer.from([0, 0]), poolAuthority.toBuffer(), mint.toBuffer(), inner.toBuffer()],
    PUMP_AMM_PROGRAM,
  );
  const [innerInfo, mintInfo, poolInfo] = await Promise.all([
    connection.getAccountInfo(inner),
    connection.getAccountInfo(mint),
    connection.getAccountInfo(pool),
  ]);
  const innerProgram = innerInfo ? innerInfo.owner : TOKEN_PROGRAM;
  const mintProgram = mintInfo ? mintInfo.owner : TOKEN_2022;
  const migrated = !!poolInfo && poolInfo.owner.equals(PUMP_AMM_PROGRAM);

  // The vaults are fields on the pool, not a derivation. They are the pool's
  // associated token accounts for every pool checked here, but the program
  // reads pool.pool_base_token_account, so that is what gets passed when the
  // pool exists; the derivation is only a fallback for a pool that does not
  // exist yet and whose slots will not be sent anyway.
  const d = migrated ? poolInfo.data : null;
  return {
    mint,
    curve: curve.address,
    quoteMint: curve.quoteMint,
    depth: curve.depth,
    complete: curve.complete,
    isMayhem: curve.isMayhem,
    native,
    innerQuote: inner,
    innerProgram,
    migrated,
    pool,
    poolBaseVault: d && d.length >= 171 ? new PublicKey(d.subarray(139, 171)) : ataOf(pool, mint, mintProgram),
    poolQuoteVault: d && d.length >= 203 ? new PublicKey(d.subarray(171, 203)) : ataOf(pool, inner, innerProgram),
  };
}

/// Walk the quote's chain: the quote coin, then each coin below it, nearest
/// first, down to the depth-0 coin that sits on SOL, USDC or a listed mint.
///
/// Returns null when the quote is not a pump coin at all, and null when it IS a
/// listed quote mint - a listed mint is depth 0 for its children and none of
/// these accounts are read for it, so taking the nested path there would attach
/// accounts the program ignores. 9cRCn9rG is both a pump coin and a listed
/// mint, which is exactly where that matters.
export async function pumpQuoteChain(connection, quoteMint, listedQuotes = null) {
  const listed = new Set(
    (listedQuotes ?? await pumpQuoteRegistry(connection).catch(() => [])).map((r) => r.mint ?? r),
  );
  const start = new PublicKey(quoteMint);
  if (listed.has(start.toBase58())) return null;

  const links = [];
  const blockers = [];
  let cursor = start;
  let bottomEligible = false;

  // At most MAX_CURVE_DEPTH + 1 links can ever be legal; one extra iteration
  // lets an over-long chain be reported as over-long rather than truncated.
  for (let i = 0; i <= MAX_CURVE_DEPTH + 1; i++) {
    const link = await chainLink(connection, cursor);
    if (!link) break;                            // cursor is not a pump coin
    links.push(link);
    if (link.native || listed.has(link.innerQuote.toBase58())) { bottomEligible = true; break; }
    cursor = link.quoteMint;
  }
  if (!links.length) return null;                // the quote is not a pump coin

  for (const l of links) {
    const who = l.mint.toBase58().slice(0, 8) + '…';
    // Mayhem coins are SOL/USDC only, so one anywhere on the chain sinks it.
    if (l.isMayhem) {
      blockers.push(
        who + " on this quote's chain is a mayhem-mode coin, which pump does not allow as a quote "
        + '(QuoteBondingCurveNotEligible)',
      );
    }
    // A sold-out curve with no pool is a real and temporary state, so name the
    // coin and say it is worth retrying rather than report a flat refusal.
    if (l.complete && !l.migrated) {
      blockers.push(
        who + " on this quote's chain has finished its curve but has not migrated yet "
        + '(QuoteCurveAwaitingMigration) - retry once migrate_v2 has run',
      );
    }
  }
  if (!bottomEligible) {
    const last = links[links.length - 1];
    blockers.push(
      "the bottom of this quote's chain is " + last.mint.toBase58().slice(0, 8) + '…, paired with '
      + last.innerQuote.toBase58().slice(0, 8) + '… - neither SOL, USDC nor a listed quote mint '
      + '(QuoteBondingCurveNotEligible)',
    );
  }

  return {
    links,
    // The quote's depth is the number of coins below it; the new coin lands one
    // deeper. The curve stores its own depth as well, so the walk can be
    // checked against the program's own answer rather than trusted.
    depth: links.length - 1,
    storedDepth: links[0].depth,
    newDepth: links.length,
    bottomEligible,
    blockers,
    // the single-level view, which is all a depth-0 quote needs
    complete: links[0].complete,
    migrated: links[0].migrated,
    innerQuote: links[0].innerQuote,
    innerProgram: links[0].innerProgram,
    curve: links[0].curve,
    pool: links[0].pool,
    poolBaseVault: links[0].poolBaseVault,
    poolQuoteVault: links[0].poolQuoteVault,
  };
}

/// Remaining accounts 4 onwards: one group per coin on the chain, packed, each
/// being that coin's curve plus its pool and two vaults only if it has
/// migrated. Slots are positional, so the packing is the whole point.
export function pumpQuoteChainAccounts(chain) {
  const out = [];
  for (const l of chain.links) {
    out.push(l.curve);
    if (l.migrated) out.push(l.pool, l.poolBaseVault, l.poolQuoteVault);
  }
  return out;
}

/// The chain for one quote, or null when the quote is an ordinary mint.
export async function pumpCoinQuoteAccounts(connection, quoteMint) {
  return pumpQuoteChain(connection, quoteMint);
}

/// UI amount -> raw units for a quote, honouring a scaled-UI multiplier.
export function quoteUiToRaw(uiAmount, quote) {
  const decimals = quote ? quote.decimals : 9;
  const multiplier = quote?.uiMultiplier && quote.uiMultiplier > 0 ? quote.uiMultiplier : 1;
  const scaled = Number(uiAmount) / multiplier;
  return BigInt(Math.floor(scaled * 10 ** decimals));
}

/// Ask the chain whether this launch would work, without spending anything.
///
/// A simulation is free and needs no signature, so this is how a pairing is
/// polled: build the real transaction, simulate it, and read the answer. When it
/// comes back ready the same inputs can be fired for real. Never throws for
/// "not yet" — that is a normal answer, not an error.
export async function pumpProbe(opts) {
  const {
    rpcUrl, payerPubkey, name, symbol, uri, devBuySol = 0, slippageBps = 1000,
    quoteMint, cashback = false, feesToHolders = false, creatorFeeBps = 0,
  } = opts;
  const connection = new Connection(rpcUrl, 'confirmed');
  try {
    const g = await pumpStatus(rpcUrl);
    if (!g.createV2Enabled) return { ready: false, reason: 'pump.fun has create_v2 disabled' };
    const quote = await resolveQuote(connection, quoteMint, { global: g, forCreate: true });
    // Two ways to be pairable now: in the quote registry, or a pump coin whose
    // chain bottoms out in a listed one. The second is pump's 2026-10-07
    // change, and reporting it as "not whitelisted" would have been wrong
    // rather than merely unhelpful. Note it does NOT require the quote to have
    // migrated - a coin still on its curve is a legal quote, it just has no
    // pool accounts to pass.
    const inRegistry = !quote || g.whitelistedQuotes.some((q) => q.mint === quote.mint.toBase58());
    const asPumpCoin = !!quote?.pumpChain?.bottomEligible;
    const whitelisted = inRegistry || asPumpCoin;

    const tx = await buildPumpLaunch({
      connection,
      payer: { publicKey: new PublicKey(payerPubkey) },
      mint: Keypair.generate(),
      name, symbol, uri, devBuySol, slippageBps, global: g, quote, cashback, feesToHolders, creatorFeeBps,
    });
    if (quote?.blockers?.length) {
      return { ready: false, whitelisted, reason: quote.blockers.join('; '), blockers: quote.blockers };
    }
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (!sim.value.err) {
      return {
        ready: true, reason: 'simulates clean', whitelisted,
        unitsConsumed: sim.value.unitsConsumed,
        token2022: !!quote?.isToken2022, warnings: quote?.warnings ?? [],
      };
    }

    const logs = sim.value.logs || [];
    const anchor = logs.find((l) => l.includes('Error Code'));
    const code = anchor?.match(/Error Code: (\w+)/)?.[1];
    return {
      ready: false,
      whitelisted,
      reason: code
        || (whitelisted ? JSON.stringify(sim.value.err) : 'quote not whitelisted by pump yet'),
      err: sim.value.err,
      token2022: !!quote?.isToken2022,
      warnings: quote?.warnings ?? [],
    };
  } catch (e) {
    return { ready: false, reason: e?.message || String(e) };
  }
}

/// Launch on pump.fun. Returns { mint, sig }.
/// Read everything a launch needs that does not depend on the coin itself.
///
/// Safe to call speculatively and repeatedly - it only reads. Hand the result
/// back to launchPump as `preloaded` and a launch starts at its simulation
/// rather than at four round trips of setup.
export async function pumpWarmup({ rpcUrl, quoteMint }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  // one at a time for the same reason launchPump does it that way - a burst on
  // one key gets throttled, and nothing here is in a hurry
  const global = await pumpStatus(rpcUrl);
  const quote = await resolveQuote(connection, quoteMint, { global, forCreate: true });
  const lookupTable = await connection.getAddressLookupTable(PUMP_LOOKUP_TABLE);
  return { global, quote, lookupTable, quoteMint: quoteMint ?? null, at: Date.now() };
}

export async function launchPump(opts) {
  const {
    rpcUrl, secretKey, name, symbol, uri, devBuySol = 0,
    slippageBps = 1000, quoteMint, cashback = false, feesToHolders = false, creatorFeeBps = 0,
    simulateOnly = false, onStatus,
    // Who receives the creator fees, which need not be the wallet launching.
    //
    // create_v2 takes `creator` as an ARGUMENT and that address never signs, so
    // it can be any wallet. That is exactly how agencypad.fun works: the human
    // pays and signs, while `creator` is a fresh wallet Agency generates and
    // custodies, and that wallet IS the coin's treasury - which is what their
    // "creator fees -> its own treasury" and "keys never reachable" describe.
    //
    // Unset it stays the payer, which is pump's default and what every launch
    // here did before. Setting it gives the fees away: whoever holds that key
    // collects them, and it cannot be changed afterwards.
    creatorAddress,
  } = opts;
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');

  // Everything needed before a launch can even be simulated - pump's global
  // config, the quote, the address lookup table - is fetched here, and this
  // used to be the slowest part of a launch.
  //
  // Firing them off together looked like the obvious fix and measured WORSE:
  // 158ms against 72ms on one Helius key, 82 against 75 on the other. The
  // provider throttles concurrent requests per key, and a burst that trips its
  // limit buys a 500-1000ms backoff per retry - which is where a launch on a
  // busy key really loses its seconds. So they stay one at a time.
  //
  // The actual fix is not doing them here at all. None depend on the coin, so a
  // caller can read them ahead of time - the extension does it while you are
  // still filling the panel in - and pass them in, leaving this block a no-op.
  const pre = opts.preloaded || {};
  say(pre.global ? 'using the pump.fun config already read…' : 'reading pump.fun config…');
  const g = pre.global ?? await pumpStatus(rpcUrl);
  // null is a legitimate quote (a plain SOL pair), so presence decides here
  const quote = 'quote' in pre ? pre.quote : await resolveQuote(connection, quoteMint, { global: g, forCreate: true });
  const lookupTable = pre.lookupTable ?? await connection.getAddressLookupTable(PUMP_LOOKUP_TABLE);

  if (!g.createV2Enabled) throw new Error('pump.fun has create_v2 disabled right now');

  // Cashback was retired by pump.fun and create_v2 now fails outright when the
  // flag is set, so asking for it can only produce a launch that does not
  // happen. Better to say why here than to let the program reject it.
  if (cashback) {
    throw new Error(
      'pump.fun removed cashback coins - create_v2 rejects the flag now. '
      + 'Holder rewards (fees to holders) is the replacement.',
    );
  }

  // Checked against the chain rather than against a constant, because the
  // ceiling is a global pump.fun can move and has: the tier table tops out at
  // 95 bps, but an explicitly set fee is allowed up to
  // max_configurable_creator_fee_bps, which currently reads 300.
  const wantBps = Math.round(Number(creatorFeeBps) || 0);
  if (wantBps > 0) {
    if (!g.creatorFeeConfigurable) {
      throw new Error('pump.fun currently has custom creator fees switched off, so the rate cannot be set');
    }
    const maxBps = Number(g.maxConfigurableCreatorFeeBps || 0);
    if (wantBps > maxBps) {
      throw new Error(
        `a ${(wantBps / 100).toFixed(2)}% creator fee is above pump.fun's current ceiling of `
        + `${(maxBps / 100).toFixed(2)}% (${maxBps} bps)`,
      );
    }
  }
  if (feesToHolders && !g.isHolderRewardEnabled) {
    throw new Error('pump.fun currently has holder-reward coins switched off');
  }
  if (feesToHolders && wantBps === 0) {
    say('note: no rate set, so holders get the market-cap tier rate (tops out at 0.95%)');
  }
  if (feesToHolders) say(`holders receive ${(wantBps / 100).toFixed(2)}% of every trade`);
  if (quote?.blockers?.length) {
    throw new Error(`cannot launch against ${quoteMint}: ${quote.blockers.join('; ')}`);
  }
  for (const w of quote?.warnings ?? []) say('note: ' + w);

  const payer = Keypair.fromSecretKey(bs58.decode(secretKey));
  const mint = Keypair.generate();
  // read once for a holder-rewards coin with a dev buy (see buildPumpLaunch),
  // so the three builds below do not each simulate it
  const buyCreator = feesToHolders && quoteUiToRaw(devBuySol, quote) > 0n
    ? await curveCreatorAfterCreate({ connection, payer, mint, name, symbol, uri, global: g, quote, feesToHolders, creatorFeeBps: wantBps, creatorAddress, lookupTable })
    : undefined;

  say('simulating…');
  const dry = await buildPumpLaunch({
    connection, payer, mint, name, symbol, uri, devBuySol, slippageBps, global: g, quote, cashback,
    feesToHolders, creatorFeeBps: wantBps, creatorAddress, lookupTable, buyCreator,
  });
  const sim = await connection.simulateTransaction(dry, { commitment: 'confirmed' });
  if (sim.value.err) {
    const logs = sim.value.logs || [];
    const anchor = logs.find((l) => l.includes('Error Code')) || logs.slice(-3).join(' | ');
    const hint = JSON.stringify(sim.value.err).includes('ProgramFailedToComplete')
      ? ' — that is the compute budget running out, not a bad instruction'
      : '';
    throw new Error(`pump.fun launch would fail: ${JSON.stringify(sim.value.err)} ${anchor}${hint}`);
  }

  // Size the compute budget from what the dry run actually used rather than a
  // guess. A Token-2022 paired launch with a dev buy measured 285k units, and a
  // fixed 300k limit left so little headroom that a slightly heavier one died
  // with ProgramFailedToComplete — the truncated-log signature of exhausting the
  // budget rather than of a bad instruction. 35% headroom, floor 600k, and the
  // 1.4M per-transaction ceiling.
  const measured = Number(sim.value.unitsConsumed || 0);
  const computeUnits = Math.min(1_400_000, Math.max(600_000, Math.ceil(measured * 1.35)));
  say(`simulation used ${measured.toLocaleString()} CU — sending with ${computeUnits.toLocaleString()}`);
  if (simulateOnly) return { mint: mint.publicKey.toBase58(), sig: null, simulated: true };
  // checked and simulated like a normal launch, but handed back unsent for the
  // caller to wrap (nonce, slot guard, tips) and sign: the slot launcher
  if (opts.prebuild) {
    const built = await buildPumpLaunch({
      connection, payer, mint, name, symbol, uri, devBuySol, slippageBps, global: g, quote, cashback,
      feesToHolders, creatorFeeBps: wantBps, creatorAddress, lookupTable, buyCreator, returnIxs: true,
    });
    return { mint: mint.publicKey.toBase58(), mintKeypair: mint, ...built, computeUnits, measured };
  }

  // Rebuild against a blockhash fetched NOW, so none of the work above eats into
  // the validity window, then keep rebroadcasting until it lands or the hash
  // expires. sendRawTransaction alone gives up long before the window closes.
  say('sending launch tx\u2026');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = await buildPumpLaunch({
    connection, payer, mint, name, symbol, uri, devBuySol, slippageBps, global: g, quote, cashback,
    feesToHolders, creatorFeeBps: wantBps, creatorAddress, lookupTable, buyCreator, blockhash, computeUnits,
  });
  const raw = tx.serialize();

  const sig = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  const started = Date.now();
  let lastRebroadcast = 0;
  for (;;) {
    const st = await connection.getSignatureStatuses([sig]);
    const v = st.value[0];
    if (v) {
      if (v.err) throw new Error(`launch landed but failed: ${JSON.stringify(v.err)} (${sig})`);
      if (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') {
        return { mint: mint.publicKey.toBase58(), sig };
      }
    }
    const height = await connection.getBlockHeight('confirmed');
    if (height > lastValidBlockHeight) {
      throw new Error(
        `launch expired before it landed (blockhash no longer valid). Nothing was spent. `
        + `Try again, and raise the priority fee if the network is busy. Signature was ${sig}`,
      );
    }
    // Solana drops unconfirmed txs from the mempool quickly; resending the same
    // signed bytes is safe and is how a launch survives a congested slot
    if (Date.now() - lastRebroadcast > 2000) {
      await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      lastRebroadcast = Date.now();
      say(`waiting for confirmation\u2026 ${Math.round((Date.now() - started) / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------------------
// Trading a pump.fun token
//
// Works for any quote the curve was opened against — SOL or one of the stock
// mints — because the v2 trade instructions carry the quote explicitly. Two
// cases:
//
//   still on the curve   trade the bonding curve directly, which is exact and
//                        depends on nothing but pump's own program
//   graduated            the curve is drained and liquidity lives in PumpSwap;
//                        routed through Jupiter instead, which indexes it
//
// buy_exact_quote_in_v2 takes an exact amount of the quote in, which is how a
// buy should read. sell_v2 takes an exact token amount in.
// ---------------------------------------------------------------------------

/// Read a bonding curve. Returns null if the mint was never launched on pump.
export async function pumpCurve(connection, mintAddress) {
  const mint = new PublicKey(mintAddress);
  const curve = pda([Buffer.from('bonding-curve'), mint.toBuffer()]);
  const info = await connection.getAccountInfo(curve);
  if (!info) return null;
  // An address is not a curve just because something lives there. Checking the
  // owner and the length matters now that every quote gets probed this way:
  // pda(['bonding-curve', USDC]) resolves to a real but unrelated account, and
  // reading reserves straight off it threw ERR_BUFFER_OUT_OF_BOUNDS rather than
  // answering "not a pump coin".
  if (!info.owner.equals(PUMP_PROGRAM) || info.data.length < 81) return null;
  const d = info.data;
  return {
    // Written only once a nested coin is created, so an older curve's account
    // is short and simply has no byte there. Absent means depth 0, which is
    // what every coin paired with SOL, USDC or a listed mint is.
    depth: d.length >= 142 ? d.readUInt8(141) : 0,
    isMayhem: d.readUInt8(81) !== 0,
    creatorFeeBps: d.length >= 123 ? d.readBigUInt64LE(115) : 0n,
    address: curve,
    mint,
    virtualTokenReserves: d.readBigUInt64LE(8),
    virtualQuoteReserves: d.readBigUInt64LE(16),
    realTokenReserves: d.readBigUInt64LE(24),
    realQuoteReserves: d.readBigUInt64LE(32),
    tokenTotalSupply: d.readBigUInt64LE(40),
    complete: d.readUInt8(48) !== 0,
    creator: new PublicKey(d.subarray(49, 81)),
    isCashbackCoin: d.readUInt8(82) !== 0,
    quoteMint: d.length >= 115 ? new PublicKey(d.subarray(83, 115)) : NATIVE_QUOTE,
  };
}

/// Constant product against the curve's live reserves, fee taken off the input.
/// Quoting locally rather than round-tripping an RPC keeps the UI responsive;
/// every trade is simulated before it is sent regardless.
export function pumpCurveQuote(curve, global, amountIn, side) {
  const feeBps = BigInt(global.feeBasisPoints ?? 0n) + BigInt(global.creatorFeeBasisPoints ?? 0n);
  const vTok = curve.virtualTokenReserves;
  const vQuote = curve.virtualQuoteReserves;
  if (vTok <= 0n || vQuote <= 0n) return 0n;
  if (side === 'buy') {
    const net = amountIn - (amountIn * feeBps) / 10_000n;
    const out = (vTok * net) / (vQuote + net);
    return out > curve.realTokenReserves ? curve.realTokenReserves : out;
  }
  const gross = (vQuote * amountIn) / (vTok + amountIn);
  return gross - (gross * feeBps) / 10_000n;
}

function tradeKeys({ curve, quote, user, feeRecipient, buybackFeeRecipient, includeGlobalVolume }) {
  const qMint = quote ? quote.mint : WSOL;
  const qProgram = quote ? quote.tokenProgram : TOKEN_PROGRAM;
  const q = (owner) => ataOf(owner, qMint, qProgram);
  const userVolume = pda([Buffer.from('user_volume_accumulator'), user.toBuffer()]);
  const creatorVault = pda([Buffer.from('creator-vault'), curve.creator.toBuffer()]);
  const keys = [
    key(PUMP_GLOBAL),
    key(curve.mint),
    key(qMint),
    key(TOKEN_2022),
    key(qProgram),
    key(ATA_PROGRAM),
    key(feeRecipient, false, true),
    key(q(feeRecipient), false, true),
    key(buybackFeeRecipient, false, true),
    key(q(buybackFeeRecipient), false, true),
    key(curve.address, false, true),
    key(ataOf(curve.address, curve.mint, TOKEN_2022), false, true),
    key(q(curve.address), false, true),
    key(user, true, true),
    key(ataOf(user, curve.mint, TOKEN_2022), false, true),
    key(q(user), false, true),
    key(creatorVault, false, true),
    key(q(creatorVault), false, true),
    key(pda([Buffer.from('sharing-config'), curve.mint.toBuffer()], PUMP_FEE_PROGRAM)),
  ];
  // buy carries the global volume accumulator; sell does not
  if (includeGlobalVolume) keys.push(key(PUMP_GLOBAL_VOLUME, false, true));
  keys.push(
    key(userVolume, false, true),
    key(q(userVolume), false, true),
    key(PUMP_FEE_CONFIG),
    key(PUMP_FEE_PROGRAM),
    key(SYS),
    key(PUMP_EVENT_AUTHORITY),
    key(PUMP_PROGRAM),
    ...(quote?.hookAccounts ?? []),
  );
  return keys;
}

/// Buy or sell a pump.fun token that is still on its bonding curve.
///
/// `amountUi` is the quote spent on a buy, or the tokens sold on a sell.
export async function pumpTrade(opts) {
  const {
    rpcUrl, secretKey, mint: mintAddress, side, amountUi,
    slippageBps = 500, onStatus,
  } = opts;
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = Keypair.fromSecretKey(bs58.decode(secretKey));

  const curve = await pumpCurve(connection, mintAddress);
  if (!curve) throw new Error('no pump.fun bonding curve for that mint');
  if (curve.complete) {
    throw new Error(
      'this token has graduated off the bonding curve — its liquidity is in PumpSwap now. '
      + 'Trade it on the swap page, which routes through Jupiter.',
    );
  }

  const g = await pumpStatus(rpcUrl);
  const isNative = curve.quoteMint.toBase58() === NATIVE_QUOTE.toBase58();
  const quote = isNative ? null : await resolveQuote(connection, curve.quoteMint.toBase58());
  if (quote?.blockers?.length) throw new Error(quote.blockers.join('; '));

  const baseDecimals = 6;
  const rawIn = side === 'buy'
    ? (isNative ? BigInt(Math.floor(Number(amountUi) * 1e9)) : quoteUiToRaw(amountUi, quote))
    : BigInt(Math.floor(Number(amountUi) * 10 ** baseDecimals));
  if (rawIn <= 0n) throw new Error('amount must be greater than zero');

  const expected = pumpCurveQuote(curve, g, rawIn, side);
  const minOut = expected - (expected * BigInt(slippageBps)) / 10_000n;

  const zero = NATIVE_QUOTE.toBase58();
  const pick = (list, fallback) => {
    const live = (list || []).filter((r) => r.toBase58() !== zero);
    return live.length ? live[Math.floor(Math.random() * live.length)] : fallback;
  };
  const feeRecipient = pick(g.feeRecipients, g.feeRecipient);
  const buybackFeeRecipient = pick(g.buybackFeeRecipients, feeRecipient);

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }),
    createAtaIdempotentIx(payer.publicKey, payer.publicKey, curve.mint, TOKEN_2022),
    createAtaIdempotentIx(
      payer.publicKey, payer.publicKey,
      quote ? quote.mint : WSOL, quote ? quote.tokenProgram : TOKEN_PROGRAM,
    ),
    new TransactionInstruction({
      programId: PUMP_PROGRAM,
      data: side === 'buy'
        ? Buffer.concat([IX.buy_exact_quote_in_v2, u64(rawIn), u64(minOut)])
        : Buffer.concat([IX.sell_v2, u64(rawIn), u64(minOut)]),
      keys: tradeKeys({
        curve, quote, user: payer.publicKey, feeRecipient, buybackFeeRecipient,
        includeGlobalVolume: side === 'buy',
      }),
    }),
  ];

  const lut = await connection.getAddressLookupTable(PUMP_LOOKUP_TABLE);
  const build = (blockhash) => {
    const msg = new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs,
    }).compileToV0Message(lut?.value ? [lut.value] : []);
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    return tx;
  };

  say('simulating…');
  const probe = build((await connection.getLatestBlockhash('confirmed')).blockhash);
  const sim = await connection.simulateTransaction(probe, { commitment: 'confirmed' });
  if (sim.value.err) {
    const logs = sim.value.logs || [];
    const anchor = logs.find((l) => l.includes('Error Code')) || logs.slice(-3).join(' | ');
    throw new Error(`${side} would fail: ${JSON.stringify(sim.value.err)} ${anchor}`);
  }

  say('sending…');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const raw = build(blockhash).serialize();
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  let last = 0;
  for (;;) {
    const st = await connection.getSignatureStatuses([sig]);
    const v = st.value[0];
    if (v) {
      if (v.err) throw new Error(`${side} landed but failed: ${JSON.stringify(v.err)}`);
      if (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') {
        return { sig, expectedOut: expected.toString(), quoteMint: curve.quoteMint.toBase58() };
      }
    }
    if (await connection.getBlockHeight('confirmed') > lastValidBlockHeight) {
      throw new Error(`${side} expired before landing — nothing was spent (${sig})`);
    }
    if (Date.now() - last > 2000) {
      await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      last = Date.now();
      say('waiting for confirmation…');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
