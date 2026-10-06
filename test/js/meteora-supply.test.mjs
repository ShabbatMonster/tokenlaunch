// Editing the supply on a Meteora DBC launch.
//
// The control already existed and already worked - it was just inside a
// collapsed <details> labelled "bonding-curve parameters (pump.fun defaults)",
// which is a reasonable place for a number nobody changes and the wrong place
// for one somebody wants. So this is mostly about where it lives.
//
// The one real bug behind it: PUMP ECONOMICS wrote 1,000,000,000 into the field
// unconditionally, so a supply you had typed was silently reset by a button
// about pricing. That is the kind of thing you find out after launching a
// billion of something you wanted a million of.
//
// Run: node test/js/meteora-supply.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { launchMeteora } from '../../src/solana.js';
import { healthyRpc } from '../../src/rpc.js';

const root = path.join(import.meta.dirname, '..', '..');
const HTML = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
const MAIN = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- where the field lives ------------------------------------------------------
const solRow = HTML.slice(HTML.indexOf('id="solRow"'), HTML.indexOf('</details>', HTML.indexOf('id="solRow"')));
const adv = HTML.slice(HTML.indexOf('id="solParams"'), HTML.indexOf('</details>', HTML.indexOf('id="solParams"')));
const supplyAt = HTML.indexOf('id="solSupply"');
const advAt = HTML.indexOf('id="solParams"');

check(supplyAt > -1, 'the Meteora row has a TOTAL SUPPLY input');
check(supplyAt < advAt,
  'and it sits above the collapsed advanced block, so it is visible without opening anything',
  `supply@${supplyAt} < details@${advAt}`);
check(!adv.includes('id="solSupply"'),
  'it is no longer buried inside "bonding-curve parameters"');
check((HTML.match(/id="solSupply"/g) || []).length === 1,
  'and there is exactly one of it - a duplicated id would break the reader');
check(solRow.includes('id="solSupplyHint"'), 'with a hint line beneath it');

// --- it reaches the launch ------------------------------------------------------
const reader = MAIN.slice(MAIN.indexOf('function solParamsFromUI'), MAIN.indexOf('\n}', MAIN.indexOf('function solParamsFromUI')));
check(/totalSupply:\s*num\('solSupply'/.test(reader),
  'solParamsFromUI reads the field into totalSupply');
check(/params\b/.test(MAIN.slice(MAIN.indexOf('const res = await launchMeteora('), MAIN.indexOf('const res = await launchMeteora(') + 300)),
  'and those params are what launchMeteora is given');

// --- the button no longer overwrites it -----------------------------------------
const econ = MAIN.slice(MAIN.indexOf('async function applyPumpEconomics'), MAIN.indexOf('\n}', MAIN.indexOf('hint.innerHTML = `<span class="err"')));
check(/supplyIsDefault/.test(econ) && /if \(supplyIsDefault\) supplyEl\.value/.test(econ),
  'PUMP ECONOMICS only fills the supply while it is still the default');
check(/kept your supply of/.test(econ),
  'and says so when it leaves a customised one alone');

// --- the hint is wired ----------------------------------------------------------
check(/function paintSolSupplyHint/.test(MAIN), 'the hint has a painter');
check(/for \(const id of \['solSupply', 'solMigPct'\]\) \$\(id\)\.addEventListener\('input', paintSolSupplyHint\)/.test(MAIN),
  'repainted by both inputs it depends on, not just the supply');
check(/if \(meteora\) paintSolSupplyHint\(\)/.test(MAIN),
  'and painted when the pad opens, so it is never blank on arrival');
check(/not the raise/.test(MAIN),
  'the hint says supply moves the price per token rather than the raise');

// --- and the chain accepts a non-default supply ---------------------------------
//
// A throwaway payer: the point is whether the DBC curve BUILDS for a given
// supply, which happens well before anything is spent.
const RPC = await healthyRpc();
const throwaway = bs58.encode(Buffer.from(Keypair.generate().secretKey));
const build = async (totalSupply) => {
  try {
    await launchMeteora({
      rpcUrl: RPC, secretKey: throwaway, quoteMint: 'So11111111111111111111111111111111111111112',
      name: 'Supply Test', symbol: 'SUP', uri: 'https://example.com/m.json',
      dryRun: true, devBuyQuote: 0,
      params: {
        totalSupply, baseDecimals: 6, feeBps: 100, pctSupplyOnMigration: 20.69,
        migrationThreshold: 85, feeClaimer: 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT',
      },
    });
    return null;
  } catch (e) {
    return (e.message || String(e)).replace(/\s+/g, ' ').slice(0, 100);
  }
};
for (const supply of [1_000_000_000, 21_000_000, 1_000_000_000_000]) {
  const err = await build(supply);
  check(err === null, `a supply of ${supply.toLocaleString()} builds a valid DBC config`, err || 'simulated clean');
}

console.log('');
process.exit(fails.length ? 1 : 0);
