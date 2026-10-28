// Abyss / Black Market launches on Robinhood Chain (4663).
//
// Driven by the project's own SDK (@black-market/sdk) rather than hand-rolled
// calldata: it owns the curve geometry, and the market config is a 992-byte
// blob of tick ranges that is not worth reimplementing. Verified 2026-10-27 by
// planning a launch and eth_call-ing the built transaction, whose calldata
// matches a real Abyss launch.
//
// A launch is one `launchAtomic(plan)` call on LaunchOrchestratorV1. Building
// the plan goes:
//
//   1. pick a profile (abyss-0..3) for the venue/hook implementation
//   2. deriveLaunchPoolRecipe  — supply + opening valuation -> opening price
//   3. deriveLaunchPositionRanges — the one-sided liquidity ladder
//   4. encodeAbyssLifecycleMarketConfig — that ladder as the market's config
//   5. predictToken, then the fee rows, then planLaunch to validate
//
// Three rules account for nearly every rejection, so each is enforced here with
// a readable message instead of a bare revert:
//
//   * fee rows must be unique and ASCENDING by address, each summing to 10000
//     bps. Two are needed - the quote and the token itself - and the token's
//     address comes from predictToken, which does not depend on the rows.
//   * rewardMode must agree with the rows: any row with rewardsBps != 0 iff
//     rewardMode != None. A burn share is only legal on the token's own row.
//   * no interior tick gaps, and ticks must align to the fee tier's spacing.
//     The staircase preset leaves gaps unless positionGaps is 'adjacent'.
import { getAddress } from 'viem';
import {
  getAddresses, ABYSS_FEE_TIERS, AbyssPoolProfile, LifecycleTokenKind, LifecycleRewardMode,
  getKnownLifecycleProfile, deriveLaunchPoolRecipe, deriveLaunchPositionRanges,
  encodeAbyssLifecycleMarketConfig, estimateLaunchInitialBuy, deriveLaunchBuySqrtPriceLimitX96,
  planLaunch, launchLifecycleAbi, LAUNCH_DEADLINE_SECONDS,
  LifecycleFundingKind,
} from '@black-market/sdk';

export const ABYSS_CHAIN_ID = 4663;
export const ABYSS_ORACLE_CONFIG_ID = '0xc0e9bed88d70a13fd3ab31451fefdd073b7266e838aee0ad1c236c8c9eff855d';
export const ABYSS_FEE_TIER_LIST = ABYSS_FEE_TIERS;
export const ABYSS_PRESETS = ['staircase', 'early-scarcity', 'smooth-ramp'];

/// The four canonical Abyss profiles. The market config's own `profile` byte
/// has to match the profile that was picked, or create_config rejects it
/// (0xc52a9bd3), so the mapping lives here rather than being assumed.
/// `oracle` also decides the config's oracleConfigId: the two non-oracle
/// profiles reject a non-zero one with InvalidConfiguration (0xc52a9bd3).
export const ABYSS_PROFILES = [
  { key: 'abyss-1', poolProfile: AbyssPoolProfile.StandardOracle, oracle: true, label: 'standard + oracle', note: 'what the live Abyss coins use' },
  { key: 'abyss-0', poolProfile: AbyssPoolProfile.Standard, oracle: false, label: 'standard', note: 'no oracle' },
  { key: 'abyss-3', poolProfile: AbyssPoolProfile.QuoteOracle, oracle: true, label: 'quote fees + oracle', note: 'fees collected in the quote token' },
  { key: 'abyss-2', poolProfile: AbyssPoolProfile.Quote, oracle: false, label: 'quote fees', note: 'quote-token fees, no oracle' },
];

export const abyssAddresses = () => getAddresses(ABYSS_CHAIN_ID);

/// The two quotes the SDK's own examples use. Any other ERC-20 works too -
/// verified against the ABYSS token on all four pool profiles - so the pad
/// offers a custom one as well, resolved by resolveAbyssQuote.
export function abyssQuotes() {
  const a = abyssAddresses();
  return [
    { symbol: 'ETH', address: a.weth ?? a.wrappedNative, decimals: 18 },
    // USDG is 6 decimals, not 18 - pricing it as 18 is wrong by 1e12
    { symbol: 'USDG', address: a.usdg ?? '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
  ];
}

const ERC20_META = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

/// Read a pasted pair token off chain. Its decimals decide what the starting
/// market cap means, so they are never assumed to be 18.
export async function resolveAbyssQuote(client, address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('paste a pair token address (0x…)');
  const addr = getAddress(address);
  const code = await client.getBytecode({ address: addr }).catch(() => null);
  if (!code || code === '0x') throw new Error(`${addr.slice(0, 10)}… is not a contract on Robinhood chain`);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: addr, abi: ERC20_META, functionName: 'symbol' }).catch(() => null),
    client.readContract({ address: addr, abi: ERC20_META, functionName: 'decimals' }).catch(() => null),
  ]);
  if (decimals === null) throw new Error(`${addr.slice(0, 10)}… does not look like an ERC-20 (no decimals)`);
  return { symbol: symbol || addr.slice(0, 8) + '…', address: addr, decimals: Number(decimals), custom: true };
}

const ZERO = '0x0000000000000000000000000000000000000000';
const rand32 = () => {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);   // present in browsers and in Node 18+
  return BigInt('0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join(''));
};

export function abyssTier(feePips) {
  const t = ABYSS_FEE_TIERS.find((x) => x.feePips === Number(feePips));
  if (!t) throw new Error(`${feePips} is not an Abyss fee tier (${ABYSS_FEE_TIERS.map((x) => x.label).join(', ')})`);
  return t;
}

/// Split 10000 bps between the owner, holder rewards and (token row only) burn.
function feeRow(asset, { ownerBps, rewardsBps = 0, burnBps = 0 }) {
  const total = ownerBps + rewardsBps + burnBps;
  if (total !== 10000) throw new Error(`fee shares for ${asset.slice(0, 8)}… add up to ${(total / 100).toFixed(2)}%, and each asset's shares have to make 100%`);
  return { asset, ownerBps, rewardsBps, burnBps };
}

/// The curve geometry for one market: opening price and the liquidity ladder.
/// `openingValuationQuote` is the whole-supply valuation in WHOLE quote tokens,
/// which is what "launches at a 10 ETH market cap" means.
export function abyssGeometry({ supply, openingValuationQuote, quoteDecimals = 18, feePips, positions = 6, preset = 'staircase' }) {
  const tier = abyssTier(feePips);
  if (!ABYSS_PRESETS.includes(preset)) throw new Error(`${preset} is not an Abyss liquidity preset (${ABYSS_PRESETS.join(', ')})`);
  if (!(positions >= 1 && positions <= 16)) throw new Error('an Abyss market takes between 1 and 16 liquidity positions');
  // Pricing the quote at 1e18 makes the SDK's "market cap in USD" read in whole
  // quote tokens, so a launch can be priced without any USD oracle.
  const recipe = deriveLaunchPoolRecipe({
    pairedTokenDecimals: quoteDecimals, pairedTokenUsdPriceX18: 10n ** 18n,
    targetMarketCapUsdX18: openingValuationQuote, launchedTokenIsQuote: false,
    fee: tier.feePips, supply, tokenBudget: supply, tickSpacing: tier.tickSpacing,
  });
  const ranges = deriveLaunchPositionRanges({
    launchSqrtPriceX96: recipe.launchSqrtPriceX96, launchedTokenIsQuote: false,
    tokenBudget: supply, tickSpacing: tier.tickSpacing, venue: 'abyss',
    distributionPreset: preset, positionCount: positions,
    // the presets leave intentional gaps, which the orchestrator rejects
    positionGaps: 'adjacent',
  });
  return { tier, recipe, ranges };
}

/// Everything except the token's own fee row, which needs the predicted address.
export function abyssPlanDraft(o) {
  const a = abyssAddresses();
  const known = getKnownLifecycleProfile({ chainId: ABYSS_CHAIN_ID, orchestrator: a.launchOrchestrator, key: o.profileKey || 'abyss-1' });
  if (!known) throw new Error(`Abyss profile ${o.profileKey} is not part of this deployment`);
  const prof = known.profile;
  const { tier, recipe, ranges } = abyssGeometry(o);

  const rewardMode = o.rewardMode ?? LifecycleRewardMode.None;
  const rewardsBps = Math.round(o.rewardsBps || 0);
  const burnBps = Math.round(o.burnBps || 0);
  // the orchestrator cross-checks these against each other, so say so here
  if (rewardsBps > 0 && rewardMode === LifecycleRewardMode.None) {
    throw new Error('giving holders a share of the fees needs the reward mode set to staking or dividends');
  }
  if (rewardsBps === 0 && rewardMode !== LifecycleRewardMode.None) {
    throw new Error('staking and dividends need a share of the fees pointed at holders, otherwise there is nothing to pay out');
  }
  if (o.tokenKind === LifecycleTokenKind.ERC404 && !(o.nftUnit > 0n)) {
    throw new Error('an ERC-404 launch needs a unit size (how many tokens make one NFT)');
  }

  const chosen = ABYSS_PROFILES.find((p) => p.key === (o.profileKey || 'abyss-1'));
  const config = encodeAbyssLifecycleMarketConfig({
    profile: o.poolProfile ?? chosen?.poolProfile ?? AbyssPoolProfile.StandardOracle,
    fee: tier.feePips,
    oracleConfigId: (chosen?.oracle ?? true) ? ABYSS_ORACLE_CONFIG_ID : ('0x' + '00'.repeat(32)),
    openingSqrtPriceX96: recipe.launchSqrtPriceX96,
    positions: ranges.positions.map((p) => ({
      tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity, tokenAmountMaximum: p.maxTokenAmount,
    })),
  });

  // a dev buy spends the quote, so it has to be escrowed first: native ETH is
  // wrapped by the escrow, anything else is pulled as an ERC-20
  const devBuy = BigInt(o.devBuyRaw || 0n);
  // One slippage figure drives BOTH the minimum out and the sqrt-price guard.
  // They were allowed to disagree once - a 20% floor with a 0.5% price limit -
  // and every dev buy reverted SlippageExceeded.
  const slippageBps = Math.min(9000, Math.max(1, Math.round(o.slippageBps ?? 2000)));
  const isNative = o.quote.address.toLowerCase() === String(abyssAddresses().weth || '').toLowerCase();
  const funding = devBuy > 0n
    ? [{
      asset: o.quote.address, amount: devBuy,
      kind: isNative ? LifecycleFundingKind.NativeWrap : LifecycleFundingKind.ERC20,
      // both kinds want the input asset to be the asset being escrowed; only a
      // Swap names a different one
      inputAsset: o.quote.address, inputAmount: devBuy, target: ZERO, data: '0x',
    }]
    : [];
  const buys = devBuy > 0n
    ? [{
      marketIndex: 0, quoteAmountIn: devBuy,
      minTokenOut: (() => {
        // openingActiveLiquidity reads 0 for a one-sided ladder whose first band
        // ends at the launch tick, so price the buy off that band's own liquidity
        const liquidity = ranges.openingActiveLiquidity > 0n ? ranges.openingActiveLiquidity : ranges.positions[0].liquidity;
        const est = estimateLaunchInitialBuy({
          launchSqrtPriceX96: recipe.launchSqrtPriceX96, liquidity,
          pairedTokenAmountIn: devBuy, launchedTokenIsQuote: false, fee: tier.feePips,
        });
        // The estimate is priced off one band, so it reads high against the
        // real ladder - a tight minimum reverts SlippageExceeded (0x8199f5f3).
        // The sqrt-price limit below is the real guard; this is a floor.
        return (est.launchedTokenAmountOut * BigInt(10000 - slippageBps)) / 10000n;
      })(),
      recipient: o.creator,
      sqrtPriceLimitX96: deriveLaunchBuySqrtPriceLimitX96({
        launchSqrtPriceX96: recipe.launchSqrtPriceX96, launchedTokenIsQuote: false, slippageBps,
      }),
    }]
    : [];

  const plan = {
    chainId: BigInt(ABYSS_CHAIN_ID), orchestrator: a.launchOrchestrator, creator: o.creator, nonce: rand32(),
    token: {
      kind: o.tokenKind ?? LifecycleTokenKind.ERC20, rewardMode,
      name: o.name, symbol: o.symbol, supply: o.supply,
      nftUnit: BigInt(o.nftUnit || 0n), metadataURI: o.metadataURI || '',
      salt: '0x' + '00'.repeat(32),
      inventoryRecipient: o.inventoryRecipient || o.creator, burnOnCancel: true,
    },
    funding,
    // the token's row is filled in by abyssPlan() once the address is known
    feeAssets: [feeRow(o.quote.address, { ownerBps: 10000 - rewardsBps, rewardsBps })],
    markets: [{
      adapterId: prof.registration.adapterId, profileId: prof.id, quoteAsset: o.quote.address,
      tokenBudget: o.supply, configVersion: prof.topology.configVersion, config,
    }],
    buys,
    deadline: BigInt(Math.floor(Date.now() / 1000) + LAUNCH_DEADLINE_SECONDS),
    executorFeeBps: 0,
  };
  return { plan, tier, recipe, ranges, tokenBurnBps: burnBps, tokenRewardsBps: rewardsBps };
}

/// The finished plan: predicts the token, adds its fee row in ascending order,
/// and has the orchestrator validate the whole thing.
export async function abyssPlan(client, o) {
  const a = abyssAddresses();
  // The ladder is built for the launched token being the pool's token1, which
  // holds only while its address sorts ABOVE the quote's. The address comes
  // from the nonce, so re-roll until it does rather than shipping geometry the
  // orchestrator will reject with TOPOLOGY_OPENING_GAP.
  let draft, token;
  for (let i = 0; i < 40; i++) {
    draft = abyssPlanDraft(o);
    token = await client.readContract({ address: a.launchOrchestrator, abi: launchLifecycleAbi, functionName: 'predictToken', args: [draft.plan] });
    if (BigInt(token) > BigInt(o.quote.address)) break;
    token = null;
  }
  if (!token) throw new Error('could not find a token address that sorts above the pair token; try again');
  const { plan } = draft;
  const tokenRow = feeRow(token, {
    ownerBps: 10000 - draft.tokenRewardsBps - draft.tokenBurnBps,
    rewardsBps: draft.tokenRewardsBps, burnBps: draft.tokenBurnBps,
  });
  // unique ASCENDING addresses, or the validator refuses the policy
  plan.feeAssets = [...plan.feeAssets, tokenRow].sort((x, y) => (BigInt(x.asset) < BigInt(y.asset) ? -1 : 1));
  const planned = await planLaunch({ client, account: o.creator, plan, mode: 'atomic' });
  return { ...draft, token, planned, tx: planned.transactions[0] };
}

/// What the launch will look like, for the UI to state before anything is sent.
export function abyssSummary({ tier, recipe, ranges, plan }, quoteSymbol) {
  const whole = (v, d = 18) => Number(v) / 10 ** d;
  return {
    feeLabel: tier.label,
    openingPriceQuotePerToken: whole(plan.markets[0].tokenBudget) > 0
      ? whole(ranges.tokenAmountMaximum) && undefined : undefined,
    positions: ranges.positions.map((p) => ({
      tickLower: p.tickLower, tickUpper: p.tickUpper, inventoryBps: p.inventoryBps,
      tokens: whole(p.maxTokenAmount),
    })),
    launchTick: recipe.launchTick,
    totalLadderTokens: whole(ranges.tokenAmountMaximum),
    unspentTokens: whole(ranges.unspentTokenAmount),
    quoteSymbol,
  };
}

export { LifecycleTokenKind, LifecycleRewardMode, AbyssPoolProfile };
