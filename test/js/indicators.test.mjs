// Chart indicator maths (src/indicators.js) against hand-worked and published
// values. RSI is checked against the StockCharts worked example of Wilder's
// RSI(14): first value 70.53, then 66.32.
//   node test/js/indicators.test.mjs
import { sma, ema, bollinger, rsi, macd, vwap, stochRsi, atr, heikinAshi } from '../../src/indicators.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const near = (a, b, e = 1e-9) => a != null && Math.abs(a - b) <= e;
const seq = Array.from({ length: 10 }, (_, i) => i + 1);

{
  const s = sma(seq, 3);
  check(s[0] === null && s[1] === null && s[2] === 2 && s[9] === 9 && s.length === 10, 'SMA(3) of 1..10: nulls until 3 values, then the mean');
  const e = ema(seq, 3);
  // seeded with SMA(3) = 2 at index 2; on a straight line it then trails by exactly 1
  check(e[1] === null && e[2] === 2 && e.slice(2).every((v, i) => near(v, i + 2)), 'EMA(3) seeds with the SMA and tracks a straight line one step behind');
}
{
  const flat = new Array(30).fill(5);
  const b = bollinger(flat, 20, 2);
  check(b.mid[19] === 5 && b.upper[19] === 5 && b.lower[19] === 5 && b.mid[18] === null, 'Bollinger on a flat line collapses to the line');
  const bb = bollinger([1, 2, 3, 4, 5], 5, 2);
  const sd = Math.sqrt(2);                       // population sd of 1..5
  check(near(bb.upper[4], 3 + 2 * sd) && near(bb.lower[4], 3 - 2 * sd), 'Bollinger uses the population standard deviation');
  // the line needs 26 candles and its 9-period signal 8 more: 34 in all
  const m = macd(new Array(40).fill(5));
  check(m.line[39] === 0 && m.signal[39] === 0 && m.hist[39] === 0 && m.line[24] === null && m.line[25] === 0 && m.signal[32] === null && m.signal[33] === 0, 'MACD is zero on a flat line and null until the slow EMA exists');
}
{
  // the example's unrounded closes (the published RSI was computed from these)
  const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028];
  const r = rsi(closes, 14);
  check(r[13] === null && near(r[14], 70.53, 0.01) && near(r[15], 66.32, 0.01), 'RSI(14) matches the published Wilder example', `${r[14]?.toFixed(2)}, ${r[15]?.toFixed(2)}`);
  check(rsi([1, 2, 3, 4, 5, 6], 3)[5] === 100, 'RSI of a market that only rises is 100');
}
{
  const H = 3600e3, day = 86400e3;
  const cs = [
    { t: day - 2 * H, o: 10, h: 12, l: 8, c: 10, v: 1 },
    { t: day - H, o: 10, h: 22, l: 18, c: 20, v: 3 },
    { t: day, o: 20, h: 31, l: 29, c: 30, v: 2 },       // a new UTC day
  ];
  const v = vwap(cs);
  check(near(v[0], 10) && near(v[1], (10 * 1 + 20 * 3) / 4) && near(v[2], 30), 'VWAP weights typical price by volume and restarts each UTC day');
  const ha = heikinAshi(cs);
  check(near(ha[0].c, 10) && near(ha[0].o, 10) && near(ha[1].o, 10) && near(ha[1].c, 17.5) && ha[1].h === 22 && ha[1].l === 10,
    'Heikin-Ashi: close is the OHLC average, open the midpoint of the previous HA body');
  const steady = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 10, h: 11, l: 9, c: 10, v: 1 }));
  check(near(atr(steady, 14)[19], 2) && atr(steady, 14)[12] === null, 'ATR of a steady 2-point range is 2');
}
{
  const wave = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 6));
  const s = stochRsi(wave, 14);
  const ks = s.k.filter((x) => x != null), ds = s.d.filter((x) => x != null);
  check(ks.length > 50 && ks.every((x) => x >= 0 && x <= 100) && ds.every((x) => x >= 0 && x <= 100) && Math.max(...ks) > 90 && Math.min(...ks) < 10,
    'Stoch RSI stays within 0-100 and swings across it on a cycling market');
}
{
  const n = 600;
  const cs = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 9) * 5 + i * 0.01);
  const lens = [sma(cs, 20), ema(cs, 9), rsi(cs, 14), macd(cs).hist, bollinger(cs).upper].map((a) => a.length);
  check(lens.every((l) => l === n), 'every indicator returns one value per candle, so index i is always candle i');
}

console.log('');
process.exit(fails.length ? 1 : 0);
