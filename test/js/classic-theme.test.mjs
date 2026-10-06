// The classic theme, checked where it can be checked.
//
// This is a look, and a look cannot be unit tested - there is no renderer here,
// so nothing below claims the pages are attractive or even that they are
// legible. What it does check is the wiring, which is where a theme like this
// actually breaks:
//
//   - classic.css has to load AFTER each page's own <style> block. Every page
//     carries its own 54-126 line stylesheet built on the same custom
//     properties, and the whole approach depends on redefining those later in
//     document order so they win on ties. Put the <link> above the <style> and
//     the site silently stays dark.
//   - the selectors have to match something. A rule for .card is worthless on a
//     page with no .card, and that is invisible until someone looks.
//   - the menu bar has to name the page it is on, or every page looks identical.
//
// Run: node test/js/classic-theme.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const docs = path.join(import.meta.dirname, '..', '..', 'docs');
const PAGES = ['index.html', 'trade.html', 'swap.html', 'arc.html',
  'fees.html', 'force-migrate.html', 'pump-migrate.html', 'openfour.html'];

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

const css = fs.readFileSync(path.join(docs, 'classic.css'), 'utf8');

// --- the stylesheet itself -----------------------------------------------------
check((css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length,
  'classic.css has balanced braces',
  `${(css.match(/\{/g) || []).length} rules`);

for (const v of ['--c-face', '--c-navy', '--c-gold', '--c-light', '--c-shadow']) {
  check(new RegExp(`${v}:`).test(css), `it defines ${v}`);
}
check(/--bg:\s*var\(--c-navy\)/.test(css) && /--panel:\s*var\(--c-face\)/.test(css),
  'and remaps the variables the pages already use, which is what re-themes them');

// The deliberate departure: gold on grey is unreadable, so success text stays a
// dark green and the gold is used where it sits on navy. Pinned so nobody
// "fixes" it back into an unreadable launch confirmation.
check(/--accent:\s*#006000/.test(css) && !/--accent:\s*var\(--c-gold\)/.test(css),
  'success text is a dark green rather than gold, because gold on grey is ~1.6:1');
check(/--c-gold/.test(css) && /menubar a:hover u\s*\{\s*color:\s*var\(--c-gold\)/.test(css),
  'while the gold is used on navy, where it reads');

check(/border-radius:\s*0\s*!important/.test(css),
  'nothing is rounded, which is most of the era in one rule');
check(/a:visited\s*\{\s*color:\s*#551a8b/.test(css),
  'and visited links are still purple');

// --- every page is wired, in the right order -----------------------------------
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(docs, page), 'utf8');
  const link = html.indexOf('classic.css');
  const styleEnd = html.indexOf('</style>');
  check(link > -1, `${page} links classic.css`);
  check(link > styleEnd && styleEnd > -1,
    `${page} loads it AFTER its own <style>, so the remap wins`,
    link > styleEnd ? `link@${link} > style@${styleEnd}` : 'WRONG ORDER — page stays dark');
}

// --- the menu bar ---------------------------------------------------------------
for (const page of PAGES) {
  const dom = new JSDOM(fs.readFileSync(path.join(docs, page), 'utf8'));
  const d = dom.window.document;
  const bar = d.querySelector('nav.menubar');
  const links = bar ? [...bar.querySelectorAll('a')] : [];
  const current = links.filter((a) => a.getAttribute('aria-current') === 'page');
  const ok = !!bar && links.length === PAGES.length
    && current.length === 1 && current[0].getAttribute('href') === page
    && links.every((a) => a.querySelector('u'));
  check(ok, `${page} has the menu bar, marking itself as current`,
    bar ? `${links.length} items, current=${current[0]?.getAttribute('href')}` : 'no menubar');
}

// every page reachable from every page, which is the point of a menu
const first = new JSDOM(fs.readFileSync(path.join(docs, PAGES[0]), 'utf8')).window.document;
const hrefs = [...first.querySelectorAll('nav.menubar a')].map((a) => a.getAttribute('href')).sort();
check(JSON.stringify(hrefs) === JSON.stringify([...PAGES].sort()),
  'and it links to every page in docs/, none missing and none invented');

// --- the selectors match real elements ------------------------------------------
//
// A themed selector that matches nothing is a rule nobody will ever see fail.
const dom = new JSDOM(fs.readFileSync(path.join(docs, 'index.html'), 'utf8'));
const doc = dom.window.document;
const themed = ['.card', 'button', 'label', 'input[type=text]', 'select', '.pads', '.status', '.wallet-chip', 'header h1'];
const unmatched = themed.filter((sel) => doc.querySelectorAll(sel).length === 0);
check(unmatched.length === 0,
  'every element the theme styles actually exists on the launcher page',
  unmatched.length ? 'no match for ' + unmatched.join(', ') : `${themed.length} selectors`);

// the menu bar is fixed, so the body needs to clear it or the first control hides
check(/\.menubar\s*\{[^}]*position:\s*fixed/.test(css) && /body\s*\{[^}]*padding-top:/.test(css),
  'the bar is fixed and the body pads for it, so nothing sits underneath');

// --- nothing was broken on the way ----------------------------------------------
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(docs, page), 'utf8');
  const d = new JSDOM(html).window.document;
  check(!!d.querySelector('body') && d.querySelectorAll('script').length > 0,
    `${page} still parses with its scripts intact`,
    `${d.querySelectorAll('script').length} scripts`);
}

// the launcher's own ids must survive, or the app stops working
const ids = ['launchBtn', 'status', 'pads', 'name', 'symbol', 'walletChip'];
const missing = ids.filter((id) => !doc.getElementById(id));
check(missing.length === 0,
  'and the launcher keeps the ids its JS binds to',
  missing.length ? 'missing ' + missing.join(', ') : `${ids.length} checked`);

// --- the variants, which specificity would otherwise strand -------------------
//
// Each page carries two-class rules (.btn.secondary, .modal button.primary,
// .mini, .tab.active) that beat a bare `button` however late this file loads -
// specificity is not document order. A page with beveled buttons next to flat
// dark ones looks more broken than one that was never themed, so these are
// pinned by name.
const variants = ['.btn.secondary', '.btn.sell', '.btn.force', '.mini', '.tab.active',
  '.modal button.primary', '.chip-edit-row .x', '.pad.active'];
const untouched = variants.filter((v) => !css.includes(v));
check(untouched.length === 0,
  'the theme overrides every two-class button variant the pages define',
  untouched.length ? 'not covered: ' + untouched.join(', ') : `${variants.length} variants`);

// the confirm button was green-on-near-black; with --accent now dark green that
// would have been dark on dark
check(/\.modal button\.primary\s*\{[^}]*background:\s*var\(--c-face\)/.test(css),
  'and the modal confirm button is chrome rather than dark-green-on-near-black');

// every page's variant classes should be reachable by the theme
let strandedPages = [];
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(docs, page), 'utf8');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const twoClass = [...style.matchAll(/^\s*(\.[a-z-]+\.[a-z-]+)\s*[,{]/gm)].map((m) => m[1]);
  const missed = [...new Set(twoClass)].filter((sel) => !css.includes(sel)
    && /btn|tab|pad|mini|primary|secondary/.test(sel));
  if (missed.length) strandedPages.push(`${page}: ${missed.join(' ')}`);
}
check(strandedPages.length === 0,
  'no page defines a button-ish two-class rule the theme leaves unstyled',
  strandedPages.length ? strandedPages.join(' | ') : `${PAGES.length} pages scanned`);

console.log('');
console.log('   NOTE  there is no renderer here, so this proves the theme is wired,');
console.log('         not that it looks right. That needs eyes on the page.');
console.log('');
process.exit(fails.length ? 1 : 0);
