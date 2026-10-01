// Spending the quote from wherever it is actually held.
//
// A LaunchLab dev buy failed with:
//
//   cannot found mintB(6GmAFSYs...) buy token accounts
//
// while the wallet was holding 4,721 of that token the whole time. The Raydium
// SDK defaults `associatedOnly` to true, so it only ever looks at the
// ASSOCIATED token account - and this balance sat in a plain one, with no ATA in
// existence at all. Anything received from an exchange or an airdrop can land
// like that, so the failure is not exotic.
//
// The error is also badly misleading: it says the accounts cannot be found, not
// that it declined to look at the one that was there.
//
// Run: node test/js/launchlab-nonata-quote.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

const RPC = 'https://mainnet.helius-rpc.com/?api-key=ae11f74a-b518-408b-bc88-524c277da375';
const c = new Connection(RPC, 'confirmed');

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const OWNER = new PublicKey('JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT');
const QUOTE = new PublicKey('6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the fix, at the source --------------------------------------------------
//
// This is the assertion that actually protects the launch path: the option has
// to be passed, and passed false.
const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'solana.js'), 'utf8');
const call = SRC.slice(SRC.indexOf('raydium.launchpad.createLaunchpad'), SRC.indexOf('computeBudgetConfig:', SRC.indexOf('raydium.launchpad.createLaunchpad')));
check(/associatedOnly:\s*false/.test(call),
  'the launch passes associatedOnly: false, so the quote may live anywhere');

// The SDK really does default it the other way - worth pinning, because if a
// future version flips the default this test stops meaning anything.
const SDK = fs.readFileSync(
  path.join(import.meta.dirname, '..', '..', 'node_modules', '@raydium-io', 'raydium-sdk-v2', 'lib', 'index.js'),
  'utf8',
);
check(/cannot found mintB/.test(SDK),
  'the SDK still throws this exact error, so the guard above is still needed');
check(/associatedOnly:\s*(o|u|i|l)\s*=\s*!0/.test(SDK),
  'and it still defaults associatedOnly to true somewhere');

// --- the wallet state that triggered it --------------------------------------
const accounts = await c.getParsedTokenAccountsByOwner(OWNER, { mint: QUOTE });
if (!accounts.value.length) {
  console.log('SKIP  the wallet no longer holds that quote at all');
} else {
  const ata = PublicKey.findProgramAddressSync(
    [OWNER.toBuffer(), TOKEN_PROGRAM.toBuffer(), QUOTE.toBuffer()], ATA_PROGRAM,
  )[0];
  const held = accounts.value.map((a) => ({
    pubkey: a.pubkey.toBase58(),
    amount: a.account.data.parsed.info.tokenAmount.uiAmountString,
    isAta: a.pubkey.equals(ata),
  }));
  held.forEach((h) => console.log(`   holds ${h.amount} in ${h.pubkey}${h.isAta ? '  (the ATA)' : '  (NOT the ATA)'}`));

  const nonAta = held.filter((h) => !h.isAta && Number(h.amount) > 0);
  const ataExists = !!(await c.getAccountInfo(ata));
  if (nonAta.length && !ataExists) {
    check(true, 'the balance is in a non-associated account and no ATA exists - exactly the failing shape',
      `${nonAta[0].amount} in ${nonAta[0].pubkey.slice(0, 10)}…`);
  } else {
    console.log('SKIP  the wallet now has an ATA for it, so the original shape is gone');
  }
}

console.log('');
process.exit(fails.length ? 1 : 0);
