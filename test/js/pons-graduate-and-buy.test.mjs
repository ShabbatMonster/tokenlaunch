// Graduating a Pons v2 coin and taking the first buy, in one transaction.
//
// The EVM cousin of the pump.fun snipe, and it differs in every mechanism:
//
//  1. WHICH CALL IS OPEN. This repo used to document forceSweptGraduation as
//     the permissionless rescue path. It is onlyOwner - it answers
//     OwnableUnauthorizedAccount even to Pons's own graduationExecutor. The open
//     one is createGraduatedPool.
//  2. ATOMICITY. An EOA transaction is one call to one address, so there is no
//     equivalent of putting two instructions side by side. Multicall3's
//     aggregate3Value forwards ETH per sub-call, which gets both into one
//     transaction with nothing deployed.
//  3. THE RECIPIENT. Under Multicall3 the Universal Router's caller is
//     Multicall3. The verified swap path elsewhere in this repo ends in
//     TAKE_ALL, which pays the caller - so the tokens would land in Multicall3
//     and stay there. This uses TAKE, which names the recipient.
//  4. THE POOL KEY. The pool does not exist until the first call in the batch
//     creates it, so the key is derived, not read.
//
// Run: node test/js/pons-graduate-and-buy.test.mjs

import { createPublicClient, http, encodeFunctionData, getAddress, parseAbiItem } from 'viem';
import {
  inspectPonsMigration, measurePonsFirstBuy, ponsPoolKey,
  ROBINHOOD, PONS_V2_FACTORY, MULTICALL3, UNIVERSAL_ROUTER,
} from '../../src/ponsMigrate.js';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const pub = createPublicClient({ chain: ROBINHOOD, transport: http(RPC) });

// a funded address on this chain, so a simulation gets past the balance check
const RICH = getAddress('0x2c2572Da570646B402b9b9e625AA102803904a49');
const STRANGER = '0x000000000000000000000000000000000000dEaD';
const POOL_MANAGER = getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951');
const MEME_HOOK = getAddress('0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- which call is open ------------------------------------------------------
const FACTORY_ABI = [
  { type: 'function', name: 'createGraduatedPool', inputs: [{ type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'forceSweptGraduation', inputs: [{ type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'graduationExecutor', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];
const SOME_TOKEN = getAddress('0x2aa5bcab85d4a04d2379b2cd11cd47108f7f7d07');
const executor = await pub.readContract({ address: PONS_V2_FACTORY, abi: FACTORY_ABI, functionName: 'graduationExecutor' });

const errorFor = async (fn, account) => {
  try {
    await pub.call({ to: PONS_V2_FACTORY, account,
      data: encodeFunctionData({ abi: FACTORY_ABI, functionName: fn, args: [SOME_TOKEN] }) });
    return 'SUCCESS';
  } catch (e) {
    try { return e.walk?.((x) => typeof x?.data === 'string')?.data || 'no data'; } catch { return 'no data'; }
  }
};

const OWNABLE_UNAUTHORIZED = '0x118cdaa7';
const forceStranger = await errorFor('forceSweptGraduation', STRANGER);
const forceExecutor = await errorFor('forceSweptGraduation', executor);
console.log(`graduationExecutor is ${executor}`);
check(forceStranger.startsWith(OWNABLE_UNAUTHORIZED) && forceExecutor.startsWith(OWNABLE_UNAUTHORIZED),
  'forceSweptGraduation is onlyOwner - it refuses even the graduationExecutor',
  'executor got ' + forceExecutor.slice(0, 10));

const createStranger = await errorFor('createGraduatedPool', STRANGER);
const createExecutor = await errorFor('createGraduatedPool', executor);
check(createStranger === createExecutor && !createStranger.startsWith(OWNABLE_UNAUTHORIZED),
  'createGraduatedPool gates on the curve, not the caller - same answer for both',
  createStranger.slice(0, 10));

// --- the derived pool key matches real pools --------------------------------
const EV = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
const head = await pub.getBlockNumber();
let pools = [];
let to = head;
for (let i = 0; i < 10 && pools.length < 4; i++) {
  const from = to - 300000n;
  try {
    const got = await pub.getLogs({ address: POOL_MANAGER, event: EV, fromBlock: from, toBlock: to });
    pools = pools.concat(got.filter((l) => getAddress(l.args.hooks) === MEME_HOOK
      && l.args.currency0 === '0x0000000000000000000000000000000000000000'));
  } catch { /* window too busy; try the next one */ }
  to = from - 1n;
}
check(pools.length > 0, 'found live Pons pools to check the derivation against', String(pools.length));

let keyMismatch = null;
for (const l of pools.slice(0, 3)) {
  const token = getAddress(l.args.currency1);
  const derived = ponsPoolKey({ token, pairToken: '0x0000000000000000000000000000000000000000', hooks: MEME_HOOK });
  const same = derived.currency0 === getAddress(l.args.currency0)
    && derived.currency1 === token
    && Number(derived.fee) === Number(l.args.fee)
    && Number(derived.tickSpacing) === Number(l.args.tickSpacing);
  if (!same) keyMismatch = token;
}
check(!keyMismatch, 'the pool key derives correctly for every sampled pool - fee 0, tickSpacing 200',
  keyMismatch ? 'mismatch on ' + keyMismatch : `${Math.min(3, pools.length)} pools`);

// --- the recipient trap ------------------------------------------------------
//
// The buy half is run on its own against a pool that already exists, with the
// balance read back INSIDE the same simulated batch. If TAKE paid the router's
// caller rather than the named recipient, this reads zero and throws.
const liveToken = getAddress(pools[0].args.currency1);
const info = await inspectPonsMigration({ token: liveToken, publicClient: pub });
check(info.isPonsCoin && info.state === 'migrated',
  'a graduated Pons coin is recognised and reported as already migrated',
  `${info.symbol} -> ${info.state}`);

let filled = null;
try {
  const m = await measurePonsFirstBuy({
    token: liveToken, buyer: RICH, buyWei: 10_000_000_000_000_000n, publicClient: pub, skipGraduate: true,
  });
  filled = m.filled;
} catch (e) { filled = null; console.log('   measure failed: ' + (e.shortMessage || e.message).split('\n')[0]); }

check(filled != null && filled > 0n,
  'TAKE pays the named recipient under Multicall3, not Multicall3 itself',
  filled != null ? `0.01 ETH filled ${(Number(filled) / 1e18).toLocaleString()} ${info.symbol}` : 'no fill');

// --- a coin that is not Pons at all -----------------------------------------
const notPons = await inspectPonsMigration({ token: MULTICALL3, publicClient: pub });
check(!notPons.isPonsCoin && notPons.state === 'not-a-pons-coin',
  'a non-Pons contract is refused rather than half-read', notPons.state);

console.log('\nfor reference: Multicall3 ' + MULTICALL3 + ', UniversalRouter ' + UNIVERSAL_ROUTER);
console.log('');
process.exit(fails.length ? 1 : 0);
