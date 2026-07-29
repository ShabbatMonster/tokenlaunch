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
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';
import {
  DynamicBondingCurveClient, buildCurve, swapQuote, getCurrentPoint,
  deriveDbcPoolAddress, deriveDbcTokenVaultAddress, deriveMintMetadata, METAPLEX_PROGRAM_ID,
  TokenType, TokenDecimal, TokenAuthorityOption,
  BaseFeeMode, CollectFeeMode, MigrationOption, MigrationFeeOption, ActivationType,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

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
