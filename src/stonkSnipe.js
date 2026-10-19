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
// lands before it would fail and still pay the full priority fee. After that
// one signature is kept until its blockhash expires, so a failure can land at
// most once.

import { Connection, PublicKey, ComputeBudgetProgram, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
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

/// Sign the prepared launch with a priority fee (total SOL, spread over the
/// compute limit) and a bribe (SOL to a tip account), against `blockhash`.
export function signSnipe(prep, { secretKey, blockhash, cuLimit = 300_000, prioSol = 0, tipSol = 0, tipAccount = null }) {
  const owner = keypairFromSecret(secretKey);
  const prioLamports = Math.round(Number(prioSol) * 1e9);
  const microLamports = Math.max(0, Math.ceil((prioLamports * 1e6) / cuLimit));
  const tipLamports = Math.round(Number(tipSol) * 1e9);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...prep.instructions,
    ...(tipLamports > 0 && tipAccount ? [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: new PublicKey(tipAccount), lamports: tipLamports })] : []),
  ];
  const msg = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([owner, prep.mintKeypair]);
  const raw = tx.serialize();
  const sig = (() => { const b = tx.signatures[0]; let s = ''; const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const x of b) n = n * 256n + BigInt(x); while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x === 0) s = '1' + s; else break; } return s; })();
  return { tx, raw, b64: toB64(raw), sig, size: raw.length, microLamports, prioLamports, tipLamports };
}

/// Where a landed launch sits against the approval: slot and index of each.
export async function landingReport(rpcUrl, { mint, configId }) {
  const rpc = (m, p) => post(rpcUrl, m, p).then((r) => r.result);
  const ours = await rpc('getSignaturesForAddress', [mint, { limit: 1000 }]);
  const launchSig = ours?.length ? ours[ours.length - 1].signature : null;
  if (!launchSig) return null;
  const lt = await rpc('getTransaction', [launchSig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  const older = await rpc('getSignaturesForAddress', [configId, { limit: 1000, before: launchSig }]);
  const approvalSig = older?.length ? older[older.length - 1].signature : null;
  const at = approvalSig ? await rpc('getTransaction', [approvalSig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]) : null;
  return {
    launchSig, launchSlot: lt?.slot ?? null, launchIndex: lt?.transactionIndex ?? null, launchErr: lt?.meta?.err ?? null,
    approvalSig, approvalSlot: at?.slot ?? null, approvalIndex: at?.transactionIndex ?? null,
    approvalBy: at?.transaction?.message?.accountKeys?.[0] ?? null,
    sameBlock: !!(lt && at && lt.slot === at.slot),
    slotsAfter: lt && at ? lt.slot - at.slot : null,
    ahead: older ? older.length - 1 : null,   // transactions on the config between approval and us
  };
}

/// One armed snipe. hooks: onLog(line), onState(state, detail).
export class StonkSnipe {
  constructor(cfg, hooks = {}) {
    // cfg: rpcUrls[], secretKey, quoteMint, platformId, name, symbol, uri,
    //      devBuyUi, raiseUi, transferFeeBps, prioSol, tipSol, service
    //      ('helius' | 'jito' | 'custom'), customTipAccount, customUrl,
    //      cuLimit, spamMs
    this.cfg = { cuLimit: 300_000, spamMs: 200, service: 'helius', ...cfg };
    this.hooks = hooks;
    this.state = 'idle';
    this.sigs = [];
    this.timers = [];
    this.subs = [];
    this.jitoLast = new Map();
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

  tipAccount() {
    if (this.cfg.service === 'helius') return pick(HELIUS_TIP_ACCOUNTS);
    if (this.cfg.service === 'jito') return pick(JITO_TIP_ACCOUNTS);
    return this.cfg.customTipAccount || null;
  }

  async resign() {
    const { blockhash } = await this.conn(0).getLatestBlockhash('confirmed');
    this.cur = signSnipe(this.prep, {
      secretKey: this.cfg.secretKey, blockhash, cuLimit: this.cfg.cuLimit,
      prioSol: this.cfg.prioSol, tipSol: this.cfg.tipSol, tipAccount: this.tipAccountFixed,
    });
    this.cur.signedAt = Date.now();
    this.sigs.push(this.cur.sig);
    return this.cur;
  }

  async arm() {
    const c = this.cfg;
    this.setState('preparing');
    if (c.service === 'helius' && Number(c.tipSol) < HELIUS_MIN_TIP_SOL) this.log(`note: Helius Sender wants a bribe of at least ${HELIUS_MIN_TIP_SOL} SOL; below that it is best-effort`);
    this.configId = raydiumConfigId(c.quoteMint).toBase58();
    await this.checkFunds();
    this.prep = await prepareSnipe({ ...c, rpcUrl: c.rpcUrls[0], onStatus: (m) => this.log(m) });
    this.tipAccountFixed = this.tipAccount();
    await this.resign();
    this.log(`built ${this.prep.mint.slice(0, 6)}… · ${this.cur.size} bytes · prio ${c.prioSol} SOL (${this.cur.microLamports} µL/CU × ${c.cuLimit}) · bribe ${c.tipSol} SOL → ${c.service}`);
    if (this.cur.size > 1232) throw new Error(`the launch is ${this.cur.size} bytes, over Solana's 1232 - shorten the name, ticker or metadata URI`);

    // already approved? then this is just a fast launch
    const exists = await this.conn(0).getAccountInfo(new PublicKey(this.configId), 'processed').catch(() => null);
    if (exists) { this.log('the quote is already approved - firing now'); return this.fire('already approved'); }

    this.setState('armed', { mint: this.prep.mint, configId: this.configId });
    this.log(`armed · watching config ${this.configId.slice(0, 8)}… for Raydium's approval`);

    // keep a fresh signature (a blockhash lives ~60s)
    this.every(20_000, () => { if (this.state === 'armed') this.resign().catch((e) => this.log('re-sign failed: ' + e.message)); });

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

    // costless bundle spam while waiting (custom services may not drop
    // failures, so they only get the post-approval blast)
    if (c.service !== 'custom') {
      const spam = async () => {
        if (this.state !== 'armed') return;
        this.sendBundle().catch(() => {});
        this.after(Math.max(50, c.spamMs), spam);
      };
      spam();
    }
    this.every(600, () => this.checkLanded().catch(() => {}));
  }

  /// Refuse to arm a snipe that would land and fail. Before the approval a
  /// failing bundle costs nothing, but after it the plain sends do, and a dev
  /// buy the wallet cannot cover fails on chain with the priority fee paid.
  async checkFunds() {
    const c = this.cfg;
    const conn = this.conn(0);
    const owner = keypairFromSecret(c.secretKey).publicKey;
    const lamports = await conn.getBalance(owner, 'confirmed');
    const needSol = Number(c.prioSol || 0) + Number(c.tipSol || 0) + 0.03;   // ~0.03 covers mint, pool and account rent
    if (lamports / 1e9 < needSol) throw new Error(`the wallet has ${(lamports / 1e9).toFixed(4)} SOL; this snipe needs about ${needSol.toFixed(4)} (priority + bribe + ~0.03 rent)`);
    const dev = Number(c.devBuyUi || 0);
    if (dev > 0) {
      const r = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(c.quoteMint) }, 'confirmed').catch(() => null);
      const held = (r?.value || []).reduce((t, a) => t + Number(a.account.data.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
      if (held < dev) throw new Error(`a dev buy of ${dev} needs the quote in the wallet - it holds ${held}. Buy the quote first or set the dev buy to 0`);
      this.log(`wallet holds ${held} of the quote; dev buy ${dev}`);
    }
  }

  async sendBundle() {
    const b = [this.cur.b64];
    if (this.cfg.service === 'helius') return post(HELIUS_SENDER, 'sendBundle', [b, { encoding: 'base64' }]);
    if (this.cfg.service === 'jito') {
      const now = Date.now();
      const region = JITO_REGIONS.find((r) => now - (this.jitoLast.get(r) || 0) >= 1000);
      if (!region) return null;
      this.jitoLast.set(region, now);
      return post(region + '/bundles', 'sendBundle', [b, { encoding: 'base64' }]);
    }
    return null;
  }

  async sendEverywhere() {
    const c = this.cfg, b64 = this.cur.b64;
    const opts = { encoding: 'base64', skipPreflight: true, maxRetries: 0 };
    const sends = c.rpcUrls.map((u) => post(u, 'sendTransaction', [b64, opts]));
    if (c.service === 'helius') sends.push(post(HELIUS_SENDER, 'sendTransaction', [b64, opts]), post(HELIUS_SENDER, 'sendBundle', [[b64], { encoding: 'base64' }]));
    if (c.service === 'jito') for (const r of JITO_REGIONS) sends.push(post(r + '/bundles', 'sendBundle', [[b64], { encoding: 'base64' }]), post(r + '/transactions', 'sendTransaction', [b64, { encoding: 'base64' }]));
    if (c.service === 'custom' && c.customUrl) sends.push(post(c.customUrl, 'sendTransaction', [b64, opts]));
    await Promise.allSettled(sends);
  }

  async fire(trigger) {
    if (this.state === 'firing' || this.state === 'landed' || this.stopped) return;
    this.setState('firing', { trigger });
    this.firedAt = Date.now();
    // One signature from here on, resent until it lands or its blockhash dies.
    // Never re-signed mid-blast: two live signatures could both land, and the
    // second would fail on the existing mint with its priority fee paid. The
    // armed loop re-signs every 20s, so the one in hand is fresh enough unless
    // re-signing fell behind - then it is replaced once, before anything is sent.
    if (Date.now() - this.cur.signedAt > 40_000) { this.log('signature ageing - re-signing before the first send'); await this.resign().catch(() => {}); }
    this.log(`APPROVED (${trigger}) - blasting ${this.cur.sig.slice(0, 10)}… everywhere`);
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
    const st = await conn.getSignatureStatuses(this.sigs.slice(-12)).catch(() => null);
    const hit = st?.value?.findIndex((v) => v && v.confirmationStatus);
    if (hit == null || hit < 0) return;
    const v = st.value[hit];
    const sig = this.sigs.slice(-12)[hit];
    if (v.err) {
      // a landed failure: stop at once so it cannot be paid for twice
      this.log(`landed but FAILED: ${JSON.stringify(v.err)} (${sig.slice(0, 10)}…) - stopping`);
      this.setState('failed', { reason: JSON.stringify(v.err), sig });
      this.stop();
      return;
    }
    this.setState('landed', { sig, mint: this.prep.mint });
    this.log(`LANDED ${sig.slice(0, 10)}… - mint ${this.prep.mint}`);
    this.stop();
    const report = await landingReport(this.cfg.rpcUrls[0], { mint: this.prep.mint, configId: this.configId }).catch(() => null);
    if (report) {
      this.log(report.sameBlock
        ? `SAME BLOCK as the approval ✓ - slot ${report.launchSlot}, approval at index ${report.approvalIndex}, ours at ${report.launchIndex}`
        : `${report.slotsAfter} slot(s) after the approval (approval slot ${report.approvalSlot} idx ${report.approvalIndex}, ours slot ${report.launchSlot} idx ${report.launchIndex})`);
      this.hooks.onState?.('landed', { sig, mint: this.prep.mint, report });
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
