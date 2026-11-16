// Small helpers shared by the venue adapters.

/// decimals in a step like "0.0001" or 1e-4
export function stepDecimals(step) {
  const s = String(step);
  if (/e-/i.test(s)) return +s.split(/e-/i)[1];
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.replace(/0+$/, '').length - i - 1;
}
/// round a number DOWN to a step, as a plain decimal string ("0.1" lots etc.)
export function toStep(x, step, mode = 'floor') {
  const d = stepDecimals(step);
  const st = +step;
  const n = mode === 'round' ? Math.round(x / st) * st : mode === 'ceil' ? Math.ceil(x / st - 1e-9) * st : Math.floor(x / st + 1e-9) * st;
  return n.toFixed(d);
}
