// Launch a pump.fun coin at a slot (the first Alpenglow block, 459,653,000).
// Pure + engine checks always run; the live simulation needs RPC=<url>.
//   RPC=https://... node test/js/slot-launch.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { slotGuardIx, SlotLaunch, LIGHTHOUSE_PROGRAM, ALPENGLOW_SLOT } from '../../src/slotLaunch.js';
import { buildSnipeTx, signSnipe, SNIPE_SERVICES } from '../../src/stonkSnipe.js';
import { buildPumpLaunch, pumpStatus, PUMP_LOOKUP_TABLE } from '../../src/pump.js';
const RPC = process.env.RPC || process.env.SOL_RPC;
const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');

// --- the guard -----------------------------------------------------------------
{
  const ix = slotGuardIx(ALPENGLOW_SLOT);
  check(ix.programId.toBase58() === LIGHTHOUSE_PROGRAM && ix.keys.length === 0, 'the guard is a Lighthouse instruction with no accounts');
  // lighthouse-sdk 2.1.0: u8 15 (AssertSysvarClock), u8 log level, u8 tag 0 (Slot), u64 slot, u8 4 (>=)
  check(Buffer.from(ix.data).toString('hex') === '0f0000' + Buffer.from(new BigUint64Array([BigInt(ALPENGLOW_SLOT)]).buffer).toString('hex') + '04',
    'and encodes "Clock.slot >= 459,653,000"', Buffer.from(ix.data).toString('hex'));
}

// --- the engine's schedule, with a fake clock and stubbed sends --------------------
{
  const kp = Keypair.generate(), mint = Keypair.generate();
  const sl = new SlotLaunch({ rpcUrls: ['http://127.0.0.1:1'], secretKey: bs58.encode(kp.secretKey), targetSlot: 1_000, bundleLeadSlots: 40, sendLeadSlots: 1, spamMs: 0 });
  const sent = { bundles: 0, plain: 0 };
  sl.fan = { sendBundles: async () => { sent.bundles++; }, sendAll: async () => { sent.plain++; } };
  sl.prep = { mint: mint.publicKey.toBase58(), instructions: [], mintKeypair: mint, lookupTable: null };
  sl.copies = [{ service: 'jito', b64: 'AA==', sig: 'x' }];
  sl.state = 'armed';
  sl.msPerSlot = 1e9;                       // freeze the extrapolation
  const at = (slot) => { sl.slot = slot; sl.slotAt = Date.now(); sl.tick(); };
  at(900);
  check(sent.bundles === 0 && sent.plain === 0 && sl.state === 'armed', 'far from the target: nothing is sent');
  at(965);
  check(sent.bundles > 0 && sent.plain === 0 && sl.state === 'armed', 'inside the bundle lead: bundles only (a failed bundle costs nothing)');
  at(999);
  check(sl.state === 'firing' && sent.plain > 0, 'one slot out: plain sends start on every route');
  // an early landing the guard stopped, with a backup set: it fires at once
  const early = { value: [{ err: { InstructionError: [1, { Custom: 6001 }] }, confirmationStatus: 'processed', slot: 999 }] };
  sl.conn = () => ({ getSignatureStatuses: async () => early });
  sl.nonce = { account: 'n', value: 'v' };
  sl.sigs = ['early'];
  sl.copies = [{ service: 'jito', b64: 'AA==', sig: 'early' }];
  sl.backup = { nonce: { account: 'b', value: 'bv' }, copies: [{ service: 'jito', b64: 'BB==', sig: 'backup1' }] };
  sl.nonceValue = async () => 'moved';
  sl.signSet = (nonce) => [{ service: 'jito', b64: 'CC==', sig: 'next-' + nonce.value }];
  const before = sent.plain;
  await sl.checkLanded();
  check(sl.copies[0].sig === 'backup1' && sl.nonce.account === 'b' && sent.plain > before && sl.state === 'firing',
    'a copy that lands early (guard 6001) swaps in the pre-signed backup set and sends it at once');
  await new Promise((r) => setTimeout(r, 20));
  check(sl.backup?.copies[0].sig === 'next-moved' && sl.backup.nonce.account === 'n', 'and the spent nonce becomes the next backup once it moves');
  // without a backup: re-sign on the moved nonce, not the spent value
  sl.backup = null;
  sl.sigs = ['backup1'];
  await sl.checkLanded();
  check(sl.copies[0].sig === 'next-moved' && sl.nonce.value === 'moved' && !sl.stopped, 'with no backup it re-signs against the moved nonce');
  sl.stop();
}

// --- a fractional plain-send lead --------------------------------------------------
{
  const kp = Keypair.generate(), mint = Keypair.generate();
  const sl = new SlotLaunch({ rpcUrls: ['http://127.0.0.1:1'], secretKey: bs58.encode(kp.secretKey), targetSlot: 1_000, bundleLeadSlots: 0, sendLeadSlots: 2.5, spamMs: 0 });
  sl.fan = { sendBundles: async () => {}, sendAll: async () => {} };
  sl.prep = { mint: mint.publicKey.toBase58(), instructions: [], mintKeypair: mint, lookupTable: null };
  sl.copies = [{ service: 'jito', b64: 'AA==', sig: 'x' }];
  sl.state = 'armed';
  sl.msPerSlot = 1000;
  sl.slot = 997; sl.slotAt = Date.now() - 300; sl.tick();        // ~997.3: 2.7 slots out
  const held = sl.state === 'armed';
  sl.slotAt = Date.now() - 600; sl.tick();                         // ~997.6: 2.4 slots out
  check(held && sl.state === 'firing', 'a 2.5-slot lead fires between whole slots (held at 2.7 out, fired at 2.4)');
  sl.stop();
}

// --- wiring --------------------------------------------------------------------
{
  const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
  for (const id of ['slotTarget', 'slotPrio', 'slotTip', 'slotBundleLead', 'slotSendLead', 'slotArmBtn', 'slotClock', 'slotLog', 'slotSenderHost', 'snipeSenderHost', 'senderBox']) {
    check(HTML.includes(`id="${id}"`), `UI has #${id}`);
  }
  check(/new SlotLaunch\(\{[^}]*secretKey: solKeyB58/.test(MAIN) && !/localStorage[^\n]*solKeyB58/.test(MAIN), 'the wallet key goes only to the live launcher');
}

if (!RPC) { console.log('SKIP  set RPC=<url> for the live simulation'); process.exit(fails.length ? 1 : 0); }

// --- live: the whole transaction, simulated --------------------------------------
// A read-only simulation against an existing durable nonce account (the
// 2026-10-19 StonkFun winner's), with its authority as payer: AdvanceNonce,
// the guard, pump.fun create_v2 via its lookup table, and a Jito tip.
{
  const conn = new Connection(RPC, 'confirmed');
  const NONCE = 'HgZamge8AwTdM6Z34LMPatLTfybo74Az46R1khMTM2KX';
  const n = await conn.getNonce(new PublicKey(NONCE), 'confirmed').catch(() => null);
  if (!n) console.log('SKIP  fixture nonce account is gone');
  else {
    const payer = n.authorizedPubkey;
    const mint = Keypair.generate();
    const g = await pumpStatus(RPC);
    const built = await buildPumpLaunch({ connection: conn, payer: { publicKey: payer }, mint, name: 'Alpenglow test', symbol: 'GLOW', uri: 'https://example.com/m.json', global: g, returnIxs: true });
    const prep = { instructions: built.instructions, mintKeypair: mint, lookupTable: built.lookupTable };
    const now = await conn.getSlot('processed');
    const run = async (slot) => {
      const { tx } = buildSnipeTx(prep, {
        payer, nonce: { account: NONCE, value: n.nonce }, cuLimit: 605_000, prioSol: 0.0001, tipSol: 0.001,
        tipAccount: SNIPE_SERVICES.jito.tips[0], guardIxs: [slotGuardIx(slot)], luts: [built.lookupTable],
      });
      const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' });
      return { err: sim.value.err, cu: sim.value.unitsConsumed, size: tx.serialize().length };
    };
    const past = await run(now - 100);
    check(!past.err, 'nonce + guard (slot already passed) + pump.fun launch + tip simulates clean', `${past.cu} CU · ${past.size} bytes`);
    const future = await run(ALPENGLOW_SLOT);
    check(JSON.stringify(future.err) === JSON.stringify({ InstructionError: [1, { Custom: 6001 }] }),
      'the same launch aimed at 459,653,000 fails on the guard (instruction 1) - it cannot land early', JSON.stringify(future.err));
    // sized as the real signed copies are
    const signed = signSnipe(prep, { secretKey: bs58.encode(Keypair.generate().secretKey), nonce: { account: NONCE, value: n.nonce }, cuLimit: 605_000, prioSol: 0.05, tipSol: 0.01, tipAccount: SNIPE_SERVICES.helius.tips[0], guardIxs: [slotGuardIx(ALPENGLOW_SLOT)], luts: [built.lookupTable] });
    check(signed.size <= 1232, 'a signed copy fits a transaction', `${signed.size} bytes`);
    void PUMP_LOOKUP_TABLE;
  }
}
console.log('');
process.exit(fails.length ? 1 : 0);
