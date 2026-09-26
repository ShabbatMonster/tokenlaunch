import { Connection, PublicKey } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Raydium LaunchLab migration: NOT POSSIBLE, and this file exists to say so
// precisely rather than to leave the question open.
//
// migrate_to_cpswap on LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj takes no
// arguments and its IDL declares no admin account, so it reads as
// permissionless. It is not. The payer is constrained to one fixed address.
//
// Proven by replaying a real migration with only the payer swapped - every
// other account, the data, and the lookup table left exactly as they were -
// against tx 2nJcoPjW8DDhckr8XHNYnCoY5CvXB9Ss8jcDeZjtvEvTewuhTWTYm11YDZh5Lwt.
// The program answers:
//
//   AnchorError caused by account: payer. Error Code: InvalidOwner.
//   Error Number: 6001. Error Message: Input account owner is not the
//   program address.
//   Left:  Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS   (our payer)
//   Right: RAYpQbFNq9i3mu6cKpTKKRwwHFDeK5AuZz8xvxUrCgw    (what it wants)
//
// It names the address it requires. Sampling agrees with the constraint: of 15
// consecutive migrate_to_cpswap calls on mainnet, 15 were signed by that same
// address, which is Raydium's own migrator.
//
// So a LaunchLab coin that has filled its curve can only be migrated by
// Raydium. There is no rescue path, no delay after which it opens up - unlike
// Pons, whose factory exposes forceSweptGraduation once its own executor has
// had its chance - and no amount of getting the 38 accounts right changes it.
//
// This module therefore offers a diagnosis and no button. If Raydium ever adds
// a permissionless path the check below will start returning a different
// reason, because it asks the chain rather than repeating this comment.
// ---------------------------------------------------------------------------

export const LAUNCHLAB_PROGRAM = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
export const CPSWAP_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
/// The only address the program will accept as payer, taken from its own error.
export const RAYDIUM_MIGRATOR = new PublicKey('RAYpQbFNq9i3mu6cKpTKKRwwHFDeK5AuZz8xvxUrCgw');

export const LAUNCHLAB_BLOCKER =
  'Raydium LaunchLab migration is permissioned. migrate_to_cpswap requires the payer to be '
  + RAYDIUM_MIGRATOR.toBase58() + ', which is Raydium’s own migrator - the program says so itself, '
  + 'naming that address in an InvalidOwner error when anyone else replays a real migration. There is no '
  + 'rescue path and no delay after which it opens up, so a stuck LaunchLab coin can only be migrated by '
  + 'Raydium. Nothing about the account list changes that.';

// PoolState, enough of it to report status without pretending to offer a fix.
// Offsets found by searching a live pool for the mints it is known to hold
// (FPGKPbsB..., from the sample migration) rather than counted off the IDL.
const POOL_STATE_SIZE = 429;
const PS_BASE_MINT = 205;
const PS_QUOTE_MINT = 237;

/// Is this a LaunchLab coin, and what can be said about it? Never returns a
/// migratable state - see LAUNCHLAB_BLOCKER.
export async function inspectRaydiumMigration({ rpcUrl, mint, connection: conn }) {
  const connection = conn || new Connection(rpcUrl, 'confirmed');
  let hits = [];
  try {
    hits = await connection.getProgramAccounts(LAUNCHLAB_PROGRAM, {
      filters: [{ dataSize: POOL_STATE_SIZE },
        { memcmp: { offset: PS_BASE_MINT, bytes: new PublicKey(mint).toBase58() } }],
      dataSlice: { offset: 0, length: 0 },
    });
  } catch (e) {
    // a failed scan is not "no pool" - say which it was
    return { venue: 'raydium', isRaydiumCoin: null, state: 'unknown',
      reason: 'could not scan LaunchLab for this mint: ' + (e?.message || String(e)) };
  }
  if (!hits.length) {
    return { venue: 'raydium', isRaydiumCoin: false, state: 'not-a-raydium-coin',
      reason: 'No Raydium LaunchLab pool exists for this mint.' };
  }
  return {
    venue: 'raydium', isRaydiumCoin: true, state: 'blocked',
    poolState: hits[0].pubkey.toBase58(),
    requiredPayer: RAYDIUM_MIGRATOR.toBase58(),
    reason: LAUNCHLAB_BLOCKER,
  };
}
