// Generates the artwork for the Crescent, Byakko and Babel looks.
//
//   node tools/skin-art.mjs        -> writes docs/{crescent,byakko,babel}-*.svg
//
// Drawn from code rather than by hand because the detail is the point: the
// tiger's flame ribbons carry thousands of glitter specks scattered along
// their length, the Babel tower is built level by level out of pipes, girders
// and lit windows, and the jade crescent is plated panel by panel. Every
// random choice comes from a seeded generator, so a run reproduces the
// committed files byte for byte and a change shows up as a real diff.
//
// Heavy repeated marks (pipes, buildings, specks of one colour) are merged
// into single <path>s per colour so the files stay small enough to ship.

import fs from 'node:fs';
import path from 'node:path';

const DOCS = path.join(import.meta.dirname, '..', 'docs');

// --- helpers ---------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r1 = (n) => Math.round(n * 10) / 10;
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const between = (rnd, a, b) => a + (b - a) * rnd();
const written = {};
function write(name, svg) {
  const out = svg.replace(/\n\s*\n/g, '\n');
  fs.writeFileSync(path.join(DOCS, name), out);
  written[name] = out.length;
}

// merged-path buckets: many marks of one style become one element
function buckets() {
  const map = new Map();
  return {
    add(style, d) { if (!map.has(style)) map.set(style, []); map.get(style).push(d); },
    render() {
      return [...map].map(([style, ds]) => `<path ${style} d="${ds.join('')}"/>`).join('\n');
    },
  };
}

// Catmull-Rom through points -> cubic segments; sampling at even spacing
function catmull(pts) {
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    segs.push([p1,
      [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      p2]);
  }
  return segs;
}
const bez = (s, t) => {
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * s[0][k] + 3 * u * u * t * s[1][k] + 3 * u * t * t * s[2][k] + t * t * t * s[3][k]);
};
const segsD = (segs) => 'M' + segs[0][0].map(r1).join(' ')
  + segs.map((s) => 'C' + [s[1], s[2], s[3]].map((p) => p.map(r1).join(' ')).join(' ')).join('');
function sampleAlong(segs, step) {
  const out = [];
  let carry = 0;
  for (const s of segs) {
    let prev = bez(s, 0);
    for (let i = 1; i <= 60; i++) {
      const p = bez(s, i / 60);
      const dx = p[0] - prev[0], dy = p[1] - prev[1];
      const len = Math.hypot(dx, dy);
      carry += len;
      while (carry >= step) {
        carry -= step;
        const k = 1 - carry / (len || 1);
        out.push({ x: prev[0] + dx * k, y: prev[1] + dy * k, nx: -dy / (len || 1), ny: dx / (len || 1) });
      }
      prev = p;
    }
  }
  return out;
}

// =================================================================================
// CRESCENT - a jade crescent megastructure over a coastal city, after the
// seventies science-fiction paperback painting
// =================================================================================
const JADE_LINE = '#2c5a47';

function crescentScene() {
  const W = 1600, H = 1000, HOR = 708, BEACH = 880, rnd = mulberry32(91);
  const C = [470, 418], R = 390;          // the sphere
  const C2 = [648, 296], R2 = 334;        // the bite taken out of it
  const inBody = (x, y) => Math.hypot(x - C[0], y - C[1]) < R && Math.hypot(x - C2[0], y - C2[1]) > R2;

  // --- the plating: latitude bands, brick-laid seams, light and dark panels
  const plates = buckets();
  const bands = [];
  for (let y = C[1] - R + 10; y < C[1] + R; y += between(rnd, 16, 30)) bands.push(y);
  for (let i = 0; i < bands.length - 1; i++) {
    const y0 = bands[i], y1 = bands[i + 1], ym = (y0 + y1) / 2;
    const hw = Math.sqrt(Math.max(0, R * R - (ym - C[1]) ** 2));
    plates.add(`stroke="${JADE_LINE}" stroke-width="1.1" stroke-opacity=".55" fill="none"`, `M${r1(C[0] - hw)} ${r1(y0)}H${r1(C[0] + hw)}`);
    plates.add('stroke="#c9ecd3" stroke-width=".7" stroke-opacity=".35" fill="none"', `M${r1(C[0] - hw)} ${r1(y0 + 1.4)}H${r1(C[0] + hw * 0.3)}`);
    const n = Math.max(6, Math.round(hw / 22));
    const shift = between(rnd, 0, 1);
    let prevX = C[0] - hw;
    for (let k = 0; k <= n; k++) {
      // seams spaced as meridians would be on the sphere: tighter at the limb
      const th = -Math.PI / 2 + ((k + shift) / (n + 1)) * Math.PI;
      const x = C[0] + hw * Math.sin(th) + between(rnd, -3, 3);
      plates.add(`stroke="${JADE_LINE}" stroke-width=".9" stroke-opacity=".5" fill="none"`, `M${r1(x)} ${r1(y0)}V${r1(y1)}`);
      const r = rnd();
      if (r < 0.16) plates.add('fill="#1f4636" opacity=".2"', `M${r1(prevX)} ${r1(y0)}H${r1(x)}V${r1(y1)}H${r1(prevX)}z`);
      else if (r < 0.27) plates.add('fill="#e3f6e8" opacity=".14"', `M${r1(prevX)} ${r1(y0)}H${r1(x)}V${r1(y1)}H${r1(prevX)}z`);
      // damage: chips, slots and scrapes
      if (rnd() < 0.2) {
        const dx = between(rnd, prevX, x), dy = between(rnd, y0 + 2, y1 - 4);
        plates.add('fill="#173528" opacity=".55"', `M${r1(dx)} ${r1(dy)}h${r1(between(rnd, 3, 14))}v${r1(between(rnd, 1.5, 4))}h${r1(-between(rnd, 3, 14))}z`);
      }
      if (rnd() < 0.06) plates.add('stroke="#e8fbef" stroke-width=".8" stroke-opacity=".35" fill="none"', `M${r1(between(rnd, prevX, x))} ${r1(between(rnd, y0, y1))}l${r1(between(rnd, 8, 30))} ${r1(between(rnd, -2, 2))}`);
      prevX = x;
    }
  }
  // a long gouge across the lower body, as in the painting
  plates.add('fill="#173528" opacity=".45"', 'M150 600L210 642L214 648L148 607z');

  // --- the cut face: the decks and domes stepping out of the bite
  const decks = [];
  const deckAngles = [146, 158, 171, 184, 197, 211, 226];
  for (const a of deckAngles) {
    const t = (a * Math.PI) / 180;
    const ex = C2[0] + Math.cos(t) * R2, ey = C2[1] + Math.sin(t) * R2;
    const dw = between(rnd, 50, 110), dh = between(rnd, 16, 30);
    // a deck pushing out of the cut, with a shadowed underside
    decks.push(`<path d="M${r1(ex - 30)} ${r1(ey - 4)}h28v${r1(dh + 10)}h-28z" fill="#24493a" opacity=".75"/>`);
    decks.push(`<path d="M${r1(ex - 26)} ${r1(ey)}h${r1(dw + 20)}l-6 ${r1(dh * 0.4)}h${r1(-dw * 0.5)}v${r1(dh * 0.6)}h${r1(-dw * 0.5 - 8)}z" fill="#6aa585" stroke="${JADE_LINE}" stroke-width="1"/>`);
    decks.push(`<path d="M${r1(ex - 6)} ${r1(ey + dh)}h${r1(dw * 0.5 + 6)}v4h${r1(-dw * 0.5 - 6)}z" fill="#24493a" opacity=".7"/>`);
    let rail = '';
    for (let x = ex; x < ex + dw - 8; x += 5) rail += `M${r1(x)} ${r1(ey)}v-3`;
    decks.push(`<path d="M${r1(ex - 4)} ${r1(ey - 3)}h${r1(dw - 6)}${rail}" stroke="${JADE_LINE}" stroke-width=".7" fill="none"/>`);
    let win = '';
    for (let x = ex + 4; x < ex + dw * 0.5; x += 7) win += `M${r1(x)} ${r1(ey + dh * 0.55)}h3v2.4h-3z`;
    decks.push(`<path d="${win}" fill="#1c3a2e" opacity=".7"/>`);
    if (rnd() < 0.55) {
      const dx = ex + between(rnd, 14, dw * 0.6), dr = between(rnd, 12, 24);
      decks.push(`<path d="M${r1(dx - dr)} ${r1(ey - 3)}A${r1(dr)} ${r1(dr * 0.85)} 0 0 1 ${r1(dx + dr)} ${r1(ey - 3)}Z" fill="url(#dome)" stroke="${JADE_LINE}" stroke-width=".9"/>`);
      decks.push(`<path d="M${r1(dx - dr - 4)} ${r1(ey - 3)}h${r1(dr * 2 + 8)}" stroke="${JADE_LINE}" stroke-width="1.4"/>`);
    }
    if (rnd() < 0.6) decks.push(`<path d="M${r1(ex + dw - 10)} ${r1(ey)}v${r1(-between(rnd, 14, 40))}M${r1(ex + dw - 14)} ${r1(ey - 10)}h8" stroke="${JADE_LINE}" stroke-width="1"/>`);
  }

  // --- the city along the horizon
  const city = buckets();
  const stone = ['#e6dfcd', '#d8ccb1', '#efe8d6', '#cbbd9f', '#dcd3bd'];
  for (let x = 300; x < W + 20;) {
    const tall = x > 1120 && rnd() < 0.55;
    const bw = between(rnd, 10, tall ? 26 : 40), bh = tall ? between(rnd, 70, 250) : between(rnd, 14, 70);
    const col = pick(rnd, stone);
    const y = HOR - bh;
    city.add(`fill="${col}"`, `M${r1(x)} ${r1(y)}h${r1(bw)}v${r1(bh)}h${r1(-bw)}z`);
    city.add('fill="#8f8572" opacity=".38"', `M${r1(x + bw * 0.6)} ${r1(y)}h${r1(bw * 0.4)}v${r1(bh)}h${r1(-bw * 0.4)}z`);
    if (tall) {
      const sp = between(rnd, 16, 60);
      city.add(`fill="${col}"`, `M${r1(x + bw * 0.25)} ${r1(y)}L${r1(x + bw * 0.5)} ${r1(y - sp)}L${r1(x + bw * 0.75)} ${r1(y)}z`);
      for (let wy = y + 8; wy < HOR - 6; wy += between(rnd, 7, 12)) city.add('fill="#7a705e" opacity=".45"', `M${r1(x + 2)} ${r1(wy)}h${r1(bw * 0.5)}v1.4h${r1(-bw * 0.5)}z`);
    }
    x += bw * between(rnd, 0.5, 1.1);
  }
  // domes and low halls in front
  for (let x = 320; x < W; x += between(rnd, 30, 80)) {
    const dr = between(rnd, 8, 24), y = HOR - between(rnd, 2, 18);
    const col = pick(rnd, ['#c99a82', '#b8735a', '#d9b29a', '#9fc4a9', '#e6dfcd']);
    city.add(`fill="${col}"`, `M${r1(x - dr)} ${r1(y)}A${r1(dr)} ${r1(dr * 0.8)} 0 0 1 ${r1(x + dr)} ${r1(y)}z`);
    city.add('fill="#d8ccb1"', `M${r1(x - dr - 6)} ${r1(y)}h${r1(dr * 2 + 12)}v${r1(HOR - y + 1)}h${r1(-dr * 2 - 12)}z`);
    city.add('fill="#8f8572" opacity=".3"', `M${r1(x - dr - 6)} ${r1(y)}h${r1(dr * 2 + 12)}v3h${r1(-dr * 2 - 12)}z`);
  }
  // cranes and masts at the harbour
  for (const hx of [380, 470, 1010]) city.add('stroke="#6f6a5e" stroke-width="1.6" fill="none"', `M${hx} ${HOR}V${HOR - 60}H${hx + 34}M${hx} ${HOR - 52}L${hx + 26} ${HOR - 60}`);

  // --- the sea, the boats, the beach and its walkers
  const glints = buckets();
  for (let i = 0; i < 220; i++) {
    const y = HOR + 4 + Math.pow(rnd(), 1.5) * (BEACH - HOR - 10);
    const len = between(rnd, 6, 40) * (0.4 + (y - HOR) / (BEACH - HOR));
    glints.add(`stroke="#e7fbf8" stroke-width="${y < 760 ? '.8' : '1.3'}" stroke-opacity="${between(rnd, 0.18, 0.55).toFixed(2)}" fill="none"`, `M${r1(between(rnd, 0, W))} ${r1(y)}h${r1(len)}`);
  }
  let boats = '';
  for (let i = 0; i < 12; i++) {
    const y = between(rnd, HOR + 8, BEACH - 20), s = 0.35 + (y - HOR) / (BEACH - HOR) * 1.3, x = between(rnd, 40, W - 60);
    boats += `<path d="M${r1(x - 3 * s)} ${r1(y + 4 * s)}h${r1(-40 * s)}" stroke="#effcf9" stroke-width="${r1(1.6 * s)}" opacity=".55"/>`;
    boats += `<path d="M${r1(x)} ${r1(y)}h${r1(30 * s)}l${r1(-5 * s)} ${r1(7 * s)}h${r1(-21 * s)}z" fill="${pick(rnd, ['#8a3226', '#7a2a22', '#e9e3d4'])}"/>`;
    boats += `<rect x="${r1(x + 9 * s)}" y="${r1(y - 6 * s)}" width="${r1(10 * s)}" height="${r1(6 * s)}" fill="#efe8d6"/>`;
    if (rnd() < 0.4) boats += `<path d="M${r1(x + 6 * s)} ${r1(y)}v${r1(-22 * s)}" stroke="#3b2a22" stroke-width="${r1(0.9 * s)}"/>`;
  }
  let walkers = '';
  const people = [[478, 0.95, '#7a3d2a'], [492, 0.9, '#c9a27a'], [503, 0.7, '#5e2e24'], [516, 1.05, '#8a4a30'], [534, 0.95, '#6b3527'], [552, 1.0, '#9a6040']];
  for (const [px, s, col] of people) {
    const py = 975;
    walkers += `<ellipse cx="${px + 9 * s}" cy="${py + 2}" rx="${r1(10 * s)}" ry="2" fill="#6f6556" opacity=".35"/>`;
    walkers += `<path d="M${r1(px - 4 * s)} ${py}L${r1(px - 2 * s)} ${r1(py - 24 * s)}H${r1(px + 2 * s)}L${r1(px + 4 * s)} ${py}z" fill="${col}"/>`;
    walkers += `<circle cx="${px}" cy="${r1(py - 27 * s)}" r="${r1(3 * s)}" fill="#4a2a20"/>`;
  }

  write('crescent-scene.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">
<!-- Crescent look: a jade megastructure - a sphere with a bite taken out of
     it, plated in brick-laid panels, chipped and gouged, decks and domes
     stepping out of the cut - hanging over a pale city of spires and domes on
     a teal sea, with walkers on a white beach. Seventies paperback colours.
     Placed left of centre so it stands beside the app column.
     Generated by tools/skin-art.mjs. -->
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="${HOR}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#15527f"/><stop offset=".55" stop-color="#2a76ac"/><stop offset="1" stop-color="#6aa9cd"/></linearGradient>
  <radialGradient id="body" cx="330" cy="290" r="560" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#b5e0c1"/><stop offset=".42" stop-color="#78b893"/><stop offset=".78" stop-color="#559a7a"/><stop offset="1" stop-color="#3c7a62"/></radialGradient>
  <radialGradient id="terminator" cx="300" cy="260" r="640" gradientUnits="userSpaceOnUse"><stop offset=".55" stop-color="#0d2a20" stop-opacity="0"/><stop offset="1" stop-color="#0d2a20" stop-opacity=".45"/></radialGradient>
  <linearGradient id="dome" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#cdeed6"/><stop offset="1" stop-color="#5e9c7e"/></linearGradient>
  <linearGradient id="sea" x1="0" y1="${HOR}" x2="0" y2="${BEACH}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#5fb2b3"/><stop offset=".35" stop-color="#3a9aa0"/><stop offset="1" stop-color="#2a8590"/></linearGradient>
  <linearGradient id="sand" x1="0" y1="${BEACH}" x2="0" y2="${H}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f3eee2"/><stop offset="1" stop-color="#e2dac7"/></linearGradient>
  <linearGradient id="haze" x1="0" y1="${HOR - 160}" x2="0" y2="${HOR}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#bfdcea" stop-opacity="0"/><stop offset="1" stop-color="#d9ecf2" stop-opacity=".55"/></linearGradient>
  <mask id="cres"><circle cx="${C[0]}" cy="${C[1]}" r="${R}" fill="#fff"/><circle cx="${C2[0]}" cy="${C2[1]}" r="${R2}" fill="#000"/></mask>
  <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="2" seed="12"/><feColorMatrix values="0 0 0 0 .2  0 0 0 0 .25  0 0 0 0 .25  0 0 0 .16 0"/></filter>
  <filter id="soft"><feGaussianBlur stdDeviation="1.2"/></filter>
</defs>
<rect width="${W}" height="${HOR + 2}" fill="url(#sky)"/>
<g mask="url(#cres)">
  <circle cx="${C[0]}" cy="${C[1]}" r="${R}" fill="url(#body)"/>
  ${plates.render()}
  <circle cx="${C2[0]}" cy="${C2[1]}" r="${R2 + 14}" fill="none" stroke="#2f5f4c" stroke-width="30"/>
  <circle cx="${C2[0]}" cy="${C2[1]}" r="${R2 + 2}" fill="none" stroke="#1d3d31" stroke-width="5" opacity=".7"/>
  <circle cx="${C[0]}" cy="${C[1]}" r="${R}" fill="url(#terminator)"/>
  <circle cx="${C[0]}" cy="${C[1]}" r="${R - 3}" fill="none" stroke="#d6f3de" stroke-width="5" stroke-opacity=".25"/>
</g>
${decks.join('\n')}
<rect y="${HOR - 160}" width="${W}" height="160" fill="url(#haze)"/>
${city.render()}
<rect y="${HOR}" width="${W}" height="${BEACH - HOR}" fill="url(#sea)"/>
${glints.render()}
${boats}
<path d="M0 ${BEACH}C200 ${BEACH - 5} 360 ${BEACH + 5} 560 ${BEACH}S920 ${BEACH - 6} 1120 ${BEACH}S1460 ${BEACH + 4} ${W} ${BEACH}V${H}H0Z" fill="url(#sand)"/>
<path d="M0 ${BEACH}C200 ${BEACH - 5} 360 ${BEACH + 5} 560 ${BEACH}S920 ${BEACH - 6} 1120 ${BEACH}S1460 ${BEACH + 4} ${W} ${BEACH}" stroke="#ffffff" stroke-width="3" fill="none" opacity=".85" filter="url(#soft)"/>
${walkers}
<rect width="${W}" height="${H}" filter="url(#grain)"/>
</svg>`);
}

function crescentFrame() {
  // a jade plated band: seams across it, notches, and a small domed turret
  // at each corner
  const corner = `<g id="c">
    <rect x="3" y="3" width="26" height="26" fill="url(#j)" stroke="${JADE_LINE}" stroke-width="1.2"/>
    <path d="M7 19A9 8 0 0 1 25 19Z" fill="#cdeed6" stroke="${JADE_LINE}" stroke-width="1"/>
    <path d="M5 19H27" stroke="${JADE_LINE}" stroke-width="1.4"/>
    <path d="M16 11V6" stroke="${JADE_LINE}" stroke-width="1"/>
    <path d="M9 23h3v2h-3zM15 23h3v2h-3zM21 23h3v2h-3z" fill="${JADE_LINE}" opacity=".6"/>
  </g>`;
  write('crescent-frame.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
<!-- Card frame for the Crescent look, nine-sliced 32px: a jade plated band
     with seams and notches, a domed turret at each corner.
     Generated by tools/skin-art.mjs. -->
<defs>
  <linearGradient id="j" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a6d8b5"/><stop offset=".55" stop-color="#6fb08c"/><stop offset="1" stop-color="#4c8f71"/></linearGradient>
  ${corner}
</defs>
<path d="M29 5H67V14H29ZM29 82H67V91H29ZM5 29H14V67H5ZM82 29H91V67H82Z" fill="url(#j)" stroke="${JADE_LINE}" stroke-width="1.1"/>
<path d="M40 5V14M56 5V14M40 82V91M56 82V91M5 40H14M5 56H14M82 40H91M82 56H91" stroke="${JADE_LINE}" stroke-width=".9" stroke-opacity=".7"/>
<path d="M45 8h6v2h-6zM45 86h6v2h-6zM8 45h2v6h-2zM86 45h2v6h-2z" fill="#1f4636" opacity=".55"/>
<use href="#c"/><use href="#c" transform="translate(96 0) scale(-1 1)"/>
<use href="#c" transform="translate(0 96) scale(1 -1)"/><use href="#c" transform="translate(96 96) scale(-1 -1)"/>
</svg>`);
}

function crescentMoon() {
  write('crescent-moon.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
<!-- The crescent itself, small: for buttons and the image drop.
     Generated by tools/skin-art.mjs. -->
<defs>
  <radialGradient id="b" cx="22" cy="20" r="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#bfe6c9"/><stop offset=".55" stop-color="#6fb08c"/><stop offset="1" stop-color="#3c7a62"/></radialGradient>
  <mask id="m"><circle cx="30" cy="34" r="26" fill="#fff"/><circle cx="42" cy="26" r="22" fill="#000"/></mask>
</defs>
<g mask="url(#m)">
  <circle cx="30" cy="34" r="26" fill="url(#b)"/>
  <path d="M4 18H60M4 26H60M4 34H60M4 42H60M4 50H60" stroke="${JADE_LINE}" stroke-width=".8" stroke-opacity=".5"/>
  <path d="M14 18V26M22 26V34M10 34V42M18 42V50M26 50V58M12 50V58" stroke="${JADE_LINE}" stroke-width=".8" stroke-opacity=".5"/>
  <circle cx="42" cy="26" r="23.5" fill="none" stroke="#2f5f4c" stroke-width="4"/>
</g>
<path d="M17 47A4 3.4 0 0 1 25 47Z" fill="#cdeed6" stroke="${JADE_LINE}" stroke-width=".7"/>
</svg>`);
}

// =================================================================================
// BYAKKO - the white tiger in cosmic flame, after the glittering painting
// =================================================================================
const GOLD = '#f5c542', RED = '#e8322b', WHITE = '#fffaf4', ULTRA = '#2f5bd3';

function sparklePath(x, y, L) {
  const w = L * 0.13;
  return `M${r1(x)} ${r1(y - L)}L${r1(x + w)} ${r1(y - w)}L${r1(x + L)} ${r1(y)}L${r1(x + w)} ${r1(y + w)}L${r1(x)} ${r1(y + L)}L${r1(x - w)} ${r1(y + w)}L${r1(x - L)} ${r1(y)}L${r1(x - w)} ${r1(y - w)}Z`;
}

function byakkoStars() {
  const S = 360, rnd = mulberry32(21);
  const sp = buckets();
  for (let i = 0; i < 230; i++) {
    const x = between(rnd, 2, S - 2), y = between(rnd, 2, S - 2);
    const col = pick(rnd, ['#ffffff', '#ffffff', '#cfe0ff', '#9fb8ff', '#ffe7a6']);
    const rr = r1(between(rnd, 0.35, 1.15));
    sp.add(`fill="${col}" opacity="${between(rnd, 0.35, 0.95).toFixed(2)}"`, `M${r1(x - rr)} ${r1(y)}a${rr} ${rr} 0 1 0 ${r1(rr * 2)} 0a${rr} ${rr} 0 1 0 ${r1(-rr * 2)} 0`);
  }
  let stars = '';
  for (let i = 0; i < 8; i++) {
    const L = between(rnd, 5, 15), x = between(rnd, L + 4, S - L - 4), y = between(rnd, L + 4, S - L - 4);
    stars += `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(L * 0.7)}" fill="url(#glow)"/><path d="${sparklePath(x, y, L)}" fill="url(#gold)"/>`;
  }
  write('byakko-stars.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
<!-- Byakko look: the night sky - glitter specks in white, ice blue and
     gold, and four-point gold sparkles. Transparent; sits on black. Tiles
     seamlessly. Generated by tools/skin-art.mjs. -->
<defs>
  <radialGradient id="glow"><stop offset="0" stop-color="#fff6d6" stop-opacity=".9"/><stop offset=".35" stop-color="${GOLD}" stop-opacity=".35"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></radialGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3c2"/><stop offset=".5" stop-color="${GOLD}"/><stop offset="1" stop-color="#d99a1e"/></linearGradient>
</defs>
${sp.render()}
${stars}
</svg>`);
}

// a Japanese kaen flame tongue: wavy sides, a curl at the tip; base at 0,0,
// pointing up, ~60 tall
const KAEN = 'M0 0C-11 -7 -15 -21 -7 -31C-1 -38 -9 -45 -3 -57C1 -49 11 -47 13 -38C16 -28 8 -22 13 -14C15 -8 10 -2 0 0Z';
const KAEN_CORE = 'M-1 -4C-5 -12 -4 -20 1 -26C4 -31 1 -36 3 -42';

function byakkoRibbons() {
  const rnd = mulberry32(33);
  // fewer, longer, less periodic sweeps; several end in a curl
  const ribbons = [
    { w: 40, blue: true, pts: [[-60, 60], [150, 210], [210, 430], [70, 640], [140, 900], [330, 1080], [250, 1300], [90, 1420], [60, 1560], [150, 1640]] },
    { w: 18, blue: false, pts: [[220, -30], [90, 150], [30, 360], [160, 520], [300, 600], [330, 520], [270, 470]] },
    { w: 22, blue: false, pts: [[-30, 980], [60, 1120], [210, 1210], [280, 1380], [180, 1520], [40, 1580]] },
    { w: 36, blue: true, pts: [[1260, 40], [1060, 170], [960, 400], [1110, 620], [1180, 840], [990, 1040], [930, 1260], [1090, 1460], [1240, 1560]] },
    { w: 16, blue: false, pts: [[1220, 560], [1090, 640], [1040, 780], [1130, 900], [1190, 860], [1160, 800]] },
    { w: 20, blue: true, pts: [[940, 1660], [1010, 1500], [1150, 1430], [1260, 1300]] },
    { w: 16, blue: false, pts: [[300, -40], [520, 50], [720, 10], [900, 80], [1060, 30], [1250, 70]] },
  ];
  const back = [], body = [];
  const specks = buckets();
  const tongues = [];
  for (const rb of ribbons) {
    const segs = catmull(rb.pts);
    const pts = sampleAlong(segs, 6);
    const n = pts.length;
    // the width swells and pinches along the length and tapers at both ends
    const phase = rnd() * 6.28, freq = between(rnd, 2.2, 3.6);
    const hw = (i) => {
      const t = i / (n - 1);
      const taper = Math.min(1, t / 0.08, (1 - t) / 0.14);
      return (rb.w / 2) * Math.max(0.12, taper) * (0.62 + 0.38 * Math.sin(phase + t * freq * Math.PI * 2));
    };
    const outline = (k) => {
      const L = pts.map((p, i) => [p.x + p.nx * hw(i) * k, p.y + p.ny * hw(i) * k]);
      const R = pts.map((p, i) => [p.x - p.nx * hw(i) * k, p.y - p.ny * hw(i) * k]).reverse();
      return 'M' + [...L, ...R].map((q) => q.map(r1).join(' ')).join('L') + 'Z';
    };
    const shape = outline(1);
    back.push(`<path d="${segsD(segs)}" stroke="${GOLD}" stroke-width="${rb.w + 30}" opacity=".24" filter="url(#glow)" fill="none"/>`);
    body.push(`<path d="${shape}" fill="${WHITE}" stroke="${RED}" stroke-width="9" stroke-linejoin="round"/>`);
    body.push(`<path d="${shape}" fill="${WHITE}" stroke="${GOLD}" stroke-width="4.5" stroke-linejoin="round"/>`);
    body.push(`<path d="${shape}" fill="${WHITE}"/>`);
    if (rb.blue) body.push(`<path d="${outline(0.36)}" fill="${ULTRA}" opacity=".88"/>`);
    // glitter: across the body, red and gold at the edges, starlight in the blue
    pts.forEach((p, i) => {
      const h = hw(i);
      for (let k = 0; k < 2; k++) {
        const off = (rnd() * 2 - 1) * h * 1.25;
        const edge = Math.abs(off) > h * 0.8;
        const col = edge ? pick(rnd, [RED, GOLD, '#ff8a3d', GOLD]) : pick(rnd, ['#ffffff', '#fff1c9', '#d8e4ff', '#ffffff']);
        const rr = r1(between(rnd, 0.45, edge ? 1.6 : 1.1));
        const x = p.x + p.nx * off, y = p.y + p.ny * off;
        specks.add(`fill="${col}"`, `M${r1(x - rr)} ${r1(y)}a${rr} ${rr} 0 1 0 ${r1(rr * 2)} 0a${rr} ${rr} 0 1 0 ${r1(-rr * 2)} 0`);
      }
      if (rb.blue) {
        const off = (rnd() * 2 - 1) * h * 0.32, rr = r1(between(rnd, 0.5, 1.7));
        specks.add('fill="#ffffff"', `M${r1(p.x + p.nx * off - rr)} ${r1(p.y + p.ny * off)}a${rr} ${rr} 0 1 0 ${r1(rr * 2)} 0a${rr} ${rr} 0 1 0 ${r1(-rr * 2)} 0`);
      }
    });
    // flame tongues licking off the outside of the bends
    for (let i = 12; i < n - 12; i += Math.floor(between(rnd, 22, 46))) {
      const p = pts[i], side = rnd() < 0.5 ? 1 : -1;
      const ang = (Math.atan2(p.ny * side, p.nx * side) * 180) / Math.PI + 90;
      const sc = between(rnd, 0.45, 1.05) * (rb.w / 34 + 0.35);
      tongues.push(`<use href="#tongue" transform="translate(${r1(p.x + p.nx * side * hw(i) * 0.7)} ${r1(p.y + p.ny * side * hw(i) * 0.7)}) rotate(${r1(ang + between(rnd, -20, 20))}) scale(${r1(sc * (rnd() < 0.5 ? 1 : -1))} ${r1(sc)})"/>`);
    }
  }
  write('byakko-ribbons.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600" stroke-linecap="round">
<!-- Byakko look: cosmic flame ribbons streaming down either side of the
     screen. Each is a filled shape that swells and pinches along its length
     and tapers at the ends - a white core edged in gold then red, a channel
     of ultramarine starlight in the widest, glitter scattered along every
     one, and kaen flame tongues curling off the bends.
     Generated by tools/skin-art.mjs. -->
<defs>
  <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10"/></filter>
  <g id="tongue">
    <path d="${KAEN}" fill="${WHITE}" stroke="${RED}" stroke-width="5" stroke-linejoin="round"/>
    <path d="${KAEN}" fill="${WHITE}" stroke="${GOLD}" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="${KAEN_CORE}" fill="none" stroke="${ULTRA}" stroke-width="1.6" opacity=".55"/>
  </g>
</defs>
${back.join('\n')}
${tongues.join('\n')}
${body.join('\n')}
${specks.render()}
</svg>`);
}

function byakkoFur() {
  const S = 160, rnd = mulberry32(44);
  const strokes = buckets();
  for (let i = 0; i < 620; i++) {
    const x = between(rnd, 0, S), y = between(rnd, 0, S);
    const len = between(rnd, 5, 12), ang = between(rnd, 1.05, 1.45);
    const bend = between(rnd, -2, 2);
    const col = pick(rnd, ['#c9d0e2', '#dfe3ef', '#ffffff', '#aab5d2', '#e9ecf4']);
    const wdt = pick(rnd, ['.5', '.7', '.9']);
    const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const sx = x + ox, sy = y + oy;
      if (sx + dx < -2 || sx > S + 2 || sy + dy < -2 || sy > S + 2) continue;
      strokes.add(`stroke="${col}" stroke-width="${wdt}"`, `M${r1(sx)} ${r1(sy)}q${r1(dx / 2 + bend)} ${r1(dy / 2)} ${r1(dx)} ${r1(dy)}`);
    }
  }
  write('byakko-fur.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" fill="none" stroke-linecap="round" opacity=".7">
<!-- White fur for Byakko cards: short brushed strokes in pale blue-greys,
     all leaning the same way. Transparent; sits on the card's white. Tiles
     seamlessly. Generated by tools/skin-art.mjs. -->
${strokes.render()}
</svg>`);
}

function byakkoSpots() {
  const S = 240, rnd = mulberry32(55);
  const spots = buckets();
  const centres = [];
  for (let gx = 0; gx < 4; gx++) for (let gy = 0; gy < 4; gy++) {
    centres.push([gx * 60 + between(rnd, 10, 50), gy * 60 + between(rnd, 10, 50)]);
  }
  for (const [cx, cy] of centres) {
    const R = between(rnd, 9, 15), n = Math.floor(between(rnd, 4, 6.99));
    const solid = rnd() < 0.25;
    const parts = [];
    if (solid) parts.push([0, 0, between(rnd, 3, 5.5), between(rnd, 2.5, 4), between(rnd, 0, 180)]);
    else {
      const a0 = rnd() * Math.PI * 2;
      for (let k = 0; k < n; k++) {
        const a = a0 + (k / n) * Math.PI * 2 + between(rnd, -0.2, 0.2);
        parts.push([Math.cos(a) * R, Math.sin(a) * R, between(rnd, 4, 7), between(rnd, 2.2, 3.6), (a * 180) / Math.PI + 90]);
      }
    }
    for (const [px, py, rx, ry, rot] of parts) {
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const x = cx + px + ox, y = cy + py + oy;
        if (x < -10 || x > S + 10 || y < -10 || y > S + 10) continue;
        const t = (rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
        // a rotated ellipse as two arcs
        const ax = x - rx * c, ay = y - rx * s, bx = x + rx * c, by = y + rx * s;
        spots.add('fill="#050816"', `M${r1(ax)} ${r1(ay)}A${r1(rx)} ${r1(ry)} ${r1(rot)} 1 0 ${r1(bx)} ${r1(by)}A${r1(rx)} ${r1(ry)} ${r1(rot)} 1 0 ${r1(ax)} ${r1(ay)}`);
      }
    }
  }
  write('byakko-spots.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" opacity=".5">
<!-- Snow-leopard rosettes for the Byakko panel: broken rings of dark blobs
     and the odd solid spot. Transparent; sits on ultramarine. Tiles
     seamlessly. Generated by tools/skin-art.mjs. -->
${spots.render()}
</svg>`);
}

function byakkoFlame() {
  const tongue = KAEN;
  const parts = [[-28, 1.15], [2, 1.35], [32, 1.0], [58, 0.75]].map(([rot, sc]) =>
    `<g transform="translate(14 86) rotate(${rot}) scale(${sc})"><path d="${tongue}" fill="${WHITE}" stroke="${RED}" stroke-width="4.6"/><path d="${tongue}" fill="${WHITE}" stroke="${GOLD}" stroke-width="2.2"/><path d="${KAEN_CORE}" stroke="${ULTRA}" stroke-width="1.6" fill="none" opacity=".6"/></g>`).join('');
  write('byakko-flame.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
<!-- A spray of flame tongues for the corner of a Byakko card: white cores,
     gold then red edges, a thread of blue. Generated by tools/skin-art.mjs. -->
<defs><filter id="g" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3"/></filter></defs>
<circle cx="24" cy="70" r="26" fill="${GOLD}" opacity=".25" filter="url(#g)"/>
${parts}
<path d="${sparklePath(78, 22, 11)}" fill="${GOLD}"/>
<path d="${sparklePath(62, 44, 5)}" fill="#fff3c2"/>
</svg>`);
}

function byakkoSparkle() {
  write('byakko-sparkle.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
<!-- One gold four-point sparkle, for buttons and the masthead.
     Generated by tools/skin-art.mjs. -->
<defs>
  <radialGradient id="glow"><stop offset="0" stop-color="#fff6d6"/><stop offset=".3" stop-color="${GOLD}" stop-opacity=".5"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></radialGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3c2"/><stop offset=".5" stop-color="${GOLD}"/><stop offset="1" stop-color="#d99a1e"/></linearGradient>
</defs>
<circle cx="20" cy="20" r="13" fill="url(#glow)"/>
<path d="${sparklePath(20, 20, 18)}" fill="url(#gold)"/>
</svg>`);
}

// =================================================================================
// BABEL - the industrial tower over the city and the sea, after the oil painting
// =================================================================================
function babelScene() {
  const rnd = mulberry32(77);
  const W = 1600, H = 1000, HORIZON = 560;
  const cx = 300, top = 190, base = 905;
  const half = (y) => {
    const t = Math.min(1, Math.max(0, (y - top) / (base - top)));
    return 255 * (0.24 + 0.76 * Math.pow(Math.sin((t * Math.PI) / 2), 0.55));
  };
  // city: rows of buildings receding to the horizon
  const city = buckets();
  const roofs = ['#b8a08c', '#a5583f', '#d8c6ad', '#8c8a8f', '#6e6a6d', '#c9b6a0', '#e2d4bd', '#bfae98', '#9d968f', '#d3c2a8'];
  const shoreX = (y) => 760 + Math.pow((y - HORIZON) / (H - HORIZON), 1.3) * 240 + Math.sin(y / 23) * 9 + Math.sin(y / 61) * 16;
  for (let y = HORIZON + 26; y < H + 10;) {
    const s = (y - HORIZON) / (H - HORIZON);
    const rowH = 3 + s * 16;
    let x = between(rnd, -10, 0);
    const xmax = shoreX(y) - 4;
    while (x < xmax) {
      const bw = between(rnd, 3, 7) + s * between(rnd, 6, 16), bh = between(rnd, 2, 6) + s * between(rnd, 6, 22);
      const col = pick(rnd, roofs);
      city.add(`fill="${col}"`, `M${r1(x)} ${r1(y - bh)}h${r1(bw)}v${r1(bh)}h${r1(-bw)}z`);
      if (s > 0.18) city.add('fill="#2f2a2a" opacity=".32"', `M${r1(x + bw * 0.62)} ${r1(y - bh)}h${r1(bw * 0.38)}v${r1(bh)}h${r1(-bw * 0.38)}z`);
      if (s > 0.35 && rnd() < 0.5) {
        for (let wy = y - bh + 2; wy < y - 2; wy += 3 + s * 2) city.add('fill="#3a3030" opacity=".35"', `M${r1(x + 1.5)} ${r1(wy)}h${r1(bw * 0.4)}v1z`);
      }
      x += bw + between(rnd, 0.3, 1.5) * (0.5 + s);
    }
    y += rowH * between(rnd, 0.55, 0.85);
  }

  // the tower: a stepped, jagged silhouette, level by level
  const levels = [];
  for (let y = top; y < base;) {
    const lh = between(rnd, 7, 13);
    const hw = half(y);
    levels.push({ y, lh, l: cx - hw * between(rnd, 0.97, 1.04) - between(rnd, 0, 9), r: cx + hw * between(rnd, 0.97, 1.04) + between(rnd, 0, 9) });
    y += lh;
  }
  let sil = `M${r1(levels[0].l)} ${r1(levels[0].y)}`;
  for (const L of levels) sil += `L${r1(L.l)} ${r1(L.y)}L${r1(L.l)} ${r1(L.y + L.lh)}`;
  for (const L of [...levels].reverse()) sil += `L${r1(L.r)} ${r1(L.y + L.lh)}L${r1(L.r)} ${r1(L.y)}`;
  sil += 'Z';

  const tw = buckets();
  // faint girders - the structure reads vertical, as in the painting
  for (const L of levels) {
    tw.add('stroke="#1d1818" stroke-width="1" stroke-opacity=".42" fill="none"', `M${r1(L.l)} ${r1(L.y)}H${r1(L.r)}`);
    if (rnd() < 0.4) tw.add('stroke="#e6cfae" stroke-width=".7" stroke-opacity=".28" fill="none"', `M${r1(L.l)} ${r1(L.y + 1.3)}H${r1(cx)}`);
    for (let x = L.l; x < L.r;) {
      const lit = x < cx - (cx - L.l) * 0.2;
      const rr = rnd();
      if (rr < 0.1) tw.add(`fill="${pick(rnd, ['#ffb35c', '#ffc979', '#ff9a3d'])}" opacity="${lit ? '.5' : '.85'}"`, `M${r1(x)} ${r1(L.y + L.lh * 0.4)}h2v2.4h-2z`);
      else if (rr < 0.14) {
        const w2 = between(rnd, 6, 16);
        tw.add(`fill="${lit ? '#9a8a7c' : '#4a4341'}"`, `M${r1(x)} ${r1(L.y + 2)}h${r1(w2)}v${r1(L.lh - 2.5)}h${r1(-w2)}z`);
        tw.add('fill="#d8c4a8" opacity=".35"', `M${r1(x)} ${r1(L.y + 2)}h${r1(w2)}v1.3h${r1(-w2)}z`);
        x += w2;
      } else if (rr < 0.17) {
        tw.add('stroke="#1d1919" stroke-width=".7" stroke-opacity=".55" fill="none"', `M${r1(x)} ${r1(L.y + 1)}L${r1(x + 6)} ${r1(L.y + L.lh)}M${r1(x + 6)} ${r1(L.y + 1)}L${r1(x)} ${r1(L.y + L.lh)}`);
      }
      x += between(rnd, 4, 10);
    }
  }
  // long vertical pipe runs, spanning many levels: the grain of the thing
  for (let i = 0; i < 420; i++) {
    const L0 = levels[Math.floor(rnd() * levels.length)];
    const span = Math.floor(between(rnd, 3, 16));
    const x = between(rnd, L0.l, L0.r);
    const lit = x < cx - (cx - L0.l) * 0.2;
    const wdt = pick(rnd, ['1', '1.4', '2', '2.8']);
    const y1 = Math.min(base, L0.y + span * 10);
    tw.add(lit ? `stroke="#c9ad8a" stroke-width="${wdt}" stroke-opacity=".34" fill="none"` : `stroke="#141111" stroke-width="${wdt}" stroke-opacity=".62" fill="none"`, `M${r1(x)} ${r1(L0.y)}V${r1(y1)}`);
    if (+wdt >= 2 && lit) tw.add('stroke="#f3e2c4" stroke-width=".6" stroke-opacity=".45" fill="none"', `M${r1(x - 0.6)} ${r1(L0.y)}V${r1(y1)}`);
  }

  // machinery jutting out past the silhouette, lit on the left, dark on the right
  const jut = buckets();
  for (let i = 0; i < 46; i++) {
    const L = levels[Math.floor(between(rnd, 3, levels.length - 2))];
    const leftSide = rnd() < 0.5;
    const bw = between(rnd, 8, 34), bh = L.lh * between(rnd, 1, 3.5), out = between(rnd, 2, 22);
    const x = leftSide ? L.l - out : L.r + out - bw;
    jut.add(`fill="${leftSide ? pick(rnd, ['#b39c86', '#a48f7b', '#c2ab92']) : pick(rnd, ['#2f2b2c', '#3a3536', '#262223'])}"`, `M${r1(x)} ${r1(L.y)}h${r1(bw)}v${r1(bh)}h${r1(-bw)}z`);
    jut.add('stroke="#1a1616" stroke-width=".8" stroke-opacity=".7" fill="none"', `M${r1(x)} ${r1(L.y)}h${r1(bw)}M${r1(x + bw * 0.3)} ${r1(L.y)}v${r1(bh)}M${r1(x + bw * 0.7)} ${r1(L.y)}v${r1(bh)}`);
    if (rnd() < 0.5) jut.add('stroke="#2a2526" stroke-width="1.2" fill="none"', `M${r1(x + bw * 0.5)} ${r1(L.y)}v${r1(-between(rnd, 6, 30))}`);
  }

  // spires and masts over the whole upper third, tallest at the crown
  const spires = buckets();
  for (let i = 0; i < 230; i++) {
    const t = Math.pow(rnd(), 1.7);
    const yb = top + t * (base - top) * 0.34;
    const hw = half(yb) * 0.95;
    const u = rnd() * 2 - 1;
    const x = cx + u * hw;
    const crown = 1 - t * 2.5;
    const ht = between(rnd, 14, 50) + Math.max(0, crown) * (1 - Math.abs(u) * 0.6) * between(rnd, 30, 120);
    const wdt = pick(rnd, ['.8', '1.2', '1.8', '2.6']);
    spires.add(`stroke="${u < -0.25 ? '#3d3534' : '#221d1e'}" stroke-width="${wdt}" fill="none"`, `M${r1(x)} ${r1(yb)}V${r1(yb - ht)}`);
    if (rnd() < 0.35) spires.add('stroke="#221d1e" stroke-width=".7" fill="none"', `M${r1(x - 3.5)} ${r1(yb - ht * between(rnd, 0.4, 0.8))}H${r1(x + 3.5)}`);
    if (rnd() < 0.12) spires.add('stroke="#221d1e" stroke-width=".6" fill="none"', `M${r1(x - 6)} ${r1(yb)}L${r1(x)} ${r1(yb - ht * 0.85)}L${r1(x + 6)} ${r1(yb)}`);
    if (rnd() < 0.2) spires.add('fill="#ffb35c"', `M${r1(x - 0.8)} ${r1(yb - ht - 1)}h1.6v1.6h-1.6z`);
  }

  // the sea: everything right of the shore below the horizon
  let shore = `M${r1(shoreX(HORIZON))} ${HORIZON}`;
  for (let y = HORIZON; y <= H; y += 20) shore += `L${r1(shoreX(y))} ${y}`;
  const sea = shore + `L${W} ${H}L${W} ${HORIZON}Z`;
  const glints = buckets();
  for (let i = 0; i < 260; i++) {
    const y = HORIZON + Math.pow(rnd(), 1.8) * (H - HORIZON);
    const x = between(rnd, shoreX(y) + 10, W);
    const len = between(rnd, 4, 30) * (0.3 + (y - HORIZON) / (H - HORIZON));
    glints.add(`stroke="#e9f7f3" stroke-width="${y < 640 ? '.7' : '1.1'}" stroke-opacity="${between(rnd, 0.15, 0.45).toFixed(2)}" fill="none"`, `M${r1(x)} ${r1(y)}h${r1(len)}`);
  }
  let boats = '';
  for (let i = 0; i < 9; i++) {
    const y = between(rnd, 600, 960), x = between(rnd, shoreX(y) + 40, W - 40), s = 0.4 + (y - HORIZON) / (H - HORIZON);
    boats += `<path d="M${r1(x)} ${r1(y)}h${r1(9 * s)}l${r1(-2 * s)} ${r1(2.4 * s)}h${r1(-6 * s)}z" fill="#2b2b30"/><path d="M${r1(x - 3 * s)} ${r1(y + 2 * s)}h${r1(-30 * s)}" stroke="#d9efea" stroke-width="${r1(1.2 * s)}" opacity=".6"/>`;
  }

  const puffs = [];
  {
    let x = cx + 70, y = top + 46, rad = 16;
    for (let i = 0; i < 46; i++) {
      const rise = i < 8 ? -5 : between(rnd, -1.5, 2.2);
      x += 6 + i * 0.55; y += rise; rad = Math.min(78, rad + between(rnd, 0.8, 2.2));
      const shade = pick(rnd, ['#4c5a63', '#56646d', '#617079', '#6f7d85']);
      const op = Math.max(0.12, 0.62 - i * 0.011);
      puffs.push(`<circle cx="${r1(x + between(rnd, -6, 6))}" cy="${r1(y + between(rnd, -10, 10))}" r="${r1(rad * between(rnd, 0.7, 1.1))}" fill="${shade}" opacity="${op.toFixed(2)}"/>`);
      if (rnd() < 0.5) puffs.push(`<circle cx="${r1(x + between(rnd, -10, 10))}" cy="${r1(y - rad * 0.55)}" r="${r1(rad * 0.45)}" fill="#c9d0cf" opacity="${(op * 0.5).toFixed(2)}"/>`);
    }
  }
  const smoke = puffs.join('');

  write('babel-scene.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">
<!-- Babel look: an immense industrial tower of pipes, girders and lit
     windows, crowned with masts and trailing smoke, rising out of a city that
     runs to a hazy horizon beside a teal sea. Placed left of centre so it
     stands beside the app column rather than behind it.
     Generated by tools/skin-art.mjs. -->
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="${HORIZON}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#7fa3a6"/><stop offset=".38" stop-color="#b8c4ae"/><stop offset=".78" stop-color="#f1cf9f"/><stop offset="1" stop-color="#f7e2b6"/>
  </linearGradient>
  <radialGradient id="sun" cx="1180" cy="${HORIZON - 20}" r="520" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff4d8" stop-opacity=".9"/><stop offset="1" stop-color="#fff4d8" stop-opacity="0"/></radialGradient>
  <linearGradient id="seaG" x1="0" y1="${HORIZON}" x2="0" y2="${H}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8fd0c8"/><stop offset=".25" stop-color="#4fb3ad"/><stop offset="1" stop-color="#1c7a82"/></linearGradient>
  <linearGradient id="land" x1="0" y1="${HORIZON}" x2="0" y2="${H}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#c7b39b"/><stop offset="1" stop-color="#7d6556"/></linearGradient>
  <linearGradient id="haze" x1="0" y1="${HORIZON - 10}" x2="0" y2="${HORIZON + 170}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f4dcb5" stop-opacity=".95"/><stop offset="1" stop-color="#f4dcb5" stop-opacity="0"/></linearGradient>
  <linearGradient id="light" x1="${cx - 300}" y1="0" x2="${cx + 300}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#94826f"/><stop offset=".4" stop-color="#565050"/><stop offset="1" stop-color="#1f1c1e"/></linearGradient>
  <linearGradient id="shade" x1="${cx - 300}" y1="0" x2="${cx + 300}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f1cf9f" stop-opacity=".22"/><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#0f0d10" stop-opacity=".5"/></linearGradient>
  <linearGradient id="aerial" x1="0" y1="${top}" x2="0" y2="${base}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#d9c7a6" stop-opacity=".35"/><stop offset=".5" stop-color="#d9c7a6" stop-opacity=".08"/><stop offset="1" stop-color="#d9c7a6" stop-opacity=".2"/></linearGradient>
  <clipPath id="tower"><path d="${sil}"/></clipPath>
  <filter id="puff" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="7"/></filter>
  <filter id="soft" x="-30%" y="-100%" width="160%" height="300%"><feGaussianBlur stdDeviation="9"/></filter>
  <filter id="paint" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".55" numOctaves="2" seed="5"/><feColorMatrix values="0 0 0 0 .3  0 0 0 0 .25  0 0 0 0 .2  0 0 0 .14 0"/></filter>
</defs>
<rect width="${W}" height="${HORIZON + 2}" fill="url(#sky)"/>
<rect width="${W}" height="${HORIZON + 2}" fill="url(#sun)"/>
<g filter="url(#soft)" opacity=".7">
  <ellipse cx="300" cy="330" rx="150" ry="16" fill="#5f707a"/>
  <ellipse cx="1290" cy="300" rx="190" ry="22" fill="#6e7d86"/>
  <ellipse cx="900" cy="420" rx="120" ry="10" fill="#8a969c"/>
</g>
<path d="M0 ${HORIZON}H${W}V${H}H0Z" fill="url(#land)"/>
<path d="${sea}" fill="url(#seaG)"/>
${glints.render()}
${boats}
${city.render()}
<path d="M-20 935C120 900 230 860 330 820" stroke="#3aa6a4" stroke-width="26" fill="none"/>
<path d="M120 912A60 60 0 0 1 210 878" stroke="#3d3433" stroke-width="3" fill="none"/>
<rect y="${HORIZON - 10}" width="${W}" height="180" fill="url(#haze)"/>
<rect y="${HORIZON}" width="${W}" height="${H - HORIZON}" fill="#e9d2b0" opacity=".22"/>
<g filter="url(#puff)">${smoke}</g>
${spires.render()}
<g clip-path="url(#tower)">
  <rect x="${cx - 310}" y="${top - 10}" width="620" height="${base - top + 20}" fill="url(#light)"/>
  ${tw.render()}
  <rect x="${cx - 310}" y="${top - 10}" width="620" height="${base - top + 20}" fill="url(#shade)"/>
  <rect x="${cx - 310}" y="${top - 10}" width="620" height="${base - top + 20}" fill="url(#aerial)"/>
</g>
${jut.render()}
<rect width="${W}" height="${H}" filter="url(#paint)"/>
</svg>`);
}

function babelFrame() {
  // iron pipes with elbow joints at the corners and a bolted flange either
  // side of each elbow; a thin rusty pipe runs inside
  const pipe = (d) => `<path d="${d}" stroke="#2f2a29" stroke-width="7"/><path d="${d}" stroke="#6b625d" stroke-width="4.6"/><path d="${d}" stroke="#b7a698" stroke-width="1.2" transform="translate(-.9 -.9)"/>`;
  const thin = (d) => `<path d="${d}" stroke="#6e3a24" stroke-width="2.8"/><path d="${d}" stroke="#b56b45" stroke-width="1"/>`;
  const corner = `<g id="c">
    ${pipe('M32 7H22A15 15 0 0 0 7 22V32')}
    ${thin('M32 15H24A9 9 0 0 0 15 24V32')}
    <rect x="23" y="2" width="4" height="10" rx="1" fill="#4d4542" stroke="#221e1d" stroke-width=".7"/>
    <rect x="2" y="23" width="10" height="4" rx="1" fill="#4d4542" stroke="#221e1d" stroke-width=".7"/>
    <circle cx="25" cy="3.6" r=".9" fill="#c9b8a8"/><circle cx="25" cy="10.4" r=".9" fill="#c9b8a8"/>
    <circle cx="3.6" cy="25" r=".9" fill="#c9b8a8"/><circle cx="10.4" cy="25" r=".9" fill="#c9b8a8"/>
    <circle cx="13" cy="13" r="2.6" fill="#9a5a3a" opacity=".5"/>
  </g>`;
  write('babel-frame.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" fill="none">
<!-- Card frame for the Babel look, nine-sliced 32px: an iron pipe with
     elbow joints and bolted flanges, a thin rusty pipe inside it.
     Generated by tools/skin-art.mjs. -->
<defs>${corner}</defs>
${pipe('M32 7H64M32 89H64M7 32V64M89 32V64')}
${thin('M32 15H64M32 81H64M15 32V64M81 32V64')}
<use href="#c"/><use href="#c" transform="translate(96 0) scale(-1 1)"/>
<use href="#c" transform="translate(0 96) scale(1 -1)"/><use href="#c" transform="translate(96 96) scale(-1 -1)"/>
</svg>`);
}

// ---------------------------------------------------------------------------------
crescentScene(); crescentFrame(); crescentMoon();
byakkoStars(); byakkoRibbons(); byakkoFur(); byakkoSpots(); byakkoFlame(); byakkoSparkle();
babelScene(); babelFrame();
for (const [n, b] of Object.entries(written)) console.log(n.padEnd(22), (b / 1024).toFixed(1).padStart(7), 'KB');
