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

/// Mine a mint keypair whose address ends in `suffix` (pump.fun's convention is
/// "pump"). Purely cosmetic — the launch works with any keypair — so it yields
/// to the event loop and gives up rather than freezing the tab.
export function minePumpMint(suffix = 'pump', maxTries = 250000, onProgress) {
  const want = String(suffix || '');
  if (!want) return Keypair.generate();
  for (let i = 0; i < maxTries; i++) {
    const kp = Keypair.generate();
    if (kp.publicKey.toBase58().endsWith(want)) return kp;
    if (onProgress && i && i % 20000 === 0) onProgress(i);
  }
  return null;
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

// A non-SOL pairing is created by passing THREE remaining accounts to create_v2:
// the quote mint, the bonding curve's associated account for that quote, and the
// quote's token program. The IDL declares only 16 accounts and says nothing about
// them, which is why this looked impossible until a real USDC launch was decoded
// (tx 29trp9sX…, create_v2 with 19 accounts). Pass nothing extra and you get a
// native-SOL curve, exactly as before.
function createV2Ix({ mint, user, name, symbol, uri, creator, isMayhem = false, cashback = false, quote = null }) {
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
    global, quote = null,
  } = opts;
  const g = global ?? await pumpStatus(connection.rpcEndpoint);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
    createV2Ix({
      mint: mint.publicKey, user: payer.publicKey, name, symbol, uri,
      creator: payer.publicKey, quote,
    }),
  ];

  const qDecimals = quote ? quote.decimals : 9;
  const lamports = BigInt(Math.floor(Number(devBuySol) * 10 ** qDecimals));
  if (lamports > 0n) {
    // pump charges its fee on top of the swap, so the cap has to allow for it
    const feeBps = BigInt(g.feeBasisPoints ?? 0n) + BigInt(g.creatorFeeBasisPoints ?? 0n);
    const withFee = lamports + (lamports * feeBps) / 10_000n;
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

  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const lut = await connection.getAddressLookupTable(PUMP_LOOKUP_TABLE);
  const msg = new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message(lut.value ? [lut.value] : []);
  const tx = new VersionedTransaction(msg);
  // dry runs build with only a pubkey for the payer, and simulate with
  // sigVerify off — real launches pass a Keypair and get a signed tx
  if (payer.secretKey) tx.sign([payer, mint]); else tx.sign([mint]);
  return tx;
}

/// Launch on pump.fun. Returns { mint, sig }.
export async function launchPump(opts) {
  const {
    rpcUrl, secretKey, name, symbol, uri, devBuySol = 0,
    vanitySuffix = 'pump', slippageBps = 1000, quoteMint, simulateOnly = false, onStatus,
  } = opts;
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');

  say('reading pump.fun config…');
  const g = await pumpStatus(rpcUrl);
  if (!g.createV2Enabled) throw new Error('pump.fun has create_v2 disabled right now');

  // A non-SOL pairing needs a curve created against that quote. The program can
  // already TRADE any whitelisted quote (buy_v2 / sell_v2 / migrate_v2 all take a
  // quote_mint, and BondingCurve carries one), but no deployed create instruction
  // accepts a quote mint yet — create and create_v2 both open a native-SOL curve.
  // So refuse clearly rather than silently launching the wrong pair.
  // A quote must be on pump's whitelist; the program rejects anything else, so
  // fail here with the live list rather than burning a transaction to find out.
  let quote = null;
  if (quoteMint && quoteMint !== NATIVE_QUOTE.toBase58()) {
    const found = g.whitelistedQuotes.find((q) => q.mint === quoteMint);
    if (!found) {
      throw new Error(
        `${quoteMint} is not a pump.fun whitelisted quote. Currently whitelisted: `
        + `${g.whitelistedQuotes.map((q) => q.mint).join(', ') || 'none'}`,
      );
    }
    quote = {
      mint: new PublicKey(found.mint),
      tokenProgram: new PublicKey(found.tokenProgram),
      decimals: found.decimals,
    };
  }

  const payer = Keypair.fromSecretKey(bs58.decode(secretKey));
  say(vanitySuffix ? `mining a …${vanitySuffix} mint address…` : 'generating the mint…');
  const mint = vanitySuffix ? minePumpMint(vanitySuffix, 400000, (n) => say(`mining …${vanitySuffix}: ${n.toLocaleString()} tries`)) : Keypair.generate();
  if (!mint) throw new Error(`could not mine a …${vanitySuffix} address — try again or clear the suffix`);

  say('building launch tx…');
  const tx = await buildPumpLaunch({ connection, payer, mint, name, symbol, uri, devBuySol, slippageBps, global: g, quote });

  say('simulating…');
  const sim = await connection.simulateTransaction(tx, { commitment: 'confirmed' });
  if (sim.value.err) {
    const logs = sim.value.logs || [];
    const anchor = logs.find((l) => l.includes('Error Code')) || logs.slice(-3).join(' | ');
    throw new Error(`pump.fun launch would fail: ${JSON.stringify(sim.value.err)} ${anchor}`);
  }
  if (simulateOnly) return { mint: mint.publicKey.toBase58(), sig: null, simulated: true };

  say('sending launch tx…');
  const sig = await connection.sendTransaction(tx, { maxRetries: 3, skipPreflight: false });
  say(`confirming ${sig.slice(0, 12)}…`);
  const bh = await connection.getLatestBlockhash('finalized');
  const res = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  if (res.value.err) throw new Error(`launch landed but failed: ${JSON.stringify(res.value.err)}`);
  return { mint: mint.publicKey.toBase58(), sig };
}
