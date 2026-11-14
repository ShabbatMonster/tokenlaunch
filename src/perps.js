// Perps page: trade every Hyperliquid perp (main exchange + every HIP-3
// exchange) from the EVM key the launcher already keeps in this browser
// (keys.v1). Prices, the book, positions and orders stream over one
// WebSocket; orders are signed locally by @nktkas/hyperliquid. See
// src/hyperliquid.js for the market list and the order maths.
import { privateKeyToAccount } from 'viem/accounts';
import {
  hlClients, hlMarkets, applyCtxs, sizeForUsd, buildOrders, closeOrder, orderOutcome, hlError, formatSize,
} from './hyperliquid.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// --- formatting ----------------------------------------------------------------
const px = (n) => {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
};
const usd = (n, d = 2) => (n == null || !isFinite(n) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const big = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0));
const pct = (n, d = 2) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

// --- state ---------------------------------------------------------------------
let wallet = null;
let C = hlClients();                          // info + subs; exchange once signed in
let markets = [];
let byCoin = new Map();
let sel = null;                               // selected market
let side = 'long';
let otype = 'market';
let cross = true;
let dexFilter = store.get('perps.dex', 'all');
let favs = new Set(store.get('perps.favs', []));
let interval = store.get('perps.ival', '15m');
let candles = [];
const userStates = new Map();                 // dex -> clearinghouse state
const userOrders = new Map();                 // dex -> open orders
let spot = null;                              // spot balances
let abstraction = null;
let assetData = null;                         // activeAssetData for sel
let bookSub = null, candleSub = null, userSubs = [];
let tab = 'pos';

// --- sign in -------------------------------------------------------------------
function loadWallet() {
  const k = store.get('keys.v1', null);
  if (!k?.evm) return false;
  try { wallet = privateKeyToAccount(k.evm.startsWith('0x') ? k.evm : '0x' + k.evm); } catch { return false; }
  C = { ...C, ...hlClients({ wallet, ws: false }), subs: C.subs };
  $('aWallet').textContent = wallet.address.slice(0, 6) + '…' + wallet.address.slice(-4);
  $('aWallet').title = wallet.address;
  return true;
}
function showKeyModal() { $('keyModal').classList.remove('hidden'); $('keyIn').focus(); }
$('keySave').onclick = () => {
  const raw = $('keyIn').value.trim();
  const hex = raw.startsWith('0x') ? raw : '0x' + raw;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) { $('keyErr').textContent = 'that is not a 32-byte hex private key'; return; }
  const k = store.get('keys.v1', {}) || {};
  k.evm = hex;
  store.set('keys.v1', k);
  $('keyIn').value = '';
  $('keyModal').classList.add('hidden');
  if (loadWallet()) startUser();
};
$('keySkip').onclick = (e) => { e.preventDefault(); $('keyModal').classList.add('hidden'); };
$('aWallet').onclick = () => { if (!wallet) showKeyModal(); };

// --- markets -------------------------------------------------------------------
function dexTabs() {
  const names = [['all', 'All'], ['fav', '★'], ...[...new Map(markets.map((m) => [m.dex, m.dex ? m.dex : 'crypto'])).entries()]];
  $('dexTabs').innerHTML = names.map(([v, l]) => `<button data-v="${esc(v)}" class="${dexFilter === v ? 'on' : ''}" title="${esc(markets.find((m) => m.dex === v)?.dexName || '')}">${esc(l)}</button>`).join('');
}
$('dexTabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  dexFilter = b.dataset.v; store.set('perps.dex', dexFilter); dexTabs(); renderList();
};

function renderList() {
  const q = $('mSearch').value.trim().toLowerCase();
  const favOnly = $('mFav').checked || dexFilter === 'fav';
  const rows = markets.filter((m) => !m.delisted
    && (dexFilter === 'all' || dexFilter === 'fav' || m.dex === dexFilter)
    && (!favOnly || favs.has(m.coin))
    && (!q || m.coin.toLowerCase().includes(q) || m.dexName.toLowerCase().includes(q)));
  $('mList').innerHTML = rows.length ? rows.slice(0, 400).map((m) => `
    <div class="mrow ${sel?.coin === m.coin ? 'on' : ''}" data-c="${esc(m.coin)}">
      <div class="nm"><span data-fav="${esc(m.coin)}" style="color:${favs.has(m.coin) ? '#facc15' : 'var(--faint)'}">★</span> ${esc(m.label)}<small>${m.dex ? esc(m.dex) : ''}</small><span class="lev">${m.maxLeverage}×</span></div>
      <div class="px">${px(m.mid)}</div>
      <div class="ch ${cls(m.change)}">${pct(m.change)}</div>
    </div>`).join('') : '<div class="empty">no market matches</div>';
}
$('mSearch').oninput = renderList;
$('mFav').onchange = renderList;
$('mList').onclick = (e) => {
  const f = e.target.closest('[data-fav]');
  if (f) {
    const c = f.dataset.fav;
    favs.has(c) ? favs.delete(c) : favs.add(c);
    store.set('perps.favs', [...favs]); renderList(); return;
  }
  const r = e.target.closest('.mrow'); if (r) select(r.dataset.c);
};

function renderTicker() {
  const m = sel; if (!m) return;
  $('tDex').textContent = `${m.dexName}${m.dex ? ' · HIP-3' : ''} · margin ${m.collateral}${m.onlyIsolated ? ' · isolated only' : ''}`;
  $('tCoin').textContent = m.label + '-PERP';
  $('tPx').textContent = px(m.mid);
  $('tPx').className = 'big ' + cls(m.change);
  $('tCh').innerHTML = `<span class="${cls(m.change)}">${pct(m.change)}</span>`;
  $('tOracle').textContent = px(m.oracle ?? m.mark);
  $('tFund').innerHTML = `<span class="${cls(m.funding)}">${(m.funding * 100).toFixed(4)}%</span>`;
  $('tOi').textContent = '$' + big(m.oi * m.mark);
  $('tVol').textContent = '$' + big(m.volume);
  $('tLev').textContent = m.maxLeverage + '×';
  document.title = `${px(m.mid)} ${m.label} · perps`;
}

async function select(coin) {
  const m = byCoin.get(coin); if (!m) return;
  sel = m;
  store.set('perps.sel', coin);
  history.replaceState(null, '', '#' + encodeURIComponent(coin));
  renderList(); renderTicker();
  const lev = $('lev');
  lev.max = m.maxLeverage;
  if (+lev.value > m.maxLeverage) lev.value = m.maxLeverage;
  if (m.onlyIsolated) cross = false;
  paintLev();
  if (otype === 'limit' && !$('limitPx').value) $('limitPx').value = m.mid;
  await Promise.all([loadCandles(), subBook(), loadAssetData()]);
  paintSummary();
}

// --- chart ---------------------------------------------------------------------
const IVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const IVAL_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
$('ivals').innerHTML = IVALS.map((i) => `<button data-i="${i}" class="${i === interval ? 'on' : ''}">${i}</button>`).join('');
$('ivals').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  interval = b.dataset.i; store.set('perps.ival', interval);
  for (const x of $('ivals').children) x.classList.toggle('on', x.dataset.i === interval);
  loadCandles();
};
async function loadCandles() {
  const m = sel; if (!m) return;
  const end = Date.now();
  try {
    const cs = await C.info.candleSnapshot({ coin: m.coin, interval, startTime: end - IVAL_MS[interval] * 150, endTime: end });
    if (sel !== m) return;
    candles = cs.map((c) => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v }));
  } catch { candles = []; }
  drawChart();
  try { await candleSub?.unsubscribe(); } catch { /* gone */ }
  candleSub = await C.subs.candle({ coin: m.coin, interval }, (c) => {
    if (sel !== m) return;
    const k = { t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v };
    const last = candles[candles.length - 1];
    if (last && last.t === k.t) candles[candles.length - 1] = k; else if (!last || k.t > last.t) { candles.push(k); if (candles.length > 300) candles.shift(); }
    drawChart();
  }).catch(() => null);
}
function drawChart() {
  const cv = $('chart'); const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const up = css.getPropertyValue('--long').trim(), dn = css.getPropertyValue('--short').trim();
  if (!candles.length) { g.fillStyle = '#5b6370'; g.font = '12px monospace'; g.fillText('no candles', 12, 20); return; }
  const axis = 64, volH = 46, top = 8, bottom = H - volH - 18;
  const n = Math.min(candles.length, Math.max(20, Math.floor((W - axis) / 7)));
  const cs = candles.slice(-n);
  let hi = Math.max(...cs.map((c) => c.h)), lo = Math.min(...cs.map((c) => c.l));
  const pad = (hi - lo) * 0.06 || hi * 0.01; hi += pad; lo -= pad;
  const y = (p) => top + (hi - p) / (hi - lo) * (bottom - top);
  const cw = (W - axis) / n;
  // grid + price axis
  g.strokeStyle = '#1c2027'; g.fillStyle = '#5b6370'; g.font = '10px monospace'; g.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const p = lo + (hi - lo) * i / 5, yy = Math.round(y(p)) + 0.5;
    g.beginPath(); g.moveTo(0, yy); g.lineTo(W - axis, yy); g.stroke();
    g.fillText(px(p), W - axis + 6, yy + 3);
  }
  const vmax = Math.max(...cs.map((c) => c.v)) || 1;
  cs.forEach((c, i) => {
    const x = i * cw + cw / 2, col = c.c >= c.o ? up : dn;
    g.strokeStyle = col; g.fillStyle = col;
    g.beginPath(); g.moveTo(Math.round(x) + 0.5, y(c.h)); g.lineTo(Math.round(x) + 0.5, y(c.l)); g.stroke();
    const bh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
    g.fillRect(x - Math.max(1, cw * 0.35), Math.min(y(c.o), y(c.c)), Math.max(2, cw * 0.7), bh);
    g.globalAlpha = 0.25; const vh = c.v / vmax * volH;
    g.fillRect(x - Math.max(1, cw * 0.35), H - 18 - vh, Math.max(2, cw * 0.7), vh); g.globalAlpha = 1;
  });
  // last price line
  const last = cs[cs.length - 1], ly = Math.round(y(last.c)) + 0.5, lc = last.c >= last.o ? up : dn;
  g.setLineDash([3, 3]); g.strokeStyle = lc; g.beginPath(); g.moveTo(0, ly); g.lineTo(W - axis, ly); g.stroke(); g.setLineDash([]);
  g.fillStyle = lc; g.fillRect(W - axis, ly - 8, axis, 16); g.fillStyle = '#0b0d10'; g.fillText(px(last.c), W - axis + 6, ly + 3);
  // entry line of an open position
  const pos = positionFor(sel?.coin);
  if (pos && +pos.entryPx >= lo && +pos.entryPx <= hi) {
    const ey = Math.round(y(+pos.entryPx)) + 0.5;
    g.strokeStyle = '#a5b4fc'; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(0, ey); g.lineTo(W - axis, ey); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#a5b4fc'; g.fillText(`entry ${+pos.szi > 0 ? 'long' : 'short'}`, 6, ey - 4);
  }
  // time labels
  g.fillStyle = '#5b6370';
  for (let i = 0; i < cs.length; i += Math.ceil(cs.length / 6)) {
    const d = new Date(cs[i].t);
    const s = interval === '1d' ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    g.fillText(s, i * cw, H - 4);
  }
}
window.addEventListener('resize', () => drawChart());

// --- order book ----------------------------------------------------------------
async function subBook() {
  const m = sel;
  try { await bookSub?.unsubscribe(); } catch { /* gone */ }
  $('bookAsks').innerHTML = $('bookBids').innerHTML = '';
  bookSub = await C.subs.l2Book({ coin: m.coin }, (b) => { if (sel === m) drawBook(b.levels); }).catch(() => null);
}
function drawBook([bids, asks]) {
  const N = 9;
  const a = asks.slice(0, N).reverse(), b = bids.slice(0, N);
  const max = Math.max(...[...a, ...b].map((l) => +l.sz * +l.px), 1);
  const row = (l, col) => `<div class="row"><i style="width:${(+l.sz * +l.px / max * 100).toFixed(1)}%;background:${col}"></i><span style="color:${col}">${px(+l.px)}</span><span>${(+l.sz).toLocaleString('en-US', { maximumFractionDigits: 4 })}</span></div>`;
  $('bookAsks').innerHTML = a.map((l) => row(l, 'var(--short)')).join('');
  $('bookBids').innerHTML = b.map((l) => row(l, 'var(--long)')).join('');
  if (bids[0] && asks[0]) {
    const sp = +asks[0].px - +bids[0].px;
    $('bookSpread').textContent = `spread ${px(sp)} (${(sp / +asks[0].px * 100).toFixed(3)}%)`;
  }
}
$('bookAsks').onclick = $('bookBids').onclick = (e) => {
  const r = e.target.closest('.row'); if (!r) return;
  setType('limit'); $('limitPx').value = r.children[1].textContent.replace(/,/g, ''); paintSummary();
};

// --- account -------------------------------------------------------------------
function positionFor(coin) {
  for (const st of userStates.values()) for (const p of st.assetPositions || []) if (p.position.coin === coin && +p.position.szi) return p.position;
  return null;
}
async function startUser() {
  for (const s of userSubs) { try { await s.unsubscribe(); } catch { /* gone */ } }
  userSubs = [];
  const user = wallet.address;
  const sub = async (p) => { const s = await p.catch(() => null); if (s) userSubs.push(s); };
  await sub(C.subs.allDexsClearinghouseState({ user }, (ev) => {
    for (const [dex, st] of ev.clearinghouseStates) userStates.set(dex, st);
    paintAccount();
  }));
  for (const dex of new Set(markets.map((m) => m.dex))) {
    await sub(C.subs.openOrders({ user, ...(dex ? { dex } : {}) }, (ev) => { userOrders.set(ev.dex ?? dex, ev.orders); paintAccount(); }));
  }
  await sub(C.subs.spotState({ user }, (ev) => { spot = ev.spotState ?? ev; paintAccount(); }));
  abstraction = await C.info.userAbstraction({ user }).catch(() => null);
  loadAssetData();
  paintUnify();
}
async function loadAssetData() {
  if (!wallet || !sel) return;
  const m = sel;
  assetData = await C.info.activeAssetData({ user: wallet.address, coin: m.coin }).catch(() => null);
  if (sel !== m || !assetData) return;
  $('lev').value = Math.min(assetData.leverage.value, m.maxLeverage);
  cross = assetData.leverage.type === 'cross' && !m.onlyIsolated;
  paintLev(); paintSummary();
}
function paintAccount() {
  let eq = 0, pnl = 0, free = 0;
  for (const st of userStates.values()) {
    eq += +st.marginSummary.accountValue;
    free += +st.withdrawable;
    for (const p of st.assetPositions || []) pnl += +p.position.unrealizedPnl;
  }
  const stable = (spot?.balances || []).filter((b) => /^USD/.test(b.coin)).reduce((a, b) => a + (+b.total - +b.hold), 0);
  $('aEquity').textContent = usd(eq);
  $('aFree').textContent = usd(free) + (stable > 0.01 ? ` · spot ${usd(stable)}` : '');
  $('aPnl').innerHTML = `<span class="${cls(pnl)}">${usd(pnl)}</span>`;
  const positions = [...userStates.entries()].flatMap(([dex, st]) => (st.assetPositions || []).filter((p) => +p.position.szi).map((p) => ({ dex, ...p.position })));
  const orders = [...userOrders.values()].flat();
  $('nPos').textContent = positions.length ? `(${positions.length})` : '';
  $('nOrd').textContent = orders.length ? `(${orders.length})` : '';
  renderBottom(positions, orders);
  if (sel) drawChart();
}
function renderBottom(positions, orders) {
  const body = $('bBody');
  if (!wallet) { body.innerHTML = '<div class="empty"><a href="#" id="signLink">sign in</a> to see positions</div>'; $('signLink').onclick = (e) => { e.preventDefault(); showKeyModal(); }; return; }
  if (tab === 'pos') {
    body.innerHTML = positions.length ? `<table class="table"><tr><th>MARKET</th><th>SIZE</th><th>VALUE</th><th>ENTRY</th><th>MARK</th><th>PNL (ROE)</th><th>LIQ.</th><th>MARGIN</th><th></th></tr>${positions.map((p) => {
      const m = byCoin.get(p.coin); const long = +p.szi > 0;
      return `<tr><td><a href="#" data-sel="${esc(p.coin)}" style="color:var(--text)">${esc(p.coin)}</a> <span class="${long ? 'up' : 'down'}">${long ? 'LONG' : 'SHORT'} ${p.leverage.value}×</span></td>
        <td>${Math.abs(+p.szi)}</td><td>${usd(+p.positionValue)}</td><td>${px(+p.entryPx)}</td><td>${px(m?.mark)}</td>
        <td class="${cls(+p.unrealizedPnl)}">${usd(+p.unrealizedPnl)} (${pct(+p.returnOnEquity * 100, 1)})</td>
        <td>${p.liquidationPx ? px(+p.liquidationPx) : '—'}</td><td>${usd(+p.marginUsed)} ${p.leverage.type === 'cross' ? 'cross' : 'iso'}</td>
        <td class="x"><button class="tbtn" data-close="${esc(p.coin)}">CLOSE</button></td></tr>`;
    }).join('')}</table>` : '<div class="empty">no open positions</div>';
  } else if (tab === 'ord') {
    body.innerHTML = orders.length ? `<table class="table"><tr><th>MARKET</th><th>TYPE</th><th>SIDE</th><th>SIZE</th><th>PRICE</th><th>TRIGGER</th><th></th></tr>${orders.map((o) => `<tr>
        <td>${esc(o.coin)}</td><td>${esc(o.orderType || 'Limit')}${o.reduceOnly ? ' · reduce' : ''}</td>
        <td class="${o.side === 'B' ? 'up' : 'down'}">${o.side === 'B' ? 'BUY' : 'SELL'}</td><td>${esc(o.sz)}</td><td>${px(+o.limitPx)}</td>
        <td>${o.isTrigger ? esc(o.triggerCondition || px(+o.triggerPx)) : '—'}</td>
        <td class="x"><button class="tbtn" data-cancel="${esc(o.coin)}|${o.oid}">CANCEL</button></td></tr>`).join('')}</table>` : '<div class="empty">no open orders</div>';
  } else {
    const rows = [...userStates.entries()].filter(([, st]) => +st.marginSummary.accountValue).map(([dex, st]) => [`perps · ${dex || 'Hyperliquid'}`, +st.marginSummary.accountValue, +st.withdrawable]);
    const sp = (spot?.balances || []).filter((b) => +b.total).map((b) => [`spot · ${b.coin}`, +b.total, +b.total - +b.hold]);
    body.innerHTML = rows.length + sp.length ? `<table class="table"><tr><th>ACCOUNT</th><th>TOTAL</th><th>AVAILABLE</th></tr>${[...rows, ...sp].map(([a, t, f]) => `<tr><td>${esc(a)}</td><td>${t.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td><td>${f.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td></tr>`).join('')}</table>
      <div class="empty">mode: <b>${esc(abstraction || '—')}</b>. Deposit at app.hyperliquid.xyz (USDC from Arbitrum) to fund this wallet.</div>`
      : '<div class="empty">this wallet has nothing on Hyperliquid yet. Deposit USDC at app.hyperliquid.xyz, then come back.</div>';
  }
}
$('bTabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  tab = b.dataset.t; for (const x of $('bTabs').children) x.classList.toggle('on', x === b); paintAccount();
};
$('bBody').onclick = async (e) => {
  const s = e.target.closest('[data-sel]'); if (s) { e.preventDefault(); select(s.dataset.sel); return; }
  const c = e.target.closest('[data-close]');
  if (c) {
    const pos = positionFor(c.dataset.close); const m = byCoin.get(c.dataset.close);
    if (!pos || !m) return;
    c.disabled = true;
    await send(() => C.exchange.order(closeOrder(m, pos.szi, slip())), `closing ${m.coin}`);
    c.disabled = false; return;
  }
  const x = e.target.closest('[data-cancel]');
  if (x) {
    const [coin, oid] = x.dataset.cancel.split('|'); const m = byCoin.get(coin);
    if (!m) return;
    x.disabled = true;
    await send(() => C.exchange.cancel({ cancels: [{ a: m.asset, o: +oid }] }), 'cancelling');
  }
};

// unified account: every exchange margins from one balance
function paintUnify() {
  const el = $('unifyNote');
  const show = wallet && sel?.dex && abstraction && abstraction !== 'unifiedAccount' && abstraction !== 'portfolioMargin';
  el.style.display = show ? '' : 'none';
  if (!show) return;
  el.innerHTML = `<b>${esc(sel.dexName)}</b> is a HIP-3 exchange with its own margin. Turn on Hyperliquid's <b>unified account</b> and every exchange trades from one balance, the way app.hyperliquid.xyz does it (one signature, can be turned off there).<br><button class="tbtn" id="unifyBtn">TURN ON UNIFIED ACCOUNT</button>`;
  $('unifyBtn').onclick = async () => {
    const ok = await send(() => C.exchange.userSetAbstraction({ user: wallet.address, abstraction: 'unifiedAccount' }), 'switching to a unified account');
    if (ok) { abstraction = 'unifiedAccount'; paintUnify(); }
  };
}

// --- ticket --------------------------------------------------------------------
const slip = () => Math.min(50, Math.max(0.05, +$('slip').value || 1));
function setSide(s) {
  side = s;
  $('sLong').classList.toggle('on', s === 'long'); $('sShort').classList.toggle('on', s === 'short');
  $('goBtn').classList.toggle('short', s === 'short');
  paintSummary();
}
$('sLong').onclick = () => setSide('long');
$('sShort').onclick = () => setSide('short');
function setType(t) {
  otype = t;
  for (const b of $('oType').children) b.classList.toggle('on', b.dataset.v === t);
  $('limitWrap').style.display = t === 'limit' ? '' : 'none';
  if (t === 'limit' && !$('limitPx').value && sel) $('limitPx').value = sel.mid;
  paintSummary();
}
$('oType').onclick = (e) => { const b = e.target.closest('button'); if (b) setType(b.dataset.v); };
$('useMid').onclick = (e) => { e.preventDefault(); if (sel) { $('limitPx').value = sel.mid; paintSummary(); } };
function paintLev() {
  $('levVal').textContent = $('lev').value;
  $('marginMode').textContent = cross ? 'cross' : 'isolated';
}
$('lev').oninput = () => { paintLev(); paintSummary(); };
$('marginMode').onclick = (e) => {
  e.preventDefault();
  if (sel?.onlyIsolated) { cross = false; } else cross = !cross;
  paintLev(); paintSummary();
};
$('tpslOn').onchange = () => { $('tpslWrap').style.display = $('tpslOn').checked ? '' : 'none'; paintSummary(); };
for (const id of ['size', 'limitPx', 'tp', 'sl', 'slip']) $(id).addEventListener('input', paintSummary);
$('sizeUnit').onchange = paintSummary;
$('reduce').onchange = paintSummary;
document.querySelector('.pcts').onclick = (e) => {
  const b = e.target.closest('button'); if (!b || !sel) return;
  if (!assetData) { $('msg').innerHTML = '<span class="err">sign in to size from your balance</span>'; return; }
  const maxCoins = +assetData.maxTradeSzs[side === 'long' ? 0 : 1];
  const coins = maxCoins * (+b.dataset.p) / 100;
  const price = refPx();
  $('size').value = $('sizeUnit').value === 'usd' ? (coins * price * 0.995).toFixed(2) : formatSize(String(coins * 0.995), sel.szDecimals);
  paintSummary();
};
const refPx = () => (otype === 'limit' && +$('limitPx').value > 0 ? +$('limitPx').value : sel?.mid);

function ticketSize() {
  const v = +$('size').value;
  if (!(v > 0)) throw new Error('enter a size');
  return $('sizeUnit').value === 'usd' ? sizeForUsd(v, refPx(), sel.szDecimals) : v;
}
function paintSummary() {
  const go = $('goBtn');
  const label = (side === 'long' ? 'LONG ' : 'SHORT ') + (sel?.label || '');
  go.textContent = wallet ? label : 'SIGN IN TO TRADE';
  const el = $('summary');
  if (!sel) { el.innerHTML = ''; return; }
  const lev = +$('lev').value;
  let s = 0; try { s = ticketSize(); } catch { /* blank */ }
  const notional = s * refPx();
  const liqDist = 1 / lev;                 // rough: ignores maintenance margin
  const liq = side === 'long' ? refPx() * (1 - liqDist * 0.9) : refPx() * (1 + liqDist * 0.9);
  $('sizeHint').textContent = s ? `${s} ${sel.label}` : `min lot ${1 / 10 ** sel.szDecimals}`;
  el.innerHTML = `
    <div>order value <b>${usd(notional)}</b></div>
    <div>margin required <b>${usd(notional / lev)}</b></div>
    <div>${otype === 'market' ? `fills up to <b>${px(sel.mid * (side === 'long' ? 1 + slip() / 100 : 1 - slip() / 100))}</b>` : `rests at <b>${px(refPx())}</b>`}</div>
    <div>est. liquidation <b>~${px(liq)}</b></div>
    ${assetData ? `<div>max this side <b>${(+assetData.maxTradeSzs[side === 'long' ? 0 : 1]).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${esc(sel.label)}</b></div>` : ''}`;
  paintUnify();
}

async function send(fn, what) {
  const msg = $('msg');
  msg.innerHTML = `<span class="dim">${esc(what)}…</span>`;
  try {
    const res = await fn();
    const out = orderOutcome(res);
    msg.innerHTML = out.length ? out.map((o) => `<div class="${o.ok ? 'up' : 'err'}">${esc(o.text)}</div>`).join('') : '<span class="up">done</span>';
    setTimeout(loadAssetData, 600);
    return out.every((o) => o.ok);
  } catch (e) {
    msg.innerHTML = `<span class="err">${esc(hlError(e))}</span>`;
    return false;
  }
}

$('goBtn').onclick = async () => {
  if (!wallet) { showKeyModal(); return; }
  if (!sel) return;
  const go = $('goBtn');
  let req;
  try {
    req = buildOrders({
      market: sel, isBuy: side === 'long', size: ticketSize(), type: otype, limitPx: +$('limitPx').value,
      slippagePct: slip(), reduceOnly: $('reduce').checked,
      tp: $('tpslOn').checked ? $('tp').value : null, sl: $('tpslOn').checked ? $('sl').value : null,
    });
  } catch (e) { $('msg').innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }
  go.disabled = true;
  try {
    // leverage is a per-market account setting; change it only when it differs
    const lev = +$('lev').value;
    const cur = assetData?.leverage;
    if (!cur || cur.value !== lev || (cur.type === 'cross') !== cross) {
      const ok = await send(() => C.exchange.updateLeverage({ asset: sel.asset, isCross: cross, leverage: lev }), `setting ${lev}× ${cross ? 'cross' : 'isolated'}`);
      if (!ok) return;
    }
    await send(() => C.exchange.order(req), `${side === 'long' ? 'buying' : 'selling'} ${sel.label}`);
  } finally { go.disabled = false; }
};

// --- boot ----------------------------------------------------------------------
(async () => {
  try {
    markets = await hlMarkets(C.info);
  } catch (e) {
    $('mList').innerHTML = `<div class="empty err">could not reach Hyperliquid: ${esc(e.message)}</div>`;
    return;
  }
  byCoin = new Map(markets.map((m) => [m.coin, m]));
  dexTabs(); renderList();
  const want = decodeURIComponent(location.hash.slice(1)) || store.get('perps.sel', 'BTC');
  await select(byCoin.has(want) ? want : 'BTC');
  let pending = false, listDrawn = 0;
  C.subs.allDexsAssetCtxs((ev) => {
    applyCtxs(markets, ev);
    for (const [dex, ctxs] of ev.ctxs) for (const m of markets) if (m.dex === dex) { const c = ctxs[m.asset - (m.dexIndex ? 100000 + m.dexIndex * 10000 : 0)]; if (c) m.oracle = +c.oraclePx; }
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false; renderTicker(); paintSummary();
      // the list is ~350 rows: redraw it at most every 2s, and not under the pointer
      if (Date.now() - listDrawn > 2000 && !$('mList').matches(':active')) { listDrawn = Date.now(); renderList(); }
    });
  }).catch(() => { /* list stays as loaded */ });
  if (loadWallet()) startUser(); else { paintAccount(); paintSummary(); }
})();
