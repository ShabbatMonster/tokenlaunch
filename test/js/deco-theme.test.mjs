// The Deco look, checked where it can be checked.
//
// Judged by eye from headless-Chrome screenshots (launcher, swap, the key
// dialog; 1280px and 390px). This checks what breaks silently:
//
//   - wiring: Deco is the default, and the switcher cycles all four looks in
//     order - this suite owns that, since the default lives here
//   - the ornaments: frame, fan tile and crest exist, parse, and are what the
//     stylesheet points at; the frame is nine-sliced at the size it was drawn
//   - nothing moves: frame, crest and pinstripe sit outside the box model
//   - legibility: computed WCAG ratios for every text/fill pairing. Deco is
//     black and gold in both colour schemes on purpose, so there is one
//     palette to check rather than two
//   - coverage: every two-class button variant any page defines is restyled
//
// Run: node test/js/deco-theme.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const docs = path.join(import.meta.dirname, '..', '..', 'docs');
const PAGES = ['index.html', 'trade.html', 'swap.html', 'arc.html',
  'fees.html', 'force-migrate.html', 'pump-migrate.html', 'openfour.html'];
const css = fs.readFileSync(path.join(docs, 'deco.css'), 'utf8');
const skinJs = fs.readFileSync(path.join(docs, 'skin.js'), 'utf8');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the stylesheet ---------------------------------------------------------------
check((css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length, 'deco.css has balanced braces');
check(css.trimStart().startsWith('@import') && /Limelight/.test(css) && /Josefin\+Sans/.test(css) && /DM\+Mono/.test(css),
  'it imports Limelight, Josefin Sans and DM Mono first, before any rule');
for (const v of ['--bg', '--panel', '--panel2', '--border', '--text', '--dim', '--accent', '--danger']) {
  check(new RegExp(`\\n\\s*${v}:`).test(css), `it remaps ${v}, which every page is built on`);
}
check(/color-scheme:\s*dark/.test(css) && !/prefers-color-scheme/.test(css),
  'it is a night look in both colour schemes, by design');
check(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'and drops the button motion for reduced motion');

// --- the ornaments --------------------------------------------------------------------
const svg = (f) => {
  const p = path.join(docs, f);
  if (!fs.existsSync(p)) return null;
  const d = new JSDOM(fs.readFileSync(p, 'utf8'), { contentType: 'image/svg+xml' }).window.document;
  return d.documentElement.nodeName === 'svg' && !d.querySelector('parsererror') ? d : null;
};
for (const f of ['deco-frame.svg', 'deco-fan.svg', 'deco-crest.svg']) {
  check(!!svg(f), `${f} exists and parses as SVG`);
  check(css.includes(`url("${f}")`), `and the stylesheet uses ${f}`);
}
const frame = svg('deco-frame.svg');
check(frame.documentElement.getAttribute('viewBox') === '0 0 96 96'
  && /border-image:\s*url\("deco-frame\.svg"\)\s*32\s*\//.test(css),
  'the frame is a 96px drawing sliced 32px from each edge, as its corners were drawn');
check(frame.querySelectorAll('use[href="#corner"]').length === 4, 'with one corner drawn and mirrored into all four');
const fan = svg('deco-fan.svg');
check(fan.documentElement.getAttribute('width') === '60' && /60px 60px/.test(css), 'the fan tile repeats at the size it was drawn');
// the fans must be drawn top row first, so each row overlaps the one above
const ys = [...fan.querySelectorAll('use[href="#fan"]')].map((u) => +u.getAttribute('y'));
check(ys.every((y, i) => i === 0 || y >= ys[i - 1]), 'and its fans are layered top to bottom, so the scales overlap correctly', ys.join(','));

// --- nothing moves -----------------------------------------------------------------------
check(/border-image:[^;]*\/\s*26px\s*\/\s*9px/.test(css), 'the card frame is pushed outward with border-image-outset');
check(/\.card::after[^{]*\{[^}]*position:\s*absolute/.test(css), 'the crest is an absolutely placed pseudo-element');
check(/\.app\s*\{[^}]*box-shadow:/.test(css) && !/\.app\s*\{[^}]*(padding|margin|width)/.test(css),
  'the pinstripe around the column is box-shadow, taking no layout space');

// --- wiring ------------------------------------------------------------------------------
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(docs, page), 'utf8');
  const link = html.indexOf('<link id="skin" rel="stylesheet" href="deco.css">');
  const styleEnd = html.indexOf('</style>');
  check(link > styleEnd && styleEnd > -1 && html.indexOf('<script src="skin.js"></script>') > link,
    `${page} loads deco.css after its own <style>, then skin.js`);
}
check(/var current = 'deco'/.test(skinJs), 'Deco is the default look');
check(/ORDER = \['deco', 'petunia', 'riso', 'classic'\]/.test(skinJs), 'and the switcher cycles Deco, Petunia, Riso, Classic');
check(/\.menubar \.mb-skin\s*\{/.test(css), 'deco styles the switcher it adds to the masthead');
{
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8').replace(/<script[^>]*src="(?!skin\.js)[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  dom.window.eval(skinJs);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  const btn = dom.window.document.querySelector('nav.menubar .mb-skin');
  const link = dom.window.document.getElementById('skin');
  check(!!btn && /Look: Deco/.test(btn.textContent), 'a first visit opens on Deco, and the switcher says so', btn?.textContent);
  const seen = [link.getAttribute('href')];
  for (let i = 0; i < 4 && btn; i++) { btn.click(); seen.push(link.getAttribute('href')); }
  check(seen.join(' ') === 'deco.css petunia.css riso.css classic.css deco.css',
    'clicking goes Deco -> Petunia -> Riso -> Classic -> Deco', seen.join(' -> '));
  check(dom.window.localStorage.getItem('tokenlaunch.skin') === 'deco', 'and remembers where it stopped');
}
{
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8').replace(/<script[^>]*src="(?!skin\.js)[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  dom.window.localStorage.setItem('tokenlaunch.skin', 'petunia');
  dom.window.eval(skinJs);
  check(dom.window.document.getElementById('skin').getAttribute('href') === 'petunia.css',
    'someone who picked Petunia before stays on Petunia');
}

// --- legibility --------------------------------------------------------------------------
const hex = (h) => { const n = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const t = Object.fromEntries([...css.matchAll(/--(d-[a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const pairs = [
  ['body text on a card', t['d-cream'], t['d-card'], 7],
  ['body text on the panel', t['d-cream'], t['d-panel'], 7],
  ['hints on a card', t['d-cream-dim'], t['d-card'], 4.5],
  ['gold labels and buttons on a card', t['d-gold'], t['d-card'], 4.5],
  ['gold on the black button face', t['d-gold'], t['d-onyx'], 4.5],
  ['links on a card', t['d-gold-hi'], t['d-card'], 4.5],
  ['success text on a card', t['d-jade'], t['d-card'], 4.5],
  ['error text on a card', t['d-coral'], t['d-card'], 4.5],
  ['warning text on a card', t['d-amber'], t['d-card'], 4.5],
  ['typing in a field', t['d-cream'], t['d-field'], 7],
  ['gold type on the emerald plaque (selected pad, VAMP)', t['d-gold-hi'], t['d-emerald'], 4.5],
  ['cream type on ruby (sell)', t['d-cream'], t['d-ruby'], 4.5],
  // the brass plates take black type: check it at the plate's darkest band
  ['black type on the darkest band of a brass plate', '#0e0d0b', '#b8902e', 4.5],
];
for (const [what, fg, bg, min] of pairs) {
  const r = ratio(fg, bg);
  check(r >= min, `${what} is at least ${min}:1`, `${r.toFixed(2)}:1 (${fg} on ${bg})`);
}
check(!/color:\s*var\(--d-gold[^)]*\)[^}]*background:\s*var\(--d-brass\)/.test(css),
  'gold type is never set on a brass plate');

// --- coverage ------------------------------------------------------------------------------
const doc = new JSDOM(fs.readFileSync(path.join(docs, 'index.html'), 'utf8')).window.document;
const themed = ['.card', '.app', 'button', 'label', 'input[type=text]', 'select', '.pads', '.status', '.wallet-chip', 'header h1', '#vampBtn', '#launchBtn', '.drop', 'nav.menubar', '.modal'];
const unmatched = themed.filter((sel) => doc.querySelectorAll(sel).length === 0);
check(unmatched.length === 0, 'every element the theme styles exists on the launcher page',
  unmatched.length ? 'no match for ' + unmatched.join(', ') : `${themed.length} selectors`);
check(/\.menubar\s*\{[^}]*position:\s*fixed/.test(css) && /body\s*\{[^}]*padding-top:/.test(css),
  'the masthead is fixed and the body pads for it and its frieze');
check(/#vampBtn\s*\{[^}]*!important/.test(css), "VAMP's inline purple gradient is replaced");
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
check(/@media \(max-width: 560px\)\s*\{[^@]*header\s*\{\s*flex-wrap:\s*wrap/.test(css),
  'on a phone the header wraps instead of widening the page');

console.log('');
process.exit(fails.length ? 1 : 0);
