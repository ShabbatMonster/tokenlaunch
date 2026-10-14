// A Meteora curve that opens like pump and raises far more before migrating.
//
// JACKPOT (BhycXzE7aCCAqcefbyy6b2nw8ryJqBBFXpW6hVsJRkEf) opens at a ~46 SOL
// market cap and does not migrate until 21,408 SOL is in, at a ~10M SOL
// migration cap. It does that by selling 99.81% of its supply on the curve and
// seeding the pool with 0.19%, which keeps the early curve as deep as pump's
// while letting it run almost indefinitely.
//
// The economics editor refused that shape: it computed the % on migration with
// a linear rule that was only exact at pump's 30/85, and enforced a 3.17%-49.84%
// band measured at 6 decimals. The only way to ask for a big raise was to raise
// the START with it - a 46,000 SOL open for an 850k raise - which is the
// "destroying the liquidity" part. Neither the rule nor the band was real.
//
// Run: node test/js/meteora-deep-curve.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { pumpEconomics, meteoraBaseDecimals } from '../../src/solana.js';
import { healthyRpc } from '../../src/rpc.js';

const RPC = await healthyRpc({ scanning: true });
const SOL = 'So11111111111111111111111111111111111111112';
const JACKPOT = 'BhycXzE7aCCAqcefbyy6b2nw8ryJqBBFXpW6hVsJRkEf';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};
const econ = (s, m, extra = {}) =>
  pumpEconomics(RPC, SOL, { startSolEquivalent: s, migrateSolEquivalent: m, ...extra });
const near = (a, b, tol) => Math.abs(a - b) / b <= tol;

// --- the live coin this is modelled on ---------------------------------------
const client = new DynamicBondingCurveClient(new Connection(RPC, 'confirmed'), 'confirmed');
const pool = await client.state.getPoolByBaseMint(new PublicKey(JACKPOT));
const cfg = await client.state.getPoolConfig(pool.account.poolState.config);
const raise = Number(cfg.migrationQuoteThreshold.toString()) / 1e9;
const pctLive = Number(cfg.migrationBaseThreshold.toString()) / Number(cfg.preMigrationTokenSupply.toString()) * 100;
check(near(raise, 21408, 0.001), 'JACKPOT raises ~21,408 SOL before migrating', raise.toFixed(2));
check(pctLive < 0.25, 'by seeding its pool with under 0.25% of supply', pctLive.toFixed(4) + '%');
check(cfg.tokenDecimal === 9, 'at 9 decimals', String(cfg.tokenDecimal));

// --- pump's default is unchanged ------------------------------------------------
const d = await econ(30, 85);
check(near(d.pctSupplyOnMigration, 20.69, 0.001), '30/85 still lands on 20.69%', String(d.pctSupplyOnMigration));
check(near(d.openingMarketCap, 27.96, 0.002), 'and opens at a 27.96 SOL cap, as pump does', String(d.openingMarketCap));

// --- the JACKPOT shape is now reachable -----------------------------------------
const j = await econ(49.4, 21408);
check(near(j.openingMarketCap, 46.04, 0.01), "JACKPOT's open reproduces", String(j.openingMarketCap));
check(near(j.migrationMarketCap, 1e7, 0.01), 'and so does its ~10M SOL migration cap', String(j.migrationMarketCap));
const k = await econ(30, 21408);
check(k.pctSupplyOnMigration < 0.2 && near(k.openingMarketCap, 27.96, 0.01),
  'a 21,408 SOL raise from a pump-like 30 open builds, at well under the old 3.17% floor',
  `${k.pctSupplyOnMigration}%`);
const big = await econ(30, 97000);
check(near(big.openingMarketCap, 27.96, 0.01), 'and so does 97,000 SOL from the same open', `${big.pctSupplyOnMigration}%`);

// --- the real ceiling is Meteora's, and it is named --------------------------------
let refused = null;
try { await econ(30, 850000); } catch (e) { refused = e.message; }
check(!!refused && /Meteora will not build/.test(refused),
  "850,000 SOL is refused - by the SDK's own check, reported as such", (refused || 'built').slice(0, 90));

// --- decimals --------------------------------------------------------------------
check(meteoraBaseDecimals(1e9) === 9, 'a 1B supply launches at 9 decimals');
check(meteoraBaseDecimals(18e9) === 9, 'up to ~18.4B still fits a u64 at 9');
check(meteoraBaseDecimals(100e9) === 6, 'and a 100B supply falls back to 6 instead of overflowing');
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
check(!/baseDecimals: 6,/.test(MAIN), 'the launch no longer hardcodes 6 decimals');
const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'solana.js'), 'utf8');
check(!/const PCT_MIN = 3\.174/.test(SRC), 'and the measured-at-6-decimals band is gone');

console.log('');
process.exit(fails.length ? 1 : 0);
