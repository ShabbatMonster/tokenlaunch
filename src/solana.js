// ---------------------------------------------------------------------------
// Solana / Meteora Dynamic Bonding Curve (DBC) launch path.
//
// Loaded lazily by main.js (dynamic import) so the heavy web3.js + Anchor +
// Meteora deps only reach the browser when someone actually launches on Solana.
// Built as its own bundle (docs/solana.js) with Node globals polyfilled — see
// build.mjs. Everything here runs client-side; the SOL key is decrypted in
// main.js and passed in, and this module signs + sends with it.
//
// Flow (two on-chain txs, per Meteora's docs):
//   1. partner.createConfig — defines the curve + binds the quote mint. The
//      config account is a fresh keypair we generate and co-sign.
//   2. creator.createPool   — mints the base token against that config and
//      opens the bonding curve. The base mint is a fresh keypair we co-sign.
//
// Quote-mint rules (from the on-chain program): any standard SPL mint works;
// a Token-2022 mint (like the pump token) works too as long as its only
// extensions are metadata-related AND migration targets DAMM v2 (not v1).
// ---------------------------------------------------------------------------
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, VersionedTransaction, sendAndConfirmTransaction, SystemProgram, Transaction, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  MINT_SIZE, getMinimumBalanceForRentExemptMint, NATIVE_MINT,
  createInitializeMint2Instruction, createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, createSetAuthorityInstruction, AuthorityType,
} from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';
import Decimal from 'decimal.js';
import {
  DynamicBondingCurveClient, buildCurve, swapQuote, getCurrentPoint,
  calculateQuoteToBaseFromAmountIn, MAX_SQRT_PRICE,
  wrapSOLInstruction, unwrapSOLInstruction,
  deriveDbcPoolAddress, deriveDbcTokenVaultAddress, deriveMintMetadata, METAPLEX_PROGRAM_ID,
  TokenType, TokenDecimal, TokenAuthorityOption,
  BaseFeeMode, CollectFeeMode, MigrationOption, MigrationFeeOption, ActivationType,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  Raydium, TxVersion, LAUNCHPAD_PROGRAM, getPdaLaunchpadConfigId, LaunchpadConfig,
  getPdaLaunchpadPoolId, LaunchpadPool,
  CLMM_PROGRAM_ID, TickUtil,
} from '@raydium-io/raydium-sdk-v2';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP = 'https://lite-api.jup.ag/swap/v1';

export const QUOTE_PRESETS = {
  SOL:  { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL',  decimals: 9 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
};

const DECIMAL_ENUM = { 6: TokenDecimal.SIX, 7: TokenDecimal.SEVEN, 8: TokenDecimal.EIGHT, 9: TokenDecimal.NINE };

// accept a base58 secret key (Phantom export) or a JSON array of 64 bytes
function keypairFromSecret(secret) {
  const s = secret.trim();
  if (s.startsWith('[')) {
    const arr = Uint8Array.from(JSON.parse(s));
    if (arr.length !== 64) throw new Error('SOL key array must be 64 bytes');
    return Keypair.fromSecretKey(arr);
  }
  const bytes = bs58.decode(s);
  if (bytes.length !== 64) throw new Error('SOL key must decode to 64 bytes');
  return Keypair.fromSecretKey(bytes);
}

/// Base decimals for a new DBC token: 9 whenever the supply fits a u64 at 9,
/// else 6.
///
/// This decides which curves can be built at all. At 6 decimals a 1B supply is
/// only 1e15 raw units, and a curve that sells nearly all of it up to a high
/// migration price rounds short of its own threshold - the SDK refuses it with
/// "Not enough liquidity ... amountLeft". JACKPOT (BhycXzE7) sells 99.81% of a
/// 1B supply to raise 21,408 SOL; its exact curve fails at 6 decimals and builds
/// at 9, which is what it uses. 9 caps the supply at ~18.4B tokens, so a bigger
/// supply falls back to 6 rather than overflowing.
export function meteoraBaseDecimals(totalSupply) {
  return BigInt(Math.ceil(Number(totalSupply))) * 10n ** 9n <= 18_446_744_073_709_551_615n ? 9 : 6;
}

// pump.fun-style curve, editable via `p`:
//   totalSupply, baseDecimals, feeBps (buy+sell), migrationThreshold (in whole
//   quote tokens), pctSupplyOnMigration, feeClaimer (all trading fees go here)
function buildLaunchConfig(quoteDecimals, p) {
  const quoteEnum = DECIMAL_ENUM[quoteDecimals];
  if (quoteEnum === undefined) throw new Error(`quote token has ${quoteDecimals} decimals; DBC supports 6–9`);
  const baseEnum = DECIMAL_ENUM[p.baseDecimals] ?? TokenDecimal.SIX;
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken,          // base is a standard SPL mint
      tokenBaseDecimal: baseEnum,
      tokenQuoteDecimal: quoteEnum,
      tokenAuthorityOption: TokenAuthorityOption.Immutable, // minting + freeze disabled
      totalTokenSupply: p.totalSupply,
      leftover: 0,
    },
    fee: {
      // flat fee (start == end) applied to every swap = same bps on buy and sell
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: p.feeBps, endingFeeBps: p.feeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken, // fees accrue in the quote token
      creatorTradingFeePercentage: 0,            // 0% to creator => 100% to feeClaimer
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2, // v2 supports Token-2022 quotes
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      // 100% of migrated LP permanently locked == liquidity burnt
      partnerPermanentLockedLiquidityPercentage: 100,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0, numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: p.pctSupplyOnMigration,
    migrationQuoteThreshold: p.migrationThreshold,
  });
}

// add a priority fee, but only if the SDK didn't already add a compute-budget ix
function addPriority(tx) {
  const has = tx.instructions.some((i) => i.programId.equals(ComputeBudgetProgram.programId));
  if (!has) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }));
  return tx;
}

// read the quote mint's token program + decimals in one call
// ---------------------------------------------------------------------------
// Token badges.
//
// Meteora's DBC only accepts a Token-2022 quote mint that Meteora has badged,
// and the badge has to be handed to create_config as an account. It is not in
// the instruction's declared account list - not in the SDK's bundled IDL, and
// not in the IDL the deployed program publishes on-chain either, both of which
// are behind the live program. So the SDK builds an 8-account create_config and
// the program rejects it with InvalidTokenBadge (6080, 0x17c0).
//
// A real successful create_config against a Token-2022 quote has NINE accounts,
// the badge last, after `program`:
//
//   0 config  1 fee_claimer  2 leftover_receiver  3 quote_mint  4 payer
//   5 system_program  6 event_authority  7 program  8 token_badge
//
// (read off 5kxJcEvYpWVcLZZ8iyprXFkp…, an xStock-quoted config). So the badge is
// appended as a trailing remaining account.
// ---------------------------------------------------------------------------

export const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const CREATE_CONFIG_DISC = Buffer.from('c9cff3724b6f2fbd', 'hex');

/// Where Meteora keeps the badge that marks a mint usable as a DBC quote.
export function meteoraTokenBadge(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('token_badge'), new PublicKey(mint).toBuffer()], DBC_PROGRAM,
  )[0];
}

/// Token-2022 extensions Meteora's DBC accepts on a quote WITHOUT a badge.
///
/// The badge is a gate on dangerous extensions, not on Token-2022 itself. A
/// metadata-only Token-2022 mint - which is every pump.fun coin - is accepted
/// bare: proven by simulating a badge-less create_config against LPEPE and
/// EJUe9f9b (accepted) and against JACKPOT, whose only extra is a transfer hook
/// (refused, InvalidTokenBadge), and by a live launch (6ANt9RWB…, 2026-10-15)
/// whose config and pool carried no badge at all. Extensions outside this set
/// are not assumed either way: the launch simulates create_config first and
/// reports Meteora's own answer.
export const DBC_BADGE_FREE_EXTENSIONS = new Set(['metadataPointer', 'tokenMetadata']);

/// Is this mint allowed as a DBC quote, and does it need its badge attached?
/// Classic SPL mints need no badge; neither do metadata-only Token-2022 mints.
export async function meteoraQuoteAllowed(rpcUrl, mint) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const { program, decimals, extensions } = await readQuoteMint(connection, new PublicKey(mint));
  const isToken2022 = program.equals(TOKEN_2022_PROGRAM_ID);
  if (!isToken2022) return { allowed: true, isToken2022, decimals, extensions, badge: null, badgeExists: false, needsBadge: false, reason: null, note: null };
  const badge = meteoraTokenBadge(mint);
  const badgeExists = !!(await connection.getAccountInfo(badge));
  const gated = extensions.filter((e) => !DBC_BADGE_FREE_EXTENSIONS.has(e));
  const needsBadge = gated.length > 0;
  let note;
  if (badgeExists) note = 'quote is Token-2022 and badged by Meteora — ok';
  else if (!needsBadge) note = 'quote is Token-2022 with only metadata extensions — Meteora needs no badge for it';
  else note = `quote is Token-2022 with ${gated.join(', ')} and no Meteora badge — `
    + 'Meteora may refuse it; the config is simulated before anything is sent';
  return {
    allowed: true, isToken2022, decimals, extensions, badge: badge.toBase58(), badgeExists, needsBadge,
    likelyRefused: needsBadge && !badgeExists, reason: null, note,
  };
}

/// Explain an InvalidTokenBadge refusal in terms of the quote's extensions.
function badgeRefusal(quote, extensions) {
  const gated = (extensions || []).filter((e) => !DBC_BADGE_FREE_EXTENSIONS.has(e));
  return `Meteora refused ${quote.toBase58()} as a quote (InvalidTokenBadge): it is Token-2022 with `
    + `${gated.join(', ') || 'extensions'} that Meteora only accepts from a badged mint, and it has no badge. `
    + 'Creating a badge is admin-gated, so either ask Meteora to badge it or pick a quote they accept - '
    + 'any pump.fun coin works, since those carry only metadata extensions.';
}

/// Append the badge to a create_config the SDK just built - when one exists.
/// Returns the badge, or null when there is none to attach (classic SPL, or a
/// Token-2022 mint Meteora takes bare).
async function attachTokenBadge(connection, tx, quote, quoteProgram, say) {
  if (!quoteProgram.equals(TOKEN_2022_PROGRAM_ID)) return null;
  const badge = meteoraTokenBadge(quote);
  const info = await connection.getAccountInfo(badge);
  if (!info) {
    // no badge to pass: a metadata-only mint does not need one, and for any
    // other mint the pre-send simulation returns Meteora's verdict
    if (say) say('quote is Token-2022 without a Meteora badge - sending create_config without one');
    return null;
  }
  const target = tx.instructions.find(
    (ix) => ix.programId.equals(DBC_PROGRAM) && Buffer.from(ix.data).subarray(0, 8).equals(CREATE_CONFIG_DISC),
  );
  if (!target) throw new Error('could not find create_config in the transaction to attach the token badge to');
  // already there if a future SDK starts doing this itself
  if (!target.keys.some((k) => k.pubkey.equals(badge))) {
    target.keys.push({ pubkey: badge, isSigner: false, isWritable: false });
  }
  if (say) say(`attached Meteora's token badge for the quote (${badge.toBase58().slice(0, 8)}…)`);
  return badge;
}

async function readQuoteMint(connection, quote) {
  const info = await connection.getParsedAccountInfo(quote, 'confirmed');
  const v = info.value;
  if (!v) throw new Error('quote mint not found on-chain');
  const decimals = v.data?.parsed?.info?.decimals;
  if (decimals == null) throw new Error('quote mint is not a valid SPL/Token-2022 mint');
  const extensions = (v.data?.parsed?.info?.extensions || []).map((e) => e.extension);
  return { program: v.owner, decimals, extensions };
}

// build the create-pool tx directly. The SDK's createPool hardcodes the classic
// Token program for the quote vault, which breaks Token-2022 quote mints — so we
// call the instruction ourselves and pass the quote's real token program. Base
// is always a fresh SPL mint (initializeVirtualPoolWithSplToken).
async function buildCreatePoolTx(client, { payer, config, baseMint, quote, quoteProgram, name, symbol, uri, badge = null, baseToken2022 = false }) {
  const creator = client.creator;
  const pool = deriveDbcPoolAddress(quote, baseMint, config);
  const baseVault = deriveDbcTokenVaultAddress(pool, baseMint);
  const quoteVault = deriveDbcTokenVaultAddress(pool, quote);
  const mintMetadata = deriveMintMetadata(baseMint);

  // The badge is needed here too, not just on create_config. Creating the pool
  // opens a quote vault, and the program checks the badge before it will do that
  // for a Token-2022 mint - which is why a launch could clear create_config and
  // still die on the second transaction with the same InvalidTokenBadge (6080 /
  // 0x17c0). A real pool init against a Token-2022 quote carries SEVENTEEN
  // accounts: the sixteen the IDL declares, then the badge. Read off
  // 3Di3sA4EVXPEuVEgmNVKF1..., an xStock-quoted pool.
  // Only when the badge exists: a metadata-only Token-2022 quote (a pump.fun
  // coin) opens its vault with the sixteen declared accounts and nothing more,
  // as the live pool init in 6ANt9RWB…'s launch did.
  const extra = [];
  if (quoteProgram.equals(TOKEN_2022_PROGRAM_ID) && badge) {
    extra.push({ pubkey: badge, isSigner: false, isWritable: false });
  }

  // A config whose token_type is Token-2022 mints the base as Token-2022, through
  // its own instruction: no Metaplex account, metadata lives on the mint. Only
  // reached when mimicking such a config - our own configs are SPL.
  if (baseToken2022) {
    const tx = await creator.program.methods
      .initializeVirtualPoolWithToken2022({ name, symbol, uri })
      .accountsPartial({
        pool, config, payer, creator: payer, baseMint,
        poolAuthority: creator.poolAuthority, baseVault, quoteVault, quoteMint: quote,
        tokenQuoteProgram: quoteProgram,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(extra)
      .transaction();
    return { tx, pool };
  }

  const tx = await creator.program.methods
    .initializeVirtualPoolWithSplToken({ name, symbol, uri })
    .accountsPartial({
      pool, config, payer, creator: payer, mintMetadata, baseMint,
      poolAuthority: creator.poolAuthority, baseVault, quoteVault, quoteMint: quote,
      tokenQuoteProgram: quoteProgram,          // classic for SPL, Token-2022 for T22 quotes
      metadataProgram: METAPLEX_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,           // base is a classic SPL mint
    })
    .remainingAccounts(extra)
    .transaction();
  return { tx, pool };
}

// ---------------------------------------------------------------------------
// The dev buy - Meteora's own name for it is the "first buy".
//
// It rides in the SAME transaction as pool creation, which is the only place
// worth putting it: the pool does not exist until that transaction runs, so
// there is no block in which anyone else can buy ahead of it, and the price paid
// is exactly the curve's start price rather than whatever a sniper leaves
// behind. Meteora's createPoolWithFirstBuy works the same way - config in one
// transaction, pool + buy in the next - so the existing two-step flow did not
// have to change to make room for it.
//
// The swap is built here by hand for the same reason buildCreatePoolTx is: the
// SDK's first-buy helper assumes the classic Token program for the quote side,
// which is exactly the assumption that breaks a Token-2022 quote.
//
// minimumAmountOut is deliberately 0. Slippage protection guards against the
// price moving between quoting and landing, and nothing can move it here - the
// pool is created and bought from in one atomic sequence at a price fixed by the
// curve. A non-zero floor would add no safety and one more way to revert.
// ---------------------------------------------------------------------------

/// Human "0.5" -> raw BN, or zero for blank/absent.
function devBuyRaw(devBuyQuote, quoteDecimals) {
  const v = String(devBuyQuote ?? '').trim();
  if (!v || Number(v) === 0) return new BN(0);
  if (!(Number(v) > 0)) throw new Error('dev buy must be a positive amount of the quote token');
  return uiToRaw(v, quoteDecimals);
}

/// What a dev buy would actually get, priced off the curve we are about to
/// create. There is no pool to ask yet - that is the point of doing it in the
/// creation transaction - so this walks the same curve the program will walk.
export function previewMeteoraDevBuy({ quoteDecimals, params, devBuyQuote }) {
  const amountIn = devBuyRaw(devBuyQuote, quoteDecimals);
  if (amountIn.isZero()) return null;

  const curveConfig = buildLaunchConfig(quoteDecimals, params);
  // collectFeeMode is QuoteToken, so the trading fee comes off the input before
  // any of it reaches the curve - the dev pays the launch's own fee like anyone
  const fee = amountIn.muln(Number(params.feeBps)).addn(9999).divn(10000);
  const afterFee = amountIn.sub(fee);

  const { outputAmount } = calculateQuoteToBaseFromAmountIn(
    { curve: curveConfig.curve }, curveConfig.sqrtStartPrice, afterFee, MAX_SQRT_PRICE,
  );

  // The curve does not run out of liquidity - its last point sits at the
  // maximum sqrt price - so a too-large buy does not show up as unspent input.
  // What it does instead is fill the migration threshold, which completes the
  // curve. A dev buy that graduates the coin inside its own creation
  // transaction is not what anybody means by a dev buy.
  const completesCurve = afterFee.gte(curveConfig.migrationQuoteThreshold);

  const baseDecimals = params.baseDecimals ?? 6;
  const supplyRaw = new BN(String(params.totalSupply)).mul(new BN(10).pow(new BN(baseDecimals)));
  const out = Number(outputAmount.toString());
  return {
    amountIn: amountIn.toString(),
    feeRaw: fee.toString(),
    tokensOutRaw: outputAmount.toString(),
    tokens: out / 10 ** baseDecimals,
    pctOfSupply: (out / Number(supplyRaw.toString())) * 100,
    completesCurve,
    // how much of the way to graduation this single buy takes the coin
    pctOfThreshold: (Number(afterFee.toString()) / Number(curveConfig.migrationQuoteThreshold.toString())) * 100,
  };
}

/// The instructions that buy from the pool being created in the same tx.
async function buildFirstBuyIxs(client, { payer, config, baseMint, quote, quoteProgram, pool, amountIn }) {
  const baseVault = deriveDbcTokenVaultAddress(pool, baseMint);
  const quoteVault = deriveDbcTokenVaultAddress(pool, quote);
  const inputTokenAccount = getAssociatedTokenAddressSync(quote, payer, true, quoteProgram);
  const outputTokenAccount = getAssociatedTokenAddressSync(baseMint, payer, true, TOKEN_PROGRAM_ID);

  // idempotent: the quote account usually exists already, the base one never
  // can - its mint does not exist until the pool instruction ahead of it runs
  const pre = [
    createAssociatedTokenAccountIdempotentInstruction(payer, inputTokenAccount, payer, quote, quoteProgram),
    createAssociatedTokenAccountIdempotentInstruction(payer, outputTokenAccount, payer, baseMint, TOKEN_PROGRAM_ID),
  ];
  const post = [];
  // a SOL-quoted curve trades wrapped SOL, so wrap on the way in and close the
  // account on the way out - otherwise the dev buy silently strands lamports
  if (quote.equals(NATIVE_MINT)) {
    pre.push(...wrapSOLInstruction(payer, inputTokenAccount, BigInt(amountIn.toString())));
    const unwrap = unwrapSOLInstruction(payer, payer);
    if (unwrap) post.push(unwrap);
  }

  // Meteora's own createPoolWithFirstBuy hands the instructions sysvar to every
  // first buy, whatever the config says, so this does too. The program reads it
  // only when the config asks for the first-swap-minimum-fee rule; an unread
  // remaining account costs 32 bytes and nothing else, and guessing the other
  // way would fail the launch outright.
  const remaining = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }];

  const tx = await client.pool.program.methods
    .swap({ amountIn, minimumAmountOut: new BN(0) })
    .accountsPartial({
      poolAuthority: client.pool.poolAuthority,
      config, pool, inputTokenAccount, outputTokenAccount,
      baseVault, quoteVault, baseMint, quoteMint: quote,
      payer,
      tokenBaseProgram: TOKEN_PROGRAM_ID,   // base is always a classic SPL mint
      tokenQuoteProgram: quoteProgram,      // and the quote is whatever it is
      referralTokenAccount: null,
    })
    .remainingAccounts(remaining)
    .preInstructions(pre)
    .postInstructions(post)
    .transaction();
  return tx.instructions;
}

/// Refuse a dev buy the wallet cannot fund, before anything is signed. A
/// create_config that lands and a create_pool that bounces leaves an orphaned
/// config and a confusing error.
async function checkDevBuyFunds(connection, payer, quote, quoteProgram, amountIn) {
  if (quote.equals(NATIVE_MINT)) {
    // pool creation alone costs roughly 0.03 SOL in rent (mint, two vaults, the
    // metadata account), and none of it comes back
    const RENT_HEADROOM = 40_000_000;
    const lamports = await connection.getBalance(payer, 'confirmed');
    if (new BN(lamports).lt(amountIn.addn(RENT_HEADROOM))) {
      throw new Error(
        `dev buy of ${Number(amountIn.toString()) / 1e9} SOL needs about `
        + `${(Number(amountIn.toString()) + RENT_HEADROOM) / 1e9} SOL in the wallet once rent for the mint, `
        + `vaults and metadata is counted; it holds ${lamports / 1e9}.`,
      );
    }
    return;
  }
  const held = await tokenBalance(connection, payer, quote, quoteProgram);
  if (held.lt(amountIn)) {
    throw new Error(
      `dev buy needs ${amountIn.toString()} of the quote token in base units and the wallet holds `
      + `${held.toString()}. The curve is priced in the quote, so the buy has to be funded in it.`,
    );
  }
}

// wait for an account to be visible on the RPC node (config propagation guard)
async function waitForAccount(connection, pubkey, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (await connection.getAccountInfo(pubkey, 'confirmed')) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('config account did not propagate in time');
}

// main entry: create the config, then the pool. Reports progress via onStatus.
// Returns { mint, config, pool, configSig, poolSig }.
export async function launchMeteora(opts) {
  const {
    rpcUrl, secretKey, quoteMint, name, symbol, uri, params,
    devBuyQuote = 0, dryRun = false, onStatus,
    // Mimic. configParams: another pool's config, already translated to
    // create_config parameters (src/solmimic.js) - the same curve under a config
    // whose fees are yours. reuseConfig: that pool's config itself - no new
    // config, just a pool on theirs, with their fee split. baseToken2022 follows
    // the config's token_type.
    configParams = null, reuseConfig = null, baseToken2022 = false,
  } = opts;
  const say = (m) => onStatus && onStatus(m);

  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = keypairFromSecret(secretKey);
  // A dry run can simulate as another, funded wallet, so Meteora's own checks run
  // instead of the simulation stopping at AccountNotFound on an empty test key.
  // Only ever used with dryRun: nothing is sent, and nothing signs for it.
  const simulateAs = dryRun && opts.simulateAs ? new PublicKey(opts.simulateAs) : null;
  const actor = simulateAs ?? payer.publicKey;
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const feeClaimer = params?.feeClaimer ? new PublicKey(params.feeClaimer) : actor;
  const quote = new PublicKey(quoteMint);

  const { program: quoteProgram, decimals: quoteDecimals, extensions: quoteExtensions } = await readQuoteMint(connection, quote);
  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  const curveConfig = configParams || (reuseConfig ? null : buildLaunchConfig(quoteDecimals, params));

  // priced and funding-checked before the first signature, so a dev buy that
  // cannot work fails while nothing has been spent
  const devBuyAmount = devBuyRaw(devBuyQuote, quoteDecimals);
  let devBuyPreview = null;
  if (!devBuyAmount.isZero() && !params) {
    throw new Error('a dev buy is not supported yet when mimicking a DBC curve - launch with 0 and buy right after');
  }
  if (!devBuyAmount.isZero()) {
    devBuyPreview = previewMeteoraDevBuy({ quoteDecimals, params, devBuyQuote });
    if (devBuyPreview.completesCurve) {
      throw new Error(
        `a dev buy of ${devBuyQuote} fills the migration threshold of ${params.migrationThreshold} on its own, `
        + 'so the coin would graduate in the same transaction that creates it. Buy less than the threshold.',
      );
    }
    if (!dryRun) await checkDevBuyFunds(connection, payer.publicKey, quote, quoteProgram, devBuyAmount);
    say(`dev buy: ${devBuyQuote} → about ${devBuyPreview.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} `
      + `${symbol} (${devBuyPreview.pctOfSupply.toFixed(2)}% of supply, `
      + `${devBuyPreview.pctOfThreshold.toFixed(1)}% of the way to graduation), in the same tx as the pool`);
  }

  // Reusing the reference config: one transaction, the pool, on their config.
  // The config exists, so even a dry run is the program's real verdict.
  if (reuseConfig) {
    const cfgKey = new PublicKey(reuseConfig);
    const badgeKey = quoteProgram.equals(TOKEN_2022_PROGRAM_ID) ? meteoraTokenBadge(quote) : null;
    const badge = badgeKey && await connection.getAccountInfo(badgeKey) ? badgeKey : null;
    const { tx: poolTx, pool } = await buildCreatePoolTx(client, {
      payer: actor, config: cfgKey, baseMint: baseMint.publicKey, quote, quoteProgram, name, symbol, uri, badge, baseToken2022,
    });
    addPriority(poolTx);
    poolTx.feePayer = actor;
    poolTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    if (dryRun) {
      const sim = await connection.simulateTransaction(new VersionedTransaction(poolTx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
      return {
        dryRun: true, reused: true, config: cfgKey.toBase58(), mint: baseMint.publicKey.toBase58(), pool: pool.toBase58(),
        simulationError: sim.value.err ? JSON.stringify(sim.value.err) : null, logs: sim.value.logs || [],
      };
    }
    const pre = await connection.simulateTransaction(poolTx, [payer, baseMint]);
    if (pre.value.err) {
      throw new Error(`the pool would fail on that config: ${(pre.value.logs || []).find((l) => l.includes('Error')) || JSON.stringify(pre.value.err)}`);
    }
    say('minting token and opening the curve on the reference config…');
    const poolSig = await sendAndConfirmTransaction(connection, poolTx, [payer, baseMint], { commitment: 'confirmed' });
    return {
      mint: baseMint.publicKey.toBase58(), config: cfgKey.toBase58(), pool: pool.toBase58(),
      configSig: null, poolSig, creator: payer.publicKey.toBase58(), devBuy: null, reused: true,
    };
  }

  say('creating bonding-curve config…');
  const createConfigTx = await client.partner.createConfig({
    payer: actor,
    config: config.publicKey,
    feeClaimer,                       // all trading fees claimable here
    leftoverReceiver: actor,
    quoteMint: quote,
    ...curveConfig,
  });
  // Token-2022 quotes need Meteora's badge passed in; the SDK does not add it
  const badge = await attachTokenBadge(connection, createConfigTx, quote, quoteProgram, say);
  addPriority(createConfigTx);

  if (dryRun) {
    // simulate the config creation only - enough to prove the quote is accepted
    // and the account list is the shape the program wants, without spending
    const target = createConfigTx.instructions.find(
      (ix) => ix.programId.equals(DBC_PROGRAM) && Buffer.from(ix.data).subarray(0, 8).equals(CREATE_CONFIG_DISC),
    );
    createConfigTx.feePayer = actor;
    createConfigTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    if (simulateAs) createConfigTx.partialSign(config); else createConfigTx.sign(payer, config);
    // simulating as a wallet that has not signed: web3.js checks a legacy
    // transaction's signatures before sending it to simulate, so compile it to
    // a versioned one and let the node skip signature verification
    // ask for the config account back, so a mimicked config can be diffed
    // field by field against the one it copies
    const sim = simulateAs
      ? await connection.simulateTransaction(new VersionedTransaction(createConfigTx.compileMessage()), {
        sigVerify: false, replaceRecentBlockhash: true,
        accounts: { addresses: [config.publicKey.toBase58()], encoding: 'base64' },
      })
      : await connection.simulateTransaction(createConfigTx, undefined, [config.publicKey]);
    let createdConfig = null;
    const written = sim.value.accounts?.[0]?.data;
    if (written) {
      const raw = Buffer.from(Array.isArray(written) ? written[0] : written, 'base64');
      const coder = (client.program || client.creator.program).coder;
      try { createdConfig = coder.accounts.decode('poolConfig', raw); } catch {
        try { createdConfig = coder.accounts.decode('PoolConfig', raw); } catch { /* left null */ }
      }
    }
    // The pool cannot be simulated before its config exists, but its shape can
    // still be checked - and the shape is exactly what was wrong.
    const { tx: poolTx, pool: dryPool } = await buildCreatePoolTx(client, {
      payer: actor, config: config.publicKey, baseMint: baseMint.publicKey,
      quote, quoteProgram, name, symbol, uri, badge, baseToken2022,
    });
    const poolIx = poolTx.instructions.find((ix) => ix.programId.equals(DBC_PROGRAM));

    // the dev buy has to fit in the same transaction as the pool, so measure it
    let firstBuyAccounts = [];
    if (!devBuyAmount.isZero()) {
      const buyIxs = await buildFirstBuyIxs(client, {
        payer: actor, config: config.publicKey, baseMint: baseMint.publicKey,
        quote, quoteProgram, pool: dryPool, amountIn: devBuyAmount,
      });
      const swapIx = buyIxs.find((ix) => ix.programId.equals(DBC_PROGRAM));
      firstBuyAccounts = swapIx ? swapIx.keys.map((k) => k.pubkey.toBase58()) : [];
      poolTx.add(...buyIxs);
    }
    addPriority(poolTx);
    poolTx.feePayer = actor;
    poolTx.recentBlockhash = createConfigTx.recentBlockhash;
    if (simulateAs) poolTx.partialSign(baseMint); else poolTx.sign(payer, baseMint);

    return {
      dryRun: true,
      devBuy: devBuyPreview,
      firstBuyAccounts,
      poolTxInstructions: poolTx.instructions.length,
      // measured without requiring every signature, since a simulate-as run
      // has no signature from the wallet it simulates as
      poolTxBytes: poolTx.serialize({ requireAllSignatures: false, verifySignatures: false }).length,
      quoteProgram: quoteProgram.toBase58(),
      tokenBadge: badge ? badge.toBase58() : null,
      createConfigAccounts: target.keys.map((k) => k.pubkey.toBase58()),
      createPoolAccounts: poolIx ? poolIx.keys.map((k) => k.pubkey.toBase58()) : [],
      simulationError: sim.value.err ? JSON.stringify(sim.value.err) : null,
      logs: sim.value.logs || [],
      createdConfig,
    };
  }


  // Ask Meteora before paying for it. A Token-2022 quote without a badge is
  // fine when it carries only metadata extensions and refused otherwise; the
  // simulation is the program's own answer, so an unknown extension is never
  // blocked on a guess and a gated one never costs a failed transaction.
  {
    createConfigTx.feePayer = payer.publicKey;
    createConfigTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    const pre = await connection.simulateTransaction(createConfigTx, [payer, config]);
    if (pre.value.err) {
      const code = pre.value.err?.InstructionError?.[1]?.Custom;
      if (code === 6080) throw new Error(badgeRefusal(quote, quoteExtensions));
      const anchor = (pre.value.logs || []).find((l) => l.includes('Error'));
      throw new Error(`create_config would fail: ${anchor || JSON.stringify(pre.value.err)}`);
    }
  }
  const configSig = await sendAndConfirmTransaction(connection, createConfigTx, [payer, config], { commitment: 'confirmed' });
  say(`config created (${configSig.slice(0, 8)}…); minting token + opening curve…`);

  await waitForAccount(connection, config.publicKey);
  const { tx: createPoolTx, pool } = await buildCreatePoolTx(client, {
    payer: payer.publicKey, config: config.publicKey, baseMint: baseMint.publicKey,
    quote, quoteProgram, name, symbol, uri, badge, baseToken2022,
  });

  // appended, not sent separately: in a tx of its own the buy would sit a block
  // behind a pool anyone can already trade
  if (!devBuyAmount.isZero()) {
    createPoolTx.add(...await buildFirstBuyIxs(client, {
      payer: payer.publicKey, config: config.publicKey, baseMint: baseMint.publicKey,
      quote, quoteProgram, pool, amountIn: devBuyAmount,
    }));
    say('minting token, opening the curve and buying, in one transaction…');
  }

  addPriority(createPoolTx);
  const poolSig = await sendAndConfirmTransaction(connection, createPoolTx, [payer, baseMint], { commitment: 'confirmed' });

  return {
    mint: baseMint.publicKey.toBase58(),
    config: config.publicKey.toBase58(),
    pool: pool.toBase58(),
    configSig,
    poolSig,
    creator: payer.publicKey.toBase58(),
    devBuy: devBuyPreview,
  };
}

// derive the wallet address from a stored SOL secret (for display / balance)
export function solAddressFromSecret(secret) {
  return keypairFromSecret(secret).publicKey.toBase58();
}

// ---------------------------------------------------------------------------
// Meteora DBC fee claiming. Our launches route 100% of trading fees to the
// config's feeClaimer, accrued in the QUOTE token (collectFeeMode=QuoteToken,
// creatorTradingFeePercentage=0). This lists what's owed per pool and claims it.
// The stored SOL wallet must BE the pool's feeClaimer, or the program rejects it.
// ---------------------------------------------------------------------------

// List every DBC pool this wallet created, with its unclaimed partner fee.
// Returns [{ pool, baseMint, quoteMint, quoteDecimals, claimableQuote, claimableBase }]
// (claimable* are raw integer strings in the token's base units).
/// Every DBC pool this wallet launched, with what is actually claimable and by
/// whom.
///
/// Three numbers matter and they are not the same thing. `lifetime` is what the
/// pool has ever earned - it keeps counting after a claim, so reporting it as a
/// balance shows money that is not there, which is exactly what this used to do.
/// `partner` is the fee claimer's unclaimed share, `creator` is the creator's.
/// They are claimed by different instructions and, often, by different wallets:
/// the fee claimer is fixed in the config at launch, so a pool you created can
/// pay someone else entirely.
export async function getMeteoraFees({ rpcUrl, owner }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const rows = await client.state.getPoolsFeesByCreator(new PublicKey(owner));
  const me = new PublicKey(owner).toBase58();
  const decCache = new Map();
  const out = [];

  for (const r of rows) {
    let baseMint = null, quoteMint = null, quoteDecimals = null;
    let feeClaimer = null, creator = null, detail = null;
    try {
      // the SDK nests the decoded account under .poolState
      const raw = await client.state.getPool(r.poolAddress);
      const pool = raw?.poolState ?? raw;
      baseMint = pool?.baseMint?.toBase58?.() || null;
      creator = pool?.creator?.toBase58?.() || null;
      if (pool?.config) {
        const cfg = await connection.getAccountInfo(pool.config);
        if (cfg) {
          // PoolConfig: quote_mint at 8, fee_claimer at 40 (from the IDL order)
          quoteMint = new PublicKey(cfg.data.subarray(8, 40)).toBase58();
          feeClaimer = new PublicKey(cfg.data.subarray(40, 72)).toBase58();
          if (!decCache.has(quoteMint)) {
            decCache.set(quoteMint, (await readQuoteMint(connection, new PublicKey(quoteMint))).decimals);
          }
          quoteDecimals = decCache.get(quoteMint);
        }
      }
    } catch (e) {
      detail = e?.message || String(e);
    }

    const isFeeClaimer = !!feeClaimer && feeClaimer === me;
    const isCreator = !!creator && creator === me;
    out.push({
      pool: r.poolAddress.toBase58(),
      baseMint, quoteMint, quoteDecimals, feeClaimer, creator, detailError: detail,
      partnerQuote: r.partnerQuoteFee.toString(),
      partnerBase: r.partnerBaseFee.toString(),
      creatorQuote: r.creatorQuoteFee.toString(),
      creatorBase: r.creatorBaseFee.toString(),
      lifetimeQuote: r.totalTradingQuoteFee.toString(),
      isFeeClaimer, isCreator,
      // what this wallet can actually take, which is the only number worth
      // putting a button next to
      claimableQuote: (
        (isFeeClaimer ? BigInt(r.partnerQuoteFee.toString()) : 0n)
        + (isCreator ? BigInt(r.creatorQuoteFee.toString()) : 0n)
      ).toString(),
      claimableBase: (
        (isFeeClaimer ? BigInt(r.partnerBaseFee.toString()) : 0n)
        + (isCreator ? BigInt(r.creatorBaseFee.toString()) : 0n)
      ).toString(),
    });
  }
  return out;
}

// Claim the unclaimed partner trading fees for one DBC pool to the fee wallet
// (= the caller, which must be the pool's feeClaimer). Returns { sig, claimedQuote, claimedBase }.
export async function claimMeteoraFees({ rpcUrl, secretKey, pool, onStatus }) {
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = keypairFromSecret(secretKey);
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const poolPk = new PublicKey(pool);
  const me = payer.publicKey.toBase58();

  say('reading the pool…');
  const raw = await client.state.getPool(poolPk);
  const ps = raw?.poolState ?? raw;
  if (!ps?.config) throw new Error('could not read that pool');
  const cfg = await connection.getAccountInfo(ps.config);
  const feeClaimer = new PublicKey(cfg.data.subarray(40, 72)).toBase58();
  const creator = ps.creator?.toBase58?.() || null;

  const metrics = await client.state.getPoolFeeMetrics(poolPk);
  const cur = metrics.current;

  // Two buckets, two instructions, and the program checks the signer against
  // the right one - calling the partner path as a non-fee-claimer is what
  // "Unauthorized" (6053 / 0x17a5) means. Pick by who this key actually is
  // rather than always reaching for the partner path.
  const canPartner = feeClaimer === me && !(cur.partnerBaseFee.isZero() && cur.partnerQuoteFee.isZero());
  const canCreator = creator === me && !(cur.creatorBaseFee.isZero() && cur.creatorQuoteFee.isZero());

  if (!canPartner && !canCreator) {
    if (feeClaimer !== me && creator !== me) {
      throw new Error(`this wallet is neither the fee claimer (${feeClaimer.slice(0, 8)}…) `
        + `nor the creator of that pool, so it cannot claim from it`);
    }
    throw new Error('nothing to claim on this pool yet (its lifetime total is not a balance)');
  }

  const sigs = [];
  let claimedQuote = 0n, claimedBase = 0n;

  if (canPartner) {
    say('claiming the fee claimer’s share…');
    const tx = await client.partner.claimPartnerTradingFee({
      feeClaimer: payer.publicKey, payer: payer.publicKey, pool: poolPk,
      maxBaseAmount: cur.partnerBaseFee, maxQuoteAmount: cur.partnerQuoteFee,
      receiver: payer.publicKey,
    });
    addPriority(tx);
    sigs.push(await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' }));
    claimedQuote += BigInt(cur.partnerQuoteFee.toString());
    claimedBase += BigInt(cur.partnerBaseFee.toString());
  }

  if (canCreator) {
    say('claiming the creator’s share…');
    const tx = await client.creator.claimCreatorTradingFee({
      creator: payer.publicKey, payer: payer.publicKey, pool: poolPk,
      maxBaseAmount: cur.creatorBaseFee, maxQuoteAmount: cur.creatorQuoteFee,
      receiver: payer.publicKey,
    });
    addPriority(tx);
    sigs.push(await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' }));
    claimedQuote += BigInt(cur.creatorQuoteFee.toString());
    claimedBase += BigInt(cur.creatorBaseFee.toString());
  }

  return {
    sig: sigs[0], sigs,
    claimedQuote: claimedQuote.toString(),
    claimedBase: claimedBase.toString(),
    asPartner: canPartner, asCreator: canCreator,
  };
}

// ---------------------------------------------------------------------------
// Router: buy/sell a DBC token with SOL by chaining Jupiter (SOL<->quote) with
// the DBC curve (quote<->token). Sequential - leg 1 confirms, then we read the
// actual amount received and feed it into leg 2.
//
// These four helpers were deleted by accident when getMeteoraFees was rewritten,
// and nothing pointed it out: they are only referenced inside functions, so the
// module still imports and builds, and the trade router only fails at the moment
// someone presses BUY. Restored verbatim.
// ---------------------------------------------------------------------------
async function resolvePool(client, connection, tokenMint) {
  const mint = new PublicKey(tokenMint);
  const pa = await client.state.getPoolByBaseMint(mint);
  if (!pa) throw new Error('no Meteora DBC pool found for this token');
  const virtualPool = pa.account;                    // { poolState }
  const config = await client.state.getPoolConfig(virtualPool.poolState.config);
  const quoteMint = config.quoteMint;
  const quoteProgram = config.quoteTokenFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const [q, b] = await Promise.all([
    connection.getParsedAccountInfo(quoteMint),
    connection.getParsedAccountInfo(mint),
  ]);
  return {
    poolAddr: pa.publicKey, virtualPool, config, quoteMint, quoteProgram,
    quoteDecimals: q.value?.data?.parsed?.info?.decimals ?? 6,
    baseDecimals: b.value?.data?.parsed?.info?.decimals ?? 6,
    isMigrated: !!virtualPool.poolState.isMigrated,
  };
}

async function tokenBalance(connection, owner, mint, program) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, program);
  try { return new BN((await connection.getTokenAccountBalance(ata)).value.amount); }
  catch { return new BN(0); }
}

// human "1.5" -> raw BN at `decimals`, without float rounding
function uiToRaw(ui, decimals) {
  const [whole, frac = ''] = String(ui).trim().split('.');
  const f = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return new BN((whole || '0') + f).add(new BN(0)); // normalize
}

const QUOTE_SYMBOLS = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
};

// resolve token -> pool metadata for the UI (quote symbol, decimals, migrated?)
export async function resolveToken({ rpcUrl, tokenMint }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const info = await resolvePool(client, connection, tokenMint);
  const qm = info.quoteMint.toBase58();
  return {
    quoteMint: qm,
    quoteSymbol: QUOTE_SYMBOLS[qm] || (qm.slice(0, 4) + '…' + qm.slice(-4)),
    quoteDecimals: info.quoteDecimals,
    baseDecimals: info.baseDecimals,
    isMigrated: info.isMigrated,
  };
}

async function jupiterQuote(inputMint, outputMint, amount, slippageBps) {
  const url = `${JUP}/quote?` + new URLSearchParams({
    inputMint, outputMint, amount: String(amount), slippageBps: String(slippageBps),
  });
  const q = await (await fetch(url)).json();
  if (!q || q.error || !q.routePlan) throw new Error(`Jupiter: no route (${q?.error || 'none'})`);
  return q;
}

// ---------------------------------------------------------------------------
// pump.fun's curve economics, ported to a DBC launch against any quote.
//
// pump seeds every launch with 30 virtual SOL against 1.073B virtual tokens,
// sells 793.1M of a 1B supply on the curve, and migrates once ~85 real SOL is
// in. Those numbers are self-consistent: 30 * 1.073B / (1.073B - 793.1M) - 30
// = 85.005 SOL raised, leaving 20.69% of supply for the pool.
//
// DBC derives the curve from (total supply, % supply on migration, migration
// threshold) rather than taking virtual reserves directly, so the same shape
// comes out of pct = 20.69 with a threshold of 85 — checked against the SDK, the
// resulting start price implies a virtual quote of exactly 30.000.
//
// For a non-SOL quote those two figures have to be priced. Jupiter gives the
// live rate, so "30 SOL equivalent" means what it says on the day rather than a
// number that rots in a config.
export const PUMP_CURVE = {
  startSolEquivalent: 30,
  migrateSolEquivalent: 85,
  pctSupplyOnMigration: 20.69,
  totalSupply: 1_000_000_000,
};

// Jupiter's lite API reports no decimals for the output mint - not at the top
// level and not inside routePlan - so an amount taken off a route has to be
// scaled by reading the mint itself. Cached, because decimals never change.
const decimalsCache = new Map();
async function mintDecimals(connection, mint) {
  const k = String(mint);
  if (!decimalsCache.has(k)) {
    decimalsCache.set(k, (await readQuoteMint(connection, new PublicKey(k))).decimals);
  }
  return decimalsCache.get(k);
}

/// How many whole `quoteMint` tokens are worth `solAmount` SOL right now.
export async function solEquivalent(rpcUrl, quoteMint, solAmount) {
  if (quoteMint === SOL_MINT) return solAmount;
  const connection = new Connection(rpcUrl, 'confirmed');
  const lamports = Math.round(solAmount * 1e9);
  const q = await jupiterQuote(SOL_MINT, quoteMint, lamports, 100);
  return Number(q.outAmount) / 10 ** await mintDecimals(connection, quoteMint);
}

/// pump.fun-shaped curve parameters for a given quote, priced live.
export async function pumpEconomics(rpcUrl, quoteMint, opts = {}) {
  // The two figures are pump's by default and yours if you say so. They are not
  // independent of each other: DBC takes (supply, % on migration, raise), and
  // the START falls out of those - so naming a start means solving for the
  // percentage rather than setting it.
  const startSol = Number(opts.startSolEquivalent ?? PUMP_CURVE.startSolEquivalent);
  const migrateSol = Number(opts.migrateSolEquivalent ?? PUMP_CURVE.migrateSolEquivalent);
  if (!(startSol > 0) || !(migrateSol > 0)) throw new Error('both economics figures must be positive');
  if (startSol >= migrateSol) throw new Error('the start has to be below the migration figure');

  const connection = new Connection(rpcUrl, 'confirmed');
  const { decimals } = await readQuoteMint(connection, new PublicKey(quoteMint));
  let migrationThreshold;
  let startEquivalent;
  if (quoteMint === SOL_MINT) {
    migrationThreshold = migrateSol;
    startEquivalent = startSol;
  } else {
    const lamports = Math.round(migrateSol * 1e9);
    const q = await jupiterQuote(SOL_MINT, quoteMint, lamports, 100);
    migrationThreshold = Number(q.outAmount) / 10 ** decimals;
    startEquivalent = migrationThreshold * (startSol / migrateSol);
  }
  // Solve for the % on migration that makes DBC open where START says, by
  // asking the SDK itself - bisecting on the curve it would actually build.
  //
  // This replaced a linear rule (pct = 58.62 x start / migrate) and a 3.17%-
  // 49.84% band that came with it. Both were artifacts: the rule is only exact
  // at pump's 30/85, and the band was measured at 6 decimals, where a curve
  // selling nearly the whole supply rounds short of its threshold. The real
  // relation for a one-segment curve is
  //
  //     opening market cap = raise x p / (1 - p)^2
  //
  // so a huge raise from a pump-like open just means a tiny p - JACKPOT runs
  // 0.19% to raise 21,408 SOL from a ~46 SOL open. Nothing caps the ratio
  // except whether the curve can be represented, and the SDK is the authority
  // on that.
  //
  // START keeps pump's convention: it is the VIRTUAL quote, and pump opens a 1B
  // coin with 1.073B virtual tokens, so 30 means a 27.96 SOL opening cap. That
  // keeps 30/85 landing on exactly the 20.69% it always has.
  const PUMP_VIRTUAL_TOKENS = 1.073;
  const targetOpen = startEquivalent / PUMP_VIRTUAL_TOKENS;
  const supply = Number(opts.totalSupply ?? PUMP_CURVE.totalSupply);
  const baseDecimals = meteoraBaseDecimals(supply);
  const curveAt = (p) => {
    try {
      return buildLaunchConfig(decimals, {
        totalSupply: supply, baseDecimals, feeBps: 100,
        pctSupplyOnMigration: p, migrationThreshold,
      });
    } catch (e) { return { error: e }; }
  };
  const openOf = (cfg) => {
    const sp = Number(BigInt(cfg.sqrtStartPrice.toString())) / 2 ** 64;
    return sp * sp * 10 ** (baseDecimals - decimals) * supply;
  };
  // opening cap rises with p; bisect in log space, since useful p spans
  // from ~1e-5 % to ~50 %
  let lo = Math.log(1e-6);
  let hi = Math.log(95);
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const cfg = curveAt(Math.exp(mid));
    // an unbuildable midpoint is treated as "too high" - the overflow side is
    // where the SDK refuses, and the solve then settles below it
    if (cfg.error || openOf(cfg) > targetOpen) hi = mid; else lo = mid;
  }
  // keep a sane number of significant figures rather than a long float
  const round = (v) => {
    if (!(v > 0)) return v;
    const mag = Math.floor(Math.log10(v));
    const places = Math.max(0, 5 - mag);
    return +v.toFixed(places);
  };
  const pct = round(Math.exp(lo));
  const built = curveAt(pct);
  if (built.error) {
    throw new Error(
      `Meteora will not build a curve that opens at ${round(targetOpen)} and raises ${round(migrationThreshold)} `
      + `on a supply of ${supply.toLocaleString()}: ${built.error.message}`,
    );
  }
  const opened = openOf(built);
  // the bisection lands on the SDK's own answer, so a miss means the target was
  // outside what any p can reach - say so instead of quietly launching elsewhere
  if (Math.abs(opened - targetOpen) / targetOpen > 0.01) {
    throw new Error(
      `the closest curve Meteora will build for a raise of ${round(migrationThreshold)} opens at ${round(opened)}, `
      + `not ${round(targetOpen)} - raise the START or lower MIGRATE`,
    );
  }
  return {
    totalSupply: PUMP_CURVE.totalSupply,
    baseDecimals,
    pctSupplyOnMigration: pct,
    migrationThreshold: round(migrationThreshold),
    migrationMarketCap: round(migrationThreshold * 100 / pct),
    startEquivalent: round(startEquivalent),
    openingMarketCap: round(opened),
    quoteDecimals: decimals,
  };
}

async function jupiterSwap(connection, owner, quoteResponse, onStatus) {
  const res = await (await fetch(`${JUP}/swap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse, userPublicKey: owner.publicKey.toBase58(),
      wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 5_000_000, priorityLevel: 'high' } },
    }),
  })).json();
  if (!res.swapTransaction) throw new Error('Jupiter swap build failed');
  const buf = Uint8Array.from(atob(res.swapTransaction), (c) => c.charCodeAt(0));
  const vtx = VersionedTransaction.deserialize(buf);
  vtx.sign([owner]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 3 });
  await connection.confirmTransaction(
    { signature: sig, blockhash: vtx.message.recentBlockhash, lastValidBlockHeight: res.lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}

// ---------------------------------------------------------------------------
// Funding the quote side.
//
// A curve quoted in anything but SOL has to be FUNDED in that thing. The dev
// buy spends the quote token, and so does anyone buying on the curve, so a
// wallet holding nothing but SOL cannot buy its own launch. Jupiter is already
// wired up for the trade router, so the same route fills the quote side first.
//
// The amount received is read as a balance delta rather than taken from the
// route's estimate: a route that partially fills, or fills at a worse price
// than quoted, still returns a happy-looking quote object.
// ---------------------------------------------------------------------------

/// What this wallet holds of the quote token, in its own units.
export async function quoteHoldings({ rpcUrl, owner, quoteMint }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const who = new PublicKey(owner);
  if (quoteMint === SOL_MINT) {
    const lamports = await connection.getBalance(who, 'confirmed');
    return { isNative: true, decimals: 9, raw: String(lamports), ui: lamports / 1e9 };
  }
  const mint = new PublicKey(quoteMint);
  const { program, decimals } = await readQuoteMint(connection, mint);
  const raw = await tokenBalance(connection, who, mint, program);
  return { isNative: false, decimals, raw: raw.toString(), ui: Number(raw.toString()) / 10 ** decimals };
}

/// What `uiSol` SOL would buy of the quote right now. No signing, no key.
export async function previewSwapIntoQuote({ rpcUrl, quoteMint, uiSol, slippageBps = 100 }) {
  if (quoteMint === SOL_MINT) throw new Error('the quote already is SOL - there is nothing to swap into');
  const lamports = uiToRaw(uiSol, 9);
  if (lamports.lten(0)) return null;
  const connection = new Connection(rpcUrl, 'confirmed');
  const [q, decimals] = await Promise.all([
    jupiterQuote(SOL_MINT, quoteMint, lamports.toString(), slippageBps),
    mintDecimals(connection, quoteMint),
  ]);
  return {
    outRaw: q.outAmount, decimals,
    out: Number(q.outAmount) / 10 ** decimals,
    route: q.routePlan.map((r) => r.swapInfo.label),
  };
}

/// Swap SOL into the quote token so the launch and its dev buy can be funded.
export async function swapIntoQuote({ rpcUrl, secretKey, quoteMint, uiSol, slippageBps = 100, onStatus }) {
  const say = (m) => onStatus && onStatus(m);
  if (quoteMint === SOL_MINT) throw new Error('the quote already is SOL - there is nothing to swap into');

  const connection = new Connection(rpcUrl, 'confirmed');
  const owner = keypairFromSecret(secretKey);
  const mint = new PublicKey(quoteMint);
  const { program, decimals } = await readQuoteMint(connection, mint);

  const lamports = uiToRaw(uiSol, 9);
  if (lamports.lten(0)) throw new Error('enter an amount of SOL to swap');

  // the launch itself is still paid for in SOL - rent for the mint, the two
  // vaults and the metadata account - so swapping the wallet dry would fund the
  // curve and then leave nothing to create it with
  const LAUNCH_HEADROOM = 40_000_000;
  const balance = await connection.getBalance(owner.publicKey, 'confirmed');
  if (new BN(balance).lt(lamports.add(new BN(LAUNCH_HEADROOM)))) {
    throw new Error(
      `swapping ${uiSol} SOL would leave too little behind: creating the pool costs about `
      + `${LAUNCH_HEADROOM / 1e9} SOL in rent and fees, and the wallet holds ${balance / 1e9}.`,
    );
  }

  say('asking Jupiter for a route…');
  const jq = await jupiterQuote(SOL_MINT, quoteMint, lamports.toString(), slippageBps);
  const route = jq.routePlan.map((r) => r.swapInfo.label);

  const pre = await tokenBalance(connection, owner.publicKey, mint, program);
  say(`swapping ${uiSol} SOL via ${route.join(' → ')}…`);
  const sig = await jupiterSwap(connection, owner, jq);

  const post = await tokenBalance(connection, owner.publicKey, mint, program);
  const received = post.sub(pre);
  if (received.lten(0)) throw new Error('the swap confirmed but no quote token arrived - check the transaction');
  return {
    sig, route, decimals,
    receivedRaw: received.toString(),
    received: Number(received.toString()) / 10 ** decimals,
  };
}

async function dbcSwap(client, connection, owner, info, amountIn, swapBaseForQuote, slippageBps) {
  const cp = await getCurrentPoint(connection, info.config.activationType);
  const q = swapQuote(info.virtualPool, info.config, swapBaseForQuote, amountIn, slippageBps, false, cp, false);
  const tx = await client.pool.swap({
    owner: owner.publicKey, pool: info.poolAddr, amountIn,
    minimumAmountOut: q.minimumAmountOut, swapBaseForQuote, referralTokenAccount: null,
  });
  addPriority(tx);
  const sig = await sendAndConfirmTransaction(connection, tx, [owner], { commitment: 'confirmed' });
  return { sig, out: q.outputAmount };
}

// preview only (no signing). uiAmount is human ("0.1" SOL for buy, "1000" tokens
// for sell). Returns estimated out amounts + the Jupiter route labels.
export async function routerPreview({ rpcUrl, tokenMint, side, uiAmount, slippageBps }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const info = await resolvePool(client, connection, tokenMint);
  if (info.isMigrated) throw new Error('this token graduated off the bonding curve');
  const cp = await getCurrentPoint(connection, info.config.activationType);
  if (side === 'buy') {
    const lamports = uiToRaw(uiAmount, 9).toString();
    const jq = await jupiterQuote(SOL_MINT, info.quoteMint.toBase58(), lamports, slippageBps);
    const dq = swapQuote(info.virtualPool, info.config, false, new BN(jq.outAmount), slippageBps, false, cp, false);
    return {
      quoteDecimals: info.quoteDecimals, baseDecimals: info.baseDecimals,
      quoteOut: jq.outAmount, tokensOut: dq.outputAmount.toString(),
      route: ['Jupiter', ...jq.routePlan.map((r) => r.swapInfo.label), 'DBC'],
    };
  }
  const raw = uiToRaw(uiAmount, info.baseDecimals);
  const dq = swapQuote(info.virtualPool, info.config, true, raw, slippageBps, false, cp, false);
  const jq = await jupiterQuote(info.quoteMint.toBase58(), SOL_MINT, dq.outputAmount.toString(), slippageBps);
  return {
    quoteDecimals: info.quoteDecimals, baseDecimals: info.baseDecimals,
    quoteOut: dq.outputAmount.toString(), solOut: jq.outAmount,
    route: ['DBC', ...jq.routePlan.map((r) => r.swapInfo.label), 'SOL'],
  };
}

// BUY: SOL -> quote (Jupiter) -> token (DBC). uiSol is human, e.g. "0.1".
export async function routerBuy({ rpcUrl, secretKey, tokenMint, uiSol, slippageBps, onStatus }) {
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const owner = keypairFromSecret(secretKey);
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const info = await resolvePool(client, connection, tokenMint);
  if (info.isMigrated) throw new Error('token graduated — trade on the migrated pool');

  say('leg 1/2: swapping SOL → quote on Jupiter…');
  const pre = await tokenBalance(connection, owner.publicKey, info.quoteMint, info.quoteProgram);
  const jq = await jupiterQuote(SOL_MINT, info.quoteMint.toBase58(), uiToRaw(uiSol, 9).toString(), slippageBps);
  const jupSig = await jupiterSwap(connection, owner, jq);
  const post = await tokenBalance(connection, owner.publicKey, info.quoteMint, info.quoteProgram);
  const quoteIn = post.sub(pre);
  if (quoteIn.lten(0)) throw new Error('no quote token received from the Jupiter leg');

  say('leg 2/2: swapping quote → token on the DBC curve…');
  const { sig, out } = await dbcSwap(client, connection, owner, info, quoteIn, false, slippageBps);
  return { jupSig, dbcSig: sig, tokensOut: out.toString(), baseDecimals: info.baseDecimals };
}

// SELL: token -> quote (DBC) -> SOL (Jupiter). uiTokens is human, e.g. "1000".
export async function routerSell({ rpcUrl, secretKey, tokenMint, uiTokens, slippageBps, onStatus }) {
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const owner = keypairFromSecret(secretKey);
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const info = await resolvePool(client, connection, tokenMint);
  if (info.isMigrated) throw new Error('token graduated — trade on the migrated pool');

  say('leg 1/2: swapping token → quote on the DBC curve…');
  const pre = await tokenBalance(connection, owner.publicKey, info.quoteMint, info.quoteProgram);
  const raw = uiToRaw(uiTokens, info.baseDecimals);
  const { sig: dbcSig } = await dbcSwap(client, connection, owner, info, raw, true, slippageBps);
  const post = await tokenBalance(connection, owner.publicKey, info.quoteMint, info.quoteProgram);
  const quoteOut = post.sub(pre);
  if (quoteOut.lten(0)) throw new Error('no quote token received from the DBC leg');

  say('leg 2/2: swapping quote → SOL on Jupiter…');
  const jq = await jupiterQuote(info.quoteMint.toBase58(), SOL_MINT, quoteOut.toString(), slippageBps);
  const jupSig = await jupiterSwap(connection, owner, jq);
  return { dbcSig, jupSig, solOut: jq.outAmount };
}

// ---------------------------------------------------------------------------
// Raydium LaunchLab — bonding-curve launch, no liquidity to seed. The quote mint
// must have an on-chain LaunchpadConfig (SOL / USD1 / Anon / USDC / USDT / EURC /
// TRUMP / NVDAx / SPYx / CRCLx are live, incl. stock-pegged xStocks quotes); the
// token graduates to a Raydium AMM/CPMM pool. Base decimals fixed at 6. Same
// program + configs power both raydium.io and letsbonk.fun — only platformId
// differs (see RAYDIUM_PLATFORM_ID / BONK_PLATFORM_ID below).
//   raydium.launchpad.createLaunchpad -> create the mint + open the curve.
// ---------------------------------------------------------------------------
export const RAYDIUM_QUOTES = {
  SOL:   { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL',   decimals: 9 },
  USD1:  { mint: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',  symbol: 'USD1',  decimals: 6 },
  Anon:  { mint: '9McvH6w97oewLmPxqQEoHUAv3u5iYMyQ9AeZZhguYf1T', symbol: 'Anon',  decimals: 9 },
  USDC:  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC',  decimals: 6 },
  USDT:  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT',  decimals: 6 },
  EURC:  { mint: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', symbol: 'EURC',  decimals: 6 },
  TRUMP: { mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', symbol: 'TRUMP', decimals: 6 },
  NVDAx: { mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',  symbol: 'NVDAx', decimals: 8 },
  SPYx:  { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',  symbol: 'SPYx',  decimals: 8 },
  CRCLx: { mint: 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1',  symbol: 'CRCLx', decimals: 8 },
};

// Platform ids for the two LaunchLab frontends — same program, same configs,
// different branding/fee-split. Omit to fall back to the SDK's own default
// (Raydium's platformId, i.e. the raydium.io frontend).
// pump.fun lives in its own file; re-exported here so main.js keeps one
// lazy import for everything Solana.
export { launchPump, pumpWarmup, pumpProbe, pumpStatus, pumpTokensForSol, pumpQuoteRegistry, inspectMint, quoteUiToRaw, PUMP_LOOKUP_TABLE, PUMP_QUOTE_REGISTRY } from './pump.js';
export { pumpTrade, pumpCurve, pumpCurveQuote } from './pump.js';
export { pumpQuoteChain, pumpQuoteChainAccounts, MAX_CURVE_DEPTH } from './pump.js';
export { inspectSolCoin, configParamsFromPoolConfig, diffPoolConfigs } from './solmimic.js';
export {
  launchStudio, studioCreateTx, studioRaise, studioVesting, studioClaimables, studioClaim, studioCreatorTokens,
  studioDevBuy, studioBuildBuy,
  STUDIO_QUOTES, STUDIO_MAX_CLAIMABLE_PCT,
} from './jupstudio.js';
import { pumpTrade, pumpCurve } from './pump.js';

export const RAYDIUM_PLATFORM_ID = '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4';
export const BONK_PLATFORM_ID = 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1';

// stonkfun.xyz runs 134 platform ids against the same program and configs, not
// three. Two of them carry essentially all the volume - 6BwHHDg3 with 115,545
// pools and 4E876qZT with 36,626 - and the remaining 132 hold between 0 and 25
// each. They all decode to a PlatformConfig pointing at stonkfun.xyz, and the
// big two are identical field for field (same fee wallets, same 10000 feeRate,
// same cpConfigId) differing only in `epoch`, which is just when each was last
// written. So the platform id is which storefront a launch is attributed to
// rather than a different set of economics - with ONE exception, the community
// flag at offset 832, which is what STONK_CC_PLATFORM_ID below is about.
//
// This constant is the ORDINARY storefront, deliberately. It briefly pointed at
// the community platform, which was an attempt to get the CC badge by swapping
// the id here - and it could not work, because nothing reads this for the
// stonkfun pads: they carry their own platformId inline. Worse, a constant
// called STONK_PLATFORM_ID that quietly produced community coins would make
// every ordinary launch a community one. The badge now has its own name,
// STONK_CC_PLATFORM_ID, and its own pad, which is the honest way to pick it.
export const STONK_PLATFORM_ID = '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt';
export const STONK_PLATFORM_ID_ALT = '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt';
export const STONK_PLATFORM_ID_ALT2 = '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7';

// --- the CC (community coin) shape -----------------------------------------
//
// What actually earns the "community coin" badge is ONE BYTE in the
// PlatformConfig, and nothing about the launch itself.
//
// The first read of this was over-fitted. Comparing the badged coin
// (8svf3G1X..., quoted in the Token-2022 stock AMC1qwR9..., 300 bps transfer
// fee) against a typical one (5Mv6c7ta..., classic SPL quote, no fee) made it
// look like CC meant "Token-2022 quote + a 300 bps fee". It does not. Two more
// badged platforms exist and both quote plain WSOL with a classic-SPL,
// zero-fee mint, so every one of those traits was a coincidence of the one
// coin first examined.
//
// Byte-diffing the two PlatformConfigs is what settles it. They are 944 bytes
// each and differ in exactly TWO places:
//
//   offset 8    `epoch` - just when each was last written, carries no meaning
//   offset 832  1 on the CC platform, 0 on the regular one
//
// Everything else - fee wallets, feeRate, cpConfigId, the curve - is
// byte-identical. Offset 832 is the first byte of what the SDK's layout still
// calls 108 bytes of padding, so this is a field the deployed program grew and
// the bundled layout has not caught up with. The usual shape of things here:
// the IDL is behind the program.
//
// The separation is total. Of 134 PlatformConfigs pointing at stonkfun.xyz,
// exactly three have the byte set, and they hold one pool each:
//
//   BFYnA6ou...  1 pool   named "FALKLANDS"   quote WSOL, classic SPL, no fee
//   CUqSiwPs...  1 pool   named "StonkFun"    quote AMC, Token-2022, 300 bps
//   ChxAAGsQ...  1 pool   named "VISIONARY"   quote WSOL, classic SPL, no fee
//
// against 131 platforms holding 152,697 pools with the byte clear. The names
// of the other two say what the field is for: one platform per community.
//
// Two things follow, and they are the whole reason this matters:
//
//   1. The badge cannot be reached by changing the quote, the curve, the raise
//      or the transfer fee. It is a property of the platform you launch under.
//   2. It is GATED, and an earlier version of this comment had that wrong. The
//      three initialize transactions are signed by the creator and the new mint
//      keypair only, with no platform admin among the signers, which looked like
//      proof that anyone could launch there. It is not. What the flag byte
//      actually switches on is a second trailing account,
//      platform_allow_config, which the program requires to EXIST - and only
//      the platform admin can create it, because a platform id is a PDA of its
//      admin's key: pda(['platform_config', admin]). CUqSiwPs is
//      pda(['platform_config', 8sLEFiHR...]).
//
//      So the admin opens a window, someone launches inside it, and the admin
//      closes it. For the CC coin that window was open for about 70 minutes on
//      2026-10-01: CreatePlatformAllowConfig at 17:51, the launch at 18:47,
//      ClosePlatformAllowConfig at 19:00. No allow config exists for ANY
//      (platform, config) pairing on chain as of now, so no launch under any of
//      the three is currently possible. See platformAllowWindow().
//
// The config is not a separate thing to choose either: it is the per-quote PDA,
// so picking the quote picks it (AMC resolves to 7j4zuEkW..., WSOL to
// 6s1xP3hp...).
export const STONK_CC_PLATFORM_ID = 'CUqSiwPs6C4WyntMgaFazLp7wYQfaLp5URbjUP9V7SNi';

/// The badged platforms, with the two that prove CC is not about the quote.
export const STONK_CC_PLATFORM_IDS = [
  'BFYnA6ouETD2m9tGEjtyU6TV6BmqdVT2YDUMmgp9Yjv3', // "FALKLANDS"
  'CUqSiwPs6C4WyntMgaFazLp7wYQfaLp5URbjUP9V7SNi', // "StonkFun"
  'ChxAAGsQoXTPVzwk5beARJM7hXVcqr3VENUxXgVmC6aH', // "VISIONARY"
];

/// What the reference CC carried. Kept because it is the default the pad
/// offers, NOT because the badge depends on it - FALKLANDS and VISIONARY carry
/// no transfer fee at all and are badged just the same.
export const STONK_CC_TRANSFER_FEE_BPS = 300;

/// The undocumented community flag: first byte of the SDK layout's trailing
/// padding in a 944-byte PlatformConfig.
export const PLATFORM_COMMUNITY_FLAG_OFFSET = 832;
export const PLATFORM_CONFIG_SIZE = 944;

// --- finding a community launch window -------------------------------------
//
// What has to be discovered is the WINDOW, not the platform. An earlier version
// of this comment had that backwards - it claimed StonkFun never reuses a
// community platform and that each coin gets its own. CUqSiwPs carried one pool
// when that was written and carries 59 now, so it is reused heavily; FALKLANDS
// and VISIONARY are separate communities running their own, not the pattern.
//
// The window is what moves. StonkFun opens an allow config, launches, and closes
// it again, per coin and per quote: one was observed open for USELESS and gone
// within minutes of the next read. So a launch here is a race against something
// that appears and vanishes, which is why this is discovery plus WATCH rather
// than a constant.
//
// Both halves are a single getProgramAccounts call:
//
//   flagged platforms  944 bytes, flag byte 1 at offset 832
//   open windows       137 bytes, PlatformAllowConfig discriminator
//
// The discriminator and the layout come from simulating a CreatePlatformAllowConfig
// into existence and asking the simulator to hand the account back, which costs
// nothing and does not need one to exist on chain - as of writing none does.
// It is sha256("account:PlatformAllowConfig")[..8], and the account is
// disc(8) + bump(1) + platform(32) + config(32) + 64 reserved.
//
// Worth noting what is NOT in there: no wallet, no allowlist, no expiry. An
// open window is open to anybody, which is why the live community launches were
// signed by their creator and the new mint alone.
export const PLATFORM_ALLOW_CONFIG_DISC = Buffer.from('f839228adeeeba4b', 'hex');
export const PLATFORM_ALLOW_CONFIG_SIZE = 137;
const ALLOW_PLATFORM_OFFSET = 9;
const ALLOW_CONFIG_OFFSET = 41;

/// Every PlatformConfig whose community flag is set.
export async function listCommunityPlatforms(rpcUrl) {
  const connection = typeof rpcUrl === 'string' ? new Connection(rpcUrl, 'confirmed') : rpcUrl;
  const accounts = await connection.getProgramAccounts(LAUNCHPAD_PROGRAM, {
    filters: [
      { dataSize: PLATFORM_CONFIG_SIZE },
      { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from('a04e8000f853e6a0', 'hex')) } },
      { memcmp: { offset: PLATFORM_COMMUNITY_FLAG_OFFSET, bytes: bs58.encode(Buffer.from([1])) } },
    ],
  });
  const str = (d, a, b) => d.slice(a, b).toString('utf8').replace(/\0+$/, '').trim();
  return accounts.map(({ pubkey, account }) => ({
    platformId: pubkey.toBase58(),
    name: str(account.data, 112, 176),
    web: str(account.data, 176, 432),
    feeRate: Number(account.data.readBigUInt64LE(104)),
    creatorFeeRate: Number(account.data.readBigUInt64LE(720)),
  }));
}

/// Every allow window currently open, on any platform.
export async function listOpenAllowWindows(rpcUrl) {
  const connection = typeof rpcUrl === 'string' ? new Connection(rpcUrl, 'confirmed') : rpcUrl;
  const accounts = await connection.getProgramAccounts(LAUNCHPAD_PROGRAM, {
    filters: [
      { dataSize: PLATFORM_ALLOW_CONFIG_SIZE },
      { memcmp: { offset: 0, bytes: bs58.encode(PLATFORM_ALLOW_CONFIG_DISC) } },
    ],
  });
  return accounts.map(({ pubkey, account }) => ({
    allowConfig: pubkey.toBase58(),
    platformId: new PublicKey(account.data.slice(ALLOW_PLATFORM_OFFSET, ALLOW_PLATFORM_OFFSET + 32)).toBase58(),
    configId: new PublicKey(account.data.slice(ALLOW_CONFIG_OFFSET, ALLOW_CONFIG_OFFSET + 32)).toBase58(),
  }));
}

/// Every community launch that is actually possible right now: a platform with
/// the flag set AND an open window, resolved down to the quote you would pair
/// against.
///
/// A window on an unflagged platform is deliberately dropped. The program only
/// consults the allow config when the flag is set, so such a window grants
/// nothing - reporting it as a launch opportunity would be a lie.
export async function findCommunityLaunchWindows(rpcUrl) {
  const connection = typeof rpcUrl === 'string' ? new Connection(rpcUrl, 'confirmed') : rpcUrl;
  const [platforms, windows] = await Promise.all([
    listCommunityPlatforms(connection),
    listOpenAllowWindows(connection),
  ]);
  const byId = new Map(platforms.map((p) => [p.platformId, p]));
  const open = windows.filter((w) => byId.has(w.platformId));
  if (!open.length) return { platforms, windows: [] };

  // the config names the quote, and the quote is what the launcher has to pick.
  // LaunchpadConfig carries mintB but NO decimals for it, so those come off the
  // mint - byte 44 of a Mint account either way, classic or Token-2022.
  const configs = await connection.getMultipleAccountsInfo(open.map((w) => new PublicKey(w.configId)));
  const quotes = open.map((w, i) => (configs[i] ? LaunchpadConfig.decode(configs[i].data).mintB : null));
  const uniq = [...new Set(quotes.filter(Boolean).map((m) => m.toBase58()))];
  const mints = await connection.getMultipleAccountsInfo(uniq.map((m) => new PublicKey(m)));
  const decimals = new Map(uniq.map((m, i) => [m, mints[i] ? mints[i].data.readUInt8(44) : null]));

  const resolved = open.map((w, i) => ({
    ...w,
    platform: byId.get(w.platformId),
    quoteMint: quotes[i] ? quotes[i].toBase58() : null,
    quoteDecimals: quotes[i] ? decimals.get(quotes[i].toBase58()) : null,
  }));
  return { platforms, windows: resolved };
}

// --- what a platform curve rule demands ------------------------------------
//
// A rule pins the curve, and a launch whose params differ is rejected with 6025
// CurveParamNotMatchPlatformRule. So on a platform that has one, the raise is
// not a choice - it has to be read off the rule and matched exactly.
//
// The rule stores a list of constraints, 18 bytes each: a field index, an
// operator, and a u128 value. The field indices are the BondingCurveParam
// fields in order, which is what makes them identifiable - a run of 1..12 with
// canonical LaunchLab values (supply 1e15, totalSellA 793.1e12) is
// unmistakable.
//
// Rather than assume where that run starts, the groups are FOUND: scan for an
// offset whose field bytes read 1,2,3..12 at stride 18. That is self-validating,
// so a header change cannot silently produce garbage - it produces no groups,
// which the caller can report honestly. The rules on StonkFun's two ordinary
// storefronts (610 and 344 bytes) do NOT match this shape and come back with
// zero groups rather than a plausible lie; they constrain a sparser set of
// fields in some other arrangement. That costs nothing here, because the three
// community platforms have no rule at all.
const CURVE_RULE_STRIDE = 18;
/// Field index -> what it constrains, 1-based as the rule stores it.
///
/// 1..8 are the BondingCurveParam fields in declaration order, which is how the
/// layout was identified in the first place: a run of them carrying canonical
/// LaunchLab values (supply 1e15, totalSellA 793.1e12) is unmistakable. 9..12
/// are the Token-2022 requirement, read off StonkFun's own rule, whose two
/// groups are byte-identical except for field 11 at 100 and 300 - exactly the
/// two transfer-fee tiers their launches use.
const CURVE_RULE_FIELD_NAMES = {
  1: 'migrateType',
  2: 'migrateCpmmFeeOn',
  3: 'supply',
  4: 'totalSellA',
  5: 'totalFundRaisingB',
  6: 'totalLockedAmount',
  7: 'cliffPeriod',
  8: 'unlockPeriod',
  9: 'requiresToken2022',
  10: 'requiresTransferFee',
  11: 'transferFeeBps',
  12: 'maxTransferFee',
};

/// Decode the constraint groups a rule holds.
///
/// A group is a run of 18-byte entries - field index, operator, u128 value -
/// whose field indices ASCEND but need not be complete. That last part was got
/// wrong at first: requiring a full 1..12 run read StonkFun's own rule as zero
/// groups, because it omits field 5 entirely. Which is the most interesting
/// thing in it - an omitted field is an UNCONSTRAINED field, so the raise is
/// free on that platform and only the shape around it is pinned.
///
/// Still self-validating: an ascending run of at least six known field indices
/// is specific enough that a header change produces no groups rather than a
/// confident wrong answer.
function decodeCurveRuleGroups(data) {
  const MIN_FIELDS = 6;
  const groups = [];
  for (let start = 0; start + CURVE_RULE_STRIDE * MIN_FIELDS <= data.length; start++) {
    const run = [];
    let last = 0;
    for (let o = start; o + CURVE_RULE_STRIDE <= data.length; o += CURVE_RULE_STRIDE) {
      const field = data[o];
      // ascending, within range, and never repeating - a repeat means the next
      // group has started
      if (!CURVE_RULE_FIELD_NAMES[field] || field <= last) break;
      run.push({ offset: o, field });
      last = field;
    }
    if (run.length < MIN_FIELDS) continue;
    const group = { offset: start, fields: run.map((r) => r.field) };
    for (const { offset, field } of run) {
      const lo = data.readBigUInt64LE(offset + 2);
      const hi = data.readBigUInt64LE(offset + 10);
      group[CURVE_RULE_FIELD_NAMES[field]] = {
        op: data[offset + 1], value: ((hi << 64n) | lo).toString(),
      };
    }
    groups.push(group);
    start = run[run.length - 1].offset + CURVE_RULE_STRIDE - 1;
  }
  return groups;
}

/// The curve a platform's rule will accept, or null when it has no rule.
export async function readPlatformCurveRule(rpcUrl, platformId, configId) {
  const connection = typeof rpcUrl === 'string' ? new Connection(rpcUrl, 'confirmed') : rpcUrl;
  const address = PublicKey.findProgramAddressSync(
    [Buffer.from('platform_curve_rule'), new PublicKey(platformId).toBuffer(), new PublicKey(configId).toBuffer()],
    LAUNCHPAD_PROGRAM,
  )[0];
  const info = await connection.getAccountInfo(address).catch(() => null);
  if (!info) return null;
  const groups = decodeCurveRuleGroups(info.data);
  return { address: address.toBase58(), size: info.data.length, groups };
}

/// Whether a community platform will accept a launch against `quoteMint` right
/// now.
///
/// A flagged platform needs a platform_allow_config account for the exact
/// (platform, config) pairing, and that account has to exist - unlike the curve
/// rule, an empty one is rejected. Only the platform's admin can create it,
/// because the platform id is itself a PDA of the admin's key
/// (pda(['platform_config', admin])), so this is a window someone else opens
/// and closes rather than anything a launcher can arrange.
export async function platformAllowWindow(rpcUrl, platformId, quoteMint) {
  const connection = typeof rpcUrl === 'string' ? new Connection(rpcUrl, 'confirmed') : rpcUrl;
  const configId = getPdaLaunchpadConfigId(LAUNCHPAD_PROGRAM, new PublicKey(quoteMint), 0, 0).publicKey;
  const allowConfig = PublicKey.findProgramAddressSync(
    [Buffer.from('platform_allow_config'), new PublicKey(platformId).toBuffer(), configId.toBuffer()],
    LAUNCHPAD_PROGRAM,
  )[0];
  const info = await connection.getAccountInfo(allowConfig).catch(() => null);
  return { configId: configId.toBase58(), allowConfig: allowConfig.toBase58(), open: !!info };
}

/// Read a platform config and say whether launches under it get the CC badge.
///
/// This exists so the launcher can answer the question BEFORE you sign rather
/// than after you look at the website - the only way the last launch went out
/// unbadged was that nothing on the page said which platform it was using.
export async function readPlatformConfig(rpcUrl, platformId) {
  const connection = typeof rpcUrl === 'string' ? new Connection(rpcUrl, 'confirmed') : rpcUrl;
  const info = await connection.getAccountInfo(new PublicKey(platformId));
  if (!info) return null;
  const d = info.data;
  if (d.length !== PLATFORM_CONFIG_SIZE) return null;
  const str = (a, b) => d.slice(a, b).toString('utf8').replace(/\0+$/, '').trim();
  return {
    platformId: String(platformId),
    // the flag is a byte the bundled layout does not name; read it positionally
    community: d[PLATFORM_COMMUNITY_FLAG_OFFSET] === 1,
    name: str(112, 176),
    web: str(176, 432),
    feeRate: Number(d.readBigUInt64LE(104)),
    creatorFeeRate: Number(d.readBigUInt64LE(720)),
    claimFeeWallet: new PublicKey(d.slice(16, 48)).toBase58(),
  };
}

/// Every quote mint that LaunchLab will actually accept, read from the chain
/// rather than from any launchpad's allowlist.
///
/// This matters because the websites gate what you may pair against: stonkfun
/// lists 425 quotes while 475 configs exist on-chain, so ~50 perfectly valid
/// pairings are simply not offered in their UI. A config is a PDA of
/// (quote mint, index 0, curveType 0).
///
/// The program DOES have a create_config instruction, but it is not ours to
/// call: its owner account is documented as "must match the predefined admin
/// address or the create config authority", and simulating it proves the
/// constraint is live — as Raydium's admin RayUznt… it succeeds, as StonkFun's
/// own 200-SOL platform wallet it fails with InvalidOwner (6001). Not even the
/// launchpads can add a quote. So on LaunchLab new pairings can only be
/// discovered, not created, which is what this does. Anything listed here is
/// launchable even if no frontend offers it; for a quote with no config at all,
/// use the Meteora DBC pad, where the config is yours to create.
export async function listLaunchpadConfigs(rpcUrl) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const accounts = await connection.getProgramAccounts(LAUNCHPAD_PROGRAM, {
    filters: [{ dataSize: LaunchpadConfig.span }],
  });

  const quotes = [];
  for (const a of accounts) {
    try {
      const cfg = LaunchpadConfig.decode(a.account.data);
      quotes.push({ mint: cfg.mintB.toBase58(), configId: a.pubkey.toBase58() });
    } catch { /* not a config we understand */ }
  }

  // decimals live on the mint, not the config — SPL and Token-2022 both keep
  // them at byte 44 of the mint account
  const out = [];
  for (let i = 0; i < quotes.length; i += 100) {
    const chunk = quotes.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk.map((q) => new PublicKey(q.mint)));
    infos.forEach((info, k) => {
      out.push({ ...chunk[k], decimals: info ? info.data[44] : null });
    });
  }
  out.sort((x, y) => x.mint.localeCompare(y.mint));
  return out;
}

// human amount -> smallest units, precise (no float drift)
function toRawUnits(amountStr, decimals) {
  const s = String(amountStr || '0').trim();
  if (!s || +s <= 0) return new BN(0);
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return new BN((whole || '0') + fracPadded).add(new BN(0)); // normalize
}

// SOL and USD1 are the only quotes with real defaultParams in Raydium's
// fetchLaunchConfigs() API — every other config (Anon included: its API entry
// comes back zeroed) needs supply/totalSellA/totalFundRaisingB passed in
// explicitly or createLaunchpad throws trying to read defaultParams off an
// undefined/zeroed config entry.
const PLATFORM_DEFAULT_QUOTES = new Set([
  'So11111111111111111111111111111111111111112',
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
]);
// Curve override reproducing the observed "bonk pair" launch
// (ErCiVpFvrmwHskgrkS536hfS2v1UEZAqRhxun9JQLi1Z on letsbonk.fun): fixed 1B
// supply, 79.31% sold via the curve, raising the equivalent of 3,274.601594
// quote tokens — which gives the same ~0.33x starting / ~4.83x migration
// market-cap-to-raise ratios regardless of which quote token is chosen.
const CURVE_SUPPLY = new BN('1000000000000000');  // 1B tokens @ 6 decimals
const CURVE_SELL_A = new BN('793100000000000');   // 79.31% of supply
const CURVE_RAISE_B_MICRO = new BN('3274601594'); // human raise amount * 1e6

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/// StonkFun's default raise, after they changed it: 85 SOL against a WSOL pair.
///
/// Read off 9bHxUoXs..., a launch made under their new defaults. Its pool
/// carries totalFundRaisingB = 85e9 against config 6s1xP3hp (WSOL), with a
/// virtual quote reserve of 30.000852951 - pump's 30/85 shape exactly. Their
/// older launches paired against a stablecoin or a tokenised stock instead and
/// raised a few thousand units of it, which is what the constant above was
/// fitted to.
const CURVE_RAISE_SOL = new BN('85000000000');    // 85 SOL @ 9dp

function curveRaiseTargetRaw(quoteDecimals, quoteMint) {
  // Against SOL the default is 85 SOL exactly. A quote-agnostic unit count
  // cannot be right across assets worth $1 and assets worth $200: scaled to 9
  // decimals the constant below comes out at 3,274 SOL, which is not a launch
  // anyone intends. For any other quote the pad's ECONOMICS button converts 85
  // SOL through Jupiter, and this stays the fallback when no raise is typed.
  if (quoteMint === WSOL_MINT) return CURVE_RAISE_SOL;
  return quoteDecimals >= 6
    ? CURVE_RAISE_B_MICRO.mul(new BN(10).pow(new BN(quoteDecimals - 6)))
    : CURVE_RAISE_B_MICRO.div(new BN(10).pow(new BN(6 - quoteDecimals)));
}

/// Human quote amount -> raw, without going through a float.
function uiRaiseToRaw(ui, quoteDecimals) {
  const [whole, frac = ''] = String(ui).trim().split('.');
  const f = (frac + '0'.repeat(quoteDecimals)).slice(0, quoteDecimals);
  return new BN((whole || '0') + f);
}

// --- what the raise target actually buys -----------------------------------
//
// LaunchLab's curve is pump.fun's, exactly. Measured off two live pools
// (8svf3G1X... and 5Mv6c7ta..., different quotes and different decimals):
//
//   virtualB   = 0.352951 x raise      pump: 30/85 = 0.352941
//   startMcap  = 0.328931 x raise
//   finalMcap  = 4.8333  x raise       = 14.69x the open
//
// with virtualA pinned at 1,073,025,605 tokens and 793.1M of 1B sold on the
// curve. So the ONLY dial is the raise: everything else follows from it, and
// "spawns at 30, migrates at 85" is just a raise of 85.
//
// Worth stating plainly because the two numbers are not the same kind of thing:
// the 30 is the VIRTUAL QUOTE RESERVE, which is what people quote, while the
// starting market cap is 0.328931 x 85 = 27.96. A raise of 85 gives both.
export const LAUNCHLAB_CURVE_RATIOS = {
  virtualPerRaise: 0.352951,
  startMcapPerRaise: 0.328931,
  finalMcapPerRaise: 4.8333,
};

/// The pump.fun shape, in whatever the quote is. 85 is the raise; the 30 and
/// the 27.96 both fall out of it.
export const PUMP_RAISE_SOL = 85;

// Poll getSignatureStatuses over plain HTTP instead of trusting a websocket
// onSignature subscription — proven reliable even in bursts, unlike the SDK's
// internal wait (see launchRaydium below for why that one gets bypassed).
async function confirmSignaturesHttp(connection, sigs, { timeoutMs = 45000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(sigs);
  while (pending.size && Date.now() < deadline) {
    const list = [...pending];
    const { value } = await connection.getSignatureStatuses(list, { searchTransactionHistory: true });
    value.forEach((status, i) => {
      const s = list[i];
      if (!status) return; // not seen by this RPC node yet
      if (status.err) throw new Error(`tx ${s} failed on-chain: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') pending.delete(s);
    });
    if (pending.size) await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (pending.size) throw new Error(`no confirmation after ${Math.round(timeoutMs / 1000)}s for: ${[...pending].join(', ')} — it may still land, check Solscan`);
}

// Raydium's own confirm-wait can reject with a bare `undefined` — no Error, no
// message, no logs — so every throw from the SDK is normalised here before it
// reaches a caller. Shared by the launch and trade paths.
function asErrorShared(e, fallback) {
  if (e instanceof Error && e.message) return e;
  const logs = e?.logs || e?.transactionLogs;
  const msg = e?.message || e?.error?.message || (Array.isArray(logs) ? logs.join('\n') : '') || fallback;
  return new Error(msg);
}

export async function launchRaydium(opts) {
  const {
    rpcUrl, secretKey, quoteMint, name, symbol, uri, buyAmountUi, migrateType, platformId,
    token2022, transferFeeBps, maxTransferFee, raiseTargetUi, onStatus,
    // Mimic: a curve copied off another LaunchLab pool, applied exactly -
    // { supply, totalSellA, totalFundRaisingB, totalLockedAmount, cliffPeriod,
    // unlockPeriod } as raw integer strings - plus that pool's decimals and its
    // CPMM creator-fee setting. A platform rule still has the last word.
    curve, decimals = 6, creatorFeeOn,
    // Build and SIMULATE, then stop. The pad uses this to prove a community
    // window will actually accept the launch before anything is signed - an
    // allow window is somebody else's to close, so "it was open a moment ago"
    // is not the same as "it will work". ownerPubkey stands in for secretKey
    // when dry running, so a simulation never needs the key at all.
    dryRun, ownerPubkey,
  } = opts;
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  if (!secretKey && !(dryRun && ownerPubkey)) throw new Error('launchRaydium needs a secret key (or ownerPubkey with dryRun)');
  const owner = secretKey ? keypairFromSecret(secretKey) : new PublicKey(ownerPubkey);

  say('loading Raydium SDK…');
  const raydium = await Raydium.load({
    connection, owner, cluster: 'mainnet',
    disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: 'finalized',
  });

  const programId = LAUNCHPAD_PROGRAM;
  const quote = new PublicKey(quoteMint);
  // config PDA binds the quote mint (index 0, constant-product curveType 0)
  const configId = getPdaLaunchpadConfigId(programId, quote, 0, 0).publicKey;
  const configData = await connection.getAccountInfo(configId);
  if (!configData) {
    throw new Error('no LaunchLab config exists for that quote token — LaunchLab needs a config per quote (SOL / USD1 / Anon / USDC / USDT / EURC / TRUMP / NVDAx / SPYx / CRCLx are live). For an arbitrary quote, use the Meteora pad instead.');
  }
  const configInfo = LaunchpadConfig.decode(configData.data);
  const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB);

  const pair = Keypair.generate(); // base mint keypair
  const buyRaw = toRawUnits(buyAmountUi, mintBInfo.decimals);
  const doBuy = buyRaw.gtn(0);

  // A platform curve rule pins supply and totalSellA, so when one exists the
  // override has to apply even to SOL/USD1 — the SDK defaults it would otherwise
  // use do not satisfy the rule. Derived here so it is known before the build.
  const curveRuleId = platformId
    ? PublicKey.findProgramAddressSync(
      [Buffer.from('platform_curve_rule'), new PublicKey(platformId).toBuffer(), configId.toBuffer()],
      programId,
    )[0]
    : null;
  const curveRuleInfo = curveRuleId ? await connection.getAccountInfo(curveRuleId).catch(() => null) : null;

  // Platforms with the flag byte set also want a platform_allow_config, and the
  // program requires that one to EXIST - an empty account is accepted for the
  // curve rule but not for this. Checked up front because the alternative is
  // paying for a transaction that cannot succeed: the last CC attempt failed on
  // chain with 6018, and with the account order corrected it would have failed
  // with 3012 instead. Neither is worth a signature.
  const platformInfo = platformId ? await connection.getAccountInfo(new PublicKey(platformId)) : null;
  const wantsAllowConfig = platformInfo?.data?.[PLATFORM_COMMUNITY_FLAG_OFFSET] === 1;
  const allowConfigId = wantsAllowConfig
    ? PublicKey.findProgramAddressSync(
      [Buffer.from('platform_allow_config'), new PublicKey(platformId).toBuffer(), configId.toBuffer()],
      programId,
    )[0]
    : null;
  if (allowConfigId && !(await connection.getAccountInfo(allowConfigId).catch(() => null))) {
    // The platform admin opens and closes this window per launch. StonkFun's CC
    // platform had one open for about 70 minutes on 2026-10-01 - created 17:51,
    // used by their one community coin at 18:47, closed at 19:00 - and the
    // launch that failed went out at 19:12, twelve minutes after it shut.
    const admin = new PublicKey(platformInfo.data.slice(16, 48)).toBase58();
    throw new Error(
      `this platform (${String(platformId).slice(0, 8)}…) only accepts launches while its admin has an allow `
      + `window open, and none is open for this quote right now. The window is a platform_allow_config account `
      + `at ${allowConfigId.toBase58().slice(0, 8)}… which does not exist; only the platform admin can create it, `
      + `because the platform id is a PDA of that admin's key. Launch on the ordinary pad instead, or pair against `
      + `a quote whose window is open. (admin fee wallet ${admin.slice(0, 8)}…)`,
    );
  }

  // A raise target stated by the caller wins; otherwise the old constant. An
  // explicit target also forces the override on, because the whole point of
  // asking for one is that the platform default is not what is wanted.
  let curveOverride = {};
  // set only when a platform rule pins it; spread order means this cannot ride
  // along inside curveOverride, which the explicit migrateType below overwrites
  let ruleMigrateType = null;
  if (raiseTargetUi || curveRuleInfo || !PLATFORM_DEFAULT_QUOTES.has(configInfo.mintB.toBase58())) {
    let raiseB = raiseTargetUi
      ? uiRaiseToRaw(raiseTargetUi, mintBInfo.decimals)
      : curveRaiseTargetRaw(mintBInfo.decimals, configInfo.mintB.toBase58());
    if (configInfo.minFundRaisingB && raiseB.lt(configInfo.minFundRaisingB)) raiseB = configInfo.minFundRaisingB;
    curveOverride = { supply: CURVE_SUPPLY, totalSellA: CURVE_SELL_A, totalFundRaisingB: raiseB };
    if (raiseTargetUi) {
      const r = LAUNCHLAB_CURVE_RATIOS;
      say(`raise ${raiseTargetUi} — opens at a ${(raiseTargetUi * r.startMcapPerRaise).toPrecision(4)} market cap `
        + `(virtual reserve ${(raiseTargetUi * r.virtualPerRaise).toPrecision(4)}), migrates around `
        + `${(raiseTargetUi * r.finalMcapPerRaise).toPrecision(4)}`);
    }
  }

  // A copied curve replaces whatever the raise logic above chose. It came off
  // a live pool, so it already satisfied that pool's platform rule.
  if (curve) {
    curveOverride = {
      supply: new BN(String(curve.supply)),
      totalSellA: new BN(String(curve.totalSellA)),
      totalFundRaisingB: new BN(String(curve.totalFundRaisingB)),
    };
  }
  const vesting = curve && String(curve.totalLockedAmount || '0') !== '0'
    ? {
      totalLockedAmount: new BN(String(curve.totalLockedAmount)),
      cliffPeriod: new BN(String(curve.cliffPeriod || '0')),
      unlockPeriod: new BN(String(curve.unlockPeriod || '0')),
    }
    : {};

  // Where the platform's rule states the curve outright, the rule wins - a
  // launch that differs by one lamport is rejected with 6025, so there is
  // nothing to choose. Only equality constraints (op 0) are honoured; anything
  // else is left alone rather than guessed at, and the dry run will say so.
  if (curveRuleInfo) {
    const groups = decodeCurveRuleGroups(curveRuleInfo.data);
    if (!groups.length) {
      say(`this platform has a curve rule (${curveRuleInfo.data.length} bytes) in a shape this tool cannot read — `
        + 'dry run first, because a mismatch is rejected with 6025');
    } else {
      // A rule holds one or more groups and a launch has to satisfy ONE of
      // them, so the group to obey is the one this launch's mint shape can
      // actually meet. The three live StonkFun rules are each a different
      // shape, which is why this cannot be a tier comparison:
      //
      //   6BwHHDg3  two groups, Token-2022 + a fee of 100 or 300 bps
      //   4E876qZT  one group,  Token-2022 and NO transfer fee at all
      //   community no rule,    so anything goes
      //
      // and 4E876qZT is why: a launch carrying a fee is rejected there, which a
      // tier check would never have noticed.
      const feeBps = token2022 ? Number(transferFeeBps ?? 100) : 0;
      const fits = (x) => {
        if (x.requiresToken2022?.op === 0 && (x.requiresToken2022.value === '1') !== !!token2022) return false;
        if (x.requiresTransferFee?.op === 0 && (x.requiresTransferFee.value === '1') !== (feeBps > 0)) return false;
        if (x.transferFeeBps?.op === 0 && x.transferFeeBps.value !== String(feeBps)) return false;
        return true;
      };
      const describe = (x) => {
        if (x.requiresToken2022?.value === '0') return 'a plain SPL mint';
        if (x.requiresTransferFee?.value === '0') return 'a Token-2022 mint with no transfer fee';
        if (x.transferFeeBps) return `a Token-2022 mint at ${x.transferFeeBps.value} bps`;
        return 'a Token-2022 mint with a transfer fee';
      };
      const g = groups.find(fits);
      if (!g) {
        const mine = token2022
          ? (feeBps > 0 ? `a Token-2022 mint at ${feeBps} bps` : 'a Token-2022 mint with no transfer fee')
          : 'a plain SPL mint';
        const tiers = groups.map((x) => x.transferFeeBps?.value).filter(Boolean);
        throw new Error(
          `this platform's curve rule only accepts ${groups.map(describe).join(', or ')}`
          + `${tiers.length ? ` (${tiers.join(' or ')} bps)` : ''}, and this launch is ${mine}. `
          + 'Anything else is rejected on chain with 6025.',
        );
      }

      // Only equality constraints, and only fields the group actually carries.
      // An ABSENT field is an unconstrained one - field 5 is missing from
      // StonkFun's rule, which is exactly why the raise is still ours to pick.
      const eq = (f) => g[f] && g[f].op === 0;
      const required = {};
      if (eq('supply')) required.supply = new BN(g.supply.value);
      if (eq('totalSellA')) required.totalSellA = new BN(g.totalSellA.value);
      if (eq('totalFundRaisingB')) {
        required.totalFundRaisingB = new BN(g.totalFundRaisingB.value);
        const asked = curveOverride.totalFundRaisingB;
        if (raiseTargetUi && asked && !asked.eq(required.totalFundRaisingB)) {
          say(`this platform's curve rule pins the raise at `
            + `${Number(required.totalFundRaisingB.toString()) / 10 ** mintBInfo.decimals} — ignoring the `
            + `${raiseTargetUi} that was asked for, because anything else is rejected`);
        }
      }
      curveOverride = { ...curveOverride, ...required };
      // the rule can pin the migrate target too, and 1 is cpmm
      if (eq('migrateType')) ruleMigrateType = g.migrateType.value === '0' ? 'amm' : 'cpmm';

    }
  }

  // Raydium's own confirm-wait can reject with a bare `undefined` (no Error, no
  // message) on timeout or on-chain failure — normalize everything here so the
  // caller always gets a real, readable Error instead of silently losing it.
  const asError = asErrorShared;
  const _unusedAsError = (e, fallback) => {
    if (e instanceof Error && e.message) return e;
    const logs = e?.logs || e?.transactionLogs;
    const msg = e?.message || e?.error?.message || (Array.isArray(logs) ? logs.join('\n') : '') || fallback;
    return new Error(msg);
  };

  say('building launch tx…');
  let execute, extInfo, builder;
  try {
    ({ execute, extInfo, builder } = await raydium.launchpad.createLaunchpad({
      programId,
      platformId: platformId ? new PublicKey(platformId) : undefined,
      mintA: pair.publicKey,
      decimals,
      name, symbol, uri,
      ...curveOverride,
      ...vesting,
      ...(creatorFeeOn != null ? { creatorFeeOn } : {}),
      // CPMM, not legacy AMM v4 — v4 needs an OpenBook market per pair (extra cost,
      // and doesn't exist for arbitrary/stock/custom quotes anyway); CPMM works for
      // any pair and matches what live LaunchLab pools actually migrate to (verified
      // on-chain: both the letsbonk.fun/TRUMP and raydium.io/NVDAx example pools
      // migrated with migrateType=1/cpmm, not 0/amm).
      migrateType: ruleMigrateType || migrateType || 'cpmm',
      // Some platforms mint the launched token as Token-2022 with a transfer-fee
      // extension, and their curve rule (below) *requires* it — the fee tier is
      // one of the fields the rule pins. StonkFun's ordinary storefronts are
      // such a platform: decoding a live launch shows initialize_with_token_2022
      // carrying Some(transferFeeBasePoints: 100, maxinumFee: 1e15), and their
      // rule has two groups differing only in that tier (100 or 300 bps).
      // Launching without it is rejected with CurveParamNotMatchPlatformRule.
      //
      // That is NOT true of every StonkFun platform. The three community-coin
      // platforms have no platform_curve_rule account at all, so nothing is
      // pinned there and the mint may be plain SPL - which is what FALKLANDS and
      // VISIONARY actually are. Pass token2022: false for that.
      ...(token2022 ? {
        token2022: true,
        transferFeeExtensionParams: {
          transferFeeBasePoints: transferFeeBps ?? 100,
          maxinumFee: maxTransferFee ? new BN(String(maxTransferFee)) : CURVE_SUPPLY,
        },
      } : {}),
      configId, configInfo,
      mintBDecimals: mintBInfo.decimals,
      txVersion: TxVersion.V0,
      // Spend the quote from WHEREVER it is held, not only from an associated
      // account. The SDK defaults associatedOnly to true, which means a wallet
      // holding the quote in a non-ATA - common for anything received from an
      // exchange or an airdrop - fails with "cannot found mintB(...) buy token
      // accounts" even though the balance is right there. Seen with 4,721 of
      // 6GmAFSYs... sitting in EqvKTd3r... while its ATA did not exist at all.
      associatedOnly: false,
      slippage: new BN(100), // 1%
      buyAmount: doBuy ? buyRaw : new BN(1),
      createOnly: !doBuy, // no dev buy -> create the mint only
      extraSigners: [pair],
      computeBudgetConfig: { units: 600000, microLamports: 100000 },
    }));
  } catch (e) {
    throw asError(e, 'failed to build the launch tx (unknown error)');
  }

  // Some platforms attach a "curve rule" to a quote config — a per-(platform,
  // config) account that constrains the curve params a launch may use. When one
  // exists the program expects it as a REMAINING account on initialize_v2, and
  // without it the launch dies with NotEnoughRemainingAccounts (0x1782 / 6018).
  //
  // The Raydium SDK never passes it: raydium.io and letsbonk.fun have no curve
  // rules, so their own launches work with the 18 declared accounts and nothing
  // more. StonkFun does have them, which is why a StonkFun launch fails on an
  // unpatched SDK. Verified against their live launches — those pass 16 accounts
  // to a 15-account instruction, and the extra one is exactly this PDA.
  //
  // So: derive it, and if it exists append it to the launch instruction and
  // rebuild the transaction.
  // A Token-2022 QUOTE needs its own program in the tokenProgramB slot, and the
  // SDK always writes the classic one there. stonkfun's "community coin"
  // launches pair against Token-2022 assets (the live one at 8svf3G1X... quotes
  // AMC1qwR9..., a Backpack tokenised stock) and their real launch carries
  // Token-2022 in BOTH program slots - decoded off the chain, not guessed.
  //
  // Patched by value rather than by index: the slot is only replaced when it
  // currently holds the classic program AND the quote mint really is owned by
  // Token-2022, so a normal launch is untouched and a layout change cannot
  // silently rewrite the wrong account.
  {
    const quoteOwner = (await connection.getAccountInfo(configInfo.mintB))?.owner;
    if (quoteOwner && quoteOwner.equals(TOKEN_2022_PROGRAM_ID) && builder) {
      let swapped = 0;
      // Only the QUOTE's slot. Every launchpad instruction lists the base token
      // program and then the quote's, so the quote's is the LAST classic one:
      // with an SPL base there are two and the first must stay - rewriting it
      // too is what failed an SPL coin against NVDAx with ConstraintAddress
      // (2012) on base_token_program - and with a Token-2022 base there is
      // only the quote's left to rewrite.
      for (const ix of builder.instructions) {
        if (!ix.programId.equals(programId)) continue;
        let last = -1;
        ix.keys.forEach((k, i) => { if (k.pubkey.equals(TOKEN_PROGRAM_ID)) last = i; });
        if (last >= 0) { ix.keys[last].pubkey = TOKEN_2022_PROGRAM_ID; swapped++; }
      }
      if (swapped) say(`quote is Token-2022 — pointed ${swapped} token-program slot(s) at it`);
    }
  }

  // --- the trailing accounts the program pops, in the order it pops them ----
  //
  // initialize reads its optional accounts positionally off the end of the
  // account list, and it advances the cursor ONLY for the ones the platform
  // actually uses. From the program binary there are two such utils,
  // platform_allow_config.rs and platform_curve_rule.rs, in that order:
  //
  //   let mut i = 0;
  //   if <platform wants an allow config> { allow = remaining[i]; i += 1 }
  //   if <platform wants a curve rule>    { rule  = remaining[i]; i += 1 }
  //
  // which is why the count is not fixed and why passing a spare account is not
  // harmless. On an ordinary platform exactly one is expected and it is the
  // curve rule; on a platform that wants an allow config, the allow config
  // comes FIRST and the curve rule moves to the second slot.
  //
  // Getting that wrong is how a CC launch failed with 6018
  // NotEnoughRemainingAccounts: we passed the curve rule alone, the program
  // took it as the allow config, then looked for a second account that was not
  // there. Pushing both unconditionally fails the other way round - an ordinary
  // platform would read the allow config as its curve rule and reject it with
  // 6024 InvalidPlatformCurveRule - so this has to follow the platform, and the
  // platform says so in the flag byte at PLATFORM_COMMUNITY_FLAG_OFFSET.
  {
    // The curve rule is passed whether or not it exists: the program reads the
    // slot to decide whether the platform restricts curve params, so an absent
    // rule still has to be handed over as an empty account — StonkFun/DOUBLEZERO
    // has no rule and 34 live pools on it, yet omitting the slot still fails
    // with 6018. The allow config is different; it has to exist, which is why
    // it is checked above rather than here.
    const extra = [allowConfigId, curveRuleId].filter(Boolean);
    if (extra.length && builder) {
      say(allowConfigId
        ? 'platform wants an allow config — attaching it ahead of the curve-rule slot…'
        : (curveRuleInfo ? 'platform has a curve rule — attaching it…' : 'attaching the curve-rule slot…'));
      let patched = 0;
      for (const ix of builder.instructions) {
        if (!ix.programId.equals(programId)) continue;
        for (const pubkey of extra) ix.keys.push({ pubkey, isSigner: false, isWritable: false });
        patched++;
      }
      if (patched) {
        try {
          builder.addCustomComputeBudget({ units: 600000, microLamports: 100000 });
        } catch { /* budget is a nicety; the launch fits in the default anyway */ }
        try {
          ({ execute } = await builder.buildV0());
        } catch (e) {
          throw asError(e, 'failed to rebuild the launch tx with the platform curve rule');
        }
      }
    }
  }

  // sequentially:false skips the SDK's own confirmation wait (an internal
  // websocket onSignature subscription with a hardcoded 60s timeout that
  // rejects with a bare `undefined` on timeout/failure — no message, no logs).
  // We send here, then confirm ourselves over plain HTTP polling below, which
  // is slower per call but gives real, attributable errors.
  // A dry run stops here, having built exactly what a real launch would send.
  // Simulating rather than sending is what makes the window check meaningful:
  // the allow config has to exist AT THE MOMENT the program runs, and only the
  // chain can confirm that.
  if (dryRun) {
    say('simulating the launch…');
    const txs = builder ? [(await builder.buildV0()).transaction] : [];
    if (!txs.length) throw new Error('nothing was built to simulate');
    const sim = await connection.simulateTransaction(txs[0], {
      sigVerify: false, replaceRecentBlockhash: true,
    });
    const logs = sim.value.logs || [];
    const anchorErr = logs.find((l) => /AnchorError|Error Code:/.test(l)) || null;
    return {
      dryRun: true,
      ok: !sim.value.err,
      err: sim.value.err || null,
      mint: pair.publicKey.toBase58(),
      // what the launch would actually write to the pool, so a dry run can be
      // diffed against a reference launch instead of eyeballed
      curve: {
        supply: (curveOverride.supply ?? null)?.toString() ?? null,
        totalSellA: (curveOverride.totalSellA ?? null)?.toString() ?? null,
        totalFundRaisingB: (curveOverride.totalFundRaisingB ?? null)?.toString() ?? null,
        totalLockedAmount: vesting.totalLockedAmount?.toString() ?? '0',
        decimals,
        migrateType: ruleMigrateType || migrateType || 'cpmm',
        quoteMint: configInfo.mintB.toBase58(),
        quoteDecimals: mintBInfo.decimals,
        configId: configId.toBase58(),
        token2022: !!token2022,
        transferFeeBps: token2022 ? (transferFeeBps ?? 100) : null,
      },
      platformId: platformId ? String(platformId) : null,
      allowConfig: allowConfigId ? allowConfigId.toBase58() : null,
      curveRule: curveRuleId ? curveRuleId.toBase58() : null,
      unitsConsumed: sim.value.unitsConsumed ?? null,
      anchorError: anchorErr,
      logs,
    };
  }

  say('sending launch tx…');
  let sent;
  try {
    sent = await execute({ sequentially: false });
  } catch (e) {
    throw asError(e, `launch tx failed to send (mint would have been ${pair.publicKey.toBase58()})`);
  }
  const sigs = Array.isArray(sent?.txIds) ? sent.txIds : (sent?.txId ? [sent.txId] : []);
  if (!sigs.length) throw new Error('launch tx sent but returned no signature — check your wallet/RPC connection');

  say('confirming launch tx…');
  try {
    await confirmSignaturesHttp(connection, sigs);
  } catch (e) {
    throw asError(e, `sent (${sigs.join(', ')}) but confirmation failed — check Solscan, it may still land`);
  }
  const sig = sigs[0];

  return {
    mint: pair.publicKey.toBase58(),
    sig,
    poolId: extInfo?.address?.poolId?.toBase58?.() || null,
  };
}

// ---------------------------------------------------------------------------
// Single-sided Raydium CLMM launch ("curve" that IS a CLMM from birth).
//
// Flow: (1) create the token mint + Metaplex metadata, mint the full supply to
// the creator, revoke mint+freeze authority. (2) create a Raydium CLMM pool vs
// the chosen quote at a computed low start price. (3) open a SINGLE-SIDED
// concentrated position holding ~all supply in a range ABOVE spot — that range
// is the curve (no quote/SOL seeded). (4) optional dev buy: swap `devBuy` quote
// in as the first trade, tuned so it acquires ~`targetPct`% of supply.
//
// The token mint is ground so it sorts BEFORE the quote mint (token = mintA),
// so "single-sided token above price" is always the upper range. Fees accrue to
// the position-NFT owner = feeRecipient (defaults to the creator).
// ---------------------------------------------------------------------------
const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// borsh CreateMetadataAccountV3 data (name/symbol/uri, no royalties, mutable)
function encodeMetadataV3(name, symbol, uri) {
  const str = (s) => {
    const b = Buffer.from(s, 'utf8'); const len = Buffer.alloc(4); len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  return Buffer.concat([
    Buffer.from([33]),                    // CreateMetadataAccountV3 discriminator
    str(name), str(symbol), str(uri),
    Buffer.from([0, 0]),                  // sellerFeeBasisPoints u16 = 0
    Buffer.from([0]),                     // creators: Option None
    Buffer.from([0]),                     // collection: Option None
    Buffer.from([0]),                     // uses: Option None
    Buffer.from([1]),                     // isMutable = true
    Buffer.from([0]),                     // collectionDetails: Option None
  ]);
}
function metadataPda(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM,
  )[0];
}

// grind a mint keypair that sorts before `other` (so token becomes CLMM mintA)
function grindMintBefore(other) {
  const o = other.toBuffer();
  for (let i = 0; i < 100000; i++) {
    const kp = Keypair.generate();
    if (Buffer.compare(kp.publicKey.toBuffer(), o) < 0) return kp;
  }
  throw new Error('could not grind a mint address');
}

// pick start price P0 (quote per token) + upper price Pb so a `devBuyQuote` buy
// walks price P0->P1 acquiring ~targetFrac of the supply held single-sided in
// [P0, Pb]. Range ratio fixed wide; solved from the CLMM x/y invariants.
function computeCurvePrices({ supplyTokens, devBuyQuote, targetFrac, rangeRatio = 1000 }) {
  const b = Math.sqrt(rangeRatio);                 // sqrt(Pb/P0)
  const rhs = targetFrac * (1 - 1 / b);            // (1 - 1/u) = targetFrac*(1 - 1/b)
  const u = 1 / (1 - rhs);                          // sqrt(P1/P0)
  const P0 = (devBuyQuote * (1 - 1 / b)) / (supplyTokens * (u - 1));
  return { startPrice: P0, upperPrice: P0 * rangeRatio };
}

export async function launchClmmCurve(opts) {
  const {
    rpcUrl, secretKey, quoteMint, name, symbol, uri,
    supplyTokens, decimals = 6, devBuyQuote = 0, targetPct = 15,
    feeRecipient, onStatus,
  } = opts;
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const owner = keypairFromSecret(secretKey);
  const quote = new PublicKey(quoteMint);
  const feeOwner = feeRecipient ? new PublicKey(feeRecipient) : owner.publicKey;

  const { program: quoteProgram, decimals: quoteDecimals } = await readQuoteMint(connection, quote);

  // 1) token mint (ground to sort before the quote so token = CLMM mintA)
  say('creating token mint...');
  const mintKp = grindMintBefore(quote);
  const mint = mintKp.publicKey;
  const ownerAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
  const supplyRaw = new BN(String(supplyTokens)).mul(new BN(10).pow(new BN(decimals)));
  const rent = await getMinimumBalanceForRentExemptMint(connection);
  const mintTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }),
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: mint, space: MINT_SIZE, lamports: rent, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint, decimals, owner.publicKey, null),
    createAssociatedTokenAccountInstruction(owner.publicKey, ownerAta, owner.publicKey, mint),
    createMintToInstruction(mint, ownerAta, owner.publicKey, BigInt(supplyRaw.toString())),
    new TransactionInstruction({
      programId: METADATA_PROGRAM,
      keys: [
        { pubkey: metadataPda(mint), isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: owner.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeMetadataV3(name, symbol, uri),
    }),
    createSetAuthorityInstruction(mint, owner.publicKey, AuthorityType.MintTokens, null),
  );
  const mintSig = await sendAndConfirmTransaction(connection, mintTx, [owner, mintKp], { commitment: 'confirmed' });
  say('mint created (' + mintSig.slice(0, 8) + '...) - building CLMM pool...');

  // 2) create the CLMM pool at the computed start price
  const raydium = await Raydium.load({ connection, owner, cluster: 'mainnet', disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: 'finalized' });
  const clmmConfigs = await raydium.api.getClmmConfigs();
  const cfg = clmmConfigs.find((c) => Number(c.tradeFeeRate) === 10000) || clmmConfigs[clmmConfigs.length - 1];
  const { startPrice, upperPrice } = computeCurvePrices({
    supplyTokens: Number(supplyTokens),
    devBuyQuote: Number(devBuyQuote) || 0.0001,
    targetFrac: Math.min(0.95, Math.max(0.001, (Number(targetPct) || 15) / 100)),
  });
  const mint1 = { address: mint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals };
  const mint2 = { address: quote.toBase58(), programId: quoteProgram.toBase58(), decimals: quoteDecimals };
  const { execute: execPool, extInfo } = await raydium.clmm.createPool({
    programId: CLMM_PROGRAM_ID, mint1, mint2,
    ammConfig: { ...cfg, id: new PublicKey(cfg.id), fundOwner: '', description: '' },
    initialPrice: new Decimal(startPrice), txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 600000, microLamports: 100000 },
  });
  const { txId: poolSig } = await execPool({ sendAndConfirm: true });
  const poolId = extInfo.address.id.toBase58();
  say('pool created (' + poolSig.slice(0, 8) + '...) - opening single-sided position...');

  // 3) single-sided token position across [startPrice, upperPrice] (above spot)
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(poolId);
  const spacing = poolInfo.config.tickSpacing;
  const lower = TickUtil.toTickIndex(TickUtil.priceToTick(new Decimal(startPrice), decimals, quoteDecimals), spacing);
  const upper = TickUtil.toTickIndex(TickUtil.priceToTick(new Decimal(upperPrice), decimals, quoteDecimals), spacing);
  // keep the whole range strictly ABOVE the opening tick so the position is
  // single-sided (token only) — no quote needed to open it
  const tickLower = Math.min(lower, upper) + spacing;
  const tickUpper = Math.max(lower, upper);
  const baseAmount = supplyRaw.muln(999).divn(1000);
  const { execute: execPos } = await raydium.clmm.openPositionFromBase({
    poolInfo, poolKeys,
    tickLower, tickUpper,
    base: 'MintA', baseAmount, otherAmountMax: new BN(0),
    ownerInfo: { useSOLBalance: true }, nft2022: true,
    txVersion: TxVersion.V0, computeBudgetConfig: { units: 600000, microLamports: 100000 },
  });
  const { txId: posSig } = await execPos({ sendAndConfirm: true });
  say('position opened (' + posSig.slice(0, 8) + '...)');

  // 4) optional dev buy — swap devBuyQuote of the quote into the pool
  let buySig = null;
  if (Number(devBuyQuote) > 0) {
    say('dev buy: swapping ' + devBuyQuote + ' for ~' + targetPct + '%...');
    const data = await raydium.clmm.getPoolInfoFromRpc(poolId);
    const amountIn = new BN(String(Math.floor(Number(devBuyQuote) * 10 ** quoteDecimals)));
    const { execute: execSwap } = await raydium.clmm.swap({
      poolInfo: data.poolInfo, poolKeys: data.poolKeys,
      inputMint: quote.toBase58(), amountIn, amountOutMin: new BN(0),
      observationId: data.computePoolInfo.observationId,
      ownerInfo: { useSOLBalance: true }, remainingAccounts: [],
      txVersion: TxVersion.V0, computeBudgetConfig: { units: 600000, microLamports: 100000 },
    });
    const r = await execSwap({ sendAndConfirm: true });
    buySig = r.txId;
  }

  if (!feeOwner.equals(owner.publicKey)) {
    say('note: position NFT stays with the launcher; transfer it to redirect fees');
  }
  return { mint: mint.toBase58(), poolId, mintSig, poolSig, posSig, buySig, startPrice, upperPrice };
}

// Read a token's on-chain Metaplex metadata (name/symbol/uri) by fetching the
// metadata PDA account directly — works on any RPC (no DAS/getAsset credits
// needed). Used by the Vamp button as a key-independent fallback.
export async function solTokenMetadata(mint, rpcUrl) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
  const mintPk = new PublicKey(mint);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mintPk.toBuffer()], METADATA_PROGRAM,
  );
  const acc = await connection.getAccountInfo(pda);
  if (!acc || !acc.data) return null;
  const data = acc.data;
  let o = 1 + 32 + 32; // key(1) + updateAuthority(32) + mint(32)
  const readStr = () => {
    const len = data.readUInt32LE(o); o += 4;
    const s = data.slice(o, o + len).toString('utf8').replace(/\0/g, '').trim(); o += len;
    return s;
  };
  const name = readStr(), symbol = readStr(), uri = readStr();
  return { name, symbol, uri };
}

// ---------------------------------------------------------------------------
// Trading a Raydium LaunchLab token (StonkFun, bonk.fun, raydium.io — one
// program, one set of configs, so one code path).
//
// The pool records its own quote mint, so a stock-paired StonkFun launch trades
// against that stock exactly as a SOL-paired one trades against SOL: the amount
// you hand in is denominated in whatever the pool was opened with.
//
// Every trade is simulated before it is sent, and confirmation is polled over
// HTTP rather than left to the SDK's websocket wait — that wait rejects with a
// bare `undefined` on timeout, which is how a working trade ends up looking
// like an unexplained failure.
// ---------------------------------------------------------------------------

/// Find a LaunchLab pool for `mint`, trying every quote that has a config.
export async function findLaunchpadPool(connection, mintAddress) {
  const mint = new PublicKey(mintAddress);
  const configs = await listLaunchpadConfigs(connection.rpcEndpoint);
  const pdas = configs.map((c) => ({
    quote: c.mint,
    decimals: c.decimals,
    pda: getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mint, new PublicKey(c.mint)).publicKey,
  }));
  for (let i = 0; i < pdas.length; i += 100) {
    const chunk = pdas.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk.map((x) => x.pda));
    for (let k = 0; k < infos.length; k++) {
      if (!infos[k]) continue;
      const pool = LaunchpadPool.decode(infos[k].data);
      return {
        poolId: chunk[k].pda,
        quoteMint: chunk[k].quote,
        quoteDecimals: chunk[k].decimals,
        poolInfo: pool,
        complete: pool.status !== 0,
      };
    }
  }
  return null;
}

/// Buy or sell a LaunchLab token. `amountUi` is the quote spent on a buy, or the
/// tokens sold on a sell.
export async function launchpadTrade(opts) {
  const {
    rpcUrl, secretKey, mint: mintAddress, side, amountUi,
    slippageBps = 500, onStatus,
  } = opts;
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const owner = keypairFromSecret(secretKey);

  say('locating the pool…');
  const found = await findLaunchpadPool(connection, mintAddress);
  if (!found) throw new Error('no LaunchLab pool for that mint against any configured quote');
  if (found.complete) {
    throw new Error(
      'this LaunchLab token has already migrated off its curve — trade it on the AMM it graduated to '
      + '(the swap page routes there via Jupiter).',
    );
  }

  const raydium = await Raydium.load({
    connection, owner, cluster: 'mainnet',
    disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: 'confirmed',
  });

  const mintA = new PublicKey(mintAddress);
  const baseDecimals = found.poolInfo.mintDecimalsA ?? 6;
  const amount = side === 'buy'
    ? toRawUnits(amountUi, found.quoteDecimals)
    : toRawUnits(amountUi, baseDecimals);
  if (amount.lten(0)) throw new Error('amount must be greater than zero');

  const common = {
    programId: LAUNCHPAD_PROGRAM,
    mintA,
    mintB: new PublicKey(found.quoteMint),
    poolInfo: found.poolInfo,
    slippage: new BN(slippageBps),
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 400000, microLamports: 200000 },
  };

  say('building trade…');
  let built;
  try {
    built = side === 'buy'
      ? await raydium.launchpad.buyToken({ ...common, buyAmount: amount })
      : await raydium.launchpad.sellToken({ ...common, sellAmount: amount });
  } catch (e) {
    throw asError(e, `failed to build the ${side}`);
  }

  const tx = built.transaction ?? built.transactions?.[0];
  if (tx) {
    say('simulating…');
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) {
      const logs = sim.value.logs || [];
      const anchor = logs.find((l) => l.includes('Error Code')) || logs.slice(-3).join(' | ');
      throw new Error(`${side} would fail: ${JSON.stringify(sim.value.err)} ${anchor}`);
    }
  }

  say(`sending ${side}…`);
  let sent;
  try {
    sent = await built.execute({ sequentially: false });
  } catch (e) {
    throw asError(e, `${side} failed to send`);
  }
  const sigs = Array.isArray(sent?.txIds) ? sent.txIds : (sent?.txId ? [sent.txId] : []);
  if (sigs.length) {
    say('confirming…');
    await confirmSignaturesHttp(connection, sigs);
  }
  return { sig: sigs[0] ?? null, quoteMint: found.quoteMint, poolId: found.poolId.toBase58() };
}

// ---------------------------------------------------------------------------
// One entry point for trading any Solana token this launcher can create.
//
// Four venues, detected from the chain rather than from what the user says:
//
//   pump      a pump.fun bonding curve, any quote including the stock mints
//   launchlab a Raydium LaunchLab curve — StonkFun, bonk.fun and raydium.io all
//             run the same program, so one path covers them
//   dbc       a Meteora dynamic bonding curve
//   jupiter   anything that has graduated; its liquidity is in an AMM now, and
//             Jupiter indexes those
//
// Detection runs the three curve lookups in parallel and takes whichever
// answers. A graduated curve is still a match — it just routes to Jupiter.
// ---------------------------------------------------------------------------
export async function findSolanaVenue(rpcUrl, mintAddress) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [pump, lab, dbc] = await Promise.all([
    pumpCurve(connection, mintAddress).catch(() => null),
    findLaunchpadPool(connection, mintAddress).catch(() => null),
    (async () => {
      try {
        const client = new DynamicBondingCurveClient(connection, 'confirmed');
        const info = await resolvePool(client, connection, mintAddress);
        return info.isMigrated ? null : info;
      } catch { return null; }
    })(),
  ]);

  if (pump && !pump.complete) {
    return { venue: 'pump', graduated: false, quoteMint: pump.quoteMint.toBase58(), curve: pump };
  }
  if (lab && !lab.complete) {
    return { venue: 'launchlab', graduated: false, quoteMint: lab.quoteMint, pool: lab };
  }
  if (dbc) {
    return { venue: 'dbc', graduated: false, quoteMint: dbc.quoteMint?.toBase58?.() ?? null, pool: dbc };
  }
  if (pump?.complete || lab?.complete) {
    return {
      venue: 'jupiter', graduated: true,
      quoteMint: (pump?.complete ? pump.quoteMint.toBase58() : lab.quoteMint),
      was: pump?.complete ? 'pump.fun' : 'LaunchLab',
    };
  }
  return { venue: 'jupiter', graduated: null, quoteMint: null };
}

/// Trade a Solana token on whichever venue actually holds it.
///
/// `amountUi` is the quote spent on a buy, or the tokens sold on a sell — both
/// in the venue's own quote, which for a stock-paired launch means the stock.
export async function solanaTrade(opts) {
  const { rpcUrl, secretKey, mint, side, amountUi, slippageBps = 500, onStatus } = opts;
  const say = (m) => onStatus && onStatus(m);
  say('finding the venue…');
  const found = await findSolanaVenue(rpcUrl, mint);

  if (found.venue === 'pump') {
    say('pump.fun bonding curve');
    return { ...found, ...await pumpTrade({ rpcUrl, secretKey, mint, side, amountUi, slippageBps, onStatus }) };
  }
  if (found.venue === 'launchlab') {
    say('Raydium LaunchLab curve');
    return { ...found, ...await launchpadTrade({ rpcUrl, secretKey, mint, side, amountUi, slippageBps, onStatus }) };
  }
  if (found.venue === 'dbc') {
    say('Meteora dynamic bonding curve');
    const res = side === 'buy'
      ? await routerBuy({ rpcUrl, secretKey, tokenMint: mint, uiSol: amountUi, slippageBps, onStatus })
      : await routerSell({ rpcUrl, secretKey, tokenMint: mint, uiTokens: amountUi, slippageBps, onStatus });
    return { ...found, ...res };
  }
  throw new Error(
    found.graduated
      ? `this token graduated off its ${found.was} curve — its liquidity is in an AMM now. `
        + 'Route it through Jupiter rather than the curve.'
      : 'no pump.fun, LaunchLab or Meteora curve found for that mint',
  );
}
