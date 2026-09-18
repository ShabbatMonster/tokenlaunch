import {
  createPublicClient, createWalletClient, http, defineChain, getAddress,
  parseEther, formatEther, encodeAbiParameters, keccak256, toHex, decodeAbiParameters,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// UsePaid coins on Pons.
//
// usepaid.app is not a launchpad of its own. A "paid" coin is an ordinary Pons
// v2 launch - the same factory this repo already uses - with two conventions:
//
//   1. it goes through UsePaid's router, which wraps Pons's launchToken and
//      folds the dev buy into the same transaction
//   2. its description reads exactly "Fees to @handle via UsePaid"
//
// Their docs are explicit that registration needs no approval: a token that
// launches on a supported venue carrying that line "registers on its own".
// Tested rather than trusted - a launch built from scratch here, with our own
// name, symbol, salt and fee recipient, simulates clean against the live router
// and returns a token address. Nothing is signed by UsePaid.
//
// Read off the VLAD launch (0x2aa5bcAB..., tx 0x408acb61...):
//
//   router     0xe33E9E479dF8802cb0866d5d05258bEc4cF62948
//   selector   0xf85f8e41
//   value      Pons launchFee + your dev buy   (0.0005 + 0.2 there)
//
// The one thing this cannot decide for you is where the creator fee goes; see
// PAID_FEE_RECIPIENT_NOTE.
// ---------------------------------------------------------------------------

const CHAIN_ID = 4663;
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const ROBINHOOD = defineChain({
  id: CHAIN_ID, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

export const USEPAID_ROUTER = '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948';
export const PONS_V2_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const LAUNCH_SELECTOR = '0xf85f8e41';
const NATIVE = '0x0000000000000000000000000000000000000000';

export const PAID_FEE_RECIPIENT_NOTE =
  'On chain the creator fee goes wherever creatorFeeRecipient points, and UsePaid assigns its own address '
  + 'per handle when you launch from their site - VLAD’s went to 0xFEE40ADD..., which is theirs rather '
  + 'than the creator’s. That address is issued by them and cannot be derived from the handle, so this '
  + 'defaults the recipient to YOU. Left alone, the description still registers the coin with UsePaid while '
  + 'the fees stay yours; paste the address UsePaid gives you for a handle to actually route them there.';

// Read off the real launch. The first argument is Pons's own LaunchParams; the
// rest belong to the router, and the fifth is zero in every launch seen.
const LAUNCH_ARGS = [
  { name: 'params', type: 'tuple', components: [
    { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
    { name: 'logo', type: 'string' }, { name: 'description', type: 'string' },
    { name: 'socials', type: 'tuple', components: [
      { name: 'twitter', type: 'string' }, { name: 'telegram', type: 'string' },
      { name: 'discord', type: 'string' }, { name: 'website', type: 'string' },
      { name: 'farcaster', type: 'string' },
    ] },
    { name: 'creatorFeeRecipient', type: 'address' }, { name: 'creatorTaxBps', type: 'uint16' },
    { name: 'buybackEnabled', type: 'bool' }, { name: 'expectedEconomics', type: 'bytes32' },
    { name: 'salt', type: 'bytes32' },
  ] },
  { name: 'launchConfigId', type: 'uint256' },
  { name: 'pairToken', type: 'address' },
  { name: 'devBuy', type: 'uint256' },
  { name: 'reserved', type: 'uint256' },
  { name: 'creator', type: 'address' },
  { name: 'snipeTaxExemptions', type: 'address[]' },
];

const FACTORY_ABI = [
  { type: 'function', name: 'launchFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'launchEnabled', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'maxCreatorTaxBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'previewLaunchEconomics', stateMutability: 'view',
    inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bytes32' }] },
];

/// The line UsePaid looks for, in their exact wording. They do fall back to
/// "the first handle in the description", but that is their leniency, not a
/// reason to write it loosely.
export const paidDescription = (handle) => `Fees to @${String(handle).replace(/^@/, '')} via UsePaid`;

export function clientsFor(privateKey) {
  const publicClient = createPublicClient({ chain: ROBINHOOD, transport: http(RPC, { retryCount: 6, retryDelay: 700 }) });
  if (!privateKey) return { publicClient, account: null, walletClient: null };
  const account = privateKeyToAccount(privateKey);
  return { publicClient, account, walletClient: createWalletClient({ account, chain: ROBINHOOD, transport: http(RPC) }) };
}

/// What Pons charges and allows right now. expectedEconomics is a commitment
/// the factory checks, so it is read live - a launch built with a stale one
/// reverts, which is what zeroing it proved.
export async function paidLaunchTerms({ launchConfigId = 0n, pairToken = NATIVE } = {}) {
  const { publicClient } = clientsFor(null);
  const call = (fn, args = []) => publicClient.readContract({
    address: getAddress(PONS_V2_FACTORY), abi: FACTORY_ABI, functionName: fn, args });
  const [launchFee, enabled, maxTaxBps, economics] = await Promise.all([
    call('launchFee'),
    call('launchEnabled').catch(() => true),
    call('maxCreatorTaxBps').catch(() => 10000n),
    call('previewLaunchEconomics', [BigInt(launchConfigId), getAddress(pairToken)]),
  ]);
  return { launchFee, enabled, maxTaxBps, economics };
}

/// Build the router calldata. Separate from sending so it can be diffed against
/// a real launch without spending anything.
export function encodePaidLaunch(opts) {
  const {
    name, symbol, logo = '', handle, description, creator,
    twitter, telegram = '', discord = '', website = '', farcaster = '',
    creatorFeeRecipient, creatorTaxBps = 100, buybackEnabled = false,
    economics, salt, devBuyWei = 0n, launchConfigId = 0n, pairToken = NATIVE,
    snipeTaxExemptions = [],
  } = opts;

  if (!name) throw new Error('a name is required');
  if (!symbol) throw new Error('a symbol is required');
  if (!handle && !description) throw new Error('give an X handle so the fees line can be written');
  if (!economics) throw new Error('expectedEconomics is required - read it with paidLaunchTerms()');

  const params = {
    name,
    symbol,
    logo,
    description: description ?? paidDescription(handle),
    socials: {
      twitter: twitter ?? (handle ? `https://x.com/${String(handle).replace(/^@/, '')}` : ''),
      telegram, discord, website, farcaster,
    },
    creatorFeeRecipient: getAddress(creatorFeeRecipient),
    creatorTaxBps: Number(creatorTaxBps),
    buybackEnabled: !!buybackEnabled,
    expectedEconomics: economics,
    salt: salt ?? keccak256(toHex(`${name}-${symbol}-${Date.now()}-${Math.random()}`)),
  };

  const encoded = encodeAbiParameters(LAUNCH_ARGS, [
    params, BigInt(launchConfigId), getAddress(pairToken), BigInt(devBuyWei), 0n,
    getAddress(creator), snipeTaxExemptions.map((a) => getAddress(a)),
  ]);
  return { data: LAUNCH_SELECTOR + encoded.slice(2), params };
}

/// Launch a UsePaid coin on Pons.
export async function launchPaid(opts) {
  const {
    privateKey, name, symbol, logo = '', handle,
    devBuyEth = '0', creatorTaxBps = 100, feeRecipient, buybackEnabled = false,
    dryRun = false, onStatus,
  } = opts;
  const say = (m) => onStatus && onStatus(m);
  const { publicClient, account, walletClient } = clientsFor(privateKey);
  if (!account) throw new Error('no EVM key - this uses the same key the launcher already holds');

  say('reading Pons terms...');
  const terms = await paidLaunchTerms();
  if (!terms.enabled) throw new Error('Pons has launching switched off right now');
  const tax = Number(creatorTaxBps);
  if (tax > Number(terms.maxTaxBps)) {
    throw new Error(`creator tax ${tax} bps is above Pons's current maximum of ${terms.maxTaxBps}`);
  }

  const devBuyWei = parseEther(String(devBuyEth || '0'));
  const value = terms.launchFee + devBuyWei;
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < value) {
    throw new Error(`need ${formatEther(value)} ETH (launch fee ${formatEther(terms.launchFee)} `
      + `+ dev buy ${formatEther(devBuyWei)}) plus gas, have ${formatEther(balance)}`);
  }

  const built = encodePaidLaunch({
    name, symbol, logo, handle, creator: account.address,
    creatorFeeRecipient: feeRecipient || account.address,
    creatorTaxBps: tax, buybackEnabled,
    economics: terms.economics, devBuyWei,
  });
  say(`"${built.params.description}"`);

  say('simulating...');
  const sim = await publicClient.call({
    to: getAddress(USEPAID_ROUTER), data: built.data, value, account,
  });
  let predicted = null;
  try { [predicted] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }], sim.data); } catch { /* shape may differ */ }

  if (dryRun) {
    say(`simulation passed - would launch ${predicted ?? '(address in the receipt)'}`);
    return { dryRun: true, token: predicted, data: built.data, value, params: built.params };
  }

  say('sending launch...');
  const hash = await walletClient.sendTransaction({
    to: getAddress(USEPAID_ROUTER), data: built.data, value,
  });
  say('waiting for confirmation...');
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('launch reverted: ' + hash);

  return { token: predicted, hash, params: built.params, value };
}
