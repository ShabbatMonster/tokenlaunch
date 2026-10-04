// ---------------------------------------------------------------------------
// Abyss Launch ("Black Market Launch") on Robinhood Chain.
//
// WHAT THIS IS NOT, YET: a working launch path. The whole system was deployed
// a few hours before this file was written and has done nothing since. Every
// address below is live and has real code, but:
//
//   templateRegistry   0 logs since deployment, nothing registered
//   launchFactory      0 logs, 0 contracts deployed
//   tokenFactory       0 logs, 0 tokens deployed
//   coordinator        nextTokenId() reverts, 0 wei
//   launch.abyss.trading   renders a component literally named
//                          `maintenance-splash`, whose only content is the
//                          words "In the depths..."
//
// So there is no registered template to name, and - the part that matters -
// no reference launch anywhere to copy. Every other venue in this repo was
// built by decoding a real, healthy transaction, and every time that reference
// was missing something got guessed wrong: the StonkFun raise, the Rehype hook
// config on long.xyz, pump's creator field. A launch() here would be ten
// inferred fields carrying real money into contracts deployed this afternoon.
// This file therefore reads and simulates; it does not send.
//
// What IS established, and worth keeping so wiring it later is short:
//
// The entry point is GATED. Both the token factory and the module factory
// return the launchFactory from `launcher()`, so they only accept calls from
// it - you cannot mint a token by calling the token factory directly.
//
// The launch call itself is fully typed (selector resolved against
// openchain.xyz, not guessed):
//
//   launch((
//     address,                                           quote / pair token
//     bytes32,                                           template id
//     bytes32,                                           second id - salt or module set
//     uint32,                                            template version
//     (bytes32, bytes, string, string, uint8, uint256),  token: type, data, name, symbol, decimals, supply
//     bytes,                                             module config
//     (uint256, uint256, uint160),                       amounts + sqrtPrice
//     (uint16, uint16, uint16),                          fee split, bps
//     (uint16, uint16, uint16),                          second fee split, bps
//     uint256                                            deadline
//   ))
//
// The field NAMES above past the first four are inferred from the surrounding
// interface, not read off a reference - templateRegistry exposes
// `isRegistered(bytes32,uint32)` which is what pins the id/version pair, the
// token factory exposes `tokenTypes(bytes32)` which pins the leading bytes32 of
// the token tuple, and the coordinator's errors name the rest
// (InvalidPriceBounds, DeadlineExpired, InvalidConfiguration).
//
// The pleasant surprise is the pool side: the coordinator exposes
// `computePoolId((address,address,uint8,uint24,bool,bytes32))` - the SAME
// six-field Abyss pool key that src/swap.js already reverse-engineered for
// trading. So the launch and the swap path agree about what a pool is, and
// nothing new has to be learned there.
// ---------------------------------------------------------------------------

import { createPublicClient, http, getAddress } from 'viem';
import { ROBINHOOD } from './rhPrice.js';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';

/// Verified on 2026-10-04: each of these returns non-empty code on Robinhood
/// Chain. They come from the launch site's own checked-in address map, which is
/// worth stating because the bundle ALSO ships a local-dev env block
/// (VITE_CHAIN_ID 31337, VITE_RPC_URL 127.0.0.1:8545) that would be the wrong
/// thing to read - those are build noise; these are the live deployment.
export const ABYSS_LAUNCH = {
  launchFactory: getAddress('0xa7a4755fb907593f05fd1e289aa780f0d57f3a12'),
  coordinator: getAddress('0xcc3aa2dff0fd6e9505b12b731111ec1b7b49621d'),
  tokenFactory: getAddress('0x84225a7b7fd9981f8a3086acfbbb688348247f6f'),
  moduleFactory: getAddress('0xe6bb1f77b94fa2003db0f4c2e248649061922c64'),
  templateRegistry: getAddress('0x01422012c452f2e363d56bd408c7ed1c44204701'),
  feeOwnerRegistry: getAddress('0xa8018950ebb6a35708820c89243ddab8718ee0bc'),
};

/// The EOA that administers the registries - 622 transactions sent and holding
/// real ETH, so it is an operator rather than a placeholder. Templates will
/// appear when it registers them.
export const ABYSS_REGISTRAR = getAddress('0x7cb44b8693b3c350a2bcd4b681af85365aa27783');

/// Roughly when the template registry appeared, found by bisecting getCode over
/// historical blocks. Recorded because "deployed hours ago" is the single most
/// important fact about this integration.
export const ABYSS_LAUNCH_DEPLOYED = { block: 80149812, iso: '2026-10-04T18:30:14.000Z' };

export const LAUNCH_SELECTOR = '0x6830d284';

/// The six-field Abyss pool key, identical to the one src/swap.js trades
/// through. profile/flag/extra are not derivable from a token pair - see that
/// file - which is why the coordinator exposes computePoolId at all.
export const ABYSS_POOL_KEY = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'profile', type: 'uint8' },
  { name: 'fee', type: 'uint24' },
  { name: 'flag', type: 'bool' },
  { name: 'extra', type: 'bytes32' },
];

export const ABYSS_LAUNCH_ABI = [
  // the gated entry point
  {
    type: 'function',
    name: 'launch',
    stateMutability: 'payable',
    outputs: [],
    inputs: [{
      type: 'tuple',
      name: 'params',
      components: [
        { name: 'quote', type: 'address' },
        { name: 'templateId', type: 'bytes32' },
        { name: 'secondId', type: 'bytes32' },
        { name: 'templateVersion', type: 'uint32' },
        {
          name: 'token',
          type: 'tuple',
          components: [
            { name: 'tokenType', type: 'bytes32' },
            { name: 'data', type: 'bytes' },
            { name: 'name', type: 'string' },
            { name: 'symbol', type: 'string' },
            { name: 'decimals', type: 'uint8' },
            { name: 'supply', type: 'uint256' },
          ],
        },
        { name: 'moduleConfig', type: 'bytes' },
        {
          name: 'liquidity',
          type: 'tuple',
          components: [
            { name: 'amount0', type: 'uint256' },
            { name: 'amount1', type: 'uint256' },
            { name: 'sqrtPriceX96', type: 'uint160' },
          ],
        },
        {
          name: 'splitA',
          type: 'tuple',
          components: [{ name: 'a', type: 'uint16' }, { name: 'b', type: 'uint16' }, { name: 'c', type: 'uint16' }],
        },
        {
          name: 'splitB',
          type: 'tuple',
          components: [{ name: 'a', type: 'uint16' }, { name: 'b', type: 'uint16' }, { name: 'c', type: 'uint16' }],
        },
        { name: 'deadline', type: 'uint256' },
      ],
    }],
  },
  { type: 'function', name: 'poolRegistry', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'adapter', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
];

export const ABYSS_REGISTRY_ABI = [
  { type: 'function', name: 'isRegistered', inputs: [{ type: 'bytes32' }, { type: 'uint32' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'registrar', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'INITIAL_VERSION', inputs: [], outputs: [{ type: 'uint32' }], stateMutability: 'view' },
];

export const ABYSS_TOKEN_FACTORY_ABI = [
  { type: 'function', name: 'tokenTypes', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'launcher', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'tokenDeployer', inputs: [{ type: 'address' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
];

export const ABYSS_COORDINATOR_ABI = [
  { type: 'function', name: 'computePoolId', inputs: [{ type: 'tuple', components: ABYSS_POOL_KEY }], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'computePoolAddress', inputs: [{ type: 'tuple', components: ABYSS_POOL_KEY }], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'launches', inputs: [{ type: 'address' }], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'positionManager', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'positionLocker', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'tokenFactory', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];

/// The errors these contracts can revert with, so a failure reads as a reason
/// rather than as four bytes. Collected from the deployed bytecode.
export const ABYSS_LAUNCH_ERRORS = {
  '0xab143c06': 'Reentrancy',
  '0x5dc588a5': 'DuplicateLaunch',
  '0xc52a9bd3': 'InvalidConfiguration',
  '0x1ab7da6b': 'DeadlineExpired',
  '0xc256622b': 'InvalidPoolKey',
  '0x79ee3325': 'InvalidPriceBounds',
  '0xec55b8cd': 'InvalidTemplate',
  '0xa1e9dd9d': 'InvalidTokenType',
  '0x6567b179': 'InvalidLauncher',
  '0x7483e907': 'InvalidDeployment',
  '0xd92e233d': 'ZeroAddress',
  '0x8a7b3bbf': 'ApprovalMismatch',
};

export const publicClient = () => createPublicClient({
  chain: ROBINHOOD,
  transport: http(RPC, { retryCount: 5, retryDelay: 900 }),
});

/// Is Abyss Launch actually usable yet?
///
/// Answered from the chain rather than from a flag in this file, because the
/// answer is expected to change: the contracts are live and the operator is
/// active, so this becomes true without any code change here. `ready` means
/// the gate is wired AND at least one template is registered.
export async function abyssLaunchStatus({ connection } = {}) {
  const pub = connection || publicClient();
  const read = (address, abi, functionName, args) => pub
    .readContract({ address, abi, functionName, args })
    .catch(() => null);

  const [launcher, coordinatorTokenFactory, initialVersion, registrar] = await Promise.all([
    read(ABYSS_LAUNCH.tokenFactory, ABYSS_TOKEN_FACTORY_ABI, 'launcher'),
    read(ABYSS_LAUNCH.coordinator, ABYSS_COORDINATOR_ABI, 'tokenFactory'),
    read(ABYSS_LAUNCH.templateRegistry, ABYSS_REGISTRY_ABI, 'INITIAL_VERSION'),
    read(ABYSS_LAUNCH.templateRegistry, ABYSS_REGISTRY_ABI, 'registrar'),
  ]);

  const gateWired = !!launcher && getAddress(launcher) === ABYSS_LAUNCH.launchFactory;
  const templates = await findAbyssTemplates({ connection: pub, version: initialVersion ?? 1 });

  return {
    gateWired,
    launcher: launcher ? getAddress(launcher) : null,
    coordinatorTokenFactory: coordinatorTokenFactory ? getAddress(coordinatorTokenFactory) : null,
    registrar: registrar ? getAddress(registrar) : null,
    initialVersion: initialVersion ?? null,
    templates,
    ready: gateWired && templates.length > 0,
    reason: !gateWired
      ? 'the launch factory is not wired as the token factory\'s launcher'
      : templates.length === 0
        ? 'no template is registered yet - Abyss Launch is deployed but not open'
        : null,
  };
}

/// Every template id this knows how to check for, and whether it is registered.
///
/// Deliberately a LIST OF CANDIDATES rather than an enumeration: the registry
/// exposes `isRegistered(id, version)` and no iterator, so ids can only be
/// confirmed, never discovered. Once Abyss registers one, its id arrives either
/// in a registry event or in their frontend when it leaves maintenance - add it
/// here and everything downstream works.
export const ABYSS_TEMPLATE_CANDIDATES = [];

export async function findAbyssTemplates({ connection, version = 1, candidates = ABYSS_TEMPLATE_CANDIDATES } = {}) {
  if (!candidates.length) return [];
  const pub = connection || publicClient();
  const results = await Promise.all(candidates.map(async (c) => {
    const ok = await pub.readContract({
      address: ABYSS_LAUNCH.templateRegistry,
      abi: ABYSS_REGISTRY_ABI,
      functionName: 'isRegistered',
      args: [c.id, version],
    }).catch(() => false);
    return ok ? { ...c, version } : null;
  }));
  return results.filter(Boolean);
}

/// Build the launch call and SIMULATE it, never send.
///
/// The only safe thing to do against this system today: the chain validates the
/// config and names its own error, which is far better than inferring from ten
/// fields whether a launch would do what was intended. When Abyss opens, this
/// is also the preflight a real send should go through first.
export async function simulateAbyssLaunch({ account, params, value = 0n, connection }) {
  const pub = connection || publicClient();
  try {
    await pub.simulateContract({
      address: ABYSS_LAUNCH.launchFactory,
      abi: ABYSS_LAUNCH_ABI,
      functionName: 'launch',
      args: [params],
      account,
      value,
    });
    return { ok: true, error: null };
  } catch (e) {
    const raw = e?.cause?.data?.slice?.(0, 10) || e?.data?.slice?.(0, 10) || null;
    return {
      ok: false,
      error: (raw && ABYSS_LAUNCH_ERRORS[raw]) || e?.shortMessage || e?.message || String(e),
      selector: raw,
    };
  }
}
