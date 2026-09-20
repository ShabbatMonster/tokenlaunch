// Regression test for Meteora DBC token badges.
//
// DBC will not take a Token-2022 quote mint unless Meteora has badged it, and
// the badge must be handed to create_config as a trailing account. It appears
// in neither the SDK's bundled IDL nor the IDL the deployed program publishes
// on-chain - both are behind the live program - so the SDK builds an 8-account
// create_config and the program answers InvalidTokenBadge (6080 / 0x17c0).
//
// Both shapes were read off real successful launches with an xStock quote:
// create_config carries nine accounts (5kxJcEvYpWVcLZZ8iyprXFkp...) and
// initialize_virtual_pool_with_spl_token carries seventeen
// (3Di3sA4EVXPEuVEgmNVKF1...), the badge last in each.
//
// Run: node test/js/meteora-token-badge.test.mjs

import { launchMeteora } from '../../src/solana.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
const RPC = 'https://api.mainnet-beta.solana.com';
const kp = Keypair.generate();
const r = await launchMeteora({
  rpcUrl: RPC, secretKey: bs58.encode(kp.secretKey),
  quoteMint: 'FLWSojG1gB5VStYR3Sb4nQFRt43UBYkqih1j2CpVLqgd',
  name: 'Tulip Coin', symbol: 'TULIP', uri: 'https://example.com/m.json',
  params: {
    feeClaimer: kp.publicKey.toBase58(), baseDecimals: 6, totalSupply: 1_000_000_000,
    feeBps: 100, migrationThreshold: 1133.75, pctSupplyOnMigration: 20.69,
  },
  dryRun: true,
  onStatus: (m) => console.log('  ' + m),
});
console.log('\nquote token program:', r.quoteProgram);
console.log('token badge        :', r.tokenBadge);
console.log('create_config has  :', r.createConfigAccounts.length, 'accounts');
r.createConfigAccounts.forEach((a, i) => console.log('  ' + String(i).padStart(2), a, i === 8 ? '  <=== TOKEN BADGE' : ''));
console.log('\nsimulation error   :', r.simulationError ?? 'none');
const badge = r.logs.filter((l) => /TokenBadge|InvalidTokenBadge|6080/.test(l));
console.log('badge complaints   :', badge.length ? badge.join(' | ') : 'none');
console.log((r.logs.join(' ').includes('InvalidTokenBadge')) ? '\nSTILL REJECTED' : '\nno InvalidTokenBadge - the quote is accepted now');


const configOk = r.createConfigAccounts.length === 9 && r.createConfigAccounts[8] === r.tokenBadge;
console.log((configOk ? 'PASS' : 'FAIL') + '  create_config: nine accounts, badge last');

// The pool instruction needs it too. Getting this wrong let a launch clear
// create_config and then die on the second transaction with the same 0x17c0,
// which is exactly what happened in the wild.
const poolOk = r.createPoolAccounts.length === 17 && r.createPoolAccounts[16] === r.tokenBadge;
console.log((poolOk ? 'PASS' : 'FAIL') + '  create_pool:   seventeen accounts, badge last');

process.exit(configOk && poolOk ? 0 : 1);
