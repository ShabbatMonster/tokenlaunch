// Volta (volta.family): a Flaunch fork on Elysium. Coins open in a Uniswap v4
// pool whose hook is Volta's PositionManager, paired with HYPE, KNTQ or VOLTA.
// Read off the live frontend's bundle (ABIs, limits, formulas) and the chain,
// 2026-11-08; every launch shape here was simulated against the live contracts.
//
//   HYPE pair:  PositionManager.flaunch(params)             value = fee + dev buy
//   KNTQ/VOLTA: HypeLaunchRouter.flaunch(params, route, min) value = fee + dev buy,
//               the router swaps the HYPE into the pair token first
//
// The dev buy ("premine") is given in tokens; the frontend works it out from
// the HYPE spent as supply * amount * 0.985 / (marketCap + amount), and so does
// this. The fee splits three ways - creator, buyback, holders - in bps.
import { parseAbi, getAddress } from 'viem';
import { NATIVE, KNTQ, ELYSIUM_EXPLORER, isAddress, parseAmount } from './elysium.js';

export const VOLTA_POSITION_MANAGER = getAddress('0x3ab88ddc3cf2a012af88b60828edb4553697e5dc');
export const VOLTA_LAUNCH_ROUTER = getAddress('0x38d47e39beddde96e7db725569d9c5395bd279a0');
export const VOLTA_QUOTER = getAddress('0x379f556c5a748bd7cc9baf0f7a344094ac1814f5');
export const VOLTA_TOKEN = getAddress('0x0f79931689af199e7cf868ed1107bba2c83c68f7');
export const voltaCoinUrl = (t) => `https://www.volta.family/token/${t}`;
export const voltaTxUrl = (h) => `${ELYSIUM_EXPLORER}/tx/${h}`;

/// The frontend's own limits (its `u` constants); the contract enforces the
/// fee and anti-snipe bounds (SwapFeeInvalid / AntiSnipeInvalid).
export const VOLTA_LIMITS = {
  minSwapFee: 100, maxSwapFee: 500, protocolShare: 3000, maxAntiSnipeFee: 3000, maxAntiSnipeSeconds: 900,
  maxScheduleSeconds: 2_592_000, totalSupply: 1_000_000_000n * 10n ** 18n, minDevBuy: 10n ** 15n,
};

/// What a coin can pair against, and how HYPE gets there.
export const VOLTA_PAIRS = [
  { key: 'HYPE', symbol: 'HYPE', token: NATIVE, route: null },
  { key: 'KNTQ', symbol: 'KNTQ', token: KNTQ, route: { currency0: NATIVE, currency1: KNTQ, fee: 10000, tickSpacing: 200, hooks: NATIVE } },
  { key: 'VOLTA', symbol: 'VOLTA', token: VOLTA_TOKEN, route: { currency0: NATIVE, currency1: VOLTA_TOKEN, fee: 0, tickSpacing: 60, hooks: VOLTA_POSITION_MANAGER } },
];

const PARAMS = '(string name, string symbol, string tokenUri, uint256 premineAmount, address creator, uint24 swapFee, (uint24 creator, uint24 buyback, uint24 holders) creatorSplit, (uint24 startFee, uint32 duration) antiSnipe, uint256 flaunchAt, bytes initialPriceParams, address pairedToken)';
export const VOLTA_ABI = parseAbi([
  `function flaunch(${PARAMS} _params) payable returns (address memecoin_)`,
  'function getFlaunchingFee(bytes _initialPriceParams) view returns (uint256)',
  'function initialPrice() view returns (address)',
  `event PoolCreated(bytes32 indexed _poolId, address _memecoin, address _memecoinTreasury, uint256 _tokenId, bool _currencyFlipped, uint256 _flaunchFee, ${PARAMS} _params)`,
  'error SwapFeeInvalid()', 'error AntiSnipeInvalid()',
]);
export const VOLTA_ROUTER_ABI = parseAbi([
  `function flaunch(${PARAMS} _params, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) _route, uint256 _minQuoteOut) payable returns (address memecoin_)`,
  'error InsufficientQuoteOut(uint256 _bought, uint256 _minQuoteOut)', 'error InsufficientValue(uint256 _value, uint256 _launchFee)',
  'error InvalidRoute()', 'error NoDevBuy()', 'error PremineCostExceedsMaximum(uint256 _cost, uint256 _maximum)',
  'error PairedTokenNotApproved(address _pairedToken)', 'error MarketCapNotSet(address _pairedToken)',
]);
const QUOTER_ABI = parseAbi(['function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)']);
const PRICE_ABI = parseAbi(['function marketCap(address) view returns (uint256)']);

/// Tokens a dev buy of `quoteAmount` of the pair token gets, as Volta's site has it.
export const voltaPremine = (quoteAmount, marketCap) =>
  (VOLTA_LIMITS.totalSupply * BigInt(quoteAmount) * 985n) / ((BigInt(marketCap) + BigInt(quoteAmount)) * 1000n);

/// The form, checked against Volta's limits, as Volta's flaunch params minus the
/// dev buy (which needs the chain).
export function voltaCheck(o) {
  const L = VOLTA_LIMITS;
  if (!o.name || !o.symbol) throw new Error('the coin needs a name and a ticker');
  const pair = VOLTA_PAIRS.find((p) => p.key === (o.pair || 'HYPE'));
  if (!pair) throw new Error('pair with HYPE, KNTQ or VOLTA');
  const swapFee = Math.round(Number(o.swapFeePct ?? 2) * 100);
  if (!(swapFee >= L.minSwapFee && swapFee <= L.maxSwapFee)) throw new Error(`Volta's swap fee is ${L.minSwapFee / 100}%–${L.maxSwapFee / 100}%`);
  const split = { creator: Math.round(Number(o.split?.creator ?? 50) * 100), buyback: Math.round(Number(o.split?.buyback ?? 25) * 100), holders: Math.round(Number(o.split?.holders ?? 25) * 100) };
  if (split.creator + split.buyback + split.holders !== 10000) throw new Error('the creator / buyback / holders split has to add up to 100%');
  let antiSnipe = { startFee: 0, duration: 0 };
  if (o.antiSnipe) {
    const startFee = Math.round(Number(o.antiSnipe.startPct) * 100);
    const duration = Math.round(Number(o.antiSnipe.minutes) * 60);
    if (!(startFee >= swapFee + 25 && startFee <= L.maxAntiSnipeFee)) {
      throw new Error(`the anti-snipe fee has to start between ${(swapFee + 25) / 100}% (just above the swap fee) and ${L.maxAntiSnipeFee / 100}%`);
    }
    if (!(duration >= 60 && duration <= L.maxAntiSnipeSeconds)) throw new Error(`anti-snipe lasts 1–${L.maxAntiSnipeSeconds / 60} minutes`);
    antiSnipe = { startFee, duration };
  }
  let flaunchAt = 0n;
  if (o.flaunchAt) {
    const t = Math.floor(new Date(o.flaunchAt).getTime() / 1000);
    const now = Math.floor(Date.now() / 1000);
    if (!(t > now)) throw new Error('the scheduled time has to be in the future');
    if (t - now > L.maxScheduleSeconds) throw new Error('Volta schedules at most 30 days ahead');
    flaunchAt = BigInt(t);
  }
  if (o.creator && !isAddress(o.creator)) throw new Error('the creator wallet is not an address');
  const devBuy = parseAmount(o.devBuyHype || '0', 18);
  if (pair.route && devBuy < L.minDevBuy) throw new Error(`a ${pair.symbol}-paired coin needs a dev buy of at least ${Number(L.minDevBuy) / 1e18} HYPE (the router swaps it into ${pair.symbol})`);
  if (devBuy > 0n && devBuy < L.minDevBuy) throw new Error(`a dev buy is at least ${Number(L.minDevBuy) / 1e18} HYPE`);
  return { pair, swapFee, split, antiSnipe, flaunchAt, devBuy };
}

/// The launch, ready to simulate and send: { address, abi, functionName, args, value }.
export async function voltaPlan(pub, o) {
  const c = voltaCheck(o);
  const fee = await pub.readContract({ address: VOLTA_POSITION_MANAGER, abi: VOLTA_ABI, functionName: 'getFlaunchingFee', args: ['0x'] });
  const priceAt = await pub.readContract({ address: VOLTA_POSITION_MANAGER, abi: VOLTA_ABI, functionName: 'initialPrice' });
  const marketCap = await pub.readContract({ address: priceAt, abi: PRICE_ABI, functionName: 'marketCap', args: [c.pair.token] });
  // the HYPE pair spends HYPE directly; the others spend what the HYPE buys
  let quoteAmount = c.devBuy, minQuoteOut = 0n;
  if (c.pair.route) {
    const { result } = await pub.simulateContract({
      address: VOLTA_QUOTER, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
      args: [{ poolKey: c.pair.route, zeroForOne: true, exactAmount: c.devBuy, hookData: '0x' }],
    });
    minQuoteOut = (result[0] * 9900n) / 10000n;   // the site's 1%
    quoteAmount = minQuoteOut;
  }
  const premineAmount = quoteAmount > 0n ? voltaPremine(quoteAmount, marketCap) : 0n;
  const params = {
    name: o.name, symbol: o.symbol, tokenUri: o.tokenUri, premineAmount,
    creator: o.creator || o.account, swapFee: c.swapFee, creatorSplit: c.split, antiSnipe: c.antiSnipe,
    flaunchAt: c.flaunchAt, initialPriceParams: '0x', pairedToken: c.pair.token,
  };
  const request = c.pair.route
    ? { address: VOLTA_LAUNCH_ROUTER, abi: VOLTA_ROUTER_ABI, functionName: 'flaunch', args: [params, c.pair.route, minQuoteOut], value: fee + c.devBuy }
    : { address: VOLTA_POSITION_MANAGER, abi: VOLTA_ABI, functionName: 'flaunch', args: [params], value: fee + c.devBuy };
  return { request, fee, marketCap, premineAmount, quoteAmount, ...c };
}
