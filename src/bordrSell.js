// Coordinated multi-wallet sell for Bordrless (bordrless.app) coins.
//
// Bordrless is its own token standard, DEX and launchpad - not SPL, so Jupiter
// and ordinary routers cannot sell it. Its launches carry an anti-dump lock in
// the rules kit: tokens bought in the first few minutes (the "early window")
// cannot be sold until a set time. The lock is a kit rule checked in the token
// hook's BeforeTransfer, which rejects an early sell with EarlyLocked (6007).
//
// Both facts are on-chain, read straight off the Launch account:
//   earlyWindowEnd  the end of the early window (createdAt + the window)
//   earlyUnlockAt   when early buyers may sell
//
// So the sell itself is built with the project's own @bordrless/sdk - the same
// instruction the site would send - and fired the instant earlyUnlockAt passes.
// A correct sell built before then reverts with EXACTLY EarlyLocked, which is
// how this module is verified without an unlocked wallet: reach the lock and
// nothing else. src/bordrSell-page.js drives the wallets and the timing.
//
// This sells tokens the wallets already hold; nothing here signs or sends - the
// page does, with keys the user pastes, which never leave the browser.

import { Connection, PublicKey, ComputeBudgetProgram, Keypair } from '@solana/web3.js';
import * as B from '@bordrless/sdk';
import bs58 from 'bs58';

export const BORDRLESS_PROGRAMS = {
  token: '2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22',
  dex: 'GyzKSnnEu2uN5bBRecE4XYY2enbfR2D2MtxnbJPGy7hk',
  launch: '1jcBymHxBjniZDhNPy51Vgm5Nz7pLUdxa9UBHc4TavC',
  kit: '14RJQXPdJfkehit6ezktjd3xujamf8nVSKw2shKamaEH',
  bridge: 'CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7',
};

// EarlyLocked is the lock; the rest are the reverts a too-early or mis-timed
// sell can throw, which the firing loop treats as "not yet, keep trying".
export const EARLY_LOCKED = 6007;
export const RETRYABLE_CUSTOM = new Set([6007]);

const conn = (rpc) => (typeof rpc === 'string' ? new Connection(rpc, 'confirmed') : rpc);

/// Read a Bordrless coin: its launch, the keys a swap needs, and the lock.
export async function loadBordrCoin(rpc, mintStr) {
  const connection = conn(rpc);
  const mint = new PublicKey(mintStr);
  const launch = await B.fetchAccount(connection, B.launchAddress(mint), B.decodeLaunch);
  if (!launch) throw new Error('no Bordrless launch found for that mint - is it a bordrless.app coin?');
  // a custom-hook launch needs the hook's accounts, or the swap is refused
  const customHook = launch.customHook ? await B.fetchCustomHookAccounts(connection, launch.customHook, mint) : null;
  const keys = B.launchKeysOf(launch, customHook);
  return {
    connection, mint, launch, keys,
    quoteMint: launch.quoteMint,
    status: launch.status,                  // 0 on the curve, 1 graduated
    createdAt: launch.createdAt,
    earlyWindowEnd: launch.earlyWindowEnd,   // unix secs, 0 if no early lock
    earlyUnlockAt: launch.earlyUnlockAt,     // unix secs, 0 if no early lock
    sniperWindowSecs: launch.sniperWindowSecs,
  };
}

/// A wallet's holding of the coin and its balance (raw units).
export async function walletHolding(rpc, mint, owner) {
  const connection = conn(rpc);
  const o = owner instanceof PublicKey ? owner : new PublicKey(owner);
  const holding = B.holdingAddress(new PublicKey(mint), o);
  const balance = await B.holdingBalance(connection, holding).catch(() => 0n);
  return { holding, balance };
}

/// The sell instruction: trader and recipient are the wallet itself, direction
/// 0 sells, amountIn is the raw token amount, minOut the least quote accepted
/// (0 = market, the fastest exit and never a slippage revert).
export function sellIx(keys, owner, amountIn, minOut = 0n) {
  const o = owner instanceof PublicKey ? owner : new PublicKey(owner);
  return B.launch.swap(keys, o, o, 0, BigInt(amountIn), BigInt(minOut));
}

/// A signed, ready-to-send sell transaction for `secret` selling `amountIn`.
/// Pass a fresh `blockhash`; `lut` is the protocol lookup table (optional for a
/// single sell, which fits without one). priorityMicroLamports tips the leader.
export function buildSignedSell({ keys, secret, amountIn, minOut = 0n, blockhash, lut = null, computeUnits = 600_000, priorityMicroLamports = 2_000_000 }) {
  const kp = secret instanceof Keypair ? secret : Keypair.fromSecretKey(bs58.decode(secret));
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
    sellIx(keys, kp.publicKey, amountIn, minOut),
  ];
  const tx = B.buildV0Transaction(kp.publicKey, ixs, blockhash, lut ? [lut] : []);
  tx.sign([kp]);
  return { tx, signer: kp.publicKey, serialized: tx.serialize() };
}

/// Why a simulation/send failed, in one line - naming EarlyLocked and whether
/// it is worth retrying (the lock, a stale blockhash, a transient).
export function classifyError(err, logs = []) {
  const custom = err?.InstructionError?.[1]?.Custom;
  if (custom === EARLY_LOCKED || (logs || []).some((l) => /EarlyLocked|early window are locked/.test(l))) {
    return { kind: 'locked', retry: true, message: 'still locked (tokens bought in the early window)' };
  }
  const anchor = (logs || []).find((l) => /Error Message:/.test(l));
  if (anchor) return { kind: 'error', retry: typeof custom === 'number' && RETRYABLE_CUSTOM.has(custom), message: anchor.replace(/.*Error Message:\s*/, '') };
  if (/Blockhash not found|block height exceeded/i.test(JSON.stringify(err || ''))) return { kind: 'stale', retry: true, message: 'blockhash expired - rebuilding' };
  return { kind: 'error', retry: false, message: typeof err === 'string' ? err : JSON.stringify(err) };
}

/// Simulate a sell: before the unlock a correct one reverts with EarlyLocked,
/// which is the proof it is otherwise ready. Returns { ok, locked, message }.
export async function simulateSell(rpc, { keys, owner, amountIn, minOut = 0n }) {
  const connection = conn(rpc);
  const o = owner instanceof PublicKey ? owner : new PublicKey(owner);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    sellIx(keys, o, amountIn, minOut),
  ];
  const bh = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const tx = B.buildV0Transaction(o, ixs, bh, []);
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  const c = classifyError(sim.value.err, sim.value.logs || []);
  return {
    ok: !sim.value.err,
    locked: c.kind === 'locked',
    message: sim.value.err ? c.message : 'would sell now',
    logs: sim.value.logs || [],
  };
}

export const pubkeyOfSecret = (secret) => Keypair.fromSecretKey(bs58.decode(secret)).publicKey.toBase58();
export { B as sdk, PublicKey, Connection };
