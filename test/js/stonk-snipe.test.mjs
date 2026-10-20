// StonkFun sniper: queue a coin against a quote Raydium has not approved yet and
// land it in the approval's block. Benchmark: 5m8XU9rz...FvF5 (ALTCOIN on quote
// 7V1evj...), which landed at index 990 of the slot whose index 855 approved it.
// Pure checks always run; the live ones need RPC=<url>.
//   RPC=https://... node test/js/stonk-snipe.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import bs58 from 'bs58';
import {
  Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram,
} from '@solana/web3.js';
import { raydiumConfigId, raydiumConfigExists, launchRaydium } from '../../src/solana.js';
import {
  standInConfig, prepareSnipe, signSnipe, buildSnipeTx, StonkSnipe, SNIPE_SERVICES,
  HELIUS_TIP_ACCOUNTS, JITO_TIP_ACCOUNTS, NOZOMI_TIP_ACCOUNTS, FALCON_TIP_ACCOUNTS,
} from '../../src/stonkSnipe.js';
const RPC = process.env.RPC || process.env.SOL_RPC;
const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
const SOL = 'So11111111111111111111111111111111111111112';
const QUOTE = '7V1evjzUMFi4QDK7kAntcfdr9MyYC6S5bvsUCtxX1dSJ';
const PLAT = '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt';
const BENCH = '5m8XU9rzAVaBxuB7gkqZx39SK216XDXmXE2Qov4GkYbt3R7NxKZyA6Xe15ntXCRu9xMYEeQ9EUvbjXrXiq1FEvF5';

// --- wiring ---------------------------------------------------------------
check(raydiumConfigId(SOL).toBase58() === '6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX', 'the config PDA the sniper watches is derived from the quote alone');
for (const svc of ['helius', 'jito', 'nozomi', 'falcon', 'custom']) check(HTML.includes(`data-snipe-svc="${svc}"`), `UI can tick ${svc} as a sender`);
check(/type="password" id="snipeNozomiKey"/.test(HTML) && /type="password" id="snipeFalconKey"/.test(HTML), 'sender API keys are masked inputs');
check(/SNIPE_APIKEYS_KEY/.test(MAIN) && !/x\.keys =|it\.keys =/.test(MAIN), 'sender API keys are kept out of the queue (COPY never exports them)');
for (const id of ['snipePrio', 'snipeTip', 'snipeNonce', 'snipeCu', 'snipeSpam', 'snipeAddBtn', 'snipeQueue']) {
  check(HTML.includes(`id="${id}"`), `UI has #${id}`);
}
const block = MAIN.slice(MAIN.indexOf('// --- StonkFun snipe queue'), MAIN.indexOf('/// Pull every LaunchLab config'));
check(block.length > 1000, 'main.js has the snipe queue');
check((block.match(/secretKey/g) || []).length === 1 && /new StonkSnipe\(\{[^}]*secretKey: solKeyB58/.test(block),
  'the private key goes only to the live engine, never into the stored queue');
check(/SNIPE_LIVE_STATES\.has\(it\.state\) && !snipeLive\.has\(it\.id\)\) \{ it\.state = 'paused'/.test(block),
  'a reload turns live snipes into paused ones (nothing runs without the key)');

// --- fee math (no RPC) ----------------------------------------------------
{
  const kp = Keypair.generate();
  const mint = Keypair.generate();
  // one stand-in launch instruction that, like the real one, needs the mint to sign
  const fake = { instructions: [SystemProgram.transfer({ fromPubkey: mint.publicKey, toPubkey: kp.publicKey, lamports: 0 })], mintKeypair: mint };
  const s = signSnipe(fake, {
    secretKey: bs58.encode(kp.secretKey), blockhash: '11111111111111111111111111111111',
    cuLimit: 450_000, prioSol: 0.32, tipSol: 0.01, tipAccount: HELIUS_TIP_ACCOUNTS[0],
  });
  // price x limit / 1e6 = lamports paid: 711111112 µL x 450k CU = 0.32 SOL, the benchmark's fee
  check(s.microLamports === 711_111_112 && Math.floor((s.microLamports * 450_000) / 1e6) === 320_000_000,
    'the priority fee entered in SOL is what is paid (0.32 SOL over 450k CU)', String(s.microLamports));
  check(s.tipLamports === 10_000_000 && s.tx.message.compiledInstructions.length === 4, 'the bribe is one transfer after the launch');
  check(s.tx.signatures.length === 2, 'signed by the wallet and the new mint');
}

// --- nonce fan-out (no RPC) -------------------------------------------------
{
  const kp = Keypair.generate();
  const mint = Keypair.generate();
  const fake = { instructions: [SystemProgram.transfer({ fromPubkey: mint.publicKey, toPubkey: kp.publicKey, lamports: 0 })], mintKeypair: mint };
  const nonce = { account: Keypair.generate().publicKey.toBase58(), value: Keypair.generate().publicKey.toBase58() };
  const tips = { helius: HELIUS_TIP_ACCOUNTS, jito: JITO_TIP_ACCOUNTS, nozomi: NOZOMI_TIP_ACCOUNTS, falcon: FALCON_TIP_ACCOUNTS };
  const copies = Object.entries(tips).map(([svc, list]) => ({ svc, ...signSnipe(fake, {
    secretKey: bs58.encode(kp.secretKey), nonce, prioSol: 0.3, tipSol: 0.01, tipAccount: list[0],
  }) }));
  const keys = (c) => c.tx.message.staticAccountKeys.map((k) => k.toBase58());
  const first = (c) => c.tx.message.compiledInstructions[0];
  check(copies.every((c) => keys(c)[first(c).programIdIndex] === SystemProgram.programId.toBase58() && Buffer.from(first(c).data).readUInt32LE(0) === 4),
    'every nonce copy opens with AdvanceNonce (what makes it a durable-nonce transaction)');
  check(copies.every((c) => c.tx.message.recentBlockhash === nonce.value), 'and all of them carry the same nonce, so only one can land');
  check(new Set(copies.map((c) => c.sig)).size === copies.length && copies.every((c) => keys(c).includes(tips[c.svc][0])),
    'one distinct copy per sender, each tipping that sender');
  check(Object.values(SNIPE_SERVICES).every((s) => Array.isArray(s.tips)) && FALCON_TIP_ACCOUNTS.length === 10 && NOZOMI_TIP_ACCOUNTS.length === 17,
    'sender table has Falcon (10) and Nozomi (17) tip accounts');
}

if (!RPC) { console.log('SKIP  set RPC=<url> for the live checks'); process.exit(fails.length ? 1 : 0); }
const conn = new Connection(RPC, 'confirmed');
// rate limits happen on a busy key: retry a few times before giving up
const rpc = async (m, q) => {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: q }) }).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    if (j && j.result !== undefined) return j.result;
    await new Promise((res) => setTimeout(res, 600 * (i + 1)));
  }
  return null;
};
const hex = (d) => Buffer.from(d).toString('hex');

// --- a stand-in config builds what the real one builds, byte for byte --------
const override = await standInConfig(conn, QUOTE);
check(override.minFundRaisingB.toString() === '1', 'the stand-in has no raise floor (the SOL config 24 SOL floor would lift the raise)');
// built as a wallet that holds the quote now: the SDK needs the quote account
// to exist to add a dev buy (the benchmark sniper's own wallet has since
// closed its account). The owner only changes accounts, not instruction data.
const holders = [];
{
  const largest = await rpc('getTokenLargestAccounts', [QUOTE]);
  for (const a of (largest?.value || []).slice(0, 8)) {
    const acct = await rpc('getAccountInfo', [a.address, { encoding: 'jsonParsed' }]);
    const owner = acct?.value?.data?.parsed?.info?.owner;
    if (owner && PublicKey.isOnCurve(new PublicKey(owner).toBytes())) holders.push(owner);   // skip pool vaults
  }
}
check(holders.length > 0, 'found a wallet holding the quote to build the dev buy as', holders[0]);
const base = {
  rpcUrl: RPC, ownerPubkey: holders[0], quoteMint: QUOTE, name: 'Alt-coin', symbol: 'ALTCOIN',
  uri: 'https://api.nemtech.io/json/c1660b19', buyAmountUi: '1200.949167', migrateType: 'cpmm', platformId: PLAT, token2022: true,
  transferFeeBps: 100, raiseTargetUi: '8549.601036', prebuild: true, configInfoOverride: override, minMintAAmountRaw: 1,
};
const real = await launchRaydium({ ...base });
const stand = await launchRaydium({ ...base, forceConfigOverride: true });
const shape = (p) => p.instructions.map((ix) => hex(ix.data)).join('|');
check(real.configExists && shape(real) === shape(stand), 'the stand-in config builds the same instructions as the live config');
const t = await rpc('getTransaction', [BENCH, { encoding: 'json', maxSupportedTransactionVersion: 1 }]);
const ix = (d) => stand.instructions.find((i) => hex(i.data).startsWith(d));
check(hex(ix('25be7ede2c9aab11').data) === hex(bs58.decode(t.transaction.message.instructions[0].data)), 'initialize data matches the benchmark sniper byte for byte');
check(hex(ix('faea0d7bd59c13ec').data) === hex(bs58.decode(t.transaction.message.instructions[3].data)), 'dev-buy data matches byte for byte');
check(ix('faea0d7bd59c13ec').keys.length === 18, 'the dev buy carries no trailing curve-rule account (18, like the benchmark)', String(ix('faea0d7bd59c13ec').keys.length));

// --- pre-builds for a quote with no config at all ----------------------------
const unapproved = 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux';   // HNT: no LaunchLab config
if (!(await raydiumConfigExists(RPC, unapproved))) {
  const kp = Keypair.generate();
  const p = await prepareSnipe({
    rpcUrl: RPC, secretKey: bs58.encode(kp.secretKey), quoteMint: unapproved, platformId: PLAT,
    name: 'Queue test', symbol: 'QTEST', uri: base.uri, devBuyUi: '0', transferFeeBps: 100,
  });
  const { blockhash } = await conn.getLatestBlockhash();
  const s = signSnipe(p, { secretKey: bs58.encode(kp.secretKey), blockhash, prioSol: 0.32, tipSol: 0.01, tipAccount: HELIUS_TIP_ACCOUNTS[0] });
  check(!p.configExists && p.configId === raydiumConfigId(unapproved).toBase58() && s.size <= 1232,
    'a snipe pre-builds and signs before the quote is approved', `${s.size} bytes`);
} else console.log('SKIP  HNT has a config now - pick another unapproved quote');

// --- the stand-in snipe executes against a live config -----------------------
// simulated as a wallet that holds the quote now (the dev buy needs it)
const largest = await rpc('getTokenLargestAccounts', [QUOTE]);
let simOk = false, why = 'no wallet holder found';
for (const a of (largest?.value || []).slice(0, 6)) {
  const acct = await rpc('getAccountInfo', [a.address, { encoding: 'jsonParsed' }]);
  const owner = acct?.value?.data?.parsed?.info?.owner;
  if (!owner || !PublicKey.isOnCurve(new PublicKey(owner).toBytes())) continue;   // skip pool vaults
  const p = await launchRaydium({ ...base, ownerPubkey: owner, name: 'Sim test', symbol: 'SIMT', buyAmountUi: '1', raiseTargetUi: undefined, forceConfigOverride: true });
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: new PublicKey(owner), recentBlockhash: blockhash, instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...p.instructions,
      SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(HELIUS_TIP_ACCOUNTS[0]), lamports: 1_000_000 }),
    ],
  }).compileToV0Message();
  const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
  why = JSON.stringify(sim.value.err);
  if (!sim.value.err) { simOk = true; why = `as ${owner.slice(0, 6)}…, ${sim.value.unitsConsumed} CU`; break; }
}
check(simOk, 'a stand-in-built launch + dev buy + bribe simulates clean against the live config', why);

// --- a nonce-signed launch executes ----------------------------------------
// Read-only simulation against an existing durable nonce account (the one the
// 2026-10-19 winner signs with), with its authority as payer: proves the
// AdvanceNonce-first layout and the nonce value as blockhash are accepted.
{
  const NONCE = 'HgZamge8AwTdM6Z34LMPatLTfybo74Az46R1khMTM2KX';
  const n = await conn.getNonce(new PublicKey(NONCE), 'confirmed').catch(() => null);
  if (!n) console.log('SKIP  fixture nonce account is gone');
  else {
    const auth = n.authorizedPubkey.toBase58();
    const p = await launchRaydium({ ...base, ownerPubkey: auth, name: 'Nonce test', symbol: 'NONCE', buyAmountUi: '0', raiseTargetUi: undefined, forceConfigOverride: true });
    const { tx } = buildSnipeTx(p, { payer: auth, nonce: { account: NONCE, value: n.nonce }, prioSol: 0.0001, tipSol: 0.001, tipAccount: FALCON_TIP_ACCOUNTS[0] });
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' });
    check(!sim.value.err, 'a durable-nonce launch + Falcon tip simulates clean against the live config', JSON.stringify(sim.value.err) + ` · ${tx.serialize().length} bytes`);
  }
  // with the benchmark's dev buy, a nonce copy still fits a transaction
  const { blockhash } = await conn.getLatestBlockhash();
  const fat = buildSnipeTx(stand, { payer: base.ownerPubkey, nonce: { account: NONCE, value: blockhash }, cuLimit: 450_000, prioSol: 0.32, tipSol: 0.01, tipAccount: FALCON_TIP_ACCOUNTS[0] });
  const size = fat.tx.serialize().length;
  check(size <= 1232, 'the benchmark launch + dev buy still fits with the nonce', `${size} bytes`);
}

// --- the engine still launches: armed on an approved quote it fires at once --
// Sends are stubbed (a throwaway wallet), the nonce is unavailable, so this
// walks the fallback path the original armed flow used.
{
  const kp = Keypair.generate();
  const lines = [], states = [];
  const sn = new StonkSnipe({
    rpcUrls: [RPC], secretKey: bs58.encode(kp.secretKey), quoteMint: QUOTE, platformId: PLAT, name: 'Engine test', symbol: 'ENGT',
    uri: base.uri, devBuyUi: '0', transferFeeBps: 100, prioSol: 0.01, tipSol: 0.001, services: ['helius', 'jito', 'nozomi'],
    keys: {}, useNonce: true, nonceAccount: null,
  }, { onLog: (m) => lines.push(m), onState: (s) => states.push(s) });
  sn.checkFunds = async () => {};
  let blasts = 0;
  sn.sendEverywhere = async () => { blasts++; };
  sn.sendBundles = async () => {};
  await sn.arm();
  await new Promise((r) => setTimeout(r, 600));
  sn.stop();
  check(lines.some((l) => /Nozomi: no API key entered - skipped/.test(l)), 'a sender without its key is skipped, not fatal');
  check(lines.some((l) => /falling back to one blockhash copy/.test(l)), 'an unusable nonce falls back to the original single-copy signing');
  check(states.includes('firing') && blasts > 0 && lines.some((l) => /already approved - firing now/.test(l)),
    'and an armed snipe on an approved quote fires straight away', `${blasts} blasts · ${sn.cur?.size} bytes`);
}
console.log('');
process.exit(fails.length ? 1 : 0);
