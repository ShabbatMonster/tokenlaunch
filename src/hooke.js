// Hooke launchpad on Robinhood chain - the factory WOLFPACK came from.
//
// Recovered from the chain rather than a site or an ABI, because there is
// neither: the hook has launched three coins in its life (all WOLFPACK, all one
// wallet) and no verified source. What is below was decoded from WOLFPACK's own
// launch, 0x9d6c3871...b6ba, and then confirmed by simulating createMeme against
// the live contracts.
//
//   hook      0x7e39dec0...68ec  the launchpad. Creates the token, owns the
//                                curve (it IS the v4 hook on the coin's pool),
//                                and accrues creator fees per coin.
//   factory   0xe0cbefb3...6d1   deploys the token by CREATE2. Its
//                                VANITY_SUFFIX_MASK is 0xffff: every token
//                                address ends in 0000, so the salt is mined.
//   hXMAX     0x71796aad...dbc   the pair. Every coin here is quoted in it -
//                                the hook reads it from hxmax(), there is no
//                                other quote to choose.
//
// createMeme(salt, name, symbol, metadata, creator, true, buy):
//   salt      the creator's 20-byte address followed by 12 mined bytes, so a
//             salt cannot be front-run onto someone else's wallet
//   metadata  ipfs:// URI of {name, symbol, description, image}, <= 128 bytes
//   creator   receives the creator fees (WOLFPACK passes its own wallet)
//   true      every live launch sends true; false reverts InvalidFeeRecipient
//             inside the launch path. Not the token ordering - true launches
//             fine whichever side of hXMAX the mined address sorts on.
//   buy       { mode, amountIn, minTokensOut, minIntermediateOut, deadline }.
//             The dev buy is OPTIONAL: mode 0 with every amount 0 launches with
//             no buy (several live coins did, and it simulates clean from a
//             wallet holding only ETH). mode 1 pays in hXMAX, mode 2 pays in
//             USDG (routed USDG -> hXMAX -> token by the hook itself); either
//             with amountIn 0 reverts InvalidInitialBuy. Paid by transferFrom,
//             so a buy needs an approval to the hook first.
//   value     exactly launchFee() - 0.00025 ETH when decoded. Anything else,
//             including fee + an ETH dev buy, reverts InvalidLaunchFee. ETH is
//             not a payment mode.
//
// The curve itself is the hook's, not ours to set: 800M of the 1B supply sells
// on it and 200M is held for graduation (MemeCurveConfigured on WOLFPACK).

import {
  createPublicClient, http, parseAbi, getAddress, getContractAddress, concat, toHex,
  encodeAbiParameters, encodeFunctionData, encodePacked, defineChain,
} from 'viem';

export const ROBINHOOD_CHAIN = defineChain({
  id: 4663, name: 'Robinhood',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
});

export const HOOKE = {
  hook: getAddress('0x7e39dec0cfe5f63e80663ad96986987670cf68ec'),
  factory: getAddress('0xe0cbefb318a7cdbce6330dc7fab6fadc679cd6d1'),
  hxmax: getAddress('0x71796aad4cdff942d3ee8bb1227f779255f89dbc'),
  usdg: getAddress('0x5fc5360d0400a0fd4f2af552add042d716f1d168'),
  feeHook: getAddress('0xb51d89bbc50b5ae469be8cfbf305cab6ff3a50cc'),
  // the router and v3 pool WOLFPACK's own buyers use for ETH -> USDG
  router: getAddress('0x8876789976decbfcbbbe364623c63652db8c0904'),
  weth: getAddress('0x0bd7d308f8e1639fab988df18a8011f41eacad73'),
  wethUsdgPool: getAddress('0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca'),
  // the WOLFPACK launch every field above was read off
  referenceTx: '0x9d6c38716b404c6967264fcaaa249f24d7ff60ebdb47030bec640b7341f5b6ba',
};

export const HOOKE_PAY = {
  HXMAX: { mode: 1, symbol: 'hXMAX', decimals: 18 },
  USDG: { mode: 2, symbol: 'USDG', decimals: 6 },
};

export const HOOKE_ABI = parseAbi([
  'function createMeme(bytes32 salt, string name, string symbol, string metadata, address creator, bool flag, (uint8 mode, uint256 amountIn, uint256 minTokensOut, uint256 minIntermediateOut, uint256 deadline) buy) payable returns (address token, uint256 tokensOut)',
  'function launchFee() view returns (uint256)',
  'function hxmax() view returns (address)',
  'function stablecoin() view returns (address)',
  'function feeHook() view returns (address)',
  'function MAX_METADATA_BYTES() view returns (uint256)',
  'function claimCreatorFees(address token) returns (uint256 claimed)',
  'function graduationTarget(address token) view returns (uint256)',
]);
// the factory getter has no recoverable name; 0xc45a0155 returns the factory
const FACTORY_GETTER = '0xc45a0155';

export const HOOKE_FACTORY_ABI = parseAbi([
  'function VANITY_SUFFIX_MASK() view returns (uint256)',
  'function initCodeHash(string name, string symbol, address minter) view returns (bytes32)',
  'function computeAddress(bytes32 salt, string name, string symbol, address minter) view returns (address)',
]);

export const HOOKE_ERRORS = {
  '0x4fb6a7b3': 'InvalidInitialBuy - the dev buy does not match its mode (mode 0 = no buy with every amount 0; modes 1/2 need an amount)',
  '0x26e49117': 'InvalidLaunchFee - send exactly the launch fee, nothing more',
  '0x768dc598': 'InvalidFeeRecipient',
  '0x13be252b': 'InsufficientAllowance - USDG not approved to the hook',
  '0xfb8f41b2': 'ERC20InsufficientAllowance - hXMAX not approved to the hook',
  '0x6cfd1095': 'HxmaxTwapOutOfBand - the hXMAX price moved too far from its average; retry shortly',
  '0x45965b35': 'CurveOutOfRange',
  '0x8d955c8f': 'CurveLiquidityLocked',
};

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const V3_POOL = parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function fee() view returns (uint24)']);
const UR_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);

export const hookePublicClient = (rpc = ROBINHOOD_CHAIN.rpcUrls.default.http[0]) =>
  createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(rpc, { retryCount: 4, retryDelay: 1500 }) });

/// Read the live config and say whether it is still the contract this file
/// was written against. A redeploy or a changed pair would otherwise launch
/// somewhere nobody intended.
export async function hookeStatus(pub) {
  const [launchFee, hxmax, stablecoin, maxMeta, factoryWord, mask] = await Promise.all([
    pub.readContract({ address: HOOKE.hook, abi: HOOKE_ABI, functionName: 'launchFee' }),
    pub.readContract({ address: HOOKE.hook, abi: HOOKE_ABI, functionName: 'hxmax' }),
    pub.readContract({ address: HOOKE.hook, abi: HOOKE_ABI, functionName: 'stablecoin' }),
    pub.readContract({ address: HOOKE.hook, abi: HOOKE_ABI, functionName: 'MAX_METADATA_BYTES' }),
    pub.call({ to: HOOKE.hook, data: FACTORY_GETTER }).then((r) => r.data),
    pub.readContract({ address: HOOKE.factory, abi: HOOKE_FACTORY_ABI, functionName: 'VANITY_SUFFIX_MASK' }),
  ]);
  const factory = getAddress('0x' + factoryWord.slice(-40));
  const problems = [];
  if (hxmax !== HOOKE.hxmax) problems.push(`the pair moved from hXMAX to ${hxmax}`);
  if (stablecoin !== HOOKE.usdg) problems.push(`the stablecoin moved from USDG to ${stablecoin}`);
  if (factory !== HOOKE.factory) problems.push(`the token factory moved to ${factory}`);
  return {
    launchFee, hxmax, stablecoin, factory,
    maxMetadataBytes: Number(maxMeta),
    // the mask is the low bits that must be zero; 0xffff means "ends in 0000"
    vanitySuffix: '0'.repeat(mask.toString(16).length),
    ok: problems.length === 0,
    problems,
  };
}

/// Mine a salt whose token address ends in the factory's vanity suffix.
///
/// The salt is the creator's address followed by 12 counter bytes, which is how
/// every live launch is shaped. The counter starts at a random point so two
/// launches of the same name from the same wallet do not mine the same address
/// - WOLFPACK was launched three times and the second would have collided.
/// ~65k tries on average; ~150ms in practice.
export function mineHookeSalt({ creator, initCodeHash, factory = HOOKE.factory, suffix = '0000', start = null, maxTries = 5_000_000 }) {
  const prefix = getAddress(creator);
  let i = start ?? BigInt('0x' + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join(''));
  for (let n = 0; n < maxTries; n++, i++) {
    const salt = concat([prefix, toHex(i & ((1n << 96n) - 1n), { size: 12 })]);
    const token = getContractAddress({ opcode: 'CREATE2', from: factory, salt, bytecodeHash: initCodeHash });
    if (token.toLowerCase().endsWith(suffix)) return { salt, token, tries: n + 1 };
  }
  throw new Error(`no ${suffix} address found in ${maxTries.toLocaleString()} tries`);
}

/// Mine a salt and prove it: the factory's own computeAddress must agree, and
/// nothing may already live at that address.
export async function prepareHookeSalt(pub, { creator, name, symbol, status }) {
  const initCodeHash = await pub.readContract({
    address: HOOKE.factory, abi: HOOKE_FACTORY_ABI, functionName: 'initCodeHash', args: [name, symbol, HOOKE.hook],
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    const mined = mineHookeSalt({ creator, initCodeHash, suffix: status?.vanitySuffix || '0000' });
    const onChain = await pub.readContract({
      address: HOOKE.factory, abi: HOOKE_FACTORY_ABI, functionName: 'computeAddress', args: [mined.salt, name, symbol, HOOKE.hook],
    });
    if (getAddress(onChain) !== getAddress(mined.token)) {
      throw new Error(`mined ${mined.token} but the factory computes ${onChain} - the address derivation changed`);
    }
    const code = await pub.getCode({ address: mined.token });
    if (!code || code === '0x') return { ...mined, initCodeHash };
  }
  throw new Error('every mined address was already taken - try again');
}

/// The createMeme arguments, in the order and shape WOLFPACK's launch used.
export function hookeCreateArgs({ salt, name, symbol, metadata, creator, mode, amountIn, minTokensOut, deadline }) {
  return [salt, name, symbol, metadata, getAddress(creator), true, {
    mode, amountIn, minTokensOut, minIntermediateOut: 0n, deadline,
  }];
}

/// Explain a revert in the hook's own terms where it has one.
export function hookeRevertReason(e) {
  const raw = String(e?.cause?.data?.errorName || e?.cause?.signature || e?.data || e?.message || e);
  for (const [sel, why] of Object.entries(HOOKE_ERRORS)) {
    if (raw.includes(sel) || raw.includes(why.split(' ')[0])) return why;
  }
  return e?.shortMessage || e?.message || String(e);
}

/// USDG out per ETH in, from the v3 pool's spot price. Used to size an ETH ->
/// USDG swap that is guaranteed - by its own minimum - to deliver the amount
/// the dev buy needs.
export async function usdgPerEth(pub) {
  const [s0] = await pub.readContract({ address: HOOKE.wethUsdgPool, abi: V3_POOL, functionName: 'slot0' });
  // token0 = WETH (18dp), token1 = USDG (6dp)
  return (Number(s0) / 2 ** 96) ** 2 * 1e18 / 1e6;
}

/// Universal Router calldata for ETH -> exactly-at-least `usdgOut` USDG.
///
/// Spends `ethIn` and refuses to deliver less than `usdgOut`, so the dev buy
/// that follows is covered or nothing happens. The v3 exact-in input carries a
/// sixth field on this router version (empty on every live swap); leaving it
/// out reverts SliceOutOfBounds.
export async function buildEthToUsdg(pub, { recipient, usdgOut, buffer = 1.03, deadline }) {
  const price = await usdgPerEth(pub);
  const fee = await pub.readContract({ address: HOOKE.wethUsdgPool, abi: V3_POOL, functionName: 'fee' });
  const ethIn = BigInt(Math.ceil(Number(usdgOut) / 1e6 / price * buffer * 1e18));
  const path = encodePacked(['address', 'uint24', 'address'], [HOOKE.weth, fee, HOOKE.usdg]);
  const inputs = [
    // WRAP_ETH to the router itself (0x...02 = ADDRESS_THIS)
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], ['0x0000000000000000000000000000000000000002', ethIn]),
    // V3_SWAP_EXACT_IN, paid from the router's WETH
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
      [getAddress(recipient), ethIn, usdgOut, path, false, []],
    ),
  ];
  const data = encodeFunctionData({ abi: UR_ABI, functionName: 'execute', args: ['0x0b00', inputs, deadline] });
  return { to: HOOKE.router, data, value: ethIn, ethIn, price };
}

// --- creator fees --------------------------------------------------------------
//
// Every trade pays a 1% fee in hXMAX, split 75% to the coin's creator and 25% to
// the platform (MemeFeeAccrued carries the trade, the fee, and both shares).
// The creator's share sits in the hook until claimCreatorFees(token) is called.
//
// launches(token) is the per-coin record, unnamed fields read by position:
//   [0] the wallet that launched     [5] who the creator fees are paid to
//   [8] unclaimed creator fees, hXMAX
// [5] is the createMeme `creator` argument, and is distinct from [0]: a
// simulated launch by one wallet naming another as recipient stored them
// separately, and the claim paid [5]. Anyone may call the claim - it pays [5]
// whoever sends it - so listing it for a coin you did not launch is harmless.

/// Where the hook was deployed; the first launch through it is block 88,512,998.
export const HOOKE_START_BLOCK = 88_500_000n;

// All three addresses are indexed - read off a simulated launch whose launcher
// and fee recipient differed, which put them in topics 2 and 3 respectively.
// The data carries the pool id and the salt, then the three strings.
const MEME_LAUNCHED = parseAbi([
  'event MemeLaunched(address indexed token, address indexed launcher, address indexed feeRecipient, bytes32 poolId, bytes32 salt, string name, string symbol, string metadata)',
])[0];

export async function hookeLaunchInfo(pub, token) {
  const r = await pub.call({ to: HOOKE.hook, data: '0x1f2d8550' + getAddress(token).slice(2).toLowerCase().padStart(64, '0') });
  const w = (r.data || '0x').slice(2).match(/.{64}/g) || [];
  if (w.length < 9 || /^0+$/.test(w[0])) return null;               // not a Hooke coin
  return {
    token: getAddress(token),
    launcher: getAddress('0x' + w[0].slice(24)),
    feeRecipient: getAddress('0x' + w[5].slice(24)),
    unclaimed: BigInt('0x' + w[8]),
  };
}

/// Every Hooke coin a wallet launched or is paid the creator fees of.
///
/// Two filtered queries - launcher, then fee recipient - so the cost follows
/// your own launches rather than the platform's (24 launches by its second
/// day). Walked in chunks because the RPC caps a single query.
export async function hookeCoinsOf(pub, address) {
  const me = getAddress(address);
  const head = await pub.getBlockNumber();
  const tokens = new Map();
  for (let from = HOOKE_START_BLOCK; from <= head; from += 2_000_000n) {
    const to = from + 1_999_999n > head ? head : from + 1_999_999n;
    const [asLauncher, asRecipient] = await Promise.all([
      pub.getLogs({ address: HOOKE.hook, event: MEME_LAUNCHED, args: { launcher: me }, fromBlock: from, toBlock: to }),
      pub.getLogs({ address: HOOKE.hook, event: MEME_LAUNCHED, args: { feeRecipient: me }, fromBlock: from, toBlock: to }),
    ]);
    for (const l of [...asLauncher, ...asRecipient]) tokens.set(getAddress(l.args.token), l.args.symbol);
  }
  const infos = await Promise.all([...tokens].map(async ([t, symbol]) => {
    const info = await hookeLaunchInfo(pub, t).catch(() => null);
    return info && { ...info, symbol };
  }));
  return infos.filter(Boolean);
}

export { ERC20 as HOOKE_ERC20 };
