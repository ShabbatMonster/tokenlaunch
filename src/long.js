import { createPublicClient, createWalletClient, http, defineChain, parseEther, parseUnits, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DopplerSDK, ADDRESSES } from '@whetstone-research/doppler-sdk/evm';

// ---------------------------------------------------------------------------
// long.xyz - a Doppler v4 launchpad on Robinhood Chain that pairs new tokens
// against tokenized stocks instead of ETH.
//
// Launching goes through the Doppler Airlock, which is permissionless as long
// as every module you name is whitelisted on it. Verified on-chain:
//
//   Airlock            0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862
//   tokenFactory       DopplerERC20V1Factory      whitelisted
//   poolInitializer    DopplerHookInitializer     whitelisted
//   governanceFactory  NoOpGovernanceFactory      whitelisted
//   liquidityMigrator  UniswapV2MigratorSplit     whitelisted
//
// NOTE: long.xyz's own "Rehype" hook modules (the ones that recycle fees into
// buying the paired stock) are currently NOT whitelisted on that Airlock -
// both the address in their app bundle and the one in the Doppler SDK come
// back NotWhitelisted. So a launch here uses the standard Doppler hook path
// rather than their Rehype variant. Everything else - the Airlock, the stock
// numeraires, the multicurve shape - is theirs.
//
// The heavy lifting (module data encoding, and mining a CREATE2 salt so the v4
// hook address carries the right permission flags) is done by the official
// Doppler SDK rather than hand-rolled, and every launch is simulated before it
// is sent.
// ---------------------------------------------------------------------------

const CHAIN_ID = 4663;
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN = defineChain({
  id: CHAIN_ID, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});


// long.xyz's own multicurve shape: most of the supply sits in a deep tail with
// progressively smaller, tighter bands above it.
const LONG_CURVES = [
  { tickLower: 32160, tickUpper: 39088, numPositions: 3, shares: parseEther('0.05') },
  { tickLower: 21176, tickUpper: 32160, numPositions: 5, shares: parseEther('0.1') },
  { tickLower: 12008, tickUpper: 21176, numPositions: 5, shares: parseEther('0.2') },
  { tickLower: 5080, tickUpper: 12008, numPositions: 5, shares: parseEther('0.3') },
  { tickLower: -887264, tickUpper: 5080, numPositions: 1, shares: parseEther('0.35') },
];

// their defaults: 1B supply, 900M sold through the curve
const DEFAULT_SUPPLY = parseEther('1000000000');
const DEFAULT_TO_SELL = parseEther('900000000');

/// Launch a token on long.xyz's Airlock, paired against `numeraire`.
/// Returns { token, hash }.
export async function launchLong(opts) {
  const {
    privateKey, name, symbol, tokenURI,
    numeraire, supplyTokens, tokensToSell, onStatus,
  } = opts;
  const say = (m) => onStatus && onStatus(m);

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });

  const quote = getAddress(numeraire);
  const initialSupply = supplyTokens ? parseEther(String(supplyTokens)) : DEFAULT_SUPPLY;
  const numTokensToSell = tokensToSell ? parseEther(String(tokensToSell)) : DEFAULT_TO_SELL;
  if (numTokensToSell > initialSupply) throw new Error('tokens to sell cannot exceed the supply');

  say('loading Doppler SDK...');
  const sdk = new DopplerSDK({ publicClient, walletClient, chainId: CHAIN_ID });
  const addrs = ADDRESSES[CHAIN_ID];

  say('building launch params (mining the v4 hook salt)...');
  const params = sdk.buildMulticurveAuction()
    .tokenConfig({ name, symbol, tokenURI: tokenURI || '' })
    .saleConfig({ initialSupply, numTokensToSell, numeraire: quote })
    .poolConfig({ fee: 0, tickSpacing: 8, curves: LONG_CURVES })
    .withDopplerHookInitializer(addrs.dopplerHookInitializer)
    // noOp migration is rejected by the SDK without beneficiaries - it would
    // leave the pool unable to graduate - so graduate into a Uniswap v2 pair
    .withMigration({ type: 'uniswapV2' })
    .withGovernance({ type: 'noOp' })
    .withUserAddress(account.address)
    .withIntegrator(account.address)
    .build();

  // simulate before spending anything, and use the predicted token address
  say('simulating launch...');
  const sim = await sdk.factory.simulateCreateMulticurve(params);
  const predicted = sim?.tokenAddress ?? null;

  say('sending launch tx...');
  const res = await sdk.factory.createMulticurve(params);
  const hash = typeof res === 'string' ? res : (res?.hash ?? res?.transactionHash ?? null);

  if (hash) {
    say('waiting for confirmation...');
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error('launch tx reverted: ' + hash);
  }

  return { token: res?.tokenAddress ?? predicted, hash };
}
