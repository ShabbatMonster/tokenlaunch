// ---------------------------------------------------------------------------
// The Axiom side: a MIGRATE button on a coin's page.
//
// Axiom is somebody else's single-page app and its markup is not ours to rely
// on, so nothing here trusts a selector. The contract address is gathered from
// every place it could plausibly be - the URL, links that name a mint, and any
// text on the page shaped like base58 - and the SERVICE WORKER decides which
// candidate is real by asking the chain which venue it belongs to. Being wrong
// about Axiom's DOM is then cheap and self-correcting.
//
// MOUNTING, which is what went wrong the first time:
//
//   - the button is built and attached SYNCHRONOUSLY, before anything is
//     awaited. The first version read a stored position first, so any hiccup in
//     chrome.storage meant no button at all rather than a button in the default
//     place.
//   - it is inserted next to Axiom's own VAMP button when one can be found by
//     its text, which is where it belongs. The first version only tried to
//     recognise a header row by geometry, and that needed the mint to already be
//     resolved - so on a slow page it never even looked.
//   - React owns that row and re-renders it, which silently removes anything we
//     put inside. A re-mount check runs on an interval and puts it back.
//   - the panel is a separate fixed-position element rather than a child of the
//     button, so an ancestor with overflow:hidden cannot clip it.
//
// The key split is unchanged and is the whole security design: the key lives in
// the service worker, and this file never names it, never imports the signing
// code, and speaks four message types.
// ---------------------------------------------------------------------------

const ID = 'pmx';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MINT_IN_URL = /(?:solscan\.io\/token\/|pump\.fun\/(?:coin\/)?|dexscreener\.com\/solana\/|birdeye\.so\/(?:solana\/)?token\/|explorer\.solana\.com\/address\/|solana\.fm\/address\/)([1-9A-HJ-NP-Za-km-z]{32,44})/;

/// Buttons Axiom already puts in the coin header. Ours goes next to the first
/// one found; VAMP is the one in the screenshot this was built from.
const ANCHOR_LABELS = ['vamp', 'buy', 'sell', 'trade'];

const state = {
  mint: null, info: null, busy: false, panelOpen: false,
  lastUrl: '', dragMoved: false, pos: null, mountedInline: false,
};

let btnRoot = null;
let panel = null;

const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- finding the contract address -------------------------------------------

const looksLikeMint = (s) => typeof s === 'string' && BASE58.test(s);

/// Every address on the page that could be the coin, best guesses first. The
/// worker checks them against the chain in this order, so the ordering is a
/// speed optimisation rather than a correctness one.
function candidateMints() {
  const seen = new Set();
  const out = [];
  const add = (m) => { if (looksLikeMint(m) && !seen.has(m)) { seen.add(m); out.push(m); } };

  for (const a of document.querySelectorAll('a[href]')) {
    const m = MINT_IN_URL.exec(a.getAttribute('href') || '');
    if (m) add(m[1]);
  }
  for (const seg of location.pathname.split('/')) add(seg);
  for (const v of new URLSearchParams(location.search).values()) add(v);

  const loose = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.nodeValue || '').trim();
    if (looksLikeMint(t)) loose.push(t);
  }
  for (const m of loose) if (m.endsWith('pump')) add(m);
  for (const m of loose) add(m);

  for (const node of document.querySelectorAll('[data-mint],[data-address],[data-token],[data-token-address]')) {
    for (const attr of ['data-mint', 'data-address', 'data-token', 'data-token-address']) add(node.getAttribute(attr));
  }
  return out.slice(0, 8);
}

// --- mounting ----------------------------------------------------------------

/// Axiom's own button to sit beside, found by its label rather than a class.
function findAnchorButton() {
  const nodes = document.querySelectorAll('button,a[role="button"],div[role="button"]');
  for (const n of nodes) {
    const t = (n.textContent || '').trim().toLowerCase();
    if (!t || t.length > 12) continue;
    if (!ANCHOR_LABELS.includes(t)) continue;
    const r = n.getBoundingClientRect();
    // must be a real, visible control near the top of the page
    if (r.width < 24 || r.height < 16 || r.top > 320) continue;
    return n;
  }
  return null;
}

function buildButton() {
  btnRoot = el('div', `${ID}-root`);
  btnRoot.id = `${ID}-root`;
  const btn = el('button', `${ID}-btn`);
  btn.type = 'button';
  btn.innerHTML = `<span class="${ID}-dot"></span><span class="${ID}-label">MIGRATE</span>`;
  btn.title = 'migrate this coin';
  btnRoot.appendChild(btn);
  btn.addEventListener('click', (e) => {
    if (state.dragMoved) return;
    e.stopPropagation(); e.preventDefault();
    togglePanel();
  });
  makeDraggable(btn);
  return btnRoot;
}

/// Put the button next to Axiom's own, or float it if there is nowhere obvious.
/// Called repeatedly: React re-renders that row and takes our node with it.
function mount() {
  if (!btnRoot) return;
  if (btnRoot.isConnected && state.mountedInline) return;          // still in place
  if (btnRoot.isConnected && !state.mountedInline && state.pos) return;

  const anchor = state.pos ? null : findAnchorButton();
  if (anchor && anchor.parentNode) {
    btnRoot.classList.add(`${ID}-inline`);
    btnRoot.style.left = ''; btnRoot.style.top = '';
    anchor.parentNode.insertBefore(btnRoot, anchor.nextSibling);
    state.mountedInline = true;
    return;
  }
  // nothing to sit beside: float, and let it be dragged
  btnRoot.classList.remove(`${ID}-inline`);
  state.mountedInline = false;
  if (!btnRoot.isConnected) document.documentElement.appendChild(btnRoot);
  if (state.pos) applyPos();
  else { btnRoot.style.left = Math.max(8, window.innerWidth - 150) + 'px'; btnRoot.style.top = '76px'; }
}

function applyPos() {
  const w = btnRoot.offsetWidth || 130;
  btnRoot.style.left = Math.max(4, Math.min(state.pos.left, window.innerWidth - w - 4)) + 'px';
  btnRoot.style.top = Math.max(4, Math.min(state.pos.top, window.innerHeight - 40)) + 'px';
}

function makeDraggable(handle) {
  let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, lastLeft = null, lastTop = null;
  const onMove = (e) => {
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!state.dragMoved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!state.dragMoved) {
      // first real movement: leave the header row and start floating
      state.dragMoved = true;
      state.mountedInline = false;
      btnRoot.classList.remove(`${ID}-inline`);
      document.documentElement.appendChild(btnRoot);
    }
    const w = btnRoot.offsetWidth;
    lastLeft = Math.max(4, Math.min(baseLeft + dx, window.innerWidth - w - 4));
    lastTop = Math.max(4, Math.min(baseTop + dy, window.innerHeight - 40));
    btnRoot.style.left = lastLeft + 'px';
    btnRoot.style.top = lastTop + 'px';
    e.preventDefault();
  };
  const onUp = async () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    if (!state.dragMoved || lastLeft === null) return;
    state.pos = { left: Math.round(lastLeft), top: Math.round(lastTop) };
    try { await chrome.storage.local.set({ pmxPos: state.pos }); } catch { /* position is a nicety */ }
    // the click listener fires after mouseup; let it see this was a drag
    setTimeout(() => { state.dragMoved = false; }, 0);
  };
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const r = btnRoot.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    baseLeft = lastLeft ?? r.left; baseTop = lastTop ?? r.top;
    state.dragMoved = false;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }, true);
}

// --- the panel ---------------------------------------------------------------

function buildPanel() {
  panel = el('div', `${ID}-panel ${ID}-hidden`);
  panel.id = `${ID}-panel`;
  panel.innerHTML = `
    <div class="${ID}-head">
      <b>MIGRATE</b><span class="${ID}-venue" id="${ID}-venue"></span>
      <span class="${ID}-grow"></span>
      <button class="${ID}-x" type="button" title="close">x</button>
    </div>
    <div class="${ID}-ca" id="${ID}-ca">reading the page…</div>
    <div class="${ID}-state" id="${ID}-state"></div>
    <div id="${ID}-buybox">
      <label class="${ID}-lab">BUY (<span id="${ID}-sym">SOL</span>) &mdash; 0 just migrates</label>
      <input class="${ID}-in" id="${ID}-amt" value="0" spellcheck="false" autocomplete="off">
      <div class="${ID}-row">
        <div><label class="${ID}-lab">SLIPPAGE %</label>
          <input class="${ID}-in" id="${ID}-slip" value="5" spellcheck="false" autocomplete="off"></div>
        <div><label class="${ID}-lab">ROUTE</label>
          <select class="${ID}-in" id="${ID}-route">
            <option value="auto">one tx (bundle if too big)</option>
            <option value="bundle">always a Jito bundle</option>
          </select></div>
      </div>
    </div>
    <div class="${ID}-hint" id="${ID}-hint"></div>
    <button class="${ID}-go" id="${ID}-go" type="button">MIGRATE</button>
    <div class="${ID}-status" id="${ID}-status"></div>`;
  document.documentElement.appendChild(panel);

  panel.querySelector(`.${ID}-x`).addEventListener('click', () => togglePanel(false));
  panel.addEventListener('click', (e) => e.stopPropagation());
  let t;
  const repreview = () => { clearTimeout(t); t = setTimeout(preview, 450); };
  panel.querySelector(`#${ID}-amt`).addEventListener('input', repreview);
  panel.querySelector(`#${ID}-slip`).addEventListener('input', repreview);
  panel.querySelector(`#${ID}-go`).addEventListener('click', onGo);
  return panel;
}

function placePanel() {
  const r = btnRoot.getBoundingClientRect();
  const w = 288;
  panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  panel.style.top = Math.min(r.bottom + 6, window.innerHeight - 80) + 'px';
}

function togglePanel(force) {
  state.panelOpen = force == null ? !state.panelOpen : force;
  panel.classList.toggle(`${ID}-hidden`, !state.panelOpen);
  if (state.panelOpen) { placePanel(); resolveMint(); preview(); }
}

// --- talking to the worker ---------------------------------------------------

const send = (msg) => new Promise((res) => {
  try {
    chrome.runtime.sendMessage(msg, (r) => res(
      chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r));
  } catch (e) { res({ ok: false, error: e?.message || String(e) }); }
});

const $ = (id) => panel?.querySelector('#' + ID + '-' + id);
const setText = (id, s) => { const n = $(id); if (n) n.textContent = s; };
const setHtml = (id, s) => { const n = $(id); if (n) n.innerHTML = s; };

const STATE_LABEL = {
  migratable: ['READY TO MIGRATE', 'ok'],
  migrated: ['ALREADY MIGRATED', 'dim'],
  'on-curve': ['STILL ON THE CURVE', 'warn'],
  blocked: ['BLOCKED', 'err'],
};
const VENUE_LABEL = { pump: 'pump.fun', meteora: 'Meteora DBC', raydium: 'Raydium LaunchLab' };

let resolving = null;
async function resolveMint(force) {
  if (resolving) return resolving;
  if (state.mint && state.info && !force) { paint(); return; }
  setText('ca', 'looking for the contract address…');
  resolving = (async () => {
    const candidates = candidateMints();
    if (!candidates.length) { setText('ca', 'no address found on this page'); setText('state', ''); return; }
    const r = await send({ type: 'pm:resolve', candidates });
    if (!r?.ok) {
      state.mint = null; state.info = null;
      setText('ca', candidates[0].slice(0, 6) + '…' + candidates[0].slice(-4));
      setHtml('state', `<span class="${ID}-err">${escapeHtml(r?.error || 'could not read this coin')}</span>`);
      paintButton();
      return;
    }
    state.mint = r.mint; state.info = r.info;
    paint();
  })();
  try { await resolving; } finally { resolving = null; }
}

function paint() {
  if (!panel) return;
  if (state.mint) setText('ca', state.mint.slice(0, 6) + '…' + state.mint.slice(-4));
  const info = state.info;
  if (info) {
    setText('venue', VENUE_LABEL[info.venue] || info.venue);
    const [label, kind] = STATE_LABEL[info.state] || ['UNKNOWN', 'dim'];
    setHtml('state', `<span class="${ID}-${kind}">${label}</span>`
      + (info.reason ? `<div class="${ID}-why">${escapeHtml(info.reason)}</div>` : ''));
    setText('sym', info.isNativeQuote ? 'SOL' : 'QUOTE');
    // Meteora opens a DAMM v2 pool, which is a different program from PumpSwap:
    // the first buy is not wired for it, so do not offer a box that lies.
    $('buybox').style.display = info.canBuy ? '' : 'none';
  }
  paintButton();
}

function paintButton() {
  if (!btnRoot) return;
  const btn = btnRoot.querySelector(`.${ID}-btn`);
  const dot = btnRoot.querySelector(`.${ID}-dot`);
  const st = state.info?.state;
  btn.classList.toggle(`${ID}-ready`, st === 'migratable');
  dot.className = `${ID}-dot ${st === 'migratable' ? 'ok' : st === 'on-curve' ? 'warn' : st === 'migrated' ? 'done' : ''}`;
  const go = $('go');
  if (go) {
    go.disabled = state.busy || st !== 'migratable';
    go.textContent = state.busy ? 'WORKING…'
      : (state.info?.canBuy && spendRaw() > 0n ? 'MIGRATE + BUY' : 'MIGRATE');
  }
}

/// The amount box in the quote's own base units.
function spendRaw() {
  if (!state.info?.canBuy) return 0n;
  const v = ($('amt')?.value || '').trim();
  if (!v || !(Number(v) > 0)) return 0n;
  const dec = state.info?.quoteDecimals;
  if (dec == null) return 0n;
  const [whole, frac = ''] = v.split('.');
  try { return BigInt((whole || '0') + (frac + '0'.repeat(dec)).slice(0, dec)); } catch { return 0n; }
}

let previewSeq = 0;
async function preview() {
  paintButton();
  if (!state.mint || state.info?.state !== 'migratable') { setText('hint', ''); return; }
  if (!state.info?.canBuy) {
    setText('hint', 'Meteora migrations open a DAMM v2 pool; the first buy is not wired for that venue yet.');
    return;
  }
  const spend = spendRaw();
  if (spend <= 0n) { setText('hint', 'leave the amount at 0 to migrate without buying.'); return; }
  const seq = ++previewSeq;
  setText('hint', 'simulating the buy to measure the fill…');
  const r = await send({
    type: 'pm:preview', mint: state.mint, spendQuote: spend.toString(),
    slippageBps: Math.round(Number($('slip')?.value || '5') * 100),
  });
  if (seq !== previewSeq) return;
  if (!r?.ok) { setHtml('hint', `<span class="${ID}-err">${escapeHtml(r?.error || 'preview failed')}</span>`); return; }
  const p = r.preview;
  setHtml('hint', `fills <b>${Number(p.tokens).toLocaleString(undefined, { maximumFractionDigits: 2 })}</b> tokens `
    + `(<b>${Number(p.pctOfSupply).toFixed(3)}%</b> of supply) · ${p.bytes} of 1232 bytes`
    + (p.bytes > 1232 ? ' · <b>goes as a bundle</b>' : ''));
}

async function onGo(e) {
  // A synthetic click from the page would carry isTrusted false. This is the
  // only control here that spends money, so it only answers to a real one.
  if (!e.isTrusted || state.busy || !state.mint) return;
  state.busy = true; paintButton();
  setText('status', 'starting…');
  const r = await send({
    type: 'pm:migrate', mint: state.mint, venue: state.info?.venue || 'pump',
    spendQuote: spendRaw().toString(),
    slippageBps: Math.round(Number($('slip')?.value || '5') * 100),
    route: $('route')?.value || 'auto',
  });
  state.busy = false;
  if (!r?.ok) {
    setHtml('status', `<span class="${ID}-err">${escapeHtml(r?.error || 'it failed')}</span>`);
    paintButton();
    return;
  }
  const res = r.result;
  const tx = res.sig || res.sigs?.[0];
  setHtml('status', `<span class="${ID}-ok">DONE</span> `
    + (tx ? `<a href="https://solscan.io/tx/${tx}" target="_blank" rel="noopener">tx</a>` : '')
    + (res.landed === false ? ` <span class="${ID}-warn">bundle did not land</span>` : ''));
  await resolveMint(true);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'pm:status') setText('status', msg.text);
});

// --- keeping up with a single-page app ---------------------------------------

function onNavigated() {
  state.mint = null; state.info = null;
  setText('status', ''); setText('hint', '');
  paint();
  setTimeout(() => { resolveMint(true); }, 700);
}

function start() {
  if (!document.body) { setTimeout(start, 100); return; }
  if (document.getElementById(`${ID}-root`)) return;   // already running

  // built and attached before anything is awaited: a slow or failing
  // chrome.storage must never mean no button
  buildButton();
  buildPanel();
  mount();
  state.lastUrl = location.href;
  onNavigated();

  chrome.storage.local.get('pmxPos').then((s) => {
    if (s?.pmxPos) { state.pos = s.pmxPos; mount(); }
  }).catch(() => {});

  // Axiom swaps pages without reloading, and re-renders the header row without
  // telling anyone. One timer covers both: re-mount if we were removed, and
  // re-read the coin if the URL moved.
  setInterval(() => {
    mount();
    if (state.panelOpen) placePanel();
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    onNavigated();
  }, 600);

  window.addEventListener('resize', () => { if (state.pos) applyPos(); if (state.panelOpen) placePanel(); });
  console.log('[pump migrate] mounted');
}

start();
