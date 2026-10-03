// ---------------------------------------------------------------------------
// Which Solana RPC to use.
//
// This exists because the endpoint had been copy-pasted into fifteen places
// with three different keys between them, and the only way to find out which
// ones were stale was to watch things fail. When the first two keys hit their
// quota, the app, the extension and ten test files each had their own opinion
// about what to fall back to - and the test files had none at all, so every
// chain-touching suite died on `429 max usage reached` at once.
//
// So: one list, in one place, and a probe that finds a live one.
//
// A maxed key is not a slow key. It answers 429 immediately and forever, which
// is the useful part: probing costs one cheap call and tells the truth, where
// retrying the same endpoint with a backoff just spends seconds arriving at the
// same answer. web3.js retries in exactly that unhelpful way, which is why
// moving endpoint beats waiting.
// ---------------------------------------------------------------------------

/// The three Helius keys, newest first because the older two have been maxed
/// before and the newest is the one most likely to have headroom.
export const HELIUS_RPCS = [
  'https://mainnet.helius-rpc.com/?api-key=6ae075bc-0892-4f8e-aa49-ec3e1a82db78',
  'https://mainnet.helius-rpc.com/?api-key=ae11f74a-b518-408b-bc88-524c277da375',
  'https://mainnet.helius-rpc.com/?api-key=3fb08d49-71d7-492b-84f1-9ff0e3eb95ea',
];

/// Last resort, and deliberately last. It serves plain reads (getAccountInfo,
/// getLatestBlockhash) but rate-limits or outright refuses the big ones this
/// repo leans on - getProgramAccounts above all - so it is a way to stay up for
/// simple work rather than a real substitute.
export const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

export const SOL_RPCS = [...HELIUS_RPCS, PUBLIC_RPC];
export const SOL_RPC = HELIUS_RPCS[0];
export const SOL_RPC_FALLBACKS = SOL_RPCS.slice(1);

/// Endpoints that can serve a getProgramAccounts scan, which the public one
/// cannot. Anything that sweeps the chain should pick from here.
export const SCAN_RPCS = HELIUS_RPCS;

const PROBE_TTL_MS = 60_000;
let cached = null;

/// Is this endpoint answering right now?
///
/// getLatestBlockhash because it is cheap, needs no arguments and still counts
/// against a quota - so a maxed key fails it, which is the whole point. A
/// non-2xx is a no rather than a throw: 429 lands here and we move on.
export async function probeRpc(url, timeoutMs = 2500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }],
      }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j?.result;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/// The first endpoint that answers, cached briefly.
///
/// Cached because a quota is a cliff rather than a slope - once a key is maxed
/// it stays maxed - but only briefly, because the reverse is also true: quotas
/// reset, and a run that started on the public endpoint should not be stuck
/// there. When nothing answers it returns the first candidate anyway, so the
/// caller gets a real RPC error instead of an error about picking one.
export async function healthyRpc({ urls = SOL_RPCS, scanning = false } = {}) {
  const list = scanning ? urls.filter((u) => u !== PUBLIC_RPC) : urls;
  const candidates = list.length ? list : urls;
  if (cached && Date.now() - cached.at < PROBE_TTL_MS && candidates.includes(cached.url)) return cached.url;
  for (const url of candidates) {
    if (await probeRpc(url)) {
      cached = { url, at: Date.now() };
      return url;
    }
  }
  return candidates[0];
}

/// Drop the cache, for a caller that has just been told the endpoint is dead.
export const forgetRpc = () => { cached = null; };

/// Which of them are actually alive, for reporting rather than choosing.
export async function rpcStatus(urls = SOL_RPCS) {
  const out = [];
  for (const url of urls) out.push({ url, ok: await probeRpc(url) });
  return out;
}

/// A short name for an endpoint, safe to show: the host plus the first chunk of
/// the key, never the whole thing.
export const rpcLabel = (url) => {
  try {
    const u = new URL(url);
    const key = u.searchParams.get('api-key');
    return u.host + (key ? ` (${key.slice(0, 8)}…)` : '');
  } catch {
    return String(url);
  }
};
