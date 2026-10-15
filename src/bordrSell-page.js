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

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s) => s.slice(0, 4) + '…' + s.slice(-4);

// RPCs the sells are blasted to in parallel. The first is the user's Helius (or
// the public fallback); more can be pasted in. Jito is added if a tip is set.
const DEFAULT_RPCS = [
  (localStorage.getItem('solRpc') || '').trim(),
  'https://api.mainnet-beta.solana.com',
].filter(Boolean);
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
const primary = () => new Connection(rpcs[0] || DEFAULT_RPCS[0] || 'https://api.mainnet-beta.solana.com', 'confirmed');

function setStatus(m, cls = '') { $('status').innerHTML = cls ? `<span class="${cls}">${esc(m)}</span>` : esc(m); }

// --- load the coin ----------------------------------------------------------
async function loadCoin() {
  const mint = $('mint').value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('paste the coin mint address');
  rpcs = rpcList();
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
async function fireWallet(w, i, keys, amountIn, blockhash) {
  const built = buildSignedSell({ keys, secret: w.secret, amountIn, minOut: minOutFor(amountIn), blockhash, priorityMicroLamports: priorityMicro() });
  const raw = built.serialized;
  const b64 = typeof Buffer !== 'undefined' ? Buffer.from(raw).toString('base64') : btoa(String.fromCharCode(...raw));
  const sig = bs58.encode(built.tx.signatures[0]);
  // blast to every RPC (sendRawTransaction) and Jito at once
  const sends = [];
  for (const url of rpcs) {
    sends.push(fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }) }).catch(() => null));
  }
  if (priorityMicro() > 0) for (const url of JITO) sends.push(fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64' }] }) }).catch(() => null));
  await Promise.allSettled(sends);
  return sig;
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

  // keep a fresh blockhash so pre-built txs never go stale
  let blockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const bhTimer = setInterval(async () => { try { blockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; } catch {} }, 10_000);

  setStatus(`armed — firing ${ready.length} wallets at ${new Date(when).toISOString().replace(/\.\d+Z$/, 'Z')} (from ${lead / 1000}s early)`);
  // wait until lead-time before the target
  while (!abort && Date.now() < when - lead) await sleep(Math.min(250, when - lead - Date.now()));

  // fire-and-retry loop: resend every round until each wallet confirms or errors
  let round = 0;
  while (firing && !abort && confirmed.size < ready.length) {
    round++;
    await Promise.all(ready.map(async (w, idx) => {
      const i = wallets.indexOf(w);
      if (confirmed.has(w.pubkey)) return;
      const amountIn = (w.balance * BigInt(Math.round(pct * 100))) / 10000n;
      try {
        const sig = await fireWallet(w, i, coin.keys, amountIn, blockhash);
        wstat(i, `sent (round ${round}) …checking`, '');
        const st = await conn.getSignatureStatus(sig);
        const s = st?.value;
        if (s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
          confirmed.add(w.pubkey);
          wstat(i, `SOLD ✓`, 'ok');
          w.sig = sig;
          const el = w.row?.querySelector('.wstat'); if (el) el.innerHTML = `<span class="ok">SOLD ✓</span> <a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">tx</a>`;
        } else if (s?.err) {
          const c = classifyError(s.err, []);
          if (!c.retry) { confirmed.add(w.pubkey); wstat(i, 'failed: ' + c.message, 'err'); }
          else wstat(i, 'locked — retrying', '');
        }
      } catch (e) { wstat(i, 'retry: ' + (e.message || e), ''); }
    }));
    $('status').innerHTML = `firing… round ${round}, sold ${confirmed.size}/${ready.length}`;
    if (confirmed.size < ready.length) await sleep(400);
    if (Date.now() > when + 120_000) break;  // give up after 2 min past target
  }
  clearInterval(bhTimer);
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
