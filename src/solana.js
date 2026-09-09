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
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, VersionedTransaction, sendAndConfirmTransaction, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  MINT_SIZE, getMinimumBalanceForRentExemptMint,
  createInitializeMint2Instruction, createAssociatedTokenAccountInstruction,
  createMintToInstruction, createSetAuthorityInstruction, AuthorityType,
} from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';
import Decimal from 'decimal.js';
import {
  DynamicBondingCurveClient, buildCurve, swapQuote, getCurrentPoint,
  deriveDbcPoolAddress, deriveDbcTokenVaultAddress, deriveMintMetadata, METAPLEX_PROGRAM_ID,
  TokenType, TokenDecimal, TokenAuthorityOption,
  BaseFeeMode, CollectFeeMode, MigrationOption, MigrationFeeOption, ActivationType,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  Raydium, TxVersion, LAUNCHPAD_PROGRAM, getPdaLaunchpadConfigId, LaunchpadConfig,
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
async function readQuoteMint(connection, quote) {
  const info = await connection.getParsedAccountInfo(quote, 'confirmed');
  const v = info.value;
  if (!v) throw new Error('quote mint not found on-chain');
  const decimals = v.data?.parsed?.info?.decimals;
  if (decimals == null) throw new Error('quote mint is not a valid SPL/Token-2022 mint');
  return { program: v.owner, decimals };
}

// build the create-pool tx directly. The SDK's createPool hardcodes the classic
// Token program for the quote vault, which breaks Token-2022 quote mints — so we
// call the instruction ourselves and pass the quote's real token program. Base
// is always a fresh SPL mint (initializeVirtualPoolWithSplToken).
async function buildCreatePoolTx(client, { payer, config, baseMint, quote, quoteProgram, name, symbol, uri }) {
  const creator = client.creator;
  const pool = deriveDbcPoolAddress(quote, baseMint, config);
  const baseVault = deriveDbcTokenVaultAddress(pool, baseMint);
  const quoteVault = deriveDbcTokenVaultAddress(pool, quote);
  const mintMetadata = deriveMintMetadata(baseMint);
  const tx = await creator.program.methods
    .initializeVirtualPoolWithSplToken({ name, symbol, uri })
    .accountsPartial({
      pool, config, payer, creator: payer, mintMetadata, baseMint,
      poolAuthority: creator.poolAuthority, baseVault, quoteVault, quoteMint: quote,
      tokenQuoteProgram: quoteProgram,          // classic for SPL, Token-2022 for T22 quotes
      metadataProgram: METAPLEX_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,           // base is a classic SPL mint
    }).transaction();
  return { tx, pool };
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
  const { rpcUrl, secretKey, quoteMint, name, symbol, uri, params, onStatus } = opts;
  const say = (m) => onStatus && onStatus(m);

  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = keypairFromSecret(secretKey);
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const feeClaimer = new PublicKey(params.feeClaimer);
  const quote = new PublicKey(quoteMint);

  const { program: quoteProgram, decimals: quoteDecimals } = await readQuoteMint(connection, quote);
  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  const curveConfig = buildLaunchConfig(quoteDecimals, params);

  say('creating bonding-curve config…');
  const createConfigTx = await client.partner.createConfig({
    payer: payer.publicKey,
    config: config.publicKey,
    feeClaimer,                       // all trading fees claimable here
    leftoverReceiver: payer.publicKey,
    quoteMint: quote,
    ...curveConfig,
  });
  addPriority(createConfigTx);
  const configSig = await sendAndConfirmTransaction(connection, createConfigTx, [payer, config], { commitment: 'confirmed' });
  say(`config created (${configSig.slice(0, 8)}…); minting token + opening curve…`);

  await waitForAccount(connection, config.publicKey);
  const { tx: createPoolTx, pool } = await buildCreatePoolTx(client, {
    payer: payer.publicKey, config: config.publicKey, baseMint: baseMint.publicKey,
    quote, quoteProgram, name, symbol, uri,
  });
  addPriority(createPoolTx);
  const poolSig = await sendAndConfirmTransaction(connection, createPoolTx, [payer, baseMint], { commitment: 'confirmed' });

  return {
    mint: baseMint.publicKey.toBase58(),
    config: config.publicKey.toBase58(),
    pool: pool.toBase58(),
    configSig,
    poolSig,
    creator: payer.publicKey.toBase58(),
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
export async function getMeteoraFees({ rpcUrl, owner }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const rows = await client.state.getPoolsFeesByCreator(new PublicKey(owner));
  const quoteCache = new Map(); // config -> { mint, decimals }
  const out = [];
  for (const r of rows) {
    let baseMint = null, quoteMint = null, quoteDecimals = 9;
    try {
      const pool = await client.state.getPool(r.poolAddress);
      baseMint = pool?.baseMint?.toBase58?.() || null;
      const cfgKey = pool?.config?.toBase58?.();
      if (cfgKey) {
        if (!quoteCache.has(cfgKey)) {
          const cfg = await client.state.getPoolConfig(pool.config);
          const qm = cfg?.quoteMint;
          const dec = qm ? (await readQuoteMint(connection, qm)).decimals : 9;
          quoteCache.set(cfgKey, { mint: qm?.toBase58?.() || null, decimals: dec });
        }
        const q = quoteCache.get(cfgKey);
        quoteMint = q.mint; quoteDecimals = q.decimals;
      }
    } catch { /* pool details are best-effort; the fee numbers still stand */ }
    out.push({
      pool: r.poolAddress.toBase58(),
      baseMint, quoteMint, quoteDecimals,
      claimableQuote: r.partnerQuoteFee.toString(),
      claimableBase: r.partnerBaseFee.toString(),
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

  say('reading claimable fees…');
  const metrics = await client.state.getPoolFeeMetrics(poolPk);
  const maxBase = metrics.current.partnerBaseFee;
  const maxQuote = metrics.current.partnerQuoteFee;
  if (maxBase.isZero() && maxQuote.isZero()) throw new Error('nothing to claim on this pool yet');

  say('building claim tx…');
  const tx = await client.partner.claimPartnerTradingFee({
    feeClaimer: payer.publicKey,
    payer: payer.publicKey,
    pool: poolPk,
    maxBaseAmount: maxBase,
    maxQuoteAmount: maxQuote,
    receiver: payer.publicKey,
  });
  addPriority(tx);
  say('sending claim tx…');
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
  return { sig, claimedBase: maxBase.toString(), claimedQuote: maxQuote.toString() };
}

// ---------------------------------------------------------------------------
// Router: buy/sell a DBC token with SOL by chaining Jupiter (SOL<->quote) with
// the DBC curve (quote<->token). Sequential — leg 1 confirms, then we read the
// actual amount received and feed it into leg 2.
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
export { launchPump, pumpStatus, pumpTokensForSol, PUMP_LOOKUP_TABLE } from './pump.js';

export const RAYDIUM_PLATFORM_ID = '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4';
export const BONK_PLATFORM_ID = 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1';

// stonkfun.xyz runs two platform ids against the same program and configs. Both
// decode to a PlatformConfig named "StonkFun" with the same fee wallet; the
// first is the busier of the two (10,665 pools vs 3,071) and is what a launch
// paired against a community token used, so it is the default here.
export const STONK_PLATFORM_ID = '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt';
export const STONK_PLATFORM_ID_ALT = '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7';

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
function curveRaiseTargetRaw(quoteDecimals) {
  return quoteDecimals >= 6
    ? CURVE_RAISE_B_MICRO.mul(new BN(10).pow(new BN(quoteDecimals - 6)))
    : CURVE_RAISE_B_MICRO.div(new BN(10).pow(new BN(6 - quoteDecimals)));
}

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

export async function launchRaydium(opts) {
  const {
    rpcUrl, secretKey, quoteMint, name, symbol, uri, buyAmountUi, migrateType, platformId,
    token2022, transferFeeBps, maxTransferFee, onStatus,
  } = opts;
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const owner = keypairFromSecret(secretKey);

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

  let curveOverride = {};
  if (curveRuleInfo || !PLATFORM_DEFAULT_QUOTES.has(configInfo.mintB.toBase58())) {
    let raiseB = curveRaiseTargetRaw(mintBInfo.decimals);
    if (configInfo.minFundRaisingB && raiseB.lt(configInfo.minFundRaisingB)) raiseB = configInfo.minFundRaisingB;
    curveOverride = { supply: CURVE_SUPPLY, totalSellA: CURVE_SELL_A, totalFundRaisingB: raiseB };
  }

  // Raydium's own confirm-wait can reject with a bare `undefined` (no Error, no
  // message) on timeout or on-chain failure — normalize everything here so the
  // caller always gets a real, readable Error instead of silently losing it.
  const asError = (e, fallback) => {
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
      decimals: 6,
      name, symbol, uri,
      ...curveOverride,
      // CPMM, not legacy AMM v4 — v4 needs an OpenBook market per pair (extra cost,
      // and doesn't exist for arbitrary/stock/custom quotes anyway); CPMM works for
      // any pair and matches what live LaunchLab pools actually migrate to (verified
      // on-chain: both the letsbonk.fun/TRUMP and raydium.io/NVDAx example pools
      // migrated with migrateType=1/cpmm, not 0/amm).
      migrateType: migrateType || 'cpmm',
      // Some platforms mint the launched token as Token-2022 with a transfer-fee
      // extension, and their curve rule (below) *requires* it — the fee tier is
      // one of the fields the rule pins. StonkFun is one: decoding a live launch
      // of theirs shows initialize_with_token_2022 carrying
      // Some(transferFeeBasePoints: 100, maxinumFee: 1e15), and their rule has two
      // groups differing only in that tier (100 or 300 bps). Launching without it
      // is rejected with CurveParamNotMatchPlatformRule.
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
  {
    const curveRule = curveRuleId;
    // Pass it whether or not it exists. The program reads this slot to decide
    // if the platform restricts curve params, so an absent rule still has to be
    // handed over as an empty account — StonkFun/DOUBLEZERO has no rule and 34
    // live pools on it, yet omitting the slot still fails with 6018. Harmless
    // for platforms that never use rules: raydium.io and letsbonk.fun both
    // simulate fine with the extra account attached.
    if (curveRule && builder) {
      say(curveRuleInfo ? 'platform has a curve rule — attaching it…' : 'attaching the curve-rule slot…');
      let patched = 0;
      for (const ix of builder.instructions) {
        if (!ix.programId.equals(programId)) continue;
        ix.keys.push({ pubkey: curveRule, isSigner: false, isWritable: false });
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
