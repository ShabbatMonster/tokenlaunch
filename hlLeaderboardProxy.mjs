// Hyperliquid's leaderboard is one 39 MB uncompressed JSON (every account,
// ~48k rows). The perps page only wants the top few hundred, so the local
// server downloads it, keeps the parsed rows for 15 minutes, and answers with
// the ranking asked for: a few tens of KB instead of 39 MB per browser load.
// Used by serve.mjs; the page falls back to fetching the file itself.
//
//   GET /api/hl-leaderboard?window=allTime&by=pnl&n=250&min=10000
import { rankLeaderboard, LB_URL, WINDOWS, RANK_BY, TT_DEFAULTS } from './src/topTraders.js';

const TTL_MS = 15 * 60e3;
let cache = null;          // { at, rows }
let inflight = null;

async function rawRows() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  inflight ??= (async () => {
    try {
      const r = await fetch(LB_URL);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      cache = { at: Date.now(), rows: j.leaderboardRows };
      return cache;
    } finally { inflight = null; }
  })();
  return inflight;
}

export async function handleHlLeaderboard(req, res) {
  const [path, query] = (req.url || '').split('?');
  if (path !== '/api/hl-leaderboard') return false;
  const q = new URLSearchParams(query || '');
  const opts = {
    window: q.get('window') in WINDOWS ? q.get('window') : TT_DEFAULTS.window,
    by: q.get('by') in RANK_BY ? q.get('by') : TT_DEFAULTS.by,
    n: Math.max(1, Math.min(1000, Number(q.get('n')) || TT_DEFAULTS.n)),
    min: Math.max(0, Number(q.get('min')) || 0),
  };
  try {
    const { at, rows } = await rawRows();
    const body = JSON.stringify({ at, total: rows.length, opts, rows: rankLeaderboard(rows, opts) });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' }).end(body);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'leaderboard: ' + e.message }));
  }
  return true;
}
