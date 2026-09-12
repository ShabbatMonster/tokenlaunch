import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

// Run with:  npm i --no-save jsdom && node extension/test/panel.test.mjs
//
// The panel reader is heuristic - it finds j7's fields by the label above them
// rather than by a class name we guessed - so this is the test that keeps it
// honest against a mock of the real layout, plus the three cases that decide
// whether money moves: j7 errors, j7 says nothing at all, and j7 succeeds.

// A mock of the j7 deploy panel as it appears in the screenshot: small uppercase
// labels stacked above their inputs, a grid of pad buttons with one highlighted,
// and a row of toggle chips.
const html = `<!doctype html><body>
<div id="panel">
  <div class="hdr">Token Deploy</div>
  <div class="f"><span data-rect="10,40,60,52">NAME</span><span class="cnt">0/32</span>
    <input id="n" data-rect="10,56,690,88" value="Not Safe For Work"></div>
  <div class="f"><span data-rect="10,110,70,122">SYMBOL</span><span class="cnt">0/13</span>
    <input id="s" data-rect="10,126,690,158" value="NSFW"></div>
  <div class="row">
    <div class="f"><span data-rect="10,180,90,192">WEBSITE (OPT.)</span>
      <input id="w" data-rect="10,196,340,228" placeholder="https://example.com"></div>
    <div class="f"><span data-rect="360,180,430,192">TWITTER</span>
      <input id="t" data-rect="360,196,690,228" value="https://x.com/nsfw"></div>
  </div>
  <div class="imgbox"><span>Select Image</span><img id="preview" src="data:image/png;base64,iVBORw0KGgo="></div>
  <div class="pads">
    <button aria-pressed="true" class="pad active">Pump</button>
    <button class="pad">OTC</button>
    <button class="pad">USD1</button>
    <button class="pad">BONK</button>
    <button class="pad">Stonk</button>
    <button class="pad">Ansem</button>
    <button class="pad">four.meme</button>
    <button class="pad">o1</button>
    <button class="pad">ETH</button>
    <button class="pad">Flap</button>
    <button class="pad">Pons</button>
    <button class="pad">Pools</button>
  </div>
  <div class="opts">
    <div class="chip" aria-checked="true">Cashback</div>
    <div class="chip" aria-checked="false">Pair · SOL</div>
    <div class="chip" aria-checked="false">Fee Split</div>
    <div class="chip" aria-checked="false">Bundle</div>
  </div>
  <div class="f"><span data-rect="10,470,70,482">DEV BUY</span>
    <input id="db" data-rect="10,486,200,518" value="5"></div>
  <button id="deploy" data-rect="240,540,520,572">Deploy (Enter)</button>
</div></body>`;

const dom = new JSDOM(html, { url: 'https://j7tracker.io/' });
const { window } = dom;
global.window = window; global.document = window.document;
global.Node = window.Node; global.Element = window.Element;
global.CSS = window.CSS || { escape: (s) => s };
global.getComputedStyle = window.getComputedStyle.bind(window);
global.MutationObserver = window.MutationObserver;
global.FileReader = window.FileReader;
global.setInterval = () => 0;

// jsdom gives every element a zero box; treat everything as visible for the test
Object.defineProperty(window.Element.prototype, 'getBoundingClientRect', {
  value() {
    if (this.id === 'j7fb-bar' && this.style && this.style.left) {
      const left = parseFloat(this.style.left), top = parseFloat(this.style.top);
      return { left, top, right: left + 300, bottom: top + 220, width: 300, height: 220 };
    }
    const r = this.getAttribute && this.getAttribute('data-rect');
    if (r) {
      const [left, top, right, bottom] = r.split(',').map(Number);
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }
    return { width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100 };
  },
});

let captured = null;
const savedStorage = {};
global.chrome = {
  runtime: {
    sendMessage: async (m) => {
      if (m.type === 'j7fb:getSettings') return { armed: true, takeoverDelayMs: 20000, defaultDevBuySol: 0 };
      if (m.type === 'j7fb:deploy') { captured = m.params; return { ok: true, result: { venue: 'Pump', mint: 'MockMint111' } }; }
      return {};
    },
    onMessage: { addListener: () => {} },
  },
  storage: { local: { get: async () => ({}), set: async (v) => { Object.assign(savedStorage, v); } } },
};

const code = fs.readFileSync(path.join(import.meta.dirname, '..', 'content.js'), 'utf8');
// expose the internals the harness needs to assert on
window.eval(code + '\n; window.__t = { readPanel, readVenue, readToggle, currentParams, fire, state, padCandidates, refresh, applyBarPos };');
await new Promise((r) => setTimeout(r, 400));

const read = await window.__t.readPanel();
console.log('--- what the scraper mirrored from the mock panel ---');
console.log('  name      ', JSON.stringify(read.name));
console.log('  symbol    ', JSON.stringify(read.symbol));
console.log('  website   ', JSON.stringify(read.website));
console.log('  twitter   ', JSON.stringify(read.twitter));
console.log('  venue     ', JSON.stringify(read.venue));
console.log('  devBuySol ', read.devBuySol);
console.log('  cashback  ', read.cashback);
console.log('  image     ', read.imageDataUrl ? 'captured' : 'MISSING');

const expect = { name: 'Not Safe For Work', symbol: 'NSFW', venue: 'pump', devBuySol: 5, cashback: true };
let bad = 0;
for (const [k, v] of Object.entries(expect)) {
  if (String(read[k]) !== String(v)) { console.log(`  MISMATCH ${k}: got ${JSON.stringify(read[k])} want ${JSON.stringify(v)}`); bad++; }
}
console.log(bad ? `\n${bad} field(s) wrong` : '\nall asserted fields correct');

// --- failure detection -----------------------------------------------------
console.log('\n--- j7 fails, does the fallback notice? ---');
Object.assign(window.__t.state.settings ??= {}, { armed: true, takeoverDelayMs: 250, autoFire: true, defaultDevBuySol: 0 });
const click = () => document.getElementById('deploy').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = () => { window.__t.state.failed = false; window.__t.state.busy = false; };

captured = null;
click();
const toast = document.createElement('div');
toast.textContent = 'Transaction timed out. Please try again.';
document.body.appendChild(toast);
await wait(500);
console.log('  error toast ->', captured ? 'fired for ' + captured.symbol + ' on ' + captured.venue : 'DID NOT FIRE');

captured = null; reset();
click();
await wait(700);
console.log('  silent j7   ->', captured ? 'fired for ' + captured.symbol + ' on ' + captured.venue : 'DID NOT FIRE');

captured = null; reset();
click();
const good = document.createElement('div');
good.textContent = 'Success! Token launched, signature 5xAb';
document.body.appendChild(good);
await wait(500);
console.log('  j7 succeeds ->', captured ? 'FIRED (WRONG)' : 'correctly stayed out of the way');

// --- the button injected into j7's toolbar ---------------------------------
console.log('\n--- inline FALLBACK button ---');
const wrap = document.getElementById('j7fb-inline-wrap');
const btn = document.getElementById('j7fb-inline');
const amt = document.getElementById('j7fb-inline-amt');
const unit = document.getElementById('j7fb-inline-unit');
console.log('  mounted     ->', wrap ? 'yes' : 'NO');
console.log('  sits next to->', wrap?.nextElementSibling?.textContent?.trim()
  || wrap?.previousElementSibling?.textContent?.trim() || '(nothing)');
console.log('  amount      ->', amt?.value, unit?.textContent);

// a stray click must not spend money; the second click is the one that fires
captured = null;
window.__t.state.failed = false; window.__t.state.busy = false; window.__t.state.armedToFire = false;
btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(50);
console.log('  1st click   ->', captured ? 'FIRED (WRONG)' : `safe, now reads "${btn.textContent}"`);
btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(300);
console.log('  2nd click   ->', captured ? `fired ${captured.symbol} for ${captured.devBuySol}` : 'DID NOT FIRE');

// the number typed inline is the amount that actually gets launched
captured = null; reset(); window.__t.state.armedToFire = false;
amt.value = '2.5';
amt.dispatchEvent(new window.Event('input', { bubbles: true })); // as typing would
btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(300);
console.log('  typed 2.5   ->', captured ? `launched with devBuySol=${captured.devBuySol}` : 'DID NOT FIRE');

// after j7 fails the button is pre-armed, so takeover is one click
captured = null; reset(); window.__t.state.armedToFire = false;
click();
const t2 = document.createElement('div');
t2.textContent = 'Error: blockhash expired';
document.body.appendChild(t2);
await wait(60);
window.__t.state.busy = false;
const armedAfterFail = btn.classList.contains('j7fb-i-arm') || btn.textContent === 'FIRE?';
console.log('  after fail  ->', armedAfterFail ? 'pre-armed, one click to take over' : 'not pre-armed');

// the unit follows the pad
document.querySelector('.pad.active').setAttribute('aria-pressed', 'false');
const ethPad = [...document.querySelectorAll('.pad')].find((b) => b.textContent === 'ETH');
ethPad.setAttribute('aria-pressed', 'true');
await window.__t.readPanel();
window.eval('paintInline()');
console.log('  ETH pad     ->', unit.textContent, '(expected ETH)');

// --- which pad is selected -------------------------------------------------
// The one that must never guess: a wrong answer launches on the wrong chain.
console.log('\n--- pad detection ---');
const pads = [...document.querySelectorAll('.pad')];
const clearFlags = () => pads.forEach((p) => {
  p.removeAttribute('aria-pressed'); p.className = 'pad'; p.setAttribute('style', '');
});

clearFlags();
pads.find((p) => p.textContent === 'Pump').setAttribute('aria-pressed', 'true');
console.log('  aria-pressed  ->', window.__t.readVenue(), '(expected pump)');

// style only: every chip grey except Pons, which is how a restyled j7 might do it
clearFlags();
pads.forEach((p) => p.setAttribute('style', 'background-color: rgb(26,30,36); border-top-color: rgb(38,43,51); color: rgb(138,147,161)'));
const pons = pads.find((p) => p.textContent === 'Pons');
pons.setAttribute('style', 'background-color: rgb(23,36,28); border-top-color: rgb(47,107,69); color: rgb(74,222,128)');
console.log('  style outlier ->', window.__t.readVenue(), '(expected pons)');

// a class name, no aria
clearFlags();
const stonk = pads.find((p) => p.textContent === 'Stonk');
stonk.className = 'pad selected';
console.log('  class name    ->', window.__t.readVenue(), '(expected stonk)');

// nothing distinguishes them: must refuse rather than default to Pump
clearFlags();
pads.forEach((p) => p.setAttribute('style', 'background-color: rgb(26,30,36)'));
const unclear = window.__t.readVenue();
console.log('  all identical ->', unclear === '' ? 'refuses (correct)' : `WRONG: guessed "${unclear}"`);

// and the refusal must stop a launch rather than silently pick pump
clearFlags();
pads.forEach((p) => p.setAttribute('style', 'background-color: rgb(26,30,36)'));
captured = null; reset(); window.__t.state.armedToFire = false;
window.__t.state.dirty = { name: false, symbol: false, venue: false };
await window.__t.refresh(false);
await window.__t.fire(true);
await wait(200);
console.log('  fire w/o pad  ->', captured ? `LAUNCHED ON "${captured.venue}" (WRONG)` : 'refused to launch (correct)');

// --- dragging the bar ------------------------------------------------------
console.log('\n--- drag the bar ---');
const barEl = document.getElementById('j7fb-bar');
const head = barEl.querySelector('.j7fb-head');
Object.defineProperty(barEl, 'offsetWidth', { value: 300, configurable: true });
Object.defineProperty(barEl, 'offsetHeight', { value: 220, configurable: true });
window.innerWidth = 1280; window.innerHeight = 900;
// jsdom has no layout, so stand in for where the bar currently sits
barEl.setAttribute('data-rect', '964,664,1264,884');

const down = (x, y) => head.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y }));
const move = (x, y) => document.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
const up = () => document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));

barEl.classList.remove('j7fb-min');
// a click that does not move must still toggle minimise, not count as a drag
down(1000, 670); move(1001, 670); up();
await wait(30);
console.log('  1px move    ->', window.__t.state.dragMoved ? 'treated as a drag (WRONG)' : 'still a click (correct)');

// drag to the bottom left
down(1000, 670); move(200, 700); up();
await wait(50);
console.log('  dragged     -> left', barEl.style.left, 'top', barEl.style.top, '| right', barEl.style.right || '(unset)');
console.log('  saved       ->', JSON.stringify(savedStorage.barPos));

// dragged past the left edge: must clamp on screen, not vanish
down(200, 700); move(-500, 700); up();
await wait(50);
console.log('  off-screen  -> left', barEl.style.left, '(clamped, must be >= 4px)');
