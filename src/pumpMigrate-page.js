import { Connection, PublicKey } from '@solana/web3.js';
import { inspectPumpMigration, migratePump, keypairFrom } from './pumpMigrate.js';
import { previewSnipe, snipeMigration } from './pumpSnipe.js';

// ---------------------------------------------------------------------------
// The pump migrate page. Same shape as force-migrate.html for Pons: paste a
// coin, read its real state off the chain, and only offer a button when the
// call simulates. Uses the SOL key the launcher already stores (keys.v1), and
// works read-only with no key at all - the state of somebody else's coin is a
// fact, not a privileged one.
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SOLSCAN = 'https://solscan.io';
const RPC = 'https://mainnet.helius-rpc.com/?api-key=ae11f74a-b518-408b-bc88-524c277da375';
const loadKeys = () => { try { return JSON.parse(localStorage.getItem('keys.v1') || 'null'); } catch { return null; } };

let solKey = null;
let owner = null;
let current = null;   // the last inspection

const isSolAddress = (s) => {
  try { return !!s && new PublicKey(s.trim()).toBase58() === s.trim(); } catch { return false; }
};

const amount = (raw, decimals) => {
  if (decimals == null) return raw + ' (raw)';
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
};

const link = (kind, addr) => `<a href="${SOLSCAN}/${kind}/${addr}" target="_blank" rel="noopener">${esc(addr)}</a>`;

const BADGES = {
  migrated: ['ALREADY MIGRATED', 'done'],
  'on-curve': ['STILL ON THE CURVE', 'active'],
  migratable: ['READY TO MIGRATE', 'ready'],
  blocked: ['BLOCKED', 'blocked'],
  'not-a-pump-coin': ['NOT A PUMP COIN', 'blocked'],
};

async function analyze() {
  const raw = $('mintInput').value.trim();
  const st = $('analyzeStatus');
  $('resultCard').classList.add('hidden');
  if (!isSolAddress(raw)) { st.innerHTML = '<span class="err">that is not a Solana mint address</span>'; return; }
  $('analyzeBtn').disabled = true;
  st.textContent = 'reading the curve, deriving the pool, simulating…';
  try {
    const connection = new Connection(RPC, 'confirmed');
    const info = await inspectPumpMigration({ connection, mint: raw, user: owner });
    current = { ...info, mint: raw };
    st.textContent = '';
    render(current);
    history.replaceState(null, '', '?mint=' + raw);
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(e.message)}</span>`;
  } finally {
    $('analyzeBtn').disabled = false;
  }
}

function render(info) {
  const [label, cls] = BADGES[info.state] || ['UNKNOWN', 'blocked'];
  $('statusBadge').innerHTML = `<span class="badge ${cls}">${label}</span>`;

  const rows = [];
  if (!info.isPumpCoin) {
    rows.push(['mint', link('token', info.mint)]);
  } else {
    const c = info.curve;
    const dec = info.quoteDecimals;
    rows.push(['curve', link('account', c.address.toBase58())]);
    rows.push(['creator', link('account', c.creator.toBase58())]);
    rows.push(['quote', (info.isNativeQuote ? 'SOL (wrapped) · ' : 'paired · ') + link('token', info.quoteMint)]);
    rows.push(['raised', amount(c.realQuoteReserves.toString(), dec)
      + (info.isNativeQuote ? ' SOL' : '') + (c.realQuoteReserves === 0n ? ' <span class="dimtext">(swept into the pool)</span>' : '')]);
    rows.push(['unsold supply', amount(c.realTokenReserves.toString(), 6)]);
    rows.push(['pool', link('account', info.pool)]);
    rows.push(['migration fee', amount(info.terms.poolMigrationFee.toString(), 9)
      + ' SOL <span class="dimtext">out of the curve, not your wallet</span>']);
  }
  $('details').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');

  const note = $('stateNote');
  note.innerHTML = info.reason ? esc(info.reason) : '';
  note.classList.toggle('hidden', !info.reason);

  const btn = $('actionBtn');
  const ready = info.state === 'migratable';
  btn.classList.toggle('hidden', !ready);
  $('snipeBox').classList.toggle('hidden', !ready);
  if (ready) {
    $('snipeSym').textContent = info.isNativeQuote ? 'SOL' : 'QUOTE';
    updateActionLabel();
  }
  $('actionStatus').textContent = ready && solKey
    ? 'the call simulates clean' + (info.simulation?.unitsConsumed ? ` (${info.simulation.unitsConsumed} CU)` : '')
    : '';

  $('devDetails').textContent = info.isPumpCoin
    ? info.accounts.map((a, i) => String(i).padStart(2) + '  ' + a).join('\n')
      + `\n\ntx size ${info.simulation?.bytes ?? '—'} bytes · probed as ${info.probedAs}`
      + (info.simulation?.logs?.length ? '\n\n' + info.simulation.logs.join('\n') : '')
    : 'no bonding curve account at the derived address';
  $('resultCard').classList.remove('hidden');
}

/// The spend box in the quote's own base units, or 0n for a plain migration.
function spendRaw() {
  const v = $('snipeAmount').value.trim();
  if (!v || !(Number(v) > 0)) return 0n;
  const dec = current?.quoteDecimals;
  if (dec == null) throw new Error('the quote mint decimals are unknown, so the spend cannot be scaled');
  const [whole, frac = ''] = v.split('.');
  return BigInt((whole || '0') + (frac + '0'.repeat(dec)).slice(0, dec));
}

function updateActionLabel() {
  const btn = $('actionBtn');
  let buying = false;
  try { buying = spendRaw() > 0n; } catch { buying = false; }
  $('tipRow').classList.toggle('hidden', $('snipeRoute').value !== 'bundle');
  btn.textContent = !solKey ? 'IMPORT A SOL KEY FIRST'
    : (buying ? 'MIGRATE + BUY FIRST' : 'MIGRATE IT');
  btn.disabled = !solKey;
}

/// Measure the fill before anything is signed. The number comes from simulating
/// the real buy, so it is what the transaction will do rather than an estimate.
let previewSeq = 0;
async function refreshSnipePreview() {
  const hint = $('snipeHint');
  updateActionLabel();
  let spend;
  try { spend = spendRaw(); } catch (e) { hint.innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }
  if (spend <= 0n) { hint.textContent = 'leave this at 0 to migrate without buying.'; return; }
  if (!owner) { hint.textContent = 'import a SOL key to price the buy — the fill is measured against your wallet.'; return; }
  const seq = ++previewSeq;
  hint.textContent = 'simulating the buy to measure the fill…';
  try {
    const p = await previewSnipe({
      rpcUrl: RPC, mint: current.mint, buyer: owner,
      spendQuote: spend.toString(), slippageBps: Math.round(Number($('snipeSlippage').value || '5') * 100),
    });
    if (seq !== previewSeq) return;
    hint.innerHTML = `fills <b>${p.tokens.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b> tokens `
      + `(<b>${p.pctOfSupply.toFixed(3)}%</b> of supply) · floor ${p.minBaseOut} · `
      + `${p.bytes} of 1232 bytes${p.bytes > 1232 ? ' — <b>too big, it will go as a bundle</b>' : ''}`;
  } catch (e) {
    if (seq === previewSeq) hint.innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
}

async function act() {
  const st = $('actionStatus');
  if (!solKey || !current) return;
  $('actionBtn').disabled = true;
  try {
    const spend = spendRaw();
    if (spend <= 0n) {
      const res = await migratePump({
        rpcUrl: RPC, secretKey: solKey, mint: current.mint,
        onStatus: (m) => { st.textContent = m; },
      });
      st.innerHTML = '<span class="ok">MIGRATED ✓</span> pool ' + link('account', res.pool)
        + ' · ' + `<a href="${SOLSCAN}/tx/${res.sig}" target="_blank" rel="noopener">tx</a>`;
    } else {
      const res = await snipeMigration({
        rpcUrl: RPC, secretKey: solKey, mint: current.mint,
        spendQuote: spend.toString(),
        slippageBps: Math.round(Number($('snipeSlippage').value || '5') * 100),
        route: $('snipeRoute').value,
        tipLamports: Math.round(Number($('snipeTip').value || '0.001') * 1e9),
        onStatus: (m) => { st.textContent = m; },
      });
      if (res.route === 'bundle') {
        st.innerHTML = res.landed
          ? `<span class="ok">MIGRATED + BOUGHT ✓</span> bundle landed in slot ${res.slot} · `
            + res.sigs.map((g) => `<a href="${SOLSCAN}/tx/${g}" target="_blank" rel="noopener">tx</a>`).join(' ')
          : `<span class="warn">bundle ${esc(res.bundleId)} did not land</span> — ${esc(res.reason)}`;
      } else {
        st.innerHTML = '<span class="ok">MIGRATED + BOUGHT ✓</span> filled ' + esc(res.filled)
          + ' · ' + `<a href="${SOLSCAN}/tx/${res.sig}" target="_blank" rel="noopener">tx</a>`;
      }
    }
    analyze();
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(e.message)}</span>`;
    $('actionBtn').disabled = false;
  }
}

function start() {
  $('appRoot').style.display = '';
  const keys = loadKeys();
  if (keys?.sol) {
    try {
      solKey = keys.sol;
      owner = keypairFrom(solKey).publicKey.toBase58();
      $('walletAddr').textContent = owner.slice(0, 4) + '…' + owner.slice(-4);
    } catch { solKey = null; $('noVault').hidden = false; }
  } else {
    $('noVault').hidden = false;
  }

  $('analyzeBtn').onclick = analyze;
  $('mintInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });
  $('actionBtn').onclick = act;
  let t;
  const repreview = () => { clearTimeout(t); t = setTimeout(refreshSnipePreview, 400); };
  $('snipeAmount').addEventListener('input', repreview);
  $('snipeSlippage').addEventListener('input', repreview);
  $('snipeRoute').addEventListener('change', updateActionLabel);

  const pre = new URLSearchParams(location.search).get('mint');
  if (pre) { $('mintInput').value = pre; analyze(); }
}

start();
