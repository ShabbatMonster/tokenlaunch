// Migrating a pump.fun coin: migrate_v2.
//
// The instruction takes no arguments, so the account list IS the instruction,
// and it is wrong in three ways that all look like something else:
//
//  1. pump's on-chain IDL declares 27 accounts. Every real migration passes 29.
//     The two undeclared ones are PumpSwap's boost vault and its quote account,
//     which the program sends part of the raised quote into. They are not in
//     pump's IDL and not in PumpSwap's either - both are behind their deployed
//     programs - so they can only be read off real transactions.
//  2. `user_pool_token_account` is not the user's. It is the POOL AUTHORITY's
//     account for the LP mint. Deriving it from the signer, which is what the
//     name invites, is wrong on every migration.
//  3. the quote is not always wrapped SOL and not always the classic token
//     program, so base_token_program and quote_token_program have to be read
//     from the mints rather than assumed.
//
// Checked against two real migrations with deliberately different shapes:
//   3J95FU1yfxWk… SOL-quoted     (25UThw41…, creator migrated it)
//   5s1H5vwTzMpf… Token-2022-quoted (GacgmKku…, a STRANGER migrated it)
//
// The second one is also the evidence that migrate_v2 is permissionless: its
// signer is not the coin's creator.
//
// Run: node test/js/pump-migrate-accounts.test.mjs

import { Connection, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  pumpMigrateAccounts, migrateV2Ix, inspectPumpMigration, readPumpCurve,
  boostVaultFor, poolAuthorityFor, lpMintFor,
} from '../../src/pumpMigrate.js';

const RPC = 'https://mainnet.helius-rpc.com/?api-key=ae11f74a-b518-408b-bc88-524c277da375';
const connection = new Connection(RPC, 'confirmed');

// An address that exists and is nobody's creator. Simulation needs a fee payer
// that exists on-chain; a fresh keypair fails as AccountNotFound before the
// program ever runs, which reads exactly like a broken account list.
const STRANGER = new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// The 29 accounts exactly as the real migrations passed them, in order.
const REAL = {
  'SOL-quoted': {
    mint: '25UThw41PUqCTRpGSBzoZRB1MYEZsjVo7AUAn7Nupump',
    user: 'E2aixUB2AbQ4yiFvYMUoqfUNvcbfw4B4yS3zcdV4WwX1',
    accounts: [
      '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
      '25UThw41PUqCTRpGSBzoZRB1MYEZsjVo7AUAn7Nupump', 'So11111111111111111111111111111111111111112',
      'HQhzTLwbmgttLskqfgV43dmMsof8W7dRBjLbyDDd1XE', 'CMinhbjMsixFTfhMue2gBLixNMuEMJqNbcFbCV6eC64M',
      'FwTw5Np2meGuJ6qvjSfajipQucHd3wZoz9ZXPMupuGWi', 'E2aixUB2AbQ4yiFvYMUoqfUNvcbfw4B4yS3zcdV4WwX1',
      '11111111111111111111111111111111', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      '4wkTST18ejFAV2wWTBW5jvgVAiAD2d6VnaGXawPbFRC', '3X8sRufYoqEm5e5aDEquEZgu1UxYSHwMNy3SyhSx73uP',
      'GUv9MWqtnLpjfYKx3Tuy6zdDy2AHhXbd126ehsmiuftv', 'GnxJXzVRBZJbjPF1cWgbQE14YbCwByU55UQM1out1ZQH',
      'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw', 'AbkSzkmiXVGbUnkLHPyUTt7K6DDaFUBShBnuvCeekSvi',
      '7tpDj1NSPYUMAadSv2XokgkPDsv3XP8QHngBezqUfWfp', 'AzWscV2gTeYJrJUPMjKB4Fa841EoEiatk392iCtrzSVe',
      'DyEZddjoESai5dHFVWGK4JDu72To2V4MMdT5xooAgPg9', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR',
      'SysvarRent111111111111111111111111111111111', 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'Hu8ur1DbgXWs9N3j2NkyzitcgB3nJL8wPq4RrXJLK55F',
      '8FnPiH3J8CNS3iNxqDs72bv9bMvzML5bPtv8nJ22krvd',
    ],
  },
  'Token-2022-quoted': {
    mint: 'GacgmKkuqxLfL7qox6YMeP7SWHdC1ayMsLUJcuKB5huf',
    // not the creator (8gGXNaGf…) - a stranger migrated this one
    user: '9C4nRvhhVquCKATjDCx5FKvNS9PNgNqgyWy9AcoDjYv5',
    accounts: [
      '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
      'GacgmKkuqxLfL7qox6YMeP7SWHdC1ayMsLUJcuKB5huf', 'CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU',
      'KijPRJHHHepbHmQYAu7LzTeL9PARQvceztkXaQns4wp', '64V3P85FEPbEZ5Wj2ujMkDygg84izPPyG6hGuBhbhGyr',
      'DeEeK26ieWJtMGv1GDksUixuVifcry3nFeR1GLgmA1FG', '9C4nRvhhVquCKATjDCx5FKvNS9PNgNqgyWy9AcoDjYv5',
      '11111111111111111111111111111111', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      'ADUJ4UgHrMqMhsGEE8bSHaEomGAHuKpDFtzmhcxrpHX7', '7nAhBZWJ7sURSE6iWhYDnv726iEiYzgj7rqLmg5EVL4k',
      '6etvDwaWKZeTB42S4AFEcNmoFDNyShyceQkiXkSQHP9N', '7MVLz3ZHaDPLwXzMUpNYBdZQKLuW3SoJBBL5qA72oTBA',
      'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw', '3a9dv6hj2cwdGotfedyvsSPoBUJLaFb2jDcKyy34gmgd',
      'CLJckjNrEC8GCHoJtHJqaWJAHDo1jCrxctkF7RcTaEQt', 'CPCWHnUYbM2tQUJXBPUBoTWJhjDNaQxHfnnyx1k74AbC',
      '5C4LrvcvpyHtTckELUU8a2HoxqcHVTaN82LySB86p24n', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR',
      'SysvarRent111111111111111111111111111111111', 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'B2CMJKcTW49aWP8d91M4hhNhWN7c76XDVuPuRBetodoD',
      'BSeRugyFB2FXxcX5XyshH4gb5WTbk9FgtAvyv4z8Ym4H',
    ],
  },
};

// --- every account derives from the mint alone -------------------------------
for (const [label, want] of Object.entries(REAL)) {
  const built = await pumpMigrateAccounts(connection, want.mint, want.user);
  const got = built.metas.map((m) => m.pubkey.toBase58());
  const firstBad = got.findIndex((a, i) => a !== want.accounts[i]);
  check(got.length === 29, `${label}: twenty-nine accounts, not the IDL's twenty-seven`, String(got.length));
  check(firstBad === -1, `${label}: every account matches the real migration`,
    firstBad === -1 ? '' : `index ${firstBad}: got ${got[firstBad]}, real tx used ${want.accounts[firstBad]}`);

  // the two the IDL never mentions
  check(got[27] === boostVaultFor(built.pool).toBase58(),
    `${label}: account 27 is PumpSwap's boost vault, keyed by the pool`);
  check(got[28] === want.accounts[28], `${label}: account 28 is the boost vault's quote account`);

  // trap 2, stated as its own assertion so a "fix" to the obvious reading fails here
  const lpMint = lpMintFor(built.pool).toBase58();
  check(built.lpMint.toBase58() === want.accounts[15], `${label}: lp_mint derives from the pool`, lpMint);
  check(got[16] !== got[7], `${label}: user_pool_token_account is NOT the signer's, despite the name`);
}

// trap 3: the two token programs genuinely differ between these coins
const sol = await pumpMigrateAccounts(connection, REAL['SOL-quoted'].mint, STRANGER);
const t22 = await pumpMigrateAccounts(connection, REAL['Token-2022-quoted'].mint, STRANGER);
check(sol.quoteTokenProgram.toBase58() !== t22.quoteTokenProgram.toBase58(),
  'the quote token program is read from the mint, not assumed',
  `${sol.quoteTokenProgram.toBase58().slice(0, 8)}… vs ${t22.quoteTokenProgram.toBase58().slice(0, 8)}…`);

// --- the live program accepts the account list -------------------------------
// Anchor validates every declared account before the handler runs, so reaching
// the handler at all proves the seeds, owners and mints are right.
for (const [label, want] of Object.entries(REAL)) {
  const built = await pumpMigrateAccounts(connection, want.mint, STRANGER);
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }))
    .add(migrateV2Ix(built.metas));
  tx.feePayer = STRANGER;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const sim = await connection.simulateTransaction(tx);
  const reached = (sim.value.logs || []).some((l) => /Instruction: MigrateV2/.test(l));
  const constraintError = (sim.value.logs || []).some((l) => /Constraint|Seeds|AccountNotInitialized|AccountOwnedBy/.test(l));
  check(reached && !constraintError,
    `${label}: the live program accepts all 29 accounts`,
    `${tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length} bytes / 1232`);
}

// --- the no-op trap ----------------------------------------------------------
// An already-migrated coin does not fail. The program logs "already migrated"
// and returns SUCCESS, so a page trusting "the simulation passed" would offer a
// button that burns a fee and does nothing.
const already = await inspectPumpMigration({ connection, mint: REAL['SOL-quoted'].mint, user: STRANGER.toBase58() });
check(already.state === 'migrated', 'an already-migrated coin reports migrated, not migratable', already.state);

// An incomplete curve is the loud case: BondingCurveNotComplete, 6006.
const live = await findLiveCurve();
if (live) {
  const info = await inspectPumpMigration({ connection, mint: live, user: STRANGER.toBase58() });
  check(info.state === 'on-curve', 'a still-trading coin reports on-curve', `${live.slice(0, 10)}… -> ${info.state}`);
} else {
  console.log('SKIP  no still-trading coin found in the sample to check the on-curve state');
}

async function findLiveCurve() {
  const res = await (await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
      params: ['4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', { limit: 15 }],
    }),
  })).json();
  for (const s of res.result || []) {
    if (s.err) continue;
    const t = await (await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getTransaction',
        params: [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 2, commitment: 'confirmed' }],
      }),
    })).json();
    for (const b of t.result?.meta?.postTokenBalances || []) {
      if (!b.mint) continue;
      const curve = await readPumpCurve(connection, b.mint);
      if (curve && !curve.complete && curve.realQuoteReserves > 0n) return b.mint;
    }
  }
  return null;
}

console.log('');
process.exit(fails.length ? 1 : 0);
