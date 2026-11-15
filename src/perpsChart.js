// The perps page's chart: TradingView's lightweight-charts (drag to pan,
// wheel / pinch to zoom, drag the price axis to stretch it, double-click it
// to reset) with indicators, position / order lines, fill markers and
// user-drawn horizontal lines. Candles are { t (ms), o, h, l, c, v }.
import {
  createChart, CandlestickSeries, LineSeries, HistogramSeries, AreaSeries,
  CrosshairMode, PriceScaleMode, LineStyle, createSeriesMarkers,
} from 'lightweight-charts';
import { sma, ema, bollinger, rsi, macd, vwap, stochRsi, atr, heikinAshi } from './indicators.js';

const UP = '#4ade80', DOWN = '#f87171';
const SUB_H = 110;            // px per indicator pane
export const INDICATORS = {
  vol:   { label: 'Volume', pane: false, params: [] },
  ma1:   { label: 'MA', pane: false, params: [['n', 20]], color: '#facc15' },
  ma2:   { label: 'MA', pane: false, params: [['n', 50]], color: '#fb923c' },
  ema1:  { label: 'EMA', pane: false, params: [['n', 9]], color: '#60a5fa' },
  ema2:  { label: 'EMA', pane: false, params: [['n', 21]], color: '#c084fc' },
  bb:    { label: 'Bollinger', pane: false, params: [['n', 20], ['k', 2]], color: '#94a3b8' },
  vwap:  { label: 'VWAP', pane: false, params: [], color: '#f472b6' },
  rsi:   { label: 'RSI', pane: true, params: [['n', 14]], color: '#a78bfa' },
  macd:  { label: 'MACD', pane: true, params: [['fast', 12], ['slow', 26], ['signal', 9]], color: '#60a5fa' },
  stoch: { label: 'Stoch RSI', pane: true, params: [['n', 14]], color: '#22d3ee' },
  atr:   { label: 'ATR', pane: true, params: [['n', 14]], color: '#fbbf24' },
};
export const CHART_DEFAULTS = {
  type: 'candles',           // candles | heikin | line | area
  log: false,
  on: { vol: true, ma1: false, ma2: false, ema1: true, ema2: true, bb: false, vwap: false, rsi: true, macd: false, stoch: false, atr: false },
  params: Object.fromEntries(Object.entries(INDICATORS).map(([k, d]) => [k, Object.fromEntries(d.params)])),
  showOrders: true, showFills: true,
};

const sec = (ms) => Math.floor(ms / 1000);
const fmt = (n) => {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return n.toLocaleString('en-US', { maximumFractionDigits: d });
};

export function createPerpsChart(el, legend, { onNeedOlder, onClickPrice } = {}) {
  let opts = structuredClone(CHART_DEFAULTS);
  let candles = [];
  let main = null;                 // the price series
  let ind = [];                    // [{ key, series[] }]
  let priceLines = [];             // account lines on `main`
  let userLines = [];              // drawn lines: { price, line }
  let markers = null;
  let fillMarks = [];
  let loadingOlder = false, noMoreOlder = false;
  let drawMode = false;
  let accountKey = '';

  const chart = createChart(el, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: '#8a93a1', fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace', fontSize: 11, panes: { separatorColor: '#262b33', separatorHoverColor: '#3b4453' } },
    grid: { vertLines: { color: '#1a1e24' }, horzLines: { color: '#1a1e24' } },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#5b6370', labelBackgroundColor: '#262b33' }, horzLine: { color: '#5b6370', labelBackgroundColor: '#262b33' } },
    rightPriceScale: { borderColor: '#262b33' },
    timeScale: {
      borderColor: '#262b33', timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 8,
      tickMarkFormatter: (t, type) => {
        const d = new Date(t * 1000);
        if (type <= 1) return type === 0 ? String(d.getFullYear()) : d.toLocaleDateString(undefined, { month: 'short' });
        if (type === 2) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
      },
    },
    localization: {
      priceFormatter: fmt,
      timeFormatter: (t) => new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
    },
  });

  // --- the price series and indicators ------------------------------------------
  function shown() { return opts.type === 'heikin' ? heikinAshi(candles) : candles; }
  function buildMain() {
    if (main) { chart.removeSeries(main); main = null; markers = null; priceLines = []; userLines.forEach((u) => { u.line = null; }); }
    const base = { priceLineVisible: true, lastValueVisible: true };
    if (opts.type === 'line') main = chart.addSeries(LineSeries, { ...base, color: '#e6e9ee', lineWidth: 2 });
    else if (opts.type === 'area') main = chart.addSeries(AreaSeries, { ...base, lineColor: '#e6e9ee', topColor: 'rgba(230,233,238,.18)', bottomColor: 'rgba(230,233,238,0)', lineWidth: 2 });
    else main = chart.addSeries(CandlestickSeries, { ...base, upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN });
    markers = createSeriesMarkers(main, []);
    accountKey = '';
    for (const u of userLines) u.line = main.createPriceLine(userLineOpts(u.price));
  }
  const mainPoint = (c) => (opts.type === 'line' || opts.type === 'area' ? { time: sec(c.t), value: c.c } : { time: sec(c.t), open: c.o, high: c.h, low: c.l, close: c.c });

  function computeInd(key) {
    const p = opts.params[key] || {};
    const closes = candles.map((c) => c.c);
    switch (key) {
      case 'ma1': case 'ma2': return [sma(closes, +p.n || 20)];
      case 'ema1': case 'ema2': return [ema(closes, +p.n || 9)];
      case 'bb': { const b = bollinger(closes, +p.n || 20, +p.k || 2); return [b.upper, b.mid, b.lower]; }
      case 'vwap': return [vwap(candles)];
      case 'rsi': return [rsi(closes, +p.n || 14)];
      case 'macd': { const m = macd(closes, +p.fast || 12, +p.slow || 26, +p.signal || 9); return [m.hist, m.line, m.signal]; }
      case 'stoch': { const s = stochRsi(closes, +p.n || 14); return [s.k, s.d]; }
      case 'atr': return [atr(candles, +p.n || 14)];
      case 'vol': return [candles.map((c) => c.v)];
      default: return [];
    }
  }
  const toPts = (vals, mapper = (v) => ({ value: v })) => vals.map((v, i) => (v == null ? { time: sec(candles[i].t) } : { time: sec(candles[i].t), ...mapper(v, i) }));
  const volColor = (i) => (candles[i].c >= candles[i].o ? 'rgba(74,222,128,.35)' : 'rgba(248,113,113,.35)');
  const histColor = (v) => (v >= 0 ? 'rgba(74,222,128,.6)' : 'rgba(248,113,113,.6)');

  function buildIndicators() {
    for (const x of ind) for (const s of x.series) chart.removeSeries(s);
    ind = [];
    // drop every pane but the price pane; sub-panes are rebuilt in order
    for (let i = chart.panes().length - 1; i > 0; i--) chart.removePane(i);
    let pane = 0;
    for (const [key, def] of Object.entries(INDICATORS)) {
      if (!opts.on[key]) continue;
      const pi = def.pane ? ++pane : 0;
      const line = (color, extra = {}) => chart.addSeries(LineSeries, { color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra }, pi);
      let series;
      if (key === 'vol') {
        series = [chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 0)];
        series[0].priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      } else if (key === 'bb') {
        series = [line(def.color, { lineStyle: LineStyle.Dashed }), line(def.color, { lineWidth: 1 }), line(def.color, { lineStyle: LineStyle.Dashed })];
      } else if (key === 'macd') {
        series = [chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pi), line('#60a5fa'), line('#fb923c')];
      } else if (key === 'stoch') {
        series = [line('#22d3ee'), line('#fb923c')];
      } else {
        series = [line(def.color, key === 'rsi' || key === 'atr' ? { lastValueVisible: true } : {})];
      }
      if (key === 'rsi' || key === 'stoch') {
        for (const lv of key === 'rsi' ? [70, 30] : [80, 20]) series[0].createPriceLine({ price: lv, color: '#3b4453', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
      }
      ind.push({ key, series });
    }
    // with volume on, the candles keep clear of the bottom fifth where it sits
    main?.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: opts.on.vol ? 0.22 : 0.06 } });
    // grow the chart by a fixed slice per indicator pane, then size the panes
    // once the container has actually resized (autoSize follows it a frame later)
    const subs = chart.panes().length - 1;
    el.style.height = `${440 + SUB_H * subs}px`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ps = chart.panes();
      const mainH = Math.max(220, el.clientHeight - 28 - SUB_H * (ps.length - 1));
      ps.forEach((p, i) => p.setHeight(i ? SUB_H : mainH));
    }));
    fillIndicators();
  }
  function fillIndicators() {
    for (const x of ind) {
      const vals = computeInd(x.key);
      if (x.key === 'vol') x.series[0].setData(toPts(vals[0], (v, i) => ({ value: v, color: volColor(i) })));
      else if (x.key === 'macd') {
        x.series[0].setData(toPts(vals[0], (v) => ({ value: v, color: histColor(v) })));
        x.series[1].setData(toPts(vals[1])); x.series[2].setData(toPts(vals[2]));
      } else vals.forEach((v, j) => x.series[j].setData(toPts(v)));
    }
  }
  // a live tick only moves the last bar: update just that point everywhere
  function tickIndicators() {
    const i = candles.length - 1, t = sec(candles[i].t);
    for (const x of ind) {
      const vals = computeInd(x.key);
      vals.forEach((arr, j) => {
        const v = arr[i];
        if (v == null) return;
        const color = x.key === 'vol' ? volColor(i) : x.key === 'macd' && j === 0 ? histColor(v) : undefined;
        x.series[j].update(color ? { time: t, value: v, color } : { time: t, value: v });
      });
    }
  }

  // --- legend: OHLC + indicator values under the crosshair -------------------------
  function paintLegend(i) {
    if (!legend) return;
    const c = candles[i ?? candles.length - 1];
    if (!c) { legend.innerHTML = ''; return; }
    const idx = i ?? candles.length - 1;
    const ch = c.o ? (c.c / c.o - 1) * 100 : 0;
    const col = ch >= 0 ? 'up' : 'down';
    let h = `<span>O <b class="${col}">${fmt(c.o)}</b></span><span>H <b class="${col}">${fmt(c.h)}</b></span><span>L <b class="${col}">${fmt(c.l)}</b></span><span>C <b class="${col}">${fmt(c.c)}</b></span><span class="${col}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</span><span>V <b>${c.v.toLocaleString('en-US', { maximumFractionDigits: 0 })}</b></span>`;
    for (const x of ind) {
      if (x.key === 'vol') continue;
      const d = INDICATORS[x.key];
      const vals = computeInd(x.key).map((a) => a[idx]);
      const ps = d.params.map(([k]) => opts.params[x.key]?.[k]).join(',');
      h += `<span style="color:${d.color}">${d.label}${ps ? `(${ps})` : ''} <b>${vals.map((v) => fmt(v)).join(' / ')}</b></span>`;
    }
    legend.innerHTML = h;
  }
  chart.subscribeCrosshairMove((p) => {
    if (!p.time || !candles.length) { paintLegend(); return; }
    const i = candles.findIndex((c) => sec(c.t) === p.time);
    paintLegend(i >= 0 ? i : undefined);
  });

  // --- older history as the chart is dragged left -----------------------------------
  chart.timeScale().subscribeVisibleLogicalRangeChange(async (r) => {
    if (!r || r.from > 15 || loadingOlder || noMoreOlder || !candles.length || !onNeedOlder) return;
    loadingOlder = true;
    try {
      const older = await onNeedOlder(candles[0].t);
      const fresh = (older || []).filter((c) => c.t < candles[0].t);
      if (!fresh.length) { noMoreOlder = true; return; }
      const range = chart.timeScale().getVisibleLogicalRange();
      candles = [...fresh, ...candles];
      main.setData(shown().map(mainPoint));
      fillIndicators();
      applyFillMarkers();
      if (range) chart.timeScale().setVisibleLogicalRange({ from: range.from + fresh.length, to: range.to + fresh.length });
    } finally { loadingOlder = false; }
  });

  // --- drawn lines ------------------------------------------------------------------
  const userLineOpts = (price) => ({ price, color: '#e6e9ee', lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: '' });
  chart.subscribeClick((p) => {
    if (!p.point || !main) return;
    const price = main.coordinateToPrice(p.point.y);
    if (price == null) return;
    if (!drawMode) { onClickPrice?.(price, p.sourceEvent); return; }
    // in draw mode a click on a line removes it, anywhere else adds one
    const near = userLines.findIndex((u) => Math.abs((main.priceToCoordinate(u.price) ?? -1e9) - p.point.y) < 6);
    if (near >= 0) {
      const [u] = userLines.splice(near, 1);
      if (u.line) main.removePriceLine(u.line);
    } else userLines.push({ price, line: main.createPriceLine(userLineOpts(price)) });
    api.onLinesChange?.(userLines.map((u) => u.price));
  });

  // --- account overlays --------------------------------------------------------------
  function setAccount({ entry, liq, long, orders = [], alerts = [] } = {}) {
    if (!main) return;
    const key = JSON.stringify([entry, liq, long, opts.showOrders && orders.map((o) => [o.px, o.label]), alerts.map((a) => [a.px, a.label])]);
    if (key === accountKey) return;
    accountKey = key;
    for (const l of priceLines) main.removePriceLine(l);
    priceLines = [];
    const add = (price, color, title, style = LineStyle.Dashed) => priceLines.push(main.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    if (entry) add(entry, '#a5b4fc', `entry ${long ? 'long' : 'short'}`, LineStyle.Solid);
    if (liq) add(liq, '#f97316', 'liquidation');
    if (opts.showOrders) for (const o of orders) add(o.px, o.color, o.label, LineStyle.Dotted);
    // price alerts always show: they are this browser's, not the exchange's
    for (const a of alerts) add(a.px, '#facc15', a.label, LineStyle.LargeDashed);
  }
  function setFills(list) { fillMarks = list; applyFillMarkers(); }
  function applyFillMarkers() {
    if (!markers) return;
    if (!opts.showFills || !candles.length) { markers.setMarkers([]); return; }
    const t0 = candles[0].t, step = candles.length > 1 ? candles[1].t - candles[0].t : 60e3;
    const ms = fillMarks.filter((f) => f.time >= t0).map((f) => ({
      // snap to the bar the fill happened in
      time: sec(t0 + Math.floor((f.time - t0) / step) * step),
      position: f.buy ? 'belowBar' : 'aboveBar', shape: f.buy ? 'arrowUp' : 'arrowDown',
      color: f.buy ? UP : DOWN, text: f.text || '', size: 1,
    })).sort((a, b) => a.time - b.time);
    markers.setMarkers(ms);
  }

  // --- public ------------------------------------------------------------------------
  const api = {
    chart,
    onLinesChange: null,
    setOptions(o) {
      const typeChanged = o.type && o.type !== opts.type;
      opts = { ...opts, ...o, on: { ...opts.on, ...(o.on || {}) }, params: { ...opts.params, ...(o.params || {}) } };
      chart.priceScale('right').applyOptions({ mode: opts.log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
      if (typeChanged || !main) { buildMain(); if (candles.length) main.setData(shown().map(mainPoint)); applyFillMarkers(); }
      buildIndicators();
      applyFillMarkers();
      paintLegend();
    },
    options: () => opts,
    setCandles(cs) {
      candles = cs.slice();
      noMoreOlder = false;
      if (!main) buildMain();
      main.setData(shown().map(mainPoint));
      fillIndicators(); applyFillMarkers(); paintLegend();
      chart.timeScale().scrollToRealTime();
    },
    update(k) {
      if (!main) return;
      const last = candles[candles.length - 1];
      if (last && k.t < last.t) return;
      if (last && last.t === k.t) candles[candles.length - 1] = k; else candles.push(k);
      // Heikin-Ashi bars depend on every bar before them
      main.update(mainPoint(opts.type === 'heikin' ? heikinAshi(candles).at(-1) : k));
      tickIndicators();
      paintLegend();
    },
    setAccount, setFills,
    setDrawMode(on) { drawMode = on; el.style.cursor = on ? 'crosshair' : ''; },
    setUserLines(prices) {
      for (const u of userLines) if (u.line && main) main.removePriceLine(u.line);
      userLines = (prices || []).map((price) => ({ price, line: main ? main.createPriceLine(userLineOpts(price)) : null }));
    },
    fit() { chart.timeScale().fitContent(); chart.priceScale('right').applyOptions({ autoScale: true }); },
    realtime() { chart.timeScale().scrollToRealTime(); },
  };
  return api;
}
