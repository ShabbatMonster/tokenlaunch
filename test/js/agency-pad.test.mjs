// agencypad.fun, and what it actually is.
//
// Agency sells a coin with a mind: you pick one of 25 models, write a prompt,
// and the mind runs on the coin's creator fees. The launch itself is pump.fun -
// their own NETWORK section names Pump and PumpSwap - so this pad is the pump
// pad plus a prompt and a model, and every pump option still applies.
//
// The thing that decided the shape of it is what their site does NOT have. Nine
// static chunks, no async chunks behind them, no Solana program id anywhere, no
// submit handler on the launch form, and a single /api/auth route that answers
// with the HTML page instead of JSON. There is nothing to post a mind to. So the
// mind goes into the token's own metadata, where it is permanent and public, and
// this pad does not claim to have registered anything.
//
// The first assertion is the one that matters most: our copy of their catalogue
// is checked against their live page. If they add a model, drop one, or reprice
// a turn, this fails - which is the only way a hardcoded catalogue stays honest.
//
// Run: node test/js/agency-pad.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import {
  AGENCY_MODELS, AGENCY_PROVIDERS, AGENCY_DEFAULT_MODEL, AGENCY_PROMPT_MAX, AGENCY_CATALOGUE_READ,
  agencyModel, agencyTurnCost, agencyTurnsFor, agencyMindSpec,
} from '../../src/agency.js';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- our catalogue against theirs, live --------------------------------------
let theirs = null;
try {
  const res = await fetch('https://www.agencypad.fun/launch', {
    headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25000),
  });
  const html = (await res.text()).replace(/\\"/g, '"');
  const at = html.indexOf('"models":[');
  const sub = html.slice(at + 9);
  let depth = 0; let end = -1;
  for (let i = 0; i < sub.length; i++) {
    if (sub[i] === '[') depth++;
    else if (sub[i] === ']') { depth--; if (!depth) { end = i + 1; break; } }
  }
  theirs = JSON.parse(sub.slice(0, end));
} catch (e) {
  console.log('SKIP  could not read agencypad.fun/launch (' + (e.message || e) + ')');
}

if (theirs) {
  check(theirs.length === AGENCY_MODELS.length,
    'the catalogue has the same number of models as their live page',
    `${AGENCY_MODELS.length} ours / ${theirs.length} theirs`);

  // The STRUCTURE has to match exactly. A model added, dropped, renamed or moved
  // between providers changes what the pad can offer, and a prompt pinned to a
  // model their runtime does not know is a coin with nothing running it.
  const shape = (m) => `${m.id}|${m.name}|${m.provider}|${m.context}`;
  const ours = new Set(AGENCY_MODELS.map(shape));
  const live = new Set(theirs.map(shape));
  const missing = [...live].filter((k) => !ours.has(k)).map((k) => k.split('|')[0]);
  const extra = [...ours].filter((k) => !live.has(k)).map((k) => k.split('|')[0]);
  check(missing.length === 0 && extra.length === 0,
    'every model matches on id, name, provider and context',
    missing.length || extra.length
      ? `missing ${missing.join(',') || 'none'} / stale ${extra.join(',') || 'none'}`
      : `${ours.size} exact`);

  // The PRICE is a different kind of fact. turnMicros moves on their side -
  // Kimi K3 went 10334 -> 9494 and GLM 5.3 3015 -> 2355 within a day of being
  // copied - and their page sends no Access-Control-Allow-Origin, so the pad
  // cannot refresh it from the browser. Failing the suite on their pricing
  // decisions would make it cry wolf, so drift is REPORTED and the thing
  // actually asserted is that the pad admits the number is a snapshot.
  const mine = new Map(AGENCY_MODELS.map((m) => [m.id, m]));
  const drift = theirs
    .filter((t) => mine.has(t.id) && mine.get(t.id).turnMicros !== t.turnMicros)
    .map((t) => `${t.id} ${mine.get(t.id).turnMicros}->${t.turnMicros}`);
  if (drift.length) {
    console.log(`NOTE  ${drift.length} model(s) repriced since ${AGENCY_CATALOGUE_READ}: ${drift.join(', ')}`);
    console.log('      update AGENCY_MODELS and AGENCY_CATALOGUE_READ when convenient — not a code fault');
  } else {
    console.log(`NOTE  no price drift since ${AGENCY_CATALOGUE_READ}`);
  }
  check(/priced \$\{esc\(a\.AGENCY_CATALOGUE_READ\)\}/.test(
    fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8')),
  'the pad shows when the price was read, rather than presenting a snapshot as live');
  check(theirs.some((m) => m.id === AGENCY_DEFAULT_MODEL),
    'the default model is one they actually offer', AGENCY_DEFAULT_MODEL);
}

// --- the catalogue's own shape ------------------------------------------------
check(AGENCY_MODELS.length === 25 && AGENCY_PROVIDERS.length === 10,
  '25 models across 10 providers, as their site advertises',
  `${AGENCY_MODELS.length} / ${AGENCY_PROVIDERS.length}`);
check(AGENCY_MODELS.every((m) => m.id.includes('/') && m.turnMicros > 0 && m.context > 0),
  'every entry carries an OpenRouter-style id, a cost and a context window');
check(new Set(AGENCY_MODELS.map((m) => m.id)).size === AGENCY_MODELS.length,
  'no duplicate ids, so the picker cannot offer the same model twice');

// --- the per-turn cost is the point of showing it -----------------------------
const costs = AGENCY_MODELS.map((m) => m.turnMicros);
const spread = Math.max(...costs) / Math.min(...costs);
check(spread > 10,
  'the catalogue spans a wide cost range, which is why the pad shows a burn rate',
  `${spread.toFixed(0)}x between cheapest and dearest`);
check(agencyTurnCost('anthropic/claude-haiku-4.5') === 0.0085,
  'turnMicros reads as millionths of a dollar', '$0.0085 a turn for Haiku 4.5');
check(agencyTurnsFor('anthropic/claude-haiku-4.5', 100) === 11764,
  'so $100 of creator fees buys a countable number of turns', '11,764 on Haiku');
check(agencyTurnsFor('openai/gpt-5.5', 100) === 2222,
  'and far fewer on the dearest model', '2,222 on GPT-5.5');
check(agencyModel('anthropic/claude-opus-5') !== null && agencyModel('nope/nope') === null,
  'a model lookup answers honestly for both cases');

// --- the mind spec, validated rather than trusted -----------------------------
const spec = agencyMindSpec({ model: AGENCY_DEFAULT_MODEL, prompt: '  be useful  ' });
check(spec.model === AGENCY_DEFAULT_MODEL && spec.prompt === 'be useful',
  'a mind spec trims the prompt and keeps the model id');
check(spec.modelName && spec.provider && spec.context && spec.turnMicros,
  'and records the model it was pinned to, since that is permanent once launched',
  spec.modelName);
check(spec.platform === 'agencypad.fun' && spec.version === 1,
  'stamped with the platform and a version, so it can be read back later');

for (const [label, opts, expect] of [
  ['an unknown model', { model: 'openai/gpt-7', prompt: 'hi' }, /not one of the 25 models/],
  ['an empty prompt', { model: AGENCY_DEFAULT_MODEL, prompt: '   ' }, /needs a prompt/],
  ['an over-long prompt', { model: AGENCY_DEFAULT_MODEL, prompt: 'x'.repeat(AGENCY_PROMPT_MAX + 1) }, /keep it under/],
]) {
  let err = null;
  try { agencyMindSpec(opts); } catch (e) { err = e.message; }
  check(!!err && expect.test(err), `${label} is refused, with the reason`, err ? err.slice(0, 64) + '…' : 'accepted');
}
check(AGENCY_PROMPT_MAX < Math.min(...AGENCY_MODELS.map((m) => m.context)),
  'the prompt cap sits inside the smallest context window in the catalogue',
  `${AGENCY_PROMPT_MAX} vs ${Math.min(...AGENCY_MODELS.map((m) => m.context))}`);

// --- the pad -------------------------------------------------------------------
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
const pad = MAIN.slice(MAIN.indexOf("id: 'agency-sol'"), MAIN.indexOf('\n  },', MAIN.indexOf("id: 'agency-sol'")));
check(pad.length > 0, 'the launcher has an Agency pad');
check(/family: 'pump'/.test(pad),
  "it launches through the pump family, so every pump option applies to it unchanged");
check(/agency: true/.test(pad), 'and flags itself so the mind row shows');
check(/pump\.fun\/coin\//.test(pad),
  'its explorer link points at pump.fun, which is where the coin actually lives');

// the mind has to be built BEFORE the upload, or a bad model fails after the
// coin exists - which is unrecoverable
const launch = MAIN.slice(MAIN.indexOf('async function launchSol'), MAIN.indexOf("if (pad.family === 'pump')"));
check(/agency: await agencyMind\(\)/.test(launch),
  'the mind is written into the metadata the launch uploads');
check(launch.indexOf('agencyMind()') < launch.indexOf('IPFS_GW(metaHash)'),
  'and built before the upload, so a bad model or empty prompt fails before the coin exists');
check(/pad\.agency \?/.test(launch),
  'only for an Agency pad, so an ordinary pump launch carries no agency block');

// --- the UI --------------------------------------------------------------------
const HTML = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'index.html'), 'utf8');
for (const id of ['agencyRow', 'agencyModel', 'agencyPrompt', 'agencyCost', 'agencyInfluencer']) {
  check(HTML.includes(`id="${id}"`), `the page has #${id}, which the code binds to`);
}
check(/<optgroup label="\$\{esc\(provider\)\}">/.test(MAIN),
  'the 25 models are grouped by provider rather than listed flat');
check(/addEventListener\('change', paintAgencyCost\)/.test(MAIN),
  'changing the model repaints the cost, so the burn rate is never stale');

// --- and it does not overclaim --------------------------------------------------
//
// A launch from this pad is NOT an AGENCY coin, and both the module and the page
// have to say so. An earlier version of this test asserted the opposite mistake:
// that Agency has no backend. That was the wrong conclusion from a real
// observation - their /launch chunks ship no submit handler, but /coins and
// /coin/<mint> are server-rendered with live market cap and fee totals for 200
// coins, so the backend plainly exists.
const AGENCY = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'agency.js'), 'utf8');
check(/CANNOT MAKE AN AGENCY COIN/.test(AGENCY),
  'the module states plainly that it cannot produce an AGENCY coin');
check(/the backend plainly/.test(AGENCY) && !/there is no backend/.test(AGENCY),
  'and records that their backend does exist, correcting the earlier claim');
check(!/fetch\(/.test(AGENCY),
  'it still calls nothing, rather than inventing an endpoint');
check(/does not make an AGENCY coin/i.test(HTML),
  'and the pad says the same on its face');
check(/CREATOR FEE RECIPIENT/.test(HTML) && /treasury/i.test(HTML),
  'naming the mechanism it cannot reproduce: a creator wallet Agency custodies');

// --- the creator argument, which is the whole mechanism -------------------------
const PUMP = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'pump.js'), 'utf8');
check(/creatorAddress,/.test(PUMP),
  'launchPump accepts a creator address, since create_v2 takes one as an argument');
check(/creator: creatorAddress \? new PublicKey\(creatorAddress\) : payer\.publicKey/.test(PUMP),
  'defaulting to the payer, which is what every launch here did before');
const calls = (MAIN.match(/creatorAddress: /g) || []).length;
check(calls >= 3,
  'and it is threaded through the launch, the armed preset and the firing of one',
  `${calls} sites`);
check(/function pumpCreatorAddress\(\)/.test(MAIN) && /isSolAddress\(raw\)/.test(MAIN),
  'the address is validated, because a bad one would hand the fees nowhere');


// --- and the override really changes the instruction ----------------------------
//
// Source greps prove the plumbing, not the behaviour. This builds the same launch
// twice and reads the `creator` out of create_v2's own argument bytes, which is
// the only thing that decides where the fees go.
//
// The layout: 8-byte discriminator, then name / symbol / uri as length-prefixed
// strings, then the 32-byte creator. Walking the strings is how the creator is
// located without assuming their lengths.
const { pumpWarmup, buildPumpLaunch, PUMP_PROGRAM } = await import('../../src/pump.js');
const { Connection, Keypair, PublicKey } = await import('@solana/web3.js');
const { healthyRpc } = await import('../../src/rpc.js');

const rpc = await healthyRpc();
const conn = new Connection(rpc, 'confirmed');
const CREATE_DISC = Buffer.from('d6904cec5f8b31b4', 'hex');
const TREASURY = 'AgEnCy1111111111111111111111111111111111111';

async function creatorOf(creatorAddress) {
  const warm = await pumpWarmup({ rpcUrl: rpc });
  const tx = await buildPumpLaunch({
    connection: conn, payer: Keypair.generate(), mint: Keypair.generate(),
    name: 'Mind', symbol: 'MIND', uri: 'https://x/m.json',
    devBuySol: 0, slippageBps: 1000,
    global: warm.global, quote: warm.quote, lookupTable: warm.lookupTable,
    ...(creatorAddress ? { creatorAddress } : {}),
  });
  const keys = tx.message.getAccountKeys({
    addressLookupTableAccounts: warm.lookupTable?.value ? [warm.lookupTable.value] : [],
  });
  for (const ix of tx.message.compiledInstructions) {
    const d = Buffer.from(ix.data);
    if (!keys.get(ix.programIdIndex)?.equals(PUMP_PROGRAM) || !d.subarray(0, 8).equals(CREATE_DISC)) continue;
    let o = 8;
    for (let i = 0; i < 3; i++) { o += 4 + d.readUInt32LE(o); }   // name, symbol, uri
    return new PublicKey(d.subarray(o, o + 32)).toBase58();
  }
  return null;
}

let treasuryValid = true;
try { new PublicKey(TREASURY); } catch { treasuryValid = false; }
if (!treasuryValid) {
  console.log('SKIP  the sample treasury address is not valid base58');
} else {
  const overridden = await creatorOf(TREASURY);
  check(overridden === TREASURY,
    'setting creatorAddress puts THAT wallet in create_v2, which is where the fees go',
    overridden);
  const defaulted = await creatorOf(null);
  check(defaulted !== TREASURY && !!defaulted,
    'and leaving it unset keeps the payer as creator, exactly as before',
    defaulted?.slice(0, 10) + '…');
}

console.log('');
process.exit(fails.length ? 1 : 0);
