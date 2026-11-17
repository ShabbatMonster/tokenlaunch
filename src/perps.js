// Perps page: trade every Hyperliquid perp (main exchange + every HIP-3
// exchange) from the EVM key the launcher already keeps in this browser
// (keys.v1). Prices, the book, positions and orders stream over one
// WebSocket; orders are signed locally by @nktkas/hyperliquid. See
// src/hyperliquid.js for the market list and the order maths.
import { privateKeyToAccount } from 'viem/accounts';
import {
  hlClients, hlMarkets, applyCtxs, sizeForUsd, buildOrders, orderOutcome, hlError, formatSize, formatPrice,
  mergeBook, partialCloseOrder, positionTpslOrders, positionPnl,
} from './hyperliquid.js';
import {
  CARD_DEFAULTS, CARD_STYLES, drawPnlCard, cardFromPosition, closedTrades, closedRoe,
} from './pnlCard.js';
import { createPerpsChart, INDICATORS, CHART_DEFAULTS, CHART_THEMES } from './perpsChart.js';
import { parseTarget, makeAlert, checkAlerts, titleText, createSound } from './priceAlerts.js';
import { createMusicPlayer } from './classical.js';
import { VENUES, VENUE_IDS, venueName, setBackpackBase } from './venues/index.js';
import { SOL_RPC } from './rpc.js';
import {
  loadLeaderboard, scanPositions, confluence, overview, shortAddr, isAddr, TT_DEFAULTS, WINDOWS, RANK_BY,
} from './topTraders.js';

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
const userStates = new Map();                 // dex -> clearinghouse state
const userOrders = new Map();                 // dex -> open orders
let spot = null;                              // spot balances
let abstraction = null;
let assetData = null;                         // activeAssetData for sel
let bookSub = null, candleSub = null, userSubs = [];
let tab = 'pos';
let fills = [];                               // newest first
let fees = null;                              // userFees: the wallet's own rates
// top traders (see "top traders" below): ranking settings, the ranked list,
// labels / stars / hand-added / hidden traders, and positions per exchange
const TT = {
  opts: { ...TT_DEFAULTS, ...store.get('perps.ttOpts', {}) }, lb: store.get('perps.lb', null),
  labels: store.get('perps.ttLabels', {}), added: store.get('perps.ttAdded', []), hidden: new Set(store.get('perps.ttHidden', [])),
  states: new Map(), busy: new Set(), progress: '', err: '', view: 'market', lines: store.get('perps.ttLines', true),
};
let ttIndex = new Map(), ttDrawn = 0;

// --- venues -------------------------------------------------------------------------
// Every exchange's markets sit in one list. Hyperliquid is native to this page
// (its markets keep their names: BTC, xyz:NVDA); every other exchange is an
// adapter in src/venues/ that hands back Hyperliquid-shaped data, and its
// markets are listed as '<venue>:<symbol>' (pacifica:BP) with `native` holding
// the exchange's own symbol and `dex` '@<venue>' - the key its account lives
// under in userStates / userOrders. Each market is labelled with its exchange.
// `V` is the adapter of the market on screen, null for Hyperliquid.
let V = null;
const SEL_KEY = 'perps.sel';
const sessions = new Map();                    // venue id -> signed-in session
const vstate = new Map();                      // venue id -> { err, note, spot, fees, fills, poll, timer }
const venueLev = new Map();                    // coin -> 'lev|cross' last set this session
const pairName = (m) => m.pair || (m.label.includes('/') ? m.label : `${m.label}-${m.collateral || 'USDC'}`);
const nat = (m) => m?.native ?? m?.coin;
const adapterOf = (m) => (m?.venue ? VENUES[m.venue] : null);
const sessionOf = (m) => (m?.venue ? sessions.get(m.venue) : null);
const canTrade = (m = sel) => (m?.venue ? sessions.has(m.venue) : !!wallet);
const signedIn = () => !!wallet || sessions.size > 0;
const venueTag = (m) => (m.venue ? VENUES[m.venue].name : m.dex ? `HL · ${m.dex}` : 'Hyperliquid');
// the market list is narrow: Hyperliquid shortens to HL there (full name on hover)
const venueShort = (m) => (m.venue ? VENUES[m.venue].name : m.dex ? `HL · ${m.dex}` : 'HL');
// a venue adapter's markets, listed under unique names; prices are copied over
// from the adapter's own objects, which its price feed keeps updating
function wrapVenue(id, list) {
  return list.map((a) => ({ ...a, native: a.coin, coin: `${id}:${a.coin}`, venue: id, dex: '@' + id, dexName: VENUES[id].name, _src: a }));
}
function syncPx(m) {
  const a = m._src;
  m.mid = a.mid; m.mark = a.mark; m.oracle = a.oracle; m.change = a.change; m.funding = a.funding; m.oi = a.oi; m.volume = a.volume;
}

// --- sign in -------------------------------------------------------------------
function loadWallet() {
  const k = store.get('keys.v1', null);
  if (!k?.evm) return false;
  try { wallet = privateKeyToAccount(k.evm.startsWith('0x') ? k.evm : '0x' + k.evm); } catch { return false; }
  C = { ...C, ...hlClients({ wallet, ws: false }), subs: C.subs };
  $('aWallet').textContent = wallet.address.slice(0, 6) + '…' + wallet.address.slice(-4);
  $('aWallet').title = wallet.address;
  $('aWallet').classList.add('addr');
  return true;
}
// the key a venue's adapter signs with: keys.v1.sol, keys.v1.evm, or an exchange
// API key kept under keys.v1.<venue>
function venueSecret(id) {
  const k = store.get('keys.v1', {}) || {};
  const kind = VENUES[id].key.kind;
  return kind === 'sol' ? k.sol : kind === 'evm' ? k.evm : k[id];
}
/// sign in to every venue whose key this browser already holds, and keep each one's account fresh
function connectVenues() {
  for (const id of Object.keys(VENUES)) {
    if (sessions.has(id)) continue;
    const secret = venueSecret(id);
    if (!secret) continue;
    try {
      sessions.set(id, VENUES[id].connect(secret, { store }));
      startVenue(id);
    } catch (e) { vstate.set(id, { ...(vstate.get(id) || {}), err: e.message }); }
  }
}
let keyTarget = null;                          // which venue the sign-in box is for (null = Hyperliquid)
function showKeyModal(venueId = null) {
  keyTarget = venueId;
  const A = venueId ? VENUES[venueId] : null;
  const kind = A ? A.key.kind : 'evm';
  $('keyModal').querySelector('h3').textContent = A ? `Sign In · ${A.name}` : 'Sign In · Hyperliquid';
  $('keyModal').querySelector('p').textContent = A
    ? `${A.key.help} The key stays in this browser (the same local store the launcher uses) and signs ${A.name} requests here; it is never sent anywhere.`
    : 'Paste the private key of the EVM wallet that holds your Hyperliquid account. It stays in this browser (the same local store the launcher uses) and signs orders here; it is never sent anywhere.';
  $('keyIn').placeholder = kind === 'sol' ? 'base58 Solana private key' : kind === 'evm' ? '0x… private key' : A.key.label;
  $('keyErr').textContent = '';
  $('keyModal').classList.remove('hidden'); $('keyIn').focus();
}
$('keySave').onclick = () => {
  const raw = $('keyIn').value.trim();
  if (keyTarget) {
    const A = VENUES[keyTarget];
    try { A.connect(A.key.kind === 'evm' && !raw.startsWith('0x') ? '0x' + raw : raw, { store }); } catch (e) { $('keyErr').textContent = e.message; return; }
    const k = store.get('keys.v1', {}) || {};
    if (A.key.kind === 'sol') k.sol = raw; else if (A.key.kind === 'evm') k.evm = raw.startsWith('0x') ? raw : '0x' + raw; else k[keyTarget] = raw;
    store.set('keys.v1', k);
    $('keyIn').value = ''; $('keyErr').textContent = '';
    $('keyModal').classList.add('hidden');
    if (A.key.kind === 'evm' && !wallet && loadWallet()) startUser();
    connectVenues();
    paintSummary(); paintAccount();
    return;
  }
  const hex = raw.startsWith('0x') ? raw : '0x' + raw;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) { $('keyErr').textContent = 'that is not a 32-byte hex private key'; return; }
  const k = store.get('keys.v1', {}) || {};
  k.evm = hex;
  store.set('keys.v1', k);
  $('keyIn').value = '';
  $('keyModal').classList.add('hidden');
  if (loadWallet()) startUser();
  connectVenues();                             // Aster / Lighter sign with the same EVM key
};
$('keySkip').onclick = (e) => { e.preventDefault(); $('keyModal').classList.add('hidden'); };
$('aWallet').onclick = () => { if (!wallet) showKeyModal(); };

// --- markets -------------------------------------------------------------------
function dexTabs() {
  const names = [['all', 'All'], ['fav', '★'], ...[...new Map(markets.map((m) => [m.dex, m.venue ? VENUES[m.venue].name : m.dex ? m.dex : 'Hyperliquid'])).entries()]];
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
    && (!q || m.coin.toLowerCase().includes(q) || pairName(m).toLowerCase().includes(q) || m.dexName.toLowerCase().includes(q) || venueTag(m).toLowerCase().includes(q)));
  if ($('mktPop').classList.contains('hidden')) return;     // nothing to draw while it is shut
  // every exchange in one list, the busiest markets first
  rows.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  $('mList').innerHTML = rows.length ? rows.slice(0, 1500).map((m) => `
    <div class="mrow ${sel?.coin === m.coin ? 'on' : ''}" data-c="${esc(m.coin)}">
      <div class="nm"><span data-fav="${esc(m.coin)}" style="color:${favs.has(m.coin) ? '#facc15' : 'var(--faint)'}">★</span><span class="pn">${esc(pairName(m))}</span><span class="lev">${m.spot ? 'spot' : m.maxLeverage + 'x'}</span><span class="vtag v-${esc(m.venue || 'hl')}" title="${esc(venueTag(m))}">${esc(venueShort(m))}</span></div>
      <div>${px(m.mid)}</div>
      <div class="${cls(m.change)}">${pct(m.change)}</div>
      <div class="${cls(m.funding)}">${(m.funding * 800).toFixed(4)}%</div>
      <div>$${big(m.volume)}</div>
      <div>$${big(m.oi * m.mark)}</div>
    </div>`).join('') : '<div class="empty">no market matches</div>';
}
function openMarkets(show) {
  const pop = $('mktPop');
  const open = show ?? pop.classList.contains('hidden');
  pop.classList.toggle('hidden', !open);
  if (open) { renderList(); $('mSearch').focus(); $('mSearch').select(); }
}
$('mktBtn').onclick = (e) => { e.stopPropagation(); openMarkets(); };
document.addEventListener('click', (e) => { if (!e.target.closest('#mktPop') && !e.target.closest('#mktBtn')) $('mktPop').classList.add('hidden'); });
$('mSearch').oninput = renderList;
$('mFav').onchange = renderList;
$('mList').onclick = (e) => {
  const f = e.target.closest('[data-fav]');
  if (f) {
    const c = f.dataset.fav;
    favs.has(c) ? favs.delete(c) : favs.add(c);
    store.set('perps.favs', [...favs]); renderList(); return;
  }
  const r = e.target.closest('.mrow'); if (r) { openMarkets(false); select(r.dataset.c); }
};

function renderTicker() {
  const m = sel; if (!m) return;
  $('tDex').innerHTML = `<span class="vtag v-${esc(m.venue || 'hl')}">${esc(venueTag(m))}</span>${!m.venue && m.dex ? ' HIP-3' : ''}${m.spot ? ' spot' : ''}${m.onlyIsolated ? ' · isolated only' : ''}`;
  $('tCoin').textContent = pairName(m);
  $('tPx').textContent = px(m.mid);
  $('tPx').className = 'price ' + cls(m.change);
  $('tCh').innerHTML = `<span class="${cls(m.change)}">${pct(m.change)}</span>`;
  $('tOracle').textContent = px(m.oracle ?? m.mark);
  $('tFund').innerHTML = `<span class="${cls(m.funding)}">${(m.funding * 100).toFixed(4)}%</span>`;
  $('tOi').textContent = '$' + big(m.oi * m.mark);
  $('tVol').textContent = '$' + big(m.volume);
  $('tLev').textContent = m.maxLeverage + 'x';
  paintTitle();
}

async function select(coin) {
  const m = byCoin.get(coin); if (!m) return;
  sel = m;
  V = adapterOf(m);
  autoPick = null;
  store.set(SEL_KEY, coin);
  history.replaceState(null, '', location.pathname + '#' + encodeURIComponent(coin));
  $('viaVenue').textContent = `via ${venueTag(m)}`;
  $('bookGroup').style.display = V ? 'none' : '';
  livePx = null; lastTitlePx = null; tickDir = 0;
  renderList(); renderTicker(); paintAlertPanel(); paintTT(); ttTick();
  const lev = $('lev');
  lev.max = m.maxLeverage;
  $('levMax').textContent = m.maxLeverage + 'x max';
  if (+lev.value > m.maxLeverage) lev.value = m.maxLeverage;
  if (m.onlyIsolated) cross = false;
  paintLev();
  if (otype === 'limit' && !$('limitPx').value) $('limitPx').value = m.mid;
  await Promise.all([loadCandles(), subBook(), loadAssetData()]);
  paintSummary();
}

// --- chart ---------------------------------------------------------------------
// lightweight-charts (src/perpsChart.js): drag to pan, wheel to zoom, older
// candles load as you drag left. Settings, drawn lines (per market) and the
// interval are remembered in this browser.
const IVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '1w'];
const QUICK = ['1m', '5m', '15m', '1h', '4h', '1d'];
const IVAL_MS = { '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '8h': 288e5, '12h': 432e5, '1d': 864e5, '1w': 6048e5 };
const toK = (c) => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v });
const savedChart = store.get('perps.chart', {});
let chartOpts = {
  ...CHART_DEFAULTS, ...savedChart,
  on: { ...CHART_DEFAULTS.on, ...(savedChart.on || {}) },
  params: Object.fromEntries(Object.keys(INDICATORS).map((k) => [k, { ...CHART_DEFAULTS.params[k], ...(savedChart.params?.[k] || {}) }])),
};
let drawing = false;
const pc = createPerpsChart($('chart'), $('chartLegend'), {
  // Hyperliquid serves the most recent 5000 candles of any interval
  onNeedOlder: async (oldest) => {
    const m = sel, iv = interval;
    const cs = V
      ? await V.candles(nat(m), iv, oldest - IVAL_MS[iv] * 500, oldest - 1).catch(() => [])
      : (await C.info.candleSnapshot({ coin: m.coin, interval: iv, startTime: oldest - IVAL_MS[iv] * 500, endTime: oldest - 1 }).catch(() => [])).map(toK);
    return sel === m && iv === interval ? cs : [];
  },
  // alt-click the chart: a limit order at that price
  onClickPrice: (price, ev) => {
    if (ev?.shiftKey && sel) { addAlert(sel.coin, price); return; }
    if (!ev?.altKey || !sel) return;
    setType('limit');
    try { $('limitPx').value = formatPrice(price.toPrecision(10), sel.szDecimals); } catch { $('limitPx').value = price; }
    paintSummary();
  },
});
pc.setOptions(chartOpts);

// --- theme -----------------------------------------------------------------------
// 'paper' (cream) or 'dark' (Hyperliquid teal). The page picks it before first
// paint from the same key (see the inline script in perps.html).
let theme = store.get('perps.theme', 'paper') === 'dark' ? 'dark' : 'paper';
const CT = () => CHART_THEMES[theme];
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('themeBtn').textContent = theme === 'paper' ? '☾' : '☀';
  pc.setTheme(theme);
  if (sel) { paintChartAccount(true); const lines = store.get('perps.lines', {})[sel.coin]; if (lines) pc.setUserLines(lines); }
  paintChartBar();
}
$('themeBtn').onclick = () => { theme = theme === 'paper' ? 'dark' : 'paper'; store.set('perps.theme', theme); applyTheme(); };
applyTheme();
pc.onLinesChange = (prices) => {
  if (!sel) return;
  const all = store.get('perps.lines', {});
  if (prices.length) all[sel.coin] = prices; else delete all[sel.coin];
  store.set('perps.lines', all);
};
function saveChart() { store.set('perps.chart', chartOpts); }

function paintChartBar() {
  $('ivals').innerHTML = QUICK.map((i) => `<button data-i="${i}" class="${i === interval ? 'on' : ''}">${i}</button>`).join('')
    + `<select id="ivalMore" title="more intervals"><option value="">${QUICK.includes(interval) ? 'more' : interval}</option>${IVALS.filter((i) => !QUICK.includes(i)).map((i) => `<option value="${i}">${i}</option>`).join('')}</select>`;
  $('ivalMore').onchange = (e) => { if (e.target.value) setInterval_(e.target.value); };
  $('chartType').value = chartOpts.type;
  $('chartLog').classList.toggle('on', chartOpts.log);
  $('chartDraw').classList.toggle('on', drawing);
  $('indPanel').innerHTML = Object.entries(INDICATORS).map(([k, d]) => `
    <label class="indrow"><input type="checkbox" data-ind="${k}" ${chartOpts.on[k] ? 'checked' : ''}>
      <span style="color:${CHART_THEMES[theme].ind[k] || d.color || 'var(--text)'}">${d.label}</span>
      ${d.params.map(([p]) => `<input class="indp" data-ind="${k}" data-p="${p}" value="${esc(chartOpts.params[k]?.[p])}" title="${p}" inputmode="decimal">`).join('')}
    </label>`).join('')
    + `<label class="indrow"><input type="checkbox" id="chOrders" ${chartOpts.showOrders ? 'checked' : ''}><span>position &amp; order lines</span></label>`
    + `<label class="indrow"><input type="checkbox" id="chFills" ${chartOpts.showFills ? 'checked' : ''}><span>my fills</span></label>`;
}
function setInterval_(iv) {
  interval = iv; store.set('perps.ival', iv);
  paintChartBar(); loadCandles();
}
$('ivals').onclick = (e) => { const b = e.target.closest('button'); if (b) setInterval_(b.dataset.i); };
$('chartType').onchange = () => { chartOpts.type = $('chartType').value; saveChart(); pc.setOptions(chartOpts); paintChartAccount(true); };
$('chartLog').onclick = () => { chartOpts.log = !chartOpts.log; saveChart(); pc.setOptions(chartOpts); paintChartBar(); };
$('chartFit').onclick = () => pc.fit();
// right-click the chart: back to the default view (instead of the browser's menu)
$('chart').addEventListener('contextmenu', (e) => { e.preventDefault(); pc.reset(); });
$('chartDraw').onclick = () => { drawing = !drawing; pc.setDrawMode(drawing); paintChartBar(); };
$('chartClear').onclick = () => { pc.setUserLines([]); pc.onLinesChange([]); };
$('indBtn').onclick = (e) => { e.stopPropagation(); $('indPanel').classList.toggle('hidden'); };
document.addEventListener('click', (e) => { if (!e.target.closest('#indPanel') && !e.target.closest('#indBtn')) $('indPanel').classList.add('hidden'); });
$('indPanel').onchange = (e) => {
  const t = e.target;
  if (t.id === 'chOrders') chartOpts.showOrders = t.checked;
  else if (t.id === 'chFills') chartOpts.showFills = t.checked;
  else if (t.dataset.p) { const v = +t.value; if (!(v > 0)) return; chartOpts.params[t.dataset.ind] = { ...chartOpts.params[t.dataset.ind], [t.dataset.p]: v }; }
  else if (t.dataset.ind) chartOpts.on[t.dataset.ind] = t.checked;
  saveChart(); pc.setOptions(chartOpts); paintChartAccount(true);
};
paintChartBar();

async function loadCandles() {
  const m = sel; if (!m) return;
  const iv = interval;
  const end = Date.now();
  let cs = [];
  try {
    cs = V ? await V.candles(nat(m), iv, end - IVAL_MS[iv] * 500, end)
      : (await C.info.candleSnapshot({ coin: m.coin, interval: iv, startTime: end - IVAL_MS[iv] * 500, endTime: end })).map(toK);
  } catch { /* empty chart */ }
  if (sel !== m || iv !== interval) return;
  pc.setCandles(cs);
  pc.setUserLines(store.get('perps.lines', {})[m.coin] || []);
  paintChartAccount(true);
  try { await candleSub?.unsubscribe(); } catch { /* gone */ }
  if (V) {
    const stop = V.subCandles(nat(m), iv, (c) => { if (sel === m && iv === interval) pc.update(c); });
    candleSub = { unsubscribe: async () => stop() };
    return;
  }
  candleSub = await C.subs.candle({ coin: m.coin, interval: iv }, (c) => {
    if (sel === m && iv === interval) pc.update(toK(c));
  }).catch(() => null);
}

let chartFillCount = -1;
// the position's entry and liquidation, open orders and TP/SL, and fills
function paintChartAccount(force = false) {
  if (!sel) return;
  const pos = positionFor(sel.coin);
  const orders = (userOrders.get(sel.dex) || []).filter((o) => o.coin === sel.coin).map((o) => {
    const trig = o.isTrigger;
    const tp = trig && /take profit/i.test(o.orderType), slo = trig && /stop/i.test(o.orderType);
    return {
      px: +(trig ? o.triggerPx : o.limitPx),
      color: tp ? CT().up : slo ? CT().down : o.side === 'B' ? CT().histUp : CT().histDown,
      label: tp ? 'TP' : slo ? 'SL' : `${o.side === 'B' ? 'buy' : 'sell'} ${o.sz}`,
    };
  });
  const al = alerts.filter((a) => a.coin === sel.coin).map((a) => ({ px: a.px, label: '🔔 ' + (a.note || (a.dir === 'above' ? 'above' : 'below')) + (a.repeat ? ' ↻' : '') }));
  // where the top traders got in, as a group
  const tc = TT.lines ? ttConf() : null;
  const extra = tc ? [
    tc.long.n && { px: tc.long.avgEntry, color: CT().up, label: `🧠 ${tc.long.n} long avg` },
    tc.short.n && { px: tc.short.avgEntry, color: CT().down, label: `🧠 ${tc.short.n} short avg` },
  ].filter(Boolean) : [];
  pc.setAccount({ entry: pos ? +pos.entryPx : null, liq: pos?.liquidationPx ? +pos.liquidationPx : null, long: pos ? +pos.szi > 0 : null, orders, alerts: al, extra });
  const af = allFills();
  if (force || af.length !== chartFillCount) {
    chartFillCount = af.length;
    pc.setFills(af.filter((f) => f.coin === sel.coin).map((f) => ({ time: f.time, buy: f.side === 'B', text: f.side === 'B' ? 'B' : 'S' })));
  }
}

// --- order book ----------------------------------------------------------------
// Hyperliquid's default book stream is 20 levels every 5 seconds - too slow to
// trade off. The book here merges three sources (see mergeBook): fast 5-level
// pushes every 0.5 s, the best bid/ask pushed the moment it changes, and 20
// levels of depth fetched every 2 s. Redraws are batched to one per frame.
const book = { deep: null, fast: null, bbo: null, coin: null, t: 0 };
let bookSubs = [], tradeSub = null, bookFrame = 0, bookView = 'book', deepTimer = 0;
let grouping = store.get('perps.group', '');          // '' = every price, else nSigFigs
const trades = [];
async function subBook() {
  const m = sel;
  for (const s of [...bookSubs, tradeSub]) { try { await s?.unsubscribe(); } catch { /* gone */ } }
  bookSubs = []; tradeSub = null;
  Object.assign(book, { deep: null, fast: null, bbo: null, coin: m.coin });
  trades.length = 0;
  $('bookAsks').innerHTML = $('bookBids').innerHTML = ''; $('tradeTape').innerHTML = '';
  const nSig = grouping ? { nSigFigs: +grouping } : {};
  const live = (f) => (ev) => { if (sel === m) { f(ev); book.t = Date.now(); queueBook(); } };
  // Depth comes from a request every 2 s, not a second l2Book stream: the
  // socket's book messages do not say which stream they belong to, so a deep
  // and a fast subscription on one coin both just get the fast 5 levels.
  // The first request also paints the book before any push arrives.
  clearInterval(deepTimer);
  if (V) {
    // a venue adapter streams whole books (and maybe trades) in Hyperliquid's level shape
    const stopB = V.subBook(nat(m), live((b) => {
      book.deep = b.levels;
      const bb = b.levels[0]?.[0], aa = b.levels[1]?.[0];
      if (bb && aa) tickPx(m, +bb.px, +aa.px);
    }));
    bookSubs = [{ unsubscribe: async () => stopB() }];
    if (V.subTrades) {
      const stopT = V.subTrades(nat(m), (ts) => {
        if (sel !== m) return;
        for (const t of ts) trades.unshift(t);
        trades.length = Math.min(trades.length, 60);
        queueBook();
      });
      tradeSub = { unsubscribe: async () => stopT() };
    }
    return;
  }
  const deep = () => C.info.l2Book({ coin: m.coin, ...nSig }).then(live((b) => { book.deep = b.levels; })).catch(() => {});
  deep(); deepTimer = setInterval(() => { if (sel === m && !document.hidden) deep(); }, 2000);
  const subs = await Promise.all([
    C.subs.l2Book({ coin: m.coin, ...nSig, fast: true }, live((b) => {
      book.fast = b.levels;
      if (grouping) tickPx(m, +b.levels[0]?.[0]?.px, +b.levels[1]?.[0]?.px);
    })),
    // the BBO is per price, so only meaningful on an ungrouped book
    grouping ? null : C.subs.bbo({ coin: m.coin }, live((b) => { book.bbo = b.bbo; tickPx(m, +b.bbo[0]?.px, +b.bbo[1]?.px); })),
  ].map((p) => p?.catch?.(() => null) ?? p));
  if (sel !== m) { for (const s of subs) s?.unsubscribe().catch(() => {}); return; }
  bookSubs = subs.filter(Boolean);
  tradeSub = await C.subs.trades({ coin: m.coin }, (ts) => {
    if (sel !== m) return;
    for (const t of ts) trades.unshift(t);
    trades.length = Math.min(trades.length, 60);
    queueBook();
  }).catch(() => null);
}
function queueBook() {
  if (bookFrame) return;
  bookFrame = requestAnimationFrame(() => { bookFrame = 0; bookView === 'book' ? drawBook() : drawTrades(); });
}
function drawBook() {
  if (!book.deep && !book.fast) return;
  const [bids, asks] = mergeBook(grouping ? { deep: book.deep, fast: book.fast } : book);
  const N = 11;
  const a = asks.slice(0, N), b = bids.slice(0, N);
  // cumulative size, outward from the spread
  let ca = 0, cb = 0;
  const aRows = a.map((l) => ({ ...l, cum: (ca += l.sz) })).reverse();
  const bRows = b.map((l) => ({ ...l, cum: (cb += l.sz) }));
  const max = Math.max(ca, cb, 1e-12);
  const szf = (n) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 1 : 4 });
  const row = (l, col) => `<div class="row" data-px="${l.px}" data-cum="${l.cum}"><i style="width:${(l.cum / max * 100).toFixed(1)}%;background:${col}"></i><span style="color:${col}">${px(l.px)}</span><span>${szf(l.sz)}</span><span>${szf(l.cum)}</span></div>`;
  $('bookAsks').innerHTML = aRows.map((l) => row(l, 'var(--short)')).join('');
  $('bookBids').innerHTML = bRows.map((l) => row(l, 'var(--long)')).join('');
  if (b[0] && a[0]) {
    const sp = a[0].px - b[0].px;
    // how lopsided the visible book is: >50% means more resting bids than asks
    const imb = cb / (ca + cb) * 100;
    $('bookSpread').innerHTML = `<span class="dim">Spread</span><span>${px(sp)}</span><span>${(sp / a[0].px * 100).toFixed(3)}%</span><span class="${imb >= 50 ? 'up' : 'down'}" title="share of the visible book that is bids">${imb.toFixed(0)}% bids</span>`;
  }
}
function drawTrades() {
  $('tradeTape').innerHTML = trades.slice(0, 26).map((t) => `<div class="row"><span class="${t.side === 'B' ? 'up' : 'down'}">${px(+t.px)}</span><span>${(+t.sz).toLocaleString('en-US', { maximumFractionDigits: 4 })}</span><span class="dim">${new Date(t.time).toLocaleTimeString(undefined, { hour12: false })}</span></div>`).join('');
}
// click a price: limit order there. Click the size column: size up to that depth.
$('bookAsks').onclick = $('bookBids').onclick = (e) => {
  const r = e.target.closest('.row'); if (!r) return;
  setType('limit'); $('limitPx').value = r.dataset.px;
  if (e.target === r.children[2] || e.target === r.children[3]) { $('sizeUnit').value = 'coin'; $('size').value = formatSize(r.dataset.cum, sel.szDecimals); }
  paintSummary();
};
$('bookTabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  bookView = b.dataset.v;
  for (const x of $('bookTabs').querySelectorAll('button')) x.classList.toggle('on', x === b);
  $('bookView').style.display = bookView === 'book' ? '' : 'none';
  $('tradeTape').style.display = bookView === 'book' ? 'none' : '';
  queueBook();
};
$('bookGroup').value = grouping;
$('bookGroup').onchange = () => { grouping = $('bookGroup').value; store.set('perps.group', grouping); subBook(); };
// a stale book is worse than none: say so if nothing has arrived for 3 s
setInterval(() => { $('bookLive').className = book.t && Date.now() - book.t < 3000 ? 'live on' : 'live'; }, 500);

// --- account -------------------------------------------------------------------
function positionFor(coin) {
  for (const st of userStates.values()) for (const p of st.assetPositions || []) if (p.position.coin === coin && +p.position.szi) return p.position;
  return null;
}
// A venue adapter has no account stream: poll it (often for the venue on
// screen, every 10 s for the rest), name its markets the way this page does,
// and turn new fills into toasts.
function startVenue(id) {
  const s = sessions.get(id);
  const vx = vstate.get(id) || {};
  vstate.set(id, vx);
  let seen = null;
  const pre = (c) => `${id}:${c}`;
  vx.poll = async () => {
    clearTimeout(vx.timer);
    try {
      const r = await s.state();
      const st = r.st;
      for (const p of st.assetPositions || []) p.position.coin = pre(p.position.coin);
      userStates.set('@' + id, st);
      userOrders.set('@' + id, (r.orders || []).map((o) => ({ ...o, coin: pre(o.coin) })));
      vx.spot = r.spot || null;
      if (r.fees) vx.fees = r.fees;
      vx.note = st.venueNote || '';
      if (r.fills) {
        const fl = r.fills.map((f) => ({ ...f, coin: pre(f.coin), venue: id }));
        const newest = fl[0]?.time ?? 0;
        if (seen != null) {
          const fresh = fl.filter((f) => f.time > seen);
          if (fresh.length && alertCfg.fillSound) sound.fill(alertCfg.vol);
          for (const f of fresh) toast(`${VENUES[id].name}: ${f.dir || (f.side === 'B' ? 'Buy' : 'Sell')} ${f.sz} ${byCoin.get(f.coin)?.label || f.coin} @ ${px(+f.px)}${+f.closedPnl ? ` · PnL ${usd(+f.closedPnl)}` : ''}`, +f.closedPnl < 0 ? 'down' : 'up');
        }
        if (fl.length || seen == null) seen = Math.max(seen ?? 0, newest);
        vx.fills = fl;
      }
      vx.err = '';
    } catch (e) { vx.err = e.message; }
    paintAccount();
    const ms = sel?.venue === id ? (s.pollMs || 3000) : 10000;
    vx.timer = setTimeout(vx.poll, document.hidden ? Math.max(15000, ms) : ms);
  };
  vx.poll();
}
// Hyperliquid's fills and every venue's, newest first
const allFills = () => [...fills, ...[...vstate.values()].flatMap((v) => v.fills || [])].sort((a, b) => b.time - a.time);
async function vsend(fn, what, id = sel?.venue) {
  const msg = $('msg');
  const name = VENUES[id]?.name || id;
  msg.innerHTML = `<span class="dim">${esc(what)}…</span>`;
  try {
    const r = await fn();
    msg.innerHTML = `<span class="up">${esc(r?.msg || 'done')}</span>`;
    setTimeout(() => vstate.get(id)?.poll?.(), 500);
    return true;
  } catch (e) {
    msg.innerHTML = `<span class="err">${esc(name)}: ${esc(e?.message || String(e))}</span>`;
    return false;
  }
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
  for (const dex of new Set(markets.filter((m) => !m.venue).map((m) => m.dex))) {
    await sub(C.subs.openOrders({ user, ...(dex ? { dex } : {}) }, (ev) => { userOrders.set(ev.dex ?? dex, ev.orders); paintAccount(); }));
  }
  await sub(C.subs.spotState({ user }, (ev) => { spot = ev.spotState ?? ev; paintAccount(); }));
  // fills: the first message is the recent history, later ones are new fills
  await sub(C.subs.userFills({ user }, (ev) => {
    const fresh = ev.isSnapshot ? [] : ev.fills;
    fills = [...ev.fills.slice().reverse(), ...fills].slice(0, 200);
    if (fresh.length && alertCfg.fillSound) sound.fill(alertCfg.vol);
    for (const f of fresh) toast(`${f.dir || (f.side === 'B' ? 'Buy' : 'Sell')} ${f.sz} ${f.coin} @ ${px(+f.px)}${+f.closedPnl ? ` · PnL ${usd(+f.closedPnl)}` : ''}`, +f.closedPnl < 0 ? 'down' : 'up');
    if (tab === 'fills') paintAccount();
  }));
  fees = await C.info.userFees({ user }).catch(() => null);
  abstraction = await C.info.userAbstraction({ user }).catch(() => null);
  loadAssetData();
  paintUnify();
}
async function loadAssetData() {
  if (!sel) return;
  const m = sel;
  if (V) {
    // no per-market account read: take leverage from an open position, if any
    assetData = null;
    const p = positionFor(m.coin);
    if (p?.leverage?.value) { $('lev').value = Math.min(p.leverage.value, m.maxLeverage); cross = p.leverage.type === 'cross' && !m.onlyIsolated; venueLev.set(m.coin, `${$('lev').value}|${cross}`); paintLev(); }
    paintSummary();
    return;
  }
  if (!wallet) { assetData = null; return; }
  assetData = await C.info.activeAssetData({ user: wallet.address, coin: m.coin }).catch(() => null);
  if (sel !== m || !assetData) return;
  $('lev').value = Math.min(assetData.leverage.value, m.maxLeverage);
  cross = assetData.leverage.type === 'cross' && !m.onlyIsolated;
  paintLev(); paintSummary();
}
// the two lines above the size box, as on Hyperliquid
function paintTicketAcct() {
  if (!sel) return;
  if (!canTrade()) { $('tkAvail').textContent = '—'; $('tkPos').textContent = '—'; return; }
  const avail = assetData?.availableToTrade ? +assetData.availableToTrade[side === 'long' ? 0 : 1] : +(userStates.get(sel.dex)?.withdrawable ?? NaN);
  $('tkAvail').textContent = isFinite(avail) ? usd(avail) + ' ' + (sel.collateral || 'USDC') : '—';
  const p = positionFor(sel.coin);
  $('tkPos').innerHTML = p ? `<span class="${+p.szi > 0 ? 'up' : 'down'}">${(+p.szi).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${esc(sel.label)}</span>` : `0 ${esc(sel.label)}`;
}
function paintAccount() {
  let eq = 0, pnl = 0, free = 0;
  for (const st of userStates.values()) {
    eq += +st.marginSummary.accountValue;
    free += +st.withdrawable;
    for (const p of st.assetPositions || []) pnl += +p.position.unrealizedPnl;
  }
  const stable = (spot?.balances || []).filter((b) => /^USD/.test(b.coin)).reduce((a, b) => a + (+b.total - +b.hold), 0);
  const on = signedIn();
  $('aEquity').textContent = on ? usd(eq) : '—';
  $('aFree').textContent = on ? usd(free) + (stable > 0.01 ? ` · spot ${usd(stable)}` : '') : '—';
  $('aPnl').innerHTML = on ? `<span class="${cls(pnl)}">${usd(pnl)}</span>` : '—';
  // cross-margin health, summed over every exchange the account uses
  let maint = 0, crossEq = 0, ntl = 0;
  for (const st of userStates.values()) {
    maint += +(st.crossMaintenanceMarginUsed ?? 0);
    crossEq += +(st.crossMarginSummary?.accountValue ?? 0);
    ntl += +(st.crossMarginSummary?.totalNtlPos ?? 0);
  }
  $('aRatio').textContent = on ? (crossEq > 0 ? (maint / crossEq * 100).toFixed(2) + '%' : '0.00%') : '—';
  $('aMaint').textContent = on ? usd(maint) : '—';
  $('aLevA').textContent = on ? (crossEq > 0 ? (ntl / crossEq).toFixed(2) + 'x' : '0.00x') : '—';
  paintTicketAcct();
  const positions = [...userStates.entries()].flatMap(([dex, st]) => (st.assetPositions || []).filter((p) => +p.position.szi).map((p) => ({ dex, ...p.position })));
  const orders = [...userOrders.values()].flat();
  $('nPos').textContent = positions.length ? `(${positions.length})` : '';
  $('nOrd').textContent = orders.length ? `(${orders.length})` : '';
  renderBottom(positions, orders);
  if (sel) paintChartAccount();
}
function renderBottom(positions, orders) {
  const body = $('bBody');
  if (tab === 'alerts') { renderAlertsTab(); return; }
  if (tab === 'tt') { renderTT(); return; }
  if (!signedIn() && tab !== 'bal') { body.innerHTML = '<div class="empty"><a href="#" id="signLink">sign in</a> to see positions</div>'; $('signLink').onclick = (e) => { e.preventDefault(); showKeyModal(V?.id || null); }; return; }
  const nm = (coin) => { const m = byCoin.get(coin); return m ? `${esc(m.label)} <span class="vtag v-${esc(m.venue || 'hl')}">${esc(venueTag(m))}</span>` : esc(coin); };
  if (tab === 'pos') {
    body.innerHTML = positions.length ? `<table class="table"><tr><th>Coin</th><th>Size</th><th>Position Value</th><th>Entry Price</th><th>Mark Price</th><th>PNL (ROE %)</th><th>Liq. Price</th><th>Margin</th><th>TP / SL</th><th></th></tr>${positions.map((p) => {
      const m = byCoin.get(p.coin); const long = +p.szi > 0;
      return `<tr><td><a href="#" data-sel="${esc(p.coin)}" style="color:var(--text)">${nm(p.coin)}</a> <span class="${long ? 'up' : 'down'}">${long ? 'Long' : 'Short'} ${p.leverage.value}x</span></td>
        <td>${Math.abs(+p.szi)}</td><td>${usd(+p.positionValue)}</td><td>${px(+p.entryPx)}</td><td>${px(m?.mark)}</td>
        <td class="${cls(+p.unrealizedPnl)}">${usd(+p.unrealizedPnl)} (${pct(+p.returnOnEquity * 100, 1)})</td>
        <td>${p.liquidationPx ? px(+p.liquidationPx) : '—'}</td><td>${usd(+p.marginUsed)} ${p.leverage.type === 'cross' ? 'cross' : 'iso'}</td>
        <td>${esc(tpslFor(p.coin))}</td>
        <td class="x"><button class="tbtn" data-card="pos|${esc(p.coin)}">Card</button> <button class="tbtn" data-tpsl="${esc(p.coin)}">TP/SL</button> <button class="tbtn" data-close="${esc(p.coin)}|0.25">25%</button> <button class="tbtn" data-close="${esc(p.coin)}|0.5">50%</button> <button class="tbtn" data-close="${esc(p.coin)}|1">Close</button></td></tr>`;
    }).join('')}</table>` : '<div class="empty">no open positions</div>';
  } else if (tab === 'fills') {
    const af = allFills();
    body.innerHTML = af.length ? `<table class="table"><tr><th>Time</th><th>Coin</th><th>Direction</th><th>Size</th><th>Price</th><th>Fee</th><th>Closed PNL</th><th></th></tr>${af.slice(0, 150).map((f) => `<tr>
        <td class="dim">${new Date(f.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</td>
        <td>${nm(f.coin)}</td><td class="${f.side === 'B' ? 'up' : 'down'}">${esc(f.dir || (f.side === 'B' ? 'Buy' : 'Sell'))}${f.liquidation ? ' · LIQUIDATED' : ''}</td>
        <td>${esc(f.sz)}</td><td>${px(+f.px)}</td><td class="dim">${(+f.fee).toFixed(4)} ${esc(f.feeToken || '')}</td>
        <td class="${cls(+f.closedPnl)}">${+f.closedPnl ? usd(+f.closedPnl) : '—'}</td>
        <td class="x">${+f.closedPnl ? `<button class="tbtn" data-card="fill|${esc(f.coin)}|${f.oid}">Card</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">no fills yet</div>';
  } else if (tab === 'ord') {
    body.innerHTML = orders.length ? `<div style="padding:8px 10px 0;text-align:right"><button class="tbtn" data-cancelall="1">Cancel All (${orders.length})</button></div><table class="table"><tr><th>Coin</th><th>Type</th><th>Direction</th><th>Size</th><th>Price</th><th>Trigger Conditions</th><th></th></tr>${orders.map((o) => `<tr>
        <td>${nm(o.coin)}</td><td>${esc(o.orderType || 'Limit')}${o.reduceOnly ? ' · reduce' : ''}</td>
        <td class="${o.side === 'B' ? 'up' : 'down'}">${o.side === 'B' ? 'Buy' : 'Sell'}</td><td>${esc(o.sz)}</td><td>${px(+o.limitPx)}</td>
        <td>${o.isTrigger ? esc(o.triggerCondition || px(+o.triggerPx)) : '—'}</td>
        <td class="x"><button class="tbtn" data-cancel="${esc(o.coin)}|${o.oid}">Cancel</button></td></tr>`).join('')}</table>` : '<div class="empty">no open orders</div>';
  } else {
    renderBalances(body);
  }
}
// Balances: one section per exchange - Hyperliquid, then every other venue,
// signed in or not (with what to do next: sign in, deposit, set up a key).
function renderBalances(body) {
  const num = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const table = (rows) => (rows.length ? `<table class="table"><tr><th>Account</th><th>Total</th><th>Available</th></tr>${rows.map(([a, t, f]) => `<tr><td>${esc(a)}</td><td>${num(t)}</td><td>${num(f)}</td></tr>`).join('')}</table>` : '');
  let h = '';
  // Hyperliquid
  const hlRows = [...userStates.entries()].filter(([k, st]) => !k.startsWith('@') && +st.marginSummary.accountValue).map(([dex, st]) => [`perps · ${dex || 'main'}`, +st.marginSummary.accountValue, +st.withdrawable]);
  const hlSpot = (spot?.balances || []).filter((b) => +b.total).map((b) => [`spot · ${b.coin}`, +b.total, +b.total - +b.hold]);
  h += `<div class="balhead"><span class="vtag v-hl">Hyperliquid</span> ${wallet ? `<span class="dim">${esc(wallet.address)}</span>` : '<a href="#" data-signin="">sign in with your EVM key</a>'}</div>`;
  if (wallet) h += table([...hlRows, ...hlSpot]) + `<div class="empty">${hlRows.length + hlSpot.length ? `mode: <b>${esc(abstraction || '—')}</b>. ` : 'nothing here yet. '}Deposit at app.hyperliquid.xyz (USDC from Arbitrum).</div>`;
  // every other venue
  for (const [id, A] of Object.entries(VENUES)) {
    const s = sessions.get(id), vx = vstate.get(id) || {};
    const st = userStates.get('@' + id);
    h += `<div class="balhead"><span class="vtag v-${id}">${esc(A.name)}</span> ${s ? `<span class="dim">${esc(s.address)}</span>` : `<a href="#" data-signin="${id}">sign in (${esc(A.key.kind === 'sol' ? 'Solana key' : A.key.kind === 'evm' ? 'EVM key' : 'API key')})</a>`}</div>`;
    if (!s) { if (vx.err) h += `<div class="empty"><span class="err">${esc(vx.err)}</span></div>`; continue; }
    const rows = st && +st.marginSummary.accountValue ? [['perps', +st.marginSummary.accountValue, +st.withdrawable]] : [];
    const sp = (vx.spot?.balances || []).filter((b) => +b.total).map((b) => [`spot · ${b.coin}`, +b.total, +b.total - +b.hold]);
    h += table([...rows, ...sp]);
    h += `<div class="empty">${vx.err ? `<span class="err">${esc(vx.err)}</span><br>` : ''}${esc(vx.note || (rows.length + sp.length ? '' : `nothing here yet: fund it at ${A.site}.`))}`;
    // only while the venue says it still needs one (Aster: approve an API wallet; Lighter: register a trading key)
    if (s.setupApiKey && /button below|press set up|set up a .* trading key|not registered/i.test(vx.note || '')) h += `<div style="margin-top:8px"><button class="tbtn" data-vsetup="${id}">Set up ${esc(A.name)} trading key</button> <span class="dim" id="vSetupMsg-${id}"></span></div>`;
    if (s.deposit) h += `<div class="inrow" style="margin-top:10px;max-width:420px"><input id="vDepAmt-${id}" inputmode="decimal" placeholder="USDC to deposit (min 10)"><button class="tbtn" data-vdep="${id}">Deposit from wallet</button></div><div class="dim" id="vDepMsg-${id}" style="margin-top:6px">Moves USDC from this wallet into ${esc(A.name)} (an on-chain transaction, simulated first).</div>`;
    h += '</div>';
  }
  body.innerHTML = h;
}
$('bBody').addEventListener('click', async (e) => {
  const si = e.target.closest('[data-signin]');
  if (si) { e.preventDefault(); showKeyModal(si.dataset.signin || null); return; }
  const su = e.target.closest('[data-vsetup]');
  if (su) {
    const id = su.dataset.vsetup, s = sessions.get(id), out = $(`vSetupMsg-${id}`);
    su.disabled = true; out.textContent = 'registering…';
    try { const r = await s.setupApiKey(); out.innerHTML = `<span class="up">${esc(r?.msg || 'done')}</span>`; vstate.get(id)?.poll?.(); }
    catch (err) { out.innerHTML = `<span class="err">${esc(err.message)}</span>`; }
    su.disabled = false; return;
  }
  const dp = e.target.closest('[data-vdep]');
  if (dp) {
    const id = dp.dataset.vdep, s = sessions.get(id), A = VENUES[id], out = $(`vDepMsg-${id}`);
    const amt = +$(`vDepAmt-${id}`).value;
    if (!(amt > 0)) { out.textContent = 'enter an amount'; return; }
    if (!confirm(`Deposit ${amt} USDC from ${s.address} into ${A.name}?`)) return;
    dp.disabled = true; out.textContent = 'simulating, then sending…';
    try {
      const sig = await s.deposit(amt, A.key.kind === 'sol' ? SOL_RPC : undefined);
      out.innerHTML = `<span class="up">deposited</span> · ${A.key.kind === 'sol' ? `<a href="https://solscan.io/tx/${esc(sig)}" target="_blank" rel="noopener">${esc(String(sig).slice(0, 16))}…</a>` : esc(String(sig).slice(0, 18))} (it shows on ${esc(A.name)} after confirmation)`;
      setTimeout(() => vstate.get(id)?.poll?.(), 4000);
    } catch (err) { out.innerHTML = `<span class="err">${esc(err.message)}</span>`; }
    dp.disabled = false;
  }
});
$('bTabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  tab = b.dataset.t; for (const x of $('bTabs').children) x.classList.toggle('on', x === b); paintAccount();
};
$('bBody').onclick = async (e) => {
  const s = e.target.closest('[data-sel]'); if (s) { e.preventDefault(); select(s.dataset.sel); return; }
  const da = e.target.closest('[data-delalert]'); if (da) { removeAlert(da.dataset.delalert); return; }
  if (e.target.closest('[data-clearalerts]')) { if (confirm(`Remove all ${alerts.length} price alerts?`)) { alerts = []; saveAlerts(); paintAlertPanel(); paintChartAccount(); renderAlertsTab(); } return; }
  const c = e.target.closest('[data-close]');
  if (c) {
    const [coin, frac] = c.dataset.close.split('|');
    const pos = positionFor(coin); const m = byCoin.get(coin);
    if (!pos || !m) return;
    c.disabled = true;
    const what = `closing ${+frac >= 1 ? '' : `${+frac * 100}% of `}${m.label}`;
    if (m.venue) await vsend(() => sessionOf(m).order({ coin: nat(m), isBuy: +pos.szi < 0, sz: Math.abs(+pos.szi) * +frac, type: 'market', slippage: slip(), reduceOnly: true }), what, m.venue);
    else await send(() => C.exchange.order(partialCloseOrder(m, pos.szi, +frac, slip())), what);
    c.disabled = false; return;
  }
  const cd = e.target.closest('[data-card]');
  if (cd) { const [kind, coin, oid] = cd.dataset.card.split('|'); openCard(kind, coin, oid); return; }
  const t = e.target.closest('[data-tpsl]');
  if (t) { openTpsl(t.dataset.tpsl); return; }
  if (e.target.closest('[data-cancelall]')) {
    // every exchange that has orders open
    for (const [k, os] of userOrders) {
      if (!k.startsWith('@') || !os.length) continue;
      const id = k.slice(1);
      await vsend(() => sessions.get(id).cancelAll(), `cancelling every ${VENUES[id].name} order`, id);
    }
    const all = [...userOrders.values()].flat().map((o) => ({ a: byCoin.get(o.coin)?.asset, o: o.oid })).filter((x) => x.a != null);
    if (all.length) await send(() => C.exchange.cancel({ cancels: all }), `cancelling ${all.length} orders`);
    return;
  }
  const x = e.target.closest('[data-cancel]');
  if (x) {
    const [coin, oid] = x.dataset.cancel.split('|'); const m = byCoin.get(coin);
    if (!m) return;
    x.disabled = true;
    if (m.venue) {
      const o = (userOrders.get(m.dex) || []).find((y) => String(y.oid) === String(oid));
      await vsend(() => sessionOf(m).cancel(nat(m), oid, !!o?.isTrigger), 'cancelling', m.venue);
      return;
    }
    await send(() => C.exchange.cancel({ cancels: [{ a: m.asset, o: +oid }] }), 'cancelling');
  }
};

// TP/SL already resting on a position, read off its open trigger orders
function tpslFor(coin) {
  const os = (userOrders.get(byCoin.get(coin)?.dex ?? '') || []).filter((o) => o.coin === coin && o.isTrigger && o.reduceOnly);
  const tp = os.find((o) => /take profit/i.test(o.orderType)), sl = os.find((o) => /stop/i.test(o.orderType));
  return [tp && `TP ${px(+tp.triggerPx)}`, sl && `SL ${px(+sl.triggerPx)}`].filter(Boolean).join(' · ') || '—';
}
// the TP/SL editor sits outside the table, which redraws every second
function openTpsl(coin) {
  const pos = positionFor(coin); const m = byCoin.get(coin);
  if (!pos || !m) return;
  const long = +pos.szi > 0;
  const tool = $('posTool');
  tool.style.display = '';
  tool.innerHTML = `<b>${esc(coin)}</b> <span class="${long ? 'up' : 'down'}">${long ? 'Long' : 'Short'} ${Math.abs(+pos.szi)}</span>
    <span class="dim">entry ${px(+pos.entryPx)} · mark ${px(m.mark)}</span>
    <input id="ptTp" placeholder="take-profit ${long ? '>' : '<'} ${px(m.mark)}" inputmode="decimal">
    <input id="ptSl" placeholder="stop-loss ${long ? '<' : '>'} ${px(m.mark)}" inputmode="decimal">
    <button class="tbtn" id="ptSet">Set</button> <button class="tbtn" id="ptX">✕</button>
    <span class="dim" id="ptHint"></span>`;
  const hint = () => {
    const e = +pos.entryPx, sz = Math.abs(+pos.szi), dir = long ? 1 : -1;
    const at = (p) => (p > 0 ? usd((p - e) * sz * dir) : null);
    const a = at(+$('ptTp').value), b = at(+$('ptSl').value);
    $('ptHint').textContent = [a && `TP pays ${a}`, b && `SL ${b}`].filter(Boolean).join(' · ');
  };
  $('ptTp').oninput = $('ptSl').oninput = hint;
  $('ptX').onclick = () => { tool.style.display = 'none'; };
  $('ptSet').onclick = async () => {
    if (m.venue) {
      const tp = $('ptTp').value.trim(), sl = $('ptSl').value.trim();
      if (!tp && !sl) { $('msg').innerHTML = '<span class="err">enter a take-profit or a stop-loss</span>'; return; }
      if (await vsend(() => sessionOf(m).setTpsl(nat(m), { tp: tp || null, sl: sl || null, long }), `setting TP/SL on ${m.label}`, m.venue)) tool.style.display = 'none';
      return;
    }
    let req;
    try { req = positionTpslOrders(m, positionFor(coin)?.szi, { tp: $('ptTp').value, sl: $('ptSl').value }); } catch (err) { $('msg').innerHTML = `<span class="err">${esc(err.message)}</span>`; return; }
    if (await send(() => C.exchange.order(req), `setting TP/SL on ${coin}`)) tool.style.display = 'none';
  };
  $('ptTp').focus();
}

// fills pop up in the corner, wherever they came from (this page, the HL app, a TP/SL)
function toast(text, kind = '', ms = 5000, onClick = null) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = text;
  t.onclick = () => { onClick?.(); t.remove(); };
  $('toasts').prepend(t);
  setTimeout(() => t.classList.add('gone'), ms);
  setTimeout(() => t.remove(), ms + 600);
}

// --- price alerts + the tab title ------------------------------------------------
// Alerts are checked on every price the page receives: all markets from the
// asset-context stream, and the open market from the best bid/offer stream as
// well (several times a second). Both arrive over the WebSocket, which keeps
// running in a background tab, and so does the sound once the audio context
// has been started by a click. See src/priceAlerts.js.
let alerts = store.get('perps.alerts', []);
const alertCfg = { tone: 'chime', vol: 0.6, times: 3, fillSound: false, notify: false, ...store.get('perps.alertCfg', {}) };
const sound = createSound();
let livePx = null, lastTitlePx = null, tickDir = 0, titleAt = 0, titleTimer = 0, flash = null, alertsDrawn = 0;
const saveAlerts = () => store.set('perps.alerts', alerts);
const saveAlertCfg = () => store.set('perps.alertCfg', alertCfg);

// classical music in the top bar (src/classical.js): this page only
const music = createMusicPlayer({
  play: $('musPlay'), next: $('musNext'), mute: $('musMute'), now: $('musNow'),
  vol: $('musVol'), shuffle: $('musShuffle'), list: $('musTracks'), composers: $('musComposers'),
}, store);
$('musList').onclick = (e) => { e.stopPropagation(); $('musPanel').classList.toggle('hidden'); };
$('musNow').onclick = () => $('musPanel').classList.toggle('hidden');
// (a click on a row the panel just redrew is no longer in the page: not an outside click)
document.addEventListener('click', (e) => { if (e.target.isConnected && !e.target.closest('#music')) $('musPanel').classList.add('hidden'); });

// browsers only allow sound after a gesture on the page
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => { sound.unlock(); setTimeout(paintLock, 50); }, true);
function paintLock() { $('alertLock').classList.toggle('hidden', sound.ready || alertCfg.tone === 'off'); }

function tickPx(m, bid, ask) {
  if (sel !== m || !(bid > 0) || !(ask > 0)) return;
  livePx = (bid + ask) / 2;
  runAlerts(m.coin, livePx);
  paintTitle();
}

function runAlerts(coin, price) {
  if (!alerts.length) return;
  const { fired, keep, changed } = checkAlerts(alerts, coin, price);
  if (!changed) return;
  alerts = keep; saveAlerts();
  for (const a of fired) fireAlert(a);
  paintAlertPanel(); if (sel?.coin === coin) paintChartAccount();
  if (tab === 'alerts') renderAlertsTab();
}

function fireAlert(a) {
  const label = byCoin.get(a.coin)?.label || a.coin;
  const up = a.dir === 'above';
  const text = `🔔 ${label} ${up ? 'reached' : 'fell to'} ${px(a.px)} · now ${px(a.at)}${a.note ? ' · ' + a.note : ''}`;
  toast(text, 'alert', 20000, () => { if (sel?.coin !== a.coin) select(a.coin); });
  if (alertCfg.tone !== 'off') { music.duck(1500 * alertCfg.times + 1500); if (!sound.alert(up, alertCfg)) paintLock(); }
  flash = { text: `🔔 ${label} ${up ? '≥' : '≤'} ${px(a.px)}`, until: Date.now() + (document.hidden ? 60000 : 8000) };
  paintTitle(true);
  if (alertCfg.notify && document.hidden && globalThis.Notification?.permission === 'granted') {
    try { new Notification(`${label} ${up ? 'reached' : 'fell to'} ${px(a.px)}`, { body: `now ${px(a.at)}${a.note ? ' · ' + a.note : ''}`, tag: 'perps-' + a.id }); } catch { /* blocked */ }
  }
}

function addAlert(coin, target, { repeat = $('alertRepeat').checked, note = $('alertNote').value } = {}) {
  const m = byCoin.get(coin);
  const cur = coin === sel?.coin && livePx ? livePx : m?.mid;
  // a level the exchange can actually print (5 significant figures, the market's decimals)
  try { if (m) target = +formatPrice(String(+target.toPrecision(12)), m.szDecimals); } catch { /* keep as typed */ }
  try {
    const a = makeAlert(coin, target, cur, { repeat, note });
    alerts = [...alerts, a]; saveAlerts();
    sound.unlock(); paintLock();
    toast(`🔔 alert set: ${m?.label || coin} ${a.dir} ${px(a.px)}${a.repeat ? ' (repeats)' : ''}`, 'alert', 3000);
    $('alertPx').value = ''; $('alertNote').value = '';
    paintAlertPanel(); paintChartAccount(); if (tab === 'alerts') renderAlertsTab();
    return true;
  } catch (e) { toast(e.message, 'down'); return false; }
}
function removeAlert(id) {
  alerts = alerts.filter((a) => a.id !== id); saveAlerts();
  paintAlertPanel(); paintChartAccount(); if (tab === 'alerts') renderAlertsTab();
}
function addFromPanel() {
  if (!sel) return;
  const cur = livePx || sel.mid;
  try { addAlert(sel.coin, parseTarget($('alertPx').value, cur)); } catch (e) { toast(e.message, 'down'); }
}

const alertLine = (a) => {
  const m = byCoin.get(a.coin);
  const now = a.coin === sel?.coin && livePx ? livePx : m?.mid;
  const dist = now ? ((a.px - now) / now) * 100 : null;
  return { label: m?.label || a.coin, now, dist };
};
function paintAlertPanel() {
  const n = alerts.length;
  $('nAl').textContent = n ? `(${n})` : '';
  if (!sel) return;
  const mine = alerts.filter((a) => a.coin === sel.coin);
  $('alertBtn').classList.toggle('has', mine.length > 0);
  $('alertBtn').textContent = mine.length ? `🔔 ${mine.length}` : '🔔 alert';
  $('alertTitle').textContent = `PRICE ALERT · ${sel.label}`;
  $('alertNow').textContent = px(livePx || sel.mid);
  $('alertList').innerHTML = mine.length ? mine.sort((a, b) => b.px - a.px).map((a) => {
    const { dist } = alertLine(a);
    return `<div class="arow"><span><span class="${a.dir === 'above' ? 'up' : 'down'}">${a.dir === 'above' ? '▲' : '▼'}</span> ${px(a.px)}
      <span class="dim">${dist == null ? '' : pct(dist, Math.abs(dist) < 0.1 ? 3 : 2)}${a.repeat ? ' · ↻' + (a.armed ? '' : ' waiting') : ''}${a.note ? ' · ' + esc(a.note) : ''}</span></span>
      <button class="tbtn" data-delalert="${esc(a.id)}">✕</button></div>`;
  }).join('') : '<div class="dim">no alerts on this market</div>';
}
function renderAlertsTab() {
  alertsDrawn = Date.now();
  const body = $('bBody');
  if (!alerts.length) { body.innerHTML = '<div class="empty">no price alerts. Press <b>🔔 alert</b> next to the price, <kbd>A</kbd>, or shift-click the chart.</div>'; return; }
  const rows = alerts.slice().sort((a, b) => Math.abs(alertLine(a).dist ?? 1e9) - Math.abs(alertLine(b).dist ?? 1e9));
  body.innerHTML = `<div style="padding:8px 10px 0;text-align:right"><button class="tbtn" data-clearalerts="1">Remove All (${alerts.length})</button></div><table class="table"><tr><th>Coin</th><th>When</th><th>Price</th><th>Now</th><th>Distance</th><th>Type</th><th>Note</th><th>Set</th><th></th></tr>${rows.map((a) => {
    const { label, now, dist } = alertLine(a);
    return `<tr><td><a href="#" data-sel="${esc(a.coin)}" style="color:var(--text)">${esc(label)}</a></td>
      <td class="${a.dir === 'above' ? 'up' : 'down'}">${a.dir === 'above' ? '▲ Rises to' : '▼ Falls to'}</td><td>${px(a.px)}</td><td>${px(now)}</td>
      <td class="dim">${dist == null ? '—' : pct(dist, Math.abs(dist) < 0.1 ? 3 : 2)}</td><td>${a.repeat ? (a.armed ? 'repeat' : 'repeat · re-arms when back') : 'once'}</td>
      <td class="dim">${esc(a.note || '')}</td>
      <td class="dim">${new Date(a.created).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</td>
      <td class="x"><button class="tbtn" data-delalert="${esc(a.id)}">✕</button></td></tr>`;
  }).join('')}</table>`;
}

// The tab text, e.g. "▲ 97,123.5 BTC +1.23% · +$12.30". At most 5 a second;
// a background tab still gets it, because this runs off the socket, not a frame.
function paintTitle(now = false) {
  if (!sel) return;
  const t = Date.now();
  if (!now && t - titleAt < 200) { if (!titleTimer) titleTimer = setTimeout(() => { titleTimer = 0; paintTitle(); }, 200); return; }
  titleAt = t;
  pc.setPnl(positionPnl(positionFor(sel.coin), livePx || sel.mid));
  if (flash && t < flash.until) {
    // alternate the alert and the price each second so both stay visible
    document.title = Math.floor(t / 1000) % 2 ? flash.text : flash.text + ' · ' + px(livePx || sel.mid);
    if (!titleTimer) titleTimer = setTimeout(() => { titleTimer = 0; paintTitle(); }, 1000);
    return;
  }
  flash = null;
  const price = livePx || sel.mid;
  if (lastTitlePx != null && price !== lastTitlePx) {
    const d = price > lastTitlePx ? 1 : -1;
    if (d !== tickDir) { tickDir = d; paintFavicon(); }
  }
  lastTitlePx = price;
  const pos = positionFor(sel.coin);
  const pnl = pos ? +pos.szi * (price - +pos.entryPx) : null;
  document.title = titleText({ price, label: sel.label, change: sel.change, tick: tickDir, pnl, fmt: px });
}
function paintFavicon() {
  const color = tickDir > 0 ? '%234ade80' : tickDir < 0 ? '%23f87171' : '%238a93a1';
  const shape = tickDir < 0 ? '10,25 90,25 50,85' : '10,75 90,75 50,15';
  $('favicon').href = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><polygon points='${shape}' fill='${color}'/></svg>`;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && flash) flash.until = Math.min(flash.until, Date.now() + 3000);
});

// the panel
$('alertBtn').onclick = (e) => { e.stopPropagation(); toggleAlertPanel(); };
function toggleAlertPanel(open) {
  const p = $('alertPanel');
  const show = open ?? p.classList.contains('hidden');
  p.classList.toggle('hidden', !show);
  if (show) { paintAlertPanel(); paintLock(); $('alertPx').focus(); }
}
document.addEventListener('click', (e) => { if (!e.target.closest('#alertPanel') && !e.target.closest('#alertBtn')) $('alertPanel').classList.add('hidden'); });
$('alertPanel').onclick = (e) => {
  const q = e.target.closest('[data-q]'); if (q) { $('alertPx').value = q.dataset.q; $('alertPx').focus(); return; }
  const d = e.target.closest('[data-delalert]'); if (d) removeAlert(d.dataset.delalert);
};
$('alertAdd').onclick = addFromPanel;
$('alertTone').value = alertCfg.tone; $('alertTimes').value = String(alertCfg.times); $('alertVol').value = alertCfg.vol;
$('alertFill').checked = alertCfg.fillSound; $('alertNotify').checked = alertCfg.notify && globalThis.Notification?.permission === 'granted';
$('alertTone').onchange = () => { alertCfg.tone = $('alertTone').value; saveAlertCfg(); paintLock(); if (alertCfg.tone !== 'off') sound.alert(true, { ...alertCfg, times: 1 }); };
$('alertTimes').onchange = () => { alertCfg.times = +$('alertTimes').value; saveAlertCfg(); };
$('alertVol').onchange = () => { alertCfg.vol = +$('alertVol').value; saveAlertCfg(); sound.alert(true, { ...alertCfg, times: 1 }); };
$('alertTest').onclick = () => { sound.unlock(); setTimeout(() => { if (!sound.alert(true, alertCfg)) paintLock(); }, 60); };
$('alertFill').onchange = () => { alertCfg.fillSound = $('alertFill').checked; saveAlertCfg(); if (alertCfg.fillSound) sound.fill(alertCfg.vol); };
$('alertNotify').onchange = async () => {
  const box = $('alertNotify');
  if (box.checked && globalThis.Notification && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission().catch(() => 'denied');
    if (p !== 'granted') { box.checked = false; toast('the browser blocked notifications for this page', 'down'); }
  }
  alertCfg.notify = box.checked; saveAlertCfg();
};

// unified account: every exchange margins from one balance
function paintUnify() {
  const el = $('unifyNote');
  const show = !V && wallet && sel?.dex && abstraction && abstraction !== 'unifiedAccount' && abstraction !== 'portfolioMargin';
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
  $('marginMode').textContent = cross ? 'Cross' : 'Isolated';
}
$('lev').oninput = () => { paintLev(); paintSummary(); };
$('levPill').onclick = () => $('levBox').classList.toggle('hidden');
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
  // a venue adapter has no max-size read: size from available margin × leverage
  const venueMax = V && canTrade() ? (+(userStates.get(sel.dex)?.withdrawable || 0) * (sel.spot ? 1 : +$('lev').value)) / refPx() : null;
  if (!assetData && !(venueMax > 0)) { $('msg').innerHTML = `<span class="err">${canTrade() ? 'no balance to size from' : 'sign in to size from your balance'}</span>`; return; }
  const maxCoins = assetData ? +assetData.maxTradeSzs[side === 'long' ? 0 : 1] : venueMax;
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
// the wallet's own rates once signed in, Hyperliquid's base tier until then
const feeRate = () => {
  if (V) { const f = vstate.get(V.id)?.fees || V.fees || { taker: 0.0005, maker: 0.0002 }; return +(otype === 'market' ? f.taker : f.maker); }
  return +(otype === 'market' ? fees?.userCrossRate ?? 0.00045 : fees?.userAddRate ?? 0.00015);
};
function paintSummary() {
  const go = $('goBtn');
  go.textContent = canTrade() ? 'Place Order' : V ? `Sign In to ${V.name}` : 'Sign In to Trade';
  go.title = (side === 'long' ? 'Buy / Long ' : 'Sell / Short ') + (sel?.label || '');
  paintTicketAcct();
  const el = $('summary');
  if (!sel) { el.innerHTML = ''; return; }
  const lev = +$('lev').value;
  let s = 0; try { s = ticketSize(); } catch { /* blank */ }
  const notional = s * refPx();
  const liqDist = 1 / lev;                 // rough: ignores maintenance margin
  const liq = side === 'long' ? refPx() * (1 - liqDist * 0.9) : refPx() * (1 + liqDist * 0.9);
  $('sizeHint').textContent = s ? `${s} ${sel.label}` : `min lot ${1 / 10 ** sel.szDecimals}`;
  el.innerHTML = `
    <div>Liquidation Price <b>${notional ? '~' + px(liq) : 'N/A'}</b></div>
    <div>Order Value <b>${notional ? usd(notional) : 'N/A'}</b></div>
    <div>Margin Required <b>${notional ? usd(notional / lev) : 'N/A'}</b></div>
    <div>${otype === 'market' ? `Fills Up To <b>${px(sel.mid * (side === 'long' ? 1 + slip() / 100 : 1 - slip() / 100))}</b>` : `Rests At <b>${px(refPx())}</b>`}</div>
    ${!sel.dex ? `<div>Fees <b>${(feeRate() * 100).toFixed(4)}%${notional ? ' · ~' + usd(notional * feeRate(), notional * feeRate() < 1 ? 3 : 2) : ''}</b></div>` : `<div>Fees <b>set by ${esc(sel.dexName)}</b></div>`}
    ${assetData ? `<div>Max Size This Side <b>${(+assetData.maxTradeSzs[side === 'long' ? 0 : 1]).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${esc(sel.label)}</b></div>` : ''}`;
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
    // a group can half-succeed: the entry fills and its TP is refused. Show each.
    const per = Array.isArray(e?.response?.response?.data?.statuses) ? orderOutcome(e.response) : null;
    msg.innerHTML = per && per.some((o) => o.ok)
      ? per.map((o, i) => `<div class="${o.ok ? 'up' : 'err'}">${per.length > 1 ? ['entry', 'take-profit', 'stop-loss'][i] ?? `order ${i + 1}` : ''} ${esc(o.ok ? o.text : hlError({ response: { status: 'err', response: o.text } }))}</div>`).join('')
      : `<span class="err">${esc(hlError(e))}</span>`;
    setTimeout(loadAssetData, 600);
    return false;
  }
}

$('goBtn').onclick = async () => {
  if (!sel) return;
  if (!canTrade()) { showKeyModal(V?.id || null); return; }
  const go = $('goBtn');
  if (V) {
    const vs = sessionOf(sel);
    let sz;
    try { sz = ticketSize(); } catch (e) { $('msg').innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }
    if (otype === 'limit' && !(+$('limitPx').value > 0)) { $('msg').innerHTML = '<span class="err">enter a limit price</span>'; return; }
    go.disabled = true;
    try {
      // leverage is an account setting per market: change it only when it differs
      const lev = +$('lev').value, want = `${lev}|${cross}`;
      if (!sel.spot && venueLev.get(sel.coin) !== want) {
        const ok = await vsend(() => vs.setLeverage(nat(sel), lev, cross), `setting ${lev}x ${cross ? 'cross' : 'isolated'}`);
        if (!ok) return;
        venueLev.set(sel.coin, want);
      }
      await vsend(() => vs.order({
        coin: nat(sel), isBuy: side === 'long', sz, type: otype, px: +$('limitPx').value, slippage: slip(), reduceOnly: $('reduce').checked,
        tp: $('tpslOn').checked ? $('tp').value || null : null, sl: $('tpslOn').checked ? $('sl').value || null : null,
      }), `${side === 'long' ? 'buying' : 'selling'} ${sel.label} on ${V.name}`);
    } finally { go.disabled = false; }
    return;
  }
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

// --- PnL cards -----------------------------------------------------------------
// The editor keeps its settings (and an uploaded background) in this browser.
// An open position's card follows the live mark while the editor is open.
const card = { kind: null, coin: null, oid: null, data: null, img: null, timer: 0 };
let cardOpts = { ...CARD_DEFAULTS, ...store.get('perps.card', {}) };
const ACCENTS = ['#4ade80', '#f87171', '#facc15', '#60a5fa', '#c084fc', '#f472b6', '#ffffff'];
try { cardOpts.image = localStorage.getItem('perps.cardImg') || null; } catch { cardOpts.image = null; }
function saveCardOpts() {
  const { image, ...rest } = cardOpts;
  store.set('perps.card', rest);
  try { image ? localStorage.setItem('perps.cardImg', image) : localStorage.removeItem('perps.cardImg'); } catch { /* too big or private mode: kept for this visit */ }
}
function cardData() {
  if (card.kind === 'pos') {
    const p = positionFor(card.coin);
    return p ? cardFromPosition(p, byCoin.get(card.coin)?.mark ?? +p.entryPx) : card.data;
  }
  const t = closedTrades(allFills()).find((x) => x.coin === card.coin && String(x.oid) === String(card.oid));
  if (!t) return null;
  const lev = +$('cardLev').value || 1;
  return { ...t, lev, roe: closedRoe(t, lev) };
}
function paintCard() {
  const d = cardData();
  if (!d) { $('cardMsg').innerHTML = '<span class="err">that position or trade is gone</span>'; return; }
  card.data = d;
  drawPnlCard($('cardCanvas').getContext('2d'), d, cardOpts, cardOpts.style === 'image' ? card.img : null);
}
function cardControls() {
  $('cardStyle').innerHTML = Object.entries(CARD_STYLES).map(([k, l]) => `<button data-v="${k}" class="${cardOpts.style === k ? 'on' : ''}">${l}</button>`).join('');
  $('cardImgWrap').style.display = cardOpts.style === 'image' ? '' : 'none';
  $('cardDim').value = cardOpts.dim; $('cardDimVal').textContent = cardOpts.dim + '%';
  $('cardAccent').innerHTML = `<button class="auto ${cardOpts.accent === 'auto' ? 'on' : ''}" data-c="auto">auto</button>`
    + ACCENTS.map((c) => `<button data-c="${c}" class="${cardOpts.accent === c ? 'on' : ''}" style="background:${c}"></button>`).join('')
    + `<input type="color" id="cardPick" value="${/^#/.test(cardOpts.accent) ? cardOpts.accent : '#4ade80'}" title="any colour">`;
  $('cardPick').oninput = (e) => { cardOpts.accent = e.target.value; saveCardOpts(); cardControls(); paintCard(); };
  $('cardUsd').checked = cardOpts.showUsd; $('cardPrices').checked = cardOpts.showPrices;
  $('cardSize').checked = cardOpts.showSize; $('cardLevOn').checked = cardOpts.showLev;
  $('cardBrand').value = cardOpts.brand; $('cardHandle').value = cardOpts.handle; $('cardCaption').value = cardOpts.caption;
  $('cardLevWrap').style.display = card.kind === 'fill' ? '' : 'none';
}
async function loadCardImg() {
  card.img = null;
  if (!cardOpts.image) return;
  const im = new Image();
  im.src = cardOpts.image;
  try { await im.decode(); card.img = im; } catch { card.img = null; }
}
async function openCard(kind, coin, oid) {
  Object.assign(card, { kind, coin, oid, data: null });
  if (kind === 'fill') {
    // the leverage a closed trade had is not kept by Hyperliquid: start from
    // what this market is set to now, and let it be changed
    const p = positionFor(coin);
    $('cardLev').value = p?.leverage?.value ?? (sel?.coin === coin && assetData ? assetData.leverage.value : 1);
  }
  $('cardMsg').textContent = '';
  cardControls();
  await loadCardImg();
  $('cardModal').classList.remove('hidden');
  paintCard();
  clearInterval(card.timer);
  if (kind === 'pos') card.timer = setInterval(paintCard, 1000);
}
function closeCard() { $('cardModal').classList.add('hidden'); clearInterval(card.timer); }
$('cardClose').onclick = (e) => { e.preventDefault(); closeCard(); };
$('cardModal').onclick = (e) => { if (e.target === $('cardModal')) closeCard(); };
$('cardStyle').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  cardOpts.style = b.dataset.v; saveCardOpts(); cardControls();
  if (cardOpts.style === 'image' && !cardOpts.image) $('cardImg').click();
  paintCard();
};
$('cardAccent').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  cardOpts.accent = b.dataset.c; saveCardOpts(); cardControls(); paintCard();
};
$('cardImg').onchange = async () => {
  const file = $('cardImg').files?.[0]; if (!file) return;
  // scaled to the card's size and stored as JPEG, so it fits in local storage
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 1600 / bmp.width);
  const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  cardOpts.image = cv.toDataURL('image/jpeg', 0.85);
  cardOpts.style = 'image';
  saveCardOpts(); cardControls(); await loadCardImg(); paintCard();
};
$('cardDim').oninput = () => { cardOpts.dim = +$('cardDim').value; $('cardDimVal').textContent = cardOpts.dim + '%'; saveCardOpts(); paintCard(); };
for (const [id, key] of [['cardUsd', 'showUsd'], ['cardPrices', 'showPrices'], ['cardSize', 'showSize'], ['cardLevOn', 'showLev']]) {
  $(id).onchange = () => { cardOpts[key] = $(id).checked; saveCardOpts(); paintCard(); };
}
for (const [id, key] of [['cardBrand', 'brand'], ['cardHandle', 'handle'], ['cardCaption', 'caption']]) {
  $(id).oninput = () => { cardOpts[key] = $(id).value; saveCardOpts(); paintCard(); };
}
$('cardLev').oninput = paintCard;
const cardName = () => `${(card.data?.coin || 'pnl').replace(':', '-')}-${card.data?.long ? 'long' : 'short'}-pnl.png`;
$('cardSave').onclick = () => {
  paintCard();
  const a = document.createElement('a');
  a.href = $('cardCanvas').toDataURL('image/png'); a.download = cardName(); a.click();
};
$('cardCopy').onclick = async () => {
  paintCard();
  try {
    const blob = await new Promise((r) => $('cardCanvas').toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    $('cardMsg').innerHTML = '<span class="up">copied - paste it into X, Discord or Telegram</span>';
  } catch (err) {
    $('cardMsg').innerHTML = `<span class="err">this browser would not copy an image (${esc(err.message || err)}) - use DOWNLOAD</span>`;
  }
};


// --- top traders: the confluence view -----------------------------------------------
// Who the best Hyperliquid traders are (the public leaderboard, ranked by the
// settings in "Manage traders"), what each of them holds (their clearinghouse
// state, rescanned every 2 minutes; HIP-3 exchanges while one of their markets
// is open) and how they sit on the market on screen: the chip in the market bar,
// the Top Traders tab, and optional average-entry lines on the chart.
// See src/topTraders.js.
function ttSave() {
  store.set('perps.ttLabels', TT.labels); store.set('perps.ttAdded', TT.added);
  store.set('perps.ttHidden', [...TT.hidden]); store.set('perps.ttOpts', TT.opts); store.set('perps.ttLines', TT.lines);
}
function ttRefreshIndex() {
  const out = new Map();
  for (const r of TT.lb?.rows || []) if (!TT.hidden.has(r.addr)) out.set(r.addr, r);
  for (const a of TT.added) if (!out.has(a) && !TT.hidden.has(a)) out.set(a, { addr: a, rank: null, name: null, manual: true });
  ttIndex = out;
}
function ttWho(addr) {
  const r = ttIndex.get(addr) || { addr };
  const l = TT.labels[addr];
  return { rank: r.rank ?? null, label: l?.label || r.name || '', star: !!l?.star, manual: !!r.manual, allTime: r.pnl?.allTime ?? null };
}
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };
const usdK = (n) => (n == null || !isFinite(n) ? '—' : (n < 0 ? '-$' : '$') + big(Math.abs(n)));
const sameOpts = (a, b) => a && b && ['window', 'by', 'n', 'min'].every((k) => String(a[k]) === String(b[k]));

async function ttLoadLeaderboard(force = false) {
  if (!force && TT.lb && sameOpts(TT.lb.opts, TT.opts) && Date.now() - TT.lb.at < 6 * 3600e3) { ttRefreshIndex(); paintTT(); ttTick(); return; }
  TT.progress = 'loading the leaderboard…'; TT.err = ''; paintTT();
  try {
    const lb = await loadLeaderboard(TT.opts);
    TT.lb = { at: lb.at || Date.now(), total: lb.total, opts: { ...TT.opts }, rows: lb.rows, via: lb.via };
    store.set('perps.lb', TT.lb);
  } catch (e) { TT.err = 'could not load the leaderboard: ' + e.message; }
  TT.progress = '';
  ttRefreshIndex();
  for (const s of TT.states.values()) s.at = 0;      // a new list needs a fresh scan
  paintTT(); paintTTModal();
  ttTick();
}

async function ttScan(dex = '') {
  if (TT.busy.has(dex) || !ttIndex.size) return;
  TT.busy.add(dex);
  try {
    const prev = TT.states.get(dex)?.map;
    const map = await scanPositions(C.info, [...ttIndex.keys()], {
      dex, prev,
      onProgress: (d, n) => { if (d % 25 === 0 || d === n) { TT.progress = `reading positions${dex ? ' on ' + dex : ''} ${d}/${n}`; paintTTStatus(); } },
    });
    TT.states.set(dex, { at: Date.now(), map });
  } finally { TT.busy.delete(dex); TT.progress = ''; }
  paintTT();
  if (sel && (sel.dex || '') === dex) paintChartAccount();
}
function ttTick() {
  if (TT.lb && Date.now() - TT.lb.at > 6 * 3600e3 && !TT.progress) { ttLoadLeaderboard(true); return; }
  const maxAge = document.hidden ? 300e3 : 120e3;
  const stale = (dex) => !TT.states.has(dex) || Date.now() - TT.states.get(dex).at > maxAge;
  if (stale('')) ttScan('');
  if (!V && sel?.dex && stale(sel.dex)) ttScan(sel.dex);
}
setInterval(ttTick, 15000);

// the tracked traders' entries on one exchange (hidden ones dropped)
const ttEntries = (dex) => [...(TT.states.get(dex)?.map || [])].filter(([a]) => ttIndex.has(a));
function ttConf() {
  if (!sel || V || !TT.states.has(sel.dex || '')) return null;
  const c = confluence(ttEntries(sel.dex || ''), sel.coin, ttWho);
  // unrealised PnL at the live price rather than at the last scan
  const price = livePx || sel.mid;
  if (price > 0) {
    for (const p of c.rows) { p.unrealizedPnl = p.szi * (price - p.entryPx); p.returnOnEquity = p.marginUsed ? p.unrealizedPnl / p.marginUsed : p.returnOnEquity; }
    for (const [k, sgn] of [['long', 1], ['short', -1]]) c[k].upnl = c.rows.filter((p) => Math.sign(p.szi) === sgn).reduce((a, p) => a + p.unrealizedPnl, 0);
  }
  return c;
}

function paintTT() {
  paintTTChip();
  if (tab === 'tt') renderTT();
}
function paintTTStatus() { const el = $('ttStatus'); if (el) el.textContent = ttStatusText(); }
function ttStatusText() {
  if (TT.err) return TT.err;
  const st = TT.states.get(sel?.dex || '');
  const o = TT.lb?.opts || TT.opts;
  return `${ttIndex.size} traders · top ${o.n} by ${RANK_BY[o.by]}${o.by === 'accountValue' ? '' : ' (' + WINDOWS[o.window] + ')'}`
    + (st ? ` · positions ${ago(st.at)}` : '') + (TT.progress ? ' · ' + TT.progress : '');
}
function paintTTChip() {
  const el = $('ttChip');
  if (V) { el.classList.add('hidden'); return; }
  const c = ttConf();
  $('nTT').textContent = c?.n ? `(${c.n})` : '';
  if (!c) { el.classList.toggle('hidden', !TT.progress); el.textContent = '🧠 reading top traders…'; return; }
  el.classList.remove('hidden');
  el.innerHTML = c.n
    ? `🧠 <b>${c.n}</b> top traders · <span class="up">${c.long.n}L</span> <span class="down">${c.short.n}S</span> <span class="bias"><i style="width:${(50 + c.bias / 2).toFixed(0)}%"></i></span>`
    : '🧠 no top trader here';
}
$('ttChip').onclick = () => {
  tab = 'tt';
  for (const x of $('bTabs').children) x.classList.toggle('on', x.dataset.t === 'tt');
  TT.view = 'market'; paintAccount();
  $('bTabs').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function ttWhoCell(p) {
  return `<span class="ttwho">${p.star ? '<span class="star">★</span> ' : ''}${p.label ? `<b>${esc(p.label)}</b> ` : ''}<a class="dim" href="https://hypurrscan.io/address/${p.addr}" target="_blank" rel="noopener">${shortAddr(p.addr)}</a></span>`;
}
function renderTT() {
  ttDrawn = Date.now();
  const body = $('bBody');
  const head = `<div class="tthead">
      <div class="seg2"><button data-ttv="market" class="${TT.view === 'market' ? 'on' : ''}">This market</button><button data-ttv="all" class="${TT.view === 'all' ? 'on' : ''}">All markets</button></div>
      <span class="dim" id="ttStatus">${esc(ttStatusText())}</span>
      <span style="flex:1"></span>
      <label class="check"><input type="checkbox" id="ttLines" ${TT.lines ? 'checked' : ''}> average entries on chart</label>
      <button class="tbtn" data-ttrescan="1">↻ Rescan</button>
      <button class="tbtn" data-ttmanage="1">Manage traders</button>
    </div>`;
  if (!ttIndex.size) { body.innerHTML = head + `<div class="empty">${TT.progress ? 'loading the leaderboard…' : 'no traders tracked. Open <b>Manage traders</b> to load a ranking or add addresses.'}</div>`; return; }
  if (TT.view === 'all') {
    const rows = overview([...TT.states.keys()].flatMap((d) => ttEntries(d))).slice(0, 80);
    const dexes = [...TT.states.keys()].map((d) => d || 'main').join(', ');
    body.innerHTML = head + (rows.length ? `<table class="table"><tr><th>Market</th><th>Traders</th><th>Long</th><th>Short</th><th>Long Value</th><th>Short Value</th><th>Bias (by value)</th><th>Their uPNL</th></tr>${rows.map((x) => {
      const m = byCoin.get(x.coin);
      return `<tr class="ttrow" data-ttsel="${esc(x.coin)}"><td><b>${esc(m?.label || x.coin)}</b>${m?.dex ? ` <span class="dim">${esc(m.dex)}</span>` : ''}</td><td>${x.n}</td>
        <td class="up">${x.nLong}</td><td class="down">${x.nShort}</td><td>${usdK(x.longNtl)}</td><td>${usdK(x.shortNtl)}</td>
        <td><span class="bias" style="width:90px"><i style="width:${(50 + x.bias / 2).toFixed(0)}%"></i></span> <span class="${cls(x.bias)}">${x.bias >= 0 ? '+' : ''}${x.bias.toFixed(0)}%</span></td>
        <td class="${cls(x.upnl)}">${usdK(x.upnl)}</td></tr>`;
    }).join('')}</table><div class="empty" style="padding:8px 12px">exchanges read: ${esc(dexes)}. HIP-3 exchanges are read while you have one of their markets open.</div>` : '<div class="empty">reading positions…</div>');
    return;
  }
  const c = ttConf();
  if (V) { body.innerHTML = head + `<div class="empty">the top traders are Hyperliquid's leaderboard, so this view covers Hyperliquid markets. ${esc(sel.label)} here is a ${esc(V.name)} market; <b>All markets</b> still shows where they are crowded.</div>`; return; }
  if (!c) { body.innerHTML = head + `<div class="empty">reading ${ttIndex.size} traders' positions${sel?.dex ? ' on ' + esc(sel.dex) : ''}… about 10 seconds.</div>`; return; }
  if (!c.n) { body.innerHTML = head + `<div class="empty">none of the ${ttIndex.size} tracked traders holds ${esc(sel.label)} right now.</div>`; return; }
  const L = c.long, S = c.short;
  const sum = `<div class="ttsum">
      <div class="side2"><span class="up"><b>${L.n}</b> long</span> · ${usdK(L.notional)}<div class="dim">${L.n ? `avg entry ${px(L.avgEntry)} · ${L.avgLev.toFixed(1)}x · <span class="${cls(L.upnl)}">${usdK(L.upnl)}</span>` : '—'}</div></div>
      <div><div class="biasbar"><i style="width:${(50 + c.bias / 2).toFixed(1)}%"></i></div></div>
      <div class="side2 r"><span class="down"><b>${S.n}</b> short</span> · ${usdK(S.notional)}<div class="dim">${S.n ? `avg entry ${px(S.avgEntry)} · ${S.avgLev.toFixed(1)}x · <span class="${cls(S.upnl)}">${usdK(S.upnl)}</span>` : '—'}</div></div>
      <div class="mid">${Math.abs(c.bias) < 10 ? 'split evenly' : `<span class="${cls(c.bias)}">${Math.abs(c.bias).toFixed(0)}% net ${c.bias > 0 ? 'long' : 'short'}</span> by value`} among the top ${ttIndex.size}</div>
    </div>`;
  body.innerHTML = head + sum + `<table class="table"><tr><th>Rank</th><th>Trader</th><th>Side</th><th>Size</th><th>Position Value</th><th>Entry Price</th><th>PNL (ROE %)</th><th>Lev.</th><th>Liq. Price</th><th>Account</th><th>All-time PNL</th><th></th></tr>${c.rows.map((p) => `<tr>
      <td class="dim">${p.rank ? '#' + p.rank : p.manual ? 'added' : '—'}</td><td>${ttWhoCell(p)}</td>
      <td class="${p.szi > 0 ? 'up' : 'down'}">${p.szi > 0 ? 'Long' : 'Short'}</td><td>${Math.abs(p.szi).toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
      <td>${usdK(p.notional)}</td><td>${px(p.entryPx)}</td>
      <td class="${cls(p.unrealizedPnl)}">${usdK(p.unrealizedPnl)} (${pct(p.returnOnEquity * 100, 1)})</td>
      <td>${p.lev ? p.lev + 'x' + (p.levType === 'isolated' ? ' iso' : '') : '—'}</td><td>${p.liquidationPx ? px(p.liquidationPx) : '—'}</td>
      <td>${usdK(p.accountValue)}</td><td class="${cls(p.allTime)}">${p.allTime == null ? '—' : usdK(p.allTime)}</td>
      <td class="x"><button class="tbtn" data-ttlabel="${p.addr}" title="label this trader">✎</button><button class="tbtn" data-ttstar="${p.addr}" title="star">${p.star ? '★' : '☆'}</button></td></tr>`).join('')}</table>`;
}

function ttLabel(addr) {
  const cur = TT.labels[addr]?.label || ttIndex.get(addr)?.name || '';
  const v = prompt(`Label for ${addr}`, cur);
  if (v == null) return;
  TT.labels[addr] = { ...(TT.labels[addr] || {}), label: v.trim().slice(0, 40) };
  if (!TT.labels[addr].label && !TT.labels[addr].star) delete TT.labels[addr];
  ttSave(); paintTT(); paintTTModal();
}
function ttStar(addr) {
  const l = TT.labels[addr] || {};
  TT.labels[addr] = { ...l, star: !l.star };
  if (!TT.labels[addr].label && !TT.labels[addr].star) delete TT.labels[addr];
  ttSave(); paintTT(); paintTTModal();
}
$('bBody').addEventListener('click', (e) => {
  const v = e.target.closest('[data-ttv]'); if (v) { TT.view = v.dataset.ttv; renderTT(); return; }
  if (e.target.closest('[data-ttrescan]')) { for (const s of TT.states.values()) s.at = 0; ttTick(); paintTTStatus(); return; }
  if (e.target.closest('[data-ttmanage]')) { openTTModal(); return; }
  const lb = e.target.closest('[data-ttlabel]'); if (lb) { ttLabel(lb.dataset.ttlabel); return; }
  const st = e.target.closest('[data-ttstar]'); if (st) { ttStar(st.dataset.ttstar); return; }
  const row = e.target.closest('[data-ttsel]'); if (row && !e.target.closest('a')) { select(row.dataset.ttsel); TT.view = 'market'; }
});
$('bBody').addEventListener('change', (e) => {
  if (e.target.id === 'ttLines') { TT.lines = e.target.checked; ttSave(); paintChartAccount(); }
});

// the "Manage traders" panel
function openTTModal() {
  $('ttBy').value = TT.opts.by; $('ttWin').value = TT.opts.window; $('ttN').value = TT.opts.n; $('ttMin').value = TT.opts.min;
  $('ttModal').classList.remove('hidden'); paintTTModal();
}
function paintTTModal() {
  if ($('ttModal').classList.contains('hidden')) return;
  const lb = TT.lb;
  $('ttLbInfo').textContent = TT.err || (TT.progress ? TT.progress : lb
    ? `${lb.rows.length} ranked from ${lb.total?.toLocaleString?.('en-US') || '?'} accounts, ${ago(lb.at)}${lb.via === 'local' ? ' (trimmed by the local server)' : ''}. Reloads by itself every 6 hours.`
    : 'no ranking loaded yet');
  const q = $('ttFilter').value.trim().toLowerCase();
  const rows = [...ttIndex.values()].filter((r) => {
    if (!q) return true;
    const w = ttWho(r.addr);
    if (q === '★') return w.star;
    return r.addr.includes(q) || (w.label || '').toLowerCase().includes(q) || String(r.rank) === q.replace('#', '');
  });
  $('ttList').innerHTML = rows.slice(0, 400).map((r) => {
    const w = ttWho(r.addr);
    return `<div class="ttli"><span class="dim">${r.rank ? '#' + r.rank : 'added'}</span>
      <input data-ttl="${r.addr}" value="${esc(TT.labels[r.addr]?.label || '')}" placeholder="${esc(r.name || 'label…')}" maxlength="40">
      <a class="dim" href="https://hypurrscan.io/address/${r.addr}" target="_blank" rel="noopener">${shortAddr(r.addr)}</a>
      <span class="r hide-sm" title="account value">${usdK(r.accountValue)}</span>
      <span class="r hide-sm ${cls(r.pnl?.allTime)}" title="all-time PnL">${r.pnl ? usdK(r.pnl.allTime) : ''}</span>
      <span class="r"><button class="tbtn" data-ttstar="${r.addr}">${w.star ? '★' : '☆'}</button><button class="tbtn" data-tthide="${r.addr}" title="${r.manual ? 'remove' : 'stop tracking'}">✕</button></span></div>`;
  }).join('') || '<div class="empty">nothing matches</div>';
  $('ttHiddenInfo').innerHTML = TT.hidden.size ? `${TT.hidden.size} hidden · <a href="#" id="ttUnhide">track them again</a>` : '';
}
$('ttClose').onclick = (e) => { e.preventDefault(); $('ttModal').classList.add('hidden'); };
$('ttModal').addEventListener('click', (e) => {
  if (e.target === $('ttModal')) { $('ttModal').classList.add('hidden'); return; }
  const st = e.target.closest('[data-ttstar]'); if (st) { ttStar(st.dataset.ttstar); return; }
  const h = e.target.closest('[data-tthide]');
  if (h) {
    const a = h.dataset.tthide;
    if (TT.added.includes(a) && !TT.lb?.rows.some((r) => r.addr === a)) TT.added = TT.added.filter((x) => x !== a); else TT.hidden.add(a);
    ttSave(); ttRefreshIndex(); paintTTModal(); paintTT(); return;
  }
  if (e.target.id === 'ttUnhide') { e.preventDefault(); TT.hidden.clear(); ttSave(); ttRefreshIndex(); for (const s of TT.states.values()) s.at = 0; ttTick(); paintTTModal(); paintTT(); }
});
$('ttModal').addEventListener('change', (e) => {
  const a = e.target.dataset?.ttl; if (!a) return;
  const v = e.target.value.trim().slice(0, 40);
  TT.labels[a] = { ...(TT.labels[a] || {}), label: v };
  if (!v && !TT.labels[a].star) delete TT.labels[a];
  ttSave(); paintTT();
});
$('ttFilter').oninput = paintTTModal;
$('ttReload').onclick = () => {
  TT.opts = { window: $('ttWin').value, by: $('ttBy').value, n: Math.max(10, Math.min(1000, Math.round(+$('ttN').value) || 250)), min: Math.max(0, +$('ttMin').value || 0) };
  ttSave(); ttLoadLeaderboard(true);
};
$('ttAddBtn').onclick = () => {
  const a = $('ttAddAddr').value.trim().toLowerCase();
  if (!isAddr(a)) { toast('that is not an 0x address', 'down'); return; }
  const label = $('ttAddLabel').value.trim().slice(0, 40);
  if (!TT.added.includes(a)) TT.added = [...TT.added, a];
  TT.hidden.delete(a);
  if (label) TT.labels[a] = { ...(TT.labels[a] || {}), label };
  $('ttAddAddr').value = ''; $('ttAddLabel').value = '';
  ttSave(); ttRefreshIndex();
  for (const s of TT.states.values()) s.at = 0;
  ttTick(); paintTTModal(); paintTT();
  toast(`tracking ${label || shortAddr(a)}`, 'up', 2500);
};

// --- keyboard ------------------------------------------------------------------
//   /  search markets      B  long      S  short      M  market      L  limit
//   Enter (in size / price / TP / SL)  place the order      Esc  leave a field
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape' && !$('cardModal').classList.contains('hidden')) { closeCard(); return; }
  if (e.key === 'Escape' && !$('alertPanel').classList.contains('hidden')) { toggleAlertPanel(false); document.activeElement?.blur(); return; }
  if (typing) {
    if (e.key === 'Escape') { document.activeElement.blur(); openMarkets(false); }
    if (e.key === 'Enter' && ['size', 'limitPx', 'tp', 'sl'].includes(document.activeElement.id)) { e.preventDefault(); $('goBtn').click(); }
    if (e.key === 'Enter' && ['alertPx', 'alertNote'].includes(document.activeElement.id)) { e.preventDefault(); addFromPanel(); }
    if (e.key === 'Enter' && document.activeElement.id === 'mSearch') {
      const first = $('mList').querySelector('.mrow'); if (first) { openMarkets(false); select(first.dataset.c); $('size').focus(); }
    }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === '/') { e.preventDefault(); openMarkets(true); }
  else if (k === 'b') setSide('long');
  else if (k === 's') setSide('short');
  else if (k === 'm') setType('market');
  else if (k === 'l') { setType('limit'); $('limitPx').focus(); }
  else if (k === 'd') $('chartDraw').click();
  else if (k === 'f') pc.fit();
  else if (k === 'a') { e.preventDefault(); toggleAlertPanel(true); }
  else if (k === 'p') music.toggle();
  else if (e.key === 'Escape' && drawing) $('chartDraw').click();
});

// funding is paid on the hour: count down to it, and show the rate per year
setInterval(() => {
  if (!sel) return;
  const ms = 3600e3 - (Date.now() % 3600e3);
  const mm = String(Math.floor(ms / 60e3)).padStart(2, '0'), ss = String(Math.floor(ms / 1e3) % 60).padStart(2, '0');
  $('tNext').textContent = `00:${mm}:${ss}`;
  $('tNext').title = `${pct(sel.funding * 24 * 365 * 100, 1)} a year at this rate`;
}, 1000);

// --- boot ----------------------------------------------------------------------
// a market asked for (link or last session) whose exchange is still loading
let autoPick = null;

(async () => {
  let hlList = [];
  try { hlList = await hlMarkets(C.info); } catch (e) { toast(`could not reach Hyperliquid: ${e.message}`, 'down', 10000); }
  markets = [...hlList];
  byCoin = new Map(markets.map((m) => [m.coin, m]));
  dexTabs(); renderList(); paintAlertPanel();
  ttLoadLeaderboard();
  const want = decodeURIComponent(location.hash.slice(1)) || store.get(SEL_KEY, 'BTC');
  if (byCoin.has(want)) await select(want);
  else { await select(byCoin.has('BTC') ? 'BTC' : markets[0]?.coin); autoPick = want; }
  let pending = false, listDrawn = 0;
  const onPrices = () => {
    // the open market is checked off its own faster stream (tickPx) once that is live
    for (const coin of new Set(alerts.map((a) => a.coin))) if (!(coin === sel?.coin && livePx)) runAlerts(coin, byCoin.get(coin)?.mid);
    paintTitle();
    if (tab === 'alerts' && Date.now() - alertsDrawn > 1000) renderAlertsTab();
    if (tab === 'tt' && TT.view === 'market' && Date.now() - ttDrawn > 2500 && !document.activeElement?.closest?.('#bBody')) renderTT();
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false; renderTicker(); paintSummary();
      // the list is ~350 rows: redraw it at most every 2s, and not under the pointer
      if (Date.now() - listDrawn > 2000 && !$('mList').matches(':active')) { listDrawn = Date.now(); renderList(); }
    });
  };
  C.subs.allDexsAssetCtxs((ev) => {
    applyCtxs(hlList, ev);
    for (const [dex, ctxs] of ev.ctxs) for (const m of hlList) if (m.dex === dex) { const c = ctxs[m.asset - (m.dexIndex ? 100000 + m.dexIndex * 10000 : 0)]; if (c) m.oracle = +c.oraclePx; }
    onPrices();
  }).catch(() => { /* list stays as loaded */ });
  // Backpack's REST API only answers its own site: through the local server's proxy (serve.mjs)
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) setBackpackBase(location.origin + '/backpack');
  // every other exchange loads alongside, adding its markets to the one list when ready
  for (const [id, A] of Object.entries(VENUES)) {
    A.markets().then((list) => {
      const mine = wrapVenue(id, list);
      markets.push(...mine);
      for (const m of mine) byCoin.set(m.coin, m);
      dexTabs(); renderList();
      A.watchPrices(list, () => { for (const m of mine) syncPx(m); onPrices(); });
      if (autoPick && byCoin.has(autoPick)) select(autoPick);
    }).catch((e) => toast(`${A.name} markets: ${e.message}`, 'down', 8000));
  }
  if (loadWallet()) startUser(); else { paintAccount(); paintSummary(); }
  connectVenues();
})();
