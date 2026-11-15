// Price alerts for the perps page: parse what was typed, decide which alerts a
// new price sets off, and make the sounds. No DOM here apart from the audio
// context, so the maths is testable in node (test/js/price-alerts.test.mjs).
//
// An alert is a level plus a side. The side is fixed when the alert is made:
// a level above the price waits for the price to reach it from below, a level
// beneath waits for it from above. A one-shot alert is removed when it fires.
// A repeating one disarms and re-arms once the price is back on its starting
// side, so a price hovering on the line does not sound on every tick.

/// "100000", "100k", "1.2m", "+2%", "-0.5%" (relative to the price now).
export function parseTarget(input, current) {
  const s = String(input ?? '').trim().toLowerCase().replace(/[,$\s]/g, '');
  if (!s) throw new Error('enter a price, or a move like +2%');
  const rel = /^([+-])(\d*\.?\d+)%$/.exec(s);
  if (rel) {
    if (!(current > 0)) throw new Error('no live price yet for a % alert');
    const p = current * (1 + (rel[1] === '-' ? -1 : 1) * +rel[2] / 100);
    if (!(p > 0)) throw new Error('that move takes the price to zero');
    return p;
  }
  const abs = /^(\d*\.?\d+)([km]?)$/.exec(s);
  if (!abs) throw new Error(`"${input}" is not a price or a % move`);
  const p = +abs[1] * (abs[2] === 'k' ? 1e3 : abs[2] === 'm' ? 1e6 : 1);
  if (!(p > 0)) throw new Error('the price must be above zero');
  return p;
}

let seq = 0;
/// A new alert. `current` decides which side it waits on.
export function makeAlert(coin, target, current, { repeat = false, note = '' } = {}) {
  if (!(target > 0)) throw new Error('the price must be above zero');
  if (!(current > 0)) throw new Error('no live price yet for ' + coin);
  if (target === current) throw new Error('that is the price right now');
  return {
    id: Date.now().toString(36) + (seq++).toString(36),
    coin, px: target, dir: target > current ? 'above' : 'below',
    repeat: !!repeat, armed: true, note: String(note || '').slice(0, 60), created: Date.now(), fired: 0,
  };
}

/// Feed one market's price in. Returns the alerts it sets off and the list to
/// keep (one-shots that fired are dropped; repeats are disarmed or re-armed).
/// `changed` says whether anything needs saving.
export function checkAlerts(alerts, coin, price) {
  if (!(price > 0)) return { fired: [], keep: alerts, changed: false };
  const fired = [];
  let changed = false;
  const keep = [];
  for (const a of alerts) {
    if (a.coin !== coin) { keep.push(a); continue; }
    const hit = a.dir === 'above' ? price >= a.px : price <= a.px;
    if (a.armed && hit) {
      fired.push({ ...a, at: price });
      changed = true;
      if (a.repeat) keep.push({ ...a, armed: false, fired: Date.now() });
      continue;
    }
    // back on the starting side: a repeating alert is ready again
    if (!a.armed && !hit) { keep.push({ ...a, armed: true }); changed = true; continue; }
    keep.push(a);
  }
  return { fired, keep, changed };
}

/// The browser tab's text: price first, because the tab is narrow.
///   ▲ 97,123.5 BTC +1.23% · +$12.30
export function titleText({ price, label, change, tick = 0, pnl = null, fmt = String }) {
  if (!(price > 0)) return `${label || ''} · perps`.trim();
  const arrow = tick > 0 ? '▲ ' : tick < 0 ? '▼ ' : '';
  const ch = change == null || !isFinite(change) ? '' : ` ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
  const p = pnl == null || !isFinite(pnl) ? '' : ` · ${pnl < 0 ? '-' : '+'}$${Math.abs(pnl).toFixed(2)}`;
  return `${arrow}${fmt(price)} ${label}${ch}${p}`;
}

// --- sound ----------------------------------------------------------------------
// Web Audio, so there is no file to load and it plays in a background tab once
// the context is running. Browsers only start a context after the user has
// clicked or typed on the page, so unlock() is called from the first gesture.

export const TONES = {
  // [frequency Hz, start s, length s] per note
  chime: { up: [[660, 0, 0.18], [880, 0.12, 0.18], [1320, 0.24, 0.35]], down: [[1320, 0, 0.18], [880, 0.12, 0.18], [660, 0.24, 0.35]], wave: 'sine' },
  beep: { up: [[1000, 0, 0.12], [1000, 0.18, 0.12]], down: [[700, 0, 0.12], [700, 0.18, 0.12]], wave: 'square' },
  alarm: { up: [[880, 0, 0.15], [1175, 0.15, 0.15], [880, 0.3, 0.15], [1175, 0.45, 0.15]], down: [[1175, 0, 0.15], [880, 0.15, 0.15], [1175, 0.3, 0.15], [880, 0.45, 0.15]], wave: 'sawtooth' },
};
const FILL_TONE = [[520, 0, 0.07], [780, 0.07, 0.1]];

export function createSound() {
  let ctx = null;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const get = () => { if (!ctx && AC) ctx = new AC(); return ctx; };
  function notes(list, wave, vol, offset = 0) {
    const c = get(); if (!c || c.state !== 'running') return false;
    const t0 = c.currentTime + 0.02 + offset;
    for (const [f, at, len] of list) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = wave; o.frequency.value = f;
      // a short attack and an exponential tail, so notes don't click
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * (wave === 'sine' ? 0.5 : 0.18)), t0 + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      o.connect(g).connect(c.destination);
      o.start(t0 + at); o.stop(t0 + at + len + 0.02);
    }
    return true;
  }
  return {
    /// call from a click or key press; true once sound can play
    unlock() { const c = get(); if (c && c.state !== 'running') c.resume().catch(() => {}); return c?.state === 'running'; },
    get ready() { return ctx?.state === 'running'; },
    /// an alert: `times` repeats of the tone, rising for a level hit from below
    alert(up, { tone = 'chime', vol = 0.6, times = 3 } = {}) {
      const t = TONES[tone] || TONES.chime;
      const list = up ? t.up : t.down;
      const span = Math.max(...list.map(([, at, len]) => at + len)) + 0.25;
      let ok = false;
      for (let i = 0; i < times; i++) ok = notes(list, t.wave, vol, i * span) || ok;
      return ok;
    },
    fill(vol = 0.6) { return notes(FILL_TONE, 'triangle', vol * 0.8); },
  };
}
