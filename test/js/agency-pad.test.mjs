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
  AGENCY_MODELS, AGENCY_PROVIDERS, AGENCY_DEFAULT_MODEL, AGENCY_PROMPT_MAX,
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

  const key = (m) => `${m.id}|${m.name}|${m.provider}|${m.context}|${m.turnMicros}`;
  const ours = new Set(AGENCY_MODELS.map(key));
  const live = new Set(theirs.map(key));
  const missing = [...live].filter((k) => !ours.has(k)).map((k) => k.split('|')[0]);
  const extra = [...ours].filter((k) => !live.has(k)).map((k) => k.split('|')[0]);
  check(missing.length === 0 && extra.length === 0,
    'and every model matches on id, name, provider, context AND per-turn cost',
    missing.length || extra.length
      ? `missing ${missing.join(',') || 'none'} / stale ${extra.join(',') || 'none'}`
      : `${ours.size} exact`);
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
const AGENCY = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'agency.js'), 'utf8');
check(/no backend/i.test(AGENCY) && /api\/auth/.test(AGENCY),
  'the module records that their site has no backend, which is why nothing is posted to it');
check(!/fetch\(/.test(AGENCY),
  'and it calls nothing, rather than pretending an endpoint exists');
check(/has no backend yet/i.test(HTML),
  'the pad tells you the mind is recorded and not yet hosted');

console.log('');
process.exit(fails.length ? 1 : 0);
