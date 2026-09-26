// ---------------------------------------------------------------------------
// The Axiom side: a MIGRATE button on a pump.fun coin's page.
//
// Axiom is somebody else's single-page app and its markup is not ours to rely
// on, so nothing here trusts a selector to be right. The contract address is
// gathered from every place it could plausibly be - the URL, links that name a
// mint, and any text on the page shaped like base58 - and the SERVICE WORKER
// decides which candidate is real by asking the chain whether it has a pump
// bonding curve. Being wrong about Axiom's DOM is then cheap and self-
// correcting; being wrong about the chain is not possible.
//
// The same split as the rest of this extension holds: the key lives in the
// service worker and never comes near this file. All a page can do, even a
// hostile one, is watch you press a button you were already pressing.
//
// The button mounts into the coin's own header row when one can be identified by
// geometry, and falls back to a floating pill when it cannot. Either way it is
// draggable and remembers where it was put.
// ---------------------------------------------------------------------------

const ID = 'pmx';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MINT_IN_URL = /(?:solscan\.io\/token\/|pump\.fun\/(?:coin\/)?|dexscreener\.com\/solana\/|birdeye\.so\/(?:solana\/)?token\/|explorer\.solana\.com\/address\/|solana\.fm\/address\/)([1-9A-HJ-NP-Za-km-z]{32,44})/;

const state = {
  mint: null,
  info: null,
  busy: false,
  panelOpen: false,
  lastUrl: '',
  dragMoved: false,
  pos: null,
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// --- finding the contract address -------------------------------------------

const looksLikeMint = (s) => typeof s === 'string' && BASE58.test(s);

/// Every address on the page that could be the coin, best guesses first. The
/// worker checks them against the chain in this order, so ordering is a speed
/// optimisation rather than a correctness one.
function candidateMints() {
  const seen = new Set();
  const out = [];
  const add = (m) => { if (looksLikeMint(m) && !seen.has(m)) { seen.add(m); out.push(m); } };

  // an explorer or pump.fun link on the page names the mint outright
  for (const a of document.querySelectorAll('a[href]')) {
    const m = MINT_IN_URL.exec(a.getAttribute('href') || '');
    if (m) add(m[1]);
  }
  // the address bar, which on most token pages is the mint or the pair
  for (const seg of location.pathname.split('/')) add(seg);
  for (const v of new URLSearchParams(location.search).values()) add(v);

  // anything rendered on the page that is shaped like a mint. Vanity "…pump"
  // addresses go first because they are pump.fun's own suffix.
  const loose = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.nodeValue || '').trim();
    if (looksLikeMint(t)) loose.push(t);
  }
  for (const m of loose) if (m.endsWith('pump')) add(m);
  for (const m of loose) add(m);

  // data attributes are a common place for an SPA to keep the id it fetched with
  for (const node of document.querySelectorAll('[data-mint],[data-address],[data-token],[data-token-address]')) {
    for (const attr of ['data-mint', 'data-address', 'data-token', 'data-token-address']) add(node.getAttribute(attr));
  }
  return out.slice(0, 8);
}

// --- the button and its panel -----------------------------------------------

let root = null;

function build() {
  root = el('div', `${ID}-root`);
  root.id = `${ID}-root`;

  const btn = el('button', `${ID}-btn`);
  btn.type = 'button';
  btn.innerHTML = `<span class="${ID}-dot"></span><span class="${ID}-label">MIGRATE</span>`;
  btn.title = 'migrate this pump.fun coin and buy first';
  root.appendChild(btn);

  const panel = el('div', `${ID}-panel ${ID}-hidden`);
  panel.innerHTML = `
    <div class="${ID}-head">
      <b>MIGRATE + FIRST BUY</b><span class="${ID}-grow"></span>
      <button class="${ID}-x" type="button" title="close">x</button>
    </div>
    <div class="${ID}-ca" id="${ID}-ca">reading the page…</div>
    <div class="${ID}-state" id="${ID}-state"></div>
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
    <div class="${ID}-hint" id="${ID}-hint"></div>
    <button class="${ID}-go" id="${ID}-go" type="button">MIGRATE</button>
    <div class="${ID}-status" id="${ID}-status"></div>`;
  root.appendChild(panel);
  document.documentElement.appendChild(root);

  btn.addEventListener('click', (e) => {
    if (state.dragMoved) return;
    e.stopPropagation();
    togglePanel();
  });
  panel.querySelector(`.${ID}-x`).addEventListener('click', () => togglePanel(false));
  // clicks inside the panel are ours; Axiom should not also act on them
  panel.addEventListener('click', (e) => e.stopPropagation());

  const amt = panel.querySelector(`#${ID}-amt`);
  const slip = panel.querySelector(`#${ID}-slip`);
  let t;
  const repreview = () => { clearTimeout(t); t = setTimeout(preview, 450); };
  amt.addEventListener('input', repreview);
  slip.addEventListener('input', repreview);
  panel.querySelector(`#${ID}-go`).addEventListener('click', onGo);

  makeDraggable(btn);
  return root;
}

function togglePanel(force) {
  const panel = root.querySelector(`.${ID}-panel`);
  state.panelOpen = force == null ? !state.panelOpen : force;
  panel.classList.toggle(`${ID}-hidden`, !state.panelOpen);
  if (state.panelOpen) { resolveMint(); preview(); }
}

// --- placement ---------------------------------------------------------------

/// Axiom's own header row, if it can be recognised. Rather than guess a class
/// name, this looks for the topmost wide, short, horizontal strip that actually
/// contains the coin's address - which is what a token header is.
function findHeaderRow() {
  const wanted = state.mint;
  if (!wanted) return null;
  let best = null;
  for (const node of document.querySelectorAll('div,header,section,nav')) {
    const r = node.getBoundingClientRect();
    if (r.top > 260 || r.height < 24 || r.height > 110 || r.width < window.innerWidth * 0.5) continue;
    if (!node.textContent || !node.textContent.includes(wanted.slice(0, 6))) continue;
    if (best == null || r.top < best.rect.top || (r.top === best.rect.top && r.height < best.rect.height)) {
      best = { node, rect: r };
    }
  }
  return best?.node || null;
}

function place() {
  if (state.pos) { applyPos(); return; }
  const row = findHeaderRow();
  if (row) {
    const r = row.getBoundingClientRect();
    root.style.left = Math.min(window.innerWidth - 140, r.right + 8) + 'px';
    root.style.top = Math.max(4, r.top + (r.height - 28) / 2) + 'px';
  } else {
    // nothing recognisable: sit out of the way and let it be dragged
    root.style.left = (window.innerWidth - 150) + 'px';
    root.style.top = '76px';
  }
}

function applyPos() {
  const w = root.offsetWidth || 130;
  root.style.left = Math.max(4, Math.min(state.pos.left, window.innerWidth - w - 4)) + 'px';
  root.style.top = Math.max(4, Math.min(state.pos.top, window.innerHeight - 40)) + 'px';
}

function makeDraggable(handle) {
  let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, lastLeft = null, lastTop = null;
  const onMove = (e) => {
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!state.dragMoved && Math.abs(dx) + Math.abs(dy) < 3) return;
    state.dragMoved = true;
    const w = root.offsetWidth;
    lastLeft = Math.max(4, Math.min(baseLeft + dx, window.innerWidth - w - 4));
    lastTop = Math.max(4, Math.min(baseTop + dy, window.innerHeight - 40));
    root.style.left = lastLeft + 'px';
    root.style.top = lastTop + 'px';
    e.preventDefault();
  };
  const onUp = async () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    if (!state.dragMoved || lastLeft === null) return;
    state.pos = { left: Math.round(lastLeft), top: Math.round(lastTop) };
    await chrome.storage.local.set({ pmxPos: state.pos });
    // the click listener fires after mouseup; let it see this was a drag
    setTimeout(() => { state.dragMoved = false; }, 0);
  };
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const r = root.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    baseLeft = lastLeft ?? r.left; baseTop = lastTop ?? r.top;
    state.dragMoved = false;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }, true);
}

// --- talking to the worker ---------------------------------------------------

const send = (msg) => new Promise((res) => {
  try { chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r)); }
  catch (e) { res({ ok: false, error: e?.message || String(e) }); }
});

const $ = (id) => root?.querySelector('#' + ID + '-' + id);
const setText = (id, s) => { const n = $(id); if (n) n.textContent = s; };
const setHtml = (id, s) => { const n = $(id); if (n) n.innerHTML = s; };

const STATE_LABEL = {
  migratable: ['READY TO MIGRATE', 'ok'],
  migrated: ['ALREADY MIGRATED', 'dim'],
  'on-curve': ['STILL ON THE CURVE', 'warn'],
  blocked: ['BLOCKED', 'err'],
  'not-a-pump-coin': ['NOT A PUMP COIN', 'err'],
};

let resolving = null;
async function resolveMint(force) {
  if (resolving) return resolving;
  if (state.mint && state.info && !force) { paint(); return; }
  setText('ca', 'looking for the contract address…');
  resolving = (async () => {
    const candidates = candidateMints();
    if (!candidates.length) {
      setText('ca', 'no address found on this page');
      setText('state', '');
      return;
    }
    const r = await send({ type: 'pm:resolve', candidates });
    if (!r?.ok) {
      state.mint = null; state.info = null;
      setText('ca', candidates[0].slice(0, 6) + '…' + candidates[0].slice(-4));
      setHtml('state', `<span class="${ID}-err">${escapeHtml(r?.error || 'could not read this coin')}</span>`);
      paintButton();
      return;
    }
    state.mint = r.mint;
    state.info = r.info;
    paint();
  })();
  try { await resolving; } finally { resolving = null; }
}

function paint() {
  if (!root) return;
  if (state.mint) setText('ca', state.mint.slice(0, 6) + '…' + state.mint.slice(-4));
  const info = state.info;
  if (info) {
    const [label, kind] = STATE_LABEL[info.state] || ['UNKNOWN', 'dim'];
    setHtml('state', `<span class="${ID}-${kind}">${label}</span>`
      + (info.reason ? `<div class="${ID}-why">${escapeHtml(info.reason)}</div>` : ''));
    setText('sym', info.isNativeQuote ? 'SOL' : 'QUOTE');
  }
  paintButton();
}

function paintButton() {
  const btn = root.querySelector(`.${ID}-btn`);
  const dot = root.querySelector(`.${ID}-dot`);
  const st = state.info?.state;
  btn.classList.toggle(`${ID}-ready`, st === 'migratable');
  dot.className = `${ID}-dot ${st === 'migratable' ? 'ok' : st === 'on-curve' ? 'warn' : st === 'migrated' ? 'done' : ''}`;
  const go = $('go');
  if (go) {
    go.disabled = state.busy || st !== 'migratable';
    go.textContent = state.busy ? 'WORKING…' : (spendRaw() > 0n ? 'MIGRATE + BUY' : 'MIGRATE');
  }
}

/// The amount box in the quote's own base units.
function spendRaw() {
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
    + (p.bytes > 1232 ? ` · <b>goes as a bundle</b>` : ''));
}

async function onGo(e) {
  // A synthetic click from the page would carry isTrusted false. This is the
  // only control here that spends money, so it only answers to a real one.
  if (!e.isTrusted || state.busy || !state.mint) return;
  state.busy = true; paintButton();
  setText('status', 'starting…');
  const r = await send({
    type: 'pm:migrate', mint: state.mint,
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

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// status lines pushed from the worker while a migration runs
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'pm:status') setText('status', msg.text);
});

// --- keeping up with a single-page app ---------------------------------------

function onNavigated() {
  state.mint = null;
  state.info = null;
  setText('status', '');
  setText('hint', '');
  paint();
  // let the new page render before reading it
  setTimeout(() => { resolveMint(true).then(place); }, 700);
}

async function start() {
  const stored = await chrome.storage.local.get('pmxPos');
  state.pos = stored?.pmxPos || null;
  build();
  place();
  state.lastUrl = location.href;
  onNavigated();

  // Axiom swaps pages without reloading, so the URL is the signal. Polling it
  // is cruder than patching history, but it also catches the replaceState calls
  // an SPA makes without telling anyone.
  setInterval(() => {
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    onNavigated();
  }, 600);

  window.addEventListener('resize', () => { if (state.pos) applyPos(); });
}

start();
