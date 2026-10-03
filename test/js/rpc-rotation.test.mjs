// Which RPC to use, and why it is one list instead of fifteen.
//
// The endpoint had been copy-pasted into fifteen places with three different
// keys between them. When two of the keys hit their quota, the app, the
// extension and ten test files each had their own idea of what to fall back to,
// and the test files had none at all - so every chain-touching suite died at
// once on "429 max usage reached", a failure that said nothing about the code
// and nothing about which key was at fault.
//
// A maxed key is the easy case to handle and the easy case to handle badly. It
// answers 429 immediately and keeps doing so, so one cheap probe tells the
// truth - while retrying the same endpoint with a backoff, which is what
// web3.js does on its own, just spends seconds arriving at the same answer.
//
// Run: node test/js/rpc-rotation.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import {
  HELIUS_RPCS, PUBLIC_RPC, SOL_RPCS, SOL_RPC, SOL_RPC_FALLBACKS, SCAN_RPCS,
  probeRpc, healthyRpc, forgetRpc, rpcStatus, rpcLabel,
} from '../../src/rpc.js';

const root = path.join(import.meta.dirname, '..', '..');
const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the list -----------------------------------------------------------------
check(HELIUS_RPCS.length === 3, 'three Helius endpoints', `${HELIUS_RPCS.length}`);
check(new Set(HELIUS_RPCS).size === 3, 'and no duplicates among them');
check(SOL_RPCS.length === 4 && SOL_RPCS[3] === PUBLIC_RPC,
  'with the public endpoint last, because it cannot serve getProgramAccounts');
check(SOL_RPC === HELIUS_RPCS[0] && SOL_RPC_FALLBACKS.length === 3,
  'the primary is the first Helius key and everything else is a fallback');
check(SCAN_RPCS.every((u) => u !== PUBLIC_RPC),
  'a scan never offers the public endpoint, which would fail confusingly');
check(HELIUS_RPCS[0].includes('6ae075bc'),
  'the newest key leads, since the older two have been maxed before');

// --- the label never leaks a whole key ----------------------------------------
const label = rpcLabel(HELIUS_RPCS[0]);
check(label.includes('helius') && label.includes('6ae075bc') && !label.includes('0892'),
  'a label shows the host and the first chunk of the key, never the whole thing', label);
check(rpcLabel(PUBLIC_RPC) === 'api.mainnet-beta.solana.com',
  'and a keyless endpoint is just its host');
check(rpcLabel('not a url') === 'not a url', 'a malformed url is returned rather than thrown over');

// --- the probe tells the truth -------------------------------------------------
const status = await rpcStatus();
console.log('');
for (const s of status) console.log(`   ${s.ok ? 'UP  ' : 'DOWN'}  ${rpcLabel(s.url)}`);
console.log('');
check(status.length === SOL_RPCS.length, 'every endpoint gets probed');
check(status.some((s) => s.ok), 'at least one endpoint is up, or nothing in this repo can run');
check(await probeRpc('https://mainnet.helius-rpc.com/?api-key=0000') === false,
  'a bad key probes as down rather than throwing');
check(await probeRpc('https://127.0.0.1:1/', 400) === false,
  'and so does an endpoint that cannot be reached at all');

// --- the chooser ---------------------------------------------------------------
forgetRpc();
const picked = await healthyRpc();
check(status.find((s) => s.url === picked)?.ok === true,
  'healthyRpc returns an endpoint that is actually up', rpcLabel(picked));
check(picked === status.find((s) => s.ok).url,
  'and the FIRST one that is up, so the order of the list is the order of preference');

forgetRpc();
const scan = await healthyRpc({ scanning: true });
check(scan !== PUBLIC_RPC, 'a scanning caller never gets the public endpoint', rpcLabel(scan));

// cached, because a quota is a cliff rather than a slope
const again = await healthyRpc();
check(again === scan, 'the choice is cached rather than re-probed on every call');
forgetRpc();
check(typeof (await healthyRpc()) === 'string', 'and the cache can be dropped');

// nothing up at all still yields something, so the caller gets a real RPC error
// rather than an error about choosing one
forgetRpc();
const dead = ['https://127.0.0.1:1/', 'https://127.0.0.2:1/'];
check(await healthyRpc({ urls: dead }) === dead[0],
  'when nothing answers it returns the first candidate anyway, so the error is the RPC\'s');
forgetRpc();

// --- nothing keeps its own copy any more ---------------------------------------
const files = [
  ...fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => 'src/' + f),
  ...fs.readdirSync(path.join(root, 'test', 'js')).filter((f) => f.endsWith('.mjs')).map((f) => 'test/js/' + f),
  'extension/background.js',
  'extension/test/multi-venue.test.mjs',
];
const offenders = files.filter((f) => f !== 'src/rpc.js'
  && /helius-rpc\.com\/\?api-key=[0-9a-f]{8}/.test(fs.readFileSync(path.join(root, f), 'utf8')));
check(offenders.length === 0,
  'src/rpc.js is the only file that spells out an endpoint',
  offenders.length ? offenders.join(', ') : `${files.length} files checked`);

const suites = files.filter((f) => f.endsWith('.mjs'));
const choosing = suites.filter((f) => /healthyRpc\(/.test(fs.readFileSync(path.join(root, f), 'utf8')));
check(choosing.length >= 9,
  'the chain-touching suites choose an endpoint instead of pinning one',
  `${choosing.length}/${suites.length} suites`);

const worker = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
check(/probeRpc,/.test(worker) && !/function probeRpc/.test(worker),
  'the extension imports the probe rather than carrying a second copy');
check(/rpcUrl: BUNDLED_RPC/.test(worker) && /rpcFallbacks: BUNDLED_RPC_FALLBACKS/.test(worker),
  'and takes its defaults from the same list');
check(/async function healthyRpc\(settings\)/.test(worker),
  'while keeping its own chooser, because it has to honour what the user set in options');

// --- the app says which one is up ----------------------------------------------
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
check(/async function paintRpcLine/.test(main) && /rpcStatus\(SOL_RPCS\)/.test(main),
  'the launcher reports the state of every endpoint rather than failing opaquely');
check(/the primary RPC is down/.test(main),
  'and names the problem when the primary is the one that is down');
check(fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8').includes('id="rpcLine"'),
  'with somewhere on the page to show it');

console.log('');
process.exit(fails.length ? 1 : 0);
