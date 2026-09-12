import {
  createPublicClient, createWalletClient, http, defineChain,
  parseEther, formatEther, keccak256, stringToBytes, parseEventLogs, getAddress,
  encodeAbiParameters, encodeFunctionData, encodePacked, concat, parseUnits, formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FAIRTOKEN_BYTECODE, FAIRTOKEN_ABI, FAIRTOKEN_TAX_BYTECODE, FAIRTOKEN_TAX_ABI } from './fairtoken.js';
import { buildPoolsLaunch, buildPoolsTokenData, selfTestPoolsLaunch, POOLS_LAUNCHER, POOLS_POOL_STRATEGY } from './poolsAtomic.js';
selfTestPoolsLaunch(); // fail fast if the launch recipe ever drifts

// ---------------------------------------------------------------------------
// Uniswap V2 fair-launch config. Deploy a fixed-supply, non-mintable ERC-20,
// pool it against ETH via the V2 router, and burn the LP to the dead address so
// liquidity is permanently locked. Multi-chain ready — only mainnet is enabled.
// ---------------------------------------------------------------------------
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const UNISWAP_V2_ROUTER_ABI = [
  {
    type: 'function', name: 'addLiquidityETH', stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountTokenDesired', type: 'uint256' },
      { name: 'amountTokenMin', type: 'uint256' },
      { name: 'amountETHMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountToken', type: 'uint256' },
      { name: 'amountETH', type: 'uint256' },
      { name: 'liquidity', type: 'uint256' },
    ],
  },
];
const UNISWAP_V2_FACTORY_ABI = [
  { type: 'function', name: 'getPair', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'address' }] },
];
// DYORswap V3 launchpad on ARC (chain 5042, USDC-native). API-driven like Rialto:
// prepare returns a ready {to,data,value} tx that deploys a fixed-supply immutable
// ERC-20, pools the full supply in a Uniswap V3 pool vs USDC, and locks the LP NFT
// in an immutable vault. Dev buy (initialBuyEth) is denominated in USDC (≤6 dp).
const DYOR_ARC_API = 'https://dyorv3.org/api/arc/v1';

// per-chain Uniswap V2 deployment (router / factory / WETH). Add chains here.
const UNISWAP_CHAINS = {
  1: {
    rpc: 'https://eth.llamarpc.com',
    router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    explorer: 'https://etherscan.io',
  },
};

// ---------------------------------------------------------------------------
// launchpad registry — flip `enabled` to light up more pads (same Noxa ABI)
// ---------------------------------------------------------------------------
const FACTORY_ABI = [
  {
    type: 'function', name: 'launchToken', stateMutability: 'payable',
    inputs: [
      {
        name: 'params', type: 'tuple', components: [
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
          { name: 'logo', type: 'string' },
          { name: 'description', type: 'string' },
          {
            name: 'socials', type: 'tuple', components: [
              { name: 'telegram', type: 'string' },
              { name: 'twitter', type: 'string' },
              { name: 'discord', type: 'string' },
              { name: 'website', type: 'string' },
              { name: 'farcaster', type: 'string' },
            ],
          },
          { name: 'devWallet', type: 'address' },
        ],
      },
      { name: 'launchConfigId', type: 'uint256' },
      { name: 'dexId', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [{ name: 'token', type: 'address' }, { name: 'positionId', type: 'uint256' }],
  },
  { type: 'function', name: 'launchFee', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'launchEnabled', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  {
    type: 'event', name: 'TokenLaunched', inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'deployer', type: 'address', indexed: true },
      { name: 'dexFactory', type: 'address', indexed: true },
      { name: 'pairToken', type: 'address', indexed: false },
      { name: 'pool', type: 'address', indexed: false },
      { name: 'dexId', type: 'uint256', indexed: false },
      { name: 'launchConfigId', type: 'uint256', indexed: false },
      { name: 'positionId', type: 'uint256', indexed: false },
      { name: 'restrictionsEndBlock', type: 'uint256', indexed: false },
      { name: 'initialBuyAmount', type: 'uint256', indexed: false },
    ],
  },
];

// ---------------------------------------------------------------------------
// Pons v2 (docs.ponsfamily.com/v2) — different family from Noxa. Launches go
// through launchToken(params, launchConfigId, pairToken) with an economics pin
// read from previewLaunchEconomics() to stop config front-running. No initial
// buy in the launch tx — dev buys are a separate buy() on the returned curve.
// Fees accrue per-recipient in the Fee Escrow: claim() native, claimToken(erc20).
// ABI transcribed from the docs; verify against the published ABI on deploy.
// ---------------------------------------------------------------------------
const PONS_FACTORY_ABI = [
  {
    type: 'function', name: 'launchToken', stateMutability: 'payable',
    inputs: [
      {
        name: 'params', type: 'tuple', components: [
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
          { name: 'logo', type: 'string' },
          { name: 'description', type: 'string' },
          {
            name: 'socials', type: 'tuple', components: [
              { name: 'twitter', type: 'string' },
              { name: 'telegram', type: 'string' },
              { name: 'discord', type: 'string' },
              { name: 'website', type: 'string' },
              { name: 'farcaster', type: 'string' },
            ],
          },
          { name: 'creatorFeeRecipient', type: 'address' },
          { name: 'creatorTaxBps', type: 'uint16' },
          { name: 'buybackEnabled', type: 'bool' },
          { name: 'expectedEconomics', type: 'bytes32' },
        ],
      },
      { name: 'launchConfigId', type: 'uint256' },
      { name: 'pairToken', type: 'address' },
    ],
    outputs: [{ name: 'token', type: 'address' }, { name: 'curve', type: 'address' }],
  },
  { type: 'function', name: 'launchFee', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'launchEnabled', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'maxCreatorTaxBps', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function', name: 'previewLaunchEconomics', stateMutability: 'view',
    inputs: [{ name: 'configId', type: 'uint256' }, { name: 'pairToken', type: 'address' }],
    outputs: [{ type: 'bytes32' }],
  },
];

const PONS_CURVE_ABI = [
  {
    type: 'function', name: 'buy', stateMutability: 'payable',
    inputs: [
      { name: 'quoteIn', type: 'uint256' },
      { name: 'minTokensOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'tokensOut', type: 'uint256' }],
  },
  {
    type: 'function', name: 'sell', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokensIn', type: 'uint256' },
      { name: 'minQuoteOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'quoteOut', type: 'uint256' }],
  },
];

// PonsV2FeeEscrow (v2) — fees accrue per recipient; claim() sends to msg.sender.
const PONS_ESCROW_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'recipient', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOfToken', inputs: [{ name: 'recipient', type: 'address' }, { name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'claim', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimToken', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' },
];
// PonsLaunchLocker (v1) — owns the LP position NFTs; collectFees(token) collects
// the v3 fees and sends them to that token's recorded fee wallet (feeRedirects),
// after the protocol share. Gated so only the recipient/collector can call it.
const PONS_LOCKER_ABI = [
  { type: 'function', name: 'collectFees', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'feeRecipientTokenCount', inputs: [{ name: 'recipient', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'feeRecipientTokens', inputs: [{ name: 'recipient', type: 'address' }, { name: 'i', type: 'uint256' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'feeRedirects', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
];
const PONS_LOCKER_ADDR = '0x736D76699C26D0d966744cAe304C000d471f7F35';
const PONS_ESCROW_ADDR = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e'; // v2 fee escrow (current)

// PonsV2LaunchFactory — bonding-curve launch. launchToken(params{…,salt},
// launchConfigId, pairToken, snipeTaxExemptions[]) -> (token, curve).
const PONS_V2_FACTORY_ABI = [
  { type: 'error', name: 'MetadataTooLong', inputs: [] },
  { type: 'function', name: 'launchEnabled', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'launchFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxCreatorTaxBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approvedPairTokens', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'previewLaunchEconomics', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bytes32' }] },
  {
    type: 'function', name: 'launchToken', stateMutability: 'payable',
    inputs: [
      { name: 'params', type: 'tuple', components: [
        { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
        { name: 'logo', type: 'string' }, { name: 'description', type: 'string' },
        { name: 'socials', type: 'tuple', components: [
          { name: 'twitter', type: 'string' }, { name: 'telegram', type: 'string' },
          { name: 'discord', type: 'string' }, { name: 'website', type: 'string' }, { name: 'farcaster', type: 'string' },
        ] },
        { name: 'creatorFeeRecipient', type: 'address' }, { name: 'creatorTaxBps', type: 'uint16' },
        { name: 'buybackEnabled', type: 'bool' }, { name: 'expectedEconomics', type: 'bytes32' },
        { name: 'salt', type: 'bytes32' },
      ] },
      { name: 'launchConfigId', type: 'uint256' }, { name: 'pairToken', type: 'address' },
      { name: 'snipeTaxExemptions', type: 'address[]' },
    ],
    outputs: [{ name: 'token', type: 'address' }, { name: 'curve', type: 'address' }],
  },
];
// ---------------------------------------------------------------------------
// Our own Uniswap-v4 bonding curve (contracts/AnyQuoteCurve*.sol).
// Same curve shape as Pons v2 (virtual quote = 0.4x the graduation threshold,
// so ~71.43% of supply sells on the curve and the rest seeds the pool), with
// the two restrictions removed: ANY quote token is allowed, and graduate() is
// permissionless the moment the threshold is met — no executor bot, no rescue
// delay, so a curve can never end up closed-but-poolless.
const V4CURVE_FACTORY = '0xaE6c291948611B29C030eBac5f71FD1C6928aE41'; // AnyQuoteCurveFactory, deployed 2026-09-02
const V4CURVE_ABI = [
  {
    type: 'function', name: 'launch', stateMutability: 'payable',
    inputs: [{ name: 'p', type: 'tuple', components: [
      { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
      { name: 'logo', type: 'string' }, { name: 'description', type: 'string' },
      { name: 'twitter', type: 'string' }, { name: 'website', type: 'string' },
      { name: 'quoteToken', type: 'address' }, { name: 'graduationThreshold', type: 'uint256' },
      { name: 'supply', type: 'uint256' }, { name: 'poolFee', type: 'uint24' },
      { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
      { name: 'feeBps', type: 'uint16' },
    ] }],
    outputs: [{ name: 'token', type: 'address' }, { name: 'curve', type: 'address' }],
  },
  { type: 'function', name: 'launchFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
const V4CURVE_BUY_ABI = [
  { type: 'function', name: 'buy', stateMutability: 'payable', inputs: [
    { name: 'quoteIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' }, { name: 'recipient', type: 'address' },
  ], outputs: [{ type: 'uint256' }] },
];

// Pons v2 rejects oversized metadata with MetadataTooLong() (0x85b8e2f4). The
// caps are PER FIELD (not a combined total) and were measured against the live
// factory by binary-searching each field until the revert flipped.
const PONS_V2_META_LIMITS = {
  name: 64, symbol: 16, logo: 512, description: 2048,
  twitter: 256, website: 256, telegram: 256, discord: 256, farcaster: 256,
};
function checkPonsV2Metadata(fields) {
  for (const [key, max] of Object.entries(PONS_V2_META_LIMITS)) {
    const v = fields[key];
    if (typeof v === 'string' && v.length > max) {
      throw new Error(`${key} is ${v.length} characters — Pons v2 allows at most ${max}. Shorten it by ${v.length - max}.`);
    }
  }
}

const PONS_V2_CURVE_ABI = [
  { type: 'function', name: 'buy', stateMutability: 'payable', inputs: [{ name: 'quoteIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
// PonsV2LaunchAndBuy — ATOMIC launch + dev buy in a single tx (no snipe gap).
const PONS_V2_FORWARDER_ADDR = '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948';
const PONS_V2_FORWARDER_ABI = [
  { type: 'error', name: 'MetadataTooLong', inputs: [] },
  {
  type: 'function', name: 'launchAndBuy', stateMutability: 'payable',
  inputs: [
    { name: 'params', type: 'tuple', components: [
      { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
      { name: 'logo', type: 'string' }, { name: 'description', type: 'string' },
      { name: 'socials', type: 'tuple', components: [
        { name: 'twitter', type: 'string' }, { name: 'telegram', type: 'string' },
        { name: 'discord', type: 'string' }, { name: 'website', type: 'string' }, { name: 'farcaster', type: 'string' },
      ] },
      { name: 'creatorFeeRecipient', type: 'address' }, { name: 'creatorTaxBps', type: 'uint16' },
      { name: 'buybackEnabled', type: 'bool' }, { name: 'expectedEconomics', type: 'bytes32' }, { name: 'salt', type: 'bytes32' },
    ] },
    { name: 'launchConfigId', type: 'uint256' }, { name: 'pairToken', type: 'address' },
    { name: 'quoteIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' },
    { name: 'recipient', type: 'address' }, { name: 'snipeTaxExemptions', type: 'address[]' },
  ],
  outputs: [{ name: 'token', type: 'address' }, { name: 'curve', type: 'address' }, { name: 'tokensOut', type: 'uint256' }],
}];
// Wallets exempt from the 99%-for-3s snipe tax on every Pons v2 launch (the launch's
// snipeTaxExemptions[]). The dev/launcher wallet is added automatically, and its atomic
// dev buy is untaxed regardless — these are the extra wallets you want to buy tax-free
// inside the snipe window.
const PONS_V2_TAX_WHITELIST = [
  '0x9e1c2a59fb22387990f507952b598283a4cf326f',
  '0x4bceadd89c26691c7c912a55fa27e957c6a55fc2',
  '0x7b36ca9407db51838f882449c266f3344160512a',
  '0xb4aa78fd343f16d67ecb6a1bd4ad112bb91be692',
  '0x9f1b39369aa566debb4e49b754c9b928de72fed8',
  '0xbab72092a2f053e34d3ca4e0b08ca84b48411bab',
  '0xf6f4c51457ffbbfee16c75fd23fdfa641016d2e5',
  '0xeeeeeeeeeeebf4d6b932da0e2f77c6dd277ec991',
  '0x665d601a51b53c70f9a00f82d96d2d8596369999',
  '0xe4dbba098059855d51349f59157e7a59de42e395',
  '0xab928c7ba171c7ac8e15f16407f3be3e0a72b553',
  '0x5d6c57466756e5963b402b7f9b9c29ccd202f4fb',
  '0x1a936979e68b8743897525d0d361043022db224c',
  '0xbbcd2d2c1483f6104516be34d6251186189d8443',
];

// ---------------------------------------------------------------------------
// Rialto (varo.rialto.xyz) — chain 4663, same chain as our other pads, but a
// PERMISSIONED launchpad: launches are Rialto-signed intents, not open factory
// calls. Flow reverse-engineered from the live web app bundle + a live launch:
//
//   1. SIWE-authenticate the wallet  POST /auth/challenge {wallet}
//                                     -> sign message, POST /auth/verify -> JWT
//   2. Upload the image             POST /assets/images (multipart) -> { url }
//   3. Ask Rialto to build+sign the intent
//                          POST /intents/create-token {name,symbol,image_uri,
//                          quote_token,fee_recipients,request_id}
//      -> { params, authorization, signature, transaction }. The pool economics
//         (tick, sqrtPrice, supply) are computed server-side from the chosen
//         quote token and baked into the signed intent; authorized by Rialto's
//         backend signer and valid ~6 min.
//   4. Submit the returned transaction (to = intent executor) from the wallet.
//      On-chain: executeLaunch(params, authorization, signature) -> (token, locker).
//
// A launch CANNOT be produced without Rialto co-signing — unlike the
// permissionless Noxa/Pons factories.
// ---------------------------------------------------------------------------
const RIALTO_API = 'https://varo.rialto.xyz/api/v1';
const TRANSFER_TOPIC = keccak256(stringToBytes('Transfer(address,address,uint256)'));

// executeLaunch(params, authorization, bytes signature) -> (token, locker).
// Kept for pre-send eth_call (to read the launched token) and reference; the
// actual submission relays Rialto's own pre-built calldata verbatim.
const RIALTO_EXECUTOR_ABI = [
  {
    type: 'function', name: 'executeLaunch', stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params', type: 'tuple', components: [
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
          { name: 'imageURI', type: 'string' },
          { name: 'creator', type: 'address' },
          { name: 'saltNonce', type: 'uint32' },
          { name: 'feeWallets', type: 'address[]' },     // creator-fee split targets
          { name: 'feeSharesBps', type: 'uint16[]' },     // bps, sums to 10000
          { name: 'supply', type: 'uint256' },
          { name: 'initialTick', type: 'int24' },
          { name: 'initialSqrtPriceX96', type: 'uint160' },
          { name: 'protocolFeeBps', type: 'uint16' },
          { name: 'quoteAsset', type: 'address' },        // WETH / USDG / NVDA / SPCX …
        ],
      },
      {
        name: 'authorization', type: 'tuple', components: [
          { name: 'authorizer', type: 'address' },
          { name: 'validAfter', type: 'uint48' },
          { name: 'validBefore', type: 'uint48' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'token', type: 'address' }, { name: 'locker', type: 'address' }],
  },
];

const LOCKER_ABI = [
  // Noxa lockers use collectFees, RobinFun's fork renamed it claimFees —
  // pick via pad.claimFn. Both are permissionless; fees route to devWallet.
  { type: 'function', name: 'collectFees', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimFees', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
];
const TOKEN_LAUNCHED_EVENT = FACTORY_ABI.find((f) => f.type === 'event' && f.name === 'TokenLaunched');
const ERC20_ABI = [
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];
// full ERC-20 used by the flap/pons dev-buy + PancakeSwap paths
const ERC20 = [
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];

// launch-buy curve: tokens_out = supply * x / (cap + x), x in ETH.
// cap fitted exactly (0.0000% err) against historical launchToken txs on
// Noxa/RobinFun; our factory uses the same starting valuation by design.
const ROBINHOOD_CURVE = { cap: 1.36935, supply: 1e9 };
const OUR_CURVE = { cap: 1.36929 }; // supply comes from the SUPPLY input

// our factory's launchToken takes one extra params field: totalSupply
const OUR_FACTORY_ABI = (() => {
  const base = JSON.parse(JSON.stringify(FACTORY_ABI));
  base.find((f) => f.name === 'launchToken').inputs[0].components.push({ name: 'totalSupply', type: 'uint256' });
  return base;
})();

// Solana / Meteora DBC config (chain logic lives in the lazy-loaded solana.js).
// Defined before PADS because the meteora pad references SOL_RPC.
// primary Helius RPC + fallbacks (the first key was maxed, so the backup leads).
// A public RPC is the last resort for plain reads (getAccountInfo, etc.).
const SOL_RPC = 'https://mainnet.helius-rpc.com/?api-key=ae11f74a-b518-408b-bc88-524c277da375';
const SOL_RPC_FALLBACKS = [
  'https://mainnet.helius-rpc.com/?api-key=3fb08d49-71d7-492b-84f1-9ff0e3eb95ea',
  'https://api.mainnet-beta.solana.com',
];
const SOL_QUOTES = {
  SOL:  { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL',  decimals: 9, defaultThreshold: 85 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, defaultThreshold: 17000 },
};
const SOL_FEE_WALLET = 'H5GAYEieNUyTmHFD4foJEKSpkggEDHBV9ffGebrD6wAW';
const SOL_CUSTOM_DEFAULT = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump'; // prefill for custom quote
const SOL_CUSTOM_THRESHOLD = 1000000; // default migration threshold for custom quotes

// Every quote mint with a live Raydium LaunchLab config (checked on-chain) —
// shared by both the raydium-sol and bonk-sol pads below, since they run the
// same LaunchLab program/configs and differ only in platformId. NVDAx / SPYx /
// CRCLx are the stock-pegged xStocks quotes (stock pairing).
// stonkfun.xyz pair tokens (their categorised quotes; the 361 community
// "custom" ones are reachable via SCAN or by pasting a mint).
const STONK_QUOTES = [
  { symbol: 'SKR', mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3', decimals: 6, kind: 'solana', name: "Seeker" },
  { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9, kind: 'solana', name: "Wrapped SOL" },
  { symbol: 'EURC', mint: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', decimals: 6, kind: 'currency', name: "EURC" },
  { symbol: 'JLUSDC', mint: '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D', decimals: 6, kind: 'currency', name: "JLUSDC" },
  { symbol: 'ONYC', mint: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5', decimals: 9, kind: 'currency', name: "ONYC" },
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, kind: 'currency', name: "USDC" },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, kind: 'currency', name: "USDT" },
  { symbol: 'AMZNX', mint: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg', decimals: 8, kind: 'xstock', name: "AMAZON" },
  { symbol: 'APPLX', mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', decimals: 8, kind: 'xstock', name: "APPLE" },
  { symbol: 'BRKX', mint: 'Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x', decimals: 8, kind: 'xstock', name: "BRKX" },
  { symbol: 'COINX', mint: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu', decimals: 8, kind: 'xstock', name: "COIN" },
  { symbol: 'CRCLX', mint: 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1', decimals: 8, kind: 'xstock', name: "CIRCLE" },
  { symbol: 'GLDX', mint: 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re', decimals: 8, kind: 'xstock', name: "GOLD" },
  { symbol: 'GMEX', mint: 'Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc', decimals: 8, kind: 'xstock', name: "GME" },
  { symbol: 'GOOGLX', mint: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', decimals: 8, kind: 'xstock', name: "GOOGLE" },
  { symbol: 'HOODX', mint: 'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg', decimals: 8, kind: 'xstock', name: "HOOD" },
  { symbol: 'INTCX', mint: 'XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM', decimals: 8, kind: 'xstock', name: "INTC" },
  { symbol: 'KOX', mint: 'XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ', decimals: 8, kind: 'xstock', name: "COCA COLA" },
  { symbol: 'MCDX', mint: 'XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2', decimals: 8, kind: 'xstock', name: "MCDX" },
  { symbol: 'METAX', mint: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', decimals: 8, kind: 'xstock', name: "META" },
  { symbol: 'MSFTX', mint: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', decimals: 8, kind: 'xstock', name: "MSFT" },
  { symbol: 'MSTRX', mint: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ', decimals: 8, kind: 'xstock', name: "MICROSTRATEGY" },
  { symbol: 'NVDAX', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', decimals: 8, kind: 'xstock', name: "NVIDIA" },
  { symbol: 'PLTRX', mint: 'XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4', decimals: 8, kind: 'xstock', name: "PLTR" },
  { symbol: 'QQQX', mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', decimals: 8, kind: 'xstock', name: "QQQ" },
  { symbol: 'SPCXX', mint: 'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8', decimals: 8, kind: 'xstock', name: "SPACEX" },
  { symbol: 'SPYX', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', decimals: 8, kind: 'xstock', name: "SP500" },
  { symbol: 'STRCX', mint: 'Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH', decimals: 8, kind: 'xstock', name: "STRCX" },
  { symbol: 'TSLAX', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', decimals: 8, kind: 'xstock', name: "TESLA" },
  { symbol: 'VIDAX', mint: 'XsfCC9VL4DamVGNgdJpfLXB3sBVa158Gbx8sh7NzmTk', decimals: 8, kind: 'xstock', name: "VIDAX" },
  { symbol: 'ANDURIL', mint: 'PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB', decimals: 9, kind: 'prestock', name: "ANDURIL" },
  { symbol: 'ANTHROPIC', mint: 'Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw', decimals: 9, kind: 'prestock', name: "ANTHROPIC" },
  { symbol: 'FIGUREAI', mint: 'PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd', decimals: 9, kind: 'prestock', name: "FIGUREAI" },
  { symbol: 'KALSHI', mint: 'PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua', decimals: 9, kind: 'prestock', name: "KALSHI" },
  { symbol: 'NEURALINK', mint: 'PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S', decimals: 9, kind: 'prestock', name: "NEURALINK" },
  { symbol: 'OPENAI', mint: 'PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF', decimals: 9, kind: 'prestock', name: "OPENAI" },
  { symbol: 'POLYMARKET', mint: 'Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP', decimals: 9, kind: 'prestock', name: "POLYMARKET" },
  { symbol: 'AMC', mint: 'AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc', decimals: 6, kind: 'backpack', name: "AMC" },
  { symbol: 'ARB', mint: 'ARBzQTYDCW2KnVEjs1Mc81LekB1ibVFZKbSVmorkoT9d', decimals: 8, kind: 'backpack', name: "ARB" },
  { symbol: 'DOGE', mint: 'DoGEV7LASBkQbibMc5k5vKnTZoMg423GpJ5QtJEGfm7R', decimals: 8, kind: 'backpack', name: "DOGE" },
  { symbol: 'DRAM', mint: 'DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw', decimals: 6, kind: 'backpack', name: "DRAM" },
  { symbol: 'GPRO', mint: 'GPRR2u6NS5yBQHWGauoJ9HXgjrTH8dDsrBfTV5zAYvDH', decimals: 6, kind: 'backpack', name: "GPRO" },
  { symbol: 'LIT', mint: 'EicWvteVi2fWepEzS3FYWsnuPoP6caZfjnKqNvydLjCH', decimals: 8, kind: 'backpack', name: "LIT" },
  { symbol: 'LLY', mint: 'LLYuwZ33keFihgwoxXsBawy31AiRFLFSva32TYq5TvD', decimals: 6, kind: 'backpack', name: "LLY" },
  { symbol: 'MRNA', mint: 'MRNAzXzhNcaEXJPibHEn8cd4vyekCDiivTyEwswLUCT', decimals: 6, kind: 'backpack', name: "MODERNA" },
  { symbol: 'MRVL', mint: 'MRVLSjkR2ceUBukujaD3xCyHP1H3B2SzpsNTZF546jo', decimals: 6, kind: 'backpack', name: "MRVL" },
  { symbol: 'MU', mint: 'MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1', decimals: 6, kind: 'backpack', name: "Micron" },
  { symbol: 'NBIS', mint: 'NBiSF3UaVUFtRzHwAfxyHsBCAZWGEKnMpewAE4oh7BG', decimals: 6, kind: 'backpack', name: "NBIS" },
  { symbol: 'NIKE', mint: 'NKEda5nHhNGgjrE9nDdMvaEmkmJ96qqxzBVZEcKmjSg', decimals: 6, kind: 'backpack', name: "NIKE" },
  { symbol: 'PEAQ', mint: 'PEAQjk7SRS6rXHVFFmpRr7zrC4g5ZuEebpwTxvaLr3b', decimals: 9, kind: 'backpack', name: "PEAQ" },
  { symbol: 'PONS', mint: 'poNSfquKq512ApeYjVghwViSun4x1MhCqHVH2Paq4jN', decimals: 8, kind: 'backpack', name: "PONS" },
  { symbol: 'PSG', mint: '5eyib4qghYGHNh7VvxSFGYLFJSanjq9hug9fR52kksnm', decimals: 9, kind: 'backpack', name: "PSG" },
  { symbol: 'ROBOSTRATEGY', mint: 'BoTx8y9ynfdxf5ZjWtCoBVkff52qKA82ysaLU8ZM6d8T', decimals: 6, kind: 'backpack', name: "BOT" },
  { symbol: 'SILVER', mint: 'SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L', decimals: 6, kind: 'backpack', name: "SILVER" },
  { symbol: 'SKHY', mint: 'SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3', decimals: 6, kind: 'backpack', name: "SKHYNIX" },
  { symbol: 'SNDK', mint: 'SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH', decimals: 6, kind: 'backpack', name: "SANDISK" },
  { symbol: 'TAO', mint: 'taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY', decimals: 9, kind: 'backpack', name: "Bittensor" },
  { symbol: 'TTWO', mint: 'TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo', decimals: 6, kind: 'backpack', name: "TTWO" },
  { symbol: 'KALSHI', mint: 'TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ', decimals: 9, kind: 'tessera', name: "KALSHI" },
  { symbol: 'OPENAI', mint: 'oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ', decimals: 9, kind: 'tessera', name: "OPENAI" },
  { symbol: 'XBTC', mint: '2zCo6bUowJMvr89ajxuWsPadAqJ2F9akCkxumNsSdgsL', decimals: 6, kind: 'leverage', name: "XBTC" },
  { symbol: 'xSOL', mint: '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs', decimals: 6, kind: 'leverage', name: "xSOL" },
  { symbol: 'HEEBOO', mint: 'HeeBovJNKd27tQ6xkeP1dfSyTr8LyLwhJz9wfFTbPLEX', decimals: 6, kind: 'collectible', name: "HEEBOO" },
  { symbol: 'SV151', mint: 'SV151D5pjygAKA8aJJcKzm4wFnRX5G92Fye94jQJk7g', decimals: 6, kind: 'collectible', name: "SV151" },
  { symbol: 'custom…', mint: 'custom', decimals: 0, kind: 'custom', name: "any mint with a LaunchLab config" },
];

const RAYDIUM_LAUNCHLAB_QUOTES = [
  { symbol: 'SOL',   mint: 'So11111111111111111111111111111111111111112' },
  { symbol: 'USD1',  mint: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB' },
  { symbol: 'Anon',  mint: '9McvH6w97oewLmPxqQEoHUAv3u5iYMyQ9AeZZhguYf1T' },
  { symbol: 'USDC',  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT',  mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  { symbol: 'EURC',  mint: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr' },
  { symbol: 'TRUMP', mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN' },
  { symbol: 'NVDAx (stock)',  mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' },
  { symbol: 'SPYx (stock)',   mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W' },
  { symbol: 'CRCLx (stock)',  mint: 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1' },
  { symbol: 'custom…', mint: 'custom' },
];

// Every quote token Pons lists on its own frontend (pulled from their app
// bundle), plus native ETH. Pons v2 only accepts the ones its factory has
// approved; our own v4 curve accepts anything, so for that pad this list is
// just a shortcut and `custom` takes any ERC-20.
const PONS_V2_PAIRS = [
  { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', decimals: 18 },
  { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
  { symbol: 'cbBTC', address: '0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4', decimals: 8 },
  { symbol: 'AAPL', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', decimals: 18 },
  { symbol: 'AMD', address: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC', decimals: 18 },
  { symbol: 'AMZN', address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', decimals: 18 },
  { symbol: 'BB', address: '0x48E39E56aCdbA37b09020C0b734A613C9a2f100A', decimals: 18 },
  { symbol: 'COIN', address: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b', decimals: 18 },
  { symbol: 'COST', address: '0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2', decimals: 18 },
  { symbol: 'CRCL', address: '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5', decimals: 18 },
  { symbol: 'DJT', address: '0x1D11f0496982706C5e14A514D4E79F2e6BdE4516', decimals: 18 },
  { symbol: 'GLD', address: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e', decimals: 18 },
  { symbol: 'GME', address: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E', decimals: 18 },
  { symbol: 'GOOGL', address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', decimals: 18 },
  { symbol: 'HIMS', address: '0xCceE82fE024c36fA15E1005edE3E9e4787e23D09', decimals: 18 },
  { symbol: 'META', address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', decimals: 18 },
  { symbol: 'MSFT', address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', decimals: 18 },
  { symbol: 'MSTR', address: '0xec262a75e413fAfD0dF80480274532C79D42da09', decimals: 18 },
  { symbol: 'MU', address: '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD', decimals: 18 },
  { symbol: 'NVDA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18 },
  { symbol: 'PLTR', address: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A', decimals: 18 },
  { symbol: 'QQQ', address: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', decimals: 18 },
  { symbol: 'RDDT', address: '0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C', decimals: 18 },
  { symbol: 'SNDK', address: '0xB90A19fF0Af67f7779afF50A882A9CfF42446400', decimals: 18 },
  { symbol: 'SPCX', address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', decimals: 18 },
  { symbol: 'SPY', address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', decimals: 18 },
  { symbol: 'TSLA', address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', decimals: 18 },
  { symbol: 'TTWO', address: '0x5e81213613b6B86EaB4c6c50d718d34359459786', decimals: 18 },
  { symbol: 'custom…', address: 'custom', decimals: 18 },
];

// Every quote (numeraire) long.xyz lists on Robinhood Chain, pulled from
// their app bundle: 1 stable, 6 ETFs, 33 tokenized stocks. All 18dp except
// USDG at 6dp. The 'custom' entry accepts any ERC-20 - the Airlock does not
// gate the numeraire, only the modules.
const LONG_QUOTES = [
  { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6, kind: 'stable', name: "Global Dollar" },
  { symbol: 'CUSO', address: '0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344', decimals: 18, kind: 'etf', name: "21Shares Crypto Basket" },
  { symbol: 'QQQ', address: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', decimals: 18, kind: 'etf', name: "Invesco QQQ" },
  { symbol: 'SGOV', address: '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5', decimals: 18, kind: 'etf', name: "iShares 0-3 Month Treasury Bond ETF" },
  { symbol: 'SLV', address: '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f', decimals: 18, kind: 'etf', name: "iShares Silver Trust" },
  { symbol: 'SPY', address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', decimals: 18, kind: 'etf', name: "SPDR S&P 500 ETF" },
  { symbol: 'XLK', address: '0x15Cd20759CE7F3285c29A319dE2D1A2e098c6f43', decimals: 18, kind: 'etf', name: "Technology Select Sector SPDR ETF" },
  { symbol: 'AAPL', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', decimals: 18, kind: 'stock', name: "Apple" },
  { symbol: 'AMD', address: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC', decimals: 18, kind: 'stock', name: "Advanced Micro Devices" },
  { symbol: 'AMZN', address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', decimals: 18, kind: 'stock', name: "Amazon" },
  { symbol: 'ASML', address: '0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA', decimals: 18, kind: 'stock', name: "ASML Holding" },
  { symbol: 'BABA', address: '0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4', decimals: 18, kind: 'stock', name: "Alibaba" },
  { symbol: 'BE', address: '0x822CC93fFD030293E9842c30BBD678F530701867', decimals: 18, kind: 'stock', name: "Bloom Energy" },
  { symbol: 'CCL', address: '0x9651342CeA770aE9a2969Ba2A52611523146aef9', decimals: 18, kind: 'stock', name: "Carnival" },
  { symbol: 'COIN', address: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b', decimals: 18, kind: 'stock', name: "Coinbase" },
  { symbol: 'COST', address: '0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2', decimals: 18, kind: 'stock', name: "Costco" },
  { symbol: 'CRCL', address: '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5', decimals: 18, kind: 'stock', name: "Circle" },
  { symbol: 'CRWV', address: '0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3', decimals: 18, kind: 'stock', name: "CoreWeave" },
  { symbol: 'DELL', address: '0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd', decimals: 18, kind: 'stock', name: "Dell" },
  { symbol: 'GME', address: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E', decimals: 18, kind: 'stock', name: "GameStop" },
  { symbol: 'GOOGL', address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', decimals: 18, kind: 'stock', name: "Alphabet" },
  { symbol: 'INTC', address: '0xc72b96e0E48ecd4DC75E1e45396e26300BC39681', decimals: 18, kind: 'stock', name: "Intel" },
  { symbol: 'META', address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', decimals: 18, kind: 'stock', name: "Meta" },
  { symbol: 'MSFT', address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', decimals: 18, kind: 'stock', name: "Microsoft" },
  { symbol: 'MSTR', address: '0xec262a75e413fAfD0dF80480274532C79D42da09', decimals: 18, kind: 'stock', name: "Strategy" },
  { symbol: 'MU', address: '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD', decimals: 18, kind: 'stock', name: "Micron" },
  { symbol: 'NFLX', address: '0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8', decimals: 18, kind: 'stock', name: "Netflix" },
  { symbol: 'NU', address: '0x408c14038a04f7bD235329E26d2bf569ee20e250', decimals: 18, kind: 'stock', name: "Nu Holdings" },
  { symbol: 'NVDA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18, kind: 'stock', name: "NVIDIA" },
  { symbol: 'ORCL', address: '0xb0992820E760d836549ba69BC7598b4af75dEE03', decimals: 18, kind: 'stock', name: "Oracle" },
  { symbol: 'PLTR', address: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A', decimals: 18, kind: 'stock', name: "Palantir" },
  { symbol: 'RBLX', address: '0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8', decimals: 18, kind: 'stock', name: "Roblox" },
  { symbol: 'RDDT', address: '0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C', decimals: 18, kind: 'stock', name: "Reddit" },
  { symbol: 'SNDK', address: '0xB90A19fF0Af67f7779afF50A882A9CfF42446400', decimals: 18, kind: 'stock', name: "SanDisk" },
  { symbol: 'SOFI', address: '0x98E75885157C80992A8D41b696D8c9C6Fb30A926', decimals: 18, kind: 'stock', name: "SoFi Technologies" },
  { symbol: 'SPCX', address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', decimals: 18, kind: 'stock', name: "SpaceX" },
  { symbol: 'TSLA', address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', decimals: 18, kind: 'stock', name: "Tesla" },
  { symbol: 'TSM', address: '0x58FfE4a942d3885bAa22D7520691F611EF09e7AA', decimals: 18, kind: 'stock', name: "Taiwan Semiconductor" },
  { symbol: 'UPS', address: '0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2', decimals: 18, kind: 'stock', name: "UPS" },
  { symbol: 'USAR', address: '0xd917B029C761D264c6A312BBbcDA868658eF86a6', decimals: 18, kind: 'stock', name: "USA Rare Earth" },
  { symbol: 'custom…', address: 'custom', decimals: 18, kind: 'custom', name: 'any ERC-20' },
];

// ---------------------------------------------------------------------------
// lunch.fun — a tax-token launchpad on Robinhood chain. Every launch opens a
// Uniswap v4 pool paired against a stock token (or ETH/USDG) with a buy/sell
// tax routed by their hook, and optionally a holder-reward tracker.
//
// Contract config comes from lunch.fun's own app bundle and was then checked
// against the deployed contracts. The launcher is an ERC-1967 proxy; the
// implementation behind it carries the launch entrypoints:
//
//   launchPairRewards(params)        single-asset holder rewards  <- default
//   launchPairRewardsBasket(params, basket[])   basket rewards
//   launchPair(params)               no reward tracker
//
// The params struct is NOT documented anywhere — its field meanings were
// established by simulating against the live contract and reading which named
// error each malformed field produces: supply 0 -> SupplyZero(), an unlisted
// pair -> PairNotAllowed(), tax over the cap -> SideCapExceeded(), shares that
// do not sum to 10000 -> BadSplit(), mismatched arrays -> BadSplitLength().
// The tax cap was binary-searched: 500 bps a side is accepted, 501 is not.
// ---------------------------------------------------------------------------
const LUNCH = {
  launcher: '0x6Fda94ACEEDC5a97171469a8873d00fB9983Bb8c', // v4PairLauncher (proxy)
  taxHook: '0x4Eb1976978756Bd56802d8162f2271844924e0cc',
  swapRouter: '0xCaf681a66D020601342297493863E78C959E5cb2', // SwapRouter02
  quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',     // QuoterV2
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  maxTaxBps: 500,
};

// lunch.fun pair tokens, straight from their app config. HOOD leads the list:
// it is the pairing this pad exists for, so it is the default selection.
const LUNCH_QUOTES = [
  { symbol: 'HOOD', address: '0x32aC8C1D7672667D5EbdEa22935F7B06fC8D496f', decimals: 18, kind: 'stock', name: "Robinhood (HOOD)" },
  { symbol: 'ETH', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', decimals: 18, kind: 'base', name: "Ether (WETH)" },
  { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6, kind: 'base', name: "Global Dollar" },
  { symbol: 'AAOI', address: '0x521Cf887E6531c6F667b5BC4D896E5d9bfE8EB2E', decimals: 18, kind: 'stock', name: "Applied Optoelectronics" },
  { symbol: 'AAPL', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', decimals: 18, kind: 'stock', name: "Apple" },
  { symbol: 'ABCL', address: '0x3139D77Ace0cbAA5bDfD38bD1F1911a794AF0B0e', decimals: 18, kind: 'stock', name: "Abcellera Biologics" },
  { symbol: 'ADBE', address: '0x232B8ed6377BE97813853B0Ac104c4Cda8378d1B', decimals: 18, kind: 'stock', name: "Adobe" },
  { symbol: 'AEHR', address: '0x5F604fBA1162193A4388A5DFa56F556f3E133cC2', decimals: 18, kind: 'stock', name: "Aehr" },
  { symbol: 'AEIS', address: '0xfAf9cb261B5FCC1f404Bb10CD39C5c6C1974E612', decimals: 18, kind: 'stock', name: "Advanced Energy" },
  { symbol: 'ALAB', address: '0x748c32c3ca24eDf31ea597Db1F3d330a7a6DA3Dc', decimals: 18, kind: 'stock', name: "Astera Labs, Inc." },
  { symbol: 'AMAT', address: '0x36046893810a7E7fCE501229d57dc3FC8c8716d0', decimals: 18, kind: 'stock', name: "Applied Materials" },
  { symbol: 'AMBA', address: '0x99D9D8663545151603863C5AcbD6FC3218899009', decimals: 18, kind: 'stock', name: "Ambarella" },
  { symbol: 'AMC', address: '0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B', decimals: 18, kind: 'stock', name: "AMC Entertainment" },
  { symbol: 'AMD', address: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC', decimals: 18, kind: 'stock', name: "AMD" },
  { symbol: 'AMKR', address: '0xDd356AA38F40A7b7076755aC854B6FBb1F0D305B', decimals: 18, kind: 'stock', name: "Amkor Technology" },
  { symbol: 'AMZN', address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', decimals: 18, kind: 'stock', name: "Amazon" },
  { symbol: 'ANET', address: '0x28bABD556b60E53663B8615036479a29c2CDd1Bf', decimals: 18, kind: 'stock', name: "Arista" },
  { symbol: 'APLD', address: '0xb8DBf92F9741c9ac1c32115E78581f23509916FD', decimals: 18, kind: 'stock', name: "Applied Digital" },
  { symbol: 'APP', address: '0xA249BAF1063Af884807C1E1400AEf7784836917E', decimals: 18, kind: 'stock', name: "AppLovin" },
  { symbol: 'ASML', address: '0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA', decimals: 18, kind: 'stock', name: "ASML Holding" },
  { symbol: 'ASTS', address: '0x1AF6446f07eb1d97c546AFC8c9544cBDF3AD5137', decimals: 18, kind: 'stock', name: "AST SpaceMobile" },
  { symbol: 'AUR', address: '0x373C06c4f7BDe527D7Dae4BA169E42b55E393CeD', decimals: 18, kind: 'stock', name: "Aurora Innovation" },
  { symbol: 'AVAV', address: '0xF6290b5e7C26502e2dA514C31509849718EA76A5', decimals: 18, kind: 'stock', name: "AeroVironment" },
  { symbol: 'AVGO', address: '0x156E175DD063a8cE274C50654eF40e0032b3fbcF', decimals: 18, kind: 'stock', name: "Broadcom" },
  { symbol: 'AXON', address: '0xC27dBD474aF5181c5A8777903690D8D262D12648', decimals: 18, kind: 'stock', name: "Axon" },
  { symbol: 'AXTI', address: '0x141eEa040c2250eEc0314e336975e81f85f6585e', decimals: 18, kind: 'stock', name: "AXT" },
  { symbol: 'BA', address: '0x4D21483a44Bf67a86b77E3dA301411880797D452', decimals: 18, kind: 'stock', name: "Boeing" },
  { symbol: 'BABA', address: '0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4', decimals: 18, kind: 'stock', name: "Alibaba" },
  { symbol: 'BB', address: '0x48E39E56aCdbA37b09020C0b734A613C9a2f100A', decimals: 18, kind: 'stock', name: "Blackberry" },
  { symbol: 'BE', address: '0x822CC93fFD030293E9842c30BBD678F530701867', decimals: 18, kind: 'stock', name: "Bloom Energy" },
  { symbol: 'BND', address: '0x2F62fC9fAbb470C690f141c28340eD832bB27020', decimals: 18, kind: 'stock', name: "Vanguard Total Bond Market ETF" },
  { symbol: 'BULL', address: '0xceF9027c7d6985b85f0BA431125073529A947A68', decimals: 18, kind: 'stock', name: "Webull" },
  { symbol: 'CBRS', address: '0x5c90450Bbb4273D7b2f17CF6917AEB237A569679', decimals: 18, kind: 'stock', name: "Cerebras Systems" },
  { symbol: 'CCL', address: '0x9651342CeA770aE9a2969Ba2A52611523146aef9', decimals: 18, kind: 'stock', name: "Carnival" },
  { symbol: 'CEG', address: '0xaE517A2903E68bd929Dfd15be875F8369D53e94a', decimals: 18, kind: 'stock', name: "Constellation Energy" },
  { symbol: 'CELH', address: '0x8cF07C5A878945185d327aAa6e33FAa95F95e7bF', decimals: 18, kind: 'stock', name: "Celsius" },
  { symbol: 'CIEN', address: '0x44f6D488021f8233B9416294d1FE9b1fEe28382d', decimals: 18, kind: 'stock', name: "Ciena" },
  { symbol: 'CLOV', address: '0x62200915e7DEab1eC7f79fb246daDbB80eACdDd0', decimals: 18, kind: 'stock', name: "Clover Health Investments" },
  { symbol: 'CLS', address: '0xBf449977089c718C004a66C554B26B94ef3Ad4De', decimals: 18, kind: 'stock', name: "Celestica" },
  { symbol: 'CLSK', address: '0xcBB95BBF36099d34dA091dc6Fa6F49EfA257Cee3', decimals: 18, kind: 'stock', name: "CleanSpark" },
  { symbol: 'COHR', address: '0x92F9F459F1a9a5AD266b182BE7Bffd1C6c666894', decimals: 18, kind: 'stock', name: "Coherent" },
  { symbol: 'COIN', address: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b', decimals: 18, kind: 'stock', name: "Coinbase" },
  { symbol: 'COST', address: '0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2', decimals: 18, kind: 'stock', name: "Costco" },
  { symbol: 'CRCL', address: '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5', decimals: 18, kind: 'stock', name: "Circle" },
  { symbol: 'CRDO', address: '0x4D67253bc223e6b0e104F1084c1fb2b669dDC41b', decimals: 18, kind: 'stock', name: "Credo Technology Group" },
  { symbol: 'CRM', address: '0xd95B44124e475743a7589e68F3D74008A5536D44', decimals: 18, kind: 'stock', name: "Salesforce" },
  { symbol: 'CRWD', address: '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931', decimals: 18, kind: 'stock', name: "CrowdStrike" },
  { symbol: 'CRWV', address: '0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3', decimals: 18, kind: 'stock', name: "CoreWeave" },
  { symbol: 'CSCO', address: '0xF543967EEBB6f1917992eF0E68De63ab07a5a0dA', decimals: 18, kind: 'stock', name: "Cisco Systems" },
  { symbol: 'CTSH', address: '0x63D5a3b6939a33f1e75d8Bcd85759858239600DB', decimals: 18, kind: 'stock', name: "Cognizant" },
  { symbol: 'CVNA', address: '0xa4f319104089FE321dc8093C6E707d4fE190A988', decimals: 18, kind: 'stock', name: "Carvana" },
  { symbol: 'DDOG', address: '0x27c99fBde9D0d2AA4f4Bfb4943f237843DdF6958', decimals: 18, kind: 'stock', name: "Datadog" },
  { symbol: 'DELL', address: '0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd', decimals: 18, kind: 'stock', name: "Dell" },
  { symbol: 'DJT', address: '0x1D11f0496982706C5e14A514D4E79F2e6BdE4516', decimals: 18, kind: 'stock', name: "Trump Media & Technology Group" },
  { symbol: 'DOCN', address: '0xc02f12B9fe9E707079EC0d546f3050d3F6C1F8bD', decimals: 18, kind: 'stock', name: "DigitalOcean" },
  { symbol: 'ELF', address: '0x39EC44Bee4F6A116c6F9B8De566848a985C53C60', decimals: 18, kind: 'stock', name: "e.l.f. Beauty" },
  { symbol: 'EWT', address: '0x1c690498150252222C275A5CEd69d3A6b1f52D5E', decimals: 18, kind: 'stock', name: "iShares MSCI Taiwan Capped ETF" },
  { symbol: 'EWY', address: '0x7f0aBeF0C07280F82c6a08ead09dEd6BAE2C13Fc', decimals: 18, kind: 'stock', name: "iShares MSCI South Korea" },
  { symbol: 'F', address: '0x25C288E6D899b9BC30160965aD9644c67e73bE0C', decimals: 18, kind: 'stock', name: "Ford" },
  { symbol: 'FICO', address: '0xa48F22A46C0F1C46CA7D111CB6c137c271987180', decimals: 18, kind: 'stock', name: "Fair Isaac" },
  { symbol: 'FIG', address: '0x41F4267525a8AFf329540eF24fD83d9044758B33', decimals: 18, kind: 'stock', name: "Figma" },
  { symbol: 'FISV', address: '0x9ECe29A4A2397C0a35fb5fA8EE2b9509130a98cc', decimals: 18, kind: 'stock', name: "Fiserv" },
  { symbol: 'FIX', address: '0x93Dbb1d2Dc5D63F4abACFF30485273f538Df68Ac', decimals: 18, kind: 'stock', name: "Comfort Systems" },
  { symbol: 'FLNC', address: '0x282e87451E10fA6679BC7D76C69BE44cD3fC777C', decimals: 18, kind: 'stock', name: "Fluence Energy" },
  { symbol: 'FLY', address: '0x03BC731Ffb162cdd7B98D3C6542bFC291126075d', decimals: 18, kind: 'stock', name: "Firefly Aerospace Inc." },
  { symbol: 'FTNT', address: '0x3FB8976980d486084b2eb4a404BD12e72823958f', decimals: 18, kind: 'stock', name: "Fortinet" },
  { symbol: 'FUTU', address: '0xeB30663bDFf0622Ef4e4E5cBb4E975F19f33f51D', decimals: 18, kind: 'stock', name: "Futu Holdings" },
  { symbol: 'GE', address: '0x63b814DDBd6BF339f25Fed8c36158a008D5B373e', decimals: 18, kind: 'stock', name: "General Electric" },
  { symbol: 'GEV', address: '0x94B8AAE43A1cCc08Aa64B7D1F29b4D920aF4a0C9', decimals: 18, kind: 'stock', name: "GE Vernova" },
  { symbol: 'GLD', address: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e', decimals: 18, kind: 'stock', name: "SPDR Gold Trust" },
  { symbol: 'GLW', address: '0x7c04E6A3368F2A1DE3874f0e80d2e0A1a9915da6', decimals: 18, kind: 'stock', name: "Corning" },
  { symbol: 'GLXY', address: '0x2D427692E928fa156ec22acfaBaFA0447C5805B7', decimals: 18, kind: 'stock', name: "Galaxy Digital Inc." },
  { symbol: 'GME', address: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E', decimals: 18, kind: 'stock', name: "GameStop" },
  { symbol: 'GOOGL', address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', decimals: 18, kind: 'stock', name: "Alphabet" },
  { symbol: 'HII', address: '0xEB61c0Ed490A367d4E3631cCf8a74B3bfc7E775D', decimals: 18, kind: 'stock', name: "Huntington Ingalls" },
  { symbol: 'HIMS', address: '0xCceE82fE024c36fA15E1005edE3E9e4787e23D09', decimals: 18, kind: 'stock', name: "Hims & Hers Health" },
  { symbol: 'HPE', address: '0x59dd09d4900C2E4B5F75b7c0d4E6796fcc234Cb1', decimals: 18, kind: 'stock', name: "HP Enterprise" },
  { symbol: 'HWM', address: '0xAEa445c5F3DB1a462998ccC422A875A361ee5d99', decimals: 18, kind: 'stock', name: "Howmet Aerospace" },
  { symbol: 'IBM', address: '0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619', decimals: 18, kind: 'stock', name: "IBM" },
  { symbol: 'IBRX', address: '0x7c148F74ac7445D1F28366b7FcDC6792a9Fcd0Cf', decimals: 18, kind: 'stock', name: "ImmunityBio," },
  { symbol: 'INDA', address: '0xACEF2e09adb47aD6aBeBAD9fF06689E60615C2B6', decimals: 18, kind: 'stock', name: "iShares MSCI India ETF" },
  { symbol: 'INFQ', address: '0xB853bC83a753342a4f8320ea680b4B1E84118D21', decimals: 18, kind: 'stock', name: "Infleqtion" },
  { symbol: 'INOD', address: '0xf1953DAB6FaD537488d5A022361FfAa8B4c95eC6', decimals: 18, kind: 'stock', name: "Innodata" },
  { symbol: 'INTC', address: '0xc72b96e0E48ecd4DC75E1e45396e26300BC39681', decimals: 18, kind: 'stock', name: "Intel" },
  { symbol: 'INTU', address: '0x56d23beE5f41A7120170b0c603Dae30128e460e9', decimals: 18, kind: 'stock', name: "Intuit" },
  { symbol: 'IONQ', address: '0x558378E000D634A36593E338eBacdd6207640EfE', decimals: 18, kind: 'stock', name: "IonQ" },
  { symbol: 'IREN', address: '0xF0AB0c93bE6F41369d302e55db1A96b3c430212D', decimals: 18, kind: 'stock', name: "IREN" },
  { symbol: 'JBL', address: '0xEAf2512dFC1bEAc608F8794B3793CD4E02894Aa6', decimals: 18, kind: 'stock', name: "Jabil Inc." },
  { symbol: 'JNJ', address: '0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80', decimals: 18, kind: 'stock', name: "Johnson & Johnson" },
  { symbol: 'JOBY', address: '0xb334C5cE741B80B5B671F47F5C269Cb193fe8E24', decimals: 18, kind: 'stock', name: "Joby Aviation" },
  { symbol: 'KLAC', address: '0x96b933C74eCB4A0926b9210cef7b743EF46be2E9', decimals: 18, kind: 'stock', name: "KLA" },
  { symbol: 'KSS', address: '0x12e3c047bf9AeCAF9dDC98c05C31BFD1dd043993', decimals: 18, kind: 'stock', name: "Kohls Corporation" },
  { symbol: 'KTOS', address: '0x7FD06a4d81cCfA3F351394E144d5191874C31313', decimals: 18, kind: 'stock', name: "Kratos Defense & Security Solutions" },
  { symbol: 'LHX', address: '0x48d60243c66437c6ac3c2495Be94747aEd5Dfe25', decimals: 18, kind: 'stock', name: "L3Harris" },
  { symbol: 'LITE', address: '0x8eF20885F94e3D9bc7eB3080279188Bd5ED7c08C', decimals: 18, kind: 'stock', name: "Lumentum" },
  { symbol: 'LLY', address: '0x8005d266423c7ea827372c9c864491e5786600ea', decimals: 18, kind: 'stock', name: "Eli Lilly" },
  { symbol: 'LMT', address: '0x329fcACEb9AD6F9580DD5F643fed0646900D043c', decimals: 18, kind: 'stock', name: "Lockheed" },
  { symbol: 'LRCX', address: '0x57b0030166DB0C31690d1A5aA167e2e26e2C29a4', decimals: 18, kind: 'stock', name: "Lam Research Corp" },
  { symbol: 'LULU', address: '0x4e62068525Ab11FE768e29dfD00ef909B9803016', decimals: 18, kind: 'stock', name: "Lululemon" },
  { symbol: 'LUNR', address: '0xa5D4968421bA94814Be3B136b15cf422101aC1a3', decimals: 18, kind: 'stock', name: "Intuitive Machines" },
  { symbol: 'MDB', address: '0xDdf2266b79abf0B48898959B0ed6E6adf512be74', decimals: 18, kind: 'stock', name: "MongoDB" },
  { symbol: 'META', address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', decimals: 18, kind: 'stock', name: "Meta Platforms" },
  { symbol: 'MOD', address: '0xc6Cbad1016b38B797610c25E1dc7D95988B1f362', decimals: 18, kind: 'stock', name: "Modine" },
  { symbol: 'MPWR', address: '0x52D50D0280AD1054b43f052bD70a49a212A1b128', decimals: 18, kind: 'stock', name: "Monolithic Power Systems" },
  { symbol: 'MRNA', address: '0x43B07D15cE533bEc5476d70C22a78a1B2B662155', decimals: 18, kind: 'stock', name: "Moderna" },
  { symbol: 'MRVL', address: '0x62fd0668e10D8B72339BE2DCF7643001688ff13B', decimals: 18, kind: 'stock', name: "Marvell" },
  { symbol: 'MSFT', address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', decimals: 18, kind: 'stock', name: "Microsoft" },
  { symbol: 'MSTR', address: '0xec262a75e413fAfD0dF80480274532C79D42da09', decimals: 18, kind: 'stock', name: "Strategy" },
  { symbol: 'MTSI', address: '0xC93f4d80e268AB922e871bd169156C3CC41894e6', decimals: 18, kind: 'stock', name: "MACOM" },
  { symbol: 'MU', address: '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD', decimals: 18, kind: 'stock', name: "Micron" },
  { symbol: 'MXL', address: '0x48961813349333209994750ffA89b3c5C22eC969', decimals: 18, kind: 'stock', name: "MaxLinear" },
  { symbol: 'NAVN', address: '0xf7181b63Fdb858558A74ba96BC42732684cd7965', decimals: 18, kind: 'stock', name: "Navan" },
  { symbol: 'NBIS', address: '0x9D9c6684F596F66a64C030B93A886D51Fd4D7931', decimals: 18, kind: 'stock', name: "Nebius Group" },
  { symbol: 'NET', address: '0x116F00968269B7bfbaD4109cE591d6E74c0601d4', decimals: 18, kind: 'stock', name: "Cloudflare" },
  { symbol: 'NFLX', address: '0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8', decimals: 18, kind: 'stock', name: "Netflix" },
  { symbol: 'NNE', address: '0xBEF75684C43c4ea7BD18Dd532a2244674Ee8b926', decimals: 18, kind: 'stock', name: "Nano Nuclear Energy" },
  { symbol: 'NOW', address: '0x0C3260aF4B8f13a69c4c2dFb84fD667890CDFa14', decimals: 18, kind: 'stock', name: "ServiceNow" },
  { symbol: 'NU', address: '0x408c14038a04f7bD235329E26d2bf569ee20e250', decimals: 18, kind: 'stock', name: "Nu Holdings" },
  { symbol: 'NVDA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18, kind: 'stock', name: "NVIDIA" },
  { symbol: 'NVTS', address: '0xbE6702d7b70315376dC48a3293f24f0982F86386', decimals: 18, kind: 'stock', name: "Navitas Semiconductor" },
  { symbol: 'OKLO', address: '0x8B2f88497f15A18E9D4FFa1a8fFB8538399aE774', decimals: 18, kind: 'stock', name: "Oklo" },
  { symbol: 'ON', address: '0xbBD09F72b025360FeE5C928053Dca6248d35be54', decimals: 18, kind: 'stock', name: "ON Semiconductor" },
  { symbol: 'ONTO', address: '0x8ff63eAeEe3fE54Ba450c4F5538064Ec5A893Aef', decimals: 18, kind: 'stock', name: "Onto Innovation" },
  { symbol: 'ORCL', address: '0xb0992820E760d836549ba69BC7598b4af75dEE03', decimals: 18, kind: 'stock', name: "Oracle" },
  { symbol: 'OUST', address: '0x40E7a279850e443f582059ae5dC1c3b6563E6395', decimals: 18, kind: 'stock', name: "Ouster" },
  { symbol: 'P', address: '0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D', decimals: 18, kind: 'stock', name: "Everpure" },
  { symbol: 'PANW', address: '0xB039597eD45CBa7B6E2fb9E8BE51802969CEe5Be', decimals: 18, kind: 'stock', name: "Palo Alto Networks" },
  { symbol: 'PATH', address: '0xfb2664f07B6Aadd29ea7a59D8859b1AeB8645cDa', decimals: 18, kind: 'stock', name: "UiPath" },
  { symbol: 'PENG', address: '0x9b23573b156B52565012F5cE02CDF60AFBaa70Be', decimals: 18, kind: 'stock', name: "Penguin Solutions" },
  { symbol: 'PFE', address: '0x7066A64c24e4206CD62E83bf198c1E7EB361F51e', decimals: 18, kind: 'stock', name: "Pfizer" },
  { symbol: 'PL', address: '0xAA4d64474c172010aB57719cb9951E6142a100d3', decimals: 18, kind: 'stock', name: "Planet Labs" },
  { symbol: 'PLTR', address: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A', decimals: 18, kind: 'stock', name: "Palantir" },
  { symbol: 'POET', address: '0xcf6B2D875361be807EAfa57458c80f28521F9333', decimals: 18, kind: 'stock', name: "POET Technologies" },
  { symbol: 'POWL', address: '0x237c16D66590F67B886d978ACD362EAeaD8B18c7', decimals: 18, kind: 'stock', name: "Powell Industries" },
  { symbol: 'PR', address: '0x4189F0c66EBBB0bfeF1C31f763131361EF32f77C', decimals: 18, kind: 'stock', name: "Permian Resources" },
  { symbol: 'PWR', address: '0x9Ab02Ead789b6903c3c44d0ED32F9c707CDF12FD', decimals: 18, kind: 'stock', name: "Quanta" },
  { symbol: 'QBTS', address: '0xC583c60aeF9Dc401Da72cEC1B404743a93cea1Cc', decimals: 18, kind: 'stock', name: "D-Wave Quantum" },
  { symbol: 'QCOM', address: '0x0f17206447090e464C277571124dD2688E48AEA9', decimals: 18, kind: 'stock', name: "Qualcomm" },
  { symbol: 'QQQ', address: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', decimals: 18, kind: 'stock', name: "Invesco QQQ" },
  { symbol: 'QUBT', address: '0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4', decimals: 18, kind: 'stock', name: "Quantum Computing" },
  { symbol: 'RBLX', address: '0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8', decimals: 18, kind: 'stock', name: "Roblox" },
  { symbol: 'RCAT', address: '0xFDE6b5d9BB419B10C23268c74e369AbFF39C0460', decimals: 18, kind: 'stock', name: "Red Cat" },
  { symbol: 'RDDT', address: '0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C', decimals: 18, kind: 'stock', name: "Reddit" },
  { symbol: 'RDW', address: '0x92Ef19E82bD8fF36661DE838D5eaE7e5CEF0EfFE', decimals: 18, kind: 'stock', name: "Redwire" },
  { symbol: 'RGTI', address: '0x284358abc07F9359f19f4b5b4aC91901Be2597Ba', decimals: 18, kind: 'stock', name: "Rigetti Computing" },
  { symbol: 'RIVN', address: '0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B', decimals: 18, kind: 'stock', name: "Rivian" },
  { symbol: 'RKLB', address: '0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2', decimals: 18, kind: 'stock', name: "Rocket Lab" },
  { symbol: 'RUN', address: '0x756Bc80af765C82da966a788858d65aDF14f3793', decimals: 18, kind: 'stock', name: "Sunrun" },
  { symbol: 'SATS', address: '0x95052ddcd5DC25641657424A8Cf04834997E1730', decimals: 18, kind: 'stock', name: "EchoStar" },
  { symbol: 'SCHD', address: '0xd63ABB2C13d7a8421a8017a712802053568e3C1D', decimals: 18, kind: 'stock', name: "Schwab US Dividend Equity ETF" },
  { symbol: 'SGOV', address: '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5', decimals: 18, kind: 'stock', name: "iShares 0-3M Treasury" },
  { symbol: 'SHOP', address: '0xF53F66751B1Eff985311b693531E3290F600c410', decimals: 18, kind: 'stock', name: "Shopify" },
  { symbol: 'SHY', address: '0xBE274710Bf3d9567e1B290eF6a5F9f90ca016FD8', decimals: 18, kind: 'stock', name: "iShares 1-3 Year Treasury Bond ETF" },
  { symbol: 'SIMO', address: '0x77E655E37F4d913fB9540e0d541D824171a60e81', decimals: 18, kind: 'stock', name: "Silicon Motion" },
  { symbol: 'SKHY', address: '0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8', decimals: 18, kind: 'stock', name: "SK hynix" },
  { symbol: 'SLS', address: '0x285b231728c7E4333799183DF1094d775246a535', decimals: 18, kind: 'stock', name: "SELLAS Life Sciences" },
  { symbol: 'SLV', address: '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f', decimals: 18, kind: 'stock', name: "iShares Silver Trust" },
  { symbol: 'SMCI', address: '0xc01aA1fECeC0605b13bc84874ff7256C0f5F562a', decimals: 18, kind: 'stock', name: "Super Micro Computer" },
  { symbol: 'SMH', address: '0x072f979c2CAc8e1391B0162a87Fee094bF8744a0', decimals: 18, kind: 'stock', name: "VanEck Semiconductor ETF" },
  { symbol: 'SMR', address: '0x1Eebee7F74517e0279dFb09d25B0407bEEc3FDd6', decimals: 18, kind: 'stock', name: "NuScale Power" },
  { symbol: 'SNAP', address: '0xF6589F11Bc40b669e584073F428B05562F568733', decimals: 18, kind: 'stock', name: "Snap" },
  { symbol: 'SNDK', address: '0xB90A19fF0Af67f7779afF50A882A9CfF42446400', decimals: 18, kind: 'stock', name: "Sandisk" },
  { symbol: 'SNOW', address: '0xBa0CAB75495255d0cB58E22B648bFED4ECD1F47E', decimals: 18, kind: 'stock', name: "Snowflake" },
  { symbol: 'SOFI', address: '0x98E75885157C80992A8D41b696D8c9C6Fb30A926', decimals: 18, kind: 'stock', name: "SoFi" },
  { symbol: 'SOUN', address: '0x6E3Dfd9f7e1649BaA14D25cac18C94d62dB10A54', decimals: 18, kind: 'stock', name: "SoundHound AI" },
  { symbol: 'SOXX', address: '0x75742c18BC1f1C5c5f448f4C9D9C6F66dafAAa38', decimals: 18, kind: 'stock', name: "iShares Semiconductor ETF" },
  { symbol: 'SPCX', address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', decimals: 18, kind: 'stock', name: "SpaceX" },
  { symbol: 'SPMO', address: '0xAd622320e520de39e72d41EF07438C3Fd3354875', decimals: 18, kind: 'stock', name: "Invesco S&P 500 Momentum" },
  { symbol: 'SPY', address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', decimals: 18, kind: 'stock', name: "SPDR S&P 500" },
  { symbol: 'TE', address: '0xb1969f6604CA1AE7a2cD3F1827876e914594CA2D', decimals: 18, kind: 'stock', name: "T1 Energy" },
  { symbol: 'TEAM', address: '0x5B97476b922F3305131B8f0B9D333172E87f4aaE', decimals: 18, kind: 'stock', name: "Atlassian Corporation" },
  { symbol: 'TEM', address: '0xB1CC0EC7Db69Cf43539119814df40071b9d61793', decimals: 18, kind: 'stock', name: "Tempus AI" },
  { symbol: 'TER', address: '0x2778C5024D5cA2CdB0f8eAD671ffc69963AdCD9C', decimals: 18, kind: 'stock', name: "Teradyne" },
  { symbol: 'TSEM', address: '0x89776d4Cd68193597A2fC132cfaC1fDe36CCeA8a', decimals: 18, kind: 'stock', name: "Tower Semiconductor" },
  { symbol: 'TSLA', address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', decimals: 18, kind: 'stock', name: "Tesla" },
  { symbol: 'TSM', address: '0x58FfE4a942d3885bAa22D7520691F611EF09e7AA', decimals: 18, kind: 'stock', name: "Taiwan Semiconductor" },
  { symbol: 'TTD', address: '0x0b5fb4031cae9163db10B169Ee72685F0EdC8545', decimals: 18, kind: 'stock', name: "Trade Desk" },
  { symbol: 'TTWO', address: '0x5e81213613b6B86EaB4c6c50d718d34359459786', decimals: 18, kind: 'stock', name: "Take-Two Interactive" },
  { symbol: 'UMC', address: '0x0E6e67Ba88e7b5d9B67636A215c76779B948dE79', decimals: 18, kind: 'stock', name: "United Microelectronics" },
  { symbol: 'UNH', address: '0xcF364ea52787e289De6F32077834056E3E70D6A8', decimals: 18, kind: 'stock', name: "UnitedHealth" },
  { symbol: 'UPS', address: '0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2', decimals: 18, kind: 'stock', name: "UPS" },
  { symbol: 'USAR', address: '0xd917B029C761D264c6A312BBbcDA868658eF86a6', decimals: 18, kind: 'stock', name: "USA Rare Earth" },
  { symbol: 'USO', address: '0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344', decimals: 18, kind: 'stock', name: "US Oil Fund" },
  { symbol: 'VICR', address: '0x6006ed4B2F94110851ff7509D97D034f0EeD9226', decimals: 18, kind: 'stock', name: "Vicor" },
  { symbol: 'VRT', address: '0xFA78C12E6488814A0262E4e802749a4a737d5fB7', decimals: 18, kind: 'stock', name: "Vertiv" },
  { symbol: 'VSAT', address: '0x26dCbfb34FC83CAbD6990f449674efDc6097fF85', decimals: 18, kind: 'stock', name: "ViaSat" },
  { symbol: 'VST', address: '0x561e2a49212b7cCF47f2744Ccb83e200722fADBc', decimals: 18, kind: 'stock', name: "Vistra" },
  { symbol: 'VTI', address: '0x0594134DF3f171a354D9C85eBD65b7A6148F6D09', decimals: 18, kind: 'stock', name: "Vanguard Morningstar Total Stock Market ETF" },
  { symbol: 'WDAY', address: '0x82DA4646242e1D962e96e932269Dc644c94a9CaA', decimals: 18, kind: 'stock', name: "Workday" },
  { symbol: 'WDC', address: '0xF52597345A8Edf418bc4071b4a35112472277D3e', decimals: 18, kind: 'stock', name: "Western Digital" },
  { symbol: 'WULF', address: '0x348Be1A8663f15edDe5CDf8A96BB69078f7aB6Fd', decimals: 18, kind: 'stock', name: "TeraWulf" },
  { symbol: 'WYFI', address: '0x9e7ABD3C9139D14E4c86DcE0e455AAB7A0C2FB3E', decimals: 18, kind: 'stock', name: "WhiteFiber, Inc." },
  { symbol: 'XLK', address: '0x15Cd20759CE7F3285c29A319dE2D1A2e098c6f43', decimals: 18, kind: 'stock', name: "Technology Select SPDR" },
  { symbol: 'XNDU', address: '0xA8eB3BCcbf2017eE7CBfb652eB51CF2E1B153289', decimals: 18, kind: 'stock', name: "Xanadu Quantum" },
  { symbol: 'XOM', address: '0xf9B46d3D1B22199D4D1025a9cEDB540A33F1a2d5', decimals: 18, kind: 'stock', name: "ExxonMobil" },
  { symbol: 'ZM', address: '0x44c4F142009036cF477eD2d09932051843137CF1', decimals: 18, kind: 'stock', name: "Zoom" },
  { symbol: 'ZS', address: '0x7dc013eB55e436f30d7ED1AFE4E36d6e45e3c3f7', decimals: 18, kind: 'stock', name: "Zscaler" },
];

// The 12 fields the launcher takes, in order. Shared by all three entrypoints;
// the basket variant appends a (token, weightBps, path)[] on the end.
const LUNCH_PARAMS = [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
  { name: 'supply', type: 'uint256' }, { name: 'pairToken', type: 'address' },
  { name: 'buyTaxBps', type: 'uint16' }, { name: 'sellTaxBps', type: 'uint16' },
  { name: 'taxRecipients', type: 'address[]' }, { name: 'taxShares', type: 'uint16[]' },
  { name: 'rewardBps', type: 'uint16' }, { name: 'devBuyPath', type: 'bytes' },
  { name: 'devBuyAmount', type: 'uint256' }, { name: 'referrer', type: 'address' },
];
const LUNCH_BASKET = { name: 'basket', type: 'tuple[]', components: [
  { name: 'token', type: 'address' }, { name: 'weightBps', type: 'uint16' }, { name: 'path', type: 'bytes' },
] };
const LUNCH_ABI = [
  { type: 'function', name: 'launchPairRewards', stateMutability: 'nonpayable', outputs: [{ type: 'address' }],
    inputs: [{ name: 'p', type: 'tuple', components: LUNCH_PARAMS }] },
  { type: 'function', name: 'launchPairRewardsBasket', stateMutability: 'nonpayable', outputs: [{ type: 'address' }],
    inputs: [{ name: 'p', type: 'tuple', components: [...LUNCH_PARAMS, LUNCH_BASKET] }] },
  { type: 'function', name: 'pairAllowed', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'pairMagnitude', inputs: [{ type: 'address' }], outputs: [{ type: 'int24' }], stateMutability: 'view' },
  { type: 'error', name: 'PairNotAllowed', inputs: [] },
  { type: 'error', name: 'SideCapExceeded', inputs: [] },
  { type: 'error', name: 'BadSplit', inputs: [] },
  { type: 'error', name: 'BadSplitLength', inputs: [] },
  { type: 'error', name: 'BadBasket', inputs: [] },
  { type: 'error', name: 'SupplyZero', inputs: [] },
  { type: 'error', name: 'SupplyTooLarge', inputs: [] },
  { type: 'error', name: 'PairMagnitudeUnset', inputs: [] },
  { type: 'error', name: 'BadDevBuyPath', inputs: [] },
  { type: 'error', name: 'BadLiquidity', inputs: [] },
];
// SwapRouter02 + QuoterV2, used to buy the pair token with ETH from inside the
// launch form. Multi-hop only: the direct WETH pools for these stock tokens are
// empty, the live route is WETH -> USDG -> stock.
const LUNCH_SWAP_ABI = [
  { type: 'function', name: 'exactInput', stateMutability: 'payable', outputs: [{ name: 'amountOut', type: 'uint256' }],
    inputs: [{ name: 'p', type: 'tuple', components: [
      { name: 'path', type: 'bytes' }, { name: 'recipient', type: 'address' },
      { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }] }] },
];
const LUNCH_QUOTER_ABI = [
  { type: 'function', name: 'quoteExactInput', stateMutability: 'nonpayable',
    inputs: [{ name: 'path', type: 'bytes' }, { name: 'amountIn', type: 'uint256' }],
    outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'sqrtAfter', type: 'uint160[]' },
              { name: 'ticksCrossed', type: 'uint32[]' }, { name: 'gasEstimate', type: 'uint256' }] },
];

const PADS = [
  {
    // our own factory — contracts/LaunchFactory.sol, deployed 2026-07-12.
    // factory is also the locker (claimFees lives on it). 100% fees ->
    // protocol wallet 0xbE8a…04dA, owner = deployer, 0 launch fee, any supply.
    // NOTE: plain-token version (no max-wallet cap). The 2% cap build (0x5251)
    // is retired — reverted per request; plain tokens read cleaner on scanners.
    id: 'ours-robinhood', label: 'Ours · Robinhood', vm: 'evm', enabled: true,
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: '0x159331ec96486EC926403e504E6FCf217d6008AB',
    locker: '0x159331ec96486EC926403e504E6FCf217d6008AB',
    claimFn: 'claimFees', startBlock: 8242608n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://robinhoodchain.blockscout.com/token/${t}`,
    nativeSymbol: 'ETH',
    curve: OUR_CURVE, customSupply: true,
  },
  {
    id: 'robinfun-robinhood', label: 'RobinFun · Robinhood', vm: 'evm', enabled: true,
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: '0x52453b4289a6c3a70bb8b4682bcd3d8731267e28',
    locker: '0x173d8370B4F67535D406F2F46168ec48aa03d26E',
    claimFn: 'claimFees', startBlock: 8147000n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://robinfun.live/token/${t}`,
    nativeSymbol: 'ETH',
    curve: ROBINHOOD_CURVE,
  },
  {
    id: 'noxa-robinhood', label: 'Noxa · Robinhood', vm: 'evm', enabled: true,
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: '0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB',
    locker: '0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85',
    claimFn: 'collectFees', startBlock: 61688n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://fun.noxa.fi/robinhood/token/${t}`,
    nativeSymbol: 'ETH',
    curve: ROBINHOOD_CURVE,
  },
  {
    // Pons v2 — on ROBINHOOD CHAIN (4663), not Ethereum. As of 2026-07-30 only the
    // first pieces are live + verified: Meme Hook 0x8e99D200…c3a044 and Fee Escrow
    // 0xbc39B650…2A0A9c (escrow set below). The FACTORY (launch entry point) is NOT
    // deployed yet — escrow.factory() reverts and the docs say "factory, bonding
    // curves, launch tokens… still to come". Also unaudited (3 audits in progress).
    // To go live once the factory ships: set factory (+ locker), confirm the
    // launchConfigId/pairToken, diff PONS_FACTORY_ABI vs the verified ABI, set
    // startBlock, then enabled: true.
    // Pons v1 — the live launchpad (v2 is currently turned off). PonsLaunchFactory,
    // verified. launchToken(params, launchConfigId, dexId, salt) → direct DEX launch
    // paired vs WETH (config 0). Tickers can be arbitrarily long. See launchPonsV1().
    id: 'pons-v1', label: 'Pons', vm: 'evm', enabled: true, family: 'pons-v1',
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB', // PonsLaunchFactory v1 (verified, live)
    locker: '0x736D76699C26D0d966744cAe304C000d471f7F35',  // PonsLaunchLocker (fees route here)
    claimFn: 'collectFees',
    launchConfigId: 0n, dexId: 0n,                          // only config 0 (pairs vs WETH)
    startBlock: 23011563n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://robinhoodchain.blockscout.com/token/${t}`,
    nativeSymbol: 'ETH',
    curve: { supply: 1e9 }, // config-0 supply (1e9 tokens) — for %-based distributions
  },
  {
    // Pons v2 — re-enabled on a new PonsV2LaunchFactory. Bonding-curve launchpad:
    // launchToken(params{…,salt}, launchConfigId, pairToken, snipeTaxExemptions[])
    // -> (token, curve). Pairs vs an approved stock (NVDA/AAPL/GME). Fees accrue in
    // the fee escrow. See launchPonsV2().
    id: 'pons-v2', label: 'Pons v2', vm: 'evm', enabled: true, family: 'pons-v2',
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', // PonsV2LaunchFactory (verified, live)
    escrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',  // PonsV2FeeEscrow (new)
    launchConfigId: 0n, creatorTaxBps: 0, buybackEnabled: false,
    startBlock: 23011563n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://robinhoodchain.blockscout.com/token/${t}`,
    nativeSymbol: 'ETH', curve: null,
    // ETH (native, 0x0) is a real distinct pair on this factory; stocks are approved
    // ERC-20 pairs. `custom` = paste any approved pair address.
    pairToken: '0x0000000000000000000000000000000000000000', // default: native ETH
    // every currently-approved pair token (verified live from the factory's
    // PairTokenApprovalUpdated events + approvedPairTokens state, 2026-08). ETH is a
    // distinct native pair; USDG is 6-decimals (handled dynamically at launch).
    quotes: PONS_V2_PAIRS,
  },
  {
    // Pools — open-to-everyone launchpad on Robinhood chain (Uniswap v4). Launch =
    // LiquidityLauncher.createToken (mint 1B, image stored as IPFS in tokenData) then
    // distributeToken (all supply single-sided into a v4 pool via the strategy). Free,
    // no seeded liquidity. Optional dev buy = a swap on the pool after. See launchPools().
    id: 'pools', label: 'Pools', vm: 'evm', enabled: true, family: 'pools',
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    launcher: '0x0000ffffbe8efe702c8703ae3477ff5de3d319c0', // canonical LiquidityLauncher (Axiom + gmgn both label "pools")
    uercFactory: '0x000000e200088D55C39a11F609E5F667729ad49b', // UERC20Factory
    strategy: '0x23f8209572b4a1C2AD88A42749E830791Fb027f1',   // opens the tickSpacing-25 pool the terminals recognize as "pools"
    router: '0x65050A9b7E5075A2bA5cED7b1b64EE66262c40Dc',     // swap router (dev buy)
    feeNft: '0x587d2fdddf14f6f84022b51e8c3a473eb88c4544',     // "Fee Beneficiary" NFT (id == LP position id)
    feeHolder: '0x7198c32a497c09497e04c86cf8f77a244a9e4b8f',  // holds positions; collectFees(uint256[]) claims your 0.25% swap fees
    startBlock: 28000000n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://robinhoodchain.blockscout.com/token/${t}`,
    nativeSymbol: 'ETH', curve: { supply: 1e9 },
  },
  {
    // Rialto · Robinhood — pair your token against a stock/ETF (NVDA, SPCX, …)
    // or WETH/USDG. Addresses from GET https://varo.rialto.xyz/api/v1/config.
    // Permissioned: launches are Rialto-signed intents — see launchRialto().
    id: 'rialto-robinhood', label: 'Rialto · Stocks', vm: 'evm', enabled: true, family: 'rialto',
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    executor: '0x1FaE6f162355cF77Bf7f23cb919130962dAd4Ecb',   // intent executor (tx target)
    launchpad: '0x851153fe84239C2dC55fa191aC2f099e20a6d0b8',
    configUrl: `${RIALTO_API}/config`,
    startBlock: 20800000n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://varo.rialto.xyz/launches/${t}`,
    nativeSymbol: 'ETH',
    curve: null,                 // economics are server-computed per quote token
    quoteToken: null,            // chosen from the pair-token dropdown (config.quotes)
  },
  {
    // Uniswap V2 on Ethereum mainnet — deploy a fixed-supply, non-mintable token,
    // pool it against ETH, and burn the LP. No bonding curve. See launchUniswap().
    id: 'uniswap-eth', label: 'Uniswap · ETH', vm: 'evm', enabled: true, family: 'uniswap',
    chainId: 1, rpc: UNISWAP_CHAINS[1].rpc,
    explorer: UNISWAP_CHAINS[1].explorer,
    site: (t) => `https://etherscan.io/token/${t}`,
    nativeSymbol: 'ETH',
    customSupply: true, curve: null,
  },
  {
    // DYORswap V3 launchpad on ARC (Circle's chain, USDC-native). Fixed-supply
    // immutable token, full supply into a Uniswap V3 pool vs USDC, LP NFT locked
    // in an immutable vault. API-driven — see launchDyorswap(). Dev buy is in USDC.
    id: 'dyorswap-arc', label: 'DYOR · ARC', vm: 'evm', enabled: true, family: 'dyorswap',
    chainId: 5042, rpc: 'https://rpc.blockdaemon.mainnet.arc.io',
    api: DYOR_ARC_API,
    explorer: 'https://arc-mainnet.cloud.blockscout.com',
    site: (t) => `https://arc-mainnet.cloud.blockscout.com/token/${t}`,
    nativeSymbol: 'USDC',
  },
  {
    // o1 · Base — launches EXACTLY the way launch.o1.exchange does: through the
    // B20LaunchpadFactory (createLaunch), which mints the B20 token AND opens a
    // Uniswap-v4 pool vs ETH from a fixed 1B supply. You get an allocation (default
    // 200M); the rest is seeded into the pool. Socials go in metadataKeys/Values.
    // (The old build called the raw B20 precompile, so tokens never appeared on o1.)
    id: 'o1-base', label: 'o1 · Base (B20)', vm: 'evm', enabled: true, family: 'b20',
    chainId: 8453, rpc: 'https://mainnet.base.org',
    launchpad: '0xa52ad458ce0282a971ecc71c051a32f28946bb9f', // B20LaunchpadFactory (verified)
    explorer: 'https://basescan.org',
    site: (t) => `https://launch.o1.exchange/token/${t}`,
    nativeSymbol: 'ETH',
    customSupply: true, defaultSupply: 1_000_000_000, curve: null, // fixed 1B launch supply
  },
  {
    // flap.sh · Robinhood — Portal.newTokenV6 tax token (V3). Bonding curve with a
    // configurable buy/sell tax that splits into market / burn / dividend / LP. The
    // token address must be vanity (ends 7777) — mined client-side. See launchFlap().
    id: 'flap-robinhood', label: 'flap · Robinhood', vm: 'evm', enabled: true, family: 'flap',
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    portal: '0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09',
    cloneImpl: '0x7777c8743c88b3aff3cf262135bef2c8b2e83333', // V6 tax-token clone base
    startBlock: 0n,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://flap.sh/robinhood/token/${t}`,
    nativeSymbol: 'ETH', curve: null,
    // stock quote tokens flap allows on Robinhood (native + tokenized equities)
    quotes: [
      { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000' },
      { symbol: 'NVDA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' },
      { symbol: 'AAPL', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' },
      { symbol: 'GME', address: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E' },
    ],
  },
  {
    // flap.sh · BNB — same Portal.newTokenV6 on BSC mainnet. Quote against BNB/USDT.
    // BSC clone impl per flap docs; simulate-first guards a wrong vanity derivation.
    id: 'flap-bnb', label: 'flap · BNB', vm: 'evm', enabled: true, family: 'flap',
    chainId: 56, rpc: 'https://bsc-dataseed.bnbchain.org',
    portal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',
    cloneImpl: '0x024f18294970B5c76c0691b87f138A0317156422', // BSC tax-token clone base (flap docs)
    swapRegistry: '0x644A8f560138418bAD4EdEFC7c17878a3c2fBEB6',
    startBlock: 0n,
    explorer: 'https://bscscan.com',
    site: (t) => `https://flap.sh/token/${t}`,
    nativeSymbol: 'BNB', curve: null,
    // flap payment tokens on BNB (addresses confirmed on-chain). CRYPTO + RWA
    // (tokenized equities). 'custom…' lets you paste any other flap payment token.
    quotes: [
      { symbol: 'BNB',   address: '0x0000000000000000000000000000000000000000' },
      { symbol: 'USDT',  address: '0x55d398326f99059fF775485246999027B3197955' },
      { symbol: 'USD1',  address: '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d' },
      { symbol: 'U',     address: '0xcE24439F2D9C6a2289F741120FE202248B666666' },
      { symbol: 'BTCB',  address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c' },
      { symbol: 'SPCXB', address: '0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1' },
      { symbol: 'SKHYB', address: '0xCA750eF65f295BBECd685Abf54e82CAf297BDB61' },
      { symbol: 'SPYB',  address: '0x7138b48df7D98D7e3cc221BfE7192D0a178182D8' },
      { symbol: 'XAUT',  address: '0x21cAef8A43163Eea865baeE23b9C2E327696A3bf' },
      { symbol: 'QQQB',  address: '0x205812CdBed920aFf76C6580abD681a46D11efc7' },
      { symbol: 'NVDAB', address: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436' },
      { symbol: 'AAPLB', address: '0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A' },
      { symbol: 'TSLAB', address: '0x5b1910eAaD6450E50f816082Aa078C41F10C292f' },
      { symbol: 'custom…', address: 'custom' },
    ],
  },
  { id: 'noxa-monad',    label: 'Noxa · Monad',   vm: 'evm', enabled: false, chainId: 143,  rpc: '', factory: '0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85', nativeSymbol: 'MON' },
  { id: 'noxa-megaeth',  label: 'Noxa · MegaETH', vm: 'evm', enabled: false, chainId: 4326, rpc: '', factory: '0xAc303930F2f7A78BBB037f3f4622Bd02f5545B9a', nativeSymbol: 'ETH' },
  {
    // Meteora Dynamic Bonding Curve on Solana mainnet. Permissionless: we build
    // a config (binds the quote mint) + create the pool client-side and sign
    // with the stored SOL key. Quote can be SOL, USDC, or any SPL/Token-2022
    // mint (e.g. the pump token). See src/solana.js (lazy-loaded bundle).
    id: 'meteora-sol', label: 'Meteora · SOL', vm: 'sol', enabled: true, family: 'meteora',
    rpc: SOL_RPC,
    explorer: 'https://solscan.io',
    site: (t) => `https://solscan.io/token/${t}`,
    nativeSymbol: 'SOL',
    quoteSel: 'SOL',           // SOL | USDC | CUSTOM (from the dropdown)
    quoteMint: null,           // resolved from quoteSel / custom input
  },
  {
    // lunch.fun - tax tokens paired against stocks on Robinhood chain. Defaults
    // match what the pad is for: HOOD as the pairing, 1%/1% tax, single-asset
    // holder rewards. Basket rewards are a toggle. See launchLunch().
    id: 'lunch-robinhood', label: 'lunch.fun · Tax v4', vm: 'evm', enabled: true, family: 'lunch',
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    launcher: LUNCH.launcher,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://www.lunch.fun/token/${t}`,
    nativeSymbol: 'ETH', curve: null, customSupply: true,
    quotes: LUNCH_QUOTES,
  },
  {
    // long.xyz - a Doppler v4 launchpad on Robinhood chain that pairs new
    // tokens against tokenized stocks rather than ETH. Launch goes through
    // their Airlock (permissionless, given whitelisted modules); the Doppler
    // SDK does the module encoding and mines the v4 hook salt. See src/long.js.
    id: 'long-robinhood', label: 'long.xyz · Stocks', vm: 'evm', enabled: true, family: 'long',
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    airlock: '0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862',
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://robinhoodchain.blockscout.com/token/${t}`,
    nativeSymbol: 'ETH', curve: null,
    quotes: LONG_QUOTES,
  },
  {
    // Our own Uniswap-v4 bonding curve on Robinhood chain. Unlike every other
    // pad here this one is our contract, so the quote list is a convenience
    // rather than a restriction — `custom` accepts any ERC-20 at all.
    id: 'v4curve-robinhood', label: 'v4 Curve · Any Quote', vm: 'evm', enabled: !!V4CURVE_FACTORY, family: 'v4curve',
    chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com',
    factory: V4CURVE_FACTORY,
    explorer: 'https://robinhoodchain.blockscout.com',
    site: (t) => `https://robinhoodchain.blockscout.com/token/${t}`,
    nativeSymbol: 'ETH', curve: null,
    poolFee: 10000, tickSpacing: 200, feeBps: 100,
    quotes: PONS_V2_PAIRS,
  },
  {
    // Raydium LaunchLab on Solana mainnet — bonding curve, no liquidity to seed.
    // Pairs against a quote mint that has an on-chain LaunchpadConfig — SOL / USD1 /
    // Anon / USDC / USDT / EURC / TRUMP are live, plus stock-pegged xStocks quotes
    // (NVDAx, SPYx, CRCLx) now that Raydium added stock pairing to LaunchLab.
    // Graduates to a Raydium AMM/CPMM pool. See launchRaydium().
    id: 'raydium-sol', label: 'Raydium · LaunchLab', vm: 'sol', enabled: true, family: 'raydium',
    rpc: SOL_RPC,
    explorer: 'https://solscan.io',
    site: (t) => `https://solscan.io/token/${t}`,
    nativeSymbol: 'SOL',
    quotes: RAYDIUM_LAUNCHLAB_QUOTES,
  },
  {
    // pump.fun. create_v2 (Token-2022) plus a buy_v2 dev buy in one transaction,
    // compiled against pump's own address lookup table because the two
    // instructions together are 43 accounts and will not otherwise fit.
    //
    // Pairing: every deployed create path opens a NATIVE-SOL curve. The program
    // is already quote-aware everywhere else — buy_v2 / sell_v2 / migrate_v2 all
    // take a quote_mint, BondingCurve stores one, and admin-only add_quote_mint
    // whitelists them (USDC is whitelisted today) — but no create instruction
    // accepts a quote yet. So the quote list here is read live from pump's Global
    // account rather than hardcoded: the moment they ship a stock quote it shows
    // up in CHECK PAIRS without a code change. See src/pump.js.
    id: 'pump-sol', label: 'pump.fun', vm: 'sol', enabled: true, family: 'pump',
    rpc: SOL_RPC,
    explorer: 'https://solscan.io',
    site: (t) => `https://pump.fun/coin/${t}`,
    nativeSymbol: 'SOL',
  },
  {
    // stonkfun.xyz — another LaunchLab frontend, same program and same configs as
    // raydium-sol / bonk-sol, launched with StonkFun's platformId. Verified on
    // chain: that id decodes to a PlatformConfig named "StonkFun" pointing at
    // https://www.stonkfun.xyz.
    //
    // The point of this pad is the pairing. LaunchLab needs a config per quote
    // mint, all of them created by Raydium's admin, and each frontend then shows
    // you a subset: stonkfun lists 425 while 474 exist on chain. So the quote
    // list here is a shortcut, not a limit — paste any mint, or hit SCAN to pull
    // every config that exists and pair against ones no website offers.
    id: 'stonk-sol', label: 'StonkFun · LaunchLab', vm: 'sol', enabled: true, family: 'raydium',
    rpc: SOL_RPC,
    explorer: 'https://solscan.io',
    site: (t) => `https://www.stonkfun.xyz/token/${t}`,
    nativeSymbol: 'SOL',
    quotes: STONK_QUOTES,
    platformId: '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt', // StonkFun
    // StonkFun mints Token-2022 with a transfer fee and its curve rule pins the
    // tier: exactly 100 or 300 bps, max fee 1e15. Anything else is rejected.
    token2022: true, transferFeeBps: 100, transferFeeChoices: [100, 300],
  },
  {
    // bonk.fun — the SAME LaunchLab program + configs as raydium-sol above (bonk.fun
    // is just a LaunchLab frontend), launched with letsbonk.fun's platformId instead
    // of Raydium's. That's why stock pairing (xStocks quotes) landed here too the
    // moment Raydium added it to LaunchLab. See launchRaydium() / BONK_PLATFORM_ID.
    id: 'bonk-sol', label: 'Bonk.fun · LaunchLab', vm: 'sol', enabled: true, family: 'raydium',
    rpc: SOL_RPC,
    explorer: 'https://solscan.io',
    site: (t) => `https://solscan.io/token/${t}`,
    nativeSymbol: 'SOL',
    quotes: RAYDIUM_LAUNCHLAB_QUOTES,
    platformId: 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1', // letsbonk.fun
  },
  {
    // Custom single-sided Raydium CLMM launch — a "curve" that IS a CLMM from
    // birth. Full supply single-sided (no quote seeded), dev buy tuned to ~15%,
    // pair against ANY mint. See launchClmmCurve() in solana.js.
    id: 'clmm-sol', label: 'Raydium · CLMM curve', vm: 'sol', enabled: true, family: 'clmm',
    rpc: SOL_RPC,
    explorer: 'https://solscan.io',
    site: (t) => `https://solscan.io/token/${t}`,
    nativeSymbol: 'SOL',
    quotes: [
      { symbol: 'SOL',  mint: 'So11111111111111111111111111111111111111112' },
      { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      { symbol: 'custom…', mint: 'custom' },
    ],
  },
];
let activePad = PADS.find((p) => p.id === 'ours-robinhood') || PADS.find((p) => p.enabled);

const IPFS_ADD = 'https://api.thegraph.com/ipfs/api/v0/add';
const IPFS_GW = (hash) => `https://ipfs.io/ipfs/${hash}`;
const DEFAULT_DESC = 'aaaaaaaaaa';

// ---------------------------------------------------------------------------
// Private/local mode: keys are stored in PLAINTEXT in this browser — no password,
// no login gate, auto-loaded on open. Shared across launcher/trade/fees via the
// same localStorage key. (The old encrypted vault.v1, if any, is left untouched.)
const KEYS_KEY = 'keys.v1';
const loadKeys = () => { try { return JSON.parse(localStorage.getItem(KEYS_KEY) || 'null'); } catch { return null; } };
const saveKeys = (obj) => localStorage.setItem(KEYS_KEY, JSON.stringify(obj));

// unlocked session state (memory only)
let account = null;        // viem account
let evmPk = null;          // raw decrypted EVM private key (for the session cache)
let solKeyB58 = null;      // decrypted SOL key (base58 / json array)

// ---------------------------------------------------------------------------
// key validation
// ---------------------------------------------------------------------------
function normalizeEvmKey(input) {
  let k = input.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error('EVM key must be 64 hex chars');
  return '0x' + k.toLowerCase();
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58DecodeLen(s) {
  let bytes = [0];
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('bad base58 char');
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of s) { if (c === '1') bytes.push(0); else break; }
  return bytes.length;
}
// full base58 decode/encode — enough to derive the SOL pubkey (last 32 bytes of
// the 64-byte secret) and show the address without loading the heavy solana bundle
function base58Decode(s) {
  const bytes = [0];
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('bad base58 char');
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  for (const c of s) { if (c === '1') zeros++; else break; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}
function base58Encode(bytes) {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const b of bytes) { if (b === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
function solSecretBytes(secret) {
  const s = secret.trim();
  const b = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : base58Decode(s);
  if (b.length !== 64) throw new Error('SOL key must be 64 bytes');
  return b;
}
const solPubkeyFromSecret = (secret) => base58Encode(solSecretBytes(secret).slice(32, 64));

function validateSolKey(input) {
  const k = input.trim();
  if (k.startsWith('[')) {
    const arr = JSON.parse(k);
    if (!Array.isArray(arr) || arr.length !== 64) throw new Error('SOL key array must have 64 numbers');
    return k;
  }
  if (base58DecodeLen(k) !== 64) throw new Error('SOL key must decode to 64 bytes');
  return k;
}

// ---------------------------------------------------------------------------
// clients
// ---------------------------------------------------------------------------
function chainFor(pad) {
  return defineChain({
    id: pad.chainId,
    name: pad.label,
    nativeCurrency: { name: pad.nativeSymbol, symbol: pad.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [pad.rpc] } },
  });
}
const publicClientFor = (pad) => createPublicClient({ chain: chainFor(pad), transport: http(pad.rpc) });

// ---------------------------------------------------------------------------
// image: pick / drop / paste -> square resize -> blob (GIFs pass through)
// ---------------------------------------------------------------------------
let logoBlob = null;

async function setImage(fileOrBlob) {
  if (!fileOrBlob || !fileOrBlob.type.startsWith('image/')) return;
  if (fileOrBlob.type === 'image/gif') {
    if (fileOrBlob.size > 4.4 * 1024 * 1024) { setStatus('GIF too big (max ~4.5MB)', true); return; }
    logoBlob = fileOrBlob;
  } else {
    logoBlob = await squareResize(fileOrBlob, 512);
  }
  const url = URL.createObjectURL(logoBlob);
  const drop = document.getElementById('drop');
  drop.classList.add('has');
  drop.innerHTML = `<img src="${url}" alt="logo">`;
  setStatus('');
}

// fetch an image URL to a Blob and load it as the logo. Most token-image CDNs
// (e.g. cdn.dexscreener.com) block cross-origin fetch(), so we go through
// images.weserv.nl — it re-serves the image with `Access-Control-Allow-Origin: *`.
async function loadImageFromUrl(imageUrl) {
  const toImageBlob = async (r) => {
    if (!r.ok) throw new Error('img ' + r.status);
    const b = await r.blob();
    if (b.size === 0) throw new Error('empty');
    return b.type.startsWith('image/') ? b : new Blob([await b.arrayBuffer()], { type: 'image/png' });
  };
  const weserv = 'https://images.weserv.nl/?url=' + encodeURIComponent(imageUrl.replace(/^https?:\/\//, '')) + '&output=png&n=-1';
  const candidates = [weserv, imageUrl, 'https://corsproxy.io/?url=' + encodeURIComponent(imageUrl)];
  for (const u of candidates) {
    try { await setImage(await toImageBlob(await fetch(u))); return true; } catch { /* next */ }
  }
  return false;
}

// normalize an ipfs://CID (or bare CID) to an https gateway; leave http(s) as-is
function ipfsHttp(u) {
  if (!u) return '';
  if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.replace(/^ipfs:\/\/(ipfs\/)?/, '');
  if (/^[a-zA-Z0-9]{46,}$/.test(u)) return 'https://ipfs.io/ipfs/' + u; // bare CID
  return u;
}

// VAMP: read a token CA from the clipboard and pull its metadata from ON-CHAIN
// sources (so coins without a paid DexScreener profile still work), then fill the
// fields. Solana → Metaplex via Helius getAsset + the token's json_uri. EVM → its
// on-chain name/symbol, with DexScreener as an image/socials supplement.
async function vamp() {
  const hint = (m, err) => { const el = $('vampHint'); el.textContent = m; el.style.color = err ? 'var(--danger)' : 'var(--dim)'; };
  let text = '';
  try { text = (await navigator.clipboard.readText() || '').trim(); }
  catch { hint('clipboard blocked by the browser — copy the CA again and allow clipboard access', true); return; }
  const evm = text.match(/0x[0-9a-fA-F]{40}/);
  const solM = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  if (evm) return vampEvm(evm[0], hint);
  if (solM && isSolAddress(solM[0])) return vampSol(solM[0], hint);
  hint('no contract address found in your clipboard', true);
}

// Solana: on-chain Metaplex metadata via Helius getAsset, then the off-chain json
// for image + socials (works for any SPL/pump.fun token, dex-listed or not).
async function vampSol(mint, hint) {
  hint(`vamping ${mint.slice(0, 4)}…${mint.slice(-4)} on-chain…`);
  let name = '', symbol = '', image = '', uri = '';

  // fast path: Helius DAS getAsset (needs credits) — try each Helius key
  for (const rpc of [SOL_RPC, ...SOL_RPC_FALLBACKS.filter((u) => u.includes('helius'))]) {
    try {
      const a = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
      }).then((r) => r.json());
      const c = a && a.result && a.result.content;
      if (c) {
        const m = c.metadata || {};
        name = m.name || ''; symbol = (m.symbol || '').replace(/^\$/, '');
        image = c.links?.image || (c.files || [])[0]?.uri || ''; uri = c.json_uri || '';
        break;
      }
    } catch { /* try next key / fall through to the account read */ }
  }

  // fallback: read the Metaplex metadata account directly (no DAS credits needed)
  if (!name && !uri) {
    hint('reading the on-chain metadata account…');
    for (const rpc of [SOL_RPC, ...SOL_RPC_FALLBACKS]) {
      try {
        const { solTokenMetadata } = await import('./solana.js');
        const md = await solTokenMetadata(mint, rpc);
        if (md && (md.name || md.uri)) { name = md.name || ''; symbol = (md.symbol || '').replace(/^\$/, ''); uri = md.uri || ''; break; }
      } catch { /* try next rpc */ }
    }
  }
  if (!name && !uri && !image) { hint('could not read on-chain metadata (RPC busy or key maxed) — try again in a moment', true); return; }

  // the off-chain JSON carries the image + socials (twitter/telegram/website)
  let tw = '', tg = '', site = '';
  if (uri) {
    try {
      const j = await fetch(ipfsHttp(uri)).then((r) => r.json());
      image = image || j.image || '';
      const ext = j.extensions || j;
      tw = ext.twitter || j.twitter || '';
      tg = ext.telegram || j.telegram || '';
      site = ext.website || j.website || ext.homepage || '';
      if (!name) name = j.name || '';
      if (!symbol) symbol = (j.symbol || '').replace(/^\$/, '');
    } catch { /* gateway/CORS hiccup — use what we have */ }
  }
  if (name) $('name').value = name;
  if (symbol) $('symbol').value = symbol;
  if (tw && $('twitter')) $('twitter').value = tw;
  if (site && $('website')) $('website').value = site;
  const bits = []; if (tw) bits.push('twitter'); if (tg) bits.push('telegram'); if (site) bits.push('website');
  let note = image ? ((await loadImageFromUrl(ipfsHttp(image))) ? ' · image ✓' : ' · image blocked') : ' · no image';
  hint(`vamped ${symbol || ''}${name ? ' — ' + name : ''}${note}${bits.length ? ' · ' + bits.join(' + ') : ''}`);
}

// EVM: DexScreener resolves the token across all chains (name/symbol always; image
// + socials when the project has a profile). Falls back to on-chain name/symbol.
async function vampEvm(ca, hint) {
  hint(`vamping ${ca.slice(0, 6)}…${ca.slice(-4)} …`);
  let pairs = [];
  try { pairs = (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + ca).then((r) => r.json()))?.pairs || []; } catch { /* */ }
  const mine = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === ca.toLowerCase());
  const list = (mine.length ? mine : pairs).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = list[0];
  const tok = p ? (p.baseToken?.address?.toLowerCase() === ca.toLowerCase() ? p.baseToken
    : (p.quoteToken?.address?.toLowerCase() === ca.toLowerCase() ? p.quoteToken : p.baseToken)) : null;

  const infos = list.map((x) => x.info || {});
  const imageUrl = (infos.find((i) => i.imageUrl) || {}).imageUrl || '';
  const socials = (infos.find((i) => (i.socials || []).length) || {}).socials || [];
  const websites = (infos.find((i) => (i.websites || []).length) || {}).websites || [];

  if (tok?.name) $('name').value = tok.name;
  if (tok?.symbol) $('symbol').value = tok.symbol.replace(/^\$/, '');
  const tw = (socials.find((s) => /twitter|^x$/i.test(s.type || '')) || {}).url || '';
  const site = (websites[0] || {}).url || '';
  if (tw && $('twitter')) $('twitter').value = tw;
  if (site && $('website')) $('website').value = site;

  if (!tok) { hint('no data for that EVM token yet — it may be too new / unindexed. name & ticker can be typed in.', true); return; }
  const bits = []; if (tw) bits.push('twitter'); if (site) bits.push('website');
  let note = imageUrl ? ((await loadImageFromUrl(imageUrl)) ? ' · image ✓' : ' · image blocked') : ' · no on-chain image (EVM) — drop it manually';
  hint(`vamped ${tok.symbol || ''}${tok.name ? ' — ' + tok.name : ''}${note}${bits.length ? ' · ' + bits.join(' + ') : ''}`);
}

async function squareResize(blob, size) {
  const img = await createImageBitmap(blob);
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

async function uploadToIpfs(blob) {
  const fd = new FormData();
  fd.append('file', new File([blob], 'logo.' + (blob.type === 'image/gif' ? 'gif' : 'png'), { type: blob.type }));
  const r = await fetch(IPFS_ADD, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('IPFS upload failed (' + r.status + ')');
  const { Hash } = await r.json();
  if (!Hash) throw new Error('IPFS upload returned no hash');
  return 'ipfs://' + Hash;
}

// ---------------------------------------------------------------------------
// o1 / Base — launch via the B20LaunchpadFactory (createLaunch), the SAME contract
// ---------------------------------------------------------------------------
// launch.o1.exchange uses. createLaunch mints a B20 token from a fixed 1B supply,
// hands you (+ any insiders) an allocation, and seeds the rest into a Uniswap-v4
// pool vs ETH — so the token actually shows up + trades on o1. Socials are written
// as metadataKeys/Values. (The old build called the raw B20 precompile directly,
// which minted a bare token that never registered on o1's launchpad.)
const B20_LAUNCHPAD_ABI = [
  { type: 'function', name: 'configVersion', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'launchSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'quotes', stateMutability: 'view', inputs: [{ name: '', type: 'address' }],
    outputs: [
      { name: 'registered', type: 'bool' }, { name: 'decimals', type: 'uint8' },
      { name: 'startTickToken0Frame', type: 'int24' }, { name: 'creationFee', type: 'uint256' },
    ],
  },
  {
    type: 'function', name: 'createLaunch', stateMutability: 'payable',
    inputs: [{ name: 'p', type: 'tuple', components: [
      { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
      { name: 'contractURI', type: 'string' }, { name: 'salt', type: 'bytes32' },
      { name: 'quote', type: 'address' },
      { name: 'allocationRecipients', type: 'address[]' },
      { name: 'allocationAmounts', type: 'uint256[]' },
      { name: 'vestedAllocations', type: 'tuple[]', components: [
        { name: 'beneficiary', type: 'address' }, { name: 'amount', type: 'uint256' },
        { name: 'steps', type: 'tuple[]', components: [
          { name: 'delay', type: 'uint32' }, { name: 'cumulativeBps', type: 'uint16' },
        ] },
      ] },
      { name: 'expectedConfigVersion', type: 'uint64' }, { name: 'deadline', type: 'uint64' },
      { name: 'roleMode', type: 'uint8' },
      { name: 'metadataKeys', type: 'string[]' }, { name: 'metadataValues', type: 'string[]' },
    ] }],
    outputs: [{ name: 'token', type: 'address' }, { name: 'id', type: 'bytes32' }],
  },
];

async function launchB20(pad, { name, symbol, logo, description, twitter, website }) {
  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  // the launch supply is a fixed 1B. You allocate slices to wallets via the wallet
  // slots (your dev wallet is pre-filled in slot 1); the unallocated remainder is
  // seeded into the o1 v4 pool. Allocations are minted directly at launch.
  const total = padSupply(pad); // 1B — base for % amounts + the pool-room check
  const supplyWei = parseEther(total.toLocaleString('fullwide', { useGrouping: false }));
  const allocs = parseDistributions(total); // [{addr, amount(wei)}] from the wallet slots
  if (!allocs.length) throw new Error('set at least one allocation — your dev wallet is pre-filled, just enter an amount');
  const recipients = allocs.map((a) => a.addr);
  const amounts = allocs.map((a) => a.amount);
  const insiders = allocs.slice(1); // for the status note (everything past the dev slot)
  const totalAlloc = amounts.reduce((s, a) => s + a, 0n);
  if (totalAlloc >= supplyWei) throw new Error(`allocations total ${formatEther(totalAlloc)} — must stay under the ${total.toLocaleString()} supply so the pool gets seeded`);

  setStatus('publishing token metadata to IPFS...');
  const contractURI = 'ipfs://' + await uploadJsonToIpfs({ name, symbol, description, image: logo });

  setStatus('reading launchpad config...');
  const configVersion = await pub.readContract({ address: pad.launchpad, abi: B20_LAUNCHPAD_ABI, functionName: 'configVersion' });
  // createLaunch is payable and charges a per-quote launch fee (quotes[quote].creationFee) —
  // send it as msg.value or the tx reverts with InvalidLaunchFeePayment.
  const quoteInfo = await pub.readContract({ address: pad.launchpad, abi: B20_LAUNCHPAD_ABI, functionName: 'quotes', args: [ZERO_ADDR] });
  if (!quoteInfo[0]) throw new Error('native ETH is not a registered quote on this o1 launchpad');
  const launchFee = quoteInfo[3];

  const metadataKeys = [], metadataValues = [];
  if (twitter) { metadataKeys.push('twitter'); metadataValues.push(twitter); }
  if (website) { metadataKeys.push('website'); metadataValues.push(website); }

  const p = {
    name, symbol, contractURI,
    salt: keccak256(stringToBytes(`${name}-${symbol}-${account.address}-${Date.now()}`)),
    quote: ZERO_ADDR,                 // native ETH pair — what o1 launches use
    allocationRecipients: recipients,
    allocationAmounts: amounts,
    vestedAllocations: [],
    expectedConfigVersion: configVersion,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    roleMode: 0,
    metadataKeys, metadataValues,
  };

  const bal = await pub.getBalance({ address: account.address });
  if (bal === 0n) throw new Error(`no ${pad.nativeSymbol} on Base for gas`);
  if (bal < launchFee) throw new Error(`need ${formatEther(launchFee)} ${pad.nativeSymbol} for the o1 launch fee, only have ${formatEther(bal)}`);

  setStatus('simulating o1 launch…');
  let token;
  try {
    const sim = await pub.simulateContract({ address: pad.launchpad, abi: B20_LAUNCHPAD_ABI, functionName: 'createLaunch', args: [p], account, value: launchFee });
    token = sim.result[0];
  } catch (e) {
    throw new Error('o1 launch simulation failed: ' + (e.shortMessage || e.message).split('\n')[0]);
  }

  setStatus('sending createLaunch tx…');
  const hash = await wallet.writeContract({ address: pad.launchpad, abi: B20_LAUNCHPAD_ABI, functionName: 'createLaunch', args: [p], value: launchFee });
  setStatus(`tx sent: ${hash}\nwaiting for confirmation…`);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error('createLaunch reverted');

  rememberLaunch(pad, token, symbol);
  const walletNote = `${recipients.length} wallet${recipients.length > 1 ? 's' : ''} allocated ${formatEther(totalAlloc).toLocaleString()} tokens`;
  setStatus(`✅ launched ${symbol} on o1 (Base)\ntoken: ${token}\n${walletNote}, rest seeded into the pool\n${pad.site(token)}`);
  refreshBalance();
  renderTokenList();
  return { token, pub, wallet };
}

// ---------------------------------------------------------------------------
// flap.sh — Portal.newTokenV6 tax token (dividends / burn / stock pairings)
// ---------------------------------------------------------------------------
// See memory flap-sh-mechanism. Token addr must end in 7777 (vanity) — mined
// client-side. Tax splits mkt/burn(deflation)/dividend/lp (bps sum 10000).
const FLAP_VANITY_SUFFIX = '7777';
const FLAP_FEED = '0xfEEDFEEDfeEDFEedFEEdFEEDFeEdfEEdFeEdFEEd'; // dividendToken = the token itself
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const FLAP_PARAM_COMPONENTS = [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'meta', type: 'string' },
  { name: 'dexThresh', type: 'uint8' }, { name: 'salt', type: 'bytes32' }, { name: 'migratorType', type: 'uint8' },
  { name: 'quoteToken', type: 'address' }, { name: 'quoteAmt', type: 'uint256' }, { name: 'beneficiary', type: 'address' },
  { name: 'permitData', type: 'bytes' }, { name: 'extensionID', type: 'bytes32' }, { name: 'extensionData', type: 'bytes' },
  { name: 'dexId', type: 'uint8' }, { name: 'lpFeeProfile', type: 'uint8' }, { name: 'buyTaxRate', type: 'uint16' },
  { name: 'sellTaxRate', type: 'uint16' }, { name: 'taxDuration', type: 'uint64' }, { name: 'antiFarmerDuration', type: 'uint64' },
  { name: 'mktBps', type: 'uint16' }, { name: 'deflationBps', type: 'uint16' }, { name: 'dividendBps', type: 'uint16' },
  { name: 'lpBps', type: 'uint16' }, { name: 'minimumShareBalance', type: 'uint256' }, { name: 'dividendToken', type: 'address' },
  { name: 'commissionReceiver', type: 'address' }, { name: 'tokenVersion', type: 'uint8' },
];
const FLAP_PORTAL_ABI = [{
  type: 'function', name: 'newTokenV6', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: FLAP_PARAM_COMPONENTS }],
  outputs: [{ name: 'token', type: 'address' }],
}];

// EIP-1167 clone init-code hash for the token implementation this pad deploys
function flapInitCodeHash(impl) {
  return keccak256(concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', getAddress(impl), '0x5af43d82803e903d91602b57fd5bf3']));
}
function flapTokenAddress(portal, initHash, salt) {
  return '0x' + keccak256(concat(['0xff', getAddress(portal), salt, initHash])).slice(-40);
}
// mine a salt whose CREATE2 token address ends in 7777 (~65k tries avg)
async function mineFlapSalt(pad) {
  const initHash = flapInitCodeHash(pad.cloneImpl);
  const base = `flap-${account.address}-${Date.now()}-${Math.random()}`;
  for (let n = 0; ; n++) {
    const salt = keccak256(stringToBytes(`${base}-${n}`));
    const addr = flapTokenAddress(pad.portal, initHash, salt);
    if (addr.toLowerCase().endsWith(FLAP_VANITY_SUFFIX)) return { salt, token: getAddress(addr), tries: n + 1 };
    if (n % 4000 === 0 && n) { setStatus(`mining vanity address (…${FLAP_VANITY_SUFFIX})… ${n.toLocaleString()} tries`); await new Promise((r) => setTimeout(r, 0)); }
  }
}

function flapReadForm(pad) {
  const qsel = document.getElementById('flapQuoteSelect');
  let quote = pad.quotes.find((q) => q.symbol === qsel.value) || pad.quotes[0];
  if (quote.address === 'custom') {
    const c = document.getElementById('flapQuoteCustom').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(c)) throw new Error('enter a valid payment token address (0x…)');
    quote = { symbol: 'custom', address: getAddress(c) };
  }
  const taxPct = Math.min(50, Math.max(0, +document.getElementById('flapTax').value || 10));
  const taxBps = Math.round(taxPct * 100);
  const mode = document.getElementById('flapMode').value; // standard | burn | dividends
  const splitPct = Math.min(100, Math.max(0, +document.getElementById('flapSplit').value || 50));
  const splitBps = Math.round(splitPct * 100);
  const devBuy = +(document.getElementById('flapDevBuy').value || '0');
  const devFund = document.getElementById('flapDevFund').value; // BNB | USDC (native pads ignore it)

  let mktBps = 10000, deflationBps = 0, dividendBps = 0, dividendToken = ZERO_ADDR, minimumShareBalance = 0n;
  if (mode === 'burn') { deflationBps = splitBps; mktBps = 10000 - splitBps; }
  else if (mode === 'dividends') {
    dividendBps = splitBps; mktBps = 10000 - splitBps;
    const dt = document.getElementById('flapDivToken').value; // self | quote | custom
    if (dt === 'self') dividendToken = FLAP_FEED;
    else if (dt === 'quote') dividendToken = quote.address;
    else {
      const c = document.getElementById('flapDivCustom').value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(c)) throw new Error('dividend token: enter a valid ERC-20 address');
      dividendToken = getAddress(c);
    }
    const ms = +(document.getElementById('flapMinShare').value || '0');
    if (!(ms > 0)) throw new Error('dividends mode needs a minimum share balance > 0');
    minimumShareBalance = parseEther(ms.toString());
  }
  return { quote, taxBps, mode, mktBps, deflationBps, dividendBps, lpBps: 0, dividendToken, minimumShareBalance, devBuy, devFund };
}

// Fund a stock-quote dev buy by swapping BNB/USDC into the pair token through the
// OpenOcean DEX aggregator (routes across PancakeSwap/Uniswap V2+V3 — the same
// liquidity GMGN uses), then flap buys with the acquired token. `amountHuman` is a
// human amount (e.g. "0.5"). Returns the raw amount of `quote` received.
const OO_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const BSC_USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
async function aggregatorAcquireQuote(pub, wallet, chainKey, fund, amountHuman, quote) {
  const inTok = fund === 'BNB' ? OO_NATIVE : getAddress(fund);
  const url = `https://open-api.openocean.finance/v3/${chainKey}/swap_quote`
    + `?inTokenAddress=${inTok}&outTokenAddress=${getAddress(quote)}`
    + `&amount=${amountHuman}&gasPrice=1&slippage=5&account=${account.address}`;
  const res = await fetch(url).then((r) => r.json()).catch(() => null);
  const tx = res && res.data;
  if (!tx || !tx.to || !tx.data) throw new Error('no aggregator route from the funding token to the pair token');

  // ERC-20 funding needs an allowance to the aggregator router
  if (fund !== 'BNB') {
    const dec = await pub.readContract({ address: getAddress(fund), abi: ERC20, functionName: 'decimals' });
    const amtRaw = parseUnits(String(amountHuman), dec);
    const alw = await pub.readContract({ address: getAddress(fund), abi: ERC20, functionName: 'allowance', args: [account.address, getAddress(tx.to)] });
    if (alw < amtRaw) {
      const ah = await wallet.writeContract({ address: getAddress(fund), abi: ERC20, functionName: 'approve', args: [getAddress(tx.to), amtRaw] });
      await pub.waitForTransactionReceipt({ hash: ah });
    }
  }

  const before = await pub.readContract({ address: getAddress(quote), abi: ERC20, functionName: 'balanceOf', args: [account.address] });
  const hash = await wallet.sendTransaction({ to: getAddress(tx.to), value: BigInt(tx.value || 0), data: tx.data });
  await pub.waitForTransactionReceipt({ hash });
  const after = await pub.readContract({ address: getAddress(quote), abi: ERC20, functionName: 'balanceOf', args: [account.address] });
  const got = after - before;
  if (got <= 0n) throw new Error('aggregator swap returned no pair tokens');
  return got;
}

async function launchFlap(pad, { name, symbol, logo, description, twitter, website, feeRecipient }) {
  const f = flapReadForm(pad);
  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  // flap `meta` is a bare IPFS CID pointing at the metadata JSON (with the image)
  setStatus('publishing token metadata to IPFS...');
  const meta = await uploadJsonToIpfs({ name, symbol, description, image: logo, twitter, website });

  const isNative = f.quote.address === ZERO_ADDR;
  // flap requires a non-zero dividendToken when the quote is an ERC-20; default it
  // to the quote token itself (harmless in standard mode where dividendBps == 0).
  let dividendToken = f.dividendToken;
  if (!isNative && dividendToken === ZERO_ADDR) dividendToken = f.quote.address;

  // dev buy. Native quote: pay msg.value directly. ERC-20/stock quote: acquire the
  // pair token by swapping BNB/USDC on PancakeSwap, approve it to flap, then flap's
  // launch does the initial buy with `quoteAmt` — so you never hold the stock.
  let quoteAmt = 0n, value = 0n;
  if (f.devBuy > 0) {
    if (isNative) {
      quoteAmt = parseEther(f.devBuy.toString());
      value = quoteAmt;
    } else {
      if (pad.chainId !== 56) throw new Error('dev buy on a stock pair is only supported on BNB');
      const fundIsNative = f.devFund === 'BNB';
      setStatus(`swapping ${f.devBuy} ${f.devFund} → ${f.quote.symbol} via aggregator…`);
      const got = await aggregatorAcquireQuote(pub, wallet, 'bsc', fundIsNative ? 'BNB' : BSC_USDC, f.devBuy, f.quote.address);
      setStatus(`approving ${f.quote.symbol} to flap…`);
      const alw = await pub.readContract({ address: getAddress(f.quote.address), abi: ERC20, functionName: 'allowance', args: [account.address, pad.portal] });
      if (alw < got) {
        const ah = await wallet.writeContract({ address: getAddress(f.quote.address), abi: ERC20, functionName: 'approve', args: [pad.portal, got] });
        await pub.waitForTransactionReceipt({ hash: ah });
      }
      quoteAmt = got; // flap pulls this via allowance during newTokenV6
    }
  }

  setStatus(`mining vanity address (…${FLAP_VANITY_SUFFIX})…`);
  const { salt, token } = await mineFlapSalt(pad);

  const params = {
    name, symbol, meta, dexThresh: 1, salt, migratorType: 1,
    quoteToken: f.quote.address, quoteAmt, beneficiary: feeRecipient,
    permitData: '0x', extensionID: '0x' + '00'.repeat(32), extensionData: '0x',
    dexId: 0, lpFeeProfile: 0, buyTaxRate: f.taxBps, sellTaxRate: f.taxBps,
    taxDuration: 3153600000n, antiFarmerDuration: 2592000n,
    mktBps: f.mktBps, deflationBps: f.deflationBps, dividendBps: f.dividendBps, lpBps: f.lpBps,
    minimumShareBalance: f.minimumShareBalance, dividendToken,
    commissionReceiver: ZERO_ADDR, tokenVersion: 6,
  };

  setStatus('simulating flap launch...');
  try {
    await pub.simulateContract({ address: pad.portal, abi: FLAP_PORTAL_ABI, functionName: 'newTokenV6', args: [params], account, value });
  } catch (e) {
    throw new Error('flap simulation failed: ' + (e.shortMessage || e.message).split('\n')[0]);
  }

  setStatus('sending flap newTokenV6 tx...');
  const hash = await wallet.writeContract({ address: pad.portal, abi: FLAP_PORTAL_ABI, functionName: 'newTokenV6', args: [params], value });
  setStatus(`tx sent: ${hash}\nwaiting for confirmation...`);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error('flap launch reverted');

  rememberLaunch(pad, token, symbol);
  const modeNote = f.mode === 'burn' ? `burn ${f.deflationBps / 100}% of tax`
    : f.mode === 'dividends' ? `dividends ${f.dividendBps / 100}% of tax` : 'standard';
  setStatus(`✅ launched ${symbol} on flap · ${pad.nativeSymbol === 'BNB' ? 'BNB' : 'Robinhood'}\ntoken: ${token}\npair: ${f.quote.symbol} · tax ${f.taxBps / 100}% · ${modeNote}\n${pad.site(token)}`);
  refreshBalance();
  renderTokenList();
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------
async function launch() {
  const pad = activePad;
  if (!pad.enabled) throw new Error('that launchpad is not live yet');
  // EVM pads need an EVM key loaded into `account`. If none is present (e.g. this
  // browser origin has no key stored, or only a SOL key was imported), pop the key
  // import form instead of a cryptic error — there is no password, just paste the key.
  if (pad.vm !== 'sol' && !account) {
    $('importEvmKey').value = '';
    $('importErr').textContent = 'paste your EVM private key to launch here';
    $('keysOverlay').classList.remove('hidden');
    $('importEvmKey').focus();
    throw new Error('no EVM key loaded on this site — paste your key in the 🔑 form that just opened (this origin/browser stores keys separately)');
  }
  const name = document.getElementById('name').value.trim();
  // ticker: preserve the user's casing/length (Pons allows arbitrarily long,
  // mixed-case tickers — no forced uppercase, no length cap)
  const symbol = document.getElementById('symbol').value.trim();
  if (!name || !symbol) throw new Error('name and ticker required');

  // Uniswap V2 fair launch (no image / bonding curve) — its own EVM flow
  if (pad.family === 'uniswap') {
    await launchUniswap(pad, { name, symbol });
    return;
  }

  if (!logoBlob) throw new Error('image required');
  const description = document.getElementById('desc').value.trim() || DEFAULT_DESC;
  const twitter = document.getElementById('twitter').value.trim();
  const website = document.getElementById('website').value.trim();

  // Solana / Meteora path — separate stack, doesn't touch the EVM branch below
  if (pad.vm === 'sol') {
    await launchSol(pad, { name, symbol, description, twitter, website });
    return;
  }

  const feeRecipientRaw = document.getElementById('feeRecipient').value.trim();
  if (feeRecipientRaw && !/^0x[0-9a-fA-F]{40}$/.test(feeRecipientRaw)) throw new Error('fee recipient is not a valid address');
  const feeRecipient = feeRecipientRaw || account.address;

  // DYORswap V3 launchpad on ARC — API-driven, dev buy in USDC
  if (pad.family === 'dyorswap') {
    await launchDyorswap(pad, { name, symbol, description, twitter, website, feeRecipient });
    return;
  }

  const devBuy = selectedBuyAmount();

  const supplyTokens = padSupply(pad);
  if (pad.customSupply && !(supplyTokens >= 1 && supplyTokens <= 1e18)) throw new Error('supply must be between 1 and 1e18 tokens');

  const dists = distroOn ? parseDistributions(supplyTokens) : [];
  // o1/B20 allocations are minted NATIVELY at launch (createLaunch) — they don't come
  // from a dev buy, so skip the curve/dev-buy distribution checks for it entirely.
  if (pad.family !== 'b20') {
    if (dists.length && pad.curve && selectedChip >= 0) {
      const x = +buyChips[selectedChip];
      const expected = parseEther(Math.floor((supplyTokens * x) / (pad.curve.cap + x)).toString());
      const total = dists.reduce((s, d) => s + d.amount, 0n);
      if (total > expected) throw new Error('distribution total exceeds what your dev buy gets you — bump the dev buy or lower amounts');
    }
    if (dists.length && selectedChip < 0) throw new Error('distribution needs a dev buy (that is where the tokens come from)');
  }

  // Rialto hosts + hashes its own image, so it skips the IPFS upload entirely
  if (pad.family === 'rialto') {
    const { token, pub, wallet } = await launchRialto(pad, {
      name, symbol, description, twitter, website, feeRecipient,
    });
    if (token && dists.length) await runDistributions(pad, pub, wallet, token, dists, $('status'));
    refreshBalance();
    renderTokenList();
    return;
  }

  setStatus('uploading image to IPFS...');
  const logo = await uploadToIpfs(logoBlob);

  // Pools — open v4 launchpad. createToken (IPFS image) -> distributeToken -> dev buy
  if (pad.family === 'pools') {
    const { token, pub, wallet } = await launchPools(pad, { name, symbol, logo, description, twitter, website, devBuy: selectedBuyAmount() });
    if (token && distroOn) {
      const dists = parseDistributions(padSupply(pad));
      if (dists.length) await runDistributions(pad, pub, wallet, token, dists, $('status'));
    }
    refreshBalance();
    renderTokenList();
    return;
  }

  // o1 / Base — B20 token (on-chain allocation + insider allocations, no curve)
  if (pad.family === 'b20') {
    await launchB20(pad, { name, symbol, logo, description, twitter, website });
    return;
  }

  // flap.sh — tax token with dividends/burn modes + stock pairings (vanity 7777)
  if (pad.family === 'flap') {
    await launchFlap(pad, { name, symbol, logo, description, twitter, website, feeRecipient });
    return;
  }

  if (pad.family === 'pons-v1') {
    const { token, pub, wallet } = await launchPonsV1(pad, {
      name, symbol, logo, description, twitter, website, feeRecipient, devBuy,
    });
    if (token && dists.length) await runDistributions(pad, pub, wallet, token, dists, $('status'));
    refreshBalance();
    renderTokenList();
    return;
  }

  if (pad.family === 'long') {
    const q = pad.quotes.find((x) => x.symbol === $('longQuoteSelect').value) || pad.quotes[0];
    const numeraire = q.address === 'custom' ? $('longQuoteCustom').value.trim() : q.address;
    if (!/^0x[a-fA-F0-9]{40}$/.test(numeraire)) throw new Error('enter a valid numeraire (stock) address');
    const supplyTokens = $('longSupply').value.trim().replace(/,/g, '');
    if (!(+supplyTokens > 0)) throw new Error('set a supply');
    // the whole supply goes on the curve, the way a real long.xyz coin does -
    // holding part of it back leaves a premined block outside the pool
    const buybackDestination = $('longBuyback').value.trim();
    if (buybackDestination && !/^0x[a-fA-F0-9]{40}$/.test(buybackDestination))
      throw new Error('the fee destination must be a valid address, or blank for your own');

    const keys = loadKeys();
    if (!keys?.evm) throw new Error('no EVM key loaded — paste your key in the key form');

    setStatus('loading long.xyz module...');
    const { launchLong } = await import('./long.js');
    const res = await launchLong({
      privateKey: keys.evm, name, symbol, tokenURI: logo,
      numeraire, supplyTokens,
      buybackDestination: buybackDestination || undefined,
      onStatus: (m) => setStatus(m),
    });

    if (res.token) rememberLaunch(pad, res.token, symbol);
    $('status').innerHTML =
      `<span style="color:var(--accent)">LAUNCHED ✓</span> ${res.token ?? '(see tx)'}<br>` +
      `paired against ${esc(q.symbol === 'custom…' ? numeraire : q.symbol)}<br>` +
      (res.hash ? `<a href="${pad.explorer}/tx/${res.hash}" target="_blank" rel="noopener">tx on explorer</a>` : '');
    refreshBalance();
    renderTokenList();
    return;
  }

  if (pad.family === 'lunch') {
    const supplyTokens = ($('supply').value || '').trim().replace(/,/g, '') || '1000000000';
    const res = await launchLunch(pad, { name, symbol, supply: supplyTokens });
    if (res.token) rememberLaunch(pad, res.token, symbol);
    const lq = lunchQuote(pad, $('lunchQuoteSelect').value);
    $('status').innerHTML =
      `<span style="color:var(--accent)">LAUNCHED ✓</span> ${res.token ?? '(see tx)'}<br>` +
      `paired against ${esc(lq.symbol)} · ${(+$('lunchBuyTax').value || 0)}% buy / ${(+$('lunchSellTax').value || 0)}% sell tax<br>` +
      (res.hash ? `<a href="${pad.explorer}/tx/${res.hash}" target="_blank" rel="noopener">tx on explorer</a>` : '');
    refreshBalance();
    renderTokenList();
    return;
  }

  if (pad.family === 'v4curve') {
    await launchV4Curve(pad, { name, symbol, logo, description, twitter, website });
    refreshBalance();
    renderTokenList();
    return;
  }

  if (pad.family === 'pons-v2') {
    const pair = resolvePonsPair(pad);
    const devBuyStr = document.getElementById('ponsDevBuy').value.trim() || '0';
    const buyback = document.getElementById('ponsBuyback').checked;
    const { token, pub, wallet } = await launchPonsV2(pad, {
      name, symbol, logo, description, twitter, website, feeRecipient, pair, devBuyStr, buyback,
    });
    if (token && dists.length) await runDistributions(pad, pub, wallet, token, dists, $('status'));
    refreshBalance();
    renderTokenList();
    return;
  }

  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  setStatus('reading launch fee...');
  const fee = await pub.readContract({ address: pad.factory, abi: FACTORY_ABI, functionName: 'launchFee' });
  const value = fee + devBuy;

  const bal = await pub.getBalance({ address: account.address });
  if (bal < value) throw new Error(`insufficient balance: need ${formatEther(value)}+gas, have ${formatEther(bal)} ${pad.nativeSymbol}`);

  const params = {
    name, symbol, logo, description,
    socials: { telegram: '', twitter, discord: '', website, farcaster: '' },
    devWallet: feeRecipient,
  };
  if (pad.customSupply) params.totalSupply = parseEther(supplyTokens.toLocaleString('fullwide', { useGrouping: false }));
  const abi = pad.customSupply ? OUR_FACTORY_ABI : FACTORY_ABI;
  const args = [
    params,
    0n, // launchConfigId
    0n, // dexId
    keccak256(stringToBytes(`${name}-${symbol}-${Date.now()}`)),
  ];

  setStatus('sending launch tx...');
  let gas;
  try {
    gas = await pub.estimateContractGas({ address: pad.factory, abi, functionName: 'launchToken', args, value, account });
    gas = (gas * 120n) / 100n;
  } catch { /* let the node estimate */ }

  const hash = await wallet.writeContract({ address: pad.factory, abi, functionName: 'launchToken', args, value, gas });
  setStatus(`tx sent: ${hash}\nwaiting for confirmation...`);

  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('tx reverted: ' + hash);

  const [ev] = parseEventLogs({ abi: FACTORY_ABI, eventName: 'TokenLaunched', logs: receipt.logs });
  const token = ev?.args?.token;
  if (token) rememberLaunch(pad, token, symbol);
  const el = document.getElementById('status');
  el.innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${token || ''}<br>` +
    (token && pad.site ? `<a href="${pad.site(token)}" target="_blank" rel="noopener">view on noxa</a> · ` : '') +
    `<a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx on explorer</a>`;
  if (token && dists.length) await runDistributions(pad, pub, wallet, token, dists, el);
  refreshBalance();
  renderTokenList();
}

// ---------------------------------------------------------------------------
// Rialto
// ---------------------------------------------------------------------------
let rialtoConfig = null; // cached GET /config (quote tokens, executor, fees)

async function loadRialtoConfig(pad) {
  if (rialtoConfig) return rialtoConfig;
  const r = await fetch(pad.configUrl, { headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`Rialto config unavailable (${r.status})`);
  rialtoConfig = await r.json();
  return rialtoConfig;
}

// SIWE: challenge -> sign with the in-app key -> verify -> bearer JWT. Fits the
// app's model — the key signs the login message client-side, nothing leaves the
// device but the signature.
async function rialtoAuth(pad) {
  const base = RIALTO_API;
  const ch = await (await fetch(`${base}/auth/challenge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: account.address }),
  })).json();
  if (!ch.message || !ch.nonce) throw new Error('Rialto auth challenge failed');
  const signature = await account.signMessage({ message: ch.message });
  const vr = await fetch(`${base}/auth/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: account.address, signature, nonce: ch.nonce }),
  });
  if (!vr.ok) throw new Error(`Rialto auth failed (${vr.status})`);
  const { token } = await vr.json();
  if (!token) throw new Error('Rialto auth returned no token');
  return token;
}

// ---------------------------------------------------------------------------
// DYORswap V3 launchpad (ARC): upload image -> publish metadata -> prepare an
// unsigned launch tx via the API -> sign + submit. The launchpad deploys the
// token, pools it vs USDC on Uniswap V3 and locks the LP NFT. Dev buy is USDC.
// ---------------------------------------------------------------------------
async function dyorUpload(api, blob) {
  const fd = new FormData();
  fd.append('image', new File([blob], 'logo.' + (blob.type === 'image/gif' ? 'gif' : 'png'), { type: blob.type }));
  const r = await fetch(`${api}/images`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`DYORswap image upload failed (${r.status})`);
  const { url } = await r.json();
  if (!url) throw new Error('DYORswap image upload returned no url');
  return url;
}

async function dyorPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || j.error || `DYORswap request failed (${r.status})`);
  return j;
}

async function launchDyorswap(pad, inp) {
  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  // dev buy in USDC (raw decimal string, ≤6 dp), from the selected dev-buy chip
  const initialBuyEth = selectedChip >= 0 ? buyChips[selectedChip] : '0';

  // step-labeled so any failure says exactly where it happened
  const step = async (label, fn) => {
    setStatus(label + '…');
    try { return await fn(); }
    catch (e) { throw new Error(`${label} failed: ${e.shortMessage || e.message}`); }
  };

  const image = await step('uploading image', () => dyorUpload(pad.api, logoBlob));
  const meta = await step('publishing metadata', () => dyorPost(`${pad.api}/metadata`, {
    name: inp.name, symbol: inp.symbol, image,
    description: inp.description,
    ...(inp.website ? { website: inp.website } : {}),
    ...(inp.twitter ? { x: inp.twitter } : {}),
  }));
  const prep = await step('preparing launch', () => dyorPost(`${pad.api}/launch/prepare`, {
    name: inp.name, symbol: inp.symbol, metadataUri: meta.uri,
    feeRecipient: inp.feeRecipient, sender: account.address,
    initialBuyEth, minTokensOut: '0',
  }));
  if (!prep.to || !prep.data) throw new Error('DYORswap prepare returned no transaction');

  const value = BigInt(prep.value || '0');
  // launches are heavy (~6.4M gas: token deploy + V3 pool + dev-buy swap). Estimate
  // if the RPC allows, else fall back to a fixed limit — flaky public-RPC estimateGas
  // on a tx this big is the usual cause of "HTTP request failed".
  let gas = 8_000_000n;
  try {
    gas = ((await pub.estimateGas({ account: account.address, to: prep.to, data: prep.data, value })) * 12n) / 10n;
  } catch { /* keep the fixed fallback */ }

  const [gasPrice, bal] = await Promise.all([
    pub.getGasPrice().catch(() => 0n),
    pub.getBalance({ address: account.address }),
  ]);
  const needed = value + gas * gasPrice;
  if (bal < needed) throw new Error(`insufficient balance: need ~${formatEther(needed)} USDC (dev buy + fee + gas), have ${formatEther(bal)}`);

  const hash = await step('sending launch tx', () => wallet.sendTransaction({ to: prep.to, data: prep.data, value, gas }));
  setStatus(`tx sent: ${hash}\nwaiting for confirmation…`);
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('launch tx reverted: ' + hash);

  // the launched token is the ERC-20 mint (Transfer from the zero address, 3 topics)
  const ZERO_TOPIC = '0x' + '0'.repeat(64);
  const mint = receipt.logs.find((l) => l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3 && l.topics[1] === ZERO_TOPIC);
  const token = mint?.address;
  if (token) rememberLaunch(pad, token, inp.symbol);

  $('status').innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${esc(token || '')}<br>` +
    `pooled vs USDC on Uniswap V3 · <b>LP locked</b>${+initialBuyEth > 0 ? ` · dev buy ${esc(initialBuyEth)} USDC` : ''}<br>` +
    (token ? `<a href="${pad.site(token)}" target="_blank" rel="noopener">token</a> · <a href="https://dyorv3.org" target="_blank" rel="noopener">dyor</a> · ` : '') +
    `<a href="${pad.explorer}/tx/${esc(hash)}" target="_blank" rel="noopener">launch tx</a>`;
  refreshBalance();
  renderTokenList();
}

// ---------------------------------------------------------------------------
// Uniswap V2 fair launch: deploy fixed-supply token -> approve router -> add
// ETH liquidity with the LP minted straight to the dead address (burnt).
// ---------------------------------------------------------------------------
async function launchUniswap(pad, inp) {
  const cfg = UNISWAP_CHAINS[pad.chainId];
  if (!cfg) throw new Error('Uniswap not configured for this chain');

  const supplyTokens = padSupply(pad); // whole tokens
  if (!(supplyTokens >= 1 && supplyTokens <= 1e18)) throw new Error('supply must be between 1 and 1e18 tokens');
  const supply = parseEther(supplyTokens.toLocaleString('fullwide', { useGrouping: false }));

  const ethRaw = $('uniEth').value.trim();
  const ethLiq = parseEther(ethRaw || '0');
  if (ethLiq <= 0n) throw new Error('enter the amount of ETH to pool as liquidity');

  const pct = Math.min(100, Math.max(1, +($('uniPct').value.trim() || 100)));
  const tokenToPool = (supply * BigInt(Math.round(pct * 100))) / 10000n;
  const slipPct = Math.min(50, Math.max(0, +($('uniSlippage').value.trim() || 2)));
  const bpsKeep = BigInt(Math.round((100 - slipPct) * 100));
  const minToken = (tokenToPool * bpsKeep) / 10000n;
  const minEth = (ethLiq * bpsKeep) / 10000n;

  // fee (buy/sell tax) -> fee wallet. 0% deploys the plain token (no tax code);
  // >0% deploys the tax variant. Only supported on mainnet (deterministic pair).
  const feePct = Math.min(20, Math.max(0, +($('uniFee').value.trim() || 0)));
  const feeBps = Math.round(feePct * 100);
  const feeWallet = $('uniFeeWallet').value.trim();
  if (feeBps > 0) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(feeWallet)) throw new Error('fee wallet is not a valid address');
    if (pad.chainId !== 1) throw new Error('the buy/sell fee token is mainnet-only for now — set fee to 0 on other chains');
  }
  const taxed = feeBps > 0;

  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  const bal = await pub.getBalance({ address: account.address });
  if (bal < ethLiq) throw new Error(`insufficient balance: need ${formatEther(ethLiq)} ETH for liquidity + gas, have ${formatEther(bal)}`);

  // 1) deploy the token (constructor mints full supply to us)
  setStatus('deploying token…');
  const deployHash = taxed
    ? await wallet.deployContract({ abi: FAIRTOKEN_TAX_ABI, bytecode: FAIRTOKEN_TAX_BYTECODE, args: [inp.name, inp.symbol, supply, getAddress(feeWallet), feeBps] })
    : await wallet.deployContract({ abi: FAIRTOKEN_ABI, bytecode: FAIRTOKEN_BYTECODE, args: [inp.name, inp.symbol, supply] });
  setStatus(`deploy tx: ${deployHash}\nwaiting…`);
  const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash, confirmations: 1 });
  if (deployRcpt.status !== 'success' || !deployRcpt.contractAddress) throw new Error('token deploy failed');
  const token = getAddress(deployRcpt.contractAddress);

  // 2) approve the router for the pooled amount
  setStatus('approving router…');
  const approveHash = await wallet.writeContract({
    address: token, abi: FAIRTOKEN_ABI, functionName: 'approve', args: [cfg.router, tokenToPool],
  });
  const approveRcpt = await pub.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
  if (approveRcpt.status !== 'success') throw new Error('approve failed');

  // 3) add liquidity with LP minted to the dead address (permanently burnt)
  setStatus('adding liquidity + burning LP…');
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const lpHash = await wallet.writeContract({
    address: cfg.router, abi: UNISWAP_V2_ROUTER_ABI, functionName: 'addLiquidityETH',
    args: [token, tokenToPool, minToken, minEth, DEAD_ADDRESS, deadline], value: ethLiq,
  });
  setStatus(`liquidity tx: ${lpHash}\nwaiting…`);
  const lpRcpt = await pub.waitForTransactionReceipt({ hash: lpHash, confirmations: 1 });
  if (lpRcpt.status !== 'success') throw new Error('addLiquidityETH reverted: ' + lpHash);

  const pair = await pub.readContract({ address: cfg.factory, abi: UNISWAP_V2_FACTORY_ABI, functionName: 'getPair', args: [token, cfg.weth] }).catch(() => null);
  rememberLaunch(pad, token, inp.symbol);
  $('status').innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${esc(token)}<br>` +
    `${pct}% of supply pooled vs ${esc(formatEther(ethLiq))} ETH · <b>LP burnt</b>` +
    `${pct < 100 ? ` · ${esc(formatEther(supply - tokenToPool))} tokens kept` : ''}` +
    `${taxed ? ` · <b>${feePct}% fee</b> → ${esc(feeWallet.slice(0, 6) + '…' + feeWallet.slice(-4))}` : ''}<br>` +
    `<a href="${cfg.explorer}/token/${esc(token)}" target="_blank" rel="noopener">token</a> · ` +
    (pair ? `<a href="https://app.uniswap.org/explore/tokens/ethereum/${esc(token)}" target="_blank" rel="noopener">uniswap</a> · ` : '') +
    `<a href="${cfg.explorer}/tx/${esc(lpHash)}" target="_blank" rel="noopener">liquidity tx</a>`;
  refreshBalance();
  renderTokenList();
}

// Upload the logo to Rialto's asset store (they host + hash it); returns the URL
// used as image_uri in the intent request.
async function rialtoUploadImage(jwt, blob) {
  const fd = new FormData();
  fd.append('image', new File([blob], 'logo.' + (blob.type === 'image/gif' ? 'gif' : 'png'), { type: blob.type }));
  const r = await fetch(`${RIALTO_API}/assets/images`, {
    method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: fd,
  });
  if (!r.ok) throw new Error(`Rialto image upload failed (${r.status})`);
  const { url } = await r.json();
  if (!url) throw new Error('Rialto image upload returned no url');
  return url;
}

// Ask Rialto to build + sign the launch intent. Returns
// { params, authorization, signature, transaction } where transaction is the
// ready-to-send executeLaunch calldata (to = intent executor, value = 0).
async function rialtoCreateLaunch(jwt, body) {
  const r = await fetch(`${RIALTO_API}/intents/create-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `Rialto launch build failed (${r.status})`;
    try { const e = await r.json(); if (e.message) msg = e.message; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return r.json();
}

async function launchRialto(pad, inp) {
  if (!pad.quoteToken) throw new Error('pick a token to pair against first');
  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  setStatus('authenticating with Rialto (signing login message)...');
  const jwt = await rialtoAuth(pad);

  setStatus('uploading image to Rialto...');
  const imageUrl = await rialtoUploadImage(jwt, logoBlob);

  setStatus('requesting signed launch intent from Rialto...');
  const built = await rialtoCreateLaunch(jwt, {
    request_id: crypto.randomUUID(),
    name: inp.name,
    symbol: inp.symbol,
    image_uri: imageUrl,
    quote_token: pad.quoteToken,
    fee_recipients: [{ wallet: inp.feeRecipient, share_bps: 10000 }],
  });
  const tx = built.transaction;
  if (!tx?.to || !tx?.data) throw new Error('Rialto returned no launch transaction');
  if (tx.to.toLowerCase() !== pad.executor.toLowerCase()) {
    throw new Error('Rialto launch target is not the expected intent executor');
  }

  // read the token/locker the launch will mint via a pre-send eth_call
  let token;
  try {
    const { data } = await pub.call({ to: tx.to, data: tx.data, account });
    if (data && data.length >= 66) token = '0x' + data.slice(26, 66);
  } catch { /* fall back to log parsing after the receipt */ }

  setStatus('sending launch tx...');
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
  setStatus(`tx sent: ${hash}\nwaiting for confirmation...`);
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('tx reverted: ' + hash);

  // if the pre-send call didn't yield the token, recover it from the mint log
  // (the ERC-20 Transfer from the zero address in this receipt)
  if (!token) {
    const ZERO_TOPIC = '0x' + '0'.repeat(64);
    const mint = receipt.logs.find((l) =>
      l.topics[0] === TRANSFER_TOPIC && l.topics[1] === ZERO_TOPIC);
    token = mint?.address;
  }
  if (token) rememberLaunch(pad, token, inp.symbol);

  const el = $('status');
  el.innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${token || ''}<br>` +
    (token && pad.site ? `<a href="${pad.site(token)}" target="_blank" rel="noopener">view on Rialto</a> · ` : '') +
    `<a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx on explorer</a>`;
  return { token, pub, wallet };
}

// populate the pair-against dropdown from Rialto's enabled quote tokens
async function refreshRialtoQuotes(pad) {
  const sel = $('quoteSelect');
  const hint = $('quoteHint');
  sel.innerHTML = '<option>loading…</option>';
  hint.textContent = '';
  try {
    const cfg = await loadRialtoConfig(pad);
    const quotes = (cfg.quotes || []).filter((q) => q.enabled);
    sel.innerHTML = '';
    for (const q of quotes) {
      const o = document.createElement('option');
      o.value = q.address;
      o.textContent = q.symbol + (q.usd_price ? ` (~$${(+q.usd_price).toLocaleString()})` : '');
      sel.appendChild(o);
    }
    // default to the first stock-like quote if present, else config default
    const def = cfg.default_quote || (quotes[0] && quotes[0].address);
    sel.value = pad.quoteToken || def || '';
    pad.quoteToken = sel.value;
    updateRialtoHint(pad);
  } catch (e) {
    sel.innerHTML = '<option>unavailable</option>';
    hint.textContent = e.message;
  }
}

function updateRialtoHint(pad) {
  const cfg = rialtoConfig;
  const q = cfg && (cfg.quotes || []).find((x) => x.address === pad.quoteToken);
  if (!q) { $('quoteHint').textContent = ''; return; }
  const fdv = q.target_initial_fdv_quote_units
    ? (Number(q.target_initial_fdv_quote_units) / 10 ** q.decimals) : null;
  $('quoteHint').textContent =
    `pooled with ${q.symbol}` + (fdv ? ` · starting FDV ≈ ${fdv.toLocaleString()} ${q.symbol}` : '');
}

// ---------------------------------------------------------------------------
// Solana / Meteora DBC (chain logic lazy-loaded from ./solana.js)
// ---------------------------------------------------------------------------
const isSolAddress = (s) => { try { return base58Decode(s).length === 32; } catch { return false; } };

async function uploadJsonToIpfs(obj) {
  const fd = new FormData();
  fd.append('file', new File([JSON.stringify(obj)], 'metadata.json', { type: 'application/json' }));
  const r = await fetch(IPFS_ADD, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('IPFS metadata upload failed (' + r.status + ')');
  const { Hash } = await r.json();
  if (!Hash) throw new Error('IPFS metadata upload returned no hash');
  return Hash;
}

// resolve the selected quote mint (SOL / USDC / custom) to its address
function solQuoteMint(pad) {
  const sel = pad.quoteSel;
  if (sel === 'CUSTOM') {
    const m = $('solCustomMint').value.trim();
    if (!isSolAddress(m)) throw new Error('enter a valid custom quote mint address');
    return m;
  }
  return SOL_QUOTES[sel].mint;
}

/// Fill the curve fields with pump.fun's economics, priced against the selected
/// quote: it opens at the 30-SOL equivalent and migrates at the 85-SOL one.
///
/// Those are not two independent knobs. DBC derives the curve from supply, the
/// share kept for migration, and the threshold — so setting 20.69% and the
/// 85-equivalent puts the start exactly at the 30-equivalent, which is how
/// pump's own numbers relate. Priced live through Jupiter, so a stock or memecoin
/// quote gets today's rate rather than a stale constant.
async function applyPumpEconomics(pad) {
  const hint = $('solQuoteHint');
  try {
    const quoteMint = solQuoteMint(pad);
    hint.textContent = 'pricing pump.fun economics against this quote\u2026';
    const { pumpEconomics } = await import('./solana.js');
    const e = await pumpEconomics(pad.rpc, quoteMint);
    $('solSupply').value = String(e.totalSupply);
    $('solMigPct').value = String(e.pctSupplyOnMigration);
    $('solMigThreshold').value = String(e.migrationThreshold);
    const sym = SOL_QUOTES[pad.quoteSel]?.symbol || 'quote';
    hint.innerHTML = `<span class="ok">pump.fun economics</span> \u00b7 opens at ~`
      + `${e.startEquivalent.toLocaleString()} ${esc(sym)} (30 SOL equivalent), migrates at `
      + `${e.migrationThreshold.toLocaleString()} ${esc(sym)} (85 SOL equivalent)`;
  } catch (err) {
    hint.innerHTML = `<span class="err">${esc(err?.message || String(err))}</span>`;
  }
}

function solParamsFromUI(pad) {
  const num = (id, name) => {
    const v = +($(id).value.trim().replace(/,/g, ''));
    if (!(v > 0)) throw new Error(`${name} must be a positive number`);
    return v;
  };
  const feeWallet = $('solFeeWallet').value.trim();
  if (!isSolAddress(feeWallet)) throw new Error('fee wallet is not a valid Solana address');
  const migRaw = $('solMigThreshold').value.trim().replace(/,/g, '');
  let migrationThreshold = +migRaw;
  if (!migRaw) {
    const def = SOL_QUOTES[pad.quoteSel]?.defaultThreshold;
    if (!def) throw new Error('set a migration threshold, or hit PUMP ECONOMICS to price it');
    migrationThreshold = def;
  }
  if (!(migrationThreshold > 0)) throw new Error('migration threshold must be positive');
  return {
    totalSupply: num('solSupply', 'total supply'),
    baseDecimals: 6,
    feeBps: num('solFeeBps', 'fee bps'),
    pctSupplyOnMigration: num('solMigPct', '% on migration'),
    migrationThreshold,
    feeClaimer: feeWallet,
  };
}

// ---------------------------------------------------------------------------
// Armed pump.fun presets
//
// The point is speed on the day: arming uploads the image and metadata to IPFS
// straight away and stores the resulting URI, so firing is nothing but the
// on-chain transaction. A preset also remembers which quote it wants, and a
// quote that is not whitelisted yet is kept rather than rejected — that is the
// whole point of arming something before pump ships the pairing.
// ---------------------------------------------------------------------------
const PUMP_ARMED_KEY = 'pump.armed.v1';
const loadArmed = () => { try { return JSON.parse(localStorage.getItem(PUMP_ARMED_KEY) || '[]'); } catch { return []; } };
const saveArmed = (list) => localStorage.setItem(PUMP_ARMED_KEY, JSON.stringify(list));

function renderArmed() {
  const list = loadArmed();
  const box = $('pumpArmedList');
  if (!list.length) { box.innerHTML = '<span class="hint">nothing armed yet</span>'; return; }
  box.innerHTML = list.map((a, i) => {
    const pair = a.quoteMint ? esc(a.quoteLabel || a.quoteMint.slice(0, 6) + '\u2026') : 'SOL';
    const on = pumpWatchers.has(a.id);
    return '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:6px">'
      + '<div class="row" style="align-items:center;gap:8px">'
      + '<div style="flex:1"><b>' + esc(a.symbol) + '</b> \u00b7 ' + esc(a.name)
      + ' <span class="hint">\u2192 ' + pair + (a.devBuy && +a.devBuy > 0 ? ' \u00b7 dev ' + esc(a.devBuy) : '')
      + (a.cashback !== false ? ' \u00b7 cashback' : '')
      + (a.feesToHolders ? ' \u00b7 fees\u2192holders' : '') + '</span></div>'
      + '<button class="btn ' + (on ? 'sell' : 'secondary') + '" data-watch="' + i + '" style="margin-top:0;flex:0 0 100px;padding:7px">'
      + (on ? 'STOP' : 'WATCH') + '</button>'
      + '<button class="btn" data-fire="' + i + '" style="margin-top:0;flex:0 0 80px;padding:7px">FIRE</button>'
      + '<button class="btn secondary" data-drop="' + i + '" style="margin-top:0;flex:0 0 40px;padding:7px">\u00d7</button>'
      + '</div>'
      + '<div class="hint" id="pumpWatch-' + esc(a.id) + '" style="font-size:11px">' + esc(pumpWatchStatus.get(a.id) || '') + '</div>'
      + '</div>';
  }).join('');
  box.querySelectorAll('[data-fire]').forEach((b) => { b.onclick = () => pumpFire(+b.dataset.fire); });
  box.querySelectorAll('[data-watch]').forEach((b) => { b.onclick = () => pumpToggleWatch(+b.dataset.watch); });
  box.querySelectorAll('[data-drop]').forEach((b) => {
    b.onclick = () => {
      const l = loadArmed();
      const [gone] = l.splice(+b.dataset.drop, 1);
      if (gone) pumpStopWatch(gone.id);
      saveArmed(l); renderArmed();
    };
  });
}

/// Arm the current form: upload now, so firing later is one transaction.
async function pumpArm(pad) {
  const out = $('pumpStatusOut');
  try {
    const name = $('name').value.trim();
    const symbol = $('symbol').value.trim();
    if (!name || !symbol) throw new Error('name and ticker are required');
    if (!logoBlob) throw new Error('add an image first — it is uploaded now so firing is instant');
    out.textContent = 'uploading image + metadata to IPFS\u2026';
    const imgHash = (await uploadToIpfs(logoBlob)).replace('ipfs://', '');
    const metaHash = await uploadJsonToIpfs({
      name, symbol, description: $('desc').value.trim() || DEFAULT_DESC,
      image: IPFS_GW(imgHash),
      extensions: { twitter: $('twitter').value.trim(), website: $('website').value.trim() },
    });
    // a pasted contract wins over the dropdown, so you can arm against a pairing
    // pump has not enabled yet
    const sel = $('pumpQuote');
    const custom = $('pumpQuoteCustom').value.trim();
    const quoteMint = pumpQuoteMint();
    const list = loadArmed();
    list.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      name, symbol, uri: IPFS_GW(metaHash),
      devBuy: $('pumpDevBuy').value.trim() || '0',
      cashback: $('pumpCashback').checked,
      feesToHolders: $('pumpFeesToHolders').checked,
      quoteMint,
      quoteLabel: custom ? (custom.slice(0, 6) + '\u2026') : (sel.value ? (sel.options[sel.selectedIndex]?.text || '') : 'SOL'),
    });
    saveArmed(list);
    renderArmed();
    out.innerHTML = '<span class="ok">ARMED</span> ' + esc(symbol) + ' \u2014 metadata is on IPFS, firing is one transaction';
  } catch (e) {
    out.innerHTML = '<span class="err">' + esc(e?.message || String(e)) + '</span>';
  }
}

/// Which contract to pair against: a pasted mint wins over the dropdown, so you
/// can launch or arm against a quote pump has not listed yet.
function pumpQuoteMint() {
  const custom = $('pumpQuoteCustom').value.trim();
  if (custom) {
    if (!isSolAddress(custom)) throw new Error('that pair contract is not a valid mint address');
    return custom;
  }
  return $('pumpQuote').value || '';
}

// A watcher polls by SIMULATING the launch, which is free — no gas, no signature,
// no transaction — and only sends once the chain says it would succeed. That is
// what makes it safe to point one at a contract pump has not enabled yet: it just
// keeps answering UnsupportedQuoteMint until the day they do.
const pumpWatchers = new Map();     // preset id -> interval handle
const pumpWatchStatus = new Map();  // preset id -> last line shown under it
const PUMP_WATCH_MS = 12000;

function pumpSetWatchStatus(id, msg) {
  pumpWatchStatus.set(id, msg);
  const el = document.getElementById('pumpWatch-' + id);
  if (el) el.textContent = msg;
}

function pumpStopWatch(id) {
  const h = pumpWatchers.get(id);
  if (h) clearInterval(h);
  pumpWatchers.delete(id);
}

function pumpToggleWatch(index) {
  const a = loadArmed()[index];
  if (!a) return;
  if (pumpWatchers.has(a.id)) {
    pumpStopWatch(a.id);
    pumpSetWatchStatus(a.id, 'watch stopped');
    renderArmed();
    return;
  }
  if (!solKeyB58) { pumpSetWatchStatus(a.id, 'no SOL key loaded'); renderArmed(); return; }
  const tick = async () => {
    // the preset may have been fired or deleted since the last tick
    if (!loadArmed().some((x) => x.id === a.id)) { pumpStopWatch(a.id); return; }
    try {
      const pad = PADS.find((x) => x.id === 'pump-sol');
      const { pumpProbe } = await import('./solana.js');
      const r = await pumpProbe({
        rpcUrl: pad.rpc, payerPubkey: solPubkeyFromSecret(solKeyB58),
        name: a.name, symbol: a.symbol, uri: a.uri,
        devBuySol: a.devBuy, cashback: a.cashback !== false,
        feesToHolders: !!a.feesToHolders,
        quoteMint: a.quoteMint || undefined,
      });
      const at = new Date().toLocaleTimeString();
      if (!r.ready) { pumpSetWatchStatus(a.id, `${at} \u00b7 not yet \u2014 ${r.reason}`); return; }
      // ready: stop first so a slow launch cannot be fired twice
      pumpStopWatch(a.id);
      pumpSetWatchStatus(a.id, `${at} \u00b7 READY \u2014 firing\u2026`);
      renderArmed();
      await pumpFire(loadArmed().findIndex((x) => x.id === a.id));
    } catch (e) {
      pumpSetWatchStatus(a.id, 'probe failed: ' + (e?.message || String(e)));
    }
  };
  pumpWatchers.set(a.id, setInterval(tick, PUMP_WATCH_MS));
  pumpSetWatchStatus(a.id, 'watching\u2026 simulating every ' + (PUMP_WATCH_MS / 1000) + 's');
  renderArmed();
  tick();
}

/// Fire an armed preset. Nothing is uploaded here — only the launch.
async function pumpFire(index) {
  const pad = PADS.find((x) => x.id === 'pump-sol');
  const a = loadArmed()[index];
  const out = $('pumpStatusOut');
  if (!a) return;
  if (!solKeyB58) { out.innerHTML = '<span class="err">no SOL key loaded</span>'; return; }
  try {
    setStatus('firing ' + a.symbol + '\u2026');
    const { launchPump } = await import('./solana.js');
    const res = await launchPump({
      rpcUrl: pad.rpc, secretKey: solKeyB58,
      name: a.name, symbol: a.symbol, uri: a.uri,
      devBuySol: a.devBuy, cashback: a.cashback !== false,
      feesToHolders: !!a.feesToHolders,
      quoteMint: a.quoteMint || undefined,
      onStatus: (m) => setStatus(m),
    });
    rememberLaunch(pad, res.mint, a.symbol);
    $('status').innerHTML =
      '<span style="color:var(--accent)">LAUNCHED \u2713</span> ' + res.mint + '<br>'
      + '<a href="' + pad.site(res.mint) + '" target="_blank" rel="noopener">on pump.fun</a>'
      + (res.sig ? ' \u00b7 <a href="' + pad.explorer + '/tx/' + res.sig + '" target="_blank" rel="noopener">launch tx</a>' : '');
    refreshBalance();
    renderTokenList();
  } catch (e) {
    setStatus(e?.message || String(e), true);
  }
}

/// Read pump.fun's Global account and show what can actually be paired against
/// right now.
///
/// The quote list is deliberately live rather than hardcoded. pump whitelists
/// non-SOL quotes with an admin-only add_quote_mint instruction, so a stock pair
/// would land in this account the moment they add it and show up here with no
/// code change. What is still missing on their side is a create instruction that
/// accepts a quote — every deployed create path opens a native-SOL curve — so
/// this also says so plainly instead of offering a pairing that cannot be built.
async function pumpCheckPairs(pad) {
  const out = $('pumpStatusOut');
  const btn = $('pumpCheckBtn');
  btn.disabled = true;
  out.textContent = 'reading pump.fun global config\u2026';
  try {
    const { pumpStatus } = await import('./solana.js');
    const g = await pumpStatus(pad.rpc);
    const sel = $('pumpQuote');
    const prev = sel.value;
    const buildOpts = (names) => g.whitelistedQuotes
      .map((q) => '<option value="' + esc(q.mint) + '">'
        + esc(names[q.mint] || (q.mint.slice(0, 6) + '\u2026')) + ' (' + q.decimals + 'dp)</option>')
      .join('');
    const names = {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
      XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W: 'SPYx',
      XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1: 'CRCLx',
      XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB: 'TSLAx',
      SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3: 'SKHY',
      Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: 'NVDAx',
    };
    sel.innerHTML = '<option value="">SOL (native)</option>' + buildOpts(names);
    if (prev) sel.value = prev;
    const listed = g.whitelistedQuotes.map((q) => names[q.mint] || (q.mint.slice(0, 8) + '\u2026')).join(', ') || 'none';
    out.innerHTML =
      '<span class="ok">create_v2 ' + (g.createV2Enabled ? 'enabled' : 'DISABLED') + '</span> \u00b7 '
      + 'fee ' + (Number(g.feeBasisPoints) / 100) + '% + creator ' + (Number(g.creatorFeeBasisPoints) / 100) + '%<br>'
      + 'whitelisted quotes: <b>' + esc(listed) + '</b><br>'
      + 'A quote is passed to create_v2 as three extra accounts, so anything listed here is launchable now. '
      + 'Re-run when pump ships stock pairs \u2014 a new quote lands in this account first.';
  } catch (e) {
    out.innerHTML = '<span class="err">' + esc(e?.message || String(e)) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

// resolve the Raydium quote mint from its dropdown (preset, scanned or custom)
function raydiumQuoteMint(pad) {
  const sel = $('raydiumQuoteSelect').value;
  const list = raydiumQuoteList(pad);
  const q = list.find((x) => x.symbol === sel) || list[0];
  if (q.mint === 'custom') {
    const m = $('raydiumQuoteCustom').value.trim();
    if (!isSolAddress(m)) throw new Error('enter a valid custom quote mint address');
    return m;
  }
  return q.mint;
}

async function launchSol(pad, inp) {
  if (!solKeyB58) throw new Error('no SOL key stored — re-import your wallet with a SOL private key');

  setStatus('uploading image + metadata to IPFS...');
  const imgHash = (await uploadToIpfs(logoBlob)).replace('ipfs://', '');
  const metaHash = await uploadJsonToIpfs({
    name: inp.name, symbol: inp.symbol, description: inp.description,
    image: IPFS_GW(imgHash),
    ...(inp.twitter || inp.website ? { extensions: { twitter: inp.twitter, website: inp.website } } : {}),
  });
  const uri = IPFS_GW(metaHash);

  if (pad.family === 'pump') {
    const devBuySol = $('pumpDevBuy').value.trim() || '0';
    setStatus('loading Solana module...');
    const { launchPump } = await import('./solana.js');
    const res = await launchPump({
      rpcUrl: pad.rpc, secretKey: solKeyB58,
      name: inp.name, symbol: inp.symbol, uri, devBuySol,
      cashback: $('pumpCashback').checked,
      feesToHolders: $('pumpFeesToHolders').checked,
      quoteMint: pumpQuoteMint() || undefined,
      onStatus: (m) => setStatus(m),
    });
    rememberLaunch(pad, res.mint, inp.symbol);
    $('status').innerHTML =
      `<span style="color:var(--accent)">LAUNCHED \u2713</span> ${res.mint}<br>` +
      `<a href="${pad.site(res.mint)}" target="_blank" rel="noopener">on pump.fun</a>` +
      (res.sig ? ` \u00b7 <a href="${pad.explorer}/tx/${res.sig}" target="_blank" rel="noopener">launch tx</a>` : '');
    refreshBalance();
    renderTokenList();
    return;
  }

  // Raydium LaunchLab path
  if (pad.family === 'raydium') {
    const quoteMint = raydiumQuoteMint(pad);
    const buyAmountUi = $('raydiumDevBuy').value.trim() || '0';
    setStatus('loading Solana module...');
    const { launchRaydium } = await import('./solana.js');
    const res = await launchRaydium({
      rpcUrl: pad.rpc, secretKey: solKeyB58, quoteMint,
      name: inp.name, symbol: inp.symbol, uri, buyAmountUi,
      migrateType: 'cpmm', platformId: pad.platformId,
      // pads whose platform pins a Token-2022 transfer fee (StonkFun) declare it
      token2022: !!pad.token2022,
      transferFeeBps: pad.token2022 ? +($('raydiumFeeBps')?.value || pad.transferFeeBps || 100) : undefined,
      onStatus: (m) => setStatus(m),
    });
    rememberLaunch(pad, res.mint, inp.symbol);
    $('status').innerHTML =
      `<span style="color:var(--accent)">LAUNCHED ✓</span> ${res.mint}<br>` +
      `<a href="${pad.site(res.mint)}" target="_blank" rel="noopener">token on solscan</a>` +
      (res.sig ? ` · <a href="${pad.explorer}/tx/${res.sig}" target="_blank" rel="noopener">launch tx</a>` : '');
    refreshBalance();
    renderTokenList();
    return;
  }

  // Custom single-sided CLMM curve path
  if (pad.family === 'clmm') {
    const q = pad.quotes.find((x) => x.symbol === $('clmmQuoteSelect').value) || pad.quotes[0];
    const quote = q.mint === 'custom' ? $('clmmQuoteCustom').value.trim() : q.mint;
    if (!isSolAddress(quote)) throw new Error('enter a valid quote mint address');
    const supplyTokens = +($('clmmSupply').value.trim().replace(/,/g, '')) || 1000000000;
    const devBuyQuote = +($('clmmDevBuy').value.trim() || '0');
    const targetPct = +($('clmmTargetPct').value.trim() || '15');
    const feeRecipientRaw = $('clmmFeeRecipient').value.trim();
    if (feeRecipientRaw && !isSolAddress(feeRecipientRaw)) throw new Error('fee recipient is not a valid Solana address');
    setStatus('loading Solana module...');
    const { launchClmmCurve } = await import('./solana.js');
    const res = await launchClmmCurve({
      rpcUrl: pad.rpc, secretKey: solKeyB58, quoteMint: quote,
      name: inp.name, symbol: inp.symbol, uri, supplyTokens, decimals: 6,
      devBuyQuote, targetPct, feeRecipient: feeRecipientRaw || null,
      onStatus: (m) => setStatus(m),
    });
    rememberLaunch(pad, res.mint, inp.symbol);
    $('status').innerHTML =
      `<span style="color:var(--accent)">LAUNCHED ✓</span> ${res.mint}<br>` +
      `<a href="${pad.site(res.mint)}" target="_blank" rel="noopener">token on solscan</a> · ` +
      `<a href="https://raydium.io/clmm/create-position/?pool_id=${res.poolId}" target="_blank" rel="noopener">CLMM pool</a>` +
      (res.buySig ? ` · dev buy ✓` : '');
    refreshBalance();
    renderTokenList();
    return;
  }

  // Meteora DBC path
  const quoteMint = solQuoteMint(pad);
  const params = solParamsFromUI(pad);
  setStatus('loading Solana module...');
  const { launchMeteora } = await import('./solana.js');
  const res = await launchMeteora({
    rpcUrl: pad.rpc, secretKey: solKeyB58, quoteMint,
    name: inp.name, symbol: inp.symbol, uri, params,
    onStatus: (m) => setStatus(m),
  });

  rememberLaunch(pad, res.mint, inp.symbol);
  $('status').innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${res.mint}<br>` +
    `<a href="${pad.site(res.mint)}" target="_blank" rel="noopener">token on solscan</a> · ` +
    `<a href="${pad.explorer}/tx/${res.poolSig}" target="_blank" rel="noopener">pool tx</a>`;
  refreshBalance();
  renderTokenList();
}

// Pons v1 launch — PonsLaunchFactory.launchToken(params, launchConfigId, dexId, salt).
// Direct DEX launch paired vs WETH (config 0). Tickers can be arbitrarily long.
const PONS_V1_FACTORY_ABI = [
  { type: 'function', name: 'launchEnabled', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'launchFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'whitelistedLaunchers', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  {
    type: 'function', name: 'launchToken', stateMutability: 'payable',
    inputs: [
      { name: 'params', type: 'tuple', components: [
        { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
        { name: 'logo', type: 'string' }, { name: 'description', type: 'string' },
        { name: 'socials', type: 'tuple', components: [
          { name: 'twitter', type: 'string' }, { name: 'telegram', type: 'string' },
          { name: 'discord', type: 'string' }, { name: 'website', type: 'string' }, { name: 'farcaster', type: 'string' },
        ] },
        { name: 'feeWallet', type: 'address' },
      ] },
      { name: 'launchConfigId', type: 'uint256' }, { name: 'dexId', type: 'uint256' }, { name: 'salt', type: 'bytes32' },
    ],
    outputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'function', name: 'predictTokenAddress', stateMutability: 'view',
    inputs: [
      { name: 'params', type: 'tuple', components: [
        { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
        { name: 'logo', type: 'string' }, { name: 'description', type: 'string' },
        { name: 'socials', type: 'tuple', components: [
          { name: 'twitter', type: 'string' }, { name: 'telegram', type: 'string' },
          { name: 'discord', type: 'string' }, { name: 'website', type: 'string' }, { name: 'farcaster', type: 'string' },
        ] },
        { name: 'feeWallet', type: 'address' },
      ] },
      { name: 'launchConfigId', type: 'uint256' }, { name: 'dexId', type: 'uint256' },
      { name: 'salt', type: 'bytes32' }, { name: 'deployer', type: 'address' },
    ],
    outputs: [{ type: 'address' }],
  },
];

// ---------------------------------------------------------------------------
// Pools — open-to-everyone Uniswap-v4 launchpad (LiquidityLauncher).
// ---------------------------------------------------------------------------
const POOLS_LAUNCHER_ABI = [
  { type: 'function', name: 'createToken', stateMutability: 'nonpayable',
    inputs: [
      { name: 'factory', type: 'address' }, { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
      { name: 'decimals', type: 'uint8' }, { name: 'initialSupply', type: 'uint128' },
      { name: 'recipient', type: 'address' }, { name: 'tokenData', type: 'bytes' },
    ], outputs: [{ name: 'token', type: 'address' }] },
  { type: 'function', name: 'distributeToken', stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'distribution', type: 'tuple', components: [
        { name: 'strategy', type: 'address' }, { name: 'amount', type: 'uint128' }, { name: 'configData', type: 'bytes' },
      ] },
      { name: 'salt', type: 'bytes32' },
    ], outputs: [] },
  { type: 'event', name: 'TokenCreated', inputs: [{ name: 'tokenAddress', type: 'address', indexed: false }] },
];
// v4 hop-path swap router (used for the optional dev buy)
const POOLS_ROUTER_ABI = [{
  type: 'function', name: 'swap', stateMutability: 'payable',
  inputs: [
    { name: 'hops', type: 'tuple[]', components: [
      { name: 'kind', type: 'uint8' }, { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'c3', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
      { name: 'hooks', type: 'address' }, { name: 'hookData', type: 'bytes' }, { name: 'a9', type: 'address' }, { name: 'b10', type: 'bytes32' },
    ] },
    { name: 'recipient', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'minOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ], outputs: [],
}];
const POOLS_TOKEN_DATA_TUPLE = [{ type: 'tuple', components: [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes' }] }];
// deterministic token-address prediction (needed before the token exists, so its
// address can be baked into the atomic launch+buy calldata)
const POOLS_GRAFFITI_ABI = [{ type: 'function', name: 'getGraffiti', stateMutability: 'pure', inputs: [{ type: 'address' }], outputs: [{ type: 'bytes32' }] }];
const POOLS_PREDICT_ABI = [{ type: 'function', name: 'getUERC20Address', stateMutability: 'view', inputs: [{ type: 'string' }, { type: 'string' }, { type: 'uint8' }, { type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'address' }] }];
// creator fee claiming — every launch mints you a "Fee Beneficiary" NFT (pad.feeNft)
// whose id equals the LP position id; collectFees([ids]) on pad.feeHolder sweeps the
// 0.25% swap fees your single-sided position has earned. Position id is captured from
// the launch receipt (below) so claiming never needs a slow log scan.
const POOLS_COLLECT_ABI = [{ type: 'function', name: 'collectFees', stateMutability: 'nonpayable', inputs: [{ name: 'ids', type: 'uint256[]' }], outputs: [] }];

// Pull the LP position id from a launch receipt: the Fee Beneficiary NFT mint
// (Transfer 0x0 -> you, tokenId in topics[3]). Returns a decimal string or null.
function poolsPositionIdFromReceipt(pad, receipt) {
  const ZT = '0x' + '0'.repeat(64);
  const me = account.address.toLowerCase();
  const mint = receipt.logs.find((l) =>
    l.address.toLowerCase() === pad.feeNft.toLowerCase()
    && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 4
    && l.topics[1] === ZT && ('0x' + l.topics[2].slice(26)).toLowerCase() === me);
  return mint ? BigInt(mint.topics[3]).toString() : null;
}

// every Pools liquidity strategy we've seen — the distributeToken tx moves supply
// into one of these, and that same tx mints your Fee Beneficiary NFT
const POOLS_STRATEGIES = [
  '0xcE57498D3474DCC244dFb6710fFbE6D4441cD2b2', // current live default
  '0x60D73b21cDf2EA846ab3d58699BBbb8F29d72491', // earlier strategy (older launches)
];

// Backfill: find a token's position id from chain (for launches recorded before we
// started capturing it). Search the token's transfer into any known strategy, then
// read the Fee Beneficiary mint from that tx — works across strategy versions.
async function findPoolsPositionId(pad, token) {
  const pub = publicClientFor(pad);
  for (const strat of POOLS_STRATEGIES) {
    const stratTopic = '0x' + '0'.repeat(24) + strat.slice(2).toLowerCase();
    const logs = await pub.getLogs({ address: getAddress(token), topics: [TRANSFER_TOPIC, null, stratTopic], fromBlock: pad.startBlock, toBlock: 'latest' }).catch(() => []);
    // dedupe by tx and check the earliest ones — the distributeToken (which mints your
    // Fee Beneficiary NFT) is right after createToken; later txs are just trades
    const txs = [...new Set(logs.map((l) => l.transactionHash))].slice(0, 20);
    for (const hash of txs) {
      const r = await pub.getTransactionReceipt({ hash }).catch(() => null);
      const id = r && poolsPositionIdFromReceipt(pad, r);
      if (id) return id;
    }
  }
  return null;
}

// Pools launch via the canonical LiquidityLauncher 0x0000ffff — the one Axiom AND gmgn
// both label "pools". One tx: launcher.multicall([createToken, distributeToken,
// distributeWithNative]). distributeToken opens the fee-2500 / tickSpacing-25 v4 pool;
// distributeWithNative does the ATOMIC dev buy in the same tx (no snipe gap). devBuy=0
// launches the pool only. Recipe reverse-engineered + validated live; see poolsAtomic.js.
async function launchPools(pad, { name, symbol, logo, description, twitter, website, devBuy }) {
  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });
  const buy = devBuy && devBuy > 0n ? devBuy : 0n;
  // slot1 (website) is the single link slot — prefer the tweet/twitter link so it renders
  const tokenData = buildPoolsTokenData({ logo, description, link: twitter || website });

  // 1) predict the token address (recipient = launcher, salt = graffiti(you)) so it can
  //    be baked into the calldata before it exists on-chain
  setStatus('predicting token address…');
  const gsalt = await pub.readContract({ address: pad.launcher, abi: POOLS_GRAFFITI_ABI, functionName: 'getGraffiti', args: [getAddress(account.address)] });
  const token = getAddress(await pub.readContract({ address: pad.uercFactory, abi: POOLS_PREDICT_ABI, functionName: 'getUERC20Address', args: [name, symbol, 18, getAddress(pad.launcher), gsalt] }));

  // 2) build the launcher multicall (createToken + open pool + atomic dev buy if any)
  const nonce = `${name}-${symbol}-${account.address}-${Date.now()}`;
  const data = buildPoolsLaunch({
    name, symbol, tokenData, token, creator: getAddress(account.address), devBuy: buy,
    dtSalt: keccak256(stringToBytes(`${nonce}-dt`)),
    dwnSalt: keccak256(stringToBytes(`${nonce}-buy`)),
  });

  // 3) SIMULATE first — if it reverts, nothing is sent (no void)
  setStatus(buy > 0n ? 'simulating atomic launch + buy…' : 'simulating launch…');
  await pub.call({ account: getAddress(account.address), to: getAddress(pad.launcher), data, value: buy });

  // 4) send the single tx
  setStatus(buy > 0n ? `atomic launch + dev buy ${formatEther(buy)} ETH…` : 'launching…');
  const hash = await wallet.sendTransaction({ to: getAddress(pad.launcher), data, value: buy });
  const rcpt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (rcpt.status !== 'success') throw new Error('launch reverted');
  rememberLaunch(pad, token, symbol, poolsPositionIdFromReceipt(pad, rcpt));

  let buyNote = '';
  if (buy > 0n) {
    let bought = 0n;
    try { bought = await pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [account.address] }); } catch { /* ignore */ }
    buyNote = bought > 0n
      ? ` · dev buy ✓ (${formatEther(buy)} ETH → ${(Number(bought / 10n ** 15n) / 1000).toLocaleString()} tokens)`
      : ' · <span class="err">dev buy: received 0 (check the pool)</span>';
  }
  $('status').innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓${buy > 0n ? ' (atomic)' : ''}</span> ${token}${buyNote}<br>` +
    `<a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">launch tx</a>`;
  return { token, pub, wallet };
}

// resolve the Pons pair token from the UI (preset symbol or a custom address)
function resolvePonsPair(pad) {
  const sel = document.getElementById('ponsQuoteSelect').value;
  if (sel === 'custom…' || sel === 'custom') {
    const c = document.getElementById('ponsQuoteCustom').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(c)) throw new Error('enter a valid approved pair token address (0x…)');
    return { address: getAddress(c), symbol: 'custom' };
  }
  const q = (pad.quotes || []).find((x) => x.symbol === sel) || (pad.quotes || [])[0];
  return { address: getAddress(q.address), symbol: q.symbol };
}

// Pons v2 — bonding-curve launch on the (re-enabled) PonsV2LaunchFactory, paired
// vs an approved stock. Dev buy runs on the returned curve (ERC-20 pair: approve
// then buy). VOID-SAFETY: simulate-first + verify the pair is approved.
async function launchPonsV2(pad, inp) {
  // fail fast with a readable message instead of a raw MetadataTooLong revert
  checkPonsV2Metadata({
    name: inp.name, symbol: inp.symbol, logo: inp.logo, description: inp.description,
    twitter: inp.twitter, website: inp.website,
  });
  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });
  const pairAddr = inp.pair.address;

  setStatus('running pre-launch checks...');
  const [enabled, fee, maxTax, approved] = await Promise.all([
    pub.readContract({ address: pad.factory, abi: PONS_V2_FACTORY_ABI, functionName: 'launchEnabled' }),
    pub.readContract({ address: pad.factory, abi: PONS_V2_FACTORY_ABI, functionName: 'launchFee' }),
    pub.readContract({ address: pad.factory, abi: PONS_V2_FACTORY_ABI, functionName: 'maxCreatorTaxBps' }).catch(() => 10000n),
    pub.readContract({ address: pad.factory, abi: PONS_V2_FACTORY_ABI, functionName: 'approvedPairTokens', args: [pairAddr] }).catch(() => true),
  ]);
  if (!enabled) throw new Error('pons v2 launches are currently paused');
  // native ETH (0x0) is a distinct pair handled specially by the factory (not on the
  // approvedPairTokens allowlist); stocks must be approved.
  const isNative = pairAddr === ZERO_ADDR;
  if (!isNative && !approved) throw new Error(`${inp.pair.symbol} is not an approved Pons v2 pair — pick ETH / NVDA / AAPL / GME`);
  const creatorTaxBps = Math.min(pad.creatorTaxBps || 0, Number(maxTax));

  const pairDecimals = isNative ? 18 : await pub.readContract({ address: pairAddr, abi: ERC20, functionName: 'decimals' });
  const devBuyRaw = parseUnits(String(inp.devBuyStr || '0'), pairDecimals);

  const expectedEconomics = await pub.readContract({
    address: pad.factory, abi: PONS_V2_FACTORY_ABI, functionName: 'previewLaunchEconomics', args: [pad.launchConfigId, pairAddr],
  });

  const bal = await pub.getBalance({ address: account.address });
  if (isNative) {
    // launch fee + the native dev buy both come out of ETH
    if (bal < fee + devBuyRaw) throw new Error(`insufficient ETH: need ${formatEther(fee + devBuyRaw)}+gas, have ${formatEther(bal)}`);
  } else {
    if (bal < fee) throw new Error(`insufficient ${pad.nativeSymbol} for the launch fee: need ${formatEther(fee)}+gas, have ${formatEther(bal)}`);
    if (devBuyRaw > 0n) {
      const held = await pub.readContract({ address: pairAddr, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
      if (held < devBuyRaw) throw new Error(`dev buy needs ${inp.devBuyStr} ${inp.pair.symbol} in your wallet (have ${formatUnits(held, pairDecimals)})`);
    }
  }

  const params = {
    name: inp.name, symbol: inp.symbol, logo: inp.logo, description: inp.description,
    socials: { twitter: inp.twitter, telegram: '', discord: '', website: inp.website, farcaster: '' },
    creatorFeeRecipient: inp.feeRecipient,
    creatorTaxBps, buybackEnabled: inp.buyback !== undefined ? !!inp.buyback : !!pad.buybackEnabled,
    expectedEconomics,
    salt: keccak256(stringToBytes(`${inp.name}-${inp.symbol}-${account.address}-${Date.now()}`)),
  };
  // exempt the launcher + your whitelisted wallets from the 99%/3s snipe tax. dedupe
  // in case the connected wallet is already in the list.
  const exemptions = [...new Set([account.address.toLowerCase(), ...PONS_V2_TAX_WHITELIST.map((a) => a.toLowerCase())])];

  let token, curve, hash, buyNote = '';

  if (devBuyRaw > 0n) {
    // ATOMIC launch + dev buy in ONE tx via PonsV2LaunchAndBuy — no gap for snipers.
    // ERC-20 pair: approve the pair token to the forwarder first (it pulls it).
    if (!isNative) {
      const alw = await pub.readContract({ address: pairAddr, abi: ERC20, functionName: 'allowance', args: [account.address, PONS_V2_FORWARDER_ADDR] });
      if (alw < devBuyRaw) {
        setStatus(`approving ${inp.pair.symbol} to the launcher…`);
        const ah = await wallet.writeContract({ address: pairAddr, abi: ERC20, functionName: 'approve', args: [PONS_V2_FORWARDER_ADDR, devBuyRaw] });
        await pub.waitForTransactionReceipt({ hash: ah, confirmations: 1 });
      }
    }
    const value = isNative ? fee + devBuyRaw : fee; // native: fee + buy; ERC-20: fee only (quote pulled)
    const args = [params, pad.launchConfigId, pairAddr, devBuyRaw, 0n, account.address, exemptions];
    setStatus('simulating atomic launch + dev buy…');
    const { result } = await pub.simulateContract({ address: PONS_V2_FORWARDER_ADDR, abi: PONS_V2_FORWARDER_ABI, functionName: 'launchAndBuy', args, value, account });
    [token, curve] = result;
    setStatus('sending atomic launch + dev buy tx…');
    hash = await wallet.writeContract({ address: PONS_V2_FORWARDER_ADDR, abi: PONS_V2_FORWARDER_ABI, functionName: 'launchAndBuy', args, value });
    buyNote = ` · dev buy ✓ (${inp.devBuyStr} ${inp.pair.symbol}, atomic)`;
  } else {
    // no dev buy — plain launchToken
    const args = [params, pad.launchConfigId, pairAddr, exemptions];
    setStatus('simulating launch...');
    const { result } = await pub.simulateContract({ address: pad.factory, abi: PONS_V2_FACTORY_ABI, functionName: 'launchToken', args, value: fee, account });
    [token, curve] = result;
    setStatus('sending launch tx...');
    hash = await wallet.writeContract({ address: pad.factory, abi: PONS_V2_FACTORY_ABI, functionName: 'launchToken', args, value: fee });
  }

  setStatus(`tx sent: ${hash}\nwaiting for confirmation...`);
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('tx reverted: ' + hash);
  rememberLaunch(pad, token, inp.symbol);

  $('status').innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${token}${buyNote}<br>` +
    `<a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx on explorer</a>`;
  return { token, curve, pub, wallet };
}

// ---------------------------------------------------------------------------
// Our own Uniswap-v4 bonding curve. One tx deploys (token, curve) and opens the
// curve; an optional dev buy is a second tx straight into curve.buy(). Any
// ERC-20 (or native ETH) works as the quote — there is no allowlist to satisfy.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// lunch.fun
// ---------------------------------------------------------------------------
const lunchQuote = (pad, sym) => pad.quotes.find((q) => q.symbol === sym) || pad.quotes[0];

/// Build the v3 path ETH pays through to reach `q`. The direct WETH pool for
/// these stock tokens exists but is empty, so the live route is the USDG hop —
/// candidates are quoted against QuoterV2 and the best real answer wins rather
/// than trusting any single one of them.
async function lunchEthPath(client, q) {
  const to = getAddress(q.address);
  const weth = getAddress(LUNCH.weth);
  const usdg = getAddress(LUNCH.usdg);
  const hop = (...xs) => encodePacked(xs.map((_, i) => (i % 2 ? 'uint24' : 'address')), xs);
  const cands = to === weth ? [] : to === usdg
    ? [hop(weth, 500, usdg), hop(weth, 3000, usdg)]
    : [hop(weth, 500, usdg, 3000, to), hop(weth, 500, usdg, 10000, to),
      hop(weth, 10000, to), hop(weth, 3000, to)];
  let best = null;
  for (const path of cands) {
    try {
      const { result } = await client.simulateContract({
        address: getAddress(LUNCH.quoter), abi: LUNCH_QUOTER_ABI,
        functionName: 'quoteExactInput', args: [path, parseEther('0.01')],
      });
      if (!best || result[0] > best.out) best = { path, out: result[0] };
    } catch { /* that fee tier has no pool, or no liquidity in it */ }
  }
  return best?.path ?? null;
}

/// Buy the pair token with ETH without leaving the launch form.
async function lunchBuyQuote(pad) {
  const st = $('lunchBuyStatus');
  const q = lunchQuote(pad, $('lunchQuoteSelect').value);
  const amt = ($('lunchBuyEth').value || '').trim();
  if (!(+amt > 0)) { st.innerHTML = '<span class="err">enter an ETH amount</span>'; return; }
  if (getAddress(q.address) === getAddress(LUNCH.weth)) {
    st.innerHTML = '<span class="err">this pairing is ETH — nothing to buy</span>'; return;
  }
  if (!account) { st.innerHTML = '<span class="err">wallet is locked</span>'; return; }
  $('lunchBuyBtn').disabled = true;
  try {
    const pub = publicClientFor(pad);
    const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });
    st.textContent = 'finding the best route…';
    const path = await lunchEthPath(pub, q);
    if (!path) throw new Error('no ETH route to ' + q.symbol);
    const amountIn = parseEther(amt);
    st.textContent = 'simulating…';
    const { result: out } = await pub.simulateContract({
      address: getAddress(LUNCH.swapRouter), abi: LUNCH_SWAP_ABI, functionName: 'exactInput',
      args: [{ path, recipient: account.address, amountIn, amountOutMinimum: 0n }],
      value: amountIn, account: account.address,
    });
    const minOut = out - (out * 300n) / 10000n; // 3% slippage on a quick grab
    const pretty = (+formatUnits(out, q.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
    st.textContent = 'buying ~' + pretty + ' ' + q.symbol + '…';
    const hash = await wallet.writeContract({
      address: getAddress(LUNCH.swapRouter), abi: LUNCH_SWAP_ABI, functionName: 'exactInput',
      args: [{ path, recipient: account.address, amountIn, amountOutMinimum: minOut }],
      value: amountIn,
    });
    const r = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (r.status !== 'success') throw new Error('swap reverted');
    st.innerHTML = '<span class="ok">GOT ' + esc(q.symbol) + ' ✓</span> '
      + '<a href="' + pad.explorer + '/tx/' + hash + '" target="_blank" rel="noopener">tx</a>';
    lunchBalance(pad);
  } catch (e) {
    st.innerHTML = '<span class="err">' + esc(e?.shortMessage || e?.message || String(e)) + '</span>';
  } finally {
    $('lunchBuyBtn').disabled = false;
  }
}

async function lunchBalance(pad) {
  if (!account) { $('lunchBal').textContent = 'balance: wallet locked'; return; }
  const q = lunchQuote(pad, $('lunchQuoteSelect').value);
  try {
    const pub = publicClientFor(pad);
    const b = await pub.readContract({
      address: getAddress(q.address), abi: ERC20, functionName: 'balanceOf', args: [account.address],
    });
    const pretty = (+formatUnits(b, q.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
    $('lunchBal').textContent = 'balance: ' + pretty + ' ' + q.symbol;
  } catch { $('lunchBal').textContent = 'balance: —'; }
}

function updateLunchUI(pad) {
  const qs = $('lunchQuoteSelect');
  if (qs.dataset.padId !== pad.id) {
    // HOOD first, then the other bases, then every stock — the pairing this pad
    // exists for should never be more than one click away
    const lead = pad.quotes.filter((q) => q.symbol === 'HOOD');
    const bases = pad.quotes.filter((q) => q.kind === 'base');
    const stocks = pad.quotes.filter((q) => q.kind === 'stock' && q.symbol !== 'HOOD');
    const opt = (q) => '<option value="' + esc(q.symbol) + '">' + esc(q.symbol)
      + (q.name ? ' — ' + esc(q.name) : '') + '</option>';
    qs.innerHTML = lead.map(opt).join('')
      + '<optgroup label="BASE">' + bases.map(opt).join('') + '</optgroup>'
      + '<optgroup label="STOCKS">' + stocks.map(opt).join('') + '</optgroup>';
    qs.value = 'HOOD';
    qs.dataset.padId = pad.id;
  }
  const q = lunchQuote(pad, qs.value);
  const isEth = getAddress(q.address) === getAddress(LUNCH.weth);
  for (const id of ['lunchDevSym', 'lunchBuySym', 'lunchBuySym2']) $(id).textContent = q.symbol;
  $('lunchBasketRow').classList.toggle('hidden', $('lunchRewards').value !== 'basket');
  $('lunchBuyBtn').disabled = isEth;
  lunchBalance(pad);
}

/// Launch on lunch.fun. Everything is simulated first — the params struct has a
/// named error for each way it can be wrong, so a bad field is reported as
/// itself rather than as a generic revert.
async function launchLunch(pad, inp) {
  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });
  const launcher = getAddress(pad.launcher);
  const q = lunchQuote(pad, $('lunchQuoteSelect').value);
  const pairToken = getAddress(q.address);

  const pct = (id, d) => Math.round((+($(id).value.trim() || d)) * 100);
  const buyTaxBps = pct('lunchBuyTax', 1);
  const sellTaxBps = pct('lunchSellTax', 1);
  for (const [lbl, v] of [['buy', buyTaxBps], ['sell', sellTaxBps]]) {
    if (!(v >= 0) || v > LUNCH.maxTaxBps) {
      throw new Error(lbl + ' tax must be 0–' + (LUNCH.maxTaxBps / 100) + '% (contract cap)');
    }
  }

  setStatus('checking the pairing…');
  const allowed = await pub.readContract({
    address: launcher, abi: LUNCH_ABI, functionName: 'pairAllowed', args: [pairToken],
  });
  if (!allowed) throw new Error(q.symbol + ' is not an allowed pairing on lunch.fun');

  const taxToRaw = ($('lunchTaxTo').value || '').trim();
  const taxTo = taxToRaw ? getAddress(taxToRaw) : account.address;
  const supply = parseEther(String(inp.supply || 1000000000));

  // the dev buy is denominated in the pair token and pulled by the launcher
  const devRaw = ($('lunchDevBuy').value || '').trim();
  const devBuyAmount = +devRaw > 0 ? parseUnits(devRaw, q.decimals) : 0n;

  const mode = $('lunchRewards').value;
  const rewardBps = Math.round((+($('lunchRewardPct').value.trim() || 0)) * 100);

  const params = {
    name: inp.name, symbol: inp.symbol, supply, pairToken,
    buyTaxBps, sellTaxBps,
    taxRecipients: [taxTo], taxShares: [10000],
    rewardBps, devBuyPath: '0x', devBuyAmount, referrer: ZERO_ADDR,
  };

  let fn = 'launchPairRewards';
  let args = [params];
  if (mode === 'basket') {
    // "SYM:weight%" pairs. Anything that is not the pair token needs a v3 path
    // from the pair token to it, or the contract rejects with BadBasket().
    const parts = ($('lunchBasket').value || 'HOOD:100').split(',').map((x) => x.trim()).filter(Boolean);
    const basket = [];
    let total = 0;
    for (const part of parts) {
      const [sym, w] = part.split(':').map((x) => (x || '').trim());
      const t = pad.quotes.find((x) => x.symbol.toLowerCase() === (sym || '').toLowerCase());
      if (!t) throw new Error('unknown basket token "' + sym + '"');
      const weightBps = Math.round((+(w || 0)) * 100);
      if (!(weightBps > 0)) throw new Error('basket weight for ' + sym + ' must be > 0');
      total += weightBps;
      const tok = getAddress(t.address);
      basket.push({
        token: tok, weightBps,
        path: tok === pairToken ? '0x' : encodePacked(['address', 'uint24', 'address'], [pairToken, 3000, tok]),
      });
    }
    if (total !== 10000) throw new Error('basket weights total ' + (total / 100) + '% — they must total 100%');
    fn = 'launchPairRewardsBasket';
    args = [{ ...params, basket }];
  }

  if (devBuyAmount > 0n) {
    setStatus('approving ' + q.symbol + ' for the dev buy…');
    const have = await pub.readContract({
      address: pairToken, abi: ERC20, functionName: 'balanceOf', args: [account.address],
    });
    if (have < devBuyAmount) {
      throw new Error('dev buy needs ' + formatUnits(devBuyAmount, q.decimals) + ' ' + q.symbol
        + ' but you hold ' + formatUnits(have, q.decimals) + ' — use "GET ' + q.symbol + ' FIRST" above');
    }
    const allowance = await pub.readContract({
      address: pairToken, abi: ERC20, functionName: 'allowance', args: [account.address, launcher],
    });
    if (allowance < devBuyAmount) {
      const ah = await wallet.writeContract({
        address: pairToken, abi: ERC20, functionName: 'approve', args: [launcher, 2n ** 256n - 1n],
      });
      await pub.waitForTransactionReceipt({ hash: ah, confirmations: 1 });
    }
  }

  setStatus('simulating launch…');
  const { result: predicted } = await pub.simulateContract({
    address: launcher, abi: LUNCH_ABI, functionName: fn, args, account: account.address,
  });

  setStatus('sending launch…');
  const hash = await wallet.writeContract({ address: launcher, abi: LUNCH_ABI, functionName: fn, args });
  const rec = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (rec.status !== 'success') throw new Error('launch reverted on-chain: ' + hash);
  return { token: predicted, hash };
}

async function launchV4Curve(pad, inp) {
  if (!pad.factory) throw new Error('the v4 curve factory is not deployed yet');
  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  const q = pad.quotes.find((x) => x.symbol === $('v4curveQuoteSelect').value) || pad.quotes[0];
  const isCustom = q.address === 'custom';
  const quoteToken = isCustom ? $('v4curveQuoteCustom').value.trim() : q.address;
  if (!/^0x[a-fA-F0-9]{40}$/.test(quoteToken)) throw new Error('enter a valid quote token address');
  const isNative = quoteToken === ZERO_ADDR;

  // a custom quote can be any ERC-20, so read its decimals rather than assume 18
  const decimals = isNative ? 18
    : (isCustom ? await pub.readContract({ address: quoteToken, abi: ERC20, functionName: 'decimals' }) : q.decimals);

  const threshStr = $('v4curveThreshold').value.trim();
  if (!(+threshStr > 0)) throw new Error('set a graduation threshold');
  const graduationThreshold = parseUnits(threshStr, decimals);

  const supplyStr = $('v4curveSupply').value.trim().replace(/,/g, '');
  if (!(+supplyStr > 0)) throw new Error('set a supply');
  const supply = parseEther(supplyStr);

  const devBuyStr = $('v4curveDevBuy').value.trim() || '0';
  const devBuyRaw = +devBuyStr > 0 ? parseUnits(devBuyStr, decimals) : 0n;

  const fee = await pub.readContract({ address: pad.factory, abi: V4CURVE_ABI, functionName: 'launchFee' });

  const params = {
    name: inp.name, symbol: inp.symbol, logo: inp.logo, description: inp.description,
    twitter: inp.twitter, website: inp.website,
    quoteToken, graduationThreshold, supply,
    poolFee: pad.poolFee, tickSpacing: pad.tickSpacing, hooks: ZERO_ADDR, feeBps: pad.feeBps,
  };

  setStatus('simulating launch...');
  const { result } = await pub.simulateContract({
    address: pad.factory, abi: V4CURVE_ABI, functionName: 'launch', args: [params], value: fee, account,
  });
  const [token, curve] = result;

  setStatus('sending launch tx...');
  const hash = await wallet.writeContract({
    address: pad.factory, abi: V4CURVE_ABI, functionName: 'launch', args: [params], value: fee,
  });
  setStatus(`tx sent: ${hash}
waiting for confirmation...`);
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('tx reverted: ' + hash);

  // optional dev buy — a separate call into the curve now that it exists
  let buyNote = '';
  if (devBuyRaw > 0n) {
    if (!isNative) {
      setStatus(`approving ${q.symbol} to the curve...`);
      const ah = await wallet.writeContract({ address: quoteToken, abi: ERC20, functionName: 'approve', args: [curve, devBuyRaw] });
      await pub.waitForTransactionReceipt({ hash: ah, confirmations: 1 });
    }
    setStatus('buying...');
    const bh = await wallet.writeContract({
      address: curve, abi: V4CURVE_BUY_ABI, functionName: 'buy',
      args: [devBuyRaw, 0n, account.address], value: isNative ? devBuyRaw : 0n,
    });
    await pub.waitForTransactionReceipt({ hash: bh, confirmations: 1 });
    buyNote = ` · dev buy ✓ (${devBuyStr} ${isCustom ? 'quote' : q.symbol})`;
  }

  rememberLaunch(pad, token, inp.symbol);
  $('status').innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${token}${buyNote}<br>` +
    `curve: ${curve}<br>` +
    `<a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx on explorer</a>`;
  return { token, curve, pub, wallet };
}

async function launchPonsV1(pad, inp) {
  const pub = publicClientFor(pad);
  const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

  setStatus('running pre-launch checks...');
  const [enabled, fee] = await Promise.all([
    pub.readContract({ address: pad.factory, abi: PONS_V1_FACTORY_ABI, functionName: 'launchEnabled' }),
    pub.readContract({ address: pad.factory, abi: PONS_V1_FACTORY_ABI, functionName: 'launchFee' }),
  ]);
  if (!enabled) throw new Error('Pons launches are currently paused');

  const params = {
    name: inp.name, symbol: inp.symbol, logo: inp.logo, description: inp.description,
    socials: { twitter: inp.twitter, telegram: '', discord: '', website: inp.website, farcaster: '' },
    feeWallet: inp.feeRecipient,
  };
  const salt = keccak256(stringToBytes(`${inp.name}-${inp.symbol}-${account.address}-${Date.now()}`));
  const args = [params, pad.launchConfigId, pad.dexId, salt];

  // optional dev buy: launchToken is payable — value beyond the fee is the initial buy
  const devBuy = inp.devBuy || 0n;
  const value = fee + devBuy;
  const bal = await pub.getBalance({ address: account.address });
  if (bal < value) throw new Error(`insufficient balance: need ${formatEther(value)}+gas, have ${formatEther(bal)} ${pad.nativeSymbol}`);

  // deterministic token address (also validates params without sending)
  let token;
  try {
    token = await pub.readContract({
      address: pad.factory, abi: PONS_V1_FACTORY_ABI, functionName: 'predictTokenAddress',
      args: [params, pad.launchConfigId, pad.dexId, salt, account.address],
    });
  } catch { /* fall back to the simulate result below */ }

  setStatus('simulating launch...');
  const sim = await pub.simulateContract({
    address: pad.factory, abi: PONS_V1_FACTORY_ABI, functionName: 'launchToken', args, value, account,
  });
  if (!token) token = sim.result;

  setStatus('sending launch tx...');
  const hash = await wallet.writeContract({
    address: pad.factory, abi: PONS_V1_FACTORY_ABI, functionName: 'launchToken', args, value,
  });
  setStatus(`tx sent: ${hash}
waiting for confirmation...`);
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('tx reverted: ' + hash);
  rememberLaunch(pad, token, inp.symbol);

  const el = $('status');
  el.innerHTML =
    `<span style="color:var(--accent)">LAUNCHED ✓</span> ${token}${devBuy > 0n ? ' · dev buy ' + formatEther(devBuy) + ' ETH' : ''}<br>` +
    `<a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx on explorer</a>`;
  return { token, curve: null, pub, wallet };
}

// ---------------------------------------------------------------------------
// dev-buy chips — editable presets, persisted
// ---------------------------------------------------------------------------
const CHIPS_KEY = 'buyChips.v1';
let buyChips = JSON.parse(localStorage.getItem(CHIPS_KEY) || 'null') || ['0.001', '0.005', '0.01', '0.05'];
let selectedChip = -1; // -1 = none

function selectedBuyAmount() {
  return selectedChip >= 0 ? parseEther(buyChips[selectedChip]) : 0n;
}

function padSupply(pad) {
  // pads without published curve params (pons v2) fall back to 1e9 so
  // %-based distributions still resolve to something sane
  if (!pad.customSupply) return pad.curve?.supply ?? 1e9;
  const raw = +($('supply').value.trim().replace(/,/g, '')) || 1e9;
  return raw;
}

function updateBuyPreview() {
  const el = $('buyPreview');
  const curve = activePad.curve;
  // Pools/v4 pads have no closed-form curve cap — the estimate would be NaN, so skip it
  if (selectedChip < 0 || !curve || curve.cap == null) { el.innerHTML = ''; return; }
  const x = +buyChips[selectedChip];
  const supply = padSupply(activePad);
  const tokens = (supply * x) / (curve.cap + x);
  const pct = (x / (curve.cap + x)) * 100;
  el.innerHTML = `you'd get ≈ <b>${Math.round(tokens).toLocaleString('en-US')}</b> tokens · <b>${pct.toFixed(2)}%</b> of supply`;
}

function renderBuyChips() {
  const box = $('buyChips');
  box.innerHTML = '';

  const none = document.createElement('button');
  none.className = 'pad' + (selectedChip === -1 ? ' active' : '');
  none.textContent = 'none';
  none.onclick = () => { selectedChip = -1; renderBuyChips(); };
  box.appendChild(none);

  buyChips.forEach((amt, i) => {
    const b = document.createElement('button');
    b.className = 'pad' + (selectedChip === i ? ' active' : '');
    b.textContent = amt + ' ' + activePad.nativeSymbol;
    b.onclick = () => { selectedChip = i; renderBuyChips(); };
    box.appendChild(b);
  });

  const pencil = document.createElement('button');
  pencil.className = 'pad';
  pencil.title = 'edit amounts';
  pencil.textContent = '✎';
  pencil.onclick = openChipEditor;
  box.appendChild(pencil);
  updateBuyPreview();
}

function chipEditRow(value) {
  const row = document.createElement('div');
  row.className = 'chip-edit-row';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = 'any';
  input.placeholder = '0.01';
  input.value = value;
  const x = document.createElement('button');
  x.className = 'x';
  x.textContent = '×';
  x.title = 'remove';
  x.onclick = () => row.remove();
  row.append(input, x);
  return row;
}

function openChipEditor() {
  const rows = $('chipEditRows');
  rows.innerHTML = '';
  for (const amt of buyChips) rows.appendChild(chipEditRow(amt));
  $('chipsOverlay').classList.remove('hidden');
}

function saveChipEditor() {
  const values = [...$('chipEditRows').querySelectorAll('input')]
    .map((i) => i.value.trim())
    .filter((v) => v && !isNaN(+v) && +v > 0);
  if (values.length) {
    buyChips = values;
    localStorage.setItem(CHIPS_KEY, JSON.stringify(buyChips));
  }
  if (selectedChip >= buyChips.length) selectedChip = -1;
  $('chipsOverlay').classList.add('hidden');
  renderBuyChips();
}

// ---------------------------------------------------------------------------
// distribute supply on launch
// ---------------------------------------------------------------------------
function distRow(addr = '', amt = '') {
  const row = document.createElement('div');
  row.className = 'chip-edit-row';
  const a = document.createElement('input');
  a.type = 'text'; a.placeholder = '0x wallet address'; a.value = addr;
  a.spellcheck = false; a.className = 'dist-addr';
  const m = document.createElement('input');
  m.type = 'text'; m.placeholder = 'tokens or %'; m.value = amt;
  m.style.flex = '0 0 110px'; m.className = 'dist-amt';
  const x = document.createElement('button');
  x.className = 'x'; x.textContent = '×'; x.title = 'remove';
  x.onclick = () => row.remove();
  row.append(a, m, x);
  return row;
}

function parseDistributions(supply) {
  const out = [];
  for (const row of $('distRows').querySelectorAll('.chip-edit-row')) {
    const addr = row.querySelector('.dist-addr').value.trim();
    const raw = row.querySelector('.dist-amt').value.trim().replace(/,/g, '');
    if (!addr && !raw) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`distribution: bad address "${addr.slice(0, 14)}…"`);
    let tokens;
    if (raw.endsWith('%')) {
      const pct = +raw.slice(0, -1);
      if (!(pct > 0 && pct <= 100)) throw new Error(`distribution: bad % "${raw}"`);
      tokens = (supply * pct) / 100;
    } else {
      tokens = +raw;
      if (!(tokens > 0)) throw new Error(`distribution: bad amount "${raw}"`);
    }
    out.push({ addr, amount: parseEther(tokens.toString()) });
  }
  return out;
}

async function runDistributions(pad, pub, wallet, token, dists, statusEl) {
  statusEl.innerHTML += `<br>distributing to ${dists.length} wallet${dists.length > 1 ? 's' : ''}…`;
  // one gas estimate reused for all, txs fired back-to-back with pipelined
  // nonces, receipts awaited together — no per-transfer round trips
  let gas = 150000n;
  try {
    gas = await pub.estimateContractGas({
      address: token, abi: ERC20_ABI, functionName: 'transfer',
      args: [dists[0].addr, dists[0].amount], account,
    });
    gas = (gas * 130n) / 100n;
  } catch { /* fall back to flat limit */ }

  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const sent = [];
  for (const d of dists) {
    const tag = `${d.addr.slice(0, 6)}…${d.addr.slice(-4)}`;
    try {
      const hash = await wallet.writeContract({
        address: token, abi: ERC20_ABI, functionName: 'transfer',
        args: [d.addr, d.amount], gas, nonce: nonce++,
      });
      sent.push({ tag, hash });
    } catch (e) {
      statusEl.innerHTML += `<br>${tag} <span class="err">failed to send (${esc(e.shortMessage || e.message)})</span>`;
    }
  }

  const results = await Promise.all(sent.map((s) =>
    pub.waitForTransactionReceipt({ hash: s.hash, confirmations: 1 })
      .then((r) => ({ ...s, ok: r.status === 'success' }))
      .catch(() => ({ ...s, ok: false })),
  ));
  for (const r of results) {
    statusEl.innerHTML += `<br>${r.tag} ${r.ok ? '✓' : '<span class="err">reverted</span>'}`;
  }
  statusEl.innerHTML += `<br>distribution done: ${results.filter((r) => r.ok).length}/${dists.length} sent`;
}

// saved wallet sets for distribution
const DIST_SETS_KEY = 'distSets.v1';
const DIST_LAST_KEY = 'distSets.last';
const loadDistSets = () => JSON.parse(localStorage.getItem(DIST_SETS_KEY) || '{}');
let distroOn = false;
let activeDistSet = localStorage.getItem(DIST_LAST_KEY) || '';

function currentDistRows() {
  const rows = [];
  for (const row of $('distRows').querySelectorAll('.chip-edit-row')) {
    const addr = row.querySelector('.dist-addr').value.trim();
    const amt = row.querySelector('.dist-amt').value.trim();
    if (addr || amt) rows.push({ addr, amt });
  }
  return rows;
}

function setDistRows(rows) {
  const box = $('distRows');
  box.innerHTML = '';
  for (const r of rows) box.appendChild(distRow(r.addr, r.amt));
  if (!rows.length) box.appendChild(distRow());
}

function renderDistSetChips() {
  const box = $('distSetChips');
  box.innerHTML = '';
  const sets = loadDistSets();
  for (const name of Object.keys(sets)) {
    const b = document.createElement('button');
    b.className = 'pad' + (name === activeDistSet ? ' active' : '');
    b.textContent = name;
    b.onclick = () => {
      activeDistSet = name;
      localStorage.setItem(DIST_LAST_KEY, name);
      setDistRows(sets[name]);
      renderDistSetChips();
    };
    box.appendChild(b);
  }
}

function toggleDistro() {
  distroOn = !distroOn;
  const t = $('distToggle');
  t.textContent = distroOn ? 'on' : 'off';
  t.classList.toggle('active', distroOn);
  $('distPanel').classList.toggle('hidden', !distroOn);
  if (distroOn) {
    // pre-load the last-used (or only) saved set
    const sets = loadDistSets();
    const names = Object.keys(sets);
    if (!currentDistRows().length && names.length) {
      if (!sets[activeDistSet]) activeDistSet = names[0];
      setDistRows(sets[activeDistSet]);
    }
    if (!$('distRows').children.length) $('distRows').appendChild(distRow());
    renderDistSetChips();
  }
}

function saveDistSet() {
  const rows = currentDistRows();
  if (!rows.length) { setStatus('nothing to save — add wallets first', true); return; }
  const name = prompt('name this wallet set:', activeDistSet || 'set 1');
  if (!name) return;
  const sets = loadDistSets();
  sets[name] = rows;
  localStorage.setItem(DIST_SETS_KEY, JSON.stringify(sets));
  activeDistSet = name;
  localStorage.setItem(DIST_LAST_KEY, name);
  renderDistSetChips();
}

function deleteDistSet() {
  if (!activeDistSet) return;
  const sets = loadDistSets();
  delete sets[activeDistSet];
  localStorage.setItem(DIST_SETS_KEY, JSON.stringify(sets));
  activeDistSet = Object.keys(sets)[0] || '';
  renderDistSetChips();
}

// ---------------------------------------------------------------------------
// my tokens + claim fees (Noxa locker)
// ---------------------------------------------------------------------------
const LAUNCHES_KEY = 'launches.v1';
const loadLaunches = () => JSON.parse(localStorage.getItem(LAUNCHES_KEY) || '[]');
function rememberLaunch(pad, token, symbol, positionId) {
  const all = loadLaunches();
  const existing = all.find((l) => l.token.toLowerCase() === token.toLowerCase());
  if (existing) {
    if (positionId && !existing.positionId) { existing.positionId = positionId; localStorage.setItem(LAUNCHES_KEY, JSON.stringify(all)); }
    return;
  }
  all.push({ pad: pad.id, token, symbol, ...(positionId ? { positionId } : {}) });
  localStorage.setItem(LAUNCHES_KEY, JSON.stringify(all));
}

async function discoverMyTokens(pad) {
  // pons v1: the locker knows every token where you're the fee recipient — enumerate
  // it so you see them all (even ones launched elsewhere), not just local memory
  if (pad.family === 'pons-v1') {
    const pub = publicClientFor(pad);
    const n = await pub.readContract({ address: pad.locker, abi: PONS_LOCKER_ABI, functionName: 'feeRecipientTokenCount', args: [account.address] }).catch(() => 0n);
    const out = [];
    for (let i = 0n; i < n; i++) {
      const t = await pub.readContract({ address: pad.locker, abi: PONS_LOCKER_ABI, functionName: 'feeRecipientTokens', args: [account.address, i] }).catch(() => null);
      if (t) out.push(t);
    }
    return out;
  }
  // pons v2 fees aggregate in the escrow (not per-token) — handled separately
  if (pad.family === 'pons-v2') return [];
  // pools has no deployer-indexed launch event; discovery is via local launch memory
  if (pad.family === 'pools') return [];
  // Rialto has no per-token locker in this app; discovery is via its API, and
  // fee claiming isn't wired — fall back to local memory only
  if (pad.family === 'rialto') return [];
  // TokenLaunched has deployer indexed — one filtered getLogs finds all ours
  const pub = publicClientFor(pad);
  const logs = await pub.getLogs({
    address: pad.factory, event: TOKEN_LAUNCHED_EVENT,
    args: { deployer: account.address },
    fromBlock: pad.startBlock, toBlock: 'latest',
  });
  return logs.map((l) => l.args.token);
}

const claimPad = () => (activePad.enabled && (activePad.locker || activePad.feeHolder) ? activePad : PADS.find((p) => p.enabled && (p.locker || p.feeHolder)));

async function getMyTokens(pad) {
  const onchain = await discoverMyTokens(pad);
  const local = loadLaunches().filter((l) => l.pad === pad.id).map((l) => l.token);
  return [...new Set([...onchain, ...local].map((t) => t.toLowerCase()))];
}

async function renderTokenList() {
  const box = $('tokenList');
  // Solana / Meteora launches claim through the DBC partner-fee path, not a locker
  if (activePad.vm === 'sol' && activePad.family === 'meteora') return renderMeteoraClaims(box);
  if (!account) { box.innerHTML = '<div class="empty">unlock wallet to load your launches</div>'; return; }
  const pad = claimPad();
  box.innerHTML = '<div class="empty">loading…</div>';
  try {
    const pub = publicClientFor(pad);
    const tokens = await getMyTokens(pad);
    if (!tokens.length) { box.innerHTML = '<div class="empty">no launches from this wallet yet</div>'; return; }
    box.innerHTML = '';
    for (const token of tokens) {
      const row = document.createElement('div');
      row.className = 'token-row';
      const known = loadLaunches().find((l) => l.token.toLowerCase() === token);
      let sym = known?.symbol || '';
      if (!sym) {
        sym = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '?');
      }
      row.innerHTML =
        `<span class="sym">${esc(sym)}</span>` +
        `<span class="addr"><a href="${esc(pad.site(token))}" target="_blank" rel="noopener">${esc(token)}</a></span>`;
      const btn = document.createElement('button');
      btn.className = 'mini';
      btn.textContent = 'CLAIM';
      btn.onclick = () => claimFees(pad, token, btn);
      row.appendChild(btn);
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = `<div class="empty">couldn't load tokens: ${esc(e.shortMessage || e.message)}</div>`;
  }
}

async function claimAllFees(btn) {
  const out = $('claimStatus');
  const say = (m, err) => { out.innerHTML = err ? `<span class="err">${m}</span>` : m; };
  // Solana / Meteora claims run off the SOL key, not an EVM account
  if (activePad.vm === 'sol' && activePad.family === 'meteora') { await claimAllMeteora(btn); return; }
  if (!account) { say('unlock wallet first', true); return; }
  const pad = claimPad();
  if (pad.family === 'pools') { await claimAllPoolsFees(pad, btn); return; }
  // pons v2 escrow aggregates all fees per recipient — one claim() covers
  // every launch, no per-token loop needed
  if (pad.family === 'pons-v2') { await claimFees(pad, null, btn); return; }
  btn.disabled = true;
  try {
    const pub = publicClientFor(pad);
    const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });
    say('checking which tokens have fees…');
    const tokens = await getMyTokens(pad);
    if (!tokens.length) { say('no launches from this wallet yet', true); return; }

    // simulate collectFees for every token in parallel — only claim the ones
    // that wouldn't revert (NoFeesToCollect etc.)
    const claimable = (await Promise.all(tokens.map((token) =>
      pub.simulateContract({
        address: pad.locker, abi: LOCKER_ABI, functionName: pad.claimFn,
        args: [token], account,
      }).then(() => token).catch(() => null),
    ))).filter(Boolean);

    if (!claimable.length) { say(`nothing to claim across ${tokens.length} token${tokens.length > 1 ? 's' : ''}`); return; }
    say(`claiming ${claimable.length} of ${tokens.length}…`);

    let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const hashes = [];
    for (const token of claimable) {
      hashes.push(await wallet.writeContract({
        address: pad.locker, abi: LOCKER_ABI, functionName: pad.claimFn,
        args: [token], nonce: nonce++,
      }));
    }
    const results = await Promise.all(hashes.map((hash) =>
      pub.waitForTransactionReceipt({ hash, confirmations: 1 })
        .then((r) => r.status === 'success').catch(() => false),
    ));
    const ok = results.filter(Boolean).length;
    say(`<span style="color:var(--accent)">CLAIMED ${ok}/${claimable.length} ✓</span> (${tokens.length - claimable.length} had nothing)`);
    refreshBalance();
  } catch (e) {
    say(e.shortMessage || e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function claimFees(pad, token, btn) {
  const out = $('claimStatus');
  const say = (m, err) => { out.innerHTML = err ? `<span class="err">${m}</span>` : m; };
  if (!account) { say('unlock wallet first', true); return; }
  if (pad.family === 'pools') { await claimPoolsFees(pad, token, btn); return; }
  if (btn) btn.disabled = true;
  try {
    // AUTO-ROUTE: if this token is a Pons v1 token (its LP fees live in the Pons
    // locker), claim it through the Pons locker regardless of the selected pad —
    // avoids calling the wrong locker's claimFees (which reverts UnknownToken).
    if (token && pad.family !== 'pons-v1' && pad.family !== 'pons-v2') {
      try {
        const pp = ponsChain();
        const redir = await publicClientFor(pp).readContract({ address: PONS_LOCKER_ADDR, abi: PONS_LOCKER_ABI, functionName: 'feeRedirects', args: [token] });
        if (redir && redir.toLowerCase() !== ZERO_ADDR.toLowerCase()) pad = pp;
      } catch { /* not a Pons token — use the given pad */ }
    }
    const pub = publicClientFor(pad);
    const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });

    // --- Pons v1: collectFees(token). VOID-SAFETY: confirm where the money goes
    // (feeRedirects) and simulate to see the exact amounts before sending.
    if (pad.family === 'pons-v1') {
      const redirect = await pub.readContract({ address: pad.locker, abi: PONS_LOCKER_ABI, functionName: 'feeRedirects', args: [token] });
      if (redirect.toLowerCase() !== account.address.toLowerCase()) {
        say(`⚠ this token's fees go to <b>${esc(redirect)}</b>, not your wallet — not claiming (nothing lost). Change it with setFeeRedirect if that's wrong.`, true);
        return;
      }
      let amt0 = 0n, amt1 = 0n;
      try {
        const sim = await pub.simulateContract({ address: pad.locker, abi: PONS_LOCKER_ABI, functionName: 'collectFees', args: [token], account });
        [amt0, amt1] = sim.result;
      } catch (e) {
        say(`nothing to claim on this token (${(e.shortMessage || e.message).split('\n')[0]})`); return;
      }
      if (amt0 === 0n && amt1 === 0n) { say('no fees accrued on this token yet'); return; }
      say(`claiming ${formatEther(amt0)} ${pad.nativeSymbol} + ${formatEther(amt1)} tokens → your wallet…`);
      const h = await wallet.writeContract({ address: pad.locker, abi: PONS_LOCKER_ABI, functionName: 'collectFees', args: [token] });
      const r = await pub.waitForTransactionReceipt({ hash: h, confirmations: 1 });
      if (r.status !== 'success') throw new Error('collectFees reverted');
      say(`<span style="color:var(--accent)">FEES CLAIMED ✓</span> ${formatEther(amt0)} ${pad.nativeSymbol} + ${formatEther(amt1)} tokens → you · <a href="${pad.explorer}/tx/${h}" target="_blank" rel="noopener">tx</a>`);
      refreshBalance(); renderTokenList();
      return;
    }

    say('claiming fees…');
    // pons v2: native fees via escrow.claim(); pass a token address to claim
    // ERC-20 balances (custom pairs / released buyback vests) instead
    const hash = pad.family === 'pons-v2'
      ? await wallet.writeContract(token
        ? { address: pad.escrow, abi: PONS_ESCROW_ABI, functionName: 'claimToken', args: [token] }
        : { address: pad.escrow, abi: PONS_ESCROW_ABI, functionName: 'claim' })
      : await wallet.writeContract({
        address: pad.locker, abi: LOCKER_ABI, functionName: pad.claimFn, args: [token],
      });
    say(`tx sent: ${hash}\nwaiting…`);
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error('tx reverted');
    say(`<span style="color:var(--accent)">FEES CLAIMED ✓</span> <a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx</a>`);
    refreshBalance();
  } catch (e) {
    const msg = e.shortMessage || e.message;
    say(/NoFeesToCollect/i.test(msg) ? 'nothing to claim yet' : msg, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- Meteora (Solana DBC) fee claiming. Your launches route 100% of trading fees
// to the config feeClaimer (your SOL wallet), accrued in the quote token. We list
// every pool your wallet created, show what's owed, and claim it via the DBC SDK. --
const SOL_QUOTE_SYMBOLS = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
};
function fmtSolAmount(rawStr, decimals) {
  try { return Number(BigInt(rawStr)) / 10 ** (decimals || 9); } catch { return 0; }
}

async function renderMeteoraClaims(box) {
  if (!solKeyB58) { box.innerHTML = '<div class="empty">import a SOL key to see your Meteora launches</div>'; return; }
  box.innerHTML = '<div class="empty">loading your Meteora pools…</div>';
  try {
    const owner = solPubkeyFromSecret(solKeyB58);
    const { getMeteoraFees } = await import('./solana.js');
    const rows = await getMeteoraFees({ rpcUrl: activePad.rpc, owner });
    if (!rows.length) { box.innerHTML = '<div class="empty">no Meteora launches from this wallet yet</div>'; return; }
    // most fees first
    rows.sort((a, b) => (BigInt(b.claimableQuote) > BigInt(a.claimableQuote) ? 1 : -1));
    box.innerHTML = '';
    for (const r of rows) {
      const sym = SOL_QUOTE_SYMBOLS[r.quoteMint] || 'quote';
      const amt = fmtSolAmount(r.claimableQuote, r.quoteDecimals);
      const has = BigInt(r.claimableQuote) > 0n || BigInt(r.claimableBase) > 0n;
      const row = document.createElement('div');
      row.className = 'token-row';
      row.innerHTML =
        `<span class="sym">${esc((r.baseMint || r.pool).slice(0, 4))}…</span>` +
        `<span class="addr"><a href="https://solscan.io/account/${esc(r.pool)}" target="_blank" rel="noopener">` +
        `${amt.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${sym} claimable</a></span>`;
      const btn = document.createElement('button');
      btn.className = has ? 'mini accent' : 'mini';
      btn.textContent = 'CLAIM';
      btn.onclick = () => claimMeteora(r.pool, btn);
      row.appendChild(btn);
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = `<div class="empty">couldn't load Meteora pools: ${esc(e.shortMessage || e.message)}</div>`;
  }
}

async function claimMeteora(pool, btn) {
  const out = $('claimStatus');
  const say = (m, err) => { out.innerHTML = err ? `<span class="err">${m}</span>` : m; };
  if (!solKeyB58) { say('import a SOL key first', true); return; }
  if (btn) btn.disabled = true;
  try {
    const { claimMeteoraFees } = await import('./solana.js');
    const res = await claimMeteoraFees({ rpcUrl: activePad.rpc, secretKey: solKeyB58, pool, onStatus: (m) => say(m) });
    const amt = fmtSolAmount(res.claimedQuote, 9);
    say(`<span style="color:var(--accent)">FEES CLAIMED ✓</span> → your wallet · <a href="https://solscan.io/tx/${res.sig}" target="_blank" rel="noopener">tx</a>`);
    refreshBalance(); renderTokenList();
  } catch (e) {
    const msg = e.shortMessage || e.message;
    say(/nothing to claim/i.test(msg) ? 'nothing to claim on this pool yet' : msg, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function claimAllMeteora(btn) {
  const out = $('claimStatus');
  const say = (m, err) => { out.innerHTML = err ? `<span class="err">${m}</span>` : m; };
  if (!solKeyB58) { say('import a SOL key first', true); return; }
  if (btn) btn.disabled = true;
  try {
    const owner = solPubkeyFromSecret(solKeyB58);
    const { getMeteoraFees, claimMeteoraFees } = await import('./solana.js');
    say('checking which pools have fees…');
    const rows = await getMeteoraFees({ rpcUrl: activePad.rpc, owner });
    const claimable = rows.filter((r) => BigInt(r.claimableQuote) > 0n || BigInt(r.claimableBase) > 0n);
    if (!claimable.length) { say(`nothing to claim across ${rows.length} pool${rows.length === 1 ? '' : 's'}`); return; }
    let ok = 0;
    for (const r of claimable) {
      say(`claiming ${ok + 1}/${claimable.length}…`);
      try { await claimMeteoraFees({ rpcUrl: activePad.rpc, secretKey: solKeyB58, pool: r.pool }); ok++; } catch { /* skip pools that reject */ }
    }
    say(`<span style="color:var(--accent)">CLAIMED ${ok}/${claimable.length} ✓</span> → your wallet`);
    refreshBalance(); renderTokenList();
  } catch (e) {
    say(e.shortMessage || e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- Pools creator-fee claiming. Your single-sided position earns 0.25% of every
// trade; collectFees([positionId]) on pad.feeHolder sweeps it to you (the position
// NFT owner), so there's no void. Position id comes from the launch record (captured
// at launch) or an on-chain lookup, and we simulate before sending. ----------------
async function poolsPositionIdFor(pad, token) {
  const rec = loadLaunches().find((l) => l.token.toLowerCase() === token.toLowerCase());
  if (rec && rec.positionId) return rec.positionId;
  const id = await findPoolsPositionId(pad, token);
  if (id) rememberLaunch(pad, token, rec?.symbol || '', id); // cache for next time
  return id;
}

async function claimPoolsFees(pad, token, btn) {
  const out = $('claimStatus');
  const say = (m, err) => { out.innerHTML = err ? `<span class="err">${m}</span>` : m; };
  if (!account) { say('unlock wallet first', true); return; }
  if (btn) btn.disabled = true;
  try {
    const pub = publicClientFor(pad);
    const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });
    say('finding your fee position…');
    const id = await poolsPositionIdFor(pad, token);
    if (!id) { say("couldn't find a fee position for this token (were you its launcher?)", true); return; }
    // simulate-first: if nothing is owed, this reverts and we send nothing
    try {
      await pub.simulateContract({ address: pad.feeHolder, abi: POOLS_COLLECT_ABI, functionName: 'collectFees', args: [[BigInt(id)]], account });
    } catch (e) {
      say(`nothing to claim on this token yet (${(e.shortMessage || e.message).split('\n')[0]})`); return;
    }
    say('claiming your 0.25% swap fees → your wallet…');
    const hash = await wallet.writeContract({ address: pad.feeHolder, abi: POOLS_COLLECT_ABI, functionName: 'collectFees', args: [[BigInt(id)]] });
    const r = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (r.status !== 'success') throw new Error('collectFees reverted');
    say(`<span style="color:var(--accent)">FEES CLAIMED ✓</span> position #${id} → you · <a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx</a>`);
    refreshBalance();
  } catch (e) {
    say(e.shortMessage || e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function claimAllPoolsFees(pad, btn) {
  const out = $('claimStatus');
  const say = (m, err) => { out.innerHTML = err ? `<span class="err">${m}</span>` : m; };
  if (btn) btn.disabled = true;
  try {
    const pub = publicClientFor(pad);
    const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });
    say('gathering your fee positions…');
    const tokens = loadLaunches().filter((l) => l.pad === pad.id).map((l) => l.token);
    if (!tokens.length) { say('no Pools launches from this wallet yet', true); return; }
    const ids = [];
    for (const t of tokens) { const id = await poolsPositionIdFor(pad, t).catch(() => null); if (id) ids.push(BigInt(id)); }
    if (!ids.length) { say("couldn't resolve any fee positions", true); return; }
    // keep only positions that actually have fees (simulate each), then sweep in one tx
    say(`checking ${ids.length} position${ids.length > 1 ? 's' : ''} for fees…`);
    const claimable = (await Promise.all(ids.map((id) =>
      pub.simulateContract({ address: pad.feeHolder, abi: POOLS_COLLECT_ABI, functionName: 'collectFees', args: [[id]], account })
        .then(() => id).catch(() => null)))).filter(Boolean);
    if (!claimable.length) { say(`nothing to claim across ${ids.length} position${ids.length > 1 ? 's' : ''}`); return; }
    say(`claiming ${claimable.length} position${claimable.length > 1 ? 's' : ''} → your wallet…`);
    await pub.simulateContract({ address: pad.feeHolder, abi: POOLS_COLLECT_ABI, functionName: 'collectFees', args: [claimable], account });
    const hash = await wallet.writeContract({ address: pad.feeHolder, abi: POOLS_COLLECT_ABI, functionName: 'collectFees', args: [claimable] });
    const r = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (r.status !== 'success') throw new Error('collectFees reverted');
    say(`<span style="color:var(--accent)">CLAIMED ${claimable.length}/${ids.length} ✓</span> → your wallet · <a href="${pad.explorer}/tx/${hash}" target="_blank" rel="noopener">tx</a>`);
    refreshBalance();
  } catch (e) {
    say(e.shortMessage || e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- Pons v2 escrow claiming (independent of the pad selector, since v2 launching
// is off). balanceOf/claim() send to msg.sender = you — no void. -----------------
const ponsChain = () => PADS.find((p) => p.id === 'pons-v1'); // same chain (4663)
async function refreshPonsV2Bal() {
  const el = $('ponsV2Bal');
  if (!account) { el.textContent = ''; return; }
  try {
    const pub = publicClientFor(ponsChain());
    const nativeBal = await pub.readContract({ address: PONS_ESCROW_ADDR, abi: PONS_ESCROW_ABI, functionName: 'balanceOf', args: [account.address] });
    const t = $('ponsV2Token').value.trim();
    let extra = '';
    if (/^0x[0-9a-fA-F]{40}$/.test(t)) {
      const tb = await pub.readContract({ address: PONS_ESCROW_ADDR, abi: PONS_ESCROW_ABI, functionName: 'balanceOfToken', args: [account.address, getAddress(t)] });
      extra = ` · ${formatEther(tb)} of ${t.slice(0, 6)}…`;
    }
    el.textContent = `claimable: ${formatEther(nativeBal)} ETH${extra}`;
  } catch { $('ponsV2Bal').textContent = ''; }
}
async function claimPonsV2() {
  const out = $('ponsV2Status');
  const say = (m, err) => { out.innerHTML = err ? `<span class="err">${m}</span>` : m; };
  if (!account) { say('unlock wallet first', true); return; }
  const btn = $('ponsV2ClaimBtn'); btn.disabled = true;
  try {
    const pad = ponsChain();
    const pub = publicClientFor(pad);
    const wallet = createWalletClient({ account, chain: chainFor(pad), transport: http(pad.rpc) });
    const t = $('ponsV2Token').value.trim();
    const isToken = /^0x[0-9a-fA-F]{40}$/.test(t);
    if (t && !isToken) { say('that is not a valid token address', true); return; }
    // void-safety: claim() / claimToken() pay msg.sender (you). Confirm a balance first.
    const bal = isToken
      ? await pub.readContract({ address: PONS_ESCROW_ADDR, abi: PONS_ESCROW_ABI, functionName: 'balanceOfToken', args: [account.address, getAddress(t)] })
      : await pub.readContract({ address: PONS_ESCROW_ADDR, abi: PONS_ESCROW_ABI, functionName: 'balanceOf', args: [account.address] });
    if (bal === 0n) { say(`nothing to claim in the v2 escrow${isToken ? ' for that token' : ''}`); return; }
    say(`claiming ${formatEther(bal)} ${isToken ? 'tokens' : 'ETH'} → your wallet…`);
    const h = isToken
      ? await wallet.writeContract({ address: PONS_ESCROW_ADDR, abi: PONS_ESCROW_ABI, functionName: 'claimToken', args: [getAddress(t)] })
      : await wallet.writeContract({ address: PONS_ESCROW_ADDR, abi: PONS_ESCROW_ABI, functionName: 'claim' });
    const r = await pub.waitForTransactionReceipt({ hash: h, confirmations: 1 });
    if (r.status !== 'success') throw new Error('claim reverted');
    say(`<span style="color:var(--accent)">CLAIMED ✓</span> ${formatEther(bal)} ${isToken ? 'tokens' : 'ETH'} → you · <a href="${pad.explorer}/tx/${h}" target="_blank" rel="noopener">tx</a>`);
    refreshPonsV2Bal(); refreshBalance();
  } catch (e) { say(e.shortMessage || e.message, true); }
  finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
// escape untrusted strings (on-chain token symbols, error text) before innerHTML —
// keys are stored in plaintext, so an injected <script> could read them
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function setStatus(msg, isErr = false) {
  // error text may include on-chain data (revert reasons, token names) — escape it
  $('status').innerHTML = isErr ? `<span class="err">${esc(msg)}</span>` : msg;
}

function renderPads() {
  const box = $('pads');
  box.innerHTML = '';
  for (const pad of PADS) {
    const b = document.createElement('button');
    b.className = 'pad' + (pad === activePad ? ' active' : '');
    b.textContent = pad.enabled ? pad.label : pad.label + ' (soon)';
    b.disabled = !pad.enabled;
    b.onclick = () => {
      activePad = pad;
      applyPadUI(pad);
      renderPads(); renderBuyChips(); refreshFeeNote(); refreshBalance(); renderTokenList();
    };
    box.appendChild(b);
  }
}

// show/hide the per-pad input sections + wallet for the active pad
function applyPadUI(pad) {
  const sol = pad.vm === 'sol';
  const meteora = pad.family === 'meteora';
  const raydium = pad.family === 'raydium';
  const pump = pad.family === 'pump';
  const clmm = pad.family === 'clmm';
  const uni = pad.family === 'uniswap';
  const dyor = pad.family === 'dyorswap';
  const b20 = pad.family === 'b20';
  const flap = pad.family === 'flap';
  const ponsV2 = pad.family === 'pons-v2';
  const v4curve = pad.family === 'v4curve';
  const long = pad.family === 'long';
  const lunch = pad.family === 'lunch';
  $('supplyRow').classList.toggle('hidden', !pad.customSupply || sol);
  $('quoteRow').classList.toggle('hidden', pad.family !== 'rialto');
  $('solRow').classList.toggle('hidden', !meteora);   // Meteora curve params
  $('raydiumRow').classList.toggle('hidden', !raydium); // LaunchLab quote + dev buy
  $('pumpRow').classList.toggle('hidden', !pump);       // pump.fun dev buy + live pair check
  if (pump) renderArmed();
  $('clmmRow').classList.toggle('hidden', !clmm);      // single-sided CLMM curve
  $('uniRow').classList.toggle('hidden', !uni);
  $('flapRow').classList.toggle('hidden', !flap);
  $('ponsRow').classList.toggle('hidden', !ponsV2);    // Pons v2 pair + dev buy
  $('v4curveRow').classList.toggle('hidden', !v4curve); // our v4 curve: any quote + threshold
  $('longRow').classList.toggle('hidden', !long);       // long.xyz: stock numeraire + supply
  $('lunchRow').classList.toggle('hidden', !lunch);     // lunch.fun: pairing, tax, rewards, quote-buy
  // B20 has no bonding curve / dev buy — you mint a fixed on-chain allocation. Its
  // "distributions" are the insider allocations (minted at creation, not transfers).
  // flap/pons-v2 have their own dev-buy field (in the pair token), so hide the ETH one.
  $('devBuyBlock').classList.toggle('hidden', sol || uni || b20 || flap || ponsV2 || lunch);
  $('distroBlock').classList.toggle('hidden', sol || uni || dyor || flap);
  if (flap) updateFlapUI(pad);
  if (ponsV2) updatePonsUI(pad);
  if (v4curve) updateV4CurveUI(pad);
  if (long) updateLongUI(pad);
  if (lunch) updateLunchUI(pad);
  // o1 / B20: fixed 1B supply. The DISTRO slots ARE the wallet allocations (minted
  // natively at launch, not post-launch transfers) — pre-fill the dev wallet in slot 1
  // and open the panel so it's obvious you can add more.
  const distLabel = $('distroBlock').querySelector('label');
  if (distLabel) distLabel.textContent = b20 ? 'WALLET ALLOCATIONS' : 'DISTRO';
  const distHint = $('distPanel').querySelector('.hint');
  if (distHint) distHint.textContent = b20
    ? 'amount in tokens (e.g. 200000000) or % of the 1B supply (e.g. 20%). minted directly to each wallet at launch — no dev buy, no post-launch transfers. whatever you don’t allocate seeds the pool.'
    : 'amount in tokens (e.g. 10000000) or % of supply (e.g. 2%). sent from your wallet right after launch — needs a dev buy big enough to cover it.';
  // o1's total supply is FIXED at 1B on-chain, so always show it (read-only); other
  // pads keep the editable supply field.
  $('supply').readOnly = !!b20;
  if (b20) {
    $('supply').value = (pad.defaultSupply || 1_000_000_000).toLocaleString('en-US');
    if (account && !$('distRows').children.length) $('distRows').appendChild(distRow(account.address, '200000000'));
    distroOn = true;
    $('distToggle').textContent = 'on'; $('distToggle').classList.add('active');
    $('distPanel').classList.remove('hidden');
  }
  if (pad.family === 'rialto') refreshRialtoQuotes(pad);
  if (meteora) updateSolQuoteUI(pad);
  if (raydium) updateRaydiumUI(pad);
  $('raydiumFeeRow').classList.toggle('hidden', !(raydium && pad.token2022));
  if (clmm) updateClmmUI(pad);
  updateWalletChip(pad);
}

// CLMM curve: populate quote dropdown, toggle custom-mint field + quote symbol
function updateClmmUI(pad) {
  const qs = $('clmmQuoteSelect');
  if (qs.dataset.padId !== pad.id) {
    qs.innerHTML = pad.quotes.map((q) => `<option value="${esc(q.symbol)}">${esc(q.symbol)}</option>`).join('');
    qs.dataset.padId = pad.id;
  }
  const q = pad.quotes.find((x) => x.symbol === qs.value) || pad.quotes[0];
  const isCustom = q.mint === 'custom';
  $('clmmQuoteCustom').classList.toggle('hidden', !isCustom);
  const sym = isCustom ? 'quote' : q.symbol;
  $('clmmDevSym').textContent = sym;
  $('clmmSeedSym').textContent = sym;
}

// Raydium: populate the quote dropdown, toggle the custom-mint field + dev-buy symbol
// Quote mints discovered by SCAN, keyed by pad id. These are appended to the
// dropdown so a config that no launchpad website lists is still one click away.
const scannedQuotes = new Map();

function raydiumQuoteList(pad) {
  return [...(pad.quotes || []), ...(scannedQuotes.get(pad.id) || [])];
}

function updateRaydiumUI(pad) {
  const qs = $('raydiumQuoteSelect');
  const list = raydiumQuoteList(pad);
  const stamp = pad.id + ':' + list.length;
  if (qs.dataset.padStamp !== stamp) {
    const prev = qs.value;
    const opt = (q) => `<option value="${esc(q.symbol)}">${esc(q.symbol)}`
      + (q.name && q.mint !== 'custom' ? ' — ' + esc(q.name) : '') + '</option>';
    // group by category when the pad supplies one (stonkfun does), otherwise flat
    const kinds = [...new Set(list.map((q) => q.kind).filter(Boolean))];
    if (kinds.length) {
      let html = '';
      for (const k of kinds) {
        const inKind = list.filter((q) => q.kind === k);
        html += k === 'custom' ? inKind.map(opt).join('')
          : `<optgroup label="${esc(k.toUpperCase())}">${inKind.map(opt).join('')}</optgroup>`;
      }
      html += list.filter((q) => !q.kind).map(opt).join('');
      qs.innerHTML = html;
    } else {
      qs.innerHTML = list.map(opt).join('');
    }
    if (prev && list.some((q) => q.symbol === prev)) qs.value = prev;
    qs.dataset.padStamp = stamp;
    qs.dataset.padId = pad.id;
  }
  const q = list.find((x) => x.symbol === qs.value) || list[0];
  const isCustom = q.mint === 'custom';
  $('raydiumQuoteCustom').classList.toggle('hidden', !isCustom);
  $('raydiumDevSym').textContent = isCustom ? 'quote' : q.symbol;
}

/// Pull every LaunchLab config that exists on chain and fold the ones this pad
/// does not already list into the dropdown.
///
/// LaunchLab will only pair against a quote mint that has a config, and every
/// config was created by Raydium's admin — there is no instruction for anyone
/// else to make one, so the set is fixed and can only be discovered. What each
/// frontend shows you is a subset of it: stonkfun lists 425 of the 474 that
/// exist. The rest are perfectly launchable, just not offered anywhere, which
/// is exactly what this surfaces.
async function raydiumScanConfigs(pad) {
  const st = $('raydiumScanStatus');
  const btn = $('raydiumScanBtn');
  btn.disabled = true;
  st.textContent = 'reading LaunchLab configs from the chain…';
  try {
    const { listLaunchpadConfigs } = await import('./solana.js');
    const found = await listLaunchpadConfigs(pad.rpc);
    const known = new Set((pad.quotes || []).map((q) => q.mint));
    const extra = found
      .filter((f) => !known.has(f.mint) && f.decimals != null)
      .map((f) => ({
        symbol: f.mint.slice(0, 4) + '…' + f.mint.slice(-4),
        mint: f.mint, decimals: f.decimals, kind: 'unlisted', name: 'config ' + f.configId.slice(0, 8) + '…',
      }));
    scannedQuotes.set(pad.id, extra);
    updateRaydiumUI(pad);
    st.innerHTML = `<span class="ok">${found.length} configs on chain</span> · `
      + `${extra.length} not in this pad's list, now selectable under UNLISTED`;
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(e?.message || String(e))}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// Solana quote dropdown -> custom-mint field + default migration threshold
function updateSolQuoteUI(pad) {
  const sel = $('solQuoteSelect').value;
  pad.quoteSel = sel;
  const custom = sel === 'CUSTOM';
  $('solCustomMint').classList.toggle('hidden', !custom);
  if (custom && !$('solCustomMint').value.trim()) $('solCustomMint').value = SOL_CUSTOM_DEFAULT;
  const q = SOL_QUOTES[sel];
  const thr = $('solMigThreshold');
  if (!thr.value.trim()) thr.value = q ? q.defaultThreshold : SOL_CUSTOM_THRESHOLD;
  $('solQuoteHint').textContent = custom
    ? 'any SPL or Token-2022 mint (metadata-only extensions)'
    : `token pooled against ${q.symbol} · threshold in ${q.symbol}`;
}

// flap: populate quote dropdown, toggle mode-dependent fields, set dev-buy symbol
function updateFlapUI(pad) {
  const qs = $('flapQuoteSelect');
  if (qs.dataset.padId !== pad.id) {
    qs.innerHTML = pad.quotes.map((q) => `<option value="${esc(q.symbol)}">${esc(q.symbol)}</option>`).join('');
    qs.dataset.padId = pad.id;
  }
  const quote = pad.quotes.find((q) => q.symbol === qs.value) || pad.quotes[0];
  const isCustom = quote.address === 'custom';
  $('flapQuoteCustom').classList.toggle('hidden', !isCustom);
  const nativeQuote = quote.address === '0x0000000000000000000000000000000000000000';
  const mode = $('flapMode').value;
  $('flapSplitWrap').classList.toggle('hidden', mode === 'standard');
  $('flapDivWrap').classList.toggle('hidden', mode !== 'dividends');
  $('flapDivCustom').classList.toggle('hidden', $('flapDivToken').value !== 'custom');
  // dev buy: native quote pays in the native coin; a stock/ERC-20 quote (BSC only)
  // is funded by BNB/USDC swapped on PancakeSwap into the pair token.
  const dev = $('flapDevBuy');
  const swapFundable = !nativeQuote && !isCustom && pad.chainId === 56;
  dev.disabled = !nativeQuote && !swapFundable;
  dev.title = dev.disabled ? 'dev buy needs the native pair, or a stock pair on BNB (funded via an aggregator swap)' : '';
  $('flapDevFundWrap').classList.toggle('hidden', !swapFundable);
  $('flapDevSym').textContent = swapFundable ? ($('flapDevFund').value || 'BNB') : pad.nativeSymbol;
  $('flapHint').textContent = mode === 'dividends'
    ? `${$('flapSplit').value || 50}% of the ${$('flapTax').value || 10}% tax paid to holders in ${$('flapDivToken').value === 'self' ? symbolOrToken() : $('flapDivToken').value === 'quote' ? quote.symbol : 'a custom token'} · address mined to end 7777`
    : mode === 'burn'
      ? `${$('flapSplit').value || 50}% of the ${$('flapTax').value || 10}% tax burned each trade · address mined to end 7777`
      : `${$('flapTax').value || 10}% buy/sell tax → your wallet · address mined to end 7777`;
}
function symbolOrToken() { const s = document.getElementById('symbol'); return (s && s.value.trim()) || 'the token'; }

// Pons v2: populate the pair dropdown, toggle the custom field + dev-buy symbol
function updatePonsUI(pad) {
  const qs = $('ponsQuoteSelect');
  if (qs.dataset.padId !== pad.id) {
    qs.innerHTML = pad.quotes.map((q) => `<option value="${esc(q.symbol)}">${esc(q.symbol)}</option>`).join('');
    qs.dataset.padId = pad.id;
  }
  const q = pad.quotes.find((x) => x.symbol === qs.value) || pad.quotes[0];
  const isCustom = q.address === 'custom';
  $('ponsQuoteCustom').classList.toggle('hidden', !isCustom);
  $('ponsDevSym').textContent = isCustom ? 'pair' : q.symbol;
}

// our v4 curve: quote dropdown -> custom field + threshold/dev-buy unit labels
function updateV4CurveUI(pad) {
  const qs = $('v4curveQuoteSelect');
  if (qs.dataset.padId !== pad.id) {
    qs.innerHTML = pad.quotes.map((q) => `<option value="${esc(q.symbol)}">${esc(q.symbol)}</option>`).join('');
    qs.dataset.padId = pad.id;
  }
  const q = pad.quotes.find((x) => x.symbol === qs.value) || pad.quotes[0];
  const isCustom = q.address === 'custom';
  $('v4curveQuoteCustom').classList.toggle('hidden', !isCustom);
  const sym = isCustom ? 'quote' : q.symbol;
  $('v4curveThreshSym').textContent = sym;
  $('v4curveDevSym').textContent = sym;
}

// long.xyz: numeraire dropdown grouped by asset class, plus the custom field
function updateLongUI(pad) {
  const qs = $('longQuoteSelect');
  if (qs.dataset.padId !== pad.id) {
    const groups = { stable: 'STABLE', etf: 'ETFs', stock: 'STOCKS', custom: '' };
    let html = '';
    for (const g of ['stable', 'etf', 'stock', 'custom']) {
      const list = pad.quotes.filter((q) => q.kind === g);
      if (!list.length) continue;
      const opts = list.map((q) => `<option value="${esc(q.symbol)}">${esc(q.symbol)}${q.name && q.kind !== 'custom' ? ' — ' + esc(q.name) : ''}</option>`).join('');
      html += groups[g] ? `<optgroup label="${groups[g]}">${opts}</optgroup>` : opts;
    }
    qs.innerHTML = html;
    qs.value = 'NVDA';
    qs.dataset.padId = pad.id;
  }
  const q = pad.quotes.find((x) => x.symbol === qs.value) || pad.quotes[0];
  $('longQuoteCustom').classList.toggle('hidden', q.address !== 'custom');
}

function updateWalletChip(pad) {
  if (pad.vm === 'sol') {
    if (!solKeyB58) { $('walletAddr').textContent = 'no SOL key'; $('walletChip').title = 'import a SOL key to launch here'; return; }
    const a = solPubkeyFromSecret(solKeyB58);
    $('walletAddr').textContent = a.slice(0, 4) + '…' + a.slice(-4);
    $('walletChip').title = a + ' (SOL — click to copy)';
  } else if (account) {
    $('walletAddr').textContent = account.address.slice(0, 6) + '…' + account.address.slice(-4);
    $('walletChip').title = account.address + ' (click to copy)';
  }
}

async function refreshFeeNote() {
  if (!activePad.enabled) return;
  if (activePad.family === 'uniswap') {
    $('feeNote').textContent = 'deploy + approve + add-liquidity gas · your ETH pooled as liquidity';
    return;
  }
  if (activePad.family === 'dyorswap') {
    $('feeNote').textContent = 'launch fee ~0.0005 USDC + optional USDC dev buy + gas · paired vs USDC on Uniswap V3 · LP locked';
    return;
  }
  if (activePad.family === 'rialto') {
    const bps = rialtoConfig?.initial_protocol_fee_bps ?? 3000;
    $('feeNote').textContent = `Rialto protocol fee ${(bps / 100).toFixed(1)}% on trades + gas`;
    return;
  }
  if (activePad.family === 'b20') {
    $('feeNote').textContent = 'B20 on Base · no launch fee · you mint the on-chain + insider allocations · gas only';
    return;
  }
  if (activePad.family === 'flap') {
    $('feeNote').textContent = `flap tax token · buy/sell tax splits per mode · address mined to end 7777 · optional dev buy + gas (${activePad.nativeSymbol})`;
    return;
  }
  try {
    const fee = await publicClientFor(activePad).readContract({
      address: activePad.factory, abi: FACTORY_ABI, functionName: 'launchFee',
    });
    $('feeNote').textContent = `launch fee ${formatEther(fee)} ${activePad.nativeSymbol} + dev buy + gas`;
  } catch { $('feeNote').textContent = ''; }
}

async function refreshBalance() {
  if (!activePad.enabled) return;
  if (activePad.vm === 'sol') {
    if (!solKeyB58) { $('walletBal').textContent = ''; return; }
    try {
      const a = solPubkeyFromSecret(solKeyB58);
      const r = await fetch(activePad.rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [a] }),
      });
      const j = await r.json();
      $('walletBal').textContent = (j.result.value / 1e9).toFixed(4) + ' SOL';
    } catch { /* rpc hiccup, ignore */ }
    return;
  }
  if (!account) return;
  try {
    const bal = await publicClientFor(activePad).getBalance({ address: account.address });
    $('walletBal').textContent = (+formatEther(bal)).toFixed(4) + ' ' + activePad.nativeSymbol;
  } catch { /* rpc hiccup, ignore */ }
}

function onUnlocked() {
  $('setupOverlay').classList.add('hidden');
  $('walletDot').classList.add('on');
  if (account) $('feeRecipient').placeholder = account.address + ' (default)';
  updateWalletChip(activePad);
  refreshBalance();
  renderTokenList();
}

// first-run setup: paste EVM and/or SOL key (both optional), stored plaintext
function doSetup() {
  try {
    $('setupErr').textContent = '';
    const evmRaw = $('setupKey').value.trim();
    const solRaw = $('setupSolKey').value.trim();
    if (!evmRaw && !solRaw) throw new Error('enter an EVM and/or SOL private key');
    const keys = {};
    if (evmRaw) { evmPk = normalizeEvmKey(evmRaw); keys.evm = evmPk; account = privateKeyToAccount(evmPk); }
    if (solRaw) { solKeyB58 = validateSolKey(solRaw); keys.sol = solKeyB58; }
    saveKeys(keys);
    $('setupKey').value = ''; $('setupSolKey').value = '';
    if (!account && solKeyB58) activePad = PADS.find((p) => p.id === 'meteora-sol') || activePad;
    onUnlocked();
    renderPads(); applyPadUI(activePad);
  } catch (e) { $('setupErr').textContent = e.message; }
}

// auto-load the plaintext keys on open (no password, no prompt)
function autoLoadKeys() {
  const k = loadKeys();
  if (!k || (!k.evm && !k.sol)) return false;
  try {
    if (k.evm) { evmPk = k.evm; account = privateKeyToAccount(k.evm); }
    if (k.sol) solKeyB58 = k.sol;
    if (!account && solKeyB58) activePad = PADS.find((p) => p.id === 'meteora-sol') || activePad;
    onUnlocked();
    renderPads(); applyPadUI(activePad);
    return true;
  } catch { return false; }
}

// add or replace a stored key (no password — plaintext local store)
function doImportKeys() {
  try {
    $('importErr').textContent = '';
    const solRaw = $('importSolKey').value.trim();
    const evmRaw = $('importEvmKey').value.trim();
    if (!solRaw && !evmRaw) throw new Error('enter a SOL or EVM key to import');

    const keys = loadKeys() || {};
    if (solRaw) { solKeyB58 = validateSolKey(solRaw); keys.sol = solKeyB58; }
    if (evmRaw) { evmPk = normalizeEvmKey(evmRaw); keys.evm = evmPk; account = privateKeyToAccount(evmPk); }
    saveKeys(keys);

    $('importSolKey').value = ''; $('importEvmKey').value = '';
    $('keysOverlay').classList.add('hidden');
    updateWalletChip(activePad);
    refreshBalance();
    renderTokenList();
    setStatus('keys updated ✓');
  } catch (e) { $('importErr').textContent = e.message; }
}

function init() {
  renderPads();
  renderBuyChips();
  refreshFeeNote();
  applyPadUI(activePad);
  $('supply').addEventListener('input', updateBuyPreview);
  $('quoteSelect').addEventListener('change', () => {
    activePad.quoteToken = $('quoteSelect').value;
    updateRialtoHint(activePad);
  });
  $('solQuoteSelect').addEventListener('change', () => updateSolQuoteUI(activePad));
  $('raydiumQuoteSelect').addEventListener('change', () => { if (activePad.family === 'raydium') updateRaydiumUI(activePad); });
  $('raydiumScanBtn').addEventListener('click', () => { if (activePad.family === 'raydium') raydiumScanConfigs(activePad); });
  $('pumpCheckBtn').addEventListener('click', () => { if (activePad.family === 'pump') pumpCheckPairs(activePad); });
  $('pumpArmBtn').addEventListener('click', () => { if (activePad.family === 'pump') pumpArm(activePad); });
  $('solPumpEconBtn').addEventListener('click', () => { if (activePad.family === 'meteora') applyPumpEconomics(activePad); });
  $('clmmQuoteSelect').addEventListener('change', () => { if (activePad.family === 'clmm') updateClmmUI(activePad); });
  $('ponsQuoteSelect').addEventListener('change', () => { if (activePad.family === 'pons-v2') updatePonsUI(activePad); });
  $('v4curveQuoteSelect').addEventListener('change', () => { if (activePad.family === 'v4curve') updateV4CurveUI(activePad); });
  $('longQuoteSelect').addEventListener('change', () => { if (activePad.family === 'long') updateLongUI(activePad); });
  for (const id of ['lunchQuoteSelect', 'lunchRewards']) {
    $(id).addEventListener('change', () => { if (activePad.family === 'lunch') updateLunchUI(activePad); });
  }
  $('lunchBuyBtn').addEventListener('click', () => { if (activePad.family === 'lunch') lunchBuyQuote(activePad); });
  for (const id of ['flapQuoteSelect', 'flapMode', 'flapDivToken', 'flapTax', 'flapSplit', 'flapDevFund']) {
    const el = $(id);
    if (el) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { if (activePad.family === 'flap') updateFlapUI(activePad); });
  }

  $('distToggle').onclick = toggleDistro;
  $('distAdd').onclick = () => $('distRows').appendChild(distRow());
  $('distSave').onclick = saveDistSet;
  $('distDelete').onclick = deleteDistSet;

  $('chipAdd').onclick = () => $('chipEditRows').appendChild(chipEditRow(''));
  $('chipSave').onclick = saveChipEditor;
  $('chipCancel').onclick = () => $('chipsOverlay').classList.add('hidden');

  $('keysLink').onclick = () => { $('importErr').textContent = ''; $('keysOverlay').classList.remove('hidden'); };
  $('importBtn').onclick = doImportKeys;
  $('importCancel').onclick = () => $('keysOverlay').classList.add('hidden');
  $('clearKeys').onclick = () => {
    if (confirm('Delete the stored key(s) from this browser?')) { localStorage.removeItem(KEYS_KEY); location.reload(); }
  };

  $('refreshTokens').onclick = renderTokenList;
  $('claimAll').onclick = () => claimAllFees($('claimAll'));
  $('ponsV2ClaimBtn').onclick = claimPonsV2;
  $('ponsV2Refresh').onclick = refreshPonsV2Bal;
  $('ponsV2Token').addEventListener('input', refreshPonsV2Bal);
  $('claimAddrBtn').onclick = () => {
    const addr = $('claimAddr').value.trim();
    // Solana / Meteora: paste a DBC pool address (base58) to claim its fees
    if (activePad.vm === 'sol' && activePad.family === 'meteora') {
      if (!isSolAddress(addr)) { $('claimStatus').innerHTML = '<span class="err">not a valid Solana pool address</span>'; return; }
      claimMeteora(addr, $('claimAddrBtn'));
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      $('claimStatus').innerHTML = '<span class="err">not a valid token address</span>';
      return;
    }
    claimFees(claimPad(), addr, $('claimAddrBtn'));
  };

  // auto-load stored keys (plaintext, no password); else show the setup form
  if (!autoLoadKeys()) $('setupOverlay').classList.remove('hidden');

  $('setupBtn').onclick = doSetup;
  $('resetVault').onclick = () => {
    if (confirm('Delete the stored key(s) from this browser?')) {
      localStorage.removeItem(KEYS_KEY);
      location.reload();
    }
  };

  $('walletChip').onclick = () => {
    const addr = activePad.vm === 'sol' ? (solKeyB58 && solPubkeyFromSecret(solKeyB58)) : account?.address;
    if (addr) { navigator.clipboard.writeText(addr); return; }
    // no key loaded for this chain — open the import form
    $('importErr').textContent = '';
    $('keysOverlay').classList.remove('hidden');
  };

  $('vampBtn').onclick = vamp;

  // image: click / drop / paste
  const drop = $('drop'), file = $('file');
  drop.onclick = () => file.click();
  file.onchange = () => setImage(file.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); setImage(e.dataTransfer.files[0]); };
  document.addEventListener('paste', (e) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) { setImage(item.getAsFile()); break; }
    }
  });

  $('launchBtn').onclick = async () => {
    const btn = $('launchBtn');
    btn.disabled = true;
    try { await launch(); }
    catch (e) { setStatus((e && (e.shortMessage || e.message)) || String(e) || 'launch failed (no error detail — check the RPC/console)', true); }
    finally { btn.disabled = false; }
  };

  setInterval(refreshBalance, 30000);
}

// no login gate — private/local tool. Boot straight into the app.
$('appRoot').style.display = '';
init();
