// Top Hyperliquid traders for the perps page's confluence view: who they are
// (the public leaderboard), what they hold (each one's clearinghouse state),
// and how they sit on the market you are looking at.
//
// The leaderboard is one public 39 MB JSON with every account (~48k rows) and
// no compression, so the local server (serve.mjs, hlLeaderboardProxy.mjs)
// trims it to the ranking asked for; a page opened anywhere else downloads it
// and ranks it itself. Positions have no batch endpoint: one clearinghouseState
// request per trader (weight 2), ~7 s for 250 at six at a time, well inside the
// 1200-weight-a-minute limit. HIP-3 exchanges are separate requests per dex.

export const LB_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
export const WINDOWS = { allTime: 'all time', month: '30 days', week: '7 days', day: '24 hours' };
export const RANK_BY = { pnl: 'PnL', roi: 'ROI', accountValue: 'account value', vlm: 'volume' };
export const TT_DEFAULTS = { window: 'allTime', by: 'pnl', n: 250, min: 10000 };

/// Rank raw leaderboard rows. `min` drops accounts holding less than that (a
/// big all-time PnL on an emptied account says little about today).
export function rankLeaderboard(raw, { window = 'allTime', by = 'pnl', n = 250, min = 0 } = {}) {
  const rows = [];
  for (const r of raw || []) {
    const av = +r.accountValue;
    if (!(av >= min)) continue;
    const w = Object.fromEntries(r.windowPerformances || []);
    const pick = (k) => Object.fromEntries(Object.keys(WINDOWS).map((x) => [x, +(w[x]?.[k] ?? 0)]));
    rows.push({ addr: String(r.ethAddress).toLowerCase(), name: r.displayName || null, accountValue: av, pnl: pick('pnl'), roi: pick('roi'), vlm: pick('vlm') });
  }
  const key = (r) => (by === 'accountValue' ? r.accountValue : r[by]?.[window] ?? 0);
  rows.sort((a, b) => key(b) - key(a));
  return rows.slice(0, Math.max(1, Math.min(1000, n))).map((r, i) => ({ ...r, rank: i + 1 }));
}

/// The ranked list: from the local server if it has the route, else the raw file.
export async function loadLeaderboard(opts = TT_DEFAULTS, { fetchImpl = globalThis.fetch, local = true } = {}) {
  const o = { ...TT_DEFAULTS, ...opts };
  if (local) {
    try {
      const q = new URLSearchParams({ window: o.window, by: o.by, n: o.n, min: o.min });
      const r = await fetchImpl('/api/hl-leaderboard?' + q);
      if (r.ok && /json/.test(r.headers.get('content-type') || '')) { const j = await r.json(); if (Array.isArray(j.rows)) return { ...j, via: 'local' }; }
    } catch { /* not served by serve.mjs */ }
  }
  const r = await fetchImpl(LB_URL);
  if (!r.ok) throw new Error('leaderboard: HTTP ' + r.status);
  const j = await r.json();
  return { at: Date.now(), total: j.leaderboardRows.length, opts: o, rows: rankLeaderboard(j.leaderboardRows, o), via: 'direct' };
}

const trimPos = (p) => ({
  coin: p.coin, szi: +p.szi, entryPx: +p.entryPx, positionValue: +p.positionValue, unrealizedPnl: +p.unrealizedPnl,
  returnOnEquity: +p.returnOnEquity, liquidationPx: p.liquidationPx == null ? null : +p.liquidationPx, marginUsed: +p.marginUsed,
  lev: p.leverage?.value ?? null, levType: p.leverage?.type ?? null,
});

/// Every trader's open positions on one exchange ('' = the main one). Returns
/// Map(addr -> { accountValue, positions }) with only traders that answered;
/// `prev` fills in anyone who failed this time so a hiccup doesn't empty a row.
export async function scanPositions(info, addrs, { dex = '', concurrency = 6, onProgress, prev = null } = {}) {
  const out = new Map();
  let i = 0, done = 0;
  const one = async (addr) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const s = await info.clearinghouseState(dex ? { user: addr, dex } : { user: addr });
        out.set(addr, { accountValue: +s.marginSummary.accountValue, positions: (s.assetPositions || []).map((a) => trimPos(a.position)).filter((p) => p.szi) });
        return;
      } catch { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
    }
    if (prev?.has(addr)) out.set(addr, prev.get(addr));
  };
  const worker = async () => { while (i < addrs.length) { const a = addrs[i++]; await one(a); onProgress?.(++done, addrs.length); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, addrs.length) }, worker));
  return out;
}

/// How the tracked traders sit on one market. `who(addr)` gives rank / label.
export function confluence(states, coin, who = () => ({})) {
  const longs = [], shorts = [];
  for (const [addr, st] of states || []) {
    for (const p of st.positions) {
      if (p.coin !== coin) continue;
      (p.szi > 0 ? longs : shorts).push({ addr, ...who(addr), accountValue: st.accountValue, ...p, notional: Math.abs(p.positionValue) });
    }
  }
  const side = (list) => {
    const ntl = list.reduce((a, p) => a + p.notional, 0);
    const size = list.reduce((a, p) => a + Math.abs(p.szi), 0);
    return {
      n: list.length, notional: ntl,
      // size-weighted average entry: where the group as a whole got in
      avgEntry: size ? list.reduce((a, p) => a + Math.abs(p.szi) * p.entryPx, 0) / size : null,
      upnl: list.reduce((a, p) => a + p.unrealizedPnl, 0),
      avgLev: list.length ? list.reduce((a, p) => a + (p.lev || 0), 0) / list.length : null,
    };
  };
  const L = side(longs), S = side(shorts);
  const tot = L.notional + S.notional;
  return {
    coin, long: L, short: S, n: L.n + S.n,
    // -100 (all short by value) .. +100 (all long by value)
    bias: tot ? ((L.notional - S.notional) / tot) * 100 : 0,
    rows: [...longs, ...shorts].sort((a, b) => b.notional - a.notional),
  };
}

/// Every market the tracked traders are in, most traders first.
export function overview(states) {
  const m = new Map();
  for (const [, st] of states || []) {
    for (const p of st.positions) {
      const x = m.get(p.coin) || { coin: p.coin, n: 0, nLong: 0, nShort: 0, longNtl: 0, shortNtl: 0, upnl: 0 };
      x.n++; x.upnl += p.unrealizedPnl;
      if (p.szi > 0) { x.nLong++; x.longNtl += Math.abs(p.positionValue); } else { x.nShort++; x.shortNtl += Math.abs(p.positionValue); }
      m.set(p.coin, x);
    }
  }
  return [...m.values()].map((x) => ({ ...x, bias: x.longNtl + x.shortNtl ? ((x.longNtl - x.shortNtl) / (x.longNtl + x.shortNtl)) * 100 : 0 }))
    .sort((a, b) => b.n - a.n || (b.longNtl + b.shortNtl) - (a.longNtl + a.shortNtl));
}

export const shortAddr = (a) => a.slice(0, 6) + '…' + a.slice(-4);
export const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());
