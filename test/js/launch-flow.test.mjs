// The deploy panel: one look, every launch option open, pages in a sidebar.
//
// Modelled on a reference "Token Deploy" panel: a dense dark form in the
// order Name, Symbol, Website | Twitter, Select Image, a tool row, the
// launchpad tabs as a grid, the settings, the dev-buy chips and a full-width
// Deploy bar. Nothing is folded away, and the pages are buttons down the left
// edge instead of a bar along the top. The caterpillar-cat photo stays behind
// it. Judged by eye from headless-Chrome screenshots at 1400px and 390px; this
// checks what breaks silently.
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

// --- one look, everywhere -------------------------------------------------------------
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(docs, page), 'utf8');
  const link = html.indexOf('<link rel="stylesheet" href="theme.css">');
  const styleEnd = html.indexOf('</style>');
  check(link > styleEnd && styleEnd > -1, `${page} loads theme.css after its own <style>`);
  check(!/skin\.js|id="skin"|(classic|riso|petunia|deco|crescent|byakko|babel)\.css/.test(html), `${page} has no trace of the old looks`);
}
check(['skin.js', 'classic.css', 'riso.css', 'petunia.css', 'deco.css', 'crescent.css', 'byakko.css', 'babel.css']
  .every((f) => !fs.existsSync(path.join(docs, f))) && !fs.existsSync(path.join(root, 'tools', 'skin-art.mjs')),
  'the old looks, their art, the switcher and the generator are gone');

// --- the sidebar replaces the top bar ----------------------------------------------------
check(/\.menubar\s*\{[^}]*position:\s*fixed;[^}]*left:\s*0;[^}]*bottom:\s*0;[^}]*width:\s*var\(--t-side\);[^}]*flex-direction:\s*column/.test(css),
  'the page buttons run down the left edge, full height');
check(/body\s*\{[^}]*padding:[^;]*calc\(var\(--t-side\) \+ 16px\)/.test(css) && !/body\s*\{[^}]*padding-top:\s*\d{2}px/.test(css),
  'the body makes room on the left, and no longer pads for a bar on top');
check(/\.menubar a\[aria-current="page"\]\s*\{[^}]*--t-green/.test(css), 'the current page is marked in the sidebar');
check(/@media \(max-width: 700px\)\s*\{\s*:root\s*\{\s*--t-side:\s*\d+px/.test(css), 'on a phone the sidebar narrows instead of disappearing');

// --- the deploy panel ----------------------------------------------------------------------
const doc = new JSDOM(fs.readFileSync(path.join(docs, 'index.html'), 'utf8')).window.document;
check(doc.querySelector('header h1')?.textContent === 'Token Deploy', 'the panel is titled Token Deploy');
check([...doc.querySelectorAll('header a')].map((a) => a.id).join() === 'keysLink' && !!doc.querySelector('header #walletChip'),
  'its header carries keys and the wallet, as the reference carries its wallet');
const card = doc.querySelector('.card.deploy');
const order = ['name', 'symbol', 'website', 'twitter', 'drop', 'vampBtn', 'pads', 'supplyRow', 'pumpRow', 'hookeRow',
  'distroBlock', 'descBlock', 'devBuyBlock', 'launchBtn', 'feeNote', 'status', 'abyssLine', 'rpcLine'];
const all = card ? [...card.querySelectorAll('*')] : [];
const pos = order.map((id) => all.indexOf(doc.getElementById(id)));
check(pos.every((x) => x >= 0) && pos.every((x, i) => i === 0 || x > pos[i - 1]),
  'the form runs Name, Symbol, Website | Twitter, image, tools, launchpads, settings, dev buy, Deploy', pos.join(','));
check(!doc.getElementById('moreOptions') && [...card.querySelectorAll('details')].every((d) => d.open),
  'every launch option is open: no drawer, and every remaining section starts expanded',
  [...card.querySelectorAll('details')].map((d) => (d.id || d.className) + (d.open ? ':open' : ':closed')).join(' '));
check(doc.getElementById('launchBtn').textContent.trim() === 'Deploy', 'the launch button reads Deploy');
check(doc.querySelector('.select-image')?.textContent.trim() === 'Select Image', 'the image box is captioned Select Image');
check(doc.getElementById('vampBtn').closest('.toolbar') !== null, 'VAMP sits in the tool row under the image');
const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id);
check(ids.length === new Set(ids).size, 'no element id was duplicated in the move');

// launchpads: every live one, as a grid of tabs, each wearing its chain
check(/<div class="pads pad-grid" id="pads">/.test(fs.readFileSync(path.join(docs, 'index.html'), 'utf8')) && /\.pad-grid\s*\{[^}]*display:\s*grid/.test(css),
  'launchpads are a grid of tabs');
check(!/padsOpen/.test(MAIN) && /if \(!pad\.enabled\) continue;/.test(MAIN), 'all live launchpads are shown at once, with no collapsing');
check(/b\.dataset\.chain = padChain\(pad\)/.test(MAIN) && /b\.title = pad\.label/.test(MAIN), 'each tab carries its chain, and its full name as a tooltip');
for (const chain of ['sol', '4663', '56', '8453', '1', '5042']) {
  check(new RegExp(`\\.pad\\[data-chain="${chain}"\\]::before`).test(css), `chain ${chain} has its own colour dot`);
}
check(/#buyChips\s*\{[^}]*display:\s*grid/.test(css), 'the dev-buy amounts are a row of equal chips');

// the photo stays behind it
check(/body\s*\{[^}]*url\("caterpillar-cat\.webp"\)/.test(css) && fs.existsSync(path.join(docs, 'caterpillar-cat.webp')),
  'the caterpillar-cat photo is still the background');

// --- legibility --------------------------------------------------------------------------------
const hex = (h) => { const n = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const t = Object.fromEntries([...css.matchAll(/--(t-[a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
for (const [what, fg, bg, min] of [
  ['text in a field', t['t-text'], t['t-shell'], 7],
  ['text on the panel', t['t-text'], t['t-panel'], 7],
  ['labels on the panel', t['t-soft'], t['t-panel'], 4.5],
  ['hints on the panel', t['t-faint'], t['t-panel'], 4.5],
  ['the active launchpad tab', t['t-green-hi'], t['t-green-bg'], 4.5],
  ['white on the Deploy bar', '#ffffff', t['t-green'], 4.5],
  ['errors on the panel', t['t-red'], t['t-panel'], 4.5],
  ['warnings on the panel', t['t-amber'], t['t-panel'], 4.5],
  ['sidebar links', t['t-soft'], t['t-shell'], 4.5],
]) {
  const r = ratio(fg, bg);
  check(r >= min, `${what} is at least ${min}:1`, `${r.toFixed(2)}:1 (${fg} on ${bg})`);
}

// --- coverage ------------------------------------------------------------------------------------
check(/#vampBtn\s*\{[^}]*!important/.test(css), "VAMP's inline purple gradient is replaced");
check(/\.app > \.note\s*\{[^}]*background:\s*var\(--t-panel\)/.test(css), 'notes sitting directly in the column get a panel, not the photo');
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

console.log('');
process.exit(fails.length ? 1 : 0);
