// The Petunia look, checked where it can be checked.
//
// Whether it is charmingly tacky or just tacky was judged by eye, from
// headless-Chrome screenshots at 1280px and 390px in both colour schemes.
// This checks what breaks silently:
//
//   - wiring: Petunia is the default, every page loads the switchable skin
//     after its own <style>, and the switcher cycles Petunia -> Riso -> Classic
//   - the artwork: the wallpaper and both blooms exist, are well-formed SVG,
//     and are what the stylesheet points at
//   - legibility: the busy wallpaper is never behind text (the app column is
//     hung on a cream panel), and every text/fill pairing is computed as a
//     WCAG ratio in light AND dark - dark mode swaps the deep text colours for
//     light ones, which is exactly how the masthead once ended up cream type
//     on light periwinkle
//   - coverage: every two-class button variant any page defines is restyled
//
// Run: node test/js/petunia-theme.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const docs = path.join(import.meta.dirname, '..', '..', 'docs');
const PAGES = ['index.html', 'trade.html', 'swap.html', 'arc.html',
  'fees.html', 'force-migrate.html', 'pump-migrate.html', 'openfour.html'];
const css = fs.readFileSync(path.join(docs, 'petunia.css'), 'utf8');
const skinJs = fs.readFileSync(path.join(docs, 'skin.js'), 'utf8');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the stylesheet ------------------------------------------------------------------
check((css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length, 'petunia.css has balanced braces');
check(css.trimStart().startsWith('@import'), 'the font @import is the first statement, or browsers drop it');
for (const v of ['--bg', '--panel', '--panel2', '--border', '--text', '--dim', '--accent', '--danger']) {
  check(new RegExp(`\\n\\s*${v}:`).test(css), `it remaps ${v}, which every page is built on`);
}
check(/@media \(prefers-color-scheme: dark\)/.test(css), 'it has a lights-down version for dark mode');
check(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'and drops the button motion for reduced motion');

// --- the artwork ---------------------------------------------------------------------
for (const f of ['petunia.svg', 'petunia-pink.svg', 'petunia-blue.svg']) {
  const p = path.join(docs, f);
  const ok = fs.existsSync(p);
  let parsed = false;
  if (ok) {
    const d = new JSDOM(fs.readFileSync(p, 'utf8'), { contentType: 'image/svg+xml' }).window.document;
    parsed = d.documentElement.nodeName === 'svg' && !d.querySelector('parsererror');
  }
  check(ok && parsed, `${f} exists and parses as SVG`);
  check(css.includes(`url("${f}")`), `and the stylesheet uses ${f}`);
}
const tile = fs.readFileSync(path.join(docs, 'petunia.svg'), 'utf8');
check(/width="240" height="240"/.test(tile) && /background-size:\s*auto,\s*240px 240px/.test(css),
  'the wallpaper repeats at the size its tile was drawn');
check((tile.match(/href="#bloom"/g) || []).length >= 4 && /#ec6fa0/.test(tile) && /#7f95e2/.test(tile),
  'with pink and periwinkle petunias, both');

// --- wiring ---------------------------------------------------------------------------
// Petunia is one of the looks the switcher cycles (Deco is the default since
// 2026-10-14; deco-theme.test.mjs owns the default and the full order).
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(docs, page), 'utf8');
  const link = html.indexOf('<link id="skin" rel="stylesheet"');
  const styleEnd = html.indexOf('</style>');
  check(link > styleEnd && styleEnd > -1 && html.indexOf('<script src="skin.js"></script>') > link,
    `${page} loads the skin after its own <style>, then skin.js`);
}
check(/petunia:\s*\{\s*href:\s*'petunia\.css'/.test(skinJs) && /ORDER = \[[^\]]*'petunia'/.test(skinJs),
  'skin.js lists Petunia and cycles through it');
check(/\.menubar \.mb-skin\s*\{/.test(css), 'petunia styles the switcher it adds to the masthead');

{
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8').replace(/<script[^>]*src="(?!skin\.js)[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  dom.window.eval(skinJs);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  const sel = dom.window.document.querySelector('nav.menubar select.mb-skin');
  const link = dom.window.document.getElementById('skin');
  check(!!sel && [...sel.options].some((o) => o.value === 'petunia' && o.textContent === 'Petunia'), 'the dropdown offers Petunia');
  sel.value = 'petunia';
  sel.dispatchEvent(new dom.window.Event('change'));
  check(link.getAttribute('href') === 'petunia.css', 'choosing it loads petunia.css');
  check(dom.window.document.documentElement.dataset.skin === 'petunia', 'with the page tagged as Petunia');
}
// a saved choice beats the default
{
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8').replace(/<script[^>]*src="(?!skin\.js)[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  dom.window.localStorage.setItem('tokenlaunch.skin', 'riso');
  dom.window.eval(skinJs);
  check(dom.window.document.getElementById('skin').getAttribute('href') === 'riso.css',
    'someone who picked Riso before stays on Riso');
}

// --- legibility --------------------------------------------------------------------------
check(/\.app\s*\{[^}]*background:\s*var\(--p-cream\)/.test(css) && /\.app\s*\{[^}]*box-shadow:/.test(css),
  'the app column is hung on a cream panel, so no text sits on the wallpaper');
check(!/\.app\s*\{[^}]*(padding|margin|width)/.test(css), 'and the panel is drawn with box-shadow, taking no layout space');

const hex = (h) => { const n = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const tokens = (block) => Object.fromEntries([...block.matchAll(/--(p-[a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const darkBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
const dark = { ...light, ...tokens(darkBlock.slice(0, darkBlock.indexOf('\n}\n'))) };

const pairs = [
  ['body text on a card', 'p-ink', 'p-card', 7],
  ['body text on the cream panel', 'p-ink', 'p-cream', 7],
  ['hints on a card', 'p-ink-soft', 'p-card', 4.5],
  ['labels (deep pink) on a card', 'p-pink-deep', 'p-card', 4.5],
  ['links (deep blue) on a card', 'p-blue-deep', 'p-card', 4.5],
  ['success text on a card', 'p-green', 'p-card', 4.5],
  ['error text on a card', 'p-red', 'p-card', 4.5],
  ['warning text on a card', 'p-amber', 'p-card', 4.5],
  ['typing in a field', 'p-ink', 'p-field', 7],
];
for (const [scheme, t] of [['light', light], ['dark', dark]]) {
  for (const [what, fg, bg, min] of pairs) {
    const r = ratio(t[fg], t[bg]);
    check(r >= min, `${scheme}: ${what} is at least ${min}:1`, `${r.toFixed(2)}:1 (${t[fg]} on ${t[bg]})`);
  }
}
// fills that do not change between schemes, with the type printed on them
const fixed = [
  ['plum type on pink candy (selected pad, LAUNCH, VAMP)', light['p-on-fill'], light['p-pink']],
  ['plum type on periwinkle candy (buttons)', light['p-on-fill'], light['p-blue']],
  ['cream type on the navy masthead', '#fff8ef', light['p-navy']],
];
for (const [what, fg, bg] of fixed) {
  const r = ratio(fg, bg);
  check(r >= 4.5, `${what} is at least 4.5:1, in both schemes`, `${r.toFixed(2)}:1`);
}
check(!('p-navy' in tokens(darkBlock.slice(0, darkBlock.indexOf('\n}\n')))) && /\.menubar\s*\{[^}]*background-color:\s*var\(--p-navy\)/.test(css),
  'the masthead fill is the fixed navy, not the blue that dark mode lightens for text');
check(!/background[^;]*var\(--p-blue-deep\)/.test(css), 'and nothing else uses that text blue as a fill');

// --- coverage ---------------------------------------------------------------------------
const doc = new JSDOM(fs.readFileSync(path.join(docs, 'index.html'), 'utf8')).window.document;
const themed = ['.card', '.app', 'button', 'label', 'input[type=text]', 'select', '.pads', '.status', '.wallet-chip', 'header h1', '#vampBtn', '#launchBtn', '.drop', 'nav.menubar'];
const unmatched = themed.filter((sel) => doc.querySelectorAll(sel).length === 0);
check(unmatched.length === 0, 'every element the theme styles exists on the launcher page',
  unmatched.length ? 'no match for ' + unmatched.join(', ') : `${themed.length} selectors`);
check(/\.menubar\s*\{[^}]*position:\s*fixed/.test(css) && /body\s*\{[^}]*padding-top:/.test(css),
  'the masthead is fixed and the body pads for it and its scallops');
check(/#vampBtn\s*\{[^}]*!important/.test(css), "VAMP's inline purple gradient is reupholstered");
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
