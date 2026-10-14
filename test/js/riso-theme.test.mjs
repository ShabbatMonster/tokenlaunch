// The Riso look, checked where it can be checked.
//
// Like classic-theme, this cannot judge whether the pages look good - that was
// done by eye, with headless-Chrome screenshots at 1280px and 390px in both
// colour schemes. What it does check is what breaks silently:
//
//   - wiring: every page loads the switchable skin after its own <style>, and
//     skin.js defaults to Riso and can switch to Classic
//   - legibility: the text/fill pairings the stylesheet claims, computed as
//     WCAG contrast ratios for light AND dark, since the dark scheme swaps the
//     inks and a pairing that reads on paper can vanish on black
//   - coverage: every two-class button variant any page defines is restyled,
//     or it keeps the old dark look next to riso stamps
//
// Run: node test/js/riso-theme.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const docs = path.join(import.meta.dirname, '..', '..', 'docs');
const PAGES = ['index.html', 'trade.html', 'swap.html', 'arc.html',
  'fees.html', 'force-migrate.html', 'pump-migrate.html', 'openfour.html'];
const css = fs.readFileSync(path.join(docs, 'riso.css'), 'utf8');
const skinJs = fs.readFileSync(path.join(docs, 'skin.js'), 'utf8');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the file itself -------------------------------------------------------------
check((css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length, 'riso.css has balanced braces');
check(css.trimStart().startsWith('@import'), 'the font @import is the first statement, or browsers drop it');
for (const v of ['--bg', '--panel', '--panel2', '--border', '--text', '--dim', '--accent', '--danger']) {
  check(new RegExp(`\\n\\s*${v}:`).test(css), `it remaps ${v}, which every page is built on`);
}
check(/@media \(prefers-color-scheme: dark\)/.test(css), 'it has a night printing for dark mode');
check(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'and turns the stamp and sticker motion off for reduced motion');
check(!/(^|[^-])width:\s*\d+px[^;]*;[^}]*\.app/.test(css) && !/\.app\s*\{/.test(css),
  'it never sizes the app column - the layout is the pages\', not the theme\'s');

// --- wiring ---------------------------------------------------------------------
// Riso is one of three looks now (Petunia is the default); every page carries
// the switchable <link id="skin"> after its own <style>, and skin.js can reach
// riso.css from it.
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(docs, page), 'utf8');
  const link = html.indexOf('<link id="skin" rel="stylesheet"');
  const styleEnd = html.indexOf('</style>');
  check(link > styleEnd && styleEnd > -1 && html.indexOf('<script src="skin.js"></script>') > link,
    `${page} loads the skin after its own <style>, then skin.js`);
}
check(/riso:\s*\{\s*href:\s*'riso\.css'/.test(skinJs) && /ORDER = \[[^\]]*'riso'/.test(skinJs),
  'skin.js lists Riso and cycles through it');
check((skinJs.match(/try {/g) || []).length >= 2, 'reading and saving the choice both survive blocked storage');
check(/\.menubar \.mb-skin\s*\{/.test(css), 'riso styles the switcher it adds to the masthead');

// the switcher really reaches Riso: run skin.js in a page and click through
{
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8').replace(/<script[^>]*src="(?!skin\.js)[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  dom.window.eval(skinJs);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  const btn = dom.window.document.querySelector('nav.menubar .mb-skin');
  const link = dom.window.document.getElementById('skin');
  // click until Riso comes up rather than counting - the cycle's length and
  // starting point belong to whichever look is the default
  const seen = [link.getAttribute('href')];
  for (let i = 0; i < 6 && btn && link.getAttribute('href') !== 'riso.css'; i++) { btn.click(); seen.push(link.getAttribute('href')); }
  check(!!btn && link.getAttribute('href') === 'riso.css', 'clicking the switcher reaches riso.css', seen.join(' -> '));
  check(dom.window.localStorage.getItem('tokenlaunch.skin') === 'riso',
    'and the choice is remembered');
}

// --- legibility ------------------------------------------------------------------
const hex = (h) => { const n = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const tokens = (block) => Object.fromEntries([...block.matchAll(/--(r-[a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const darkBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
const dark = { ...light, ...tokens(darkBlock.slice(0, darkBlock.indexOf('\n}\n'))) };

const pairs = [
  ['body text on card paper', 'r-ink', 'r-card', 7],
  ['dim text on card paper', 'r-ink-soft', 'r-card', 4.5],
  ['labels (blue) on card paper', 'r-blue-txt', 'r-card', 4.5],
  ['success text on card paper', 'r-green', 'r-card', 4.5],
  ['error text on card paper', 'r-red', 'r-card', 4.5],
  ['warning text on card paper', 'r-amber', 'r-card', 4.5],
  ['type on a blue fill (selected pad, VAMP)', 'r-on-blue', 'r-blue', 4.5],
  ['body text on the page paper', 'r-ink', 'r-paper', 7],
];
for (const [scheme, t] of [['light', light], ['dark', dark]]) {
  for (const [what, fg, bg, min] of pairs) {
    const r = ratio(t[fg], t[bg]);
    check(r >= min, `${scheme}: ${what} is at least ${min}:1`, `${r.toFixed(2)}:1 (${t[fg]} on ${t[bg]})`);
  }
}
// the fills that carry ink-black type in BOTH schemes - pink and yellow never
// carry light text
for (const [what, fill] of [['pink stamps', 'r-pink'], ['yellow stamps', 'r-yellow']]) {
  const r = ratio('#231f20', light[fill]);
  check(r >= 4.5, `ink-black type on ${what} is at least 4.5:1`, `${r.toFixed(2)}:1`);
}

// --- coverage ---------------------------------------------------------------------
const dom = new JSDOM(fs.readFileSync(path.join(docs, 'index.html'), 'utf8'));
const doc = dom.window.document;
const themed = ['.card', 'button', 'label', 'input[type=text]', 'select', '.pads', '.status', '.wallet-chip', 'header h1', '#vampBtn', 'nav.menubar'];
const unmatched = themed.filter((sel) => doc.querySelectorAll(sel).length === 0);
check(unmatched.length === 0, 'every element the theme styles exists on the launcher page',
  unmatched.length ? 'no match for ' + unmatched.join(', ') : `${themed.length} selectors`);
check(/\.menubar\s*\{[^}]*position:\s*fixed/.test(css) && /body\s*\{[^}]*padding-top:/.test(css),
  'the masthead is fixed and the body pads for it');
check(/#vampBtn\s*\{[^}]*!important/.test(css), 'VAMP\'s inline purple gradient is overridden, not left clashing');

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

// phones: the header row used to widen the page past 390px in both looks
check(/@media \(max-width: 560px\)\s*\{[^@]*header\s*\{\s*flex-wrap:\s*wrap/.test(css),
  'on a phone the header wraps instead of widening the page');

console.log('');
process.exit(fails.length ? 1 : 0);
