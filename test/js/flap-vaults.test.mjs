// flap.sh fee vaults on BNB: launching through VaultPortal.newTokenV6WithVault
// so the market share of the tax goes to a vault instead of a wallet - the X
// account (gift) vault, a split across wallets, and the stock-dividend vaults.
//
// The params are newTokenV6's minus `beneficiary` plus `vaultFactory` +
// `vaultData`. Each factory publishes its own launch rules through
// tokenCreationPolicies(), which the pad reads and enforces.
// Live checks need a BSC RPC; pure wiring checks always run.
//   node test/js/flap-vaults.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import { createPublicClient, http, keccak256, concat, getAddress, stringToBytes, encodeAbiParameters, decodeAbiParameters, parseEther } from 'viem';
import { bsc } from 'viem/chains';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');

const VAULT_PORTAL = '0x90497450f2a706f1951b5bdda52B4E5d16f34C06';
const PORTAL = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
const IMPL = '0x024f18294970B5c76c0691b87f138A0317156422';
const ZERO = '0x0000000000000000000000000000000000000000';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const NVDAON = '0xA9eE28C80f960B889dFbd1902055218cBa016F75';
const FROM = '0x8894E0a0c962CB723c1976a4421c95949bE2D4E3';   // funded; every call is read-only
const F = {
  gift: '0x5e8604a69158FA583b0C5c16441A9b3d429E7Cbb',
  giftv2: '0xFb7ccc4Fd09Da5b7016A18d51e227Af4ABE53f44',
  giftx: '0x025549F52B03cF36f9e1a337c02d3AA7Af66ab32',
  split: '0xfab75Dc774cB9B38b91749B8833360B46a52345F',
  rwa2: '0x40a9a2FDa017E0923EA0B403F2f063f9E51168Fb',
  rwa1: '0xf8aC088F06D155f3C3F531f1Ef80B14f1604530a',
};

// --- wiring -----------------------------------------------------------------
check(MAIN.includes(`const FLAP_VAULT_PORTAL = '${VAULT_PORTAL}'`), 'main.js points at the BSC VaultPortal');
for (const [id, addr] of Object.entries(F)) check(new RegExp(`${id}:[\\s\\S]{0,160}${addr}`).test(MAIN), `the ${id} vault factory is wired`);
check(/FLAP_PARAM_COMPONENTS\.filter\(\(c\) => c\.name !== 'beneficiary'\)/.test(MAIN)
  && /\{ name: 'vaultFactory', type: 'address' \}, \{ name: 'vaultData', type: 'bytes' \}/.test(MAIN),
  'the vault params drop beneficiary and add vaultFactory + vaultData');
check(/tokenCreationPolicies/.test(MAIN) && /flapCheckPolicies\(rules, params\)/.test(MAIN), 'the pad reads and enforces each factory\'s published rules');
check(/if \(!\(mktBps > 0\)\) throw new Error/.test(MAIN), 'and refuses a vault launch with no market share to pay it');
for (const id of ['flapVault', 'flapVaultX', 'flapVaultSplit', 'flapVaultRwa', 'flapVaultRules']) check(HTML.includes(`id="${id}"`), `UI has #${id}`);

// --- the one encoding that is easy to get wrong -------------------------------
const encodeXHandle = (h) => encodeAbiParameters([{ type: 'tuple', components: [{ name: 'xHandle', type: 'string' }] }], [{ xHandle: h }]);
{
  const tuple = encodeXHandle('mythlake2016');
  const bare = encodeAbiParameters([{ type: 'string' }], ['mythlake2016']);
  check(tuple !== bare && tuple.length === bare.length + 64, 'a gift vault\'s X handle is encoded as a struct, not a bare string (a bare one panics the factory)');
  check(/encodeXHandle = \(handle\) => encodeAbiParameters\(\s*\[\{ type: 'tuple'/.test(MAIN), 'and main.js encodes it that way');
}

const RPC = process.env.BSC_RPC || 'https://bsc-dataseed.bnbchain.org';
const c = createPublicClient({ chain: bsc, transport: http(RPC) });
if (!(await c.getBlockNumber().catch(() => null))) { console.log('SKIP  no BSC RPC reachable for the live checks'); process.exit(fails.length ? 1 : 0); }

// --- every factory is registered and enabled on the VaultPortal ----------------
const REG_ABI = [{ type: 'function', name: 'vaultFactories', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ name: 'enabled', type: 'bool' }, { name: 'official', type: 'bool' }, { name: 'riskLevel', type: 'uint8' }, { name: 'reserved', type: 'bytes29' }] }];
for (const [id, addr] of Object.entries(F)) {
  const [enabled] = await c.readContract({ address: VAULT_PORTAL, abi: REG_ABI, functionName: 'vaultFactories', args: [addr] });
  check(enabled, `${id} is registered and enabled on the VaultPortal`);
}

// --- simulate a launch per vault ------------------------------------------------
const COMPONENTS = [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'meta', type: 'string' },
  { name: 'dexThresh', type: 'uint8' }, { name: 'salt', type: 'bytes32' }, { name: 'migratorType', type: 'uint8' },
  { name: 'quoteToken', type: 'address' }, { name: 'quoteAmt', type: 'uint256' },
  { name: 'permitData', type: 'bytes' }, { name: 'extensionID', type: 'bytes32' }, { name: 'extensionData', type: 'bytes' },
  { name: 'dexId', type: 'uint8' }, { name: 'lpFeeProfile', type: 'uint8' }, { name: 'buyTaxRate', type: 'uint16' },
  { name: 'sellTaxRate', type: 'uint16' }, { name: 'taxDuration', type: 'uint64' }, { name: 'antiFarmerDuration', type: 'uint64' },
  { name: 'mktBps', type: 'uint16' }, { name: 'deflationBps', type: 'uint16' }, { name: 'dividendBps', type: 'uint16' },
  { name: 'lpBps', type: 'uint16' }, { name: 'minimumShareBalance', type: 'uint256' }, { name: 'dividendToken', type: 'address' },
  { name: 'commissionReceiver', type: 'address' }, { name: 'tokenVersion', type: 'uint8' },
  { name: 'vaultFactory', type: 'address' }, { name: 'vaultData', type: 'bytes' },
];
const ABI = [{ type: 'function', name: 'newTokenV6WithVault', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: COMPONENTS }], outputs: [{ name: 'token', type: 'address' }] }];
const initHash = keccak256(concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', getAddress(IMPL), '0x5af43d82803e903d91602b57fd5bf3']));
const predict = (salt) => '0x' + keccak256(concat(['0xff', getAddress(PORTAL), salt, initHash])).slice(-40);
function mine(tag) {
  for (let n = 0; ; n++) {
    const salt = keccak256(stringToBytes(`${tag}-${n}`));
    if (predict(salt).toLowerCase().endsWith('7777')) return salt;
  }
}
const SPLIT = (rs) => encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'recipient', type: 'address' }, { name: 'bps', type: 'uint16' }] }], [rs]);

async function sim(label, factory, vaultData, over = {}, value = 0n) {
  const salt = mine(label + Date.now() + Math.random());
  const params = {
    name: 'Vault test', symbol: 'VTEST', meta: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
    dexThresh: 1, salt, migratorType: 1, quoteToken: ZERO, quoteAmt: 0n,
    permitData: '0x', extensionID: '0x' + '00'.repeat(32), extensionData: '0x',
    dexId: 0, lpFeeProfile: 0, buyTaxRate: 100, sellTaxRate: 100,
    taxDuration: 3153600000n, antiFarmerDuration: 2592000n,
    mktBps: 10000, deflationBps: 0, dividendBps: 0, lpBps: 0,
    minimumShareBalance: 0n, dividendToken: ZERO, commissionReceiver: ZERO, tokenVersion: 6,
    vaultFactory: getAddress(factory), vaultData, ...over,
  };
  try {
    const { result } = await c.simulateContract({ address: VAULT_PORTAL, abi: ABI, functionName: 'newTokenV6WithVault', args: [params], account: FROM, value });
    return { ok: true, token: result, mined: getAddress(predict(salt)) };
  } catch (e) {
    const d = e.details || '';
    let why = (d.match(/execution reverted:?\s*(.*)/) || [, e.shortMessage || ''])[1] || '';
    if (/0x4e487b71.*0041/.test(d.replace(/\s/g, ''))) why = 'Panic(0x41) — vaultData wrong shape';
    if (/0x2b1599db/.test(d)) why = 'InvalidMktBps()';
    return { ok: false, why: String(why).split(':')[0].slice(0, 100) };
  }
}

const X = encodeXHandle('mythlake2016');
const good = [
  ['the X account vault launches (native pair, 1% tax)', F.gift, X, {}, 0n],
  ['the X account vault at 2% tax', F.gift, X, { buyTaxRate: 200, sellTaxRate: 200 }, 0n],
  ['the X account vault with a burn split', F.gift, X, { buyTaxRate: 300, sellTaxRate: 300, mktBps: 6000, deflationBps: 4000 }, 0n],
  ['the X account vault with a dev buy', F.gift, X, { quoteAmt: parseEther('0.01') }, parseEther('0.01')],
  ['the X account vault against a USDT pair', F.gift, X, { quoteToken: USDT, dividendToken: USDT }, 0n],
  ['Gift Vault V2 launches', F.giftv2, X, {}, 0n],
  ['FlapXVault launches', F.giftx, X, {}, 0n],
  ['the split vault launches (70/30)', F.split, SPLIT([{ recipient: FROM, bps: 7000 }, { recipient: '0x000000000000000000000000000000000000dEaD', bps: 3000 }]), {}, 0n],
  ['the split vault takes any tax rate (10%)', F.split, SPLIT([{ recipient: FROM, bps: 10000 }]), { buyTaxRate: 1000, sellTaxRate: 1000 }, 0n],
  ['the RWA v2 stock-dividend vault launches', F.rwa2, '0x', { dividendToken: NVDAON }, 0n],
  ['the RWA v1 stock-dividend vault launches', F.rwa1, '0x', { dividendToken: NVDAON }, 0n],
];
for (const [label, ...args] of good) {
  const r = await sim(label, ...args);
  check(r.ok && r.token.toLowerCase() === r.mined?.toLowerCase(), label, r.ok ? `${r.token} (vanity 7777, matches the mined salt)` : r.why);
}

// --- and the mistakes it has to catch -------------------------------------------
const bad = [
  ['a bare-string X handle is rejected by the factory', F.gift, encodeAbiParameters([{ type: 'string' }], ['mythlake2016']), {}, 0n],
  ['a 10% tax is rejected by the gift vault (1/2/3% only)', F.gift, X, { buyTaxRate: 1000, sellTaxRate: 1000 }, 0n],
  ['a split that does not add up to 100% is rejected', F.split, SPLIT([{ recipient: FROM, bps: 9999 }]), {}, 0n],
  ['a vault with no market share is rejected', F.gift, X, { mktBps: 0, deflationBps: 10000 }, 0n],
  ['an unlisted dividend asset is rejected by the RWA vault', F.rwa2, '0x', { dividendToken: USDT }, 0n],
];
for (const [label, ...args] of bad) {
  const r = await sim(label, ...args);
  check(!r.ok, label, r.ok ? 'it was ACCEPTED, which it should not be' : r.why);
}

// --- the published rules the pad enforces --------------------------------------
const POLICY_ABI = [{ type: 'function', name: 'tokenCreationPolicies', stateMutability: 'view', inputs: [], outputs: [{ type: 'tuple[]', components: [{ name: 'field', type: 'string' }, { name: 'op', type: 'string' }, { name: 'values', type: 'bytes' }, { name: 'message', type: 'string' }] }] }];
{
  const rules = await c.readContract({ address: F.gift, abi: POLICY_ABI, functionName: 'tokenCreationPolicies' }).catch(() => null);
  const tax = rules?.find((r) => r.field === 'buyTaxRate');
  const taxes = tax ? decodeAbiParameters([{ type: 'uint256[]' }], tax.values)[0].map(Number) : [];
  check(tax?.op === 'in' && String(taxes) === '100,200,300', 'the gift vault publishes its 1/2/3% tax rule for the pad to read', String(taxes));
  const assets = await c.readContract({ address: F.rwa2, abi: [{ type: 'function', name: 'getSupportedAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] }], functionName: 'getSupportedAssets' }).catch(() => []);
  check(assets.length > 0 && assets.map((a) => a.toLowerCase()).includes(NVDAON.toLowerCase()), 'the RWA vault publishes its dividend-asset list for the dropdown', `${assets.length} assets`);
}
console.log('');
process.exit(fails.length ? 1 : 0);
