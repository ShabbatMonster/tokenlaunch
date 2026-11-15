// Chart indicators, computed from candles ({ t, o, h, l, c, v }, oldest first).
// Every function returns an array the same length as its input, with null
// where there is not enough history yet, so index i always lines up with
// candle i.

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/// Exponential MA, seeded with the SMA of the first n values (the usual convention).
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null, seed = 0, count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      seed += v; count++;
      if (count === n) { prev = seed / n; out[i] = prev; }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/// Bollinger bands: SMA(n) +/- k population standard deviations.
export function bollinger(values, n = 20, k = 2) {
  const mid = sma(values, n);
  const upper = new Array(values.length).fill(null), lower = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    upper[i] = mid[i] + k * sd; lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

/// RSI with Wilder's smoothing.
export function rsi(values, n = 14) {
  const out = new Array(values.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast), s = ema(values, slow);
  const line = values.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
  const sig = ema(line, signal);
  const hist = line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i]));
  return { line, signal: sig, hist };
}

/// VWAP from typical price, restarting each UTC day (the usual session for
/// a 24/7 market).
export function vwap(candles) {
  const out = new Array(candles.length).fill(null);
  let day = null, pv = 0, vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = Math.floor(c.t / 86400000);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v; vol += c.v;
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return out;
}

/// Stochastic RSI: %K (smoothed) and %D.
export function stochRsi(values, n = 14, kSmooth = 3, dSmooth = 3) {
  const r = rsi(values, n);
  const raw = r.map((v, i) => {
    if (v == null || i < 2 * n - 1) return null;
    let lo = Infinity, hi = -Infinity;
    for (let j = i - n + 1; j <= i; j++) { if (r[j] == null) return null; lo = Math.min(lo, r[j]); hi = Math.max(hi, r[j]); }
    return hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100;
  });
  const smooth = (arr, m) => arr.map((_, i) => {
    if (i < m - 1) return null;
    const w = arr.slice(i - m + 1, i + 1);
    return w.some((x) => x == null) ? null : w.reduce((a, b) => a + b, 0) / m;
  });
  const k = smooth(raw, kSmooth);
  return { k, d: smooth(k, dSmooth) };
}

/// Average true range (Wilder).
export function atr(candles, n = 14) {
  const out = new Array(candles.length).fill(null);
  let prev = null, sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c));
    if (i < n) { sum += tr; if (i === n - 1) { prev = sum / n; out[i] = prev; } }
    else { prev = (prev * (n - 1) + tr) / n; out[i] = prev; }
  }
  return out;
}

/// Heikin-Ashi candles (smoothed bodies; same times and volumes).
export function heikinAshi(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const close = (c.o + c.h + c.l + c.c) / 4;
    const open = i === 0 ? (c.o + c.c) / 2 : (out[i - 1].o + out[i - 1].c) / 2;
    out.push({ t: c.t, o: open, h: Math.max(c.h, open, close), l: Math.min(c.l, open, close), c: close, v: c.v });
  }
  return out;
}
