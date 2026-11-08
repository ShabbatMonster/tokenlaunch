// Ascend (ascendlaunch.xyz): Elysium's launchpad that opens each coin straight
// into a Uniswap v4 hook pool - no bonding curve - paired with KNTQ.
//
// Ascend publishes no ABI and its site will not load outside a browser
// (Cloudflare), so this was worked out from the chain, 2026-11-08: two real
// launches (e/acc 0xDEB08b…, no buy; Blob 0xd2A744…, a 220 KNTQ buy), their
// events, and simulating the factory with one field changed at a time. The
// encoder below rebuilds e/acc's launch byte for byte.
//
//   launch(Coin, Fees, bytes32 salt, uint256 0, address platform, int24 tick)
//     Coin = (name, symbol, quote, devBuyAmount, devBuyMinOut, salt, 0, 10000, 0)
//     Fees = (10000, 10000, 0, 0, 0, address[] recipients, uint256[] shares)
//
// Fields marked FIXED revert if changed, so they are Ascend's own settings and
// are sent exactly as its site sends them. The fee recipients and their shares
// (to 10,000) are the creator's to choose. The coin starts at a fixed price
// (tick -117600) with the whole supply in one range, so a dev buy's output is
// exact v4 arithmetic - it matches Blob's real buy to the wei, at 0% fee.
import { encodeAbiParameters, parseAbi, getAddress } from 'viem';
import { KNTQ, buyToken0Out, parseAmount, ELYSIUM_EXPLORER } from './elysium.js';

export const ASCEND_FACTORY = getAddress('0xbdb8d64452191041c4daa3ad0f64be4380fea0b1');
export const ASCEND_LAUNCHPAD = getAddress('0xe0def4221b9840a610d4e7d55812a79a6431a8ec');   // the v4 hook
const PLATFORM = getAddress('0xa9a627729d04576d8f79e3279bd17429c7794712');   // FIXED: zero reverts
const TICK = -117400;                                           // FIXED: the range's lower tick
const SELECTOR = '0x0dd88951';
/// The one range every Ascend coin opens with (1B supply, KNTQ quote).
export const ASCEND_SEED = { startTick: -117600, tickLower: -117400, tickUpper: 82600, liquidity: 2823830179493213523424743n };
export const ascendCoinUrl = (t) => `${ELYSIUM_EXPLORER}/token/${t}`;
export const ascendTxUrl = (h) => `${ELYSIUM_EXPLORER}/tx/${h}`;

const TYPES = [
  { type: 'tuple', components: [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] },
  { type: 'tuple', components: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'uint256[]' }] },
  { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'int24' },
];
const ERC20 = parseAbi(['function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
export const ASCEND_ERRORS = { '0x873e2c9a': 'the dev buy would get less than its minimum out' };

/// The launch calldata.
export function ascendCalldata({ name, symbol, devBuy = 0n, devBuyMinOut = 0n, salt, recipients, shares }) {
  return SELECTOR + encodeAbiParameters(TYPES, [
    [name, symbol, KNTQ, devBuy, devBuyMinOut, salt, 0n, 10000n, 0n],
    [10000n, 10000n, 0n, 0n, 0n, recipients, shares],
    salt, 0n, PLATFORM, TICK,
  ]).slice(2);
}

/// Tokens a KNTQ dev buy gets - the launch's own first trade, which pays no fee.
export const ascendDevBuyOut = (kntqIn) => buyToken0Out({ amountIn: kntqIn, feePips: 0, liquidity: ASCEND_SEED.liquidity, tickLower: ASCEND_SEED.tickLower });

const randomSalt = () => {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

/// The launch, ready to send. `pub.call` predicts the coin's address; the salt is
/// re-rolled until it sorts below KNTQ, the layout both real launches have and
/// the one the dev-buy maths is checked against.
export async function ascendPlan(pub, o) {
  if (!o.name || !o.symbol) throw new Error('the coin needs a name and a ticker');
  const recipients = o.split?.length ? o.split.map((s) => s.wallet) : [o.account];
  const shares = o.split?.length ? o.split.map((s) => BigInt(s.bps)) : [10000n];
  if (shares.reduce((a, b) => a + b, 0n) !== 10000n) throw new Error('the fee shares have to add up to 100%');
  const devBuy = parseAmount(o.devBuyKntq || '0', 18);
  const expectedOut = devBuy > 0n ? ascendDevBuyOut(devBuy) : 0n;
  const devBuyMinOut = (expectedOut * 99n) / 100n;
  let salt, token;
  for (let i = 0; i < 12; i++) {
    salt = randomSalt();
    // predicted with no dev buy, so it works before the KNTQ approval exists
    const r = await pub.call({ account: o.account, to: ASCEND_FACTORY, data: ascendCalldata({ name: o.name, symbol: o.symbol, salt, recipients, shares }) })
      .catch((e) => { throw new Error('Ascend would refuse this launch: ' + (e.shortMessage || e.message)); });
    token = '0x' + r.data.slice(26, 66);
    if (BigInt(token) < BigInt(KNTQ)) break;
    token = null;
  }
  if (!token) throw new Error('could not find a coin address that sorts below KNTQ; try again');
  return {
    request: { to: ASCEND_FACTORY, data: ascendCalldata({ name: o.name, symbol: o.symbol, devBuy, devBuyMinOut, salt, recipients, shares }), value: 0n },
    token, salt, devBuy, expectedOut, devBuyMinOut, recipients, shares,
  };
}

/// What the dev buy needs first: KNTQ in the wallet and an allowance for the factory.
export async function ascendDevBuyNeeds(pub, account, devBuy) {
  if (devBuy <= 0n) return { ok: true };
  const [bal, allow] = await Promise.all([
    pub.readContract({ address: KNTQ, abi: ERC20, functionName: 'balanceOf', args: [account] }),
    pub.readContract({ address: KNTQ, abi: ERC20, functionName: 'allowance', args: [account, ASCEND_FACTORY] }),
  ]);
  return { ok: bal >= devBuy && allow >= devBuy, balance: bal, allowance: allow, needsApproval: allow < devBuy, short: bal < devBuy ? devBuy - bal : 0n };
}
export const ASCEND_KNTQ_ABI = ERC20;
