import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

// Run with:  node extension/test/multi-venue.test.mjs
//
// The extension was built around pump.fun and then grew Meteora and Pons
// support in the worker - but the two halves that decide whether you can REACH
// a coin at all stayed pump-shaped, and that is what made a perfectly
// migratable DBC coin look unsupported:
//
//   1. the content script only runs on sites that list a coin. A curve that has
//      bonded but NOT migrated has no AMM pool, so the DEX trackers often do
//      not list it - and that is precisely the coin this tool exists for. There
//      was no way in at all.
//   2. candidates were capped at 8, and the only ordering hint is a 'pump'
//      suffix. A Meteora mint has no suffix to sort it forward, so on a busy
//      page full of other base58 it could be cut off the end. Indistinguishable
//      from the venue being unsupported.
//
// The fix is the popup: paste an address, and the worker asks the chain which
// venue it is, exactly as it does for the panel. Nothing in the popup knows a
// pump coin from a Meteora one, and nothing there can reach the key.
//
// The live check at the end uses the real coin this was found with:
// GvnHcQ7tf5FGuh7Fj27KfyGtXDNPdHosRZwe3UVTLjwM, a force-bonded DBC curve.

const here = import.meta.dirname;
const AXIOM = fs.readFileSync(path.join(here, '..', 'axiom.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(here, '..', 'background.js'), 'utf8');
const POPUP_JS = fs.readFileSync(path.join(here, '..', 'popup.js'), 'utf8');
const POPUP_HTML = fs.readFileSync(path.join(here, '..', 'popup.html'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(here, '..', 'manifest.json'), 'utf8'));

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the URL shapes, taken from the real content script ----------------------
const MINT_IN_URL = eval(AXIOM.match(/const MINT_IN_URL = (\/.*\/);/)[1]);
const DBC = 'GvnHcQ7tf5FGuh7Fj27KfyGtXDNPdHosRZwe3UVTLjwM';
const urls = [
  ['axiom.trade/meme', `https://axiom.trade/meme/${DBC}`],
  ['solscan', `https://solscan.io/token/${DBC}`],
  ['jup.ag', `https://jup.ag/tokens/${DBC}`],
  ['gmgn', `https://gmgn.ai/sol/token/${DBC}`],
  ['photon', `https://photon-sol.tinyastro.io/en/lp/${DBC}`],
  ['dexscreener', `https://dexscreener.com/solana/${DBC}`],
];
const missed = urls.filter(([, u]) => MINT_IN_URL.exec(u)?.[1] !== DBC).map(([n]) => n);
check(missed.length === 0,
  'a non-pump mint is found in a link on every site the extension runs on',
  missed.length ? 'missed ' + missed.join(', ') : urls.length + ' shapes');
check(MINT_IN_URL.exec('https://pump.fun/coin/25UThw41PUqCTRpGSBzoZRB1MYEZsjVo7AUAn7Nupump')?.[1]
  === '25UThw41PUqCTRpGSBzoZRB1MYEZsjVo7AUAn7Nupump',
  'and the pump shape still works, so broadening it cost nothing');

// --- the candidate cap --------------------------------------------------------
//
// The failure this reproduces: a page listing a dozen unrelated base58
// addresses, with the Meteora mint last. Under the old cap of 8 it never
// reached the worker.
function loadCandidateMints(dom) {
  const start = AXIOM.indexOf('function candidateMints()');
  const end = AXIOM.indexOf('\n}', AXIOM.indexOf('return out.slice', start)) + 2;
  const prelude = `
    const BASE58 = ${AXIOM.match(/const BASE58 = (.+);/)[1]};
    const EVM_ADDR = ${AXIOM.match(/const EVM_ADDR = (.+);/)[1]};
    const MINT_IN_URL = ${AXIOM.match(/const MINT_IN_URL = (\/.*\/);/)[1]};
    const looksLikeMint = ${AXIOM.match(/const looksLikeMint = (.+);/)[1]};
  `;
  const fn = new Function('document', 'location', 'URLSearchParams', 'NodeFilter',
    prelude + AXIOM.slice(start, end) + '; return candidateMints();');
  return () => fn(dom.window.document, dom.window.location, dom.window.URLSearchParams, dom.window.NodeFilter);
}

// twelve decoys that look exactly like mints, then the real one
const decoys = Array.from({ length: 12 }, (_, i) => 'Dec0y' + String(i).padStart(2, '0') + 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.slice(0, 34));
const dom = new JSDOM(
  `<body>${decoys.map((d) => `<div>${d}</div>`).join('')}<div>${DBC}</div></body>`,
  { url: 'https://axiom.trade/discover' },
);
const found = loadCandidateMints(dom)();
check(found.includes(DBC),
  'the real mint still reaches the worker from a page full of decoys',
  `position ${found.indexOf(DBC) + 1} of ${found.length}`);
check(/return out\.slice\(0, 24\)/.test(AXIOM) && /\.slice\(0, 24\)/.test(WORKER),
  'the content script and the worker agree on how many candidates to check');

// --- the worker asks the chain, in venue order --------------------------------
const identify = WORKER.slice(WORKER.indexOf('async function identify'), WORKER.indexOf('function trimPons'));
check(/inspectPumpMigration/.test(identify) && /inspectMeteoraMigration/.test(identify)
  && /inspectRaydiumMigration/.test(identify) && /inspectPonsMigration/.test(identify),
  'identify() tries all four venues rather than assuming pump');
check(identify.indexOf('isPumpCoin') < identify.indexOf('isMeteoraCoin'),
  'pump first, because its check is the cheapest - an ordering choice, not a restriction');
check(!/nothing on this page is a coin on pump\.fun, Meteora or Raydium/.test(WORKER),
  'and the failure message no longer implies only three venues exist');

// --- the popup can drive a migration on its own -------------------------------
check(/id="ca"/.test(POPUP_HTML) && /id="migrate"/.test(POPUP_HTML),
  'the popup has an address box and a migrate button, so a coin with no page is reachable');
check(/type: 'pm:resolve'/.test(POPUP_JS) && /type: 'pm:migrate'/.test(POPUP_JS),
  'it drives the same two worker messages the panel does');
check(/venue: i\.venue/.test(POPUP_JS),
  'and passes back whatever venue the chain said, rather than defaulting to pump');
// A label table keyed by venue is fine; an `if (venue === 'pump')` is not,
// because branching like that is how the pump assumption got baked in the
// first time.
check(!/venue\s*===\s*['"]pump['"]/.test(POPUP_JS) && !/isPump/.test(POPUP_JS),
  'nothing in the popup branches on the venue being pump');

// the key boundary is the whole security model, so pin it on the popup too
check(!/secretKey|privateKey|evmKey|importKey/.test(POPUP_JS),
  'the popup never names key material, let alone handles it');

// --- status has somewhere to go when there is no tab --------------------------
check(/function statusSink/.test(WORKER),
  'progress goes through one sink rather than straight to a tab');
const sink = WORKER.slice(WORKER.indexOf('function statusSink'), WORKER.indexOf('// --- messages'));
check(/chrome\.tabs\.sendMessage/.test(sink) && /chrome\.runtime\.sendMessage/.test(sink),
  'which feeds the panel and the popup, since the popup has no tab of its own');
check((sink.match(/\.catch\(\(\) => \{\}\)/g) || []).length >= 3,
  'every send is fire-and-forget, so a closed popup cannot interrupt a migration');
check(/if \(msg\?\.type === 'pm:status'\) return false;/.test(WORKER),
  'and the worker ignores its own broadcast instead of answering it as unknown');
check(/lastResult/.test(WORKER) && /lastResult/.test(POPUP_JS),
  'the result is stored, because the popup closes while the worker keeps going');

// --- the manifest reaches those sites -----------------------------------------
const matches = MANIFEST.content_scripts[0].matches;
for (const host of ['https://solscan.io/*', 'https://jup.ag/*', 'https://dexscreener.com/*']) {
  check(matches.includes(host), `the content script is injected on ${host.replace('https://', '').replace('/*', '')}`);
}
check(matches.every((m) => MANIFEST.host_permissions.includes(m)),
  'and every injected site is in host_permissions, or the injection is silently refused');
check(!/^pump migrate$/.test(MANIFEST.name),
  'the extension is no longer named after one venue', MANIFEST.name);
check(MANIFEST.default_title === undefined,
  'no stray top-level default_title, which is not a manifest key and makes Chrome reject the load');

// --- the live coin ------------------------------------------------------------
//
// Everything above is structure. This is the actual coin that did not work.
const { inspectMeteoraMigration, inspectPumpMigration } = await import('../../src/ext-launcher.js');
const RPC = 'https://mainnet.helius-rpc.com/?api-key=ae11f74a-b518-408b-bc88-524c277da375';
const pump = await inspectPumpMigration({ rpcUrl: RPC, mint: DBC }).catch(() => null);
check(pump?.isPumpCoin === false,
  'the coin really is not a pump coin, which is why the pump-only path found nothing');
const met = await inspectMeteoraMigration({ rpcUrl: RPC, mint: DBC }).catch(() => null);
check(met?.isMeteoraCoin === true,
  'while it IS a Meteora DBC curve, which the broadened path finds',
  `${met?.state} · raised ${met?.raisedQuote} of ${met?.quoteMint?.slice(0, 8)}…`);
check(met?.isNativeQuote === false,
  'quoted in a non-SOL token, which the panel names rather than calling it QUOTE');

// This coin's state moves - it was 'migratable' when the bug was found and is
// 'migrated' once the migration lands - so pin the CLASSIFICATION rather than
// one moment of it. Both states must be reported honestly, and only a
// migratable curve may offer a simulation.
if (met?.state === 'migratable') {
  check(met.simulation?.unitsConsumed > 0,
    'and being migratable, its migration simulates - the only thing ever missing was a way to ask',
    `${met.simulation.unitsConsumed} CU`);
} else if (met?.state === 'migrated') {
  check(/already migrated/i.test(met.reason || ''),
    'and now that it has migrated, it says so rather than offering a migration that would fail',
    met.reason);
  check(met.migrationProgress >= 3,
    'with the progress flag the chain actually reports', String(met.migrationProgress));
} else {
  check(false, 'the curve is in an unexpected state', `${met?.state}: ${met?.reason}`);
}

console.log('');
process.exit(fails.length ? 1 : 0);
