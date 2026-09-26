import {
  Connection, Keypair, PublicKey, VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Jupiter, standalone.
//
// src/solana.js already has these routines, but it pulls in the Meteora and
// Raydium SDKs with them, and the extension has no use for either. This is the
// same logic with nothing behind it but web3.js, so the swap can ride into the
// service worker without another megabyte.
//
// Two things worth stating, both learned the hard way:
//
//   - Jupiter's lite API reports NO decimals for the output mint, at the top
//     level or inside routePlan. An amount taken off a route and divided by a
//     guessed 10^9 is wrong by a thousand on a USDC route, so decimals are read
//     from the mint and cached.
//   - what arrived is read as a balance delta, not taken from the route's
//     estimate. A route that partially fills, or fills worse than quoted, still
//     hands back a cheerful-looking quote object.
// ---------------------------------------------------------------------------

const JUP = 'https://lite-api.jup.ag/swap/v1';
export const WSOL = 'So11111111111111111111111111111111111111112';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_ACCOUNT_AMOUNT = 64;

const ataOf = (mint, owner, tokenProgram) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM,
)[0];

export function keypairFrom(secret) {
  const s = String(secret).trim();
  if (s.startsWith('[')) {
    const arr = Uint8Array.from(JSON.parse(s));
    if (arr.length !== 64) throw new Error('SOL key array must be 64 bytes');
    return Keypair.fromSecretKey(arr);
  }
  return Keypair.fromSecretKey(bs58.decode(s));
}

const decimalsCache = new Map();
async function mintInfo(connection, mint) {
  const k = String(mint);
  if (!decimalsCache.has(k)) {
    const info = await connection.getParsedAccountInfo(new PublicKey(k), 'confirmed');
    const dec = info.value?.data?.parsed?.info?.decimals;
    if (dec == null) throw new Error('not a valid SPL or Token-2022 mint: ' + k);
    const program = info.value.owner.equals(TOKEN_2022) ? TOKEN_2022 : TOKEN_PROGRAM;
    decimalsCache.set(k, { decimals: dec, program });
  }
  return decimalsCache.get(k);
}

/// What this wallet holds of a mint, in its own units.
export async function tokenHoldings({ rpcUrl, owner, mint, connection: conn }) {
  const connection = conn || new Connection(rpcUrl, 'confirmed');
  const who = new PublicKey(owner);
  if (String(mint) === WSOL) {
    const lamports = await connection.getBalance(who, 'confirmed');
    return { isNative: true, decimals: 9, raw: String(lamports), ui: lamports / 1e9 };
  }
  const { decimals, program } = await mintInfo(connection, mint);
  const ata = ataOf(new PublicKey(mint), who, program);
  const info = await connection.getAccountInfo(ata, 'confirmed');
  const raw = info ? info.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT) : 0n;
  return { isNative: false, decimals, raw: raw.toString(), ui: Number(raw) / 10 ** decimals };
}

async function jupiterQuote(inputMint, outputMint, amount, slippageBps) {
  const url = `${JUP}/quote?` + new URLSearchParams({
    inputMint, outputMint, amount: String(amount), slippageBps: String(slippageBps),
  });
  const q = await (await fetch(url)).json();
  if (!q || q.error || !q.routePlan) throw new Error('Jupiter: no route (' + (q?.error || 'none') + ')');
  return q;
}

/// What `lamports` of SOL would buy of `quoteMint` right now. No signing.
export async function previewSwapIntoQuote({ rpcUrl, quoteMint, lamports, slippageBps = 100, connection: conn }) {
  if (String(quoteMint) === WSOL) throw new Error('the quote already is SOL - there is nothing to swap into');
  const amount = BigInt(lamports);
  if (amount <= 0n) return null;
  const connection = conn || new Connection(rpcUrl, 'confirmed');
  const [q, info] = await Promise.all([
    jupiterQuote(WSOL, String(quoteMint), amount.toString(), slippageBps),
    mintInfo(connection, quoteMint),
  ]);
  return {
    outRaw: q.outAmount,
    decimals: info.decimals,
    out: Number(q.outAmount) / 10 ** info.decimals,
    route: q.routePlan.map((r) => r.swapInfo.label),
  };
}

/// Swap SOL into the coin's quote token so a buy can be funded.
export async function swapIntoQuote({
  rpcUrl, secretKey, quoteMint, lamports, slippageBps = 100, onStatus,
}) {
  const say = (m) => onStatus && onStatus(m);
  if (String(quoteMint) === WSOL) throw new Error('the quote already is SOL - there is nothing to swap into');

  const connection = new Connection(rpcUrl, 'confirmed');
  const owner = keypairFrom(secretKey);
  const amount = BigInt(lamports);
  if (amount <= 0n) throw new Error('enter an amount of SOL to swap');

  // Whatever is swapped stops being available for rent and fees, and a migration
  // still has to create accounts afterwards.
  const HEADROOM = 30_000_000;
  const balance = BigInt(await connection.getBalance(owner.publicKey, 'confirmed'));
  if (balance < amount + BigInt(HEADROOM)) {
    throw new Error(
      `swapping ${Number(amount) / 1e9} SOL would leave too little behind: the migration still needs about `
      + `${HEADROOM / 1e9} SOL for rent and fees, and the wallet holds ${Number(balance) / 1e9}.`,
    );
  }

  const { decimals, program } = await mintInfo(connection, quoteMint);
  const ata = ataOf(new PublicKey(quoteMint), owner.publicKey, program);
  const before = await connection.getAccountInfo(ata, 'confirmed')
    .then((i) => (i ? i.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT) : 0n));

  say('asking Jupiter for a route...');
  const q = await jupiterQuote(WSOL, String(quoteMint), amount.toString(), slippageBps);
  const route = q.routePlan.map((r) => r.swapInfo.label);

  say('swapping ' + Number(amount) / 1e9 + ' SOL via ' + route.join(' → ') + '...');
  const res = await (await fetch(`${JUP}/swap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: q, userPublicKey: owner.publicKey.toBase58(),
      wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 5_000_000, priorityLevel: 'high' } },
    }),
  })).json();
  if (!res.swapTransaction) throw new Error('Jupiter could not build the swap: ' + (res?.error || 'no reason given'));

  const buf = Uint8Array.from(atob(res.swapTransaction), (ch) => ch.charCodeAt(0));
  const vtx = VersionedTransaction.deserialize(buf);
  vtx.sign([owner]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 3 });
  await connection.confirmTransaction({
    signature: sig, blockhash: vtx.message.recentBlockhash, lastValidBlockHeight: res.lastValidBlockHeight,
  }, 'confirmed');

  const after = await connection.getAccountInfo(ata, 'confirmed')
    .then((i) => (i ? i.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT) : 0n));
  const received = after - before;
  if (received <= 0n) throw new Error('the swap confirmed but no quote token arrived - check the transaction');

  return {
    sig, route, decimals,
    receivedRaw: received.toString(),
    received: Number(received) / 10 ** decimals,
    heldRaw: after.toString(),
  };
}
