// Price alerts (src/priceAlerts.js): parsing, which side an alert waits on,
// firing, one-shot removal, repeat re-arming, and the tab title.
//   node test/js/price-alerts.test.mjs
import { parseTarget, makeAlert, checkAlerts, titleText, TONES } from '../../src/priceAlerts.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const throws = (f) => { try { f(); return false; } catch { return true; } };

check(parseTarget('100000', 1) === 100000 && parseTarget('$100,000', 1) === 100000 && parseTarget('100k', 1) === 100000 && parseTarget('1.5m', 1) === 1.5e6,
  'plain, $ and comma, k and m prices parse');
check(near(parseTarget('+2%', 50000), 51000) && near(parseTarget('-0.5%', 200), 199) && near(parseTarget('+.5%', 100), 100.5), '% moves are relative to the price now');
check(throws(() => parseTarget('', 1)) && throws(() => parseTarget('abc', 1)) && throws(() => parseTarget('0', 1)) && throws(() => parseTarget('-100%', 5)) && throws(() => parseTarget('+2%', null)),
  'empty, junk, zero, -100% and a % with no price are refused');

{
  const up = makeAlert('BTC', 100000, 97000);
  const dn = makeAlert('BTC', 90000, 97000);
  check(up.dir === 'above' && dn.dir === 'below' && up.armed && up.id !== dn.id, 'a level above the price waits for a rise, below for a fall');
  check(throws(() => makeAlert('BTC', 97000, 97000)) && throws(() => makeAlert('BTC', 1, null)), 'an alert at the price now, or with no price, is refused');

  let r = checkAlerts([up, dn], 'BTC', 99999);
  check(r.fired.length === 0 && !r.changed && r.keep.length === 2, 'nothing fires short of the level');
  r = checkAlerts([up, dn], 'ETH', 1e9);
  check(r.fired.length === 0 && r.keep.length === 2, "another market's price never fires a BTC alert");
  r = checkAlerts([up, dn], 'BTC', 100000);
  check(r.fired.length === 1 && r.fired[0].id === up.id && r.fired[0].at === 100000 && r.keep.length === 1 && r.keep[0].id === dn.id,
    'touching the level fires it, and a one-shot is then removed');
  r = checkAlerts([up, dn], 'BTC', 85000);
  check(r.fired.length === 1 && r.fired[0].id === dn.id, 'a price gapping straight through a lower level still fires it');
  check(checkAlerts([up], 'BTC', NaN).fired.length === 0 && checkAlerts([up], 'BTC', 0).fired.length === 0, 'a missing price fires nothing');
}
{
  const rep = makeAlert('SOL', 200, 190, { repeat: true });
  let list = [rep];
  const seen = [];
  for (const p of [195, 201, 202, 199.5, 200.5, 199, 203]) {
    const r = checkAlerts(list, 'SOL', p);
    list = r.keep; seen.push(r.fired.length);
  }
  // fires at 201, waits (202), re-arms at 199.5, fires at 200.5, re-arms at 199, fires at 203
  check(seen.join('') === '0100101' && list.length === 1, 'a repeat alert fires once per crossing, re-arming only after the price goes back', seen.join(''));
}
{
  const fmt = (n) => n.toLocaleString('en-US');
  check(titleText({ price: 97123.5, label: 'BTC', change: 1.234, tick: 1, fmt }) === '▲ 97,123.5 BTC +1.23%', 'title: arrow, price, market, 24h change');
  check(titleText({ price: 3.5, label: 'xyz:TSLA', change: -0.5, tick: -1, pnl: -12.3, fmt }) === '▼ 3.5 xyz:TSLA -0.50% · -$12.30', 'title: a falling tick and an open position\'s PnL');
  check(titleText({ price: null, label: 'BTC' }) === 'BTC · ShabbatLiquid', 'title: no price yet');
}
check(Object.values(TONES).every((t) => t.up.length && t.down.length && t.wave), 'every tone has a rising and a falling version');

console.log('');
process.exit(fails.length ? 1 : 0);
