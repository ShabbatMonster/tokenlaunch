import {
  createPublicClient, createWalletClient, http, defineChain, getAddress,
  encodeFunctionData, encodeAbiParameters, parseAbiParameters, decodeAbiParameters,
  formatEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Graduating a Pons v2 coin, and being the first buy - the EVM cousin of the
// pump.fun snipe.
//
// WHICH CALL. Not forceSweptGraduation, whatever this repo used to say about
// it: that one is onlyOwner and answers OwnableUnauthorizedAccount even to
// Pons's own graduationExecutor. The open one is createGraduatedPool, and it is
// open in the ordinary sense - simulated from a stranger and from the executor
// it returns the same state error, so the gate is the curve, not the caller. On
// mainnet five different non-executor addresses have called it.
//
// ATOMICITY WITHOUT A CONTRACT. An EOA transaction is one call to one address,
// so the Solana trick of putting two instructions side by side is not available.
// What is available is Multicall3, deployed at its canonical address here, whose
// aggregate3Value forwards ETH per sub-call. Graduating and buying therefore fit
// in one transaction with nothing deployed: createGraduatedPool first, the
// Universal Router second. Somebody is already doing this through a contract of
// their own (0x5c847BE2..., 5555 bytes, 0.15 ETH in one transaction touching the
// factory, the PoolManager, the hook and Permit2), so the pattern is not
// theoretical.
//
// THE RECIPIENT TRAP. Under Multicall3 the Universal Router's caller is
// Multicall3, not you. The verified swap path elsewhere in this repo ends in
// TAKE_ALL, which pays the router's caller - so the tokens would land in
// Multicall3 and stay there. This uses TAKE instead, which names the recipient
// outright. That difference is the whole reason this file does not simply reuse
// swap.js's plan.
//
// THE POOL DOES NOT EXIST YET, so its key is derived rather than read. Checked
// across 48 live Pons pools: fee 0, tickSpacing 200, hooks = factory.memeHook(),
// currencies the token and the curve's pairToken sorted, with native ETH as
// address(0) sorting first.
//
// This is a RACE, not a rescue. Pons's executor sweeps promptly - of 600 recent
// launches, none was ready-and-ungraduated - and the chain is an Arbitrum Nitro
// sequencer, first come first served, with no bundles to buy priority with.
// ---------------------------------------------------------------------------

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const ROBINHOOD = defineChain({
  id: 4663, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

export const PONS_V2_FACTORY = getAddress('0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e');
export const MULTICALL3 = getAddress('0xcA11bde05977b3631167028862bE2a173976CA11');
export const UNIVERSAL_ROUTER = getAddress('0x8876789976DeCBFcBBbE364623C63652DB8C0904');
const ZERO = '0x0000000000000000000000000000000000000000';

/// Constant across all 48 live Pons pools sampled.
const PONS_FEE = 0;
const PONS_TICK_SPACING = 200;

const FACTORY_ABI = [
  { type: 'function', name: 'createGraduatedPool', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'memeHook', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];
const TOKEN_ABI = [
  { type: 'function', name: 'curve', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'launchFactory', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
];
const CURVE_ABI = [
  { type: 'function', name: 'pairToken', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'graduated', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'readyToGraduate', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'quoteReserve', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'graduationThreshold', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];
const MULTICALL3_ABI = [{
  type: 'function', name: 'aggregate3Value', stateMutability: 'payable',
  inputs: [{ name: 'calls', type: 'tuple[]', components: [
    { name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' },
    { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' },
  ] }],
  outputs: [{ name: 'returnData', type: 'tuple[]', components: [
    { name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' },
  ] }],
}];
const UNIVERSAL_ROUTER_ABI = [{
  type: 'function', name: 'execute', stateMutability: 'payable',
  inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }],
  outputs: [],
}];

const V4_POOL_KEY = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
];
const EXACT_IN_SINGLE_PARAMS = [{ type: 'tuple', components: [
  { name: 'poolKey', type: 'tuple', components: V4_POOL_KEY },
  { name: 'zeroForOne', type: 'bool' },
  { name: 'amountIn', type: 'uint128' },
  { name: 'amountOutMinimum', type: 'uint128' },
  { name: 'hookData', type: 'bytes' },
] }];

const V4_SWAP = '0x10';
// SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE. The last one is the difference from
// the swap page: TAKE_ALL pays the router's caller, which under Multicall3 is
// Multicall3 - TAKE names the recipient instead.
const V4_ACTIONS = '0x060c0e';

/// The address an EVM key controls, for the worker to probe with.
export const evmAddressFromKey = (privateKey) => privateKeyToAccount(privateKey).address;

export const clientFor = (privateKey) => {
  const publicClient = createPublicClient({ chain: ROBINHOOD, transport: http(RPC, { retryCount: 4, retryDelay: 500 }) });
  if (!privateKey) return { publicClient, account: null, walletClient: null };
  const account = privateKeyToAccount(privateKey);
  return { publicClient, account, walletClient: createWalletClient({ account, chain: ROBINHOOD, transport: http(RPC) }) };
};

/// The pool createGraduatedPool is about to open. Derived, because it does not
/// exist yet - there is nothing to read.
export function ponsPoolKey({ token, pairToken, hooks }) {
  const a = getAddress(token);
  const b = pairToken && pairToken !== ZERO ? getAddress(pairToken) : ZERO;
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0, currency1, fee: PONS_FEE, tickSpacing: PONS_TICK_SPACING, hooks: getAddress(hooks) };
}

/// One V4_SWAP command that buys `token` with native ETH and pays `recipient`.
function buyPlan({ poolKey, amountIn, minOut, recipient }) {
  const zeroForOne = poolKey.currency0 === ZERO
    || BigInt(poolKey.currency0) < BigInt(poolKey.currency1) === false;
  // the side we spend is whichever currency is the pair token, and for a native
  // pair that is currency0 (address(0) sorts first)
  const z = poolKey.currency0 === ZERO ? true : zeroForOne;
  const currencyIn = z ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = z ? poolKey.currency1 : poolKey.currency0;
  const params = [
    encodeAbiParameters(EXACT_IN_SINGLE_PARAMS, [{
      poolKey, zeroForOne: z, amountIn, amountOutMinimum: minOut, hookData: '0x',
    }]),
    encodeAbiParameters(parseAbiParameters('address, uint256'), [currencyIn, amountIn]),
    // TAKE(currency, recipient, amount): naming the recipient is the point
    encodeAbiParameters(parseAbiParameters('address, address, uint256'), [currencyOut, recipient, minOut]),
  ];
  const input = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [V4_ACTIONS, params]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  return {
    currencyIn, currencyOut,
    callData: encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [V4_SWAP, [input], deadline] }),
  };
}

/// What state this Pons coin is in.
export async function inspectPonsMigration({ token, user, publicClient: pc }) {
  const publicClient = pc || clientFor(null).publicClient;
  const addr = getAddress(token);
  const read = (abi, address, functionName, args = []) =>
    publicClient.readContract({ address, abi, functionName, args });

  let curve = null;
  let factory = null;
  try {
    [curve, factory] = await Promise.all([
      read(TOKEN_ABI, addr, 'curve'), read(TOKEN_ABI, addr, 'launchFactory'),
    ]);
  } catch {
    return { venue: 'pons', isPonsCoin: false, state: 'not-a-pons-coin',
      reason: 'This address does not look like a Pons launch token (no curve() on it).' };
  }
  if (!curve || curve === ZERO || getAddress(factory) !== PONS_V2_FACTORY) {
    return { venue: 'pons', isPonsCoin: false, state: 'not-a-pons-coin',
      reason: 'This token was not launched by the Pons v2 factory.' };
  }

  const [pairToken, graduated, ready, reserve, threshold, hooks, symbol, decimals] = await Promise.all([
    read(CURVE_ABI, curve, 'pairToken').catch(() => ZERO),
    read(CURVE_ABI, curve, 'graduated').catch(() => null),
    read(CURVE_ABI, curve, 'readyToGraduate').catch(() => null),
    read(CURVE_ABI, curve, 'quoteReserve').catch(() => null),
    read(CURVE_ABI, curve, 'graduationThreshold').catch(() => null),
    read(FACTORY_ABI, PONS_V2_FACTORY, 'memeHook'),
    read(TOKEN_ABI, addr, 'symbol').catch(() => null),
    read(TOKEN_ABI, addr, 'decimals').catch(() => 18),
  ]);

  const poolKey = ponsPoolKey({ token: addr, pairToken, hooks });
  const common = {
    venue: 'pons', isPonsCoin: true, token: addr, curve: getAddress(curve),
    pairToken: pairToken === ZERO ? null : getAddress(pairToken),
    isNativeQuote: pairToken === ZERO,
    symbol, decimals: Number(decimals),
    quoteReserve: reserve?.toString() ?? null,
    graduationThreshold: threshold?.toString() ?? null,
    poolKey: { ...poolKey, fee: Number(poolKey.fee), tickSpacing: Number(poolKey.tickSpacing) },
  };

  if (graduated) {
    return { ...common, state: 'migrated', reason: 'This curve has already graduated into its Uniswap v4 pool.' };
  }
  if (!ready) {
    return { ...common, state: 'on-curve',
      reason: 'The curve has not reached its graduation threshold yet.' };
  }
  // ready and not graduated: simulate rather than assume
  const probe = user ? getAddress(user) : '0x000000000000000000000000000000000000dEaD';
  try {
    await publicClient.call({
      to: PONS_V2_FACTORY,
      data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createGraduatedPool', args: [addr] }),
      account: probe,
    });
    return { ...common, state: 'migratable', reason: null };
  } catch (e) {
    const data = (() => { try { return e.walk?.((x) => typeof x?.data === 'string')?.data; } catch { return null; } })();
    return { ...common, state: 'blocked',
      reason: 'createGraduatedPool does not simulate: ' + (data || e.shortMessage || e.message) };
  }
}

/// The one transaction: graduate, then buy, then (when measuring) read back the
/// balance so the fill is a fact rather than a model.
function batchCalls({ token, poolKey, buyWei, minOut, recipient, withBalance, skipGraduate }) {
  const plan = buyPlan({ poolKey, amountIn: buyWei, minOut, recipient });
  const calls = [];
  // skipGraduate is how the buy half gets tested on its own, against a pool that
  // already exists - the graduate call would revert on one of those
  if (!skipGraduate) {
    calls.push({
      target: PONS_V2_FACTORY, allowFailure: false, value: 0n,
      callData: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createGraduatedPool', args: [token] }),
    });
  }
  calls.push({ target: UNIVERSAL_ROUTER, allowFailure: false, value: buyWei, callData: plan.callData });
  if (withBalance) {
    calls.push({
      target: token, allowFailure: false, value: 0n,
      callData: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'balanceOf', args: [recipient] }),
    });
  }
  return calls;
}

/// How many tokens the buy really returns, read out of a simulation of the
/// whole batch rather than modelled. The pool does not exist until the first
/// call in this very batch creates it, so there is nothing to quote against.
export async function measurePonsFirstBuy({ token, buyer, buyWei, publicClient: pc, skipGraduate = false }) {
  const publicClient = pc || clientFor(null).publicClient;
  const info = await inspectPonsMigration({ token, user: buyer, publicClient });
  if (!info.isPonsCoin) throw new Error(info.reason);

  const recipient = getAddress(buyer);
  const before = await publicClient.readContract({
    address: info.token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [recipient],
  }).catch(() => 0n);

  const calls = batchCalls({
    token: info.token, poolKey: info.poolKey, buyWei: BigInt(buyWei),
    minOut: 0n, recipient, withBalance: true, skipGraduate,
  });
  const res = await publicClient.call({
    to: MULTICALL3, account: recipient, value: BigInt(buyWei),
    data: encodeFunctionData({ abi: MULTICALL3_ABI, functionName: 'aggregate3Value', args: [calls] }),
  });
  const [results] = decodeAbiParameters(MULTICALL3_ABI[0].outputs, res.data);
  const last = results[results.length - 1];
  if (!last?.success) throw new Error('the batch simulated but the balance read failed');
  const [after] = decodeAbiParameters(parseAbiParameters('uint256'), last.returnData);
  const filled = after - before;
  if (filled <= 0n) throw new Error('the simulated buy filled nothing');
  return { filled, before, after, info };
}

/// Graduate the curve and take the first buy, in one transaction.
export async function migratePons({
  privateKey, token, buyWei, slippageBps = 4000, dryRun = false, onStatus,
}) {
  const say = (m) => onStatus && onStatus(m);
  const { publicClient, account, walletClient } = clientFor(privateKey);
  if (!account) throw new Error('no EVM key - Pons runs on Robinhood Chain, not Solana');

  const spend = BigInt(buyWei || 0);
  const info = await inspectPonsMigration({ token, user: account.address, publicClient });
  if (!info.isPonsCoin) throw new Error(info.reason);
  if (info.state === 'migrated') throw new Error('this curve has already graduated');
  if (info.state === 'on-curve') throw new Error('the curve has not reached its graduation threshold yet');
  if (info.state === 'blocked') throw new Error(info.reason);
  if (!info.isNativeQuote && spend > 0n) {
    throw new Error(
      'this coin is paired against ' + info.pairToken + ', not native ETH. The buy half only handles a '
      + 'native pair for now; graduate it with the amount at 0 and swap separately.',
    );
  }

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < spend) {
    throw new Error(`need ${formatEther(spend)} ETH for the buy plus gas, and the wallet holds ${formatEther(balance)}`);
  }

  // graduation alone, when no buy was asked for
  if (spend === 0n) {
    say('graduating...');
    const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createGraduatedPool', args: [info.token] });
    if (dryRun) { await publicClient.call({ to: PONS_V2_FACTORY, data, account }); return { dryRun: true, route: 'graduate-only' }; }
    const hash = await walletClient.sendTransaction({ to: PONS_V2_FACTORY, data });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error('the graduation reverted: ' + hash);
    return { venue: 'pons', route: 'graduate-only', hash, token: info.token };
  }

  say('measuring what the first buy fills...');
  const measured = await measurePonsFirstBuy({ token: info.token, buyer: account.address, buyWei: spend, publicClient });
  const floorRaw = measured.filled - (measured.filled * BigInt(Math.round(slippageBps))) / 10_000n;
  const minOut = floorRaw > 0n ? floorRaw : 1n;
  say(`fills ${measured.filled}, floor ${minOut}`);

  const calls = batchCalls({
    token: info.token, poolKey: info.poolKey, buyWei: spend,
    minOut, recipient: account.address, withBalance: false,
  });
  const data = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: 'aggregate3Value', args: [calls] });

  say('simulating the whole batch...');
  await publicClient.call({ to: MULTICALL3, data, value: spend, account });

  if (dryRun) return { dryRun: true, route: 'graduate-and-buy', filled: measured.filled.toString(), minOut: minOut.toString() };

  say('sending...');
  const hash = await walletClient.sendTransaction({ to: MULTICALL3, data, value: spend });
  say('waiting for confirmation...');
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('the transaction reverted: ' + hash);

  return {
    venue: 'pons', route: 'graduate-and-buy', hash, token: info.token,
    filled: measured.filled.toString(), minOut: minOut.toString(),
  };
}
