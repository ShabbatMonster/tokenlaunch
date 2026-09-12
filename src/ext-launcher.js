// ---------------------------------------------------------------------------
// The half of the j7 fallback extension that actually spends money.
//
// This is bundled into the extension's service worker, and it is the ONLY
// place the private key is ever touched. The content script running inside
// j7tracker.io never receives it, never sees it, and cannot ask for it - it can
// only post a set of scraped launch parameters here. That split is the whole
// security design: a page that turns hostile can at worst ask for a launch it
// can already see you setting up, not for your key.
// ---------------------------------------------------------------------------

import {
  launchPump, pumpStatus, pumpWarmup, launchRaydium, solAddressFromSecret,
  BONK_PLATFORM_ID, STONK_PLATFORM_ID, RAYDIUM_PLATFORM_ID,
} from './solana.js';

export { launchPump, pumpStatus, pumpWarmup, launchRaydium, solAddressFromSecret };

export const WSOL = 'So11111111111111111111111111111111111111112';

// j7's pad buttons, mapped onto the launch paths this repo can actually drive.
// Anything not listed is reported as uncovered rather than quietly launched
// somewhere else - a fallback that deploys your coin on the wrong venue is
// worse than one that refuses.
export const VENUES = {
  pump: { label: 'Pump', kind: 'pump' },
  bonk: { label: 'BONK', kind: 'launchlab', platformId: BONK_PLATFORM_ID },
  stonk: { label: 'Stonk', kind: 'launchlab', platformId: STONK_PLATFORM_ID },
  raydium: { label: 'Raydium', kind: 'launchlab', platformId: RAYDIUM_PLATFORM_ID },
};

export const UNSUPPORTED_VENUES = {
  otc: 'OTC is not one of the launch paths this tool implements',
  usd1: 'USD1 is a quote token here, not a venue - pick a pad and set the pair to USD1',
  ansem: 'the Ansem pad is not implemented',
  'four.meme': 'four.meme is BNB Chain, which needs an EVM key rather than your Solana one',
  o1: 'the o1 pad is not implemented',
  eth: 'ETH pads are EVM, which needs an EVM key rather than your Solana one',
  flap: 'Flap is BNB Chain, which needs an EVM key rather than your Solana one',
  pons: 'Pons is Robinhood Chain, which needs an EVM key rather than your Solana one',
  pools: 'Pools is Robinhood Chain, which needs an EVM key rather than your Solana one',
};

/// Pin the image and the token metadata, returning the URI a launch wants.
///
/// pump.fun's own pinner is tried first because it returns metadata in exactly
/// the shape pump expects and is what their frontend uses. The generic IPFS
/// path is the fallback for when that endpoint is unreachable or rate-limited.
export async function uploadMetadata(meta, onStatus) {
  const say = (m) => onStatus && onStatus(m);
  const { name, symbol, description, imageDataUrl, twitter, website, telegram } = meta;

  let imageBlob = null;
  if (imageDataUrl) {
    try { imageBlob = await (await fetch(imageDataUrl)).blob(); } catch { imageBlob = null; }
  }

  say('pinning metadata…');
  try {
    const fd = new FormData();
    if (imageBlob) fd.append('file', imageBlob, 'image.png');
    fd.append('name', name || '');
    fd.append('symbol', symbol || '');
    fd.append('description', description || '');
    fd.append('twitter', twitter || '');
    fd.append('telegram', telegram || '');
    fd.append('website', website || '');
    fd.append('showName', 'true');
    const r = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: fd });
    if (r.ok) {
      const j = await r.json();
      if (j?.metadataUri) { say('metadata pinned'); return j.metadataUri; }
    }
  } catch { /* fall through to the generic pinner */ }

  say('pump.fun pinner unavailable, using IPFS directly…');
  const add = async (blob, filename) => {
    const fd = new FormData();
    fd.append('file', blob, filename);
    const r = await fetch('https://api.thegraph.com/ipfs/api/v0/add', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('IPFS upload failed (' + r.status + ')');
    const { Hash } = await r.json();
    if (!Hash) throw new Error('IPFS upload returned no hash');
    return 'https://ipfs.io/ipfs/' + Hash;
  };

  const image = imageBlob ? await add(imageBlob, 'image.png') : '';
  const doc = {
    name: name || '', symbol: symbol || '', description: description || '',
    image, showName: true,
    ...(twitter ? { twitter } : {}), ...(website ? { website } : {}), ...(telegram ? { telegram } : {}),
  };
  const uri = await add(new Blob([JSON.stringify(doc)], { type: 'application/json' }), 'metadata.json');
  say('metadata pinned');
  return uri;
}

function need(v, what) {
  if (v === undefined || v === null || String(v).trim() === '') throw new Error(`j7 panel had no ${what}`);
  return String(v).trim();
}

/// Run the launch the panel was set up for.
///
/// `params` is whatever the content script could read off j7 - it is treated as
/// untrusted input from a page, so everything is validated here rather than
/// assumed. Returns { mint, signature, venue }.
export async function deployMirrored(opts) {
  const { params, secretKey, rpcUrl, simulateOnly = false, preloaded, onStatus } = opts;
  const say = (m) => onStatus && onStatus(m);

  const venueKey = String(params?.venue || '').toLowerCase();
  if (UNSUPPORTED_VENUES[venueKey]) throw new Error(UNSUPPORTED_VENUES[venueKey]);
  const venue = VENUES[venueKey];
  if (!venue) throw new Error(`no idea how to launch on "${params?.venue ?? 'nothing'}" - pick a pad on j7 first`);

  const name = need(params.name, 'name');
  const symbol = need(params.symbol, 'symbol');
  if (!secretKey) throw new Error('no key in the extension - open its options and paste one');

  const uri = params.uri || await uploadMetadata({
    name, symbol,
    description: params.description || '',
    imageDataUrl: params.imageDataUrl || '',
    twitter: params.twitter || '', website: params.website || '', telegram: params.telegram || '',
  }, say);

  const devBuy = Number(params.devBuySol || 0) || 0;
  const slippageBps = Number(params.slippageBps || 1000) || 1000;
  const quoteMint = params.quoteMint && params.quoteMint !== WSOL ? params.quoteMint : undefined;

  if (venue.kind === 'pump') {
    say(`launching ${symbol} on pump.fun…`);
    const res = await launchPump({
      rpcUrl, secretKey, name, symbol, uri,
      devBuySol: devBuy, slippageBps, quoteMint,
      // cashback was removed by pump.fun; create_v2 rejects it
      cashback: false,
      feesToHolders: !!params.feesToHolders,
      creatorFeeBps: Number(params.creatorFeeBps || 0) || 0,
      simulateOnly, preloaded, onStatus: say,
    });
    return { venue: venue.label, mint: res?.mint ?? res?.mintAddress ?? null, signature: res?.signature ?? res?.hash ?? null, raw: res };
  }

  say(`launching ${symbol} on ${venue.label}…`);
  const res = await launchRaydium({
    rpcUrl, secretKey, name, symbol, uri,
    quoteMint: params.quoteMint || WSOL,
    buyAmountUi: devBuy,
    platformId: venue.platformId,
    onStatus: say,
  });
  return { venue: venue.label, mint: res?.mint ?? res?.mintAddress ?? null, signature: res?.signature ?? res?.txId ?? null, raw: res };
}
