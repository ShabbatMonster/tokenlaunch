// Abyss Launch, and why the pad is disabled.
//
// The whole system went live on Robinhood Chain a few hours before this was
// written. Every contract is real and the gate is wired, but no template is
// registered, nothing has ever launched, and launch.abyss.trading serves a
// component named `maintenance-splash`. So this suite pins two different kinds
// of thing:
//
//   the FACTS, which must stay true  - the addresses, the gate, the entry
//                                      point's signature, the shared pool key
//   the STATE, which is expected to change - whether it is open
//
// A test that failed the moment Abyss opened would be worse than no test, so
// readiness is reported and the pad's disabled-ness is asserted to MATCH the
// chain rather than asserted outright.
//
// Run: node test/js/abyss-launch.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, http, getAddress, toFunctionSelector } from 'viem';
import {
  ABYSS_LAUNCH, ABYSS_REGISTRAR, ABYSS_LAUNCH_DEPLOYED, LAUNCH_SELECTOR,
  ABYSS_LAUNCH_ABI, ABYSS_POOL_KEY, ABYSS_LAUNCH_ERRORS,
  ABYSS_COORDINATOR_ABI, ABYSS_TOKEN_FACTORY_ABI,
  abyssLaunchStatus, simulateAbyssLaunch,
} from '../../src/abyss.js';
import { ROBINHOOD } from '../../src/rhPrice.js';

const pub = createPublicClient({
  chain: ROBINHOOD,
  transport: http('https://rpc.mainnet.chain.robinhood.com', { retryCount: 5, retryDelay: 900 }),
});

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the contracts are real ----------------------------------------------------
const names = Object.keys(ABYSS_LAUNCH);
const codes = await Promise.all(names.map((n) => pub.getCode({ address: ABYSS_LAUNCH[n] }).catch(() => null)));
const empty = names.filter((n, i) => !codes[i] || codes[i] === '0x');
check(empty.length === 0,
  'all six launch contracts have code on Robinhood Chain',
  empty.length ? 'empty: ' + empty.join(', ') : `${names.length} live`);

// The addresses came out of the site's checked-in map, NOT its env block - the
// bundle also ships VITE_CHAIN_ID 31337 and a localhost RPC, which would have
// been the wrong thing to trust.
check(ABYSS_LAUNCH.launchFactory === getAddress('0xa7a4755fb907593f05fd1e289aa780f0d57f3a12'),
  'the launch factory is the address the site ships, checksummed');

// --- the gate -------------------------------------------------------------------
//
// Both factories answer `launcher()` with the launch factory, so a token cannot
// be minted by calling the token factory directly. That is the gate, and it is
// the reason a launch has to go through one entry point.
const [tokLauncher, modLauncher] = await Promise.all([
  pub.readContract({ address: ABYSS_LAUNCH.tokenFactory, abi: ABYSS_TOKEN_FACTORY_ABI, functionName: 'launcher' }).catch(() => null),
  pub.readContract({ address: ABYSS_LAUNCH.moduleFactory, abi: ABYSS_TOKEN_FACTORY_ABI, functionName: 'launcher' }).catch(() => null),
]);
check(!!tokLauncher && getAddress(tokLauncher) === ABYSS_LAUNCH.launchFactory,
  'the token factory only accepts the launch factory as launcher', tokLauncher);
check(!!modLauncher && getAddress(modLauncher) === ABYSS_LAUNCH.launchFactory,
  'and so does the module factory');

const coordTok = await pub.readContract({
  address: ABYSS_LAUNCH.coordinator, abi: ABYSS_COORDINATOR_ABI, functionName: 'tokenFactory',
}).catch(() => null);
check(!!coordTok && getAddress(coordTok) === ABYSS_LAUNCH.tokenFactory,
  'and the coordinator points at the same token factory, so the set is one system');

// --- the entry point's signature ------------------------------------------------
//
// Recovered from the deployed bytecode and resolved against openchain, then
// rebuilt as an ABI here. If the ABI in abyss.js does not hash to the selector
// the chain dispatches on, it is wrong - that is what this checks.
const launchFn = ABYSS_LAUNCH_ABI.find((f) => f.name === 'launch');
check(!!launchFn, 'abyss.js carries a launch() ABI');
const selector = toFunctionSelector(launchFn);
check(selector === LAUNCH_SELECTOR,
  'and it hashes to the selector the deployed contract dispatches on',
  `${selector} vs ${LAUNCH_SELECTOR}`);

const params = launchFn.inputs[0].components;
check(params.length === 10, 'the call takes ten fields', `${params.length}`);
check(params[4].type === 'tuple' && params[4].components.length === 6,
  'one of which is the token spec: type, data, name, symbol, decimals, supply');
check(params.filter((p) => p.type === 'tuple' && p.components?.length === 3).length === 3,
  'and three are triples - the price bounds and two fee splits');

// --- the pool key is the one we already trade through ---------------------------
//
// The nice part: the coordinator's computePoolId takes the SAME six-field key
// src/swap.js reverse-engineered for trading, so launch and swap agree.
const SWAP = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'swap.js'), 'utf8');
check(ABYSS_POOL_KEY.length === 6
  && ABYSS_POOL_KEY.map((f) => f.type).join(',') === 'address,address,uint8,uint24,bool,bytes32',
  'the Abyss pool key is six fields, as the swap path found');
check(/profile/.test(SWAP) && /AbyssPoolCreated/.test(SWAP),
  'and the swap path already knows the same shape, so nothing new is invented here');

// The ABI is checked by SELECTOR rather than by calling it. A first attempt
// fed computePoolId a hand-made key and it reverted - correctly, since the
// coordinator validates the key (it has an InvalidPoolKey error) and a pool
// invented out of two unrelated addresses is not one. Fabricating a valid key
// would be inventing exactly the thing this file refuses to invent, so: prove
// the encoding by hashing it, and note that an invalid key is rejected.
const computeFn = ABYSS_COORDINATOR_ABI.find((f) => f.name === 'computePoolId');
check(toFunctionSelector(computeFn) === '0xf8c5761c',
  'the six-field pool key encodes to the selector the coordinator dispatches on',
  toFunctionSelector(computeFn));

const bogus = await pub.readContract({
  address: ABYSS_LAUNCH.coordinator,
  abi: ABYSS_COORDINATOR_ABI,
  functionName: 'computePoolId',
  args: [{
    currency0: getAddress('0x0bd7d308f8e1639fab988df18a8011f41eacad73'),
    currency1: ABYSS_LAUNCH.coordinator,
    profile: 3, fee: 10000, flag: true,
    extra: '0xc0e9bed88d70a13fd3ab31451fefdd073b7266e838aee0ad1c236c8c9eff855d',
  }],
}).then(() => 'accepted').catch(() => 'rejected');
check(bogus === 'rejected',
  'and a made-up key is rejected, so the coordinator really does validate one');

// --- the state, reported rather than asserted ----------------------------------
const status = await abyssLaunchStatus({ connection: pub });
console.log('');
console.log(`   gate wired     ${status.gateWired}`);
console.log(`   registrar      ${status.registrar}`);
console.log(`   INITIAL_VERSION ${status.initialVersion}`);
console.log(`   templates      ${status.templates.length}`);
console.log(`   open           ${status.ready}${status.reason ? ' — ' + status.reason : ''}`);
console.log('');

check(status.gateWired, 'the live gate matches what this file records');
check(typeof status.ready === 'boolean' && (status.ready || !!status.reason),
  'readiness is answered from the chain, with a reason when it is not open');

// --- and the pad agrees with the chain ------------------------------------------
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
const pad = MAIN.slice(MAIN.indexOf("id: 'abyss-robinhood'"), MAIN.indexOf('\n  },', MAIN.indexOf("id: 'abyss-robinhood'")));
check(pad.length > 0, 'the launcher has an Abyss pad');
check(/enabled: false/.test(pad) === !status.ready,
  status.ready
    ? 'Abyss has opened, so the pad should no longer be hardcoded disabled — wire it against a real launch'
    : 'the pad is disabled, which matches the chain saying it is not open');
check(/paintAbyssLine/.test(MAIN) && /abyssLaunchStatus/.test(MAIN),
  'and the page asks the chain whether it has opened rather than trusting a constant');

// --- nothing sends --------------------------------------------------------------
const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'abyss.js'), 'utf8');
check(!/writeContract|sendTransaction|privateKeyToAccount/.test(SRC),
  'abyss.js cannot send a transaction at all - it reads and simulates');
check(/simulateContract/.test(SRC) && typeof simulateAbyssLaunch === 'function',
  'the only launch path offered is a simulation, which is what the chain can validate');
check(Object.keys(ABYSS_LAUNCH_ERRORS).length >= 10,
  'and its errors are named, so a revert reads as a reason rather than four bytes',
  `${Object.keys(ABYSS_LAUNCH_ERRORS).length} errors`);
check(ABYSS_LAUNCH_DEPLOYED.block > 0 && /2026-10-04/.test(ABYSS_LAUNCH_DEPLOYED.iso),
  'the deployment date is recorded, since "deployed hours ago" is the main fact here',
  ABYSS_LAUNCH_DEPLOYED.iso);
check(ABYSS_REGISTRAR === getAddress('0x7cb44b8693b3c350a2bcd4b681af85365aa27783'),
  'the registrar is recorded too - templates appear when that key registers them');

console.log('');
process.exit(fails.length ? 1 : 0);
