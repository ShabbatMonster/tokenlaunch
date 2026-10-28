// How long a Meteora (DBC) coin's name, ticker and URI may be.
//
// A classic SPL launch writes its metadata through Metaplex, and that program
// caps the fields in its own code — name 32 bytes, symbol 10, uri 200 — so a
// longer one fails the whole launch with "Name too long" / custom program error
// 0xb out of metaqbxx…. Nothing on Meteora's side or ours sets those numbers,
// and nothing can raise them.
//
// Pinned against the live program on 2026-10-28 by simulating a pool on an
// existing config: 32/10/200 bytes simulate clean, 33/11/201 return
// "Name too long" / "Symbol too long" / "URI too long", and 8 rocket emoji (32
// bytes, 8 characters) pass where 9 (36 bytes) do not — the cap is bytes.
//
// A Token-2022 base keeps its metadata on the mint instead, and the program sets
// no cap at all: the same path took a 240-byte name and a 32-byte ticker. The
// only ceiling left is the 1232-byte transaction the fields ride in, which a
// 400-byte URI does blow. So the pad mints Token-2022 whenever the fields do not
// fit Metaplex, rather than refusing them.
//   node test/js/meteora-name-length.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { launchMeteora, inspectSolCoin, METAPLEX_METADATA_MAX, metaplexMetadataOverflow } from '../../src/solana.js';
import { SOL_RPC } from '../../src/rpc.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the caps, as the program holds them ------------------------------------------
check(METAPLEX_METADATA_MAX.name === 32 && METAPLEX_METADATA_MAX.symbol === 10 && METAPLEX_METADATA_MAX.uri === 200,
  'the Metaplex caps are carried as 32 / 10 / 200 bytes');
check(metaplexMetadataOverflow({ name: 'a'.repeat(32), symbol: 'b'.repeat(10), uri: 'c'.repeat(200) }).length === 0,
  'a name, ticker and URI exactly at the caps are fine');
{
  const over = metaplexMetadataOverflow({ name: 'a'.repeat(33), symbol: 'b'.repeat(11), uri: 'c'.repeat(201) });
  check(over.length === 3, 'one byte over on each is three overflows', over.map((o) => `${o.field} ${o.bytes}>${o.max}`).join(', '));
}
{
  // the program measures the UTF-8 string, so characters are the wrong unit
  const eight = metaplexMetadataOverflow({ name: '🚀'.repeat(8) });
  const nine = metaplexMetadataOverflow({ name: '🚀'.repeat(9) });
  check(eight.length === 0 && nine.length === 1, 'the cap is on bytes, not characters: 8 emoji fit, 9 do not',
    `9 emoji = ${nine[0]?.bytes} bytes / ${nine[0]?.chars} chars`);
}

// --- the pad picks the standard that can carry them -------------------------------
check(HTML.includes('id="solToken2022"') && HTML.includes('id="solStdHint"'),
  'the pad has a Token-2022 option and says which standard it will mint');
check(/baseToken2022: \$\('solToken2022'\)\.checked \|\| solNeedsToken2022\(\)/.test(MAIN),
  'and switches to it on its own when the name or ticker will not fit Metaplex');
check(/function paintSolTokenStd/.test(MAIN) && /Metaplex holds/.test(MAIN),
  'the hint names the field and the byte count rather than waiting for the revert');
check(/for \(const id of \['name', 'symbol'\]\) \$\(id\)\.addEventListener\('input'/.test(MAIN),
  'repainted as the name is typed');
check(/minted as Token-2022, with its metadata on the mint/.test(MAIN),
  'and the launch says so afterwards, since it changes the token standard');

// --- our own builder refuses what the program would, in words ----------------------
const RICH = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const throwaway = bs58.encode(Keypair.generate().secretKey);
const params = (baseToken2022) => ({
  totalSupply: 1_000_000_000, baseDecimals: 9, feeBps: 100, migratedFeeBps: 100,
  pctSupplyOnMigration: 20, migrationThreshold: 85,
  feeClaimer: 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT', baseToken2022,
});
const launch = (o) => launchMeteora({
  rpcUrl: SOL_RPC, secretKey: throwaway, dryRun: true, simulateAs: RICH,
  quoteMint: 'So11111111111111111111111111111111111111112',
  uri: 'https://ipfs.io/ipfs/bafkreitest', devBuyQuote: 0, name: 'Name', symbol: 'SYM',
  params: params(false), ...o,
}).catch((e) => ({ thrown: e.message }));

const LONG = 'A Very Long Token Name That Metaplex Would Never Hold';   // 53 bytes
{
  const r = await launch({ name: LONG });
  check(/is 53 bytes and a Metaplex metadata account holds 32/.test(r.thrown || ''),
    'an SPL launch with a 53-byte name is refused with both numbers', (r.thrown || 'it was ACCEPTED').slice(0, 95));
  check(/launch the token as Token-2022 instead/.test(r.thrown || ''), 'and is told the way around it');
}

const RPC_OK = !!(await inspectSolCoin(SOL_RPC, 'So11111111111111111111111111111111111111112').catch(() => null)
  || true);
if (!RPC_OK) { console.log('SKIP  Solana RPC unreachable'); process.exit(fails.length ? 1 : 0); }

// --- live: the standard that can hold it, and the one that cannot ------------------
{
  const r = await launch({ name: LONG, symbol: 'LONGTICKER!!', params: params(true) });
  check(!r.thrown && !r.simulationError, 'the same launch as Token-2022 simulates clean',
    r.thrown || r.simulationError || 'config written');
  check(Number(r.createdConfig?.tokenType) === 1, 'and the config it writes says Token-2022', `tokenType ${r.createdConfig?.tokenType}`);
  await sleep(700);
  const withBuy = await launch({ name: LONG, symbol: 'LONGTICKER!!', params: params(true), devBuyQuote: '0.05' });
  check(!withBuy.thrown && !withBuy.simulationError && withBuy.poolTxInstructions > 2,
    'a dev buy still rides along in the same transaction on a Token-2022 base',
    withBuy.thrown || withBuy.simulationError || `${withBuy.poolTxInstructions} instructions`);
  await sleep(700);
  const spl = await launch({ name: 'a'.repeat(32), symbol: 'b'.repeat(10) });
  check(!spl.thrown && !spl.simulationError && Number(spl.createdConfig?.tokenType) === 0,
    'and a name and ticker exactly at the caps still launch as classic SPL',
    spl.thrown || spl.simulationError || `tokenType ${spl.createdConfig?.tokenType}`);
}

// --- live: a pool on a real Token-2022 config takes the long fields ----------------
// The chain's own verdict on the far side of the config: this is a pool
// instruction on a config that already exists, so the simulation is real.
{
  const coin = await inspectSolCoin(SOL_RPC, '6G3JsxAAjBwQT2gqAUT7ijYm9NZs8fkbkAGSy1mgnCRV').catch(() => null);
  if (!coin || coin.kind !== 'dbc' || !coin.baseToken2022) {
    console.log('SKIP  the reference Token-2022 DBC coin could not be read');
  } else {
    const r = await launchMeteora({
      rpcUrl: SOL_RPC, secretKey: throwaway, dryRun: true, simulateAs: RICH,
      quoteMint: coin.quoteMint, params: null, baseToken2022: true, reuseConfig: coin.config,
      name: 'x'.repeat(240), symbol: 'y'.repeat(32),
      uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc5rnxtbnkrqxgl6qdxvlnh4xeqt3ifwpxglqwu7a',
    }).catch((e) => ({ thrown: e.message }));
    const tooLong = (r.logs || []).find((l) => /too long/i.test(l));
    check(!r.thrown && !r.simulationError && !tooLong,
      'a real Token-2022 pool takes a 240-byte name and a 32-byte ticker beside a normal IPFS URI',
      r.thrown || tooLong || r.simulationError || 'the program accepted both');
  }
}

console.log('');
process.exit(fails.length ? 1 : 0);
