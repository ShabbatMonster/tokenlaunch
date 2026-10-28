// Float (floatlaunch.xyz) launches, pinned against the live program.
//
// Float wraps Raydium LaunchLab in its own program (3KguFi7Y…), with no
// published IDL. Everything here was read off two real launches - FLOWSTATE
// (4UZzNas…) and FLOAT (7uBAsDz8…), both SPYx-paired - and Float's binary, so
// the strongest check is the first one: the pad rebuilds FLOWSTATE's launch and
// dev buy byte for byte, every account in place.
//
// The rule the user asked for: Float charges 1 SOL to reuse a ticker, and the
// pad refuses a taken one instead. The program itself does NOT refuse - it takes
// the 1 SOL - so the launch also carries a Lighthouse assertion that the ticker
// record does not exist, which reverts the transaction if someone registers the
// ticker while it is in flight.
//   node test/js/float-launch.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import {
  Connection, PublicKey, Transaction, VersionedTransaction, TransactionMessage, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  launchFloat, floatLaunchIx, floatDevBuyIxs, floatTickerFreeGuardIx, readFloatConfig, readFloatQuote,
  floatTickerOwner, floatMint, floatConfig, floatQuoteRecord, floatTickerRecord, floatLaunchRecord,
  floatCoinAuthority, floatCheckMetadata, FLOAT_LOOKUP_TABLE, FLOAT_TICKER_RULE,
} from '../../src/float.js';
import { FLOAT_PAIRS } from '../../src/floatPairs.js';
import { SOL_RPC } from '../../src/rpc.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(import.meta.dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');

const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const FLOWSTATE = { mint: '4UZzNasEVFs5p7mP46mXNU5Hpe5b5E6Y5n1r7dyTHmr2', sig: '55dLDSbvAJ5d29fxb7hzCG9xM4qz5Zy2cowvHvG96xtZsRvUy4wUEXFwwoH6rF715CkpXfgNkqHtuGj3wv7uea2c' };
const DEV = '4Lm2uqHgauVS1gzzNCd1F4FeGNwzUp6dXp5uqHxmrnDX';    // FLOWSTATE's creator, whose launch is the reference
const RICH = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const URI = 'https://ipfs.io/ipfs/bafkreigh2akiscaildc5rnxtbnkrqxgl6qdxvlnh4xeqt3ifwpxglqwu7a';
const fresh = () => 'Z' + Math.random().toString(36).slice(2, 8).toUpperCase();

// --- the pad ---------------------------------------------------------------------
check(/id: 'float-sol'/.test(MAIN) && /family: 'float'/.test(MAIN), 'main.js has the Float pad');
check(/floatlaunch\.xyz\/tokens\/\$\{t\}/.test(MAIN), 'and links a launched coin to its page on Float');
for (const id of ['floatRow', 'floatQuote', 'floatTier', 'floatDevBuy', 'floatTickerHint', 'floatHoldHint', 'floatCreator', 'floatFundBtn']) {
  check(HTML.includes(`id="${id}"`), `UI has #${id}`);
}
check(/function checkFloatTicker/.test(MAIN) && /addEventListener\('input', \(\) => \{ if \(activePad\.family === 'float'\) checkFloatTicker/.test(MAIN),
  'the ticker is checked as it is typed');
check(/async function precheckFloat/.test(MAIN) && /await precheckFloat\(pad, inp\)/.test(MAIN),
  'and again before the image is uploaded, so a taken ticker costs nothing');
check(/symbol: inp\.symbol\.toUpperCase\(\)/.test(MAIN), 'tickers are registered upper-case, as Float requires');
check(FLOAT_PAIRS.length >= 100 && FLOAT_PAIRS[0].symbol === 'SPYx' && FLOAT_PAIRS.every((q) => q.mint && Number.isInteger(q.decimals)),
  'the pair list is Float\'s own, SPYx first, each with its decimals', `${FLOAT_PAIRS.length} pairs`);

// --- the rules, refused in words before anything is signed -----------------------
const refuses = (o, re, label) => {
  let msg = '';
  try { floatCheckMetadata({ name: 'Coin', symbol: 'COIN', uri: URI, ...o }); } catch (e) { msg = e.message; }
  check(re.test(msg), label, msg.slice(0, 90) || 'it was ACCEPTED');
};
refuses({ symbol: 'lower' }, /A-Z and 0-9 only/, 'a lower-case ticker is refused');
refuses({ symbol: 'ABCDEFGHIJK' }, /1-10 characters/, 'an 11-character ticker is refused');
refuses({ symbol: 'NO-DASH' }, /A-Z and 0-9 only/, 'punctuation in a ticker is refused');
refuses({ name: 'x'.repeat(33) }, /33 bytes .* holds 32/, 'a 33-byte name is refused (Float and Metaplex both cap it at 32)');
refuses({ uri: 'https://x.co/' + 'a'.repeat(188) }, /201 bytes; the cap is 200/, 'a 201-byte metadata URI is refused');
check(FLOAT_TICKER_RULE.test('A') && FLOAT_TICKER_RULE.test('ABCDEFGHIJ') && FLOAT_TICKER_RULE.test('X1'), 'and 1-10 of A-Z/0-9 is fine');

// --- live -------------------------------------------------------------------------
const c = new Connection(SOL_RPC, 'confirmed');
if (!(await c.getSlot().catch(() => null))) { console.log('SKIP  Solana RPC unreachable'); process.exit(fails.length ? 1 : 0); }

// every PDA, against the accounts FLOWSTATE's launch actually used
const tx = await c.getTransaction(FLOWSTATE.sig, { maxSupportedTransactionVersion: 0 });
const m = tx.transaction.message;
const keys = m.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
const real = (n) => {
  const ix = m.compiledInstructions[n];
  return { data: Buffer.from(ix.data), keys: ix.accountKeyIndexes.map((i) => ({ k: keys.get(i).toBase58(), s: m.isAccountSigner(i), w: m.isAccountWritable(i) })) };
};
const launchReal = real(2);
{
  const k = launchReal.keys.map((x) => x.k);
  check(k[1] === floatConfig().toBase58(), 'the config is the PDA "config"');
  check(k[3] === floatQuoteRecord(SPYX).toBase58(), 'each pair is the PDA "quote" + its mint');
  check(k[5] === floatTickerRecord('FLOWSTATE').toBase58(), 'each ticker is the PDA "ticker" + the ticker');
  check(k[7] === floatLaunchRecord(FLOWSTATE.mint).toBase58() && k[8] === floatCoinAuthority(FLOWSTATE.mint).toBase58(),
    'and each coin has a launch record and an authority, both seeded by its mint');
}
const cfg = await readFloatConfig(c, 0);
const quote = await readFloatQuote(c, SPYX);
check(cfg.tiers.length === 3 && cfg.tiers.map((t) => t.totalBps).join(',') === '100,200,250',
  'Float has three fee tiers, 1% / 2% / 2.5% all-in, each its own LaunchLab platform', cfg.tiers.map((t) => `${t.totalBps / 100}%`).join(' '));
check(quote.symbol === 'SPYx' && quote.decimals === 8, 'SPYx is read as an 8-decimal Token-2022 pair', `${quote.symbol} / ${quote.decimals}dp`);
{
  // decode FLOWSTATE's own arguments and rebuild the instruction from them
  const d = launchReal.data;
  let o = 8;
  const str = () => { const n = d.readUInt32LE(o); o += 4; const s = d.subarray(o, o + n).toString('utf8'); o += n; return s; };
  const name = str(), symbol = str(), uri = str();
  const creator = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const feeTier = d[o]; o += 1;
  const nonce = d.readBigUInt64LE(o);
  check(floatMint(new PublicKey(DEV), nonce).toBase58() === FLOWSTATE.mint, 'the coin is the PDA "mint" + payer + nonce, so there is no mint keypair');
  const mine = floatLaunchIx({ payer: new PublicKey(DEV), creator, nonce, name, symbol, uri, quote, cfg: await readFloatConfig(c, feeTier) });
  const same = (r, ix) => Buffer.compare(r.data, Buffer.from(ix.data)) === 0 && r.keys.length === ix.keys.length
    && r.keys.every((rk, i) => ix.keys[i].pubkey.toBase58() === rk.k && ix.keys[i].isSigner === rk.s && ix.keys[i].isWritable === rk.w);
  check(same(launchReal, mine.ix), 'the pad rebuilds FLOWSTATE\'s Launch byte for byte, all 23 accounts in place');
  const buyReal = real(4);
  const [, buy] = floatDevBuyIxs({ payer: new PublicKey(DEV), mint: mine.mint, pool: mine.pool, quote, cfg, amountIn: buyReal.data.readBigUInt64LE(8) });
  check(same(buyReal, buy), 'and its dev buy (LaunchLab buy_exact_in) byte for byte, all 18 accounts');
}

// a taken ticker: refused, and what refusing it saves
{
  // Not pinned to one coin: takeovers really happen. FLOAT pointed at 7uBAsDz8…
  // and was taken over (1 SOL paid) by CdmPprk8… while this pad was being built.
  const held = await floatTickerOwner(c, 'FLOAT');
  check(!!held && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(held.coin) && held.since instanceof Date,
    'FLOAT is read as taken, with the coin that holds it now', held ? `${held.coin.slice(0, 8)}… since ${held.since.toISOString().slice(0, 16)}` : 'free?');
  const r = await launchFloat({ rpcUrl: SOL_RPC, dryRun: true, simulateAs: RICH, quoteMint: SPYX, name: 'x', symbol: 'FLOAT', uri: URI }).catch((e) => ({ thrown: e.message }));
  check(/already taken on Float .* 1 SOL .* stops here/.test(r.thrown || ''), 'a launch with a taken ticker stops before signing', (r.thrown || 'it went ahead').slice(0, 90));
  check(await floatTickerOwner(c, fresh()) === null, 'and a fresh ticker reads as free');

  const lut = (await c.getAddressLookupTable(FLOAT_LOOKUP_TABLE)).value;
  const payer = new PublicKey(RICH);
  const pre = await c.getBalance(cfg.treasury);
  const simWith = async (ixs) => {
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: (await c.getLatestBlockhash()).blockhash, instructions: ixs }).compileToV0Message([lut]);
    const s = await c.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, accounts: { addresses: [cfg.treasury.toBase58()], encoding: 'base64' } });
    return { err: s.value.err, gained: ((s.value.accounts?.[0]?.lamports ?? pre) - pre) / 1e9 };
  };
  const { ix } = floatLaunchIx({ payer, creator: payer, nonce: BigInt(Date.now()), name: 'x', symbol: 'FLOAT', uri: URI, quote, cfg });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
  const bare = await simWith([cu, ix]);
  check(!bare.err && bare.gained === 1, 'without the guard Float would take the ticker over and charge 1 SOL — the program does not refuse',
    `treasury +${bare.gained} SOL`);
  await sleep(500);
  const guarded = await simWith([cu, floatTickerFreeGuardIx('FLOAT'), ix]);
  check(!!guarded.err && guarded.gained === 0, 'with the guard the same launch reverts and nothing is paid', `treasury +${guarded.gained} SOL`);
}

// launches that go through
const live = async (label, o, detail) => {
  await sleep(600);
  const r = await launchFloat({ rpcUrl: SOL_RPC, dryRun: true, simulateAs: RICH, quoteMint: SPYX, name: 'Float Wire', symbol: fresh(), uri: URI, ...o })
    .catch((e) => ({ thrown: e.message }));
  const ok = !r.thrown && !r.simulationError;
  check(ok, label, ok ? (detail ? detail(r) : `${r.unitsConsumed} CU`) : (r.thrown || r.simulationError).slice(0, 110));
  return ok ? r : null;
};
for (const t of [0, 1, 2]) await live(`a launch at the ${cfg.tiers[t].totalBps / 100}% fee tier simulates`, { feeTier: t }, (r) => `${r.feeBps / 100}% · ${r.unitsConsumed} CU`);
// the dev buy has to be simulated as a wallet that really holds SPYx; any
// one borrowed for good can spend it (FLOWSTATE's creator did), so find one now
async function spyxHolder() {
  const big = await c.getTokenLargestAccounts(new PublicKey(SPYX)).catch(() => null);
  for (const a of big?.value || []) {
    if (Number(a.uiAmount) < 0.02) continue;
    const info = (await c.getParsedAccountInfo(a.address)).value?.data?.parsed?.info;
    const owner = info?.owner && new PublicKey(info.owner);
    const acct = owner && await c.getAccountInfo(owner);
    // a plain wallet with SOL for rent, not a pool vault owned by a program
    if (acct && acct.owner.equals(new PublicKey('11111111111111111111111111111111')) && acct.lamports > 0.1e9) {
      // and its SPYx has to sit in its own ATA, which is where the buy draws from
      const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
      const ata = getAssociatedTokenAddressSync(new PublicKey(SPYX), owner, false, new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
      if (ata.equals(a.address)) return owner.toBase58();
    }
  }
  return null;
}
{
  const holder = await spyxHolder();
  if (!holder) console.log('SKIP  no wallet holding SPYx in its own account could be found to simulate the dev buy as');
  else await live('a launch with an atomic dev buy in SPYx simulates', { simulateAs: holder, devBuyUi: '0.01' },
    (r) => `${Number(r.devBuyRaw) / 1e8} SPYx, simulated as ${holder.slice(0, 6)}… · ${r.unitsConsumed} CU`);
}
await live('creator fees can go to a different wallet', { creatorWallet: 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT' }, (r) => `creator ${r.creator.slice(0, 8)}…`);
{
  const spl = FLOAT_PAIRS.find((q) => q.symbol === 'APE') || FLOAT_PAIRS.find((q) => q.decimals === 18);
  if (spl) await live(`a classic-SPL pair (${spl.symbol}) launches too`, { quoteMint: spl.mint });
}
await sleep(600);
{
  const r = await launchFloat({ rpcUrl: SOL_RPC, dryRun: true, simulateAs: RICH, quoteMint: SPYX, name: 'Float Wire', symbol: fresh(), uri: URI })
    .catch((e) => ({ thrown: e.message }));
  check(r.logs?.some((l) => /L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95/.test(l)) && !r.simulationError,
    'every launch carries the ticker guard, and a free ticker passes it');
}

console.log('');
process.exit(fails.length ? 1 : 0);
