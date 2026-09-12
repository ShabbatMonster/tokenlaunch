// ---------------------------------------------------------------------------
// Runs inside j7tracker.io. Reads the deploy panel, watches the deploy attempt,
// and when it fails puts our own launch in front of the error.
//
// It never holds the key. All it can do is post what it read to the service
// worker and render whatever status comes back.
//
// j7's markup is not ours and will change, so nothing here depends on a class
// name we guessed. Fields are found the way a person finds them - by the label
// sitting above them - and anything the heuristics get wrong can be corrected
// in the bar itself or taught permanently with the picker. What is read is
// always shown before it is used, because a launcher that silently mirrors the
// wrong symbol is worse than one that admits it is unsure.
// ---------------------------------------------------------------------------

const PAD_NAMES = [
  'pump', 'otc', 'usd1', 'bonk', 'stonk', 'ansem',
  'four.meme', 'o1', 'eth', 'flap', 'pons', 'pools',
];
const FAIL_RE = /(timed?\s?out|timeout|failed|failure|error|rejected|declined|insufficient|try again|unable to|went wrong|blockhash|expired)/i;
const OK_RE = /(success|launched|deployed|created|confirmed|signature|mint(ed)?\b)/i;

const state = {
  settings: null,
  selectors: {},
  lastRead: null,
  armedTimer: null,
  failed: false,
  busy: false,
  teaching: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const text = (el) => (el?.textContent || '').trim();
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// --- reading the panel ------------------------------------------------------

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/// Find the input a label belongs to. j7 stacks a small uppercase label above
/// each field, so the match is "the first field that starts after this label",
/// which survives restyling in a way a class name would not.
function inputForLabel(re) {
  const all = [...document.querySelectorAll('label,span,div,p,h1,h2,h3,h4,h5,h6')];
  const labels = all.filter((el) => {
    const t = text(el);
    return t.length < 40 && re.test(t) && el.children.length === 0 && visible(el);
  });
  for (const lab of labels) {
    // an explicit association wins whenever j7 provides one
    const forId = lab.getAttribute?.('for');
    if (forId) {
      const byId = document.getElementById(forId);
      if (byId) return byId;
    }
    let scope = lab;
    for (let up = 0; up < 4 && scope; up++) {
      const field = [...scope.querySelectorAll('input,textarea')]
        .find((i) => visible(i) && i.type !== 'checkbox' && i.type !== 'radio'
          && (lab.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (field) return field;
      scope = scope.parentElement;
    }
  }
  return null;
}

function bySelector(key) {
  const sel = state.selectors[key];
  if (!sel) return null;
  try { return document.querySelector(sel); } catch { return null; }
}

function readField(key, re) {
  const el = bySelector(key) || inputForLabel(re);
  if (!el) return '';
  return (el.value ?? text(el) ?? '').trim();
}

/// Which pad is selected. A chosen button differs from its neighbours somehow -
/// aria state, a class, or just a brighter border - so rather than guess j7's
/// class names, compare each candidate against the others and take the odd one.
function readVenue() {
  const taught = bySelector('venue');
  if (taught) {
    const t = norm(text(taught));
    const hit = PAD_NAMES.find((p) => t.includes(p));
    if (hit) return hit;
  }

  const buttons = [...document.querySelectorAll('button,[role="button"],a,div,span')]
    .filter((el) => visible(el) && el.children.length <= 2)
    .map((el) => ({ el, name: PAD_NAMES.find((p) => norm(text(el)) === p) }))
    .filter((x) => x.name);
  if (!buttons.length) return '';

  const scored = buttons.map(({ el, name }) => {
    const cs = getComputedStyle(el);
    const cls = (el.className && typeof el.className === 'string') ? el.className : '';
    let score = 0;
    if (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true') score += 10;
    if (el.getAttribute('data-state') === 'active' || el.getAttribute('data-active') === 'true') score += 10;
    if (/\b(active|selected|chosen|current|on)\b/i.test(cls)) score += 6;
    // a selected chip is usually the one that bothered to draw a border colour
    const border = cs.borderTopColor || '';
    if (border && !/rgba?\(0, 0, 0, 0\)|transparent/.test(border)) score += 1;
    if (cs.outlineStyle && cs.outlineStyle !== 'none') score += 1;
    return { el, name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].name : (scored[0]?.name || '');
}

function readToggle(labelRe) {
  const hit = [...document.querySelectorAll('button,[role="button"],label,div,span')]
    .find((el) => visible(el) && labelRe.test(text(el)) && text(el).length < 30);
  if (!hit) return null;
  const box = hit.querySelector?.('input[type=checkbox]');
  if (box) return box.checked;
  const aria = hit.getAttribute('aria-checked') || hit.getAttribute('aria-pressed');
  if (aria != null) return aria === 'true';
  const cls = typeof hit.className === 'string' ? hit.className : '';
  if (/\b(active|selected|on|checked)\b/i.test(cls)) return true;
  return null;
}

/// The image, as a data URL so it can survive the trip to the service worker.
/// Tries the file input first (the original bytes), then whatever preview j7
/// rendered, which may be a blob: URL only this page can read.
async function readImage() {
  const fileInput = [...document.querySelectorAll('input[type=file]')].find((i) => i.files?.length);
  if (fileInput?.files?.[0]) return await blobToDataUrl(fileInput.files[0]);

  const taught = bySelector('image');
  const imgs = taught ? [taught] : [...document.querySelectorAll('img')].filter(visible);
  for (const img of imgs) {
    const src = img.currentSrc || img.src || '';
    if (!src || src.startsWith('data:image/svg')) continue;
    if (/^(blob:|data:image)/.test(src) || img.naturalWidth >= 64) {
      try { return await urlToDataUrl(src); } catch { /* try the next one */ }
    }
  }
  return '';
}

const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});

async function urlToDataUrl(src) {
  if (src.startsWith('data:')) return src;
  const r = await fetch(src);
  return await blobToDataUrl(await r.blob());
}

function firstNumber(s) {
  const m = String(s ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

async function readPanel() {
  const name = readField('name', /^name\b/i);
  const symbol = readField('symbol', /^symbol\b/i);
  const website = readField('website', /^website/i);
  const twitter = readField('twitter', /^twitter/i);
  const devBuyRaw = readField('devBuy', /^(dev\s?buy|amount|buy)\b/i);

  const read = {
    name, symbol, website, twitter,
    venue: readVenue(),
    devBuySol: firstNumber(devBuyRaw) ?? (state.settings?.defaultDevBuySol ?? 0),
    cashback: readToggle(/^cashback$/i),
    feesToHolders: readToggle(/fee\s?split/i),
    imageDataUrl: await readImage(),
  };
  state.lastRead = read;
  return read;
}

// --- the bar ----------------------------------------------------------------

let bar, fields = {}, statusEl, fireBtn, bannerEl;

function buildBar() {
  if (bar) return;
  bar = document.createElement('div');
  bar.id = 'j7fb-bar';
  bar.innerHTML = `
    <div class="j7fb-head">
      <b>DEPLOY FALLBACK</b>
      <span class="j7fb-dot" id="j7fb-dot"></span>
      <span class="j7fb-grow"></span>
      <button class="j7fb-mini" id="j7fb-refresh" title="re-read the panel">↻</button>
      <button class="j7fb-mini" id="j7fb-teach" title="teach a field">◎</button>
      <button class="j7fb-mini" id="j7fb-hide" title="hide">✕</button>
    </div>
    <div class="j7fb-banner" id="j7fb-banner" hidden></div>
    <div class="j7fb-grid">
      <label>NAME<input id="j7fb-name" spellcheck="false"></label>
      <label>SYMBOL<input id="j7fb-symbol" spellcheck="false"></label>
      <label>PAD<input id="j7fb-venue" spellcheck="false"></label>
      <label>DEV BUY (SOL)<input id="j7fb-devBuySol" spellcheck="false"></label>
    </div>
    <div class="j7fb-img" id="j7fb-img"></div>
    <button class="j7fb-fire" id="j7fb-fire">DEPLOY THIS MYSELF</button>
    <div class="j7fb-status" id="j7fb-status"></div>
  `;
  document.documentElement.appendChild(bar);

  for (const k of ['name', 'symbol', 'venue', 'devBuySol']) fields[k] = bar.querySelector('#j7fb-' + k);
  statusEl = bar.querySelector('#j7fb-status');
  fireBtn = bar.querySelector('#j7fb-fire');
  bannerEl = bar.querySelector('#j7fb-banner');

  bar.querySelector('#j7fb-refresh').onclick = () => refresh(true);
  bar.querySelector('#j7fb-hide').onclick = () => bar.classList.add('j7fb-min');
  bar.querySelector('#j7fb-teach').onclick = startTeaching;
  bar.querySelector('.j7fb-head').onclick = (e) => {
    if (e.target.closest('.j7fb-mini')) return;
    bar.classList.toggle('j7fb-min');
  };
  fireBtn.onclick = () => fire(false);
}

function paint(read) {
  if (!bar) return;
  for (const k of ['name', 'symbol', 'venue']) if (document.activeElement !== fields[k]) fields[k].value = read[k] ?? '';
  if (document.activeElement !== fields.devBuySol) fields.devBuySol.value = read.devBuySol ?? 0;
  const box = bar.querySelector('#j7fb-img');
  box.innerHTML = read.imageDataUrl
    ? `<img src="${read.imageDataUrl}"><span>image mirrored</span>`
    : '<span class="j7fb-warn">no image found — j7 may not have loaded one yet</span>';
  const dot = bar.querySelector('#j7fb-dot');
  const ready = read.name && read.symbol && read.venue;
  dot.className = 'j7fb-dot ' + (state.busy ? 'busy' : ready ? 'ok' : 'warn');
  dot.title = ready ? 'panel mirrored' : 'still missing something';
}

async function refresh(showStatus) {
  const read = await readPanel();
  paint(read);
  if (showStatus) {
    const missing = ['name', 'symbol', 'venue'].filter((k) => !read[k]);
    setStatus(missing.length ? `could not read: ${missing.join(', ')} — type it here or use ◎ to teach it` : 'panel mirrored');
  }
  return read;
}

function setStatus(msg, kind = '') {
  if (statusEl) { statusEl.textContent = msg; statusEl.className = 'j7fb-status ' + kind; }
}

function showBanner(msg) {
  if (!bannerEl) return;
  bannerEl.hidden = false;
  bannerEl.textContent = msg;
  bar.classList.remove('j7fb-min');
  bar.classList.add('j7fb-alert');
}

/// What actually gets launched: the mirrored panel, with anything typed into
/// the bar taking priority, because those edits are the user correcting us.
function currentParams() {
  const read = state.lastRead || {};
  return {
    ...read,
    name: fields.name?.value.trim() || read.name,
    symbol: fields.symbol?.value.trim() || read.symbol,
    venue: (fields.venue?.value.trim() || read.venue || '').toLowerCase(),
    devBuySol: firstNumber(fields.devBuySol?.value) ?? read.devBuySol ?? 0,
  };
}

async function fire(force) {
  if (state.busy) return;
  const params = currentParams();
  if (!params.name || !params.symbol) { setStatus('need a name and a symbol', 'err'); return; }
  if (!params.venue) { setStatus('need a pad — type e.g. pump', 'err'); return; }

  state.busy = true;
  fireBtn.disabled = true;
  setStatus('starting…');
  paint(state.lastRead || params);
  try {
    const res = await chrome.runtime.sendMessage({ type: 'j7fb:deploy', params, force });
    if (res?.ok) {
      setStatus(`launched on ${res.result.venue}: ${res.result.mint ?? 'see wallet'}`, 'ok');
      showBanner('Launched by the fallback — j7 did not need to succeed.');
    } else {
      setStatus(res?.error || 'failed', 'err');
      fireBtn.textContent = 'TRY AGAIN';
    }
  } catch (e) {
    setStatus(e?.message || String(e), 'err');
  } finally {
    state.busy = false;
    fireBtn.disabled = false;
  }
}

// --- watching j7 ------------------------------------------------------------

function looksLikeDeployClick(el) {
  const t = norm(text(el.closest('button,[role="button"],a') || el));
  return /^deploy\b/.test(t) || t.includes('deploy (enter)');
}

function armTakeover(why) {
  clearTimeout(state.armedTimer);
  const delay = state.settings?.takeoverDelayMs ?? 20000;
  state.armedTimer = setTimeout(() => {
    if (state.failed || state.busy) return;
    state.failed = true;
    onFailure(why || `j7 did not confirm within ${Math.round(delay / 1000)}s`);
  }, delay);
}

async function onFailure(reason) {
  await refresh(false);
  showBanner('j7 could not deploy: ' + reason);
  setStatus(state.settings?.autoFire ? 'taking over automatically…' : 'ready to take over — press the button');
  if (state.settings?.autoFire) fire(false);
}

function startWatching() {
  document.addEventListener('click', (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (looksLikeDeployClick(el)) {
      state.failed = false;
      if (bannerEl) bannerEl.hidden = true;
      bar?.classList.remove('j7fb-alert');
      refresh(false);
      armTakeover(null);
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !state.busy) { refresh(false); armTakeover(null); }
  }, true);

  // j7's own toasts are the earliest and clearest failure signal there is
  const seen = new WeakSet();
  const obs = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (!(node instanceof Element) || seen.has(node)) continue;
        seen.add(node);
        if (node.closest?.('#j7fb-bar')) continue;
        const t = text(node);
        if (!t || t.length > 400) continue;
        if (OK_RE.test(t) && !FAIL_RE.test(t)) { clearTimeout(state.armedTimer); state.failed = false; continue; }
        if (FAIL_RE.test(t) && !state.busy && !state.failed) {
          state.failed = true;
          clearTimeout(state.armedTimer);
          onFailure(t.slice(0, 160));
        }
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// --- teaching a field -------------------------------------------------------

const TEACH_ORDER = ['name', 'symbol', 'website', 'twitter', 'devBuy', 'venue', 'image'];

function cssPath(el) {
  if (el.id) return '#' + CSS.escape(el.id);
  for (const attr of ['data-testid', 'data-test', 'name', 'placeholder', 'aria-label']) {
    const v = el.getAttribute?.(attr);
    if (v) return `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(v).replace(/\\/g, '')}"]`;
  }
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && parts.length < 6) {
    const parent = cur.parentElement;
    if (!parent) break;
    const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
    const idx = same.indexOf(cur) + 1;
    parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${idx})`);
    if (parent.id) { parts.unshift('#' + CSS.escape(parent.id)); break; }
    cur = parent;
  }
  return parts.join(' > ');
}

function startTeaching() {
  state.teaching = 0;
  setStatus(`click j7's ${TEACH_ORDER[0].toUpperCase()} field (Esc to stop)`);
  document.body.classList.add('j7fb-teaching');
  document.addEventListener('click', teachClick, true);
  document.addEventListener('keydown', teachEsc, true);
}

function stopTeaching(msg) {
  state.teaching = null;
  document.body.classList.remove('j7fb-teaching');
  document.removeEventListener('click', teachClick, true);
  document.removeEventListener('keydown', teachEsc, true);
  setStatus(msg || 'done teaching');
  refresh(true);
}

function teachEsc(e) { if (e.key === 'Escape') { e.preventDefault(); stopTeaching('stopped'); } }

async function teachClick(e) {
  if (e.target.closest?.('#j7fb-bar')) return;
  e.preventDefault();
  e.stopPropagation();
  const key = TEACH_ORDER[state.teaching];
  state.selectors[key] = cssPath(e.target);
  await chrome.storage.local.set({ selectors: state.selectors });
  state.teaching += 1;
  if (state.teaching >= TEACH_ORDER.length) { stopTeaching('all fields taught'); return; }
  setStatus(`click j7's ${TEACH_ORDER[state.teaching].toUpperCase()} field (Esc to stop)`);
}

// --- boot -------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'j7fb:status') setStatus(msg.text);
  if (msg?.type === 'j7fb:fire') fire(true);
  if (msg?.type === 'j7fb:refresh') refresh(true);
});

async function boot() {
  state.settings = await chrome.runtime.sendMessage({ type: 'j7fb:getSettings' }).catch(() => null);
  if (!state.settings?.armed) return; // disarmed: stay completely out of the page
  state.selectors = (await chrome.storage.local.get('selectors')).selectors || {};

  buildBar();
  await refresh(true);
  startWatching();
  // j7 is a single-page app, so the panel appears and disappears under us
  setInterval(() => { if (!state.busy && state.teaching == null) refresh(false); }, 2500);
}

boot();
