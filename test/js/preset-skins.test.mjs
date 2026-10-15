// The three preset looks - Crescent, Byakko, Babel - and the dropdown that
// switches between every look.
//
// Each was judged by eye from headless-Chrome screenshots at 1280px and 390px
// against the painting it is after. This checks what breaks silently:
//
//   - the switcher: Crescent is the default, the dropdown lists the presets
//     first then the earlier looks, choosing one swaps the stylesheet and is
//     remembered, a saved choice survives, and it does not stretch across the
//     masthead (every page makes <select> full width)
//   - the artwork is reproducible: tools/skin-art.mjs is seeded, so a rerun
//     must give back the committed files byte for byte - otherwise the art in
//     the repo is not the art the generator describes
//   - each look's assets exist, parse, and are what its stylesheet uses
//   - legibility: WCAG ratios for every text/fill pairing each look claims
//   - coverage: every two-class button variant any page defines is restyled,
//     and the header wraps on a phone
//
// Run: node test/js/preset-skins.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';

const root = path.join(import.meta.dirname, '..', '..');
const docs = path.join(root, 'docs');
const PAGES = ['index.html', 'trade.html', 'swap.html', 'arc.html',
  'fees.html', 'force-migrate.html', 'pump-migrate.html', 'openfour.html'];
const skinJs = fs.readFileSync(path.join(docs, 'skin.js'), 'utf8');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the switcher ---------------------------------------------------------------------
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(docs, page), 'utf8');
  const link = html.indexOf('<link id="skin" rel="stylesheet" href="crescent.css">');
  const styleEnd = html.indexOf('</style>');
  check(link > styleEnd && styleEnd > -1 && html.indexOf('<script src="skin.js"></script>') > link,
    `${page} loads crescent.css after its own <style>, then skin.js`);
}
const fresh = (saved) => {
  const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8').replace(/<script[^>]*src="(?!skin\.js)[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  if (saved) dom.window.localStorage.setItem('tokenlaunch.skin', saved);
  dom.window.eval(skinJs);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return dom;
};
{
  const dom = fresh();
  const doc = dom.window.document;
  const sel = doc.querySelector('nav.menubar select.mb-skin');
  const link = doc.getElementById('skin');
  check(!!sel && link.getAttribute('href') === 'crescent.css' && sel.value === 'crescent', 'a first visit opens on Crescent, and the dropdown says so');
  const groups = [...sel.querySelectorAll('optgroup')].map((g) => g.label + ': ' + [...g.querySelectorAll('option')].map((o) => o.textContent).join(', '));
  check(groups.join(' | ') === 'Presets: Crescent, Byakko, Babel | More looks: Deco, Petunia, Riso, Classic',
    'the dropdown lists the three presets first, then the earlier looks', groups.join(' | '));
  check(sel.getAttribute('aria-label') === 'Look', 'and it is labelled for screen readers');
  // jsdom reports `flex: none` in its expanded form
  check(sel.style.width === 'auto' && ['none', '0 0 auto'].includes(sel.style.flex), 'it stays compact in the masthead instead of filling it',
    `width ${sel.style.width}, flex ${sel.style.flex}`);
  for (const [name, href] of [['byakko', 'byakko.css'], ['babel', 'babel.css'], ['classic', 'classic.css'], ['crescent', 'crescent.css']]) {
    sel.value = name;
    sel.dispatchEvent(new dom.window.Event('change'));
    check(link.getAttribute('href') === href && doc.documentElement.dataset.skin === name, `choosing ${name} loads ${href}`);
  }
  check(dom.window.localStorage.getItem('tokenlaunch.skin') === 'crescent', 'and the last choice is remembered');
  check(doc.querySelectorAll('.mb-skin').length === 1, 'the dropdown is mounted once');
}
for (const saved of ['byakko', 'babel', 'deco', 'petunia']) {
  check(fresh(saved).window.document.getElementById('skin').getAttribute('href') === `${saved}.css`, `someone who picked ${saved} stays on it`);
}
check(fresh('nonsense').window.document.getElementById('skin').getAttribute('href') === 'crescent.css', 'a stale or unknown saved value falls back to the default');

// --- the artwork is reproducible -----------------------------------------------------------
const ART = ['crescent-scene.svg', 'crescent-frame.svg', 'crescent-moon.svg',
  'byakko-stars.svg', 'byakko-ribbons.svg', 'byakko-fur.svg', 'byakko-spots.svg', 'byakko-flame.svg', 'byakko-sparkle.svg',
  'babel-scene.svg', 'babel-frame.svg'];
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(docs, f))).digest('hex');
const before = Object.fromEntries(ART.map((f) => [f, hash(f)]));
execFileSync(process.execPath, [path.join(root, 'tools', 'skin-art.mjs')], { stdio: 'ignore' });
const drift = ART.filter((f) => hash(f) !== before[f]);
check(drift.length === 0, 'rerunning tools/skin-art.mjs reproduces every committed SVG byte for byte',
  drift.length ? 'changed: ' + drift.join(', ') : `${ART.length} files`);
for (const f of ART) {
  const text = fs.readFileSync(path.join(docs, f), 'utf8');
  const d = new JSDOM(text, { contentType: 'image/svg+xml' }).window.document;
  check(d.documentElement.nodeName === 'svg' && !d.querySelector('parsererror') && /Generated by tools\/skin-art\.mjs/.test(text),
    `${f} parses, and says where it came from`);
}
const kb = (f) => fs.statSync(path.join(docs, f)).size / 1024;
check(ART.every((f) => kb(f) < 400), 'no single piece of art is over 400KB', ART.map((f) => `${f} ${kb(f).toFixed(0)}KB`).filter((s) => +s.split(' ')[1].replace('KB', '') > 100).join(', '));
check(!fs.existsSync(path.join(docs, 'airship-city.svg')), 'the airship art from the mistaken first reference is gone');

// --- per-look checks ------------------------------------------------------------------------
const hex = (h) => { const n = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const LOOKS = {
  crescent: {
    prefix: 'c', art: ['crescent-scene.svg', 'crescent-frame.svg', 'crescent-moon.svg'],
    pairs: [
      ['body text on a stone card', 'c-ink', 'c-card', 7],
      ['hints on a card', 'c-ink-soft', 'c-card', 4.5],
      ['jade labels on a card', 'c-jade-deep', 'c-card', 4.5],
      ['links on a card', 'c-sky-mid', 'c-card', 4.5],
      ['success text', 'c-green', 'c-card', 4.5],
      ['error text', 'c-red', 'c-card', 4.5],
      ['dark type on jade buttons', 'c-on-jade', 'c-jade', 4.5],
      ['cream type on the sky masthead', 'c-cream', 'c-sky', 4.5],
      ['cream type on the darkest blue of LAUNCH / the selected pad', 'c-cream', '#164e7c', 4.5],
      ['cream type on terracotta VAMP', 'c-cream', 'c-terra', 4.5],
    ],
  },
  byakko: {
    prefix: 'b', art: ['byakko-stars.svg', 'byakko-ribbons.svg', 'byakko-fur.svg', 'byakko-spots.svg', 'byakko-flame.svg', 'byakko-sparkle.svg'],
    pairs: [
      ['body text on white fur', 'b-ink', 'b-card', 7],
      ['body text on the panel fur', 'b-ink', 'b-fur', 7],
      ['hints on a card', 'b-ink-soft', 'b-card', 4.5],
      ['ultramarine labels and links', 'b-ultra-txt', 'b-card', 4.5],
      ['success text', 'b-green', 'b-card', 4.5],
      ['error text', 'b-red', 'b-card', 4.5],
      ['white type on ultramarine buttons', '#ffffff', 'b-ultra', 4.5],
      ['white type on the eye-red selected pad and LAUNCH', '#ffffff', 'b-red', 4.5],
      ['white masthead links on the night sky', '#f3f0f4', 'b-void', 7],
    ],
  },
  babel: {
    prefix: 'g', art: ['babel-scene.svg', 'babel-frame.svg'],
    pairs: [
      ['body text on a haze card', 'g-ink', 'g-card', 7],
      ['body text on the haze panel', 'g-ink', 'g-haze', 7],
      ['hints on a card', 'g-ink-soft', 'g-card', 4.5],
      ['rust labels on a card', 'g-rust-txt', 'g-card', 4.5],
      ['teal links on a card', 'g-teal-deep', 'g-card', 4.5],
      ['success text', 'g-green', 'g-card', 4.5],
      ['error text', 'g-red', 'g-card', 4.5],
      ['white type on teal buttons', '#ffffff', 'g-teal', 4.5],
      ['peach type on the iron selected pad and masthead', 'g-peach', 'g-iron', 4.5],
      ['iron type on the darkest band of the sunset LAUNCH plate', 'g-ink', '#e08a4e', 4.5],
    ],
  },
};
const doc = new JSDOM(fs.readFileSync(path.join(docs, 'index.html'), 'utf8')).window.document;
for (const [name, look] of Object.entries(LOOKS)) {
  const css = fs.readFileSync(path.join(docs, `${name}.css`), 'utf8');
  check((css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length && css.trimStart().startsWith('@import'),
    `${name}.css has balanced braces and its font @import first`);
  for (const v of ['--bg', '--panel', '--panel2', '--border', '--text', '--dim', '--accent', '--danger']) {
    if (!new RegExp(`\\n\\s*${v}:`).test(css)) check(false, `${name} remaps ${v}`);
  }
  check(['--bg', '--panel', '--panel2', '--border', '--text', '--dim', '--accent', '--danger'].every((v) => new RegExp(`\\n\\s*${v}:`).test(css)),
    `${name} remaps all eight shared properties`);
  for (const f of look.art) check(css.includes(`url("${f}")`), `${name}.css uses ${f}`);
  check(/skin-art\.mjs/.test(css), `${name}.css points at the generator for its artwork`);
  const t = Object.fromEntries([...css.matchAll(new RegExp(`--(${look.prefix}-[a-z-]+):\\s*(#[0-9a-f]{6})`, 'gi'))].map((m) => [m[1], m[2]]));
  for (const [what, fg, bg, min] of look.pairs) {
    const a = fg.startsWith('#') ? fg : t[fg], b = bg.startsWith('#') ? bg : t[bg];
    const r = a && b ? ratio(a, b) : 0;
    check(r >= min, `${name}: ${what} is at least ${min}:1`, a && b ? `${r.toFixed(2)}:1 (${a} on ${b})` : `missing ${fg} or ${bg}`);
  }
  const themed = ['.card', '.app', 'button', 'label', 'input[type=text]', 'select', '.pads', '.status', '.wallet-chip', 'header h1', '#vampBtn', '#launchBtn', '.drop', 'nav.menubar', '.modal'];
  // the stylesheets address the masthead as .menubar; the page's element is nav.menubar
  const unstyled = themed.filter((s) => !doc.querySelectorAll(s).length || !css.includes(s === 'nav.menubar' ? '.menubar' : s));
  check(unstyled.length === 0, `${name} styles every main element of the launcher`, unstyled.join(', ') || `${themed.length} selectors`);
  check(/\.menubar\s*\{[^}]*position:\s*fixed/.test(css) && /body\s*\{[^}]*padding-top:/.test(css), `${name}: masthead fixed, body padded for it`);
  check(/#vampBtn\s*\{[^}]*!important/.test(css), `${name}: VAMP's inline gradient is replaced`);
  check(/@media \(max-width: 560px\)\s*\{[^@]*header\s*\{\s*flex-wrap:\s*wrap/.test(css), `${name}: on a phone the header wraps instead of widening the page`);
  check(/@media \(prefers-reduced-motion: reduce\)/.test(css), `${name}: reduced motion is respected`);
  const stranded = [];
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(docs, page), 'utf8');
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const twoClass = [...style.matchAll(/^\s*(\.[a-z-]+\.[a-z-]+)\s*[,{]/gm)].map((m) => m[1]);
    const missed = [...new Set(twoClass)].filter((sel) => !css.includes(sel) && /btn|tab|pad|mini|primary|secondary|badge/.test(sel));
    if (missed.length) stranded.push(`${page}: ${missed.join(' ')}`);
  }
  check(stranded.length === 0, `${name}: no page's button variant is left unstyled`, stranded.join(' | ') || `${PAGES.length} pages scanned`);
}

console.log('');
process.exit(fails.length ? 1 : 0);
