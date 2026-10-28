// Float (floatlaunch.xyz): coins paired against tokenised stocks, on Raydium
// LaunchLab, through Float's own program 3KguFi7Y… rather than LaunchLab directly.
//
// Read off two live launches (4UZzNas… FLOWSTATE and 7uBAsDz8… FLOAT, both
// SPYx-paired) and Float's program binary, 2026-10-28. There is no published
// IDL; every seed below was matched against a real account.
//
// A launch is one transaction:
//   1. Float `Launch(name, symbol, uri, creator, fee_tier, nonce)`: mints the
//      coin as a PDA of (payer, nonce), registers the ticker, records the
//      launch and CPIs LaunchLab InitializeV2 on the fee tier's platform. The
//      creator is only the wallet the 5% creator share is paid to; the tiers
//      are 1%, 2% and 2.5% all-in, each its own LaunchLab platform.
//   2. optionally a plain LaunchLab buy_exact_in - the dev buy - paid in the
//      quote, in the same transaction so nothing can get in front of it.
//
// Tickers are first-come: Float keeps a record per ticker (PDA "ticker" + the
// ticker), and taking over one that exists either fails ("still protected") or
// costs 1 SOL to Float's treasury. This module never does that: an existing
// ticker record is a refusal, before anything is signed.
import {
  Connection, PublicKey, TransactionInstruction, SystemProgram, ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY, VersionedTransaction, TransactionMessage,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { keypairFromSecret } from './solana.js';

export const FLOAT_PROGRAM = new PublicKey('3KguFi7YYzLgttG46fRism16CfcuNCkDh6U7td9JTqxX');
export const FLOAT_SITE = 'https://www.floatlaunch.xyz';
const LAUNCHLAB = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const LIGHTHOUSE = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
const LAUNCH_DISC = Buffer.from('99f15de116454a3d', 'hex');
const BUY_EXACT_IN_DISC = Buffer.from('faea0d7bd59c13ec', 'hex');
const QUOTE_RECORD_SIZE = 130;
/// Float's own address lookup table: its program and config, LaunchLab's
/// authorities, the token programs and sysvars, its platform, and every pair
/// token with its LaunchLab config. Without it a launch with a dev buy is ~1335
/// bytes, over Solana's 1232; with it Float's own launches are ~1004.
export const FLOAT_LOOKUP_TABLE = new PublicKey('4wueL2taRzko7661R7NMcCuV5YQ2FuQyEJUYYqBc9Mku');
/// The coin's metadata goes through Metaplex (it is a classic SPL mint), so its
/// caps apply - see METAPLEX_METADATA_MAX in solana.js.
export const FLOAT_NAME_MAX_BYTES = 32;
export const FLOAT_URI_MAX_BYTES = 200;
/// Float's own ticker rule, in its words: "Ticker must be 1-10 characters A-Z or 0-9".
export const FLOAT_TICKER_RULE = /^[A-Z0-9]{1,10}$/;

const pda = (seeds, program = FLOAT_PROGRAM) => PublicKey.findProgramAddressSync(seeds, program)[0];
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

export const floatConfig = () => pda([Buffer.from('config')]);
export const floatQuoteRecord = (quoteMint) => pda([Buffer.from('quote'), new PublicKey(quoteMint).toBuffer()]);
export const floatTickerRecord = (ticker) => pda([Buffer.from('ticker'), Buffer.from(ticker, 'utf8')]);
export const floatLaunchRecord = (mint) => pda([Buffer.from('launch'), new PublicKey(mint).toBuffer()]);
/// The per-coin authority. LaunchLab records it as the pool's creator, so the
/// creator fees accrue to it and Float pays them out.
export const floatCoinAuthority = (mint) => pda([Buffer.from('coin'), new PublicKey(mint).toBuffer()]);
/// The coin's own address: a PDA of the PAYER and a nonce, so there is no mint
/// keypair to sign with and a different nonce is a different address. (Not the
/// creator: seeding it by the creator fails ConstraintSeeds on coin_mint.)
export const floatMint = (payer, nonce) => pda([Buffer.from('mint'), new PublicKey(payer).toBuffer(), u64le(nonce)]);

const llPool = (base, quote) => pda([Buffer.from('pool'), base.toBuffer(), quote.toBuffer()], LAUNCHLAB);
const llVault = (pool, mint) => pda([Buffer.from('pool_vault'), pool.toBuffer(), mint.toBuffer()], LAUNCHLAB);
const LL_AUTHORITY = pda([Buffer.from('vault_auth_seed')], LAUNCHLAB);
const LL_EVENT_AUTHORITY = pda([Buffer.from('__event_authority')], LAUNCHLAB);
const llPlatformFeeVault = (platform, quote) => pda([platform.toBuffer(), quote.toBuffer()], LAUNCHLAB);
const llCreatorFeeVault = (creator, quote) => pda([creator.toBuffer(), quote.toBuffer()], LAUNCHLAB);
const metadataPda = (mint) => pda([Buffer.from('metadata'), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX);

/// Float's custom errors, in declaration order from 6000, as the program
/// words them - so a failure reads as a sentence rather than 0x177a.
export const FLOAT_ERRORS = [
  'Config is frozen and can no longer be changed', 'Fee split must add up to 10000 bps',
  'Fee tiers must be 1-3 rates of at most 10%', "Unknown fee tier, or its platform hasn't been created",
  'Curve settings are out of range', 'New launches are paused', 'This stock token is not enabled for launches',
  'Not a LaunchLab constant-product config for this quote token', 'The LaunchLab platform has already been created',
  // 6009 and 6010 pinned live; the rest follow the binary's declaration order
  'Ticker must be 1-10 characters A-Z or 0-9', 'Name or metadata URI is too long',
  'Ticker is still protected and cannot be taken over yet', 'Launch price is out of range',
];

/// Treasury and fee tiers, out of Float's config. Each tier is its own LaunchLab
/// platform: a u8 count at 106, then the platforms from 107. A tier's trading
/// fee is its platform fee plus its creator fee plus LaunchLab's 0.25% - 1%, 2%
/// and 2.5% today, which is what floatlaunch.xyz offers. Every platform is
/// checked to really be one, so a layout change fails here and not mid-launch.
export async function readFloatConfig(connection, feeTier = 0) {
  const info = await connection.getAccountInfo(floatConfig());
  if (!info || !info.owner.equals(FLOAT_PROGRAM)) throw new Error('Float\'s config account is missing');
  const d = info.data;
  const treasury = new PublicKey(d.subarray(40, 72));
  const count = d[106];
  if (!(count >= 1 && count <= 3)) throw new Error('Float\'s config no longer reads as it used to; its layout changed');
  const keys = [...Array(count)].map((_, i) => new PublicKey(d.subarray(107 + 32 * i, 139 + 32 * i)));
  const infos = await connection.getMultipleAccountsInfo(keys);
  const tiers = keys.map((platform, i) => {
    const p = infos[i];
    if (!p || !p.owner.equals(LAUNCHLAB) || p.data.length !== 944) {
      throw new Error('Float\'s config no longer has its LaunchLab platforms where it used to; the layout changed');
    }
    const platformRate = Number(p.data.readBigUInt64LE(104));    // 1e-6 units
    const creatorRate = Number(p.data.readBigUInt64LE(720));
    return { index: i, platform, platformRate, creatorRate, totalBps: Math.round((platformRate + creatorRate) / 100) + 25 };
  });
  if (!tiers[feeTier]) throw new Error(`Float has ${count} fee tier${count === 1 ? '' : 's'}; there is no tier ${feeTier}`);
  return { treasury, tiers, platform: tiers[feeTier].platform, feeTier };
}

/// The pair token as Float has it registered: its LaunchLab config, and the
/// token program and decimals needed to spend it.
export async function readFloatQuote(connection, quoteMint) {
  const quote = new PublicKey(quoteMint);
  const rec = await connection.getAccountInfo(floatQuoteRecord(quote));
  if (!rec || rec.data.length !== QUOTE_RECORD_SIZE) {
    throw new Error(`${quote.toBase58().slice(0, 8)}… is not one of Float's pair tokens`);
  }
  const mint = await connection.getParsedAccountInfo(quote);
  const info = mint.value?.data?.parsed?.info;
  if (!info) throw new Error('could not read the pair token\'s mint');
  const md = (info.extensions || []).find((e) => e.extension === 'tokenMetadata')?.state;
  return {
    mint: quote, llConfig: new PublicKey(rec.data.subarray(40, 72)),
    program: mint.value.owner, decimals: info.decimals, symbol: md?.symbol || null,
  };
}

/// Who has a ticker already, if anyone. Any record at all is a wall.
export async function floatTickerOwner(connection, ticker) {
  const rec = await connection.getAccountInfo(floatTickerRecord(ticker));
  if (!rec) return null;
  const d = rec.data;
  return {
    coin: new PublicKey(d.subarray(8, 40)).toBase58(),
    owner: new PublicKey(d.subarray(40, 72)).toBase58(),
    since: new Date(Number(d.readBigInt64LE(72)) * 1000),
  };
}

/// Check everything Float would refuse, in words, before a signature.
export function floatCheckMetadata({ name, symbol, uri }) {
  if (!FLOAT_TICKER_RULE.test(symbol || '')) {
    throw new Error(`Float tickers are 1-10 characters, A-Z and 0-9 only; "${symbol}" is not one`);
  }
  const bytes = (s) => new TextEncoder().encode(s || '').length;
  if (!name) throw new Error('the coin needs a name');
  if (bytes(name) > FLOAT_NAME_MAX_BYTES) {
    throw new Error(`the name is ${bytes(name)} bytes and a Float coin's (Metaplex) metadata holds ${FLOAT_NAME_MAX_BYTES}`);
  }
  if (bytes(uri) > FLOAT_URI_MAX_BYTES) throw new Error(`the metadata URI is ${bytes(uri)} bytes; the cap is ${FLOAT_URI_MAX_BYTES}`);
}

function floatString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u64le(b.length).subarray(0, 4), b]);
}

/// The Launch instruction, account for account as the live launches send it.
export function floatLaunchIx({ payer, creator, nonce, name, symbol, uri, quote, cfg, feeTier = cfg.feeTier ?? 0 }) {
  const mint = floatMint(payer, nonce);
  const pool = llPool(mint, quote.mint);
  const keys = [
    [payer, true, true], [floatConfig(), false, false], [cfg.treasury, false, true],
    [floatQuoteRecord(quote.mint), false, false], [quote.mint, false, false],
    [floatTickerRecord(symbol), false, true], [mint, false, true], [floatLaunchRecord(mint), false, true],
    [floatCoinAuthority(mint), false, false], [quote.llConfig, false, false], [cfg.platform, false, false],
    [LL_AUTHORITY, false, false], [pool, false, true], [llVault(pool, mint), false, true],
    [llVault(pool, quote.mint), false, true], [metadataPda(mint), false, true], [LL_EVENT_AUTHORITY, false, false],
    [LAUNCHLAB, false, false], [TOKEN_PROGRAM_ID, false, false], [quote.program, false, false],
    [METAPLEX, false, false], [SystemProgram.programId, false, false], [SYSVAR_RENT_PUBKEY, false, false],
  ].map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable }));
  const data = Buffer.concat([
    LAUNCH_DISC, floatString(name), floatString(symbol), floatString(uri),
    // one byte between the creator and the nonce: the fee tier, an index into
    // Float's 1-3 fee rates, each its own LaunchLab platform. Float has one.
    new PublicKey(creator).toBuffer(), Buffer.from([feeTier]), u64le(nonce),
  ]);
  return { ix: new TransactionInstruction({ programId: FLOAT_PROGRAM, keys, data }), mint, pool };
}

/// Fail the whole transaction if the ticker has been registered by the time it
/// executes. Float does not refuse a taken ticker - it takes 1 SOL for it - so
/// the check before signing is not enough on its own: someone could register
/// the ticker in the seconds between that check and this landing. Lighthouse's
/// AssertAccountInfo (discriminator 5, log level 0, assertion Lamports = tag 0,
/// u64 value, IntegerOperator Equal = 0) on the ticker record: an account that
/// does not exist has no lamports, so the worst case is a reverted transaction
/// and its fee, never the 1 SOL.
export function floatTickerFreeGuardIx(ticker) {
  const data = Buffer.alloc(12);
  data[0] = 5;   // AssertAccountInfo
  data[1] = 0;   // log level: silent
  data[2] = 0;   // Lamports; value 0 at 3..10, operator Equal at 11
  return new TransactionInstruction({
    programId: LIGHTHOUSE, data,
    keys: [{ pubkey: floatTickerRecord(ticker), isSigner: false, isWritable: false }],
  });
}

/// The dev buy: LaunchLab's own buy_exact_in against the pool the Launch just
/// opened. Atomic with it, so the minimum out can be 1 - nothing can trade
/// between the two instructions.
export function floatDevBuyIxs({ payer, mint, pool, quote, cfg, amountIn }) {
  const userBase = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_PROGRAM_ID);
  const userQuote = getAssociatedTokenAddressSync(quote.mint, payer, false, quote.program);
  const creator = floatCoinAuthority(mint);
  const keys = [
    [payer, true, true], [LL_AUTHORITY, false, false], [quote.llConfig, false, false], [cfg.platform, false, false],
    [pool, false, true], [userBase, false, true], [userQuote, false, true],
    [llVault(pool, mint), false, true], [llVault(pool, quote.mint), false, true],
    [mint, false, true], [quote.mint, false, false], [TOKEN_PROGRAM_ID, false, false], [quote.program, false, false],
    [LL_EVENT_AUTHORITY, false, false], [LAUNCHLAB, false, false], [SystemProgram.programId, false, false],
    [llPlatformFeeVault(cfg.platform, quote.mint), false, true], [llCreatorFeeVault(creator, quote.mint), false, true],
  ].map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable }));
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, userBase, payer, mint, TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      programId: LAUNCHLAB, keys,
      data: Buffer.concat([BUY_EXACT_IN_DISC, u64le(amountIn), u64le(1), u64le(0)]),
    }),
  ];
}

const randomNonce = () => {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return Buffer.from(b).readBigUInt64LE(0);
};

/// A failed simulation, as Float or LaunchLab words it.
export function explainFloatFailure(logs = [], err = null) {
  if (logs.some((l) => l.includes(LIGHTHOUSE.toBase58() + ' failed'))) {
    return 'someone registered this ticker while the launch was on its way, so the guard stopped it — '
      + 'nothing was paid for the ticker; pick another';
  }
  const code = (logs.join('\n').match(/custom program error: 0x([0-9a-f]+)/i) || [])[1];
  const n = code ? parseInt(code, 16) : null;
  const anchor = logs.find((l) => /Error Message:/.test(l));
  if (anchor) return anchor.replace(/.*Error Message:\s*/, '');
  if (n !== null && n >= 6000 && n - 6000 < FLOAT_ERRORS.length && logs.some((l) => l.includes(FLOAT_PROGRAM.toBase58() + ' failed'))) {
    return FLOAT_ERRORS[n - 6000];
  }
  const tooLong = logs.find((l) => /too long/i.test(l));
  if (tooLong) return tooLong.replace('Program log: ', '');
  return (logs.find((l) => /Error|failed/.test(l)) || JSON.stringify(err) || 'the launch would fail').slice(0, 200);
}

/// Launch a coin on Float. Refuses a ticker someone already holds rather than
/// paying to take it over.
export async function launchFloat(opts) {
  const {
    rpcUrl, secretKey, quoteMint, name, symbol, uri, feeTier = 0, creatorWallet = null,
    devBuyUi = '0', priorityMicroLamports = 200_000, dryRun = false, onStatus,
  } = opts;
  const say = (m) => onStatus && onStatus(m);
  floatCheckMetadata({ name, symbol, uri });
  const connection = new Connection(rpcUrl, 'confirmed');
  const signer = secretKey ? keypairFromSecret(secretKey) : null;
  const payer = dryRun && opts.simulateAs ? new PublicKey(opts.simulateAs) : signer.publicKey;

  say('checking the ticker is free on Float…');
  const held = await floatTickerOwner(connection, symbol);
  if (held) {
    throw new Error(`the ticker ${symbol} is already taken on Float — by ${held.coin.slice(0, 8)}… since `
      + `${held.since.toISOString().slice(0, 10)}. Reusing it means paying Float 1 SOL to take it over, so this launch `
      + 'stops here instead; pick another ticker.');
  }

  const [cfg, quote] = await Promise.all([readFloatConfig(connection, feeTier), readFloatQuote(connection, quoteMint)]);
  // the creator share is paid to this wallet, in the pair token
  const creator = creatorWallet ? new PublicKey(creatorWallet) : payer;
  let nonce, mint;
  for (;;) {
    nonce = opts.nonce != null ? BigInt(opts.nonce) : randomNonce();
    mint = floatMint(payer, nonce);
    if (opts.nonce != null || !(await connection.getAccountInfo(mint))) break;
  }
  const launch = floatLaunchIx({ payer, creator, nonce, name, symbol, uri, quote, cfg });

  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })];
  if (priorityMicroLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));
  ixs.push(floatTickerFreeGuardIx(symbol), launch.ix);

  const amountIn = uiToRaw(devBuyUi, quote.decimals);
  const name_ = quote.symbol || 'the pair token';
  if (amountIn > 0n) {
    if (!dryRun) {
      const ata = getAssociatedTokenAddressSync(quote.mint, payer, false, quote.program);
      const bal = await connection.getTokenAccountBalance(ata).then((r) => BigInt(r.value.amount)).catch(() => 0n);
      if (bal < amountIn) {
        const whole = (v) => (Number(v) / 10 ** quote.decimals).toLocaleString(undefined, { maximumFractionDigits: quote.decimals });
        throw new Error(`the dev buy is ${whole(amountIn)} ${name_} and the wallet holds ${whole(bal)} — `
          + `${whole(amountIn - bal)} short. Float coins are priced in ${name_}, so the buy is funded in it, not SOL.`);
      }
    }
    ixs.push(...floatDevBuyIxs({ payer, mint: launch.mint, pool: launch.pool, quote, cfg, amountIn }));
  }

  // compiled against Float's lookup table when it is there; without it only a
  // launch with no dev buy fits
  const lut = (await connection.getAddressLookupTable(FLOAT_LOOKUP_TABLE).catch(() => null))?.value;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message(lut ? [lut] : []));
  say('simulating the launch…');
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  const result = {
    mint: launch.mint.toBase58(), pool: launch.pool.toBase58(), nonce: nonce.toString(),
    quote: quote.mint.toBase58(), quoteSymbol: quote.symbol, devBuyRaw: amountIn.toString(),
    feeTier, feeBps: cfg.tiers[feeTier].totalBps, creator: creator.toBase58(),
  };
  if (sim.value.err) {
    const why = explainFloatFailure(sim.value.logs || [], sim.value.err);
    if (dryRun) return { ...result, dryRun: true, simulationError: why, logs: sim.value.logs || [] };
    throw new Error('Float would refuse this launch: ' + why);
  }
  if (dryRun) return { ...result, dryRun: true, simulationError: null, logs: sim.value.logs || [], unitsConsumed: sim.value.unitsConsumed };

  say('sending the launch…');
  tx.sign([signer]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  say(`sent ${sig.slice(0, 8)}… — waiting for confirmation`);
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) throw new Error(`the launch landed but failed: ${JSON.stringify(conf.value.err)} (${sig})`);
  return { ...result, sig };
}

function uiToRaw(ui, decimals) {
  const s = String(ui ?? '0').trim().replace(/,/g, '') || '0';
  if (!/^\d*\.?\d*$/.test(s)) throw new Error(`"${ui}" is not an amount`);
  const [w, f = ''] = s.split('.');
  return BigInt((w || '0') + f.padEnd(decimals, '0').slice(0, decimals));
}

/// Every pair token Float offers: one record each, with the mint and its
/// LaunchLab config. Symbols come from the mint (Token-2022) or its Metaplex
/// account (classic SPL).
export async function listFloatQuotes(rpcUrl) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const recs = await connection.getProgramAccounts(FLOAT_PROGRAM, { filters: [{ dataSize: QUOTE_RECORD_SIZE }] });
  const mints = recs.map((r) => new PublicKey(r.account.data.subarray(8, 40)));
  const out = [];
  for (let i = 0; i < mints.length; i += 90) {
    const slice = mints.slice(i, i + 90);
    const [infos, metas] = await Promise.all([
      connection.getMultipleParsedAccounts(slice),
      connection.getMultipleAccountsInfo(slice.map(metadataPda)),
    ]);
    slice.forEach((m, j) => {
      const v = infos.value[j];
      const info = v?.data?.parsed?.info;
      const md = (info?.extensions || []).find((e) => e.extension === 'tokenMetadata')?.state;
      let symbol = md?.symbol, name = md?.name;
      if (!symbol && metas[j]) {
        const d = metas[j].data;
        let o = 1 + 32 + 32;
        const str = () => { const n = d.readUInt32LE(o); o += 4; const s = d.subarray(o, o + n).toString('utf8').replace(/\0+$/, ''); o += n; return s; };
        name = str(); symbol = str();
      }
      out.push({
        mint: m.toBase58(), symbol: (symbol || '').trim() || m.toBase58().slice(0, 6),
        name: (name || '').trim(), decimals: info?.decimals ?? null,
        token2022: v ? v.owner.equals(TOKEN_2022_PROGRAM_ID) : null,
      });
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

