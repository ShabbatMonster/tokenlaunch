// PnL cards: a shareable 1200x675 image of a position or a closed trade.
// Pure canvas, no fonts or images to fetch (an uploaded background is drawn
// from the user's own file). The numbers come from Hyperliquid's own data;
// the card only chooses which of them to show.

export const CARD_W = 1200, CARD_H = 675;

export const CARD_STYLES = {
  midnight: 'Midnight',
  glow: 'Glow',
  grid: 'Terminal',
  paper: 'Paper',
  image: 'Your image',
};

export const CARD_DEFAULTS = {
  style: 'midnight',
  accent: 'auto',            // 'auto' = green in profit, red in loss; else a #hex
  showUsd: true,
  showPrices: true,
  showSize: false,
  showLev: true,
  brand: 'ShabbatLiquid',
  caption: '',
  handle: '',
  dim: 55,                   // % darkening over an uploaded image
  image: null,               // data: URL of the uploaded background
};

// --- the data on a card ---------------------------------------------------------

/// An open position (a clearinghouse assetPosition.position) as card data.
export function cardFromPosition(p, markPx) {
  const szi = Number(p.szi);
  return {
    kind: 'open', coin: p.coin, long: szi > 0, lev: p.leverage?.value ?? null,
    entry: Number(p.entryPx), exit: Number(markPx), size: Math.abs(szi),
    pnl: Number(p.unrealizedPnl), roe: Number(p.returnOnEquity) * 100, time: Date.now(),
  };
}

/// Fills grouped into closed trades: every fill of one order that closed (part
/// of) a position, with its volume-weighted exit, realised PnL and the entry
/// that PnL implies. Newest first.
export function closedTrades(fills) {
  const byOrder = new Map();
  for (const f of fills) {
    // realised PnL: a close, a flip ("Long > Short") or a liquidation
    if (!Number(f.closedPnl)) continue;
    const k = `${f.coin}|${f.oid}`;
    // a sell (side A) closes a long, a buy closes a short
    const g = byOrder.get(k) || { coin: f.coin, oid: f.oid, closesLong: f.side === 'A', sz: 0, notional: 0, pnl: 0, fee: 0, time: 0, liquidation: !!f.liquidation };
    // on a flip only the old position's size was closed; the rest opened the new one
    const closed = /&gt;|>/.test(f.dir || '') ? Math.min(Number(f.sz), Math.abs(Number(f.startPosition))) : Number(f.sz);
    g.sz += closed; g.notional += closed * Number(f.px); g.pnl += Number(f.closedPnl); g.fee += Number(f.fee || 0);
    g.time = Math.max(g.time, f.time);
    byOrder.set(k, g);
  }
  return [...byOrder.values()].map((g) => {
    const exit = g.notional / g.sz;
    const long = g.closesLong;
    // closedPnl = (exit - entry) * size for a long, (entry - exit) * size for a short
    const entry = long ? exit - g.pnl / g.sz : exit + g.pnl / g.sz;
    return { kind: 'closed', coin: g.coin, oid: g.oid, long, entry, exit, size: g.sz, pnl: g.pnl, fee: g.fee, time: g.time, liquidation: g.liquidation };
  }).sort((a, b) => b.time - a.time);
}

/// Return on the margin a closed trade used at `lev`x (Hyperliquid does not
/// keep the leverage a closed trade had, so the card asks for it).
export function closedRoe(t, lev) {
  const margin = (t.entry * t.size) / (lev || 1);
  return margin > 0 ? (t.pnl / margin) * 100 : 0;
}

// --- drawing ----------------------------------------------------------------------

const SANS = '"Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

const fmtPx = (n) => {
  const a = Math.abs(n);
  const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return n.toLocaleString('en-US', { maximumFractionDigits: d });
};
const fmtUsd = (n) => (n < 0 ? '-' : '+') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n < 0 ? '' : '+') + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/// Draw `t` (card data with `roe` set) onto a CARD_W x CARD_H context.
/// `img` is a loaded HTMLImageElement / ImageBitmap for the 'image' style.
export function drawPnlCard(g, t, o = CARD_DEFAULTS, img = null) {
  const W = CARD_W, H = CARD_H;
  const up = t.pnl >= 0;
  const light = o.style === 'paper';
  // on the light background the auto colours are darkened to stay readable
  const accent = o.accent && o.accent !== 'auto' ? o.accent : (up ? (light ? '#16a34a' : '#4ade80') : (light ? '#dc2626' : '#f87171'));
  const ink = light ? '#0f1115' : '#f4f6f8';
  const dimInk = light ? 'rgba(15,17,21,.55)' : 'rgba(244,246,248,.55)';
  g.save();
  g.clearRect(0, 0, W, H);

  // background
  if (o.style === 'image' && img) {
    const s = Math.max(W / img.width, H / img.height);
    const w = img.width * s, h = img.height * s;
    g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    g.fillStyle = `rgba(5,6,8,${(o.dim ?? 55) / 100})`; g.fillRect(0, 0, W, H);
    const fade = g.createLinearGradient(0, 0, W * 0.75, 0);
    fade.addColorStop(0, 'rgba(5,6,8,.55)'); fade.addColorStop(1, 'rgba(5,6,8,0)');
    g.fillStyle = fade; g.fillRect(0, 0, W, H);
  } else if (light) {
    g.fillStyle = '#f3f1ec'; g.fillRect(0, 0, W, H);
    const r = g.createRadialGradient(W * 0.85, H * 0.2, 0, W * 0.85, H * 0.2, W * 0.6);
    r.addColorStop(0, hexA(accent, 0.22)); r.addColorStop(1, hexA(accent, 0));
    g.fillStyle = r; g.fillRect(0, 0, W, H);
  } else {
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0d1014'); bg.addColorStop(1, '#06070a');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    if (o.style === 'glow') {
      for (const [x, y, r, a] of [[W * 0.82, H * 0.35, 520, 0.38], [W * 0.15, H * 1.05, 420, 0.16]]) {
        const rg = g.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, hexA(accent, a)); rg.addColorStop(1, hexA(accent, 0));
        g.fillStyle = rg; g.fillRect(0, 0, W, H);
      }
    } else if (o.style === 'grid') {
      g.strokeStyle = 'rgba(255,255,255,.045)'; g.lineWidth = 1;
      for (let x = 0; x <= W; x += 40) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
      for (let y = 0; y <= H; y += 40) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
      const rg = g.createRadialGradient(W * 0.8, H * 0.4, 0, W * 0.8, H * 0.4, 460);
      rg.addColorStop(0, hexA(accent, 0.2)); rg.addColorStop(1, hexA(accent, 0));
      g.fillStyle = rg; g.fillRect(0, 0, W, H);
    } else {
      const rg = g.createRadialGradient(W, 0, 0, W, 0, W * 0.75);
      rg.addColorStop(0, hexA(accent, 0.16)); rg.addColorStop(1, hexA(accent, 0));
      g.fillStyle = rg; g.fillRect(0, 0, W, H);
    }
    // a faint rising / falling line behind the numbers
    g.strokeStyle = hexA(accent, 0.22); g.lineWidth = 4; g.lineJoin = 'round';
    g.beginPath();
    const pts = 14;
    for (let i = 0; i <= pts; i++) {
      const x = W * 0.45 + (W * 0.55) * (i / pts);
      const trend = up ? 1 - i / pts : i / pts;
      const wob = Math.sin(i * 1.7 + (t.coin.length || 1)) * 0.07;
      const y = H * (0.18 + 0.55 * Math.min(1, Math.max(0, trend + wob)));
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  // accent bar on the left edge
  g.fillStyle = accent; g.fillRect(0, 0, 8, H);

  const L = 72;
  // header: brand · date
  g.textBaseline = 'alphabetic';
  g.fillStyle = dimInk; g.font = `600 22px ${MONO}`;
  g.fillText((o.brand || '').toUpperCase().split('').join(' '), L, 78);
  g.textAlign = 'right';
  g.fillText(new Date(t.time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }), W - 64, 78);
  g.textAlign = 'left';

  // market + side badge
  const market = (t.coin.includes(':') ? t.coin.split(':')[1] : t.coin) + '-PERP';
  g.fillStyle = ink; g.font = `700 58px ${SANS}`;
  g.fillText(market, L, 176);
  const mw = g.measureText(market).width;
  const badge = (t.long ? 'LONG' : 'SHORT') + (o.showLev && t.lev ? ` ${t.lev}×` : '') + (t.liquidation ? ' · LIQUIDATED' : '');
  g.font = `700 24px ${SANS}`;
  const bw = g.measureText(badge).width + 32;
  const bx = L + mw + 24, by = 140;
  g.fillStyle = hexA(t.long ? '#4ade80' : '#f87171', light ? 0.18 : 0.16);
  roundRect(g, bx, by, bw, 46, 10); g.fill();
  g.fillStyle = t.long ? (light ? '#15803d' : '#4ade80') : (light ? '#b91c1c' : '#f87171');
  g.fillText(badge, bx + 16, by + 32);
  if (t.coin.includes(':')) {
    g.fillStyle = dimInk; g.font = `500 22px ${MONO}`;
    g.fillText(t.coin.split(':')[0] + ' · HIP-3', L, 214);
  }

  // the number
  g.fillStyle = accent; g.font = `800 150px ${SANS}`;
  g.shadowColor = hexA(accent, light ? 0 : 0.35); g.shadowBlur = 40;
  g.fillText(fmtPct(t.roe), L - 6, 380);
  g.shadowBlur = 0;
  let y = 380;
  if (o.showUsd) {
    g.fillStyle = ink; g.font = `600 46px ${SANS}`;
    g.fillText(fmtUsd(t.pnl), L, y + 66);
    y += 66;
  }
  g.fillStyle = dimInk; g.font = `500 20px ${MONO}`;
  g.fillText(t.kind === 'open' ? 'UNREALIZED · ROE' : 'REALIZED · ROE', L, y + 40);

  // stats row
  const stats = [];
  if (o.showPrices) stats.push(['ENTRY', fmtPx(t.entry)], [t.kind === 'open' ? 'MARK' : 'EXIT', fmtPx(t.exit)]);
  if (o.showSize) stats.push(['SIZE', t.size.toLocaleString('en-US', { maximumFractionDigits: 4 })]);
  let sx = L;
  for (const [k, v] of stats) {
    g.fillStyle = dimInk; g.font = `600 18px ${MONO}`; g.fillText(k, sx, H - 104);
    g.fillStyle = ink; g.font = `600 34px ${SANS}`; g.fillText(v, sx, H - 64);
    sx += Math.max(220, g.measureText(v).width + 70);
  }

  // caption / handle
  g.textAlign = 'right';
  if (o.handle) { g.fillStyle = ink; g.font = `600 28px ${SANS}`; g.fillText(o.handle, W - 64, H - 64); }
  if (o.caption) {
    g.fillStyle = dimInk; g.font = `500 24px ${SANS}`;
    wrap(g, o.caption, W - 64, o.handle ? H - 110 : H - 64, 460, 30);
  }
  g.restore();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// right-aligned text, wrapped upward from `y` so the last line sits on it
function wrap(g, text, x, y, maxW, lh) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const tryL = line ? line + ' ' + w : w;
    if (g.measureText(tryL).width > maxW && line) { lines.push(line); line = w; } else line = tryL;
  }
  if (line) lines.push(line);
  lines.slice(-3).reverse().forEach((l, i) => g.fillText(l, x, y - i * lh));
}
