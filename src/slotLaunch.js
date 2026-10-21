// Launch a pump.fun coin AT a given slot - e.g. the first Alpenglow block
// (Solana's switch from TowerBFT, slot 459,653,000 on 2026-10-21).
//
// A transaction cannot be told which slot to land in, but it can be told which
// slots it must NOT land in. The launch opens with a Lighthouse assertion
// (L2TExM...; deployed on mainnet, checked 2026-10-21) that the Clock sysvar's
// slot is >= the target, so landing a slot early is impossible: it fails.
// With that in place:
//
//   1. the launch is built and simulated now (launchPump prebuild), then
//      signed against a durable nonce once per landing service, each copy
//      tipping that service. Nonce copies never expire, so this can be done
//      hours ahead; the copies share the nonce, so only one can ever land.
//   2. a slot clock follows the chain (websocket slot notifications + polling).
//   3. from `bundleLeadSlots` before the target the Jito/Helius copies go out
//      as bundles, over and over. Before the target they fail the guard and are
//      dropped - a failed bundle costs nothing - so the first one a leader tries
//      at the target slot or later lands.
//   4. from `sendLeadSlots` before the target (as the clock sees it, which runs
//      a little behind the chain) every copy is also sent plainly down every
//      route. A plain send that reaches a leader a slot early lands FAILED - the
//      guard stops it - and its fee is paid. That also moves the nonce, killing
//      the other copies, so the launcher re-signs at once against the new nonce
//      and keeps going; by then the target has arrived.
//   5. it reports the slot it landed in, and whether that was the first block
//      produced at or after the target.

import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { launchPump } from './pump.js';
import { keypairFromSecret } from './solana.js';
import {
  SNIPE_SERVICES, Fanout, usableServices, signSnipe, buildSnipeTx, createNonceAccount, readNonce,
  tickAfter, tickCancel,
} from './stonkSnipe.js';

export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
/// Alpenglow takes over from TowerBFT here (5,000 slots into epoch 1064).
export const ALPENGLOW_SLOT = 459_653_000;
/// Lighthouse's AssertionFailed
const GUARD_FAILED = 6001;

/// Lighthouse AssertSysvarClock: Clock.slot >= `slot`, no accounts.
/// Layout (lighthouse-sdk 2.1.0): u8 discriminator 15, u8 log level (0 =
/// silent), u8 SysvarClockAssertion tag (0 = Slot), u64 value, u8 operator
/// (4 = GreaterThanOrEqual).
export function slotGuardIx(slot) {
  const data = new Uint8Array(12);
  data[0] = 15; data[1] = 0; data[2] = 0;
  new DataView(data.buffer).setBigUint64(3, BigInt(slot), true);
  data[11] = 4;
  return new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM), keys: [], data: Buffer.from(data) });
}

export class SlotLaunch {
  constructor(cfg, hooks = {}) {
    // cfg: rpcUrls[], secretKey, targetSlot, name, symbol, uri, devBuySol,
    //      feesToHolders, creatorFeeBps, creatorAddress, quoteMint,
    //      prioSol, tipSol, services[], keys { nozomi, falcon }, customUrl,
    //      customTipAccount, useNonce, nonceAccount, backupNonceAccount,
    //      bundleLeadSlots, sendLeadSlots (may be fractional), spamMs
    this.cfg = { bundleLeadSlots: 40, sendLeadSlots: 2, spamMs: 100, useNonce: true, keys: {}, ...cfg };
    this.hooks = hooks;
    this.state = 'idle';
    this.sigs = [];
    this.timers = [];
    this.subs = [];
    this.stopped = false;
    this.slot = 0;            // highest slot seen
    this.slotAt = 0;          // when it was seen
    this.msPerSlot = 400;     // refined from the clock
    this.earlyRetries = 0;
    this.fan = new Fanout(this.cfg);
  }

  log(m) { this.hooks.onLog?.(`${new Date().toISOString().slice(11, 23)} ${m}`); }
  setState(s, d) { this.state = s; this.hooks.onState?.(s, d); }
  after(ms, fn) { const h = tickAfter(ms, fn); this.timers.push(h); return h; }
  every(ms, fn) {
    const h = { id: null, t: null, loop: true };
    const run = () => { if (this.stopped || !h.loop) return; fn(); Object.assign(h, tickAfter(ms, run)); };
    Object.assign(h, tickAfter(ms, run));
    this.timers.push(h);
    return h;
  }
  conn(i = 0) { return new Connection(this.cfg.rpcUrls[i % this.cfg.rpcUrls.length], 'processed'); }

  /// where the chain is now, extrapolated from the last slot seen
  estSlot() { return Math.floor(this.estSlotF()); }
  /// the same with the fraction of the current slot, so a lead can be 2.5
  estSlotF() { return this.slot + Math.max(0, (Date.now() - this.slotAt) / this.msPerSlot); }
  eta(slot) { return new Date(Date.now() + (slot - this.estSlot()) * this.msPerSlot); }

  seeSlot(s) {
    if (s <= this.slot) return;
    const now = Date.now();
    if (this.slot && this.slotAt) {
      const per = (now - this.slotAt) / (s - this.slot);
      if (per > 50 && per < 2000) this.msPerSlot = this.msPerSlot * 0.9 + per * 0.1;
    }
    this.slot = s; this.slotAt = now;
  }

  async checkFunds() {
    const c = this.cfg;
    const lamports = await this.conn(0).getBalance(new PublicKey(this.owner), 'confirmed');
    const need = Number(c.prioSol || 0) + Number(c.tipSol || 0) + Number(c.devBuySol || 0) + 0.03
      + (c.useNonce && !c.nonceAccount ? 0.0016 : 0) + (c.useNonce && !c.backupNonceAccount ? 0.0016 : 0);
    if (lamports / 1e9 < need) throw new Error(`the wallet has ${(lamports / 1e9).toFixed(4)} SOL; this launch needs about ${need.toFixed(4)} (dev buy + priority + bribe + ~0.03 rent)`);
  }

  baseSign() {
    const c = this.cfg;
    return {
      secretKey: c.secretKey, cuLimit: this.cuLimit, prioSol: c.prioSol, tipSol: c.tipSol,
      guardIxs: [slotGuardIx(c.targetSlot)], luts: [this.prep.lookupTable],
    };
  }
  tipFor(svc) { return svc === 'custom' ? this.cfg.customTipAccount : SNIPE_SERVICES[svc].tips[Math.floor(Math.random() * SNIPE_SERVICES[svc].tips.length)]; }

  /// One copy per service against `nonce` ({ account, value }), each opening
  /// with the slot guard - plus a Jito copy for the bundles.
  signSet(nonce) {
    const base = this.baseSign();
    const want = [...new Set([...this.services, 'jito'])];
    return want.map((service) => ({ service, ...signSnipe(this.prep, { ...base, nonce, tipAccount: this.tipFor(service) }) }));
  }

  /// A nonce's value, optionally waiting (up to `waitMs`) for it to move off
  /// `notValue`. After an early landing the recovery reads at 'processed':
  /// 'confirmed' trails by a slot or two and would hand back the spent value,
  /// re-signing copies that can never land.
  async nonceValue(account, { commitment = 'confirmed', notValue = null, waitMs = 0 } = {}) {
    const until = Date.now() + waitMs;
    for (;;) {
      const v = await readNonce(this.conn(0), account, this.owner, commitment).catch(() => null);
      if (v && v !== notValue) return v;
      if (Date.now() >= until) return null;
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  /// The main set: one copy per service (nonce) or a single copy (blockhash).
  async sign() {
    if (this.nonce) {
      const value = await this.nonceValue(this.nonce.account);
      if (!value) throw new Error('the nonce account ' + this.nonce.account.slice(0, 8) + '… is gone or not this wallet\'s');
      this.nonce.value = value;
      this.copies = this.signSet(this.nonce);
    } else {
      const { blockhash } = await this.conn(0).getLatestBlockhash('confirmed');
      const service = this.services[0];
      this.copies = [{ service, ...signSnipe(this.prep, { ...this.baseSign(), blockhash, tipAccount: this.tipFor(service) }) }];
    }
    this.signedAt = Date.now();
    for (const v of this.copies) this.sigs.push(v.sig);
    return this.copies;
  }

  /// The backup set: the same launch on a SECOND nonce, signed ahead and held.
  /// It is only sent once a main copy has landed early - which moved the main
  /// nonce and so already killed every main copy - so it can never launch
  /// twice or pay twice; it just skips the wait to re-sign.
  async setupBackup() {
    const c = this.cfg;
    let account = c.backupNonceAccount && c.backupNonceAccount !== this.nonce.account
      && await readNonce(this.conn(0), c.backupNonceAccount, this.owner) ? c.backupNonceAccount : null;
    if (!account) {
      this.log('opening a second nonce account for the backup set (one-time, ~0.0015 SOL rent)…');
      account = await createNonceAccount(new Connection(c.rpcUrls[0], 'confirmed'), c.secretKey);
      this.hooks.onNonce?.(account);
    }
    const nonce = { account, value: await this.nonceValue(account) };
    if (!nonce.value) throw new Error('could not read the backup nonce');
    this.backup = { nonce, copies: this.signSet(nonce) };
    this.log(`backup set ready on nonce ${account.slice(0, 8)}… - fires instantly if a copy lands early`);
  }

  /// Simulate the launch exactly as signed, minus the slot guard (which would
  /// fail before the target): proves the nonce, tip, lookup table and launch.
  async preflight() {
    const c = this.cfg;
    const { tx } = buildSnipeTx(this.prep, {
      payer: this.owner, ...(this.nonce ? { nonce: this.nonce } : { blockhash: (await this.conn(0).getLatestBlockhash()).blockhash }),
      cuLimit: this.cuLimit, prioSol: c.prioSol, tipSol: c.tipSol, tipAccount: SNIPE_SERVICES.jito.tips[0], luts: [this.prep.lookupTable],
    });
    const sim = await this.conn(0).simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' });
    return { ok: !sim.value.err, err: sim.value.err, cu: sim.value.unitsConsumed, logs: sim.value.logs || [] };
  }

  async arm() {
    const c = this.cfg;
    this.setState('preparing');
    this.owner = keypairFromSecret(c.secretKey).publicKey.toBase58();
    this.services = usableServices(c, (m) => this.log(m));
    if (!this.services.length) throw new Error('no usable landing service - tick one and enter its key');
    if (!(Number(c.targetSlot) > 0)) throw new Error('enter the target slot');
    await this.checkFunds();

    this.seeSlot(await this.conn(0).getSlot('processed'));
    if (this.slot >= c.targetSlot) this.log(`slot ${c.targetSlot} has already passed (now ${this.slot}) - this will launch at once`);

    this.log('building + simulating the pump.fun launch…');
    this.prep = await launchPump({
      rpcUrl: c.rpcUrls[0], secretKey: c.secretKey, name: c.name, symbol: c.symbol, uri: c.uri,
      devBuySol: c.devBuySol || '0', cashback: false, feesToHolders: !!c.feesToHolders,
      creatorFeeBps: c.creatorFeeBps || 0, creatorAddress: c.creatorAddress || undefined, quoteMint: c.quoteMint || undefined,
      prebuild: true, onStatus: (m) => this.log(m),
    });
    this.cuLimit = Math.min(1_400_000, this.prep.computeUnits + 5_000);   // + guard and nonce

    if (c.useNonce) {
      try {
        let account = c.nonceAccount && await readNonce(this.conn(0), c.nonceAccount, this.owner) ? c.nonceAccount : null;
        if (!account) {
          this.log('opening a durable nonce account (one-time, ~0.0015 SOL rent)…');
          account = await createNonceAccount(new Connection(c.rpcUrls[0], 'confirmed'), c.secretKey);
          this.hooks.onNonce?.(account);
          this.log(`nonce account ${account}`);
        }
        this.nonce = { account, value: null };
        await this.sign();
        if (this.copies.some((v) => v.size > 1232)) { this.log('with the nonce the launch is over 1232 bytes - falling back to one blockhash copy'); this.nonce = null; }
      } catch (e) { this.log('nonce unavailable (' + e.message + ') - falling back to one blockhash copy'); this.nonce = null; }
    }
    if (!this.nonce) await this.sign();
    else await this.setupBackup().catch((e) => { this.backup = null; this.log('no backup set (' + e.message + ') - an early landing will re-sign instead'); });
    if (this.copies[0].size > 1232) throw new Error(`the launch is ${this.copies[0].size} bytes, over Solana's 1232 - shorten the name, ticker or metadata URI`);

    const pf = await this.preflight();
    if (!pf.ok) throw new Error('the signed launch would fail: ' + JSON.stringify(pf.err) + ' ' + (pf.logs.find((l) => /Error/.test(l)) || ''));
    this.log(`built ${this.prep.mint.slice(0, 6)}… · ${this.copies[0].size} bytes · preflight OK (${pf.cu} CU) · prio ${c.prioSol} SOL over ${this.cuLimit} CU · bribe ${c.tipSol} SOL`
      + ` · ${this.nonce ? `nonce: ${this.copies.length} copies (${this.copies.map((v) => SNIPE_SERVICES[v.service].label).join(' + ')})` : `one blockhash copy via ${SNIPE_SERVICES[this.copies[0].service].label}`}`);

    this.setState('armed', { mint: this.prep.mint, nonceAccount: this.nonce?.account || null });
    this.watchSlots();
    // a blockhash copy dies in ~60s; a nonce copy only if the nonce moves
    this.every(this.nonce ? 30_000 : 20_000, async () => {
      if (this.state !== 'armed') return;
      if (this.nonce) {
        const v = await readNonce(this.conn(0), this.nonce.account, this.owner).catch(() => null);
        if (v && v !== this.nonce.value) { this.log('nonce moved - re-signing'); await this.sign().catch((e) => this.log('re-sign failed: ' + e.message)); }
        if (this.backup) {
          const b = await readNonce(this.conn(0), this.backup.nonce.account, this.owner).catch(() => null);
          if (b && b !== this.backup.nonce.value) { this.backup.nonce.value = b; this.backup.copies = this.signSet(this.backup.nonce); this.log('backup nonce moved - re-signed the backup set'); }
        }
      } else await this.sign().catch((e) => this.log('re-sign failed: ' + e.message));
    });
    // a last full check ~30s before the target
    this.preflightDone = false;
    this.every(50, () => this.tick());
    // landing checks: every 150ms once firing, every 600ms before
    this.every(150, () => { if (this.state === 'firing' || this.due('check', 600)) this.checkLanded().catch(() => {}); });
    // and at once whenever a nonce moves - an early landing moves it
    for (const acct of [this.nonce?.account, this.backup?.nonce.account].filter(Boolean)) {
      try {
        const u = c.rpcUrls[0];
        const conn = new Connection(u, { commitment: 'processed', wsEndpoint: u.replace(/^http/, 'ws') });
        const id = conn.onAccountChange(new PublicKey(acct), () => this.checkLanded().catch(() => {}), 'processed');
        this.subs.push([conn, id, 'account']);
      } catch { /* the polling covers it */ }
    }
    this.log(`armed for slot ${c.targetSlot.toLocaleString()} · now ${this.slot.toLocaleString()} · ~${Math.round((c.targetSlot - this.slot) * this.msPerSlot / 1000)}s at ${Math.round(this.msPerSlot)}ms/slot`);
  }

  watchSlots() {
    this.cfg.rpcUrls.forEach((u, i) => {
      try {
        const conn = new Connection(u, { commitment: 'processed', wsEndpoint: u.replace(/^http/, 'ws') });
        const id = conn.onSlotChange((s) => this.seeSlot(s.slot));
        this.subs.push([conn, id]);
      } catch (e) { this.log('slot websocket ' + (i + 1) + ' failed: ' + e.message); }
    });
    let n = 0;
    this.every(300, async () => { const s = await this.conn(n++).getSlot('processed').catch(() => 0); if (s) this.seeSlot(s); });
  }

  tick() {
    if (this.stopped) return;
    const c = this.cfg;
    const est = this.estSlot();
    const left = c.targetSlot - est;
    this.hooks.onClock?.({ slot: this.slot, est, left, msPerSlot: this.msPerSlot, eta: this.eta(c.targetSlot), state: this.state });
    if (this.state === 'armed' && !this.preflightDone && left <= Math.ceil(30_000 / this.msPerSlot)) {
      this.preflightDone = true;
      this.preflight().then((pf) => this.log(pf.ok ? `T-30s preflight OK (${pf.cu} CU)` : `T-30s preflight FAILED: ${JSON.stringify(pf.err)} - pump may have changed; disarm and re-arm`)).catch(() => {});
    }
    // bundles: free until they land
    if ((this.state === 'armed' || this.state === 'firing') && left <= c.bundleLeadSlots && this.due('bundle', c.spamMs)) {
      this.fan.sendBundles(this.copies).catch(() => {});
    }
    // plain sends: everything, every route. The lead is in slots and may be
    // fractional (2.5): tested 2026-10-21, a lead of 2 landed one slot late and
    // 3 one slot early, so the line sits between.
    const leftF = c.targetSlot - this.estSlotF();
    if (this.state === 'armed' && leftF <= c.sendLeadSlots) {
      this.setState('firing', { slot: this.slot });
      this.firedAt = Date.now();
      this.log(`T-${Math.max(0, leftF).toFixed(2)} slots (seen ${this.slot.toLocaleString()}) - sending ${this.copies.length} cop${this.copies.length === 1 ? 'y' : 'ies'} down every route`);
      this.after(120_000, () => { if (this.state === 'firing') { this.log('gave up 120s after firing without landing'); this.setState('failed', { reason: 'did not land' }); this.stop(); } });
    }
    if (this.state === 'firing' && this.due('plain', Date.now() - this.firedAt < 6000 ? 80 : 400)) {
      this.fan.sendAll(this.copies, this.copies[0].b64).catch(() => {});
    }
  }

  due(key, gap) {
    this.lastTick = this.lastTick || new Map();
    const now = Date.now();
    if (now - (this.lastTick.get(key) || 0) < gap) return false;
    this.lastTick.set(key, now);
    return true;
  }

  async checkLanded() {
    if (this.stopped || !this.copies || this.state === 'landed' || this.busy) return;
    this.busy = true;
    try { await this.checkLandedOnce(); } finally { this.busy = false; }
  }

  async checkLandedOnce() {
    const recent = this.sigs.slice(-60);
    const st = await this.conn(Math.floor(Math.random() * 10)).getSignatureStatuses(recent).catch(() => null);
    const hit = st?.value?.findIndex((v) => v && v.confirmationStatus);
    if (hit == null || hit < 0) return;
    const v = st.value[hit];
    const sig = recent[hit];
    const via = this.copies.find((x) => x.sig === sig)?.service;
    if (v.err) {
      const ie = v.err.InstructionError;
      const guardIndex = this.nonce ? 1 : 0;
      if (ie && ie[0] === guardIndex && ie[1]?.Custom === GUARD_FAILED) {
        // landed a slot early: the guard stopped it, the fee is paid, and (with
        // a nonce) every other copy of that set is dead.
        this.earlyRetries++;
        const dead = new Set(this.copies.map((x) => x.sig));
        this.sigs = this.sigs.filter((s) => !dead.has(s));
        if (this.earlyRetries > 4) { this.setState('failed', { reason: 'kept landing early', sig }); this.stop(); return; }
        if (!this.nonce) {
          this.log(`a copy reached slot ${v.slot ?? '?'} - before the target - and the guard stopped it (its fee is paid). Re-signing…`);
          await this.sign().catch((e) => this.log('re-sign failed: ' + e.message));
          return;
        }
        const spent = this.nonce;
        if (this.backup) {
          // swap in the pre-signed backup set and send it at once
          this.nonce = this.backup.nonce; this.copies = this.backup.copies; this.backup = null;
          for (const x of this.copies) this.sigs.push(x.sig);
          this.log(`a copy reached slot ${v.slot ?? '?'} - before the target - and the guard stopped it (its fee is paid). Backup set fired instantly (${this.earlyRetries})`);
          this.fan.sendAll(this.copies, this.copies[0].b64).catch(() => {});
          this.fan.sendBundles(this.copies).catch(() => {});
          // the spent nonce becomes the next backup once it has moved
          this.nonceValue(spent.account, { commitment: 'processed', notValue: spent.value, waitMs: 8000 }).then((value) => {
            if (!value || this.stopped || this.state === 'landed') return;
            const nonce = { account: spent.account, value };
            this.backup = { nonce, copies: this.signSet(nonce) };
            this.log('new backup set ready');
          }).catch(() => {});
          return;
        }
        this.log(`a copy reached slot ${v.slot ?? '?'} - before the target - and the guard stopped it (its fee is paid). Re-signing on the moved nonce (${this.earlyRetries})…`);
        const value = await this.nonceValue(spent.account, { commitment: 'processed', notValue: spent.value, waitMs: 8000 });
        if (!value) { this.log('the nonce did not move - cannot re-sign'); return; }
        this.nonce = { account: spent.account, value };
        this.copies = this.signSet(this.nonce);
        this.signedAt = Date.now();
        for (const x of this.copies) this.sigs.push(x.sig);
        return;
      }
      this.log(`landed but FAILED: ${JSON.stringify(v.err)} (${sig.slice(0, 10)}…) - stopping`);
      this.setState('failed', { reason: JSON.stringify(v.err), sig });
      this.stop();
      return;
    }
    this.setState('landed', { sig, mint: this.prep.mint, via });
    this.log(`LANDED ${sig.slice(0, 10)}…${via ? ' via ' + SNIPE_SERVICES[via].label : ''} - mint ${this.prep.mint}`);
    this.stop();
    const report = await this.report(sig).catch(() => null);
    if (report) {
      this.log(report.firstBlock
        ? `FIRST BLOCK ✓ - slot ${report.slot.toLocaleString()} (target ${this.cfg.targetSlot.toLocaleString()}), position ${report.index} in the block`
        : `slot ${report.slot.toLocaleString()}, ${report.slot - this.cfg.targetSlot} after the target; ${report.blocksBefore} block(s) were produced at/after the target before it · position ${report.index}`);
      this.hooks.onState?.('landed', { sig, mint: this.prep.mint, via, report });
    }
  }

  /// the landing slot, its position, and whether any block at/after the target
  /// came before it
  async report(sig) {
    const conn = new Connection(this.cfg.rpcUrls[0], 'confirmed');
    let t = null;
    for (let i = 0; i < 10 && !t; i++) { t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null); if (!t) await new Promise((r) => setTimeout(r, 800)); }
    if (!t) return null;
    const produced = await conn.getBlocks(this.cfg.targetSlot, t.slot, 'confirmed').catch(() => []);
    const before = produced.filter((s) => s < t.slot).length;
    let index = null;
    const blk = await conn.getBlock(t.slot, { maxSupportedTransactionVersion: 0, transactionDetails: 'signatures', rewards: false }).catch(() => null);
    if (blk) index = blk.signatures.indexOf(sig);
    return { slot: t.slot, index, blocksBefore: before, firstBlock: before === 0 && t.slot >= this.cfg.targetSlot };
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) { t.loop = false; tickCancel(t); }
    this.timers = [];
    for (const [conn, id, kind] of this.subs) (kind === 'account' ? conn.removeAccountChangeListener(id) : conn.removeSlotChangeListener(id)).catch(() => {});
    this.subs = [];
  }

  disarm() {
    if (this.state === 'landed') return;
    this.stop();
    this.setState('disarmed');
    this.log('disarmed');
  }
}
