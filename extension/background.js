// ---------------------------------------------------------------------------
// Service worker. Holds the key, runs the migration, and talks to the content
// script only in mint-in / status-out messages.
//
// Nothing here ever sends key material to a tab, and nothing a tab sends can
// ask for it. The content script's whole vocabulary is the message types
// handled below; anything else is ignored.
//
// The j7tracker deploy fallback used to live here too. It is gone: this worker
// now does one job, on three venues, and the venue is decided by asking the
// chain rather than by looking at which site you happen to be on.
// ---------------------------------------------------------------------------

import {
  solAddressFromSecret,
  inspectPumpMigration, previewSnipe, snipeMigration, migratePump,
  inspectMeteoraMigration, migrateMeteora, findStuckMeteoraPools,
  inspectRaydiumMigration,
  previewSwapIntoQuote, swapIntoQuote, tokenHoldings,
} from './vendor/launcher.js';

// where the launcher keeps its keys, so the extension can borrow rather than
// make you paste the same key a second time
const LAUNCHER_URLS = [
  'https://shabbatmonster.github.io/tokenlaunch/*',
  'http://localhost/*',
  'http://127.0.0.1/*',
];
const LAUNCHER_HOME = 'https://shabbatmonster.github.io/tokenlaunch/';

const DEFAULTS = {
  // measured 15-21ms against 23-110ms for the other key in this repo
  rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=3fb08d49-71d7-492b-84f1-9ff0e3eb95ea',
  // 40% by default, which is a choice about LOSING the race rather than about
  // price impact. The floor is measured by simulating the real buy, so your own
  // impact - however large the buy - is already inside the number it is a
  // percentage of. What the tolerance actually buys is: if somebody else's
  // migration lands first and moves the price, how much worse a fill will you
  // still take rather than reverting. See the README.
  slippageBps: 4000,
  route: 'auto',
  tipLamports: 1_000_000,
  // Tried in order when the configured one is refusing. A throttled key answers
  // 429 and web3.js then retries the SAME endpoint with a backoff per attempt,
  // which is where the seconds go. Moving endpoint is far cheaper than waiting.
  rpcFallbacks: [
    'https://mainnet.helius-rpc.com/?api-key=ae11f74a-b518-408b-bc88-524c277da375',
    'https://api.mainnet-beta.solana.com',
  ],
};

const getSettings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });
const getKey = async () => (await chrome.storage.local.get('secretKey')).secretKey || '';

const addressOrNull = async () => {
  const key = await getKey();
  if (!key) return null;
  try { return solAddressFromSecret(key); } catch { return null; }
};

// one migration at a time: two in flight on the same coin is money for nothing
let migrateInFlight = false;

// --- picking an endpoint that is actually answering -------------------------

const RPC_TTL_MS = 60_000;
let goodRpc = null;

async function probeRpc(url, timeoutMs = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }),
    });
    if (!r.ok) return false;                  // 429 lands here, and we move on
    const j = await r.json();
    return !!j?.result;
  } catch { return false; } finally { clearTimeout(timer); }
}

async function healthyRpc(settings) {
  if (goodRpc && Date.now() - goodRpc.at < RPC_TTL_MS) return goodRpc.url;
  const urls = [settings.rpcUrl, ...(settings.rpcFallbacks || [])].filter(Boolean);
  for (const url of urls) {
    if (await probeRpc(url)) { goodRpc = { url, at: Date.now() }; return url; }
  }
  // nothing answered - use what was configured and let the error be the error
  goodRpc = { url: urls[0], at: Date.now() };
  return urls[0];
}

// --- keys --------------------------------------------------------------------

function fromOwnPage(sender) {
  return sender?.id === chrome.runtime.id
    && String(sender?.url || '').startsWith(chrome.runtime.getURL(''));
}

/// Read the launcher's own saved keys out of its localStorage.
///
/// Same user, same machine, same key - this just saves pasting it twice. It
/// needs a tab on that origin because localStorage is per-origin, so an already
/// open one is reused and a temporary background tab is opened only if there is
/// none, then closed again.
async function importKeyFromLauncher() {
  let tabs = [];
  for (const pattern of LAUNCHER_URLS) {
    try { tabs = tabs.concat(await chrome.tabs.query({ url: pattern })); } catch { /* pattern not permitted */ }
  }
  let tab = tabs.find((t) => /tokenlaunch|localhost|127\.0\.0\.1/.test(t.url || ''));
  let opened = false;

  try {
    if (!tab) {
      const granted = await chrome.permissions.request({ origins: [LAUNCHER_HOME + '*'] }).catch(() => false);
      if (!granted) return { ok: false, error: 'need permission for the launcher page to read its key' };
      tab = await chrome.tabs.create({ url: LAUNCHER_HOME, active: false });
      opened = true;
      await new Promise((res) => {
        const done = (id, info) => {
          if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); res(); }
        };
        chrome.tabs.onUpdated.addListener(done);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); res(); }, 15000);
      });
    }

    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try { return localStorage.getItem('keys.v1'); } catch { return null; }
      },
    });
    if (!result) return { ok: false, error: 'the launcher has no key saved in this browser' };

    const keys = JSON.parse(result);
    if (!keys?.sol) {
      return { ok: false, error: keys?.evm
        ? 'the launcher only has an EVM key saved - migrations run on Solana'
        : 'no Solana key found in the launcher' };
    }
    let address = null;
    try { address = solAddressFromSecret(keys.sol); }
    catch { return { ok: false, error: 'the launcher key is not valid base58' }; }

    await chrome.storage.local.set({ secretKey: keys.sol });
    return { ok: true, address };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    if (opened && tab?.id != null) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// --- which venue is this coin on --------------------------------------------
//
// Asked of the chain, cheapest question first. pump is a single derived account
// read; Meteora and Raydium each need a filtered program scan. The first venue
// that claims the mint wins, and a coin cannot be on two.

async function identify(rpcUrl, mint, user) {
  const pump = await inspectPumpMigration({ rpcUrl, mint, user }).catch(() => null);
  if (pump?.isPumpCoin) return trimPump(pump);

  const met = await inspectMeteoraMigration({ rpcUrl, mint, user }).catch(() => null);
  if (met?.isMeteoraCoin) return trimMeteora(met);

  const ray = await inspectRaydiumMigration({ rpcUrl, mint }).catch(() => null);
  if (ray?.isRaydiumCoin) {
    return {
      venue: 'raydium', canBuy: false, state: ray.state, reason: ray.reason,
      pool: ray.poolState || null, quoteMint: null, quoteDecimals: null,
      isNativeQuote: false, creator: null, raisedQuote: null,
    };
  }
  return null;
}

// Only what the panel draws. The raw results carry BigInts and PublicKeys,
// neither of which survives the structured clone into a content script - a
// BigInt actually throws.
function trimPump(info) {
  return {
    venue: 'pump', canBuy: true,
    state: info.state,
    reason: info.reason || null,
    pool: info.pool || null,
    quoteMint: info.quoteMint || null,
    quoteDecimals: info.quoteDecimals ?? null,
    isNativeQuote: !!info.isNativeQuote,
    creator: info.curve?.creator?.toBase58?.() || null,
    raisedQuote: info.curve?.realQuoteReserves?.toString?.() || null,
  };
}

function trimMeteora(info) {
  return {
    venue: 'meteora',
    // the pool a DBC migration opens is DAMM v2, a different program from
    // PumpSwap, so the first buy does not carry over yet
    canBuy: false,
    state: info.state,
    reason: info.reason || null,
    pool: info.virtualPool || null,
    quoteMint: info.quoteMint || null,
    quoteDecimals: info.quoteDecimals ?? null,
    isNativeQuote: !!info.isNativeQuote,
    creator: info.creator || null,
    raisedQuote: info.raisedQuote || null,
    migrationProgress: info.migrationProgress ?? null,
  };
}

// --- messages ----------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'pm:getSettings': {
        const s = await getSettings();
        sendResponse({ ...s, hasKey: !!(await getKey()), address: await addressOrNull() });
        return;
      }
      case 'pm:setSettings': {
        // Only our own pages may write settings. This cannot be "does it come
        // from a tab" - the options page is itself a tab, which is what used to
        // make saving a key silently fail. What separates us from a website is
        // the sender's URL being inside this extension.
        if (!fromOwnPage(sender)) { sendResponse({ ok: false, error: 'not allowed from a page' }); return; }
        await chrome.storage.local.set(msg.values || {});
        sendResponse({ ok: true });
        return;
      }
      case 'pm:importKey': {
        if (!fromOwnPage(sender)) { sendResponse({ ok: false, error: 'not allowed from a page' }); return; }
        sendResponse(await importKeyFromLauncher());
        return;
      }
      case 'pm:resolve': {
        // The content script scrapes loosely - URL, links, anything on the page
        // shaped like base58 - and this decides which candidate is real by
        // asking the chain. Being wrong about a site's DOM is then cheap.
        const rpcUrl = await healthyRpc(await getSettings());
        const user = await addressOrNull();
        for (const mint of (msg.candidates || []).slice(0, 8)) {
          const info = await identify(rpcUrl, mint, user);
          if (info) { sendResponse({ ok: true, mint, info }); return; }
        }
        sendResponse({ ok: false, error: 'nothing on this page is a coin on pump.fun, Meteora or Raydium' });
        return;
      }
      case 'pm:preview': {
        const rpcUrl = await healthyRpc(await getSettings());
        const address = await addressOrNull();
        if (!address) { sendResponse({ ok: false, error: 'no key imported yet' }); return; }
        try {
          sendResponse({ ok: true, preview: await previewSnipe({
            rpcUrl, mint: msg.mint, buyer: address,
            spendQuote: msg.spendQuote, slippageBps: msg.slippageBps ?? 500,
          }) });
        } catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
        return;
      }
      case 'pm:balance': {
        // what the wallet holds of a mint, for the MAX button
        const rpcUrl = await healthyRpc(await getSettings());
        const owner = await addressOrNull();
        if (!owner) { sendResponse({ ok: false, error: 'no key imported yet' }); return; }
        try { sendResponse({ ok: true, holdings: await tokenHoldings({ rpcUrl, owner, mint: msg.mint }) }); }
        catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
        return;
      }
      case 'pm:quoteSwap': {
        const rpcUrl = await healthyRpc(await getSettings());
        try {
          sendResponse({ ok: true, preview: await previewSwapIntoQuote({
            rpcUrl, quoteMint: msg.quoteMint, lamports: msg.lamports, slippageBps: msg.slippageBps ?? 100,
          }) });
        } catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
        return;
      }
      case 'pm:swap': {
        if (migrateInFlight) { sendResponse({ ok: false, error: 'something is already running' }); return; }
        migrateInFlight = true;
        try {
          const rpcUrl = await healthyRpc(await getSettings());
          const secretKey = await getKey();
          if (!secretKey) { sendResponse({ ok: false, error: 'no key imported yet' }); return; }
          const tabId = sender.tab?.id ?? null;
          const say = (m) => { if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'pm:status', text: m }).catch(() => {}); };
          sendResponse({ ok: true, result: await swapIntoQuote({
            rpcUrl, secretKey, quoteMint: msg.quoteMint, lamports: msg.lamports,
            slippageBps: msg.slippageBps ?? 100, onStatus: say,
          }) });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        } finally { migrateInFlight = false; }
        return;
      }
      case 'pm:migrate': {
        if (migrateInFlight) { sendResponse({ ok: false, error: 'a migration is already running' }); return; }
        migrateInFlight = true;
        try {
          const settings = await getSettings();
          const rpcUrl = await healthyRpc(settings);
          const secretKey = await getKey();
          if (!secretKey) { sendResponse({ ok: false, error: 'no key imported yet' }); return; }
          const tabId = sender.tab?.id ?? null;
          const say = (m) => { if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'pm:status', text: m }).catch(() => {}); };

          if (msg.venue === 'meteora') {
            sendResponse({ ok: true, result: await migrateMeteora({ rpcUrl, secretKey, mint: msg.mint, onStatus: say }) });
            return;
          }
          if (msg.venue === 'raydium') {
            sendResponse({ ok: false, error: 'Raydium LaunchLab migration is permissioned - only Raydium can call it' });
            return;
          }
          const spend = String(msg.spendQuote || '0');
          const res = spend === '0'
            ? { venue: 'pump', route: 'migrate-only', ...await migratePump({ rpcUrl, secretKey, mint: msg.mint, onStatus: say }) }
            : { venue: 'pump', ...await snipeMigration({
              rpcUrl, secretKey, mint: msg.mint, spendQuote: spend,
              slippageBps: msg.slippageBps ?? settings.slippageBps,
              route: msg.route || settings.route,
              tipLamports: msg.tipLamports ?? settings.tipLamports, onStatus: say,
            }) };
          sendResponse({ ok: true, result: res });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        } finally {
          migrateInFlight = false;
        }
        return;
      }
      case 'pm:stuck': {
        // every DBC pool this wallet launched that finished its curve and never
        // migrated - the case this whole tool exists for
        if (!fromOwnPage(sender)) { sendResponse({ ok: false, error: 'not allowed from a page' }); return; }
        const rpcUrl = await healthyRpc(await getSettings());
        const creator = await addressOrNull();
        if (!creator) { sendResponse({ ok: false, error: 'no key imported yet' }); return; }
        try { sendResponse({ ok: true, pools: await findStuckMeteoraPools({ rpcUrl, creator }) }); }
        catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
        return;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true;   // async sendResponse
});
