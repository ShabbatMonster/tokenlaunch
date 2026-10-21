// A pump.fun dev buy pays into creator_vault, seeded by the creator the CURVE
// records - the payer, the "creator fee recipient" address when one is set,
// or (fees to holders) a per-mint address pump derives itself. Seeding it by
// the payer every time failed the dev buy with ConstraintSeeds (2006) on
// creator_vault for the last two (2026-10-21). Read-only simulations.
//   RPC=https://... node test/js/pump-dev-buy-creator.test.mjs
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { buildPumpLaunch, pumpStatus } from '../../src/pump.js';
const RPC = process.env.RPC || process.env.SOL_RPC;
const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
if (!RPC) { console.log('SKIP  set RPC=<url>'); process.exit(0); }

const conn = new Connection(RPC, 'confirmed');
const g = await pumpStatus(RPC);
// any funded wallet works as the simulated payer; this one is active on chain
const payer = { publicKey: new PublicKey('4xY9T1Q7foJzJsJ6YZDSsfp9zkzeZsXnxd45SixduMmr') };
const other = Keypair.generate().publicKey.toBase58();
for (const [label, o] of [
  ['your own wallet', {}],
  ['a creator fee recipient address', { creatorAddress: other }],
  ['fees to holders', { feesToHolders: true }],
  ['fees to holders + a creator address', { creatorAddress: other, feesToHolders: true }],
]) {
  const tx = await buildPumpLaunch({ connection: conn, payer, mint: Keypair.generate(), name: 'Dev buy test', symbol: 'DBT', uri: 'https://example.com/m.json', devBuySol: '0.01', global: g, ...o });
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  const why = (sim.value.logs || []).find((l) => /Error Code|caused by/.test(l)) || '';
  check(!sim.value.err, `a launch with a dev buy simulates clean: ${label}`, sim.value.err ? JSON.stringify(sim.value.err) + ' ' + why : `${sim.value.unitsConsumed} CU`);
}
console.log('');
process.exit(fails.length ? 1 : 0);
