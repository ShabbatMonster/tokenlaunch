// StonkFun sniper: be the first coin on a quote the moment Raydium approves it.
//
// A LaunchLab quote becomes launchable when Raydium's admin creates its
// LaunchpadConfig (RayUzn...tty2 sends CreateConfig + UpdateConfigs in one tx).
// The sniper this was modelled on (5m8XU9rz...FvF5, ALTCOIN on quote 7V1evj...)
// landed at slot 458982526 index 990 - the SAME block as the approval at index
// 855 - with a dev buy of ~30% of supply, a 0.32 SOL priority fee and a 0.01
// SOL bribe. Nothing the launch needs depends on the config's contents, only on
// its address (a PDA of the quote), so the whole transaction can be built and
// signed before the approval exists:
//
//   1. pre-build the StonkFun launch + dev buy (solana.js launchRaydium with
//      prebuild + a stand-in config: new quote configs come out standard -
//      curve type 0, migrate fee 0, no raise floor), add the priority fee and
//      the bribe, and sign it; re-sign with a fresh blockhash every ~20s
//   2. while armed, submit it as a BUNDLE over and over. A bundle that fails
//      (config not there yet) is dropped and costs nothing; the first one tried
//      after the approval executes lands - in the same block if it is reached
//      before the leader finishes it
//   3. watch the config account (websocket accountSubscribe at `processed`,
//      plus polling); the instant it exists, blast the same signed transaction
//      down every path, bundles and plain sends alike
//   4. report where it landed against the approval: same slot? which index?
//
// Plain sends are only made AFTER the config exists, because a plain send that
// lands before it would fail and still pay the full priority fee.
//
// By default the launch is signed against a DURABLE NONCE, once per landing
// service (Helius Sender, Jito, Nozomi, Falcon, custom), each copy carrying
// that service's tip. All copies share the nonce, so the first to land
// advances it and kills the rest: every route can be raced at once and a tip
// and fee are still paid once. Nonce copies never expire, so nothing is
// re-signed while armed. If the nonce cannot be used (no SOL for its rent, or
// the launch too big with it) it falls back to the original single blockhash
// copy, re-signed every 20s.

import {
  Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram, SystemProgram, TransactionMessage, VersionedTransaction,
  NONCE_ACCOUNT_LENGTH,
} from '@solana/web3.js';
import BN from 'bn.js';
import { LaunchpadConfig, LAUNCHPAD_PROGRAM, getPdaLaunchpadPoolId } from '@raydium-io/raydium-sdk-v2';
import { launchRaydium, raydiumConfigId, keypairFromSecret, loadRaydiumClient, raydiumQuoteInfo } from './solana.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const RAYDIUM_ADMIN = 'RayUzntHM1dWZJyCnkQjHusUGhYyi6gpNf7t8srtty2';

/// Helius Sender (one tip, routed via Helius, Jito, Harmonic and Rakurai).
export const HELIUS_SENDER = 'https://sender.helius-rpc.com/fast';
export const HELIUS_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta', '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF', '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey', '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];
export const HELIUS_MIN_TIP_SOL = 0.001;

/// Jito block engines; unauthenticated, each region allows about one request a
/// second, so the spam rotates across them.
export const JITO_REGIONS = ['mainnet', 'ny', 'amsterdam', 'frankfurt', 'tokyo', 'slc', 'london', 'singapore', 'dublin']
  .map((r) => `https://${r}.block-engine.jito.wtf/api/v1`);
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Timers that keep their pace in a background tab. Chrome slows a hidden tab's
// chained timers to once a second, then once a minute after five minutes - an
// armed snipe sitting behind other tabs for an hour would spam once a minute
// and blast once a second. A dedicated worker's timers are not throttled, so
// the ticks come from one when the page can make it.
let tickWorker;
const tickFns = new Map();
let tickSeq = 0;
function worker() {
  if (tickWorker !== undefined) return tickWorker;
  tickWorker = null;
  try {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return null;
    const src = 'const t=new Map();onmessage=(e)=>{const[k,id,ms]=e.data;'
      + 'if(k==="s")t.set(id,setTimeout(()=>{t.delete(id);postMessage(id)},ms));else{clearTimeout(t.get(id));t.delete(id)}}';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => { const fn = tickFns.get(e.data); tickFns.delete(e.data); fn?.(); };
    tickWorker = w;
  } catch { tickWorker = null; }
  return tickWorker;
}
function after(ms, fn) {
  const w = worker();
  if (!w) return { t: setTimeout(fn, ms) };
  const id = ++tickSeq;
  tickFns.set(id, fn);
  w.postMessage(['s', id, ms]);
  return { id };
}
function cancel(h) {
  if (!h) return;
  if (h.t != null) clearTimeout(h.t);
  if (h.id != null) { tickFns.delete(h.id); tickWorker?.postMessage(['c', h.id]); }
}
const toB64 = (u8) => (typeof Buffer !== 'undefined' ? Buffer.from(u8).toString('base64') : btoa(String.fromCharCode(...u8)));

async function post(url, method, params) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, result: j.result, error: j.error };
  } catch (e) { return { status: 0, error: { message: e.message } }; }
}

/// A stand-in for a config that does not exist yet: a live config's fields with
/// the new quote as mintB. The launch instructions only carry the config's
/// address; the SDK reads mintB, curveType and migrateFee off this.
export async function standInConfig(connection, quoteMint) {
  const tpl = await connection.getAccountInfo(raydiumConfigId(SOL_MINT));
  if (!tpl) throw new Error('could not read a template LaunchLab config');
  const c = LaunchpadConfig.decode(tpl.data);
  // the values Raydium gave the config of a freshly approved quote (7V1evj...,
  // 2026-10-19): no raise floor, the rest standard. minFundRaisingB matters -
  // the builder lifts a raise below it, and SOL's is 24 SOL.
  return {
    ...c, mintB: new PublicKey(quoteMint), curveType: 0, migrateFee: new BN(0),
    tradeFeeRate: new BN(2500), minSupplyA: new BN(10_000_000), maxLockRate: new BN(999_999),
    minSellRateA: new BN(1), minMigrateRateA: new BN(150_000), minFundRaisingB: new BN(1),
  };
}

/// Build (not send) the StonkFun launch + dev buy for `quoteMint`, whether or
/// not its config exists yet. Returns the instructions and the mint keypair.
export async function prepareSnipe(o) {
  const connection = new Connection(o.rpcUrl, 'confirmed');
  const client = o.client || await loadRaydiumClient(o.rpcUrl, o.secretKey);
  const mintBInfo = o.mintBInfo || await raydiumQuoteInfo(client, o.quoteMint);
  const override = await standInConfig(connection, o.quoteMint);
  const prep = await launchRaydium({
    rpcUrl: o.rpcUrl, secretKey: o.secretKey, quoteMint: o.quoteMint,
    name: o.name, symbol: o.symbol, uri: o.uri,
    buyAmountUi: String(o.devBuyUi || '0'), migrateType: 'cpmm', platformId: o.platformId,
    ...(o.transferFeeBps > 0 ? { token2022: true, transferFeeBps: o.transferFeeBps } : { token2022: false }),
    raiseTargetUi: o.raiseUi || undefined,
    prebuild: true, configInfoOverride: override, minMintAAmountRaw: 1,
    client, mintBInfo, onStatus: o.onStatus,
  });
  prep.poolId = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, prep.mintKeypair.publicKey, new PublicKey(o.quoteMint)).publicKey.toBase58();
  prep.client = client;
  prep.mintBInfo = mintBInfo;
  return prep;
}

// --- landing services ----------------------------------------------------------
//
// Every service wants its own tip, to its own accounts, in the transaction
// itself. With a durable nonce one launch can be signed once per service - each
// copy carrying that service's tip - and all of them sent at once: they share
// the nonce, so whichever lands first advances it and every other copy is dead.
// One tip and one fee are ever paid. (The sniper that won 2026-10-19 does this:
// its nonce account HgZamge8... landed through Falcon there, Astralane on
// ALTCOIN, Nozomi before that.)

/// Temporal's Nozomi. Needs an API key (?c=); allows browser requests.
export const NOZOMI_URLS = ['https://edge.nozomi.temporal.xyz', 'https://ewr1.nozomi.temporal.xyz', 'https://fra2.nozomi.temporal.xyz', 'https://ams1.nozomi.temporal.xyz'];
export const NOZOMI_TIP_ACCOUNTS = [
  'TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq', 'noz3jAjPiHuBPqiSPkkugaJDkJscPuRhYnSpbi8UvC4',
  'noz3str9KXfpKknefHji8L1mPgimezaiUyCHYMDv1GE', 'noz6uoYCDijhu1V7cutCpwxNiSovEwLdRHPwmgCGDNo',
  'noz9EPNcT7WH6Sou3sr3GGjHQYVkN3DNirpbvDkv9YJ', 'nozc5yT15LazbLTFVZzoNZCwjh3yUtW86LoUyqsBu4L',
  'nozFrhfnNGoyqwVuwPAW4aaGqempx4PU6g6D9CJMv7Z', 'nozievPk7HyK1Rqy1MPJwVQ7qQg2QoJGyP71oeDwbsu',
  'noznbgwYnBLDHu8wcQVCEw6kDrXkPdKkydGJGNXGvL7', 'nozNVWs5N8mgzuD3qigrCG2UoKxZttxzZ85pvAQVrbP',
  'nozpEGbwx4BcGp6pvEdAh1JoC2CQGZdU6HbNP1v2p6P', 'nozrhjhkCr3zXT3BiT4WCodYCUFeQvcdUkM7MqhKqge',
  'nozrwQtWhEdrA6W8dkbt9gnUaMs52PdAv5byipnadq3', 'nozUacTVWub3cL4mJmGCYjKZTnE9RbdY5AP46iQgbPJ',
  'nozWCyTPppJjRuw2fpzDhhWbW355fzosWSzrrMYB1Qk', 'nozWNju6dY353eMkMqURqwQEoM3SFgEKC6psLCSfUne',
  'nozxNBgWohjR75vdspfxR5H9ceC7XXH99xpxhVGt3Bb',
];

/// Corvus Labs' Falcon. Needs an API key (?api-key=); plain http only and no
/// CORS, so a browser can only post to it blind, and only from an http page
/// (the local site) - an https page is not allowed to call http.
export const FALCON_URLS = ['fra', 'ams', 'nyc', 'lon'].map((r) => `http://${r}.falcon.wtf`);
export const FALCON_TIP_ACCOUNTS = [
  'Fa1con11xLjPddfzRwRUB16sbFZggp2JeJkCeWREyR8X', 'Fa1con11TM1RuAQzbQzYjTy4Ekfap9Lnc9fnEbQYEd6Q',
  'Fa1con113Bvi76nS5AzUiRDC2fqjfzkNMUNRLgQybMYt', 'Fa1con1QGHJK232s8yZpzZZwqPexnAKcoyKj626LNsMv',
  'Fa1con1zUzb6qJVFz5tNkPq1Ahm8H1qKW7Q48252QbkQ', 'Fa1con16d3MSwd3SAiwvr2LwgkpE7ot8zntbpuec8HAx',
  'Fa1con1i7mpa7Qc6epYJ6r4P9AbU77DFFz173r59Df1x', 'Fa1con18nWn8TdAGL7JX8PertfMUGVSc899NawokJ4Bq',
  'Fa1con1GKusK2EqsfzrDzGPaYZSxQtFGzJiRMMU9Zm2g', 'Fa1con1RDwVwM9VrJ53CwVefD3VU9c58EMpDawV7fLMi',
];

/// The services, their tip accounts, the least tip each honours, and the gap
/// kept between sends to one so a blast stays under its rate limit.
export const SNIPE_SERVICES = {
  helius: { label: 'Helius Sender', tips: HELIUS_TIP_ACCOUNTS, minTipSol: HELIUS_MIN_TIP_SOL, gapMs: 0 },
  jito: { label: 'Jito', tips: JITO_TIP_ACCOUNTS, minTipSol: 0.000001, gapMs: 0 },
  nozomi: { label: 'Nozomi', tips: NOZOMI_TIP_ACCOUNTS, minTipSol: 0.001, gapMs: 200, needsKey: true },
  falcon: { label: 'Falcon', tips: FALCON_TIP_ACCOUNTS, minTipSol: 0.001, gapMs: 250, needsKey: true, httpOnly: true },
  custom: { label: 'custom', tips: [], minTipSol: 0, gapMs: 100 },
};

/// Fire-and-forget POST for a service that does not allow browser requests:
/// a text/plain body needs no preflight, and the response is not readable.
async function postBlind(url, method, params) {
  try {
    await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: 0 };
  } catch (e) { return { status: 0, error: { message: e.message } }; }
}

const b58 = (bytes) => { let s = ''; const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of bytes) { if (x === 0) s = '1' + s; else break; } return s; };

// --- durable nonce ---------------------------------------------------------------

/// Open a nonce account owned by the wallet (one-time; ~0.0015 SOL of rent,
/// which a withdraw gets back). Returns its address.
export async function createNonceAccount(connection, secretKey) {
  const owner = keypairFromSecret(secretKey);
  const nonceKp = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: owner.publicKey, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...SystemProgram.createNonceAccount({ fromPubkey: owner.publicKey, noncePubkey: nonceKp.publicKey, authorizedPubkey: owner.publicKey, lamports }).instructions,
  );
  tx.sign(owner, nonceKp);
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (res.value.err) throw new Error('creating the nonce account failed: ' + JSON.stringify(res.value.err));
  return nonceKp.publicKey.toBase58();
}

/// The nonce's current value, or null if the account is missing / not ours.
export async function readNonce(connection, nonceAccount, ownerPubkey) {
  const n = await connection.getNonce(new PublicKey(nonceAccount), 'confirmed').catch(() => null);
  if (!n || !n.authorizedPubkey.equals(new PublicKey(ownerPubkey))) return null;
  return n.nonce;
}

/// Sign the prepared launch with a priority fee (total SOL, spread over the
/// compute limit) and a bribe (SOL to a tip account). Against `blockhash`, or -
/// with `nonce: { account, value }` - against a durable nonce, which puts the
/// AdvanceNonce instruction first and never expires.
export function signSnipe(prep, { secretKey, ...o }) {
  const owner = keypairFromSecret(secretKey);
  const { tx, microLamports, prioLamports, tipLamports } = buildSnipeTx(prep, { ...o, payer: owner.publicKey });
  tx.sign([owner, prep.mintKeypair]);
  const raw = tx.serialize();
  return { tx, raw, b64: toB64(raw), sig: b58(tx.signatures[0]), size: raw.length, microLamports, prioLamports, tipLamports, tipAccount: o.tipAccount || null };
}

/// The unsigned snipe transaction for `payer` (signSnipe signs this; tests
/// simulate it with a funded payer).
export function buildSnipeTx(prep, { payer, blockhash, nonce = null, cuLimit = 300_000, prioSol = 0, tipSol = 0, tipAccount = null }) {
  const payerKey = new PublicKey(payer);
  const prioLamports = Math.round(Number(prioSol) * 1e9);
  const microLamports = Math.max(0, Math.ceil((prioLamports * 1e6) / cuLimit));
  const tipLamports = Math.round(Number(tipSol) * 1e9);
  const ixs = [
    // a durable-nonce transaction must open with AdvanceNonce
    ...(nonce ? [SystemProgram.nonceAdvance({ noncePubkey: new PublicKey(nonce.account), authorizedPubkey: payerKey })] : []),
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...prep.instructions,
    ...(tipLamports > 0 && tipAccount ? [SystemProgram.transfer({ fromPubkey: payerKey, toPubkey: new PublicKey(tipAccount), lamports: tipLamports })] : []),
  ];
  const msg = new TransactionMessage({ payerKey, recentBlockhash: nonce ? nonce.value : blockhash, instructions: ixs }).compileToV0Message();
  return { tx: new VersionedTransaction(msg), microLamports, prioLamports, tipLamports };
}

/// Where a landed launch sits against the approval: slot and index of each.
/// The approval is the OLDEST SUCCESSFUL transaction on the config before ours -
/// not simply the oldest: other snipers' early sends fail on the missing config
/// by the thousand (1941 of them before the 2026-10-19 approval).
export async function landingReport(rpcUrl, { mint, configId }) {
  const rpc = (m, p) => post(rpcUrl, m, p).then((r) => r.result);
  const ours = await rpc('getSignaturesForAddress', [mint, { limit: 1000 }]);
  const launchSig = ours?.length ? ours[ours.length - 1].signature : null;
  if (!launchSig) return null;
  const lt = await rpc('getTransaction', [launchSig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  const older = await rpc('getSignaturesForAddress', [configId, { limit: 1000, before: launchSig }]);
  const ok = (older || []).filter((s) => !s.err);
  const approvalSig = ok.length ? ok[ok.length - 1].signature : null;
  const at = approvalSig ? await rpc('getTransaction', [approvalSig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]) : null;
  return {
    launchSig, launchSlot: lt?.slot ?? null, launchIndex: lt?.transactionIndex ?? null, launchErr: lt?.meta?.err ?? null,
    approvalSig, approvalSlot: at?.slot ?? null, approvalIndex: at?.transactionIndex ?? null,
    approvalBy: at?.transaction?.message?.accountKeys?.[0] ?? null,
    sameBlock: !!(lt && at && lt.slot === at.slot),
    slotsAfter: lt && at ? lt.slot - at.slot : null,
    ahead: ok.length ? ok.length - 1 : null,   // successful transactions on the config between approval and us
  };
}

/// One armed snipe. hooks: onLog(line), onState(state, detail), onNonce(address).
export class StonkSnipe {
  constructor(cfg, hooks = {}) {
    // cfg: rpcUrls[], secretKey, quoteMint, platformId, name, symbol, uri,
    //      devBuyUi, raiseUi, transferFeeBps, prioSol, tipSol,
    //      services[] (keys of SNIPE_SERVICES), keys { nozomi, falcon },
    //      customTipAccount, customUrl, useNonce, nonceAccount, cuLimit, spamMs
    //      (legacy: service = one of them)
    this.cfg = { cuLimit: 300_000, spamMs: 200, useNonce: true, keys: {}, ...cfg };
    if (!this.cfg.services?.length) this.cfg.services = [this.cfg.service || 'helius'];
    this.hooks = hooks;
    this.state = 'idle';
    this.sigs = [];
    this.timers = [];
    this.subs = [];
    this.lastSent = new Map();
    this.stopped = false;
  }

  log(m) { this.hooks.onLog?.(`${new Date().toISOString().slice(11, 23)} ${m}`); }
  after(ms, fn) { const h = after(ms, fn); this.timers.push(h); return h; }
  every(ms, fn) {
    const h = { id: null, t: null, loop: true };
    const run = () => { if (this.stopped || !h.loop) return; fn(); Object.assign(h, after(ms, run)); };
    Object.assign(h, after(ms, run));
    this.timers.push(h);
    return h;
  }
  setState(s, d) { this.state = s; this.hooks.onState?.(s, d); }
  conn(i = 0) { const u = this.cfg.rpcUrls[i % this.cfg.rpcUrls.length]; return new Connection(u, 'processed'); }

  /// the services this snipe can actually use from here
  usable() {
    const c = this.cfg;
    const httpsPage = typeof location !== 'undefined' && location.protocol === 'https:';
    return c.services.filter((s) => {
      const def = SNIPE_SERVICES[s];
      if (!def) return false;
      if (def.needsKey && !c.keys?.[s]) { this.log(`${def.label}: no API key entered - skipped`); return false; }
      if (def.httpOnly && httpsPage) { this.log(`${def.label}: http only, which an https page cannot call - skipped (use the local site)`); return false; }
      if (s === 'custom' && !(c.customUrl && c.customTipAccount)) { this.log('custom: needs a URL and a tip account - skipped'); return false; }
      return true;
    });
  }

  tipFor(service) { return service === 'custom' ? this.cfg.customTipAccount : pick(SNIPE_SERVICES[service].tips); }

  /// Sign the launch. Nonce mode: one copy per service, each with that
  /// service's tip, plus a Jito copy for the pre-approval bundles even when
  /// Jito is not a chosen sender (a Jito bundle must tip Jito, and an
  /// unlanded bundle costs nothing). Blockhash mode: one copy, tipping the
  /// first service - two live blockhash copies could BOTH land, the second
  /// failing on the existing mint with its fee paid, so there is only ever one.
  async resign() {
    const c = this.cfg;
    const base = { secretKey: c.secretKey, cuLimit: c.cuLimit, prioSol: c.prioSol, tipSol: c.tipSol };
    if (this.nonce) {
      const value = await readNonce(this.conn(0), this.nonce.account, this.owner);
      if (!value) throw new Error('the nonce account ' + this.nonce.account.slice(0, 8) + '… is gone or not this wallet\'s');
      this.nonce.value = value;
      const want = [...new Set([...this.services, 'jito'])];
      this.variants = want.map((service) => ({ service, ...signSnipe(this.prep, { ...base, nonce: this.nonce, tipAccount: this.tipFor(service) }) }));
    } else {
      const { blockhash } = await this.conn(0).getLatestBlockhash('confirmed');
      const service = this.services[0];
      this.variants = [{ service, ...signSnipe(this.prep, { ...base, blockhash, tipAccount: this.tipAccountFixed || (this.tipAccountFixed = this.tipFor(service)) }) }];
    }
    this.cur = this.variants[0];
    this.cur.signedAt = Date.now();
    for (const v of this.variants) this.sigs.push(v.sig);
    return this.cur;
  }

  async arm() {
    const c = this.cfg;
    this.setState('preparing');
    this.owner = keypairFromSecret(c.secretKey).publicKey.toBase58();
    this.services = this.usable();
    if (!this.services.length) throw new Error('no usable landing service - tick one and enter its key');
    for (const s of this.services) {
      const min = SNIPE_SERVICES[s].minTipSol;
      if (Number(c.tipSol) < min) this.log(`note: ${SNIPE_SERVICES[s].label} drops a bribe under ${min} SOL`);
    }
    this.configId = raydiumConfigId(c.quoteMint).toBase58();
    await this.checkFunds();
    this.prep = await prepareSnipe({ ...c, rpcUrl: c.rpcUrls[0], onStatus: (m) => this.log(m) });

    if (c.useNonce) {
      try {
        let account = c.nonceAccount && await readNonce(this.conn(0), c.nonceAccount, this.owner) ? c.nonceAccount : null;
        if (!account) {
          this.log('opening a durable nonce account for this snipe (one-time, ~0.0015 SOL rent)…');
          account = await createNonceAccount(new Connection(c.rpcUrls[0], 'confirmed'), c.secretKey);
          this.hooks.onNonce?.(account);
          this.log(`nonce account ${account}`);
        }
        this.nonce = { account, value: null };
        await this.resign();
        if (this.variants.some((v) => v.size > 1232)) {
          this.log(`with the nonce the launch is ${Math.max(...this.variants.map((v) => v.size))} bytes, over 1232 - falling back to one blockhash copy`);
          this.nonce = null;
        }
      } catch (e) {
        this.log('nonce unavailable (' + e.message + ') - falling back to one blockhash copy');
        this.nonce = null;
      }
    }
    if (!this.nonce) await this.resign();
    if (this.cur.size > 1232) throw new Error(`the launch is ${this.cur.size} bytes, over Solana's 1232 - shorten the name, ticker or metadata URI`);
    const routes = this.nonce ? this.variants.map((v) => SNIPE_SERVICES[v.service].label).join(' + ') : SNIPE_SERVICES[this.cur.service].label;
    this.log(`built ${this.prep.mint.slice(0, 6)}… · ${this.cur.size} bytes · prio ${c.prioSol} SOL (${this.cur.microLamports} µL/CU × ${c.cuLimit}) · bribe ${c.tipSol} SOL`
      + ` · ${this.nonce ? `nonce fan-out: ${this.variants.length} copies (${routes}), only one can land` : `one copy via ${routes}`}`);

    // already approved? then this is just a fast launch
    const exists = await this.conn(0).getAccountInfo(new PublicKey(this.configId), 'processed').catch(() => null);
    if (exists) { this.log('the quote is already approved - firing now'); return this.fire('already approved'); }

    this.setState('armed', { mint: this.prep.mint, configId: this.configId, nonceAccount: this.nonce?.account || null });
    this.log(`armed · watching config ${this.configId.slice(0, 8)}… for Raydium's approval`);

    // blockhash copies expire in ~60s; a nonce copy never does, but is checked
    // in case something else advanced the nonce
    if (this.nonce) {
      this.every(30_000, async () => {
        if (this.state !== 'armed') return;
        const v = await readNonce(this.conn(0), this.nonce.account, this.owner).catch(() => null);
        if (v && v !== this.nonce.value) { this.log('nonce moved - re-signing'); this.resign().catch((e) => this.log('re-sign failed: ' + e.message)); }
      });
    } else {
      this.every(20_000, () => { if (this.state === 'armed') this.resign().catch((e) => this.log('re-sign failed: ' + e.message)); });
    }

    // push detection on every RPC's websocket, plus polling
    c.rpcUrls.forEach((u, i) => {
      try {
        const conn = new Connection(u, { commitment: 'processed', wsEndpoint: u.replace(/^http/, 'ws') });
        const id = conn.onAccountChange(new PublicKey(this.configId), () => this.fire(`websocket ${i + 1}`), 'processed');
        this.subs.push([conn, id]);
      } catch (e) { this.log('websocket ' + (i + 1) + ' failed: ' + e.message); }
    });
    let n = 0;
    const poll = async () => {
      if (this.state !== 'armed') return;
      const info = await this.conn(n++).getAccountInfo(new PublicKey(this.configId), 'processed').catch(() => null);
      if (info) this.fire('poll');
      else if (!this.stopped) this.after(250, poll);
    };
    poll();

    // costless bundle spam while waiting: a bundle that fails (no config yet)
    // is dropped. Nonce mode always has a Jito-tipped copy for this; blockhash
    // mode only when its one copy tips Jito or Helius (which takes bundles).
    const bundleable = this.nonce || ['jito', 'helius'].includes(this.cur.service);
    if (bundleable) {
      const spam = () => {
        if (this.state !== 'armed') return;
        this.sendBundles().catch(() => {});
        this.after(Math.max(50, c.spamMs), spam);
      };
      spam();
    } else this.log('no bundle spam with this sender in blockhash mode - it only fires on approval');
    this.every(600, () => this.checkLanded().catch(() => {}));
  }

  /// Refuse to arm a snipe that would land and fail. Before the approval a
  /// failing bundle costs nothing, but after it the plain sends do, and a dev
  /// buy the wallet cannot cover fails on chain with the priority fee paid.
  async checkFunds() {
    const c = this.cfg;
    const conn = this.conn(0);
    const owner = new PublicKey(this.owner);
    const lamports = await conn.getBalance(owner, 'confirmed');
    const needSol = Number(c.prioSol || 0) + Number(c.tipSol || 0) + 0.03 + (c.useNonce && !c.nonceAccount ? 0.0016 : 0);   // ~0.03 covers mint, pool and account rent
    if (lamports / 1e9 < needSol) throw new Error(`the wallet has ${(lamports / 1e9).toFixed(4)} SOL; this snipe needs about ${needSol.toFixed(4)} (priority + bribe + ~0.03 rent)`);
    const dev = Number(c.devBuyUi || 0);
    if (dev > 0) {
      const r = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(c.quoteMint) }, 'confirmed').catch(() => null);
      const held = (r?.value || []).reduce((t, a) => t + Number(a.account.data.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
      if (held < dev) throw new Error(`a dev buy of ${dev} needs the quote in the wallet - it holds ${held}. Buy the quote first or set the dev buy to 0`);
      this.log(`wallet holds ${held} of the quote; dev buy ${dev}`);
    }
  }

  // one send per route, spaced by the service's gap
  due(key, gapMs) {
    const now = Date.now();
    if (now - (this.lastSent.get(key) || 0) < gapMs) return false;
    this.lastSent.set(key, now);
    return true;
  }

  // Jito allows about one unauthenticated request a second per region
  jitoRegion() {
    const now = Date.now();
    const r = JITO_REGIONS.find((x) => now - (this.lastSent.get(x) || 0) >= 1000);
    if (r) this.lastSent.set(r, now);
    return r;
  }

  variant(service) { return this.variants.find((v) => v.service === service); }

  async sendBundles() {
    const sends = [];
    const j = this.variant('jito');
    if (j) { const r = this.jitoRegion(); if (r) sends.push(post(r + '/bundles', 'sendBundle', [[j.b64], { encoding: 'base64' }])); }
    const h = this.variant('helius');
    if (h) sends.push(post(HELIUS_SENDER, 'sendBundle', [[h.b64], { encoding: 'base64' }]));
    await Promise.allSettled(sends);
  }

  /// Every copy down its own route, plus the plain RPCs.
  async sendEverywhere() {
    const c = this.cfg;
    const opts = { encoding: 'base64', skipPreflight: true, maxRetries: 0 };
    const sends = c.rpcUrls.map((u) => post(u, 'sendTransaction', [this.cur.b64, opts]));
    for (const v of this.variants) {
      if (v.service === 'helius') {
        sends.push(post(HELIUS_SENDER, 'sendTransaction', [v.b64, opts]), post(HELIUS_SENDER, 'sendBundle', [[v.b64], { encoding: 'base64' }]));
      } else if (v.service === 'jito') {
        const r = this.jitoRegion();
        if (r) sends.push(post(r + '/bundles', 'sendBundle', [[v.b64], { encoding: 'base64' }]), post(r + '/transactions', 'sendTransaction', [v.b64, { encoding: 'base64' }]));
      } else if (v.service === 'nozomi') {
        if (this.due('nozomi', SNIPE_SERVICES.nozomi.gapMs)) for (const u of NOZOMI_URLS) sends.push(post(`${u}/?c=${encodeURIComponent(c.keys.nozomi)}`, 'sendTransaction', [v.b64, opts]));
      } else if (v.service === 'falcon') {
        if (this.due('falcon', SNIPE_SERVICES.falcon.gapMs)) for (const u of FALCON_URLS) sends.push(postBlind(`${u}/?api-key=${encodeURIComponent(c.keys.falcon)}`, 'sendTransaction', [v.b64, opts]));
      } else if (v.service === 'custom') {
        if (this.due('custom', SNIPE_SERVICES.custom.gapMs)) sends.push(post(c.customUrl, 'sendTransaction', [v.b64, opts]));
      }
    }
    await Promise.allSettled(sends);
  }

  async fire(trigger) {
    if (this.state === 'firing' || this.state === 'landed' || this.stopped) return;
    this.setState('firing', { trigger });
    this.firedAt = Date.now();
    // Blockhash mode: one signature from here on, never re-signed mid-blast -
    // two live signatures could both land and the second would fail on the
    // existing mint with its fee paid. The armed loop re-signs every 20s, so
    // it is fresh unless re-signing fell behind; then it is replaced once,
    // before anything is sent. Nonce copies do not age.
    if (!this.nonce && Date.now() - this.cur.signedAt > 40_000) { this.log('signature ageing - re-signing before the first send'); await this.resign().catch(() => {}); }
    this.log(`APPROVED (${trigger}) - blasting ${this.variants.length} cop${this.variants.length === 1 ? 'y' : 'ies'} everywhere`);
    const blast = () => {
      if (this.state !== 'firing') return;
      this.sendEverywhere().catch(() => {});
      const since = Date.now() - this.firedAt;
      this.after(since < 4000 ? 80 : 400, blast);
    };
    blast();
    this.every(300, () => this.checkLanded().catch(() => {}));
    this.after(90_000, () => { if (this.state === 'firing') { this.log('gave up after 90s without landing'); this.setState('failed', { reason: 'did not land in 90s' }); this.stop(); } });
  }

  async checkLanded() {
    if (this.state === 'landed' || this.stopped || !this.prep) return;
    const conn = this.conn(Math.floor(Math.random() * 10));
    const recent = this.sigs.slice(-60);
    const st = await conn.getSignatureStatuses(recent).catch(() => null);
    const hit = st?.value?.findIndex((v) => v && v.confirmationStatus);
    if (hit == null || hit < 0) return;
    const v = st.value[hit];
    const sig = recent[hit];
    const via = this.variants?.find((x) => x.sig === sig)?.service;
    if (v.err) {
      // a landed failure: stop at once so it cannot be paid for twice (with a
      // nonce the other copies are already dead - the nonce moved)
      this.log(`landed but FAILED: ${JSON.stringify(v.err)} (${sig.slice(0, 10)}…${via ? ' via ' + via : ''}) - stopping`);
      this.setState('failed', { reason: JSON.stringify(v.err), sig });
      this.stop();
      return;
    }
    this.setState('landed', { sig, mint: this.prep.mint, via });
    this.log(`LANDED ${sig.slice(0, 10)}…${via ? ' via ' + SNIPE_SERVICES[via]?.label : ''} - mint ${this.prep.mint}`);
    this.stop();
    const report = await landingReport(this.cfg.rpcUrls[0], { mint: this.prep.mint, configId: this.configId }).catch(() => null);
    if (report) {
      this.log(report.sameBlock
        ? `SAME BLOCK as the approval ✓ - slot ${report.launchSlot}, approval at index ${report.approvalIndex}, ours at ${report.launchIndex}`
        : `${report.slotsAfter} slot(s) after the approval (approval slot ${report.approvalSlot} idx ${report.approvalIndex}, ours slot ${report.launchSlot} idx ${report.launchIndex})`);
      this.hooks.onState?.('landed', { sig, mint: this.prep.mint, via, report });
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) { t.loop = false; cancel(t); }
    this.timers = [];
    for (const [conn, id] of this.subs) conn.removeAccountChangeListener(id).catch(() => {});
    this.subs = [];
  }

  disarm() {
    if (this.state === 'landed') return;
    this.stop();
    this.setState('disarmed');
    this.log('disarmed');
  }
}

export { RAYDIUM_ADMIN };
