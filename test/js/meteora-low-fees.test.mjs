// The cheapest a Meteora (DBC) launch can be, pinned against the LIVE program.
//
// Two separate fees, with two separate floors:
//   pre-bond   the bonding curve's trading fee          floor 25 bps (0.25%)
//   post-bond  the migrated DAMM v2 pool's fee          floor 10 bps (0.10%)
//
// Below either one the program itself refuses create_config - the curve fee
// with ExceedMaxFeeBps out of the fee scheduler, the pool fee with
// InvalidMigratedPoolFee - so 0.01% is not reachable on either side. Reaching
// 0.10% post-bond needs MigrationFeeOption.Customizable, because the lowest
// fixed option is 0.25%.
//   RPC=https://... node test/js/meteora-low-fees.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { DynamicBondingCurveClient, MigrationFeeOption, MigratedCollectFeeMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { buildLaunchConfigForTest, DBC_MIN_FEE_BPS, DBC_MAX_FEE_BPS, DBC_MIN_MIGRATED_FEE_BPS, DBC_MAX_MIGRATED_FEE_BPS } from '../../src/solana.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');

// --- the floors the pad ships ---------------------------------------------------
check(DBC_MIN_FEE_BPS === 25 && DBC_MAX_FEE_BPS === 9900, 'the pre-bond fee range is 25–9900 bps');
check(DBC_MIN_MIGRATED_FEE_BPS === 10 && DBC_MAX_MIGRATED_FEE_BPS === 1000, 'the post-bond fee range is 10–1000 bps');
check(HTML.includes('id="solMigratedFeeBps"') && HTML.includes('id="solLowFeeBtn"'), 'the pad has a post-bond fee field and a lowest-fees button');
check(/migratedFeeBps: num\('solMigratedFeeBps'/.test(MAIN), 'and feeds it into the launch params');
check(/\$\('solFeeBps'\)\.value = String\(DBC_FEE_LIMITS\.minFee\)/.test(MAIN)
  && /\$\('solMigratedFeeBps'\)\.value = String\(DBC_FEE_LIMITS\.minMigrated\)/.test(MAIN),
  'the lowest-fees button sets both to the floor');

// --- the builder refuses anything the program would --------------------------------
const base = { totalSupply: 1_000_000_000, baseDecimals: 9, pctSupplyOnMigration: 20, migrationThreshold: 85, feeClaimer: 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT' };
const built = (feeBps, migratedFeeBps) => buildLaunchConfigForTest(9, { ...base, feeBps, migratedFeeBps });
for (const [feeBps, migratedFeeBps, why] of [[1, 100, 'a 0.01% pre-bond fee'], [24, 100, 'a 0.24% pre-bond fee'], [25, 1, 'a 0.01% post-bond fee'], [25, 9, 'a 0.09% post-bond fee'], [25, 1001, 'a 10.01% post-bond fee']]) {
  let threw = '';
  try { built(feeBps, migratedFeeBps); } catch (e) { threw = e.message; }
  check(!!threw, `the builder refuses ${why}`, threw.slice(0, 95));
}
{
  const cfg = built(25, 10);
  check(cfg.migratedPoolFee?.poolFeeBps === 10 && cfg.migrationFeeOption === MigrationFeeOption.Customizable
    && cfg.migratedPoolFee.collectFeeMode === MigratedCollectFeeMode.QuoteToken,
    '0.10% post-bond is built through the Customizable option (the fixed ones stop at 0.25%)');
  const fixed = built(25, 100);
  check(fixed.migrationFeeOption === MigrationFeeOption.FixedBps100, 'and a fee matching a fixed option still uses that option', `option ${fixed.migrationFeeOption}`);
  check(String(cfg.poolFees.baseFee.cliffFeeNumerator) === '2500000', 'a 0.25% curve fee is 2,500,000 / 1e9', String(cfg.poolFees.baseFee.cliffFeeNumerator));
}

const RPC = process.env.RPC || process.env.SOL_RPC;
if (!RPC) { console.log('SKIP  set RPC=<url> for the live program checks'); process.exit(fails.length ? 1 : 0); }

// --- and the live program agrees ---------------------------------------------------
const connection = new Connection(RPC, 'confirmed');
const client = new DynamicBondingCurveClient(connection, 'confirmed');
const program = client.partner.program;
const PAYER = new PublicKey('95VJZAzpoB9zGJz3JzUUCEfiPgQW4zZLMFtdm4BZQZ73');   // funded; every call is read-only
const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], program.programId);

/// create_config built straight from the Anchor program, so the SDK's own
/// client-side validation cannot mask what the program does.
// one blockhash for the whole run; simulation replaces it anyway, and asking
// per call trips the RPC's rate limit
const { blockhash } = await connection.getLatestBlockhash('confirmed');
async function programTakes(params) {
  const config = Keypair.generate();
  const ix = await program.methods.createConfig(params).accountsPartial({
    config: config.publicKey, feeClaimer: PAYER, leftoverReceiver: PAYER, quoteMint: SOL, payer: PAYER,
    systemProgram: SystemProgram.programId, eventAuthority, program: program.programId,
  }).instruction();
  const tx = new Transaction().add(ix);
  tx.feePayer = PAYER;
  tx.recentBlockhash = blockhash;
  const sim = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
  const log = (sim.value.logs || []).find((l) => /Error Code/.test(l)) || '';
  return { ok: !sim.value.err, why: (log.match(/Error Code: (\w+)/) || [, JSON.stringify(sim.value.err)])[1] };
}

const floor = built(DBC_MIN_FEE_BPS, DBC_MIN_MIGRATED_FEE_BPS);
const bend = (mutate) => { const p = built(DBC_MIN_FEE_BPS, DBC_MIN_MIGRATED_FEE_BPS); mutate(p); return p; };

{
  const r = await programTakes(floor);
  check(r.ok, 'the program accepts the floor pair: 0.25% pre-bond + 0.10% post-bond', r.why);
}
for (const bps of [1, 10, 24]) {
  const r = await programTakes(bend((p) => { p.poolFees.baseFee.cliffFeeNumerator = new BN(bps).muln(100_000); }));
  check(!r.ok, `the program rejects a ${bps / 100}% pre-bond fee`, r.why);
}
for (const bps of [1, 9]) {
  const r = await programTakes(bend((p) => { p.migratedPoolFee.poolFeeBps = bps; }));
  check(!r.ok, `the program rejects a ${bps / 100}% post-bond fee — so 0.01% after migration is not possible`, r.why);
}
{
  const r = await programTakes(built(DBC_MIN_FEE_BPS, 100));
  check(r.ok, 'and the old 1% post-bond default still launches', r.why);
}
console.log('');
process.exit(fails.length ? 1 : 0);
