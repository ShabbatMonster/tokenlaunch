// One look, one short launch flow.
//
// The site used to carry seven switchable looks; it now has a single one
// (docs/theme.css) over a photo background, and the launcher's form is three
// steps - pick a launchpad, give the coin an image, a name and a ticker,
// LAUNCH - with everything optional folded into one "More options" drawer.
// Judged by eye from headless-Chrome screenshots at 1280px and 390px, closed
// and opened. This checks what breaks silently.
//
// Run: node test/js/launch-flow.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.join(import.meta.dirname, '..', '..');
const docs = path.join(root, 'docs');
const PAGES = ['index.html', 'trade.html', 'swap.html', 'arc.html',
  'fees.html', 'force-migrate.html', 'pump-migrate.html', 'openfour.html'];
const css = fs.readFileSync(path.join(docs, 'theme.css'), 'utf8');
const MAIN = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- one look, everywhere ----------------------------------------------------------
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(docs, page), 'utf8');
  const link = html.indexOf('<link rel="stylesheet" href="theme.css">');
  const styleEnd = html.indexOf('</style>');
  check(link > styleEnd && styleEnd > -1, `${page} loads theme.css after its own <style>`);
  check(!/skin\.js|id="skin"|(classic|riso|petunia|deco|crescent|byakko|babel)\.css/.test(html), `${page} has no trace of the old looks`);
}
const gone = ['skin.js', 'classic.css', 'riso.css', 'petunia.css', 'deco.css', 'crescent.css', 'byakko.css', 'babel.css', 'petunia.svg', 'deco-frame.svg', 'crescent-scene.svg', 'byakko-ribbons.svg', 'babel-scene.svg'];
check(gone.every((f) => !fs.existsSync(path.join(docs, f))), 'the old looks, their art and the switcher are removed');
check(!fs.existsSync(path.join(root, 'tools', 'skin-art.mjs')), 'and so is their art generator');

// --- the photo ------------------------------------------------------------------------
const photo = path.join(docs, 'caterpillar-cat.webp');
const head = fs.existsSync(photo) ? fs.readFileSync(photo).subarray(0, 12) : Buffer.alloc(0);
check(head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP', 'the background photo is a real WebP');
check(fs.statSync(photo).size < 200 * 1024, 'and small enough to load fast', `${(fs.statSync(photo).size / 1024).toFixed(0)}KB`);
check(/body\s*\{[^}]*url\("caterpillar-cat\.webp"\)[^}]*cover[^}]*fixed/.test(css), 'it fills the window behind everything');
check(/@media \(min-width: 1000px\)\s*\{\s*body\s*\{\s*justify-content:\s*flex-end/.test(css),
  'and on a wide screen the column moves right so the cat stays in view');
check(/backdrop-filter:\s*blur/.test(css) && /\.card, \.modal \{[^}]*background:\s*var\(--k-glass\)/.test(css),
  'cards are frosted glass over the photo');

// --- the launch flow ---------------------------------------------------------------------
const doc = new JSDOM(fs.readFileSync(path.join(docs, 'index.html'), 'utf8')).window.document;
const card = doc.getElementById('launchBtn').closest('.card');
const labels = [...card.querySelectorAll(':scope > label')].map((l) => l.textContent.trim());
check(labels[0] === '1 · LAUNCHPAD' && labels[1] === '2 · YOUR COIN', 'the form opens with two numbered steps', labels.join(' | '));
const more = doc.getElementById('moreOptions');
check(!!more && more.tagName === 'DETAILS' && !more.hasAttribute('open'), 'everything optional is in one drawer, closed by default');
const optional = ['vampBtn', 'supplyRow', 'quoteRow', 'solRow', 'agencyRow', 'pumpRow', 'raydiumRow', 'clmmRow', 'uniRow', 'flapRow',
  'lunchRow', 'hookeRow', 'longRow', 'v4curveRow', 'ponsRow', 'twitter', 'website', 'devBuyBlock', 'distroBlock', 'descBlock', 'abyssLine', 'rpcLine'];
const strayed = optional.filter((id) => !doc.getElementById(id) || !more.contains(doc.getElementById(id)));
check(strayed.length === 0, 'the drawer holds vamp, socials, dev buy, distro, description, every launchpad\'s settings and the diagnostics',
  strayed.length ? 'outside: ' + strayed.join(', ') : `${optional.length} pieces`);
const essential = ['pads', 'drop', 'name', 'symbol', 'launchBtn', 'feeNote', 'status'];
const hidden = essential.filter((id) => !doc.getElementById(id) || more.contains(doc.getElementById(id)));
check(hidden.length === 0, 'and the essentials stay in view', hidden.join(', ') || essential.join(', '));
check(more.compareDocumentPosition(doc.getElementById('launchBtn')) & 4, 'LAUNCH comes after the drawer, so options are set before it');
const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id);
check(ids.length === new Set(ids).size, 'no element id was duplicated in the move');
const headerLinks = [...doc.querySelectorAll('header a')].map((a) => a.id || a.getAttribute('href'));
check(headerLinks.join(',') === 'keysLink' && !!doc.querySelector('header #walletChip'), 'the header keeps only keys and the wallet; the menu bar links the pages');

// the launchpad picker: only the one in use until you ask to change it
check(/if \(!pad\.enabled\) continue;/.test(MAIN), 'launchpads that are not live are not offered at all');
check(/if \(!padsOpen && pad !== activePad\) continue;/.test(MAIN), 'the picker shows only the launchpad in use until opened');
check(/padsOpen = false;\s*\n\s*applyPadUI\(pad\)/.test(MAIN), 'and closes again once one is chosen');
check(/toggle\.textContent = padsOpen \? 'close' : 'change'/.test(MAIN) && /aria-expanded/.test(MAIN), 'with a change/close control that reports its state');

// --- legibility ------------------------------------------------------------------------------
const hex = (h) => { const n = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const t = Object.fromEntries([...css.matchAll(/--(k-[a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
// the glass is 80% near-white over a photo; check against a conservative
// worst case - the glass composited over the darkest leaf green
const glass = '#d2d6cd';
for (const [what, fg, bg, min] of [
  ['body text on the glass', t['k-ink'], glass, 7],
  ['hints on the glass', t['k-ink-soft'], glass, 4.5],
  ['green labels on the glass', t['k-leaf'], glass, 4.5],
  ['success text on white', t['k-green'], '#ffffff', 4.5],
  ['error text on white', t['k-red'], '#ffffff', 4.5],
  ['warning text on white', t['k-amber-txt'], '#ffffff', 4.5],
  ['white type on green buttons and the selected launchpad', '#ffffff', t['k-leaf'], 4.5],
  ['dark type on the amber LAUNCH at its darkest', '#241a08', t['k-amber-lo'], 4.5],
  ['white menu links on the dark leaf glass', '#f2f6ee', '#24341f', 7],
]) {
  const r = ratio(fg, bg);
  check(r >= min, `${what} is at least ${min}:1`, `${r.toFixed(2)}:1 (${fg} on ${bg})`);
}
check(/header h1[^{]*\{[^}]*text-shadow/.test(css), 'the title over the photo carries a shadow so it reads on any part of it');
// swap, arc and the migrate pages put explanatory notes straight in the column;
// on the photo those were unreadable until they got glass of their own
const notePages = PAGES.filter((p) => {
  const d = new JSDOM(fs.readFileSync(path.join(docs, p), 'utf8')).window.document;
  return d.querySelector('.app > .note');
});
check(notePages.length > 0 && /\.app > \.note\s*\{[^}]*background:\s*var\(--k-glass\)[^}]*backdrop-filter/.test(css),
  'notes sitting directly in the column get their own glass', notePages.join(', '));

// --- coverage ---------------------------------------------------------------------------------
check(/#vampBtn\s*\{[^}]*!important/.test(css), "VAMP's inline purple gradient is brought into the palette");
let stranded = [];
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(docs, page), 'utf8');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const twoClass = [...style.matchAll(/^\s*(\.[a-z-]+\.[a-z-]+)\s*[,{]/gm)].map((m) => m[1]);
  const missed = [...new Set(twoClass)].filter((sel) => !css.includes(sel) && /btn|tab|pad|mini|primary|secondary|badge/.test(sel));
  if (missed.length) stranded.push(`${page}: ${missed.join(' ')}`);
}
check(stranded.length === 0, 'no page defines a button-ish two-class rule the theme leaves unstyled',
  stranded.length ? stranded.join(' | ') : `${PAGES.length} pages scanned`);
check(/\.menubar\s*\{[^}]*position:\s*fixed/.test(css) && /body\s*\{[^}]*padding-top:/.test(css), 'the menu bar is fixed and the body pads for it');
check(/@media \(max-width: 560px\)\s*\{[^@]*header\s*\{\s*flex-wrap:\s*wrap/.test(css), 'on a phone the header wraps instead of widening the page');

console.log('');
process.exit(fails.length ? 1 : 0);
