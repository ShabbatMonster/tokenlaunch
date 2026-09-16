import {
  createPublicClient, createWalletClient, http, defineChain,
  parseUnits, getAddress, encodeFunctionData, decodeEventLog, parseAbiItem,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Argus (argus.world) - a launchpad on Arc, Circle's USDC-gas L1.
//
// Nothing here is documented anywhere. Argus publishes no ABI, the factory is
// not verified, and its launch selector is not in any signature database. So
// the shape below was read off real launches: RAMBO
// (0x60f4D66B464bFCE01Ffa6B8145A1116Dc537de65, "Rambo Cat") plus six others
// launched minutes apart, diffed field by field to separate the constants from
// the choices.
//
// A launched token is a 45-byte EIP-1167 clone of 0x1B74922c..., the pool is
// Uniswap v4 (the PoolManager appears in every launch receipt at the same
// canonical address it uses on other chains), and the quote is Arc's USDC at
// 0x3600...0000.
//
// The launch call is selector 0x11b8f0f1 with two structs and two bytes32:
//
//   f(LaunchConfig, Metadata, bytes32 salt, bytes32 nonce)
//
// ---------------------------------------------------------------------------

export const ARC_CHAIN_ID = 5042;
const RPC = 'https://arc.drpc.org';

export const ARC = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc',
  // Arc is USDC-gas; the native unit is 18 decimals at the protocol level even
  // though the USDC *token* used for pricing here is 6
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

export const ARGUS_FACTORY = '0xB021Be536808f551b31789422Fd28a6c9c6e97Da';
export const ARGUS_TOKEN_IMPL = '0x1B74922c01DDfD9C77B37D02C0a236611E8Fe500';
/// Arc's USDC, and the only quote every observed launch used.
export const ARC_USDC = '0x3600000000000000000000000000000000000000';

// Every launch deploys a Uniswap v4 hook by CREATE2 from the factory, and its
// address is MINED: the low 14 bits must equal 0x2044, which in v4's encoding is
// BEFORE_INITIALIZE | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA - a hook that sets
// the pool up and takes a slice of every swap. Read from two separate launches
// whose hooks both end in ...044 despite nothing else matching.
export const ARGUS_HOOK_FLAGS = 0x2044;
const USDC_DECIMALS = 6;

// Constant in all seven launches read, so they are protocol settings rather
// than things a creator picks. Named for what they appear to be; they are
// passed through verbatim either way.
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;   // 1B, 18dp
const CURVE_START = 2_500_000_000n;                 // 2,500 USDC
const GRADUATION = 45_000_000_000n;                 // 45,000 USDC
const RESERVED_ZERO = 0n;
const TRAILING_ONE = 1n;

/// Where a coin's trading fees go. Exactly one of the three carries 10000
/// (100%); the other two are zero. Which slot is set is the only difference
/// between the launches, so this is the "fees to holders" switch.
///
/// `holders` is the slot RAMBO uses - the launch you pointed at as the right
/// way to do it - and it is the one that makes the factory deploy an extra
/// contract (a second EIP-1167 clone, ~490k more gas, one more emitter in the
/// receipt than either other mode). That extra clone is the payout contract;
/// no other mode creates one.
export const FEE_MODES = { creator: 0, buyback: 1, holders: 2 };
const FEE_MODE_LABEL = ['creator', 'buyback//second slot', 'holders'];

const LAUNCH_ABI = [{
  type: 'function', name: 'launch', stateMutability: 'nonpayable',
  inputs: [
    { name: 'config', type: 'tuple', components: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'totalSupply', type: 'uint256' },
      { name: 'curveStart', type: 'uint256' },
      { name: 'graduation', type: 'uint256' },
      { name: 'buyFeeBps', type: 'uint256' },
      { name: 'sellFeeBps', type: 'uint256' },
      { name: 'feeToCreatorBps', type: 'uint256' },
      { name: 'feeToBuybackBps', type: 'uint256' },
      { name: 'feeToHoldersBps', type: 'uint256' },
      { name: 'reserved', type: 'uint256' },
      { name: 'devBuy', type: 'uint256' },
      { name: 'quote', type: 'address' },
      { name: 'flag', type: 'uint256' },
    ] },
    { name: 'meta', type: 'tuple', components: [
      { name: 'uri', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'creatorHandle', type: 'string' },
      { name: 'telegram', type: 'string' },
      { name: 'twitter', type: 'string' },
    ] },
    { name: 'salt', type: 'bytes32' },
    { name: 'nonce', type: 'bytes32' },
  ],
  outputs: [],
}];

// the factory's own selector, which is what actually goes on the wire - the
// name "launch" above is ours, since Argus publishes none
const LAUNCH_SELECTOR = '0x11b8f0f1';

// The factory answers this when the salt, the nonce or the fee is not one it
// issued. All three feed the mined hook address, which is why changing any of
// them produces the same error while changing the name, the supply or the dev
// buy does not.
const SALT_ERROR = '0x2cc656a4';

export const ARGUS_SALT_BLOCKER =
  'Argus rejected the salt. A launch deploys a Uniswap v4 hook at a CREATE2 address whose low 14 bits '
  + 'must be 0x2044, so the salt has to be mined - and the factory derives its CREATE2 salt from the two '
  + 'bytes32 arguments by a rule that is not any of the obvious hashes of them. Replaying a real launch '
  + 'at the block before it happened succeeds, so everything else in this encoding is right; what is '
  + 'missing is that derivation, which needs the factory disassembled.';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

function randomBytes32() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/// The second bytes32 is never full width in a real launch: its top eight bytes
/// are always zero. Mirrored rather than guessed at.
function randomNonce() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  b.fill(0, 0, 8);
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function feeSplit(mode) {
  const m = typeof mode === 'string' ? FEE_MODES[mode] : mode;
  if (m === undefined || m === null) throw new Error(`unknown fee mode "${mode}"`);
  return {
    feeToCreatorBps: m === FEE_MODES.creator ? 10000n : 0n,
    feeToBuybackBps: m === FEE_MODES.buyback ? 10000n : 0n,
    feeToHoldersBps: m === FEE_MODES.holders ? 10000n : 0n,
  };
}

/// Build the calldata for a launch. Exposed on its own so it can be diffed
/// against a real launch without sending anything.
export function encodeArgusLaunch(opts) {
  const {
    name, symbol, uri = '', description = '', creatorHandle = '', telegram = '', twitter = '',
    feeBps = 100, feeMode = 'holders', devBuyUsdc = 0,
    quote = ARC_USDC, salt = randomBytes32(), nonce = randomNonce(),
  } = opts;

  if (!name) throw new Error('a name is required');
  if (!symbol) throw new Error('a symbol is required');
  const bps = BigInt(Math.round(Number(feeBps)));
  // every launch read used 100, 200 or 300 on both sides, always equal
  if (bps < 0n || bps > 10000n) throw new Error('fee must be between 0 and 10000 bps');

  const config = {
    name, symbol,
    totalSupply: TOTAL_SUPPLY,
    curveStart: CURVE_START,
    graduation: GRADUATION,
    buyFeeBps: bps,
    sellFeeBps: bps,
    ...feeSplit(feeMode),
    reserved: RESERVED_ZERO,
    devBuy: parseUnits(String(devBuyUsdc || 0), USDC_DECIMALS),
    quote: getAddress(quote),
    flag: TRAILING_ONE,
  };
  const meta = { uri, description, creatorHandle, telegram, twitter };

  const data = encodeFunctionData({ abi: LAUNCH_ABI, functionName: 'launch', args: [config, meta, salt, nonce] });
  // viem derives the selector from our invented name, so put the real one back
  return { data: LAUNCH_SELECTOR + data.slice(10), config, meta, salt, nonce };
}

export function argusClients(privateKey) {
  const publicClient = createPublicClient({ chain: ARC, transport: http(RPC, { retryCount: 5, retryDelay: 600 }) });
  if (!privateKey) return { publicClient, account: null, walletClient: null };
  const account = privateKeyToAccount(privateKey);
  return { publicClient, account, walletClient: createWalletClient({ account, chain: ARC, transport: http(RPC) }) };
}

/// Launch a coin on Argus. Fees go to holders unless told otherwise.
export async function launchArgus(opts) {
  const { privateKey, dryRun = false, onStatus } = opts;
  const say = (m) => onStatus && onStatus(m);
  const { publicClient, account, walletClient } = argusClients(privateKey);
  if (!account) throw new Error('no key - Argus launches need an Arc wallet');

  const built = encodeArgusLaunch(opts);
  const mode = typeof opts.feeMode === 'string' ? FEE_MODES[opts.feeMode] : (opts.feeMode ?? FEE_MODES.holders);
  say(`fee ${built.config.buyFeeBps} bps, all of it to ${FEE_MODE_LABEL[mode]}`);

  const tx = { to: getAddress(ARGUS_FACTORY), data: built.data, account, value: 0n };

  say('simulating...');
  try {
    await publicClient.call(tx);
  } catch (e) {
    const data = (() => { try { return e.walk?.((x) => typeof x?.data === 'string')?.data; } catch { return null; } })();
    if (typeof data === 'string' && data.startsWith(SALT_ERROR)) throw new Error(ARGUS_SALT_BLOCKER);
    throw e;
  }

  if (dryRun) {
    say('simulation passed');
    return { dryRun: true, data: built.data, config: built.config };
  }

  say('sending launch...');
  const hash = await walletClient.sendTransaction(tx);
  say('waiting for confirmation...');
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('launch reverted: ' + hash);

  // the new token is whichever contract minted the supply to the curve
  let token = null;
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
      if (ev.args.from === '0x0000000000000000000000000000000000000000') { token = getAddress(log.address); break; }
    } catch { /* not a Transfer */ }
  }
  return { token, hash, config: built.config };
}

/// Read a launched Argus coin back: is it one, and where do its fees go?
export async function inspectArgus(tokenAddress) {
  const { publicClient } = argusClients(null);
  const token = getAddress(tokenAddress);
  const code = await publicClient.getCode({ address: token });
  const clone = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code || '');
  const impl = clone ? getAddress('0x' + clone[1]) : null;

  const erc = [
    { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  ];
  const read = async (fn) => publicClient.readContract({ address: token, abi: erc, functionName: fn }).catch(() => null);

  return {
    token,
    isArgusToken: impl === getAddress(ARGUS_TOKEN_IMPL),
    implementation: impl,
    name: await read('name'),
    symbol: await read('symbol'),
    totalSupply: await read('totalSupply'),
  };
}
