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

  const zero = NATIVE_QUOTE.toBase58();
  const quotes = [];
  for (const q of g.whitelistedQuoteMints) {
    if (q.toBase58() === zero) continue;
    const mi = await connection.getAccountInfo(q).catch(() => null);
    quotes.push({
      mint: q.toBase58(),
      decimals: mi ? mi.data[44] : null,
      tokenProgram: mi ? mi.owner.toBase58() : null,
    });
  }
  return { ...g, whitelistedQuotes: quotes };
}

/// Tokens out for a given SOL in, on the constant-product curve pump seeds every
/// launch with. Fees are charged on top of the SOL you send, so they do not enter
/// this term — they are covered by the max_sol_cost headroom instead.
export function pumpTokensForSol(global, solLamports, quote = null) {
  const vTok = BigInt(global.initialVirtualTokenReserves);
  // a non-SOL curve is seeded from initial_virtual_quote_reserves instead
  const vSol = quote && global.initialVirtualQuoteReserves
    ? BigInt(global.initialVirtualQuoteReserves)
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
function createV2Ix({ mint, user, name, symbol, uri, creator, isMayhem = false, cashback = true, quote = null }) {
  const solVault = pda([Buffer.from('sol-vault')], PUMP_MAYHEM_PROGRAM);
  const mayhemState = pda([Buffer.from('mayhem-state'), mint.toBuffer()], PUMP_MAYHEM_PROGRAM);
  const bondingCurve = pda([Buffer.from('bonding-curve'), mint.toBuffer()]);
  const data = Buffer.concat([
    IX.create_v2, str(name), str(symbol), str(uri), creator.toBuffer(),
    Buffer.from([isMayhem ? 1 : 0]), Buffer.from([cashback ? 1 : 0]),
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
  const data = Buffer.concat([IX.buy_v2, u64(amountTokens), u64(maxSolCost)]);
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

/// Build the launch transaction without sending it. Split out so the same code
/// can be simulated, dry-run, or fired by the watcher.
export async function buildPumpLaunch(opts) {
  const {
    connection, payer, mint, name, symbol, uri,
    devBuySol = 0, slippageBps = 1000, priorityMicroLamports = 200000, computeUnits = 300000,
    global, quote = null, cashback = true,
  } = opts;
  const g = global ?? await pumpStatus(connection.rpcEndpoint);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
    createV2Ix({
      mint: mint.publicKey, user: payer.publicKey, name, symbol, uri,
      creator: payer.publicKey, quote, cashback,
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
    ixs.push(buyIx({
      mint: mint.publicKey, user: payer.publicKey, creator: payer.publicKey,
      feeRecipient, buybackFeeRecipient, amountTokens, maxSolCost, quote,
    }));
  }

  // 'confirmed', not 'finalized': a finalized hash is ~32 slots (13s+) old the
  // moment you get it, which throws away a third of the ~60s validity window and
  // is a large part of why launches were dying on "block height exceeded".
  const blockhash = opts.blockhash
    ?? (await connection.getLatestBlockhash('confirmed')).blockhash;
  const lut = opts.lookupTable ?? await connection.getAddressLookupTable(PUMP_LOOKUP_TABLE);
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
async function resolveQuote(connection, quoteMint) {
  if (!quoteMint || quoteMint === NATIVE_QUOTE.toBase58()) return null;
  const q = await inspectMint(connection, quoteMint);
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
  return q;
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
  const { rpcUrl, payerPubkey, name, symbol, uri, devBuySol = 0, slippageBps = 1000, quoteMint, cashback = true } = opts;
  const connection = new Connection(rpcUrl, 'confirmed');
  try {
    const g = await pumpStatus(rpcUrl);
    if (!g.createV2Enabled) return { ready: false, reason: 'pump.fun has create_v2 disabled' };
    const quote = await resolveQuote(connection, quoteMint);
    const whitelisted = !quote || g.whitelistedQuotes.some((q) => q.mint === quote.mint.toBase58());

    const tx = await buildPumpLaunch({
      connection,
      payer: { publicKey: new PublicKey(payerPubkey) },
      mint: Keypair.generate(),
      name, symbol, uri, devBuySol, slippageBps, global: g, quote, cashback,
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
export async function launchPump(opts) {
  const {
    rpcUrl, secretKey, name, symbol, uri, devBuySol = 0,
    slippageBps = 1000, quoteMint, cashback = true, simulateOnly = false, onStatus,
  } = opts;
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');

  say('reading pump.fun config…');
  const g = await pumpStatus(rpcUrl);
  if (!g.createV2Enabled) throw new Error('pump.fun has create_v2 disabled right now');
  const quote = await resolveQuote(connection, quoteMint);
  if (quote?.blockers?.length) {
    throw new Error(`cannot launch against ${quoteMint}: ${quote.blockers.join('; ')}`);
  }
  for (const w of quote?.warnings ?? []) say('note: ' + w);

  const payer = Keypair.fromSecretKey(bs58.decode(secretKey));

  const mint = Keypair.generate();

  // fetch the lookup table once and reuse it for both the dry run and the send
  const lookupTable = await connection.getAddressLookupTable(PUMP_LOOKUP_TABLE);

  say('simulating\u2026');
  const dry = await buildPumpLaunch({
    connection, payer, mint, name, symbol, uri, devBuySol, slippageBps, global: g, quote, cashback, lookupTable,
  });
  const sim = await connection.simulateTransaction(dry, { commitment: 'confirmed' });
  if (sim.value.err) {
    const logs = sim.value.logs || [];
    const anchor = logs.find((l) => l.includes('Error Code')) || logs.slice(-3).join(' | ');
    throw new Error(`pump.fun launch would fail: ${JSON.stringify(sim.value.err)} ${anchor}`);
  }
  if (simulateOnly) return { mint: mint.publicKey.toBase58(), sig: null, simulated: true };

  // Rebuild against a blockhash fetched NOW, so none of the work above eats into
  // the validity window, then keep rebroadcasting until it lands or the hash
  // expires. sendRawTransaction alone gives up long before the window closes.
  say('sending launch tx\u2026');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = await buildPumpLaunch({
    connection, payer, mint, name, symbol, uri, devBuySol, slippageBps, global: g, quote, cashback,
    lookupTable, blockhash,
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
