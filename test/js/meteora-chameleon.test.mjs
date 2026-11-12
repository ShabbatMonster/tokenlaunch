// Chameleon: a Meteora DBC coin whose name, ticker and picture can be changed
// after launch (the idea from the chamelequote repo, Totality).
//
// A DBC config's token_update_authority decides who owns the coin's metadata.
// The pad normally writes Immutable (1). Chameleon writes CreatorUpdateAuthority
// (0), and the program then makes the pool's creator - the launch wallet - the
// metadata's update authority and leaves it mutable. Checked live 2026-11-11 on
// four coins from such configs (two SPL, two Token-2022): update authority =
// pool creator every time, never the config's fee claimer.
//
// The rename itself is simulated as the real update authority of live coins
// (sigVerify off), and the written metadata account is read back.
//   node test/js/meteora-chameleon.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { launchMeteora, inspectSolCoin, readSolTokenMetadata, renameSolToken } from '../../src/solana.js';
import { SOL_RPC } from '../../src/rpc.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the pad ------------------------------------------------------------------------
check(['solChameleon', 'solChamHint', 'chamPanel', 'chamMint', 'chamLoadBtn', 'chamName', 'chamSymbol', 'chamImage', 'chamRenameBtn', 'chamStatus']
  .every((id) => HTML.includes(`id="${id}"`)), 'UI: the DBC pad has the CHAMELEON switch and a rename panel');
check(/chameleon: \$\('solChameleon'\)\.checked/.test(MAIN), 'UI: the switch reaches the launch parameters');
check(/S\.renameSolToken\(/.test(MAIN) && /\.\.\.\(old \|\| \{\}\), name, symbol, image/.test(MAIN),
  'UI: a rename re-uploads the metadata JSON with the old fields kept');

// --- the config it writes -----------------------------------------------------------
const RICH = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const throwaway = bs58.encode(Keypair.generate().secretKey);
const params = (o) => ({
  totalSupply: 1_000_000_000, baseDecimals: 9, feeBps: 100, migratedFeeBps: 100,
  pctSupplyOnMigration: 20, migrationThreshold: 85,
  feeClaimer: 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT', baseToken2022: false, ...o,
});
const launch = (p) => launchMeteora({
  rpcUrl: SOL_RPC, secretKey: throwaway, dryRun: true, simulateAs: RICH,
  quoteMint: 'So11111111111111111111111111111111111111112',
  uri: 'https://ipfs.io/ipfs/bafkreitest', devBuyQuote: 0, name: 'Chameleon', symbol: 'CHAM', params: params(p),
}).catch((e) => ({ thrown: e.message }));
for (const t22 of [false, true]) {
  const std = t22 ? 'Token-2022' : 'SPL';
  const on = await launch({ chameleon: true, baseToken2022: t22 });
  check(!on.thrown && !on.simulationError && Number(on.createdConfig?.tokenUpdateAuthority) === 0,
    `${std} chameleon launch: the config is accepted and says CreatorUpdateAuthority (0)`,
    on.thrown || on.simulationError || `tokenUpdateAuthority ${on.createdConfig?.tokenUpdateAuthority}`);
  await sleep(600);
  const off = await launch({ baseToken2022: t22 });
  check(!off.thrown && !off.simulationError && Number(off.createdConfig?.tokenUpdateAuthority) === 1,
    `${std} launch without it: Immutable (1), as before`, off.thrown || off.simulationError || `tokenUpdateAuthority ${off.createdConfig?.tokenUpdateAuthority}`);
  check(Number(on.createdConfig?.tokenType) === (t22 ? 1 : 0), `${std}: and the token standard is unchanged by it`);
  await sleep(600);
}

// --- live coins from CreatorUpdateAuthority configs ----------------------------------
const COINS = [
  { mint: 'EcFEvJCBJBvLdB7yMj5FyFVhNBkceTNEfaGeodzRSJeL', std: 'spl' },
  { mint: 'F1ZAMQgVn4sdEbFv8Fjtn323iXuFsedn95vP2WM5BAGS', std: 'spl' },
  { mint: 'EkUWBPgZtSsmcgrpfemPT4STuNSztjaiVdNHdUEvBLNK', std: 'token-2022' },
];
for (const c of COINS) {
  const coin = await inspectSolCoin(SOL_RPC, c.mint).catch(() => null);
  const m = await readSolTokenMetadata(SOL_RPC, c.mint).catch(() => null);
  if (!coin || !m) { console.log('SKIP  could not read ' + c.mint); continue; }
  check(m.standard === c.std && m.mutable && m.updateAuthority === coin.creator,
    `${c.std}: on a CreatorUpdateAuthority config the pool creator is the update authority`,
    `${c.mint.slice(0, 6)}… creator ${coin.creator.slice(0, 6)}… UA ${String(m.updateAuthority).slice(0, 6)}… fee claimer ${coin.feeClaimer.slice(0, 6)}…`);
  await sleep(500);
  const r = await renameSolToken({
    rpcUrl: SOL_RPC, mint: c.mint, name: 'Renamed Coin', symbol: 'RNMD', uri: 'https://ipfs.io/ipfs/bafkreinewone',
    dryRun: true, simulateAs: m.updateAuthority,
  }).catch((e) => ({ thrown: e.message }));
  const w = r.written;
  check(!r.thrown && !r.simulationError && w?.name === 'Renamed Coin' && w?.symbol === 'RNMD' && w?.uri === 'https://ipfs.io/ipfs/bafkreinewone'
    && w?.updateAuthority === m.updateAuthority && w?.mutable,
    `${c.std}: its update authority renames it in one transaction, and the account reads back the new name, ticker and URI`,
    r.thrown || r.simulationError || `${m.name} → ${w?.name} ($${w?.symbol})`);
  if (c.std === 'spl' && w) {
    check(w.sellerFeeBasisPoints === m.sellerFeeBasisPoints && JSON.stringify(w.creators) === JSON.stringify(m.creators),
      'spl: everything else in the Metaplex data is carried over untouched');
  }
  await sleep(500);
  const stranger = await renameSolToken({ rpcUrl: SOL_RPC, mint: c.mint, name: 'X', dryRun: true, simulateAs: RICH }).then(() => 'taken', (e) => e.message);
  check(/^only .* can rename this coin/.test(stranger), `${c.std}: any other wallet is refused before signing, by name`, stranger.slice(0, 80));
  await sleep(500);
}

// a Token-2022 rename that grows the mint pays the extra rent in the same transaction
{
  const c = COINS[2];
  const m = await readSolTokenMetadata(SOL_RPC, c.mint).catch(() => null);
  if (m) {
    const long = 'A Chameleon Coin With A Much Longer Name Than Before';
    const r = await renameSolToken({ rpcUrl: SOL_RPC, mint: c.mint, name: long, symbol: 'LONGERTICKER', dryRun: true, simulateAs: m.updateAuthority })
      .catch((e) => ({ thrown: e.message }));
    check(!r.thrown && !r.simulationError && r.written?.name === long && r.written?.uri === m.uri,
      'token-2022: a longer name tops the mint\'s rent up and leaves the URI alone', r.thrown || r.simulationError || `${long.length}-byte name`);
  }
}

// Metaplex's caps still hold for an SPL coin
{
  const m = await readSolTokenMetadata(SOL_RPC, COINS[0].mint).catch(() => null);
  if (m) {
    const r = await renameSolToken({ rpcUrl: SOL_RPC, mint: COINS[0].mint, name: 'a'.repeat(33), dryRun: true, simulateAs: m.updateAuthority }).then(() => 'taken', (e) => e.message);
    check(/33 bytes and a Metaplex metadata account holds 32/.test(r), 'spl: a 33-byte name is refused with the cap, before anything is sent', r.slice(0, 80));
  }
}

// an immutable coin cannot be renamed by anyone
{
  const mint = 'EhaPbQhUErf8L1o5KuGfQ311z8JiDwkdCbzg2VjK29bU';   // Table Coin, on an Immutable DBC config
  const m = await readSolTokenMetadata(SOL_RPC, mint).catch(() => null);
  if (m && !m.mutable) {
    const r = await renameSolToken({ rpcUrl: SOL_RPC, mint, name: 'X', dryRun: true, simulateAs: RICH }).then(() => 'taken', (e) => e.message);
    check(/immutable/.test(r), 'a coin launched immutable is refused, saying it was not a chameleon', r.slice(0, 80));
  } else console.log('SKIP  reference immutable coin is not immutable: ' + JSON.stringify(m && { mutable: m.mutable, ua: m.updateAuthority }));
}

console.log('');
process.exit(fails.length ? 1 : 0);
