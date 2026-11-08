// Ascend (ascendlaunch.xyz): Elysium's launchpad that opens each coin straight
// into a Uniswap v4 pool - no bonding curve - paired with HYPE, KNTQ or USDC.
//
// Mapped 2026-11-08 from Ascend's own app bundle (served unwalled from
// docs.ascendlaunch.xyz; the app domain sits behind Cloudflare) and checked
// against all ~680 launches on its factories. Two ways in, as on its site:
//
//   Vanilla   EscrowFactory.launchChecked(coin, terms, ruleSet, startTick)
//             the creator share of the fee goes to one wallet.
//   Holder Rewards / Buyback / Custom mix
//             SeatFactory.launchChecked(coin, seat, salt, builder, ruleSet, startTick)
//             a "seat" contract takes the creator share and pays it out:
//             holderBpsQuote / holderBpsToken to holders (in the quote and in
//             the coin), buybackBps to buying the coin back (burned or kept),
//             the rest to up to 10 payees.
//
//   coin = (name, symbol, quote, devBuyQuote, minDevOut, salt, creator 0x0, fee pips, builderFee 0)
//
// The trade fee is 1%-10%. Each quote has its own opening tick (quoteConfig);
// the whole 1B supply sits in one range from there, so a dev buy - the launch's
// own first trade, which pays no fee - is exact v4 arithmetic, mirrored here
// rounding for rounding from Ascend's app.
import { parseAbi, getAddress, encodeAbiParameters, encodeFunctionData, keccak256, stringToHex, concat } from 'viem';
import { KNTQ, NATIVE, sqrtPriceAtTick, parseAmount, isAddress, ELYSIUM_EXPLORER } from './elysium.js';

export const ASCEND_LAUNCHPAD = getAddress('0xe0def4221b9840a610d4e7d55812a79a6431a8ec');        // the v4 hook; quoteConfig
export const ASCEND_ESCROW_FACTORY = getAddress('0x63f6a8a8d0257c0363251a50cde8a8b1046e4d19');   // Vanilla launches
export const ASCEND_SEAT_FACTORY = getAddress('0xbdb8d64452191041c4daa3ad0f64be4380fea0b1');     // seat launches
export const ASCEND_CTO_REGISTRY = getAddress('0x8c26412796e7a759916d8ee0c2d91f2976e96da8');
export const WHYPE = getAddress('0xba876237b0f021a6c6d852d6c26e107997cc5e81');
export const ASCEND_USDC = getAddress('0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65');
export const ascendCoinUrl = (t) => `${ELYSIUM_EXPLORER}/token/${t}`;
export const ascendTxUrl = (h) => `${ELYSIUM_EXPLORER}/tx/${h}`;

/// The quotes Ascend's app lists. Each is re-checked live (quoteConfig) before a
/// launch, and any other token the launchpad allows can be given by address.
/// HYPE is WHYPE: native HYPE is wrapped one-for-one first.
export const ASCEND_QUOTES = [
  { key: 'HYPE', symbol: 'HYPE', token: WHYPE, decimals: 18, wrap: true },
  { key: 'KNTQ', symbol: 'KNTQ', token: KNTQ, decimals: 18 },
  { key: 'USDC', symbol: 'USDC', token: ASCEND_USDC, decimals: 6 },
];

export const ASCEND_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const ASCEND_FEE = { minPips: 10_000, maxPips: 100_000 };   // 1% - 10%
const RANGE_TICKS = 200_000;   // the one range: [startTick, startTick + 200000]
const START_GAP = 200;         // the pool opens one tick spacing outside it
const ZERO = NATIVE;
const METADATA_TAG = stringToHex('ascend.metadata.v1', { size: 32 });
const DISCLOSURE_TAG = stringToHex('ascend.disclosure.v1', { size: 32 });

const COIN = '(string name, string symbol, address quote, uint256 devBuyQuote, uint256 minDevOut, bytes32 salt, address creator, uint24 fee, uint24 builderFee)';
const TERMS = '(address recipient, address dev, address builder, bool cto)';
const SEAT = '(uint16 holderBpsQuote, uint16 holderBpsToken, uint16 buybackBps, bool burnBought, address devBuyTo, address[] payees, uint16[] bps)';
export const ASCEND_ESCROW_ABI = parseAbi([
  `function launchChecked(${COIN} p, ${TERMS} r, address expectedRuleSet, int24 expectedStartTick) returns (address token, bytes32 poolId, address escrow)`,
  `function predict(address payer, ${COIN} p, ${TERMS} r) view returns (address escrow, address token)`,
  'function ruleSet() view returns (address)', 'function LAUNCH_TERMS_VERSION() view returns (uint256)',
  'error BadBuilder()', 'error BadLaunch()', 'error LaunchTermsChanged()', 'error NoRuleSet()', 'error RuleSetNotReady(uint256)', 'error Unauthorized()',
]);
export const ASCEND_SEAT_ABI = parseAbi([
  `function launchChecked(${COIN} p, ${SEAT} c, bytes32 seatSalt, address builder, address expectedRuleSet, int24 expectedStartTick) returns (address token, bytes32 poolId, address seat, address escrow)`,
  `function predict(address deployer, ${SEAT} c, bytes32 salt) view returns (address)`,
  'error BadExclusions()', 'error BadLaunch()', 'error LaunchTermsChanged()', 'error Unauthorized()',
]);
const QUOTE_ABI = parseAbi(['function quoteConfig(address) view returns ((bool allowed, int24 startTick, uint128 maxClip))']);
export const ASCEND_ERC20_ABI = parseAbi([
  'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  'function deposit() payable',
]);
export const ASCEND_ERRORS = { '0x873e2c9a': 'the dev buy would get less than its minimum out' };

// --- the coin types ------------------------------------------------------------
/// What the creator share of each trade fee does, as Ascend's launch form has it.
export const ASCEND_COIN_TYPES = [
  { key: 'vanilla', label: 'Vanilla', note: 'your creator share to your wallet' },
  { key: 'holders', label: 'Holder Rewards', note: 'holders share the fees' },
  { key: 'buyback', label: 'Buyback', note: 'fees buy the coin back' },
  { key: 'custom', label: 'Custom mix', note: 'holders / buyback / creator, your way' },
];

const pct = (v, what) => {
  const s = String(v ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) throw new Error(`${what} has to be a percentage with at most two decimals`);
  const bps = Math.round(Number(s) * 100);
  if (bps > 10000) throw new Error(`${what} is at most 100%`);
  return bps;
};

/// The seat a non-Vanilla coin launches with, or null for Vanilla.
///   o.type        vanilla | holders | buyback | custom
///   o.holdersQuotePct / o.holdersTokenPct   (holders)  of the creator share
///   o.holdersPct / o.buybackPct / o.creatorPct, o.burn  (custom; add to 100)
///   o.payees      [{ wallet, bps }] summing to 10000 - who gets the rest
///   o.devBuyTo    where the dev buy's coins go (blank = the first payee)
export function ascendSeat(o) {
  const type = o.type || 'vanilla';
  if (type === 'vanilla') return null;
  let holderBpsQuote, holderBpsToken, buybackBps, burnBought;
  if (type === 'holders') {
    holderBpsQuote = pct(o.holdersQuotePct ?? 50, 'the holders’ share of quote fees');
    holderBpsToken = pct(o.holdersTokenPct ?? o.holdersQuotePct ?? 50, 'the holders’ share of coin fees');
    buybackBps = 0; burnBought = false;
  } else if (type === 'buyback') {
    holderBpsQuote = holderBpsToken = 0; buybackBps = 10000; burnBought = o.burn ?? true;
  } else if (type === 'custom') {
    const h = pct(o.holdersPct ?? 40, 'the holders’ share'), b = pct(o.buybackPct ?? 40, 'the buyback share'), c = pct(o.creatorPct ?? 20, 'the creator share');
    if (h + b + c !== 10000) throw new Error(`holders, buyback and creator add up to ${(h + b + c) / 100}%; they must make 100%`);
    if (b === 0) throw new Error(h === 0 ? 'with no holder or buyback share this is a Vanilla coin' : 'with no buyback share this is a Holder Rewards coin');
    holderBpsQuote = holderBpsToken = h; buybackBps = b; burnBought = o.burn ?? true;
  } else throw new Error(`unknown Ascend coin type "${type}"`);
  const payees = (o.payees || []).map((p) => ({ wallet: p.wallet, bps: Number(p.bps) }));
  if (!payees.length) throw new Error('a seat needs at least one payee');
  if (payees.length > 10) throw new Error('at most 10 payees');
  for (const p of payees) {
    if (!isAddress(p.wallet) || /^0x0{40}$/i.test(p.wallet)) throw new Error(`payee ${p.wallet} is not a wallet address`);
    if (/^0x0{36}dead$/i.test(p.wallet)) throw new Error('the burn address cannot claim fees; enter a wallet');
    if (!(Number.isInteger(p.bps) && p.bps > 0)) throw new Error('every payee’s share must be above 0%');
  }
  if (payees.reduce((s, p) => s + p.bps, 0) !== 10000) throw new Error('payee shares must add up to 100%');
  const devBuyTo = o.devBuyTo ? o.devBuyTo : ZERO;
  if (o.devBuyTo && !isAddress(o.devBuyTo)) throw new Error('the dev-buy recipient is not an address');
  return { holderBpsQuote, holderBpsToken, buybackBps, burnBought, devBuyTo, payees: payees.map((p) => getAddress(p.wallet)), bps: payees.map((p) => p.bps) };
}

/// The creator share, said plainly: where every creator fee goes.
export function ascendSeatSummary(seat) {
  if (!seat) return 'Vanilla: the creator share goes to one wallet';
  const f = (b) => `${(b / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
  const rest = 10000 - Math.max(seat.holderBpsQuote, seat.holderBpsToken) - seat.buybackBps;
  const h = seat.holderBpsQuote === seat.holderBpsToken ? f(seat.holderBpsQuote) : `${f(seat.holderBpsQuote)} of quote and ${f(seat.holderBpsToken)} of coin fees`;
  return [seat.holderBpsQuote || seat.holderBpsToken ? `${h} to holders` : null, seat.buybackBps ? `${f(seat.buybackBps)} to buybacks${seat.burnBought ? ' (burned)' : ''}` : null,
    rest > 0 ? `${f(rest)} to ${seat.payees.length === 1 ? 'the payee' : seat.payees.length + ' payees'}` : null].filter(Boolean).join(', ');
}

// --- the dev buy ---------------------------------------------------------------
const Q96 = 1n << 96n;
const mulDiv = (a, b, c) => (a * b) / c;
const mulDivUp = (a, b, c) => { const p = a * b; return p / c + (p % c === 0n ? 0n : 1n); };
const divUp = (a, b) => (a + b - 1n) / b;

/// Coins a dev buy of `quoteIn` gets: the coin's range opens just outside the
/// price, so the buy crosses the gap free and then trades inside one range.
/// `tokenIs0` = the coin's address sorts below the quote's.
export function ascendDevBuyOut({ quoteIn, startTick, tokenIs0 }) {
  quoteIn = BigInt(quoteIn);
  if (quoteIn <= 0n) return { tokensOut: 0n, quoteSpent: 0n, refund: 0n };
  let lo = startTick, up = startTick + RANGE_TICKS;
  if (!tokenIs0) [lo, up] = [-up, -lo];
  const sLo = sqrtPriceAtTick(lo), sUp = sqrtPriceAtTick(up);
  // the whole supply in the range, as Ascend seeds it
  const L = tokenIs0 ? mulDiv(ASCEND_SUPPLY, mulDiv(sLo, sUp, Q96), sUp - sLo) : mulDiv(ASCEND_SUPPLY, Q96, sUp - sLo);
  if (tokenIs0) {
    // quote is token1: price rises from sLo
    const toTop = divUp(mulDivUp(L, sUp - sLo, Q96), 1n);
    if (quoteIn >= toTop) return { tokensOut: ((L << 96n) * (sUp - sLo) / sUp) / sLo, quoteSpent: toTop, refund: quoteIn - toTop };
    const s1 = sLo + (quoteIn < (1n << 160n) ? (quoteIn << 96n) / L : (quoteIn * Q96) / L);
    return { tokensOut: ((L << 96n) * (s1 - sLo) / s1) / sLo, quoteSpent: quoteIn, refund: 0n };
  }
  // quote is token0: price falls from sUp
  const toBottom = divUp(mulDivUp(L << 96n, sUp - sLo, sUp), sLo);
  if (quoteIn >= toBottom) return { tokensOut: (L * (sUp - sLo)) / Q96, quoteSpent: toBottom, refund: quoteIn - toBottom };
  const r = L << 96n, prod = quoteIn * sUp;
  const s1 = prod < (1n << 256n) && r + prod < (1n << 256n) ? mulDivUp(r, sUp, r + prod) : divUp(r, r / sUp + quoteIn);
  return { tokensOut: (L * (sUp - s1)) / Q96, quoteSpent: quoteIn, refund: 0n };
}

const randomSalt = () => {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

/// The quote a launch pairs with: one of ASCEND_QUOTES by key, or any token by
/// address - as long as Ascend's launchpad allows it right now.
export async function ascendQuote(pub, keyOrAddress = 'KNTQ') {
  let q = ASCEND_QUOTES.find((x) => x.key === keyOrAddress || x.token.toLowerCase() === String(keyOrAddress).toLowerCase());
  if (!q) {
    if (!isAddress(keyOrAddress)) throw new Error('pair with HYPE, KNTQ, USDC or a token address Ascend allows');
    const token = getAddress(keyOrAddress);
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: token, abi: ASCEND_ERC20_ABI, functionName: 'symbol' }).catch(() => '?'),
      pub.readContract({ address: token, abi: ASCEND_ERC20_ABI, functionName: 'decimals' }),
    ]).catch(() => { throw new Error(`${token} is not a token on Elysium`); });
    q = { key: token, symbol, token, decimals: Number(decimals) };
  }
  const cfg = await pub.readContract({ address: ASCEND_LAUNCHPAD, abi: QUOTE_ABI, functionName: 'quoteConfig', args: [q.token] });
  if (!cfg.allowed) throw new Error(`Ascend does not take ${q.symbol} as a pair for new launches right now`);
  return { ...q, startTick: Number(cfg.startTick), maxClip: cfg.maxClip };
}

/// The launch, ready to send.
///   o.account, o.name, o.symbol, o.quote ('HYPE' | 'KNTQ' | 'USDC' | address)
///   o.feePct (1-10, two decimals), o.devBuy (in the quote), o.plan (needed for
///   a dev buy over 10% of supply), o.recipient (Vanilla's creator wallet), and
///   the seat options of ascendSeat().
export async function ascendPlan(pub, o) {
  if (!o.name || !o.symbol) throw new Error('the coin needs a name and a ticker');
  if ([...o.name].length > 40) throw new Error('Ascend names are at most 40 characters');
  if ([...o.symbol].length > 32) throw new Error('Ascend tickers are at most 32 characters');
  const feeStr = String(o.feePct ?? 1).trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(feeStr)) throw new Error('the trade fee is 1%–10%, with at most two decimals');
  const fee = Math.round(Number(feeStr) * 10000);
  if (!(fee >= ASCEND_FEE.minPips && fee <= ASCEND_FEE.maxPips)) throw new Error('the trade fee is 1%–10%, with at most two decimals');
  const seat = ascendSeat(o.type && o.type !== 'vanilla' ? { ...o, payees: o.payees?.length ? o.payees : [{ wallet: o.account, bps: 10000 }] } : { type: 'vanilla' });
  const recipient = o.recipient || o.account;
  if (!seat && !isAddress(recipient)) throw new Error('the creator wallet is not an address');

  const [quote, ruleSet, termsVersion] = await Promise.all([
    ascendQuote(pub, o.quote || 'KNTQ'),
    pub.readContract({ address: ASCEND_ESCROW_FACTORY, abi: ASCEND_ESCROW_ABI, functionName: 'ruleSet' }),
    pub.readContract({ address: ASCEND_ESCROW_FACTORY, abi: ASCEND_ESCROW_ABI, functionName: 'LAUNCH_TERMS_VERSION' }),
  ]);
  if (termsVersion < 1n) throw new Error('Ascend’s factory predates checked launches; this pad needs updating');
  const devBuy = parseAmount(o.devBuy || '0', quote.decimals);
  const salt = randomSalt();
  const coin = (minDevOut) => ({ name: o.name, symbol: o.symbol, quote: quote.token, devBuyQuote: devBuy, minDevOut, salt, creator: ZERO, fee, builderFee: 0 });

  // the coin's address, from Ascend's own predict
  let token, seatAddress = null;
  if (seat) {
    seatAddress = await pub.readContract({ address: ASCEND_SEAT_FACTORY, abi: ASCEND_SEAT_ABI, functionName: 'predict', args: [o.account, seat, salt] });
    const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [o.account, salt]));
    const terms = { recipient: seatAddress, dev: seat.devBuyTo === ZERO ? seat.payees[0] : seat.devBuyTo, builder: ZERO, cto: false };
    [, token] = await pub.readContract({ address: ASCEND_ESCROW_FACTORY, abi: ASCEND_ESCROW_ABI, functionName: 'predict', args: [ASCEND_SEAT_FACTORY, { ...coin(0n), salt: inner }, terms] });
  } else {
    const terms = { recipient: getAddress(recipient), dev: getAddress(recipient), builder: ZERO, cto: true };
    [, token] = await pub.readContract({ address: ASCEND_ESCROW_FACTORY, abi: ASCEND_ESCROW_ABI, functionName: 'predict', args: [o.account, coin(0n), terms] });
  }
  const tokenIs0 = BigInt(token) < BigInt(quote.token);
  const buy = ascendDevBuyOut({ quoteIn: devBuy, startTick: quote.startTick, tokenIs0 });
  const devBuyMinOut = (buy.tokensOut * 99n) / 100n;
  const needsPlan = buy.tokensOut * 10n > ASCEND_SUPPLY;
  if (needsPlan && !String(o.plan || '').trim()) throw new Error('a dev buy over 10% of supply needs an allocation plan (what you will do with the coins), as Ascend requires');
  if (o.plan && String(o.plan).trim().length > 500) throw new Error('the allocation plan is at most 500 characters');

  const target = seat ? ASCEND_SEAT_FACTORY : ASCEND_ESCROW_FACTORY;
  const encode = (minDevOut) => {
    let data = seat
      ? encodeFunctionData({ abi: ASCEND_SEAT_ABI, functionName: 'launchChecked', args: [coin(minDevOut), seat, salt, ZERO, ruleSet, quote.startTick] })
      : encodeFunctionData({ abi: ASCEND_ESCROW_ABI, functionName: 'launchChecked', args: [coin(minDevOut), { recipient: getAddress(recipient), dev: getAddress(recipient), builder: ZERO, cto: true }, ruleSet, quote.startTick] });
    // Ascend's app appends its disclosure / metadata after the call itself
    if (needsPlan || o.plan) data = concat([data, encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }, { type: 'string' }], [DISCLOSURE_TAG, o.metadataUri || '', String(o.plan).trim()])]);
    else if (o.metadataUri) data = concat([data, encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }], [METADATA_TAG, o.metadataUri])]);
    return data;
  };
  const data = encode(devBuyMinOut);

  return {
    request: { to: target, data, value: 0n },
    target, token: getAddress(token), seat: seatAddress, seatConfig: seat, quote, fee, ruleSet, salt,
    devBuy, expectedOut: buy.tokensOut, devBuyMinOut, refund: buy.refund, tokenIs0, needsPlan,
    /// the same launch with another minimum out (tests use it to prove the maths exact)
    withMinOut: (min) => ({ to: target, data: encode(min), value: 0n }),
  };
}

/// What the dev buy needs first: the quote in the wallet (HYPE is wrapped) and
/// an allowance for the factory being called.
export async function ascendDevBuyNeeds(pub, account, plan) {
  if (plan.devBuy <= 0n) return { ok: true, steps: [] };
  const [bal, allow, native] = await Promise.all([
    pub.readContract({ address: plan.quote.token, abi: ASCEND_ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    pub.readContract({ address: plan.quote.token, abi: ASCEND_ERC20_ABI, functionName: 'allowance', args: [account, plan.target] }),
    pub.getBalance({ address: account }),
  ]);
  const steps = [];
  let short = bal < plan.devBuy ? plan.devBuy - bal : 0n;
  if (short > 0n && plan.quote.wrap) {
    if (native < short) throw new Error(`the dev buy needs ${short} more wei of HYPE than the wallet holds`);
    steps.push({ kind: 'wrap', amount: short, request: { address: WHYPE, abi: ASCEND_ERC20_ABI, functionName: 'deposit', value: short } });
    short = 0n;
  }
  if (allow < plan.devBuy) steps.push({ kind: 'approve', amount: plan.devBuy, request: { address: plan.quote.token, abi: ASCEND_ERC20_ABI, functionName: 'approve', args: [plan.target, plan.devBuy] } });
  return { ok: short === 0n && !steps.length, short, balance: bal, allowance: allow, steps };
}
