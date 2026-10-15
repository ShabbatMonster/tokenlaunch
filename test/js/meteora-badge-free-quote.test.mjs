// Meteora DBC and Token-2022 quotes that need no badge.
//
// The badge is a gate on dangerous Token-2022 extensions, not on Token-2022
// itself. A metadata-only mint - every pump.fun coin - is accepted bare, which
// is how 6ANt9RWB… launched on 2026-10-15 paired against LPEPE (Dn5wmTV2…pump):
// its config was created with an 8-account create_config and its pool with a
// 16-account init, no badge anywhere, and LPEPE has none.
//
// This used to be refused before it reached the program: the launcher treated
// every Token-2022 quote as needing a badge. Here a dry run goes all the way to
// Meteora's simulation for both kinds of quote, and the shape of the
// instructions is checked against the live launch.
//
// Run: node test/js/meteora-badge-free-quote.test.mjs

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { launchMeteora, meteoraQuoteAllowed, meteoraTokenBadge, DBC_BADGE_FREE_EXTENSIONS } from '../../src/solana.js';
import { healthyRpc } from '../../src/rpc.js';

const RPC = await healthyRpc({ scanning: true });
const LPEPE = 'Dn5wmTV2Zi1aLbrh1VbvSBEqeGvve6Eqgu7hHupxpump';
const JACKPOT = 'BhycXzE7aCCAqcefbyy6b2nw8ryJqBBFXpW6hVsJRkEf';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

check(DBC_BADGE_FREE_EXTENSIONS.size === 2 && DBC_BADGE_FREE_EXTENSIONS.has('metadataPointer') && DBC_BADGE_FREE_EXTENSIONS.has('tokenMetadata'),
  'the badge-free set is exactly the metadata pair - only what was proven');

// --- the gate no longer refuses a pump coin ---------------------------------------
const g = await meteoraQuoteAllowed(RPC, LPEPE);
check(g.isToken2022 && g.allowed, 'a pump-coin quote passes the pre-launch check', g.note);
check(!g.badgeExists && !g.needsBadge, 'with no badge, because it has only metadata extensions', g.extensions.join(', '));
const j = await meteoraQuoteAllowed(RPC, JACKPOT);
check(j.isToken2022 && j.needsBadge && !j.badgeExists && j.likelyRefused,
  'a transfer-hook quote is flagged as likely refused, not silently passed', j.note);

// --- dry runs, all the way to Meteora's simulation ----------------------------------
//
// Simulated AS a funded wallet. A fresh test key has no SOL, so its simulation
// stops at AccountNotFound before Meteora's checks run - which would make "no
// InvalidTokenBadge" pass without the program ever having been asked.
const { Connection, PublicKey } = await import('@solana/web3.js');
const conn = new Connection(RPC, 'confirmed');
let funded = null;
for (const cand of ['JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT', '9eCkkWFSpcFvNi3q48t7YW6NHtoNp52PpdgB9u5eCTc', 'TNWDmGKpDrjbceA7k1n7pVJ9FaFJUPKGznPt35bgsD1']) {
  if (await conn.getBalance(new PublicKey(cand)).catch(() => 0) > 0.05e9) { funded = cand; break; }
}
check(!!funded, 'a funded wallet is available to simulate as', funded || 'none had 0.05 SOL');
const dry = async (quoteMint) => {
  const kp = Keypair.generate();
  return launchMeteora({
    rpcUrl: RPC, secretKey: bs58.encode(kp.secretKey), quoteMint,
    name: 'Badge Free', symbol: 'BFREE', uri: 'https://example.com/m.json',
    params: { feeClaimer: kp.publicKey.toBase58(), baseDecimals: 9, totalSupply: 1_000_000_000, feeBps: 100, migrationThreshold: 1000000, pctSupplyOnMigration: 20.69 },
    dryRun: true, simulateAs: funded,
  });
};
const p = await dry(LPEPE);
const badge = meteoraTokenBadge(LPEPE).toBase58();
check(p.createConfigAccounts.length === 8 && !p.createConfigAccounts.includes(badge),
  'create_config carries the 8 declared accounts and no badge - as the live config did', `${p.createConfigAccounts.length} accounts`);
check(p.createPoolAccounts.length === 16 && !p.createPoolAccounts.includes(badge),
  'the pool init carries 16 accounts and no badge - as the live pool init did', `${p.createPoolAccounts.length} accounts`);
check(!p.simulationError && !p.logs.join(' ').includes('InvalidTokenBadge'),
  'and Meteora accepts the config: the simulation runs clean', p.simulationError ? `sim: ${JSON.stringify(p.simulationError).slice(0, 100)}` : 'clean');

const k = await dry(JACKPOT);
check(k.logs.join(' ').includes('InvalidTokenBadge') || /6080/.test(JSON.stringify(k.simulationError ?? '')),
  'a transfer-hook quote without a badge is still refused by Meteora itself', String(k.simulationError ?? '').slice(0, 80));

console.log('');
process.exit(fails.length ? 1 : 0);
