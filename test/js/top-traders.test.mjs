// Top traders (src/topTraders.js): ranking the leaderboard, the confluence
// maths for one market, and the all-markets overview.
//   node test/js/top-traders.test.mjs          offline
//   node test/js/top-traders.test.mjs --live   also rank the real leaderboard and read 5 traders' positions
import { rankLeaderboard, confluence, overview, scanPositions, LB_URL, isAddr } from '../../src/topTraders.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

const row = (addr, av, all, month, name = null) => ({
  ethAddress: addr, accountValue: String(av), displayName: name,
  windowPerformances: [['day', { pnl: '0', roi: '0', vlm: '0' }], ['week', { pnl: '0', roi: '0', vlm: '0' }], ['month', { pnl: String(month), roi: '0.1', vlm: '5' }], ['allTime', { pnl: String(all), roi: '1', vlm: '9' }]],
});
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), Cx = '0x' + 'c'.repeat(40), D = '0x' + 'D'.repeat(40);
const raw = [row(A, 50_000, 900, 10), row(B, 5_000, 5_000, 50), row(Cx, 2_000_000, 300, 700, 'Cee'), row(D, 80_000, 400, -5)];
{
  const r = rankLeaderboard(raw, { window: 'allTime', by: 'pnl', n: 10, min: 0 });
  check(r.map((x) => x.addr[2]).join('') === 'badc' && r[0].rank === 1 && r[3].rank === 4, 'ranks by all-time PnL, best first', r.map((x) => x.addr[2]).join(''));
  check(r.every((x) => x.addr === x.addr.toLowerCase()) && r.find((x) => x.name === 'Cee'), 'addresses lower-cased, display names kept');
  const m = rankLeaderboard(raw, { window: 'month', by: 'pnl', n: 2, min: 10_000 });
  check(m.length === 2 && m[0].addr === Cx && m[1].addr === A, 'min account drops small accounts; n caps the list; month window', m.map((x) => x.addr[2]).join(''));
  const v = rankLeaderboard(raw, { by: 'accountValue', n: 1 });
  check(v[0].addr === Cx && v[0].pnl.month === 700, 'rank by account value; per-window PnL carried along');
}

const pos = (coin, szi, entryPx, lev = 10) => ({ coin, szi, entryPx, positionValue: Math.abs(szi) * entryPx * 1.01, unrealizedPnl: 0, returnOnEquity: 0, liquidationPx: null, marginUsed: Math.abs(szi) * entryPx / lev, lev, levType: 'cross' });
const states = new Map([
  [A, { accountValue: 1e6, positions: [pos('BTC', 2, 60000), pos('ETH', -10, 3000)] }],
  [B, { accountValue: 5e5, positions: [pos('BTC', 1, 66000, 20)] }],
  [Cx, { accountValue: 2e6, positions: [pos('BTC', -1, 70000, 5), pos('xyz:NVDA', 100, 150)] }],
  [D, { accountValue: 1e5, positions: [] }],
]);
{
  const c = confluence(states, 'BTC', (a) => ({ label: a === A ? 'whale' : '' }));
  check(c.n === 3 && c.long.n === 2 && c.short.n === 1, 'BTC: two long, one short');
  check(near(c.long.avgEntry, (2 * 60000 + 1 * 66000) / 3), 'average entry is weighted by size', String(c.long.avgEntry));
  const L = (2 * 60000 + 66000) * 1.01, S = 70000 * 1.01;
  check(near(c.bias, ((L - S) / (L + S)) * 100, 1e-9) && c.bias > 0, 'bias: net long by value, -100..+100', c.bias.toFixed(2));
  check(c.rows[0].addr === A && c.rows[0].label === 'whale' && c.rows[0].accountValue === 1e6, 'rows: biggest position first, with who() merged in');
  check(near(c.long.avgLev, 15) && c.short.avgLev === 5, 'average leverage per side');
  check(confluence(states, 'DOGE').n === 0 && confluence(states, 'DOGE').bias === 0, 'a market nobody holds');
  check(confluence(states, 'xyz:NVDA').long.n === 1, 'HIP-3 coins match by their dex-prefixed name');
}
{
  const o = overview(states);
  check(o[0].coin === 'BTC' && o[0].n === 3 && o[0].nLong === 2 && o[0].nShort === 1, 'overview: the most-held market first');
  check(o.length === 3 && o.find((x) => x.coin === 'ETH').bias === -100, 'overview: every held market, all-short is -100');
}
check(isAddr(A) && !isAddr('0x123') && !isAddr('hello'), 'address check');

if (process.argv.includes('--live')) {
  const j = await (await fetch(LB_URL)).json();
  const r = rankLeaderboard(j.leaderboardRows, { n: 250, min: 10000 });
  check(r.length === 250 && r[0].pnl.allTime >= r[249].pnl.allTime && r.every((x) => x.accountValue >= 10000), 'live: top 250 by all-time PnL, all over $10k', `${j.leaderboardRows.length} accounts`);
  const { HttpTransport, InfoClient } = await import('@nktkas/hyperliquid');
  const info = new InfoClient({ transport: new HttpTransport() });
  const st = await scanPositions(info, r.slice(0, 5).map((x) => x.addr));
  check(st.size === 5 && [...st.values()].every((s) => s.accountValue >= 0 && Array.isArray(s.positions)), 'live: positions read for 5 traders', [...st.values()].map((s) => s.positions.length).join(','));
}
console.log('');
process.exit(fails.length ? 1 : 0);
