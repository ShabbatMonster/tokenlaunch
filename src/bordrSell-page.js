// Bordrless coordinated multi-wallet sell page.
//
// Paste the coin and a list of private keys, pick the second selling opens
// (read off the chain by default), and at that second every wallet's sell is
// fired in parallel - pre-signed, blasted to several RPCs and Jito, and resent
// through the lock error until it confirms. Keys live only in this tab.
//
// The sell itself comes from src/bordrSell.js (the @bordrless/sdk path proven
// against the live lock). See bordr-sell.html for the shell.

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  loadBordrCoin, walletHolding, buildSignedSell, simulateSell, classifyError, pubkeyOfSecret,
} from './bordrSell.js';
import { HELIUS_RPCS, PUBLIC_RPC } from './rpc.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s) => s.slice(0, 4) + '…' + s.slice(-4);

// RPCs for reads and for blasting the sells. The app's own Helius endpoints go
// first (the public RPC 403s on getAccountInfo, which is what the old default
// hit); a key saved by the main app, and any pasted into the RPC box, come
// before them. The public RPC is only a last resort.
let savedRpc = '';
try { savedRpc = (localStorage.getItem('solRpc') || '').trim(); } catch { /* private window */ }
const DEFAULT_RPCS = [savedRpc, ...HELIUS_RPCS, PUBLIC_RPC].filter(Boolean);
const JITO = [
  'https://mainnet.block-engine.jito.wtf/api/v1/transactions',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions',
];

let coin = null;             // loaded coin
let wallets = [];            // { secret, pubkey, balance, holding, row, status }
let rpcs = [];
let firing = false;
let abort = false;

function rpcList() {
  const extra = $('rpcs').value.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
  return [...new Set([...extra, ...DEFAULT_RPCS])];
}
let readRpc = null;                 // the endpoint found working for reads
const primary = () => new Connection(readRpc || rpcs[0] || DEFAULT_RPCS[0], 'confirmed');

// The first RPC in the list that answers a read, so a 403 or a rate-limit on
// one endpoint just moves to the next instead of failing the whole load.
async function pickReadRpc() {
  for (const url of rpcs) {
    try {
      const c = new Connection(url, 'confirmed');
      await c.getLatestBlockhash('confirmed');
      readRpc = url;
      return url;
    } catch { /* try the next */ }
  }
  throw new Error('no RPC answered - paste a working Solana RPC in the RPC box (the public one blocks these reads)');
}

function setStatus(m, cls = '') { $('status').innerHTML = cls ? `<span class="${cls}">${esc(m)}</span>` : esc(m); }

// --- load the coin ----------------------------------------------------------
async function loadCoin() {
  const mint = $('mint').value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('paste the coin mint address');
  rpcs = rpcList();
  setStatus('finding a working RPC…');
  await pickReadRpc();
  setStatus('reading the coin…');
  coin = await loadBordrCoin(primary(), mint);
  const unlock = coin.earlyUnlockAt;
  if (unlock) $('sellTime').value = new Date(unlock * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const line = coin.earlyUnlockAt
    ? `early buyers locked until <b>${new Date(unlock * 1000).toISOString().replace(/\.\d+Z$/, 'Z')}</b> (created ${new Date(coin.createdAt * 1000).toISOString().replace(/\.\d+Z$/, 'Z')}, window ends ${new Date(coin.earlyWindowEnd * 1000).toISOString().replace(/\.\d+Z$/, 'Z')})`
    : 'this launch has no early-window lock - wallets can sell now';
  $('coinInfo').innerHTML = `<span class="ok">loaded</span> · ${coin.status === 1 ? 'graduated' : 'on the curve'} · ${line}`;
  $('armWrap').classList.remove('hidden');
  startCountdown();
  if (wallets.length) await refreshWallets();
}

// --- wallets ----------------------------------------------------------------
function parseWallets() {
  const lines = $('keys').value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    let pubkey;
    try { pubkey = pubkeyOfSecret(line); } catch { out.push({ secret: null, pubkey: null, error: 'not a valid base58 private key', bad: line.slice(0, 8) }); continue; }
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push({ secret: line, pubkey, balance: 0n, holding: null, status: 'checking…' });
  }
  return out;
}

async function refreshWallets() {
  const box = $('walletRows');
  box.innerHTML = '';
  wallets.forEach((w, i) => {
    const row = document.createElement('div');
    row.className = 'wrow';
    row.innerHTML = w.error
      ? `<span class="err">✕ ${esc(w.bad)}… — ${esc(w.error)}</span>`
      : `<span class="waddr">${esc(short(w.pubkey))}</span><span class="wbal" id="wbal${i}">…</span><span class="wstat" id="wstat${i}">${esc(w.status || '')}</span>`;
    w.row = row;
    box.appendChild(row);
  });
  if (!coin) return;
  await Promise.all(wallets.map(async (w, i) => {
    if (w.error) return;
    const { holding, balance } = await walletHolding(primary(), coin.mint, w.pubkey);
    w.holding = holding; w.balance = balance;
    const el = $(`wbal${i}`); if (el) el.textContent = (Number(balance) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const st = $(`wstat${i}`); if (st) st.textContent = balance > 0n ? 'ready' : 'no balance';
  }));
  const held = wallets.filter((w) => !w.error && w.balance > 0n).length;
  $('walletSummary').textContent = `${held} wallet${held === 1 ? '' : 's'} holding, ${wallets.filter((w) => w.error).length} rejected`;
}

function wstat(i, msg, cls) { const el = $(`wstat${i}`); if (el) el.innerHTML = cls ? `<span class="${cls}">${esc(msg)}</span>` : esc(msg); }

// --- pre-flight check -------------------------------------------------------
// Before the unlock a correct sell reverts with EarlyLocked; that is the proof
// the sell is ready. A wallet past the window already simulates clean.
async function checkAll() {
  if (!coin) { setStatus('load the coin first', 'err'); return; }
  const pct = sellPct();
  setStatus('checking every wallet’s sell…');
  await Promise.all(wallets.map(async (w, i) => {
    if (w.error || w.balance <= 0n) return;
    const amountIn = (w.balance * BigInt(Math.round(pct * 100))) / 10000n;
    try {
      const r = await simulateSell(primary(), { keys: coin.keys, owner: w.pubkey, amountIn, minOut: minOut(amountIn) });
      if (r.ok) wstat(i, 'sells now ✓', 'ok');
      else if (r.locked) wstat(i, 'ready — locked until unlock ✓', 'ok');
      else wstat(i, r.message, 'err');
    } catch (e) { wstat(i, e.message, 'err'); }
  }));
  setStatus('checked. a locked wallet showing “ready” will go through the instant the lock lifts.');
}

const sellPct = () => Math.min(100, Math.max(0.0001, +($('pct').value.trim() || 100)));
const slippageBps = () => Math.min(10000, Math.max(0, +($('slip').value.trim() || 0)));
const priorityMicro = () => Math.max(0, Math.round((+($('tip').value.trim() || 0.001)) * 1e9 / 0.6)); // rough: tip SOL → micro-lamports/CU over 600k CU
function minOut() { return 0n; }   // market exit; slippage floor is opt-in below
function minOutFor(amountIn) {
  const bps = slippageBps();
  return bps === 0 ? 0n : 0n;      // the quote side is priced per-swap; 0 = market. A floor needs a live quote we skip for speed.
}

// --- firing -----------------------------------------------------------------
// Blast one already-signed transaction (base64) to every RPC at once, and to
// Jito once the real tip is on (before that it would just be noise). Resending
// the SAME bytes is safe: the network deduplicates by signature, so it lands at
// most once however many times this is called.
async function blastRaw(b64, tipMicro) {
  const sends = [];
  for (const url of rpcs) sends.push(fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }) }).catch(() => null));
  if (tipMicro > 0) for (const url of JITO) sends.push(fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64' }] }) }).catch(() => null));
  await Promise.allSettled(sends);
}

function markSold(w, i, sig) {
  w.sig = sig;
  wstat(i, 'SOLD ✓', 'ok');
  const el = w.row?.querySelector('.wstat');
  if (el) el.innerHTML = `<span class="ok">SOLD ✓</span> <a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">tx</a>`;
}

async function armAndFire() {
  if (!coin) { setStatus('load the coin first', 'err'); return; }
  const ready = wallets.filter((w) => !w.error && w.balance > 0n);
  if (!ready.length) { setStatus('no wallets with a balance to sell', 'err'); return; }
  const when = Date.parse($('sellTime').value.trim());
  if (!when) { setStatus('enter a valid sell time (UTC)', 'err'); return; }
  const lead = Math.max(0, +($('lead').value.trim() || 2)) * 1000;   // start firing this many seconds early
  firing = true; abort = false;
  $('armBtn').textContent = 'STOP';
  const pct = sellPct();
  const conn = primary();
  const confirmed = new Set();

  // one fresh blockhash to start; NOT auto-refreshed, because changing the
  // blockhash changes the signed bytes and so the signature, and a new
  // signature is a second transaction that could also land and charge the tip
  // again. Each wallet reuses ONE signed, tipped transaction - identical bytes
  // resent are deduplicated by the network, so it lands (and is tipped) at most
  // once - and is only rebuilt after the old one can no longer land.
  let blockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;

  // the lock uses the CHAIN clock, which can lag the PC clock, so track the
  // offset and gate the real tip on chain time: the big tip goes on only from
  // the unlock (minus a small lead so the first open block already carries it),
  // and pre-unlock attempts go out at zero priority.
  let chainOffsetMs = 0;
  const syncClock = async () => {
    try { const slot = await conn.getSlot('confirmed'); const t = await conn.getBlockTime(slot); if (t) chainOffsetMs = t * 1000 - Date.now(); } catch {}
  };
  await syncClock();
  const clockTimer = setInterval(syncClock, 5_000);
  const chainNow = () => Date.now() + chainOffsetMs;
  const tipLeadMs = 400;                    // start paying the tip this long (chain time) before the unlock
  const fullTip = priorityMicro();

  setStatus(`armed — firing ${ready.length} wallets at ${new Date(when).toISOString().replace(/\.\d+Z$/, 'Z')} · tip only from the unlock (chain clock ${chainOffsetMs >= 0 ? '+' : ''}${(chainOffsetMs / 1000).toFixed(1)}s)`);
  // wait until lead-time before the target (wall clock, just to start the loop)
  while (!abort && Date.now() < when - lead) await sleep(Math.min(250, when - lead - Date.now()));

  // fire-and-retry loop: resend every round until each wallet confirms or errors
  // A blockhash is good for ~60s; rebuild a wallet's tx only once the old one
  // is past that, so the old and new tipped txs never both land.
  const BH_LIFE_MS = 62_000;
  let round = 0;
  while (firing && !abort && confirmed.size < ready.length) {
    round++;
    // real tip only once the chain clock reaches the unlock (minus a small
    // lead); before that, probes go out at zero priority so a reverted landing
    // costs only the base fee, not the tip
    const tipMicro = chainNow() >= when - tipLeadMs ? fullTip : 0;
    await Promise.all(ready.map(async (w) => {
      const i = wallets.indexOf(w);
      if (confirmed.has(w.pubkey)) return;
      const amountIn = (w.balance * BigInt(Math.round(pct * 100))) / 10000n;
      try {
        // (re)build this wallet's signed tx only when the tip phase changes
        // (0 -> full, once) or the blockhash has expired; otherwise resend the
        // exact same bytes so the network dedups it to a single landing.
        const needNew = !w.fire || w.fire.tip !== tipMicro || (Date.now() - w.fire.builtAt > BH_LIFE_MS);
        if (needNew) {
          // before replacing a tipped tx, make sure the old one did not already
          // land (so we never fire a second tipped tx that lands and re-tips)
          if (w.fire && w.fire.tip > 0) {
            const prev = await conn.getSignatureStatus(w.fire.sig).catch(() => null);
            if (prev?.value && !prev.value.err) { confirmed.add(w.pubkey); markSold(w, i, w.fire.sig); return; }
          }
          if (needNew && Date.now() - (w.fire?.builtAt || 0) > BH_LIFE_MS) blockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
          const built = buildSignedSell({ keys: coin.keys, secret: w.secret, amountIn, minOut: minOutFor(amountIn), blockhash, priorityMicroLamports: tipMicro });
          const raw = built.serialized;
          w.fire = { b64: typeof Buffer !== 'undefined' ? Buffer.from(raw).toString('base64') : btoa(String.fromCharCode(...raw)), sig: bs58.encode(built.tx.signatures[0]), tip: tipMicro, builtAt: Date.now() };
        }
        await blastRaw(w.fire.b64, tipMicro);
        wstat(i, tipMicro > 0 ? `firing with tip (round ${round})…` : `probing — not yet unlocked (round ${round})`, '');
        const st = await conn.getSignatureStatus(w.fire.sig);
        const s = st?.value;
        if (s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
          confirmed.add(w.pubkey); markSold(w, i, w.fire.sig);
        } else if (s?.err) {
          const c = classifyError(s.err, []);
          if (!c.retry) { confirmed.add(w.pubkey); wstat(i, 'failed: ' + c.message, 'err'); }
          else wstat(i, 'locked — retrying', '');
        }
      } catch (e) { wstat(i, 'retry: ' + (e.message || e), ''); }
    }));
    const phase = chainNow() >= when - tipLeadMs ? 'firing with tip' : 'probing (no tip yet)';
    $('status').innerHTML = `${phase}… round ${round}, sold ${confirmed.size}/${ready.length}`;
    if (confirmed.size < ready.length) await sleep(400);
    if (Date.now() > when + 120_000) break;  // give up after 2 min past target
  }
  clearInterval(bhTimer);
  clearInterval(clockTimer);
  firing = false;
  $('armBtn').textContent = 'ARM';
  setStatus(`done — sold ${confirmed.size}/${ready.length}` + (confirmed.size < ready.length ? '. re-check the unsold rows.' : ' ✓'), confirmed.size === ready.length ? 'ok' : 'err');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- countdown --------------------------------------------------------------
let cdTimer = null;
function startCountdown() {
  clearInterval(cdTimer);
  cdTimer = setInterval(() => {
    const when = Date.parse($('sellTime').value.trim());
    if (!when) { $('countdown').textContent = ''; return; }
    const d = Math.round((when - Date.now()) / 1000);
    $('countdown').textContent = d > 0 ? `unlock in ${Math.floor(d / 60)}m ${d % 60}s` : `unlocked ${-d}s ago`;
  }, 250);
}

// --- wiring -----------------------------------------------------------------
$('loadBtn').addEventListener('click', async () => {
  try { await loadCoin(); } catch (e) { $('coinInfo').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
});
$('parseBtn').addEventListener('click', async () => {
  wallets = parseWallets();
  await refreshWallets();
});
$('checkBtn').addEventListener('click', () => checkAll().catch((e) => setStatus(e.message, 'err')));
$('armBtn').addEventListener('click', () => {
  if (firing) { abort = true; firing = false; $('armBtn').textContent = 'ARM'; setStatus('stopped'); return; }
  armAndFire().catch((e) => { firing = false; $('armBtn').textContent = 'ARM'; setStatus(e.message, 'err'); });
});
$('mint').addEventListener('input', () => { coin = null; $('armWrap').classList.add('hidden'); });
