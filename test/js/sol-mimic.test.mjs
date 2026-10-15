// Solana Mimic: the same curve as a coin you can see, on LaunchLab or DBC.
//
// Every launch here is a DRY RUN, simulated as a large public wallet (a
// Binance hot wallet - an address, not a key; nothing is signed by it), so the
// programs give their real verdict without anything being sent.
//
//   LaunchLab  StonkFun's ordinary platform (Token-2022 coin, rule-pinned
//              curve), bonk.fun (classic coin vs a classic quote), raydium.io
//              (classic coin vs NVDAx, a Token-2022 quote - the case that broke
//              when every token-program slot was rewritten), and StonkFun's
//              community coin, which only simulates while a window is open
//   DBC        an SPL coin vs a pump.fun quote, a Token-2022 coin, a bags.fm
//              coin - each cloned (the config the program would write must
//              match theirs in every curve and fee field) and reused (a pool
//              on their config, simulated for real)
//
// Run: node test/js/sol-mimic.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { SOL_RPC } from '../../src/rpc.js';
import { inspectSolCoin, launchRaydium, launchMeteora, diffPoolConfigs, configParamsFromPoolConfig } from '../../src/solana.js';

const RICH = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const throwaway = bs58.encode(Keypair.generate().secretKey);
const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};
const META = { name: 'Mimic Test', symbol: 'MIMT', uri: 'https://ipfs.io/ipfs/bafkreimimictestmimictestmimictestmimictestmimictest' };

// --- LaunchLab ---------------------------------------------------------------------------
async function launchlab(mint, label, { platformId } = {}) {
  const r = await inspectSolCoin(SOL_RPC, mint);
  check(r.kind === 'launchlab', `${label}: read as a LaunchLab coin`, `${r.name} / ${r.symbol}, quote ${r.quoteSymbol}, platform ${r.platformName || r.platformId}`);
  if (r.kind !== 'launchlab') return null;
  const d = await launchRaydium({
    rpcUrl: SOL_RPC, dryRun: true, ownerPubkey: RICH, ...META, quoteMint: r.quoteMint, buyAmountUi: '0',
    migrateType: r.migrateType, platformId: platformId || r.platformId, token2022: r.token2022,
    ...(r.token2022 && r.transferFeeBps ? { transferFeeBps: r.transferFeeBps, maxTransferFee: r.maxTransferFee } : {}),
    curve: r.curve, decimals: r.curve.decimals, creatorFeeOn: r.creatorFeeOn,
  }).catch((e) => ({ thrown: e.message }));
  return { r, d };
}

for (const [mint, label] of [
  ['9bHxUoXsy6qoV4o9z5joMYoPts7bqR3mPokRw66dHHaU', 'StonkFun'],
  ['ErCiVpFvrmwHskgrkS536hfS2v1UEZAqRhxun9JQLi1Z', 'bonk.fun'],
  ['7hWtUpMNCA7VgdEYjgnTvti8HZgAQARyYTACayo5FLr4', 'raydium.io vs NVDAx'],
]) {
  const x = await launchlab(mint, label);
  if (!x) continue;
  const { r, d } = x;
  check(!d.thrown && d.ok, `${label}: a new coin on the same curve, platform and quote simulates clean`, d.thrown || d.anchorError || '');
  if (d.curve) {
    const same = ['supply', 'totalSellA', 'totalFundRaisingB'].every((k) => d.curve[k] === r.curve[k]) && d.curve.decimals === r.curve.decimals
      && d.curve.migrateType === r.migrateType && d.curve.quoteMint === r.quoteMint && d.curve.token2022 === r.token2022;
    check(same, `${label}: and the curve it launches is theirs exactly`, `raise ${d.curve.totalFundRaisingB}, ${d.curve.totalSellA} on the curve, ${d.curve.decimals} dp`);
  }
}
// the same bonk.fun curve under raydium.io's platform instead
{
  const x = await launchlab('ErCiVpFvrmwHskgrkS536hfS2v1UEZAqRhxun9JQLi1Z', 'bonk.fun -> raydium.io', { platformId: '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4' });
  check(x && !x.d.thrown && x.d.ok && x.d.platformId === '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4', 'a bonk.fun curve also launches under raydium.io\'s platform', x?.d?.thrown || x?.d?.anchorError || '');
}
// StonkFun's community coin: only possible while their window for the pairing is open
{
  const x = await launchlab('8svf3G1X4mnAX3Xm71jFXgiHydbvc5XKQKicbnokRUky', 'StonkFun CC');
  if (x) {
    const open = !x.d.thrown && x.d.ok;
    const closedHonestly = !!x.d.thrown && /allow window|window open/i.test(x.d.thrown);
    check(open || closedHonestly, 'the CC coin\'s curve simulates while its window is open, or is refused with the window named',
      open ? 'window open now' : x.d.thrown?.slice(0, 80));
  }
}

// --- DBC ---------------------------------------------------------------------------------
for (const [mint, label] of [
  ['6ANt9RWB8t2K7vgVtoWHdmRgdoGfLymMdkyFhstxvALz', 'SPL coin vs a pump.fun quote'],
  ['6G3JsxAAjBwQT2gqAUT7ijYm9NZs8fkbkAGSy1mgnCRV', 'Token-2022 coin'],
  ['4rRkeKx9qDwrebNeRy9Nmf5cATTPYoG9DXpRpH5ABAGS', 'bags.fm coin'],
]) {
  const r = await inspectSolCoin(SOL_RPC, mint);
  check(r.kind === 'dbc', `DBC ${label}: read as a DBC coin`, `${r.name} / ${r.symbol}, quote ${r.quoteSymbol}, ${r.summary?.curvePoints}-point curve`);
  if (r.kind !== 'dbc') continue;
  const base = { rpcUrl: SOL_RPC, secretKey: throwaway, dryRun: true, simulateAs: RICH, ...META, quoteMint: r.quoteMint, params: null, baseToken2022: r.baseToken2022 };
  const clone = await launchMeteora({ ...base, configParams: r.configParams }).catch((e) => ({ thrown: e.message }));
  check(!clone.thrown && !clone.simulationError, `DBC ${label}: cloning their config simulates clean`, clone.thrown || clone.simulationError || '');
  const diff = clone.createdConfig ? diffPoolConfigs(clone.createdConfig, r.poolConfig) : null;
  check(diff && diff.length === 0, `DBC ${label}: and the config it would write matches theirs in every curve and fee field`, diff ? (diff.join(', ') || 'identical') : 'no config read back');
  check(clone.createdConfig && clone.createdConfig.feeClaimer.toBase58() === RICH, `DBC ${label}: with the fees claimable by the launcher, not them`);
  const reuse = await launchMeteora({ ...base, reuseConfig: r.config }).catch((e) => ({ thrown: e.message }));
  check(!reuse.thrown && !reuse.simulationError, `DBC ${label}: a pool on their own config simulates clean`, reuse.thrown || reuse.simulationError || '');
}

// --- the translation itself ----------------------------------------------------------------
{
  const r = await inspectSolCoin(SOL_RPC, '6ANt9RWB8t2K7vgVtoWHdmRgdoGfLymMdkyFhstxvALz');
  const p = configParamsFromPoolConfig(r.poolConfig);
  check(p.curve.length === r.summary.curvePoints && p.tokenSupply && p.poolFees.dynamicFee, 'config params carry the non-empty curve points, the fixed supply and the dynamic fee');
  const none = await inspectSolCoin(SOL_RPC, 'EJUe9f9buQVzEFu2YwBorVzY63mEf4BLoJTLJxsfpump');
  check(none.kind === null && /pump\.fun pad/.test(none.reason), 'a pump.fun coin is pointed at the pump.fun pad instead', none.reason);
}

// --- the pad ---------------------------------------------------------------------------------
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'index.html'), 'utf8');
check(/id: 'mimic-sol'[^}]*family: 'solmimic'/.test(MAIN), 'the app lists a Mimic · Solana pad');
check(/if \(pad\.family === 'solmimic'\) \{\s*await launchSolMimic/.test(MAIN), 'launching on it goes through launchSolMimic');
check(['smToken', 'smLoad', 'smSummary', 'smPlatform', 'smDevBuy', 'smDbcMode', 'smSim'].every((id) => HTML.includes(`id="${id}"`)),
  'with a mint field, LOAD, the curve summary, a platform choice, a dev buy, clone/reuse and SIMULATE');
check(/<option value="clone">[^<]*<\/option>\s*<option value="reuse">/.test(HTML), 'clone (your fees) is the default over reuse');

console.log('');
process.exit(fails.length ? 1 : 0);
