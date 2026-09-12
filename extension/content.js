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
// what a dev buy is priced in, per pad - the number next to the button means
// nothing without it
const PAD_UNIT = {
  pump: 'SOL', otc: 'SOL', usd1: 'SOL', bonk: 'SOL', stonk: 'SOL', ansem: 'SOL', o1: 'SOL',
  eth: 'ETH', pons: 'ETH', pools: 'ETH',
  flap: 'BNB', 'four.meme': 'BNB',
};
const unitFor = (venue) => PAD_UNIT[String(venue || '').toLowerCase()] || 'SOL';

const FAIL_RE = /(timed?\s?out|timeout|failed|failure|error|rejected|declined|insufficient|try again|unable to|went wrong|blockhash|expired)/i;
const OK_RE = /(success|launched|deployed|created|confirmed|signature|mint(ed)?\b)/i;

const state = {
  settings: null,
  selectors: {},
  lastRead: null,
  matched: {},
  armedTimer: null,
  failed: false,
  busy: false,
  teaching: null,
  placing: false,
  armedToFire: false,
  confirmTimer: null,
  amtDirty: false,
  // a box you have typed into is yours until the next launch - the same rule as
  // the amount box. Without this, the 2.5s re-read wipes a pad you typed by
  // hand, which is now the normal way to fix an unreadable one.
  dirty: { name: false, symbol: false, venue: false },
  dragMoved: false,
  prepFp: '',
  prepTimer: null,
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

// Our own bar and button live in the page too, and they contain a NAME and a
// SYMBOL box of their own. Nothing used to exclude them, so a scan could match
// our empty input and read the ticker back as blank.
function isOurs(el) {
  return !!(el && el.closest && (el.closest('#j7fb-bar') || el.closest('#j7fb-inline-wrap')));
}

const FIELD_SELECTOR = 'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]),textarea';

function candidateFields() {
  return [...document.querySelectorAll(FIELD_SELECTOR)].filter((i) => visible(i) && !isOurs(i));
}

function labelsMatching(re) {
  return [...document.querySelectorAll('label,span,div,p,b,strong,h1,h2,h3,h4,h5,h6')]
    .filter((el) => {
      if (isOurs(el) || el.children.length || !visible(el)) return false;
      const t = text(el);
      return t.length > 0 && t.length < 40 && re.test(t);
    });
}

/// Find the box a caption belongs to.
///
/// j7 stacks a small uppercase caption above each box, so the honest way to pair
/// them is the way your eye does: the nearest box that starts below the caption
/// and lines up underneath it. Walking up the DOM and taking "the next input
/// after this label" is not the same thing - a panel that puts two fields in one
/// row (WEBSITE and TWITTER) nests them in ways that make the next input the
/// wrong one, which is how the ticker ended up unreadable.
function findFieldFor(labelRe, hintRe) {
  const fields = candidateFields();
  if (!fields.length) return null;

  // a box that names itself is better evidence than any amount of geometry,
  // but only when exactly one box claims the name
  if (hintRe) {
    const named = fields.filter((i) => hintRe.test([
      i.getAttribute('placeholder') || '', i.getAttribute('name') || '',
      i.getAttribute('aria-label') || '', i.id || '',
    ].join(' ')));
    if (named.length === 1) return named[0];
  }

  let best = null;
  for (const lab of labelsMatching(labelRe)) {
    const forId = lab.getAttribute('for');
    if (forId) {
      const byId = document.getElementById(forId);
      if (byId && !isOurs(byId)) return byId;
    }
    const lr = lab.getBoundingClientRect();
    for (const f of fields) {
      const fr = f.getBoundingClientRect();
      if (fr.top < lr.top - 2) continue;                       // above the caption
      const overlap = Math.min(lr.right, fr.right) - Math.max(lr.left, fr.left);
      if (overlap <= 0) continue;                              // a different column
      const gap = fr.top - lr.bottom;
      if (gap > 140) continue;                                 // too far to belong to it
      const score = Math.min(overlap, 200) / 10 - Math.abs(gap);
      if (!best || score > best.score) best = { el: f, score };
    }
  }
  return best ? best.el : null;
}

function bySelector(key) {
  const sel = state.selectors[key];
  if (!sel) return null;
  try { return document.querySelector(sel); } catch { return null; }
}

function describe(el) {
  if (!el) return 'nothing matched';
  const bits = [el.tagName.toLowerCase()];
  if (el.id) bits.push('#' + el.id);
  const ph = el.getAttribute && el.getAttribute('placeholder');
  if (ph) bits.push('placeholder "' + ph.slice(0, 24) + '"');
  return bits.join(' ');
}

function readField(key, labelRe, hintRe) {
  const el = bySelector(key) || findFieldFor(labelRe, hintRe);
  state.matched[key] = (state.selectors[key] ? 'taught: ' : '') + describe(el);
  if (!el) return '';
  return (el.value ?? text(el) ?? '').trim();
}

/// Which pad is selected.
///
/// This one matters more than the rest: a wrong answer launches your coin on
/// the wrong chain. It used to fall back to the first pad in the DOM when it
/// could not tell, which is Pump - so a Robinhood-chain coin could go to
/// pump.fun. Now an unclear answer is reported as unclear.
///
/// The pads are a grid of near-identical chips with one drawn differently, so
/// rather than guess at j7's class names, every chip's computed style is
/// compared against the others and the odd one out wins. That survives a
/// restyle in a way a class name does not, and it is how you pick it out by eye.
function padCandidates() {
  const byEl = new Map();
  for (const el of document.querySelectorAll('button,[role="button"],a,div,span')) {
    if (isOurs(el) || !visible(el)) continue;
    const name = PAD_NAMES.find((pad) => norm(text(el)) === pad);
    if (!name) continue;
    // the chip that carries the styling is the button, not the text node inside
    const chip = el.closest('button,[role="button"],a') || el;
    if (isOurs(chip)) continue;
    const prev = byEl.get(chip);
    if (!prev || prev.length > name.length) byEl.set(chip, name);
  }
  return [...byEl].map(([el, name]) => ({ el, name }));
}

function modeOf(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (!best || n > best.n) best = { v, n };
  return best ? best.v : null;
}

function readVenue() {
  const taught = bySelector('venue');
  if (taught) {
    const t = norm(text(taught));
    const hit = PAD_NAMES.find((pad) => t.includes(pad));
    if (hit) { state.matched.venue = 'taught: ' + hit; return hit; }
  }

  const pads = padCandidates();
  if (pads.length < 2) { state.matched.venue = 'no pad grid found'; return ''; }

  // an explicit state beats any amount of style comparison
  const flagged = pads.filter(({ el }) =>
    el.getAttribute('aria-pressed') === 'true'
    || el.getAttribute('aria-selected') === 'true'
    || el.getAttribute('aria-checked') === 'true'
    || el.getAttribute('data-state') === 'active'
    || el.getAttribute('data-active') === 'true'
    || el.getAttribute('data-selected') === 'true');
  if (flagged.length === 1) {
    state.matched.venue = flagged[0].name + ' (aria/data state)';
    return flagged[0].name;
  }

  const classed = pads.filter(({ el }) => {
    const cls = typeof el.className === 'string' ? el.className : '';
    return /(^|[^a-z])(active|selected|chosen|current)([^a-z]|$)/i.test(cls);
  });
  if (classed.length === 1) {
    state.matched.venue = classed[0].name + ' (class)';
    return classed[0].name;
  }

  // style outlier: whichever chip differs from what the others agree on
  const PROPS = ['backgroundColor', 'borderTopColor', 'color', 'borderTopWidth', 'boxShadow'];
  const styles = pads.map(({ el }) => {
    const cs = getComputedStyle(el);
    const out = {};
    for (const prop of PROPS) out[prop] = String(cs[prop] || '');
    return out;
  });
  const modes = {};
  for (const prop of PROPS) modes[prop] = modeOf(styles.map((st) => st[prop]));

  const scores = pads.map((pad, i) => {
    let differs = 0;
    for (const prop of PROPS) if (styles[i][prop] !== modes[prop]) differs += 1;
    return { ...pad, differs };
  }).sort((x, y) => y.differs - x.differs);

  const top = scores[0];
  const tie = scores.filter((x) => x.differs === top.differs).length > 1;
  if (top.differs > 0 && !tie) {
    state.matched.venue = top.name + ` (styled unlike the other ${pads.length - 1})`;
    return top.name;
  }

  state.matched.venue = tie
    ? `unclear - ${scores.filter((x) => x.differs === top.differs).map((x) => x.name).join(' and ')} look alike`
    : `unclear - all ${pads.length} pads look identical`;
  return '';
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
  const name = readField('name', /^(name|token name)/i, /token ?name/i);
  // "ticker" is what people call it even when the panel says SYMBOL
  const symbol = readField('symbol', /^(symbol|ticker)/i, /symbol|ticker/i);
  const website = readField('website', /^(website|site|url)/i, /website|url/i);
  const twitter = readField('twitter', /^twitter/i, /twitter|x[.]com/i);
  const devBuyRaw = readField('devBuy', /^(dev ?buy|amount|buy)/i, null);

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
      <button class="j7fb-mini" id="j7fb-place" title="move the FALLBACK button">⇱</button>
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
  for (const k of ['name', 'symbol', 'venue']) {
    fields[k].addEventListener('input', () => { state.dirty[k] = fields[k].value.trim() !== ''; });
  }
  statusEl = bar.querySelector('#j7fb-status');
  fireBtn = bar.querySelector('#j7fb-fire');
  bannerEl = bar.querySelector('#j7fb-banner');

  applyBarPos();
  makeDraggable(bar.querySelector('.j7fb-head'));

  bar.querySelector('#j7fb-refresh').onclick = () => refresh(true);
  bar.querySelector('#j7fb-hide').onclick = () => bar.classList.add('j7fb-min');
  bar.querySelector('#j7fb-teach').onclick = startTeaching;
  bar.querySelector('#j7fb-place').onclick = startPlacing;
  bar.querySelector('.j7fb-head').onclick = (e) => {
    if (e.target.closest('.j7fb-mini')) return;
    if (state.dragMoved) return;   // a drag that ended on the header is not a click
    bar.classList.toggle('j7fb-min');
  };
  fireBtn.onclick = () => fire(false);
}

/// Put the bar back where it was left. Stored as a corner offset rather than an
/// absolute point so it stays put when the window is a different size than it
/// was, and clamped on the way in so a saved position on a since-detached
/// monitor cannot leave it off-screen.
function applyBarPos() {
  const pos = state.settings?.barPos;
  if (!pos) return;
  const w = bar.offsetWidth || 300;
  const h = bar.offsetHeight || 200;
  const left = Math.max(4, Math.min(pos.left, window.innerWidth - w - 4));
  const top = Math.max(4, Math.min(pos.top, window.innerHeight - h - 4));
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
  bar.style.right = 'auto';
  bar.style.bottom = 'auto';
}

function makeDraggable(handle) {
  let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
  // remember where it was actually put rather than asking layout again on the
  // way out - the value saved should be the one that was applied
  let lastLeft = null, lastTop = null;

  const onMove = (e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!state.dragMoved && Math.abs(dx) + Math.abs(dy) < 3) return;  // still a click
    state.dragMoved = true;
    const w = bar.offsetWidth, h = bar.offsetHeight;
    const left = Math.max(4, Math.min(baseLeft + dx, window.innerWidth - w - 4));
    const top = Math.max(4, Math.min(baseTop + dy, window.innerHeight - h - 4));
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
    lastLeft = left; lastTop = top;
    e.preventDefault();
  };

  const onUp = async () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    bar.classList.remove('j7fb-dragging');
    if (!state.dragMoved || lastLeft === null) return;
    const barPos = { left: Math.round(lastLeft), top: Math.round(lastTop) };
    if (state.settings) state.settings.barPos = barPos;
    await chrome.storage.local.set({ barPos });
    // the click handler runs after mouseup; let it see that this was a drag
    setTimeout(() => { state.dragMoved = false; }, 0);
  };

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.j7fb-mini')) return;
    const r = bar.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    baseLeft = lastLeft ?? r.left;
    baseTop = lastTop ?? r.top;
    state.dragMoved = false;
    bar.classList.add('j7fb-dragging');
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

function paint(read) {
  if (!bar) return;
  for (const k of ['name', 'symbol', 'venue']) {
    if (state.dirty[k] || document.activeElement === fields[k]) continue;
    fields[k].value = read[k] ?? '';
  }
  if (document.activeElement !== fields.devBuySol) fields.devBuySol.value = read.devBuySol ?? 0;
  const box = bar.querySelector('#j7fb-img');
  box.innerHTML = read.imageDataUrl
    ? `<img src="${read.imageDataUrl}"><span>image mirrored</span>`
    : '<span class="j7fb-warn">no image found — j7 may not have loaded one yet</span>';
  // say what each box is looking at, so a misread is diagnosable instead of
  // just wrong
  for (const k of ['name', 'symbol', 'venue']) {
    if (fields[k]) fields[k].title = state.matched[k] || '';
  }
  if (fields.venue && !read.venue && state.matched.venue) {
    fields.venue.placeholder = state.matched.venue.slice(0, 40);
  }

  const dot = bar.querySelector('#j7fb-dot');
  const ready = read.name && read.symbol && read.venue;
  dot.className = 'j7fb-dot ' + (state.busy ? 'busy' : ready ? 'ok' : 'warn');
  dot.title = ready ? 'panel mirrored' : 'still missing something';
  paintInline();
}

/// Nudge the worker to read pump's config and pin the metadata ahead of time.
///
/// Debounced and fingerprinted so typing a name does not fire an upload per
/// keystroke - only a panel that has settled into a new shape triggers one.
function prepare(read) {
  const fp = [read.name, read.symbol, read.venue, (read.imageDataUrl || '').length].join('|');
  if (fp === state.prepFp) return;
  state.prepFp = fp;
  clearTimeout(state.prepTimer);
  state.prepTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'j7fb:prepare', params: currentParams() }).catch(() => {});
  }, 900);
}

async function refresh(showStatus) {
  const read = await readPanel();
  paint(read);
  if (read.name && read.symbol) prepare(read);
  if (showStatus) {
    const missing = ['name', 'symbol', 'venue'].filter((k) => !read[k]);
    if (!missing.length) setStatus('panel mirrored');
    else if (missing.length === 1 && missing[0] === 'venue') {
      setStatus(`pad unreadable (${state.matched.venue}) — type it above, or ◎ to teach it`, 'err');
    } else {
      setStatus(`could not read: ${missing.join(', ')} — type it here or use ◎ to teach it`, 'err');
    }
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
    devBuySol: firstNumber(inlineAmt?.value) ?? firstNumber(fields.devBuySol?.value) ?? read.devBuySol ?? 0,
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
      state.amtDirty = false;
      state.dirty = { name: false, symbol: false, venue: false };
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

// --- the button inside j7's own panel ---------------------------------------
//
// The floating bar is fine for watching, but the point of a fallback is that it
// is already sitting where your hand is when the deploy fails. So one button is
// injected into j7's own toolbar, next to its Panel control.
//
// Anchoring is done the way everything else here is: a taught position wins, and
// otherwise it is found by a landmark with a stable name rather than a class we
// guessed at.

let inlineBtn = null;
let inlineAmt = null;
let inlineUnit = null;

function findAnchor() {
  const taught = bySelector('anchor');
  if (taught && visible(taught)) return { el: taught, where: 'after' };

  // the drawn spot: the toolbar row that ends in j7's "Panel" button
  const panel = [...document.querySelectorAll('button,[role="button"],a,div,span')]
    .find((el) => visible(el) && norm(text(el)) === 'panel' && el.children.length <= 2);
  if (panel) return { el: panel, where: 'before' };

  const deploy = [...document.querySelectorAll('button,[role="button"]')]
    .find((el) => visible(el) && /^deploy\b/.test(norm(text(el))));
  if (deploy) return { el: deploy, where: 'before' };

  return null;
}

function mountInline() {
  if (inlineBtn && document.contains(inlineBtn)) return;
  const spot = findAnchor();
  if (!spot) return;

  const wrap = document.createElement('span');
  wrap.id = 'j7fb-inline-wrap';

  inlineAmt = document.createElement('input');
  inlineAmt.id = 'j7fb-inline-amt';
  inlineAmt.type = 'text';
  inlineAmt.spellcheck = false;
  inlineAmt.title = 'dev buy for the fallback launch';
  // j7 binds hotkeys on the document (Enter deploys), so nothing typed in here
  // may reach it
  for (const ev of ['keydown', 'keyup', 'keypress']) {
    inlineAmt.addEventListener(ev, (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); onInlineClick(); }
    }, true);
  }
  inlineAmt.addEventListener('input', () => {
    // once you have typed an amount it is yours: stop mirroring j7's over it,
    // or clicking the button (which moves focus) would quietly restore the old
    // number and launch for the wrong size
    state.amtDirty = inlineAmt.value.trim() !== '';
    if (fields.devBuySol) fields.devBuySol.value = inlineAmt.value;
  });
  inlineAmt.addEventListener('click', (e) => e.stopPropagation(), true);

  inlineUnit = document.createElement('span');
  inlineUnit.id = 'j7fb-inline-unit';

  inlineBtn = document.createElement('button');
  inlineBtn.id = 'j7fb-inline';
  inlineBtn.type = 'button';
  inlineBtn.addEventListener('click', (e) => {
    // j7 owns this toolbar; do not let the click reach whatever it has bound
    e.preventDefault();
    e.stopPropagation();
    onInlineClick();
  }, true);

  wrap.append(inlineAmt, inlineUnit, inlineBtn);
  if (spot.where === 'before') spot.el.parentElement?.insertBefore(wrap, spot.el);
  else spot.el.parentElement?.insertBefore(wrap, spot.el.nextSibling);
  paintInline();
}

/// Two stages, so a stray click in a dense toolbar cannot spend SOL - except
/// when j7 has already failed, where the button pre-arms itself and the whole
/// thing is the one click it should be.
function onInlineClick() {
  if (state.busy) return;
  if (state.armedToFire) {
    clearTimeout(state.confirmTimer);
    state.armedToFire = false;
    fire(false);
    paintInline();
    return;
  }
  state.armedToFire = true;
  paintInline();
  clearTimeout(state.confirmTimer);
  state.confirmTimer = setTimeout(() => { state.armedToFire = false; paintInline(); }, 4000);
}

function paintInline() {
  if (!inlineBtn) return;
  const read = state.lastRead || {};
  const ready = !!(read.name && read.symbol && read.venue);

  if (inlineUnit) inlineUnit.textContent = unitFor(read.venue);
  if (inlineAmt && !state.amtDirty && document.activeElement !== inlineAmt) {
    inlineAmt.value = String(read.devBuySol ?? 0);
  }
  inlineBtn.classList.toggle('j7fb-i-alert', state.failed && !state.busy);
  inlineBtn.classList.toggle('j7fb-i-arm', state.armedToFire);
  inlineBtn.classList.toggle('j7fb-i-busy', state.busy);
  inlineBtn.classList.toggle('j7fb-i-cold', !ready);

  inlineBtn.textContent = state.busy ? 'DEPLOYING…'
    : state.armedToFire ? 'FIRE?'
    : state.failed ? 'FALLBACK !'
    : 'FALLBACK';

  inlineBtn.title = !ready
    ? 'the panel is missing a name, symbol or pad - open the fallback bar to check'
    : state.armedToFire ? 'click again to launch ' + read.symbol
    : `launch ${read.symbol} on ${read.venue} for ${inlineAmt?.value || 0} ${unitFor(read.venue)}`
      + (state.failed ? ' (j7 failed)' : '');
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
  state.armedToFire = true;
  clearTimeout(state.confirmTimer);
  paintInline();
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

/// Put the FALLBACK button somewhere else: click whatever it should sit next to.
function startPlacing() {
  state.placing = true;
  setStatus('click where the FALLBACK button should go (Esc to stop)');
  document.body.classList.add('j7fb-teaching');
  document.addEventListener('click', placeClick, true);
  document.addEventListener('keydown', placeEsc, true);
}

function stopPlacing(msg) {
  state.placing = false;
  document.body.classList.remove('j7fb-teaching');
  document.removeEventListener('click', placeClick, true);
  document.removeEventListener('keydown', placeEsc, true);
  setStatus(msg);
}

function placeEsc(e) { if (e.key === 'Escape') { e.preventDefault(); stopPlacing('left where it was'); } }

async function placeClick(e) {
  if (e.target.closest?.('#j7fb-bar') || e.target.closest?.('#j7fb-inline-wrap')) return;
  e.preventDefault();
  e.stopPropagation();
  state.selectors.anchor = cssPath(e.target);
  await chrome.storage.local.set({ selectors: state.selectors });
  document.getElementById('j7fb-inline-wrap')?.remove();
  inlineBtn = null;
  mountInline();
  stopPlacing('button moved');
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
  state.settings.barPos = (await chrome.storage.local.get('barPos')).barPos || null;

  buildBar();
  mountInline();
  await refresh(true);
  startWatching();
  window.addEventListener('resize', () => { if (bar) applyBarPos(); });
  // j7 is a single-page app, so the panel - and our button with it - appears and
  // disappears under us
  setInterval(() => {
    if (state.busy || state.teaching != null || state.placing) return;
    mountInline();
    refresh(false);
  }, 2500);
}

boot();
