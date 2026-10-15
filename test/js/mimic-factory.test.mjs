// Mimic: launch on whatever Robinhood factory another token came from.
//
// Paste a token; its launch call is found, the function recovered (a signature
// only counts if it re-encodes the calldata byte for byte), the arguments
// tagged by role, your values swapped in, and the result simulated. Pinned to
// two real launches:
//
//   WOLFPACK (Hooke)  - discovery from the token alone, every role, the USDG it
//                       paid, and its 0000 address: the CREATE2 recipe is
//                       inferred, a salt mined for a new coin, and the factory
//                       accepts that launch (and refuses an unmined one)
//   a live Pons v2    - rebuilt as a different coin from a different wallet,
//                       and the factory accepts it in simulation
//
// Run: node test/js/mimic-factory.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { decodeFunctionData, getAddress, keccak256, encodeAbiParameters, parseAbi, getContractAddress } from 'viem';
import { mimicPublicClient, findLaunchTx, loadTemplate, buildCalldata, approvalsFor, parseParam, inferVanityRecipe, mineForRecipe, vanitySuffix, create2Salt, noBuyEdits } from '../../src/mimic.js';
import { mineCpu, patternFrom, matches } from '../../src/vanity.js';

const pub = mimicPublicClient();
const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};
const ME = '0x2222222222222222222222222222222222225678';
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

// --- WOLFPACK: everything from the token address alone ------------------------------
const WOLFPACK = '0x5199ea953d71d6a5413be1b2efecd26aacab0000';
const hash = await findLaunchTx(pub, WOLFPACK);
check(hash === '0x9d6c38716b404c6967264fcaaa249f24d7ff60ebdb47030bec640b7341f5b6ba', 'the launch is found from the token address alone', hash);
const w = await loadTemplate(pub, hash, { token: WOLFPACK });
check(w.factory === getAddress('0x7e39dec0cfe5f63e80663ad96986987670cf68ec'), 'the factory is the contract that was called (Hooke)');
check(/^createMeme\(/.test(w.signature || ''), 'the function is recovered from a signature directory', w.signature);
check(w.name === 'wolfpack' && w.symbol === 'WOLFPACK', 'the reference name and ticker are read off the token');
const role = (r) => w.params.filter((p) => p.role === r).map((p) => p.path.join('.'));
check(role('name').join() === '1' && role('symbol').join() === '2' && role('uri').join() === '3', 'name, ticker and metadata URI are found by value');
check(role('you').join() === '4', "the launcher's own address is found, to become yours");
check(role('salt-prefix').join() === '0', 'a salt that starts with the launcher is found, to be re-prefixed with yours');
check(role('deadline').join() === '6.4', 'a timestamp near the launch inside the tuple is found as the deadline');
check(w.pulled.length === 1 && w.pulled[0].symbol === 'USDG' && w.pulled[0].amount === 50_000_000n, 'the 50 USDG the launch paid is detected');
check(role('pay-amount').join() === '6.1', 'and the argument carrying that amount is tied to it');
check(w.warnings.some((x) => /0000/.test(x)), 'the vanity-address limit is called out, since this token ends in 0000');

const data = buildCalldata(w, { name: 'Mimic Test', symbol: 'MIMIC', uri: 'ipfs://bafyNEW', you: ME, deadline: 1_900_000_000n }, { '6.1': '75000000' });
const args = decodeFunctionData({ abi: [w.item], data }).args;
check(args[1] === 'Mimic Test' && args[2] === 'MIMIC' && args[3] === 'ipfs://bafyNEW', 'rebuilt with your name, ticker and metadata');
check(getAddress(args[4]) === getAddress(ME) && args[0].slice(0, 42).toLowerCase() === ME.toLowerCase(), 'with your wallet as creator and as the salt prefix');
check(args[0].slice(42) === w.params[0].value.slice(42), 'keeping the rest of the original salt');
check(args[6].amountIn === 75_000_000n || args[6][1] === 75_000_000n, 'an edited field is applied');
const ap = approvalsFor(w, { '6.1': '75000000' });
check(ap.length === 1 && ap[0].amount === 75_000_000n && ap[0].spender === w.factory, 'and the USDG approval follows the edited amount, to the factory');

// --- WOLFPACK's vanity address: infer the recipe, mine, launch -------------------------
check(vanitySuffix(WOLFPACK) === '0000' && vanitySuffix('0x5199ea953d71d6a5413be1b2efecd26aacab7777') === '7777' && vanitySuffix('0x5199ea953d71d6a5413be1b2efecd26aacab1234') === null,
  'vanity endings are recognised (and a plain address is not one)');
const { recipe, reason } = await inferVanityRecipe(pub, w);
check(!!recipe, 'the CREATE2 recipe is worked out from the reference token alone', reason || '');
if (recipe) {
  check(recipe.deployer === getAddress('0xe0cbefb318a7cdbce6330dc7fab6fadc679cd6d1'), 'the deployer is the contract behind the factory, not the one called');
  check(recipe.hash.kind === 'view' && recipe.hash.item.name === 'initCodeHash' && recipe.hash.args.map((a) => a.k).join() === 'name,symbol,factory',
    'the init code hash comes from initCodeHash(name, symbol, minter), re-asked with your values', recipe.hash.args?.map((a) => a.k).join());
  check(recipe.salt.path === '0' && recipe.salt.prefixed && recipe.salt.transform.kind === 'raw', 'the salt is argument 0, used raw, prefixed with the launcher');
  const v = { name: 'Mimic Test', symbol: 'MIMIC', uri: 'ipfs://bafyNEW', you: ME, deadline: deadline() };
  const m = await mineForRecipe(pub, recipe, { ...v, factory: w.factory });
  check(m.address.toLowerCase().endsWith('0000') && m.salt.toLowerCase().startsWith(ME.toLowerCase()), 'a salt is mined: the address ends in 0000 and the salt starts with your wallet', `${m.address} in ${m.tries} tries`);
  const HOOKE_VIEW = parseAbi(['function computeAddress(bytes32 salt, string name, string symbol, address minter) view returns (address)']);
  const onChain = await pub.readContract({ address: recipe.deployer, abi: HOOKE_VIEW, functionName: 'computeAddress', args: [m.salt, v.name, v.symbol, w.factory] });
  check(getAddress(onChain) === m.address, "the factory's own computeAddress agrees with the mined address", onChain);
  // USDG keeps balances at slot 1 and allowances at slot 3
  const slot = (a, s) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a, BigInt(s)]));
  const allowSlot = (o, sp, s) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [sp, slot(o, s)]));
  const BIG = '0x' + 'f'.repeat(30).padStart(64, '0');
  const ov = [{ address: ME, balance: 10n ** 20n }, { address: w.pulled[0].token, stateDiff: [{ slot: slot(ME, 1), value: BIG }, { slot: allowSlot(ME, w.factory, 3), value: BIG }] }];
  const sim = (edits) => pub.call({ account: ME, to: w.factory, data: buildCalldata(w, v, edits), value: w.value, stateOverride: ov }).then((r) => r.data, () => null);
  const ok = await sim({ [recipe.salt.path]: m.value });
  check(!!ok && getAddress('0x' + ok.slice(26, 66)) === m.address, 'Hooke accepts the mined launch from a different wallet and creates exactly the mined address', ok ? '0x' + ok.slice(26, 66) : 'reverted');
  check(await sim({}) === null, 'and refuses the same launch with an unmined salt - the mining is what makes it work');

  // no dev buy: the buy struct goes out as zeros, nothing is approved, and a
  // wallet holding only ETH can launch
  const nb = noBuyEdits(w);
  check(Object.keys(nb).sort().join() === '6.0,6.1,6.2,6.3', 'no dev buy zeroes the whole buy struct (mode, amount, minimums) but keeps the deadline', Object.keys(nb).join());
  check(approvalsFor(w, nb).length === 0, 'and leaves nothing to approve');
  const free = await pub.call({ account: ME, to: w.factory, data: buildCalldata(w, v, { ...nb, [recipe.salt.path]: m.value }), value: w.value, stateOverride: [{ address: ME, balance: 10n ** 16n }] }).then((r) => r.data, () => null);
  check(!!free && getAddress('0x' + free.slice(26, 66)) === m.address, 'Hooke accepts a no-dev-buy launch from a wallet holding only ETH', free ? '0x' + free.slice(26, 66) : 'reverted');
}

// the coin this was reported on: launched with a 68 hXMAX dev buy, mimicked with none
{
  const REF = '0xe6b34c84ea48d930717eeaf3248f0c9c6bd50000';
  const h68 = await findLaunchTx(pub, REF);
  const t68 = await loadTemplate(pub, h68, { token: REF });
  check(t68.pulled.length === 1 && t68.pulled[0].symbol === 'hXMAX' && t68.pulled[0].amount === 68n * 10n ** 18n, 'a coin launched with a 68 hXMAX dev buy is loaded', `${t68.pulled.map((x) => x.symbol).join()}`);
  check(approvalsFor(t68, noBuyEdits(t68)).length === 0, 'and mimicking it with no dev buy asks for no hXMAX');
  const r68 = (await inferVanityRecipe(pub, t68)).recipe;
  if (r68) {
    const v68 = { name: 'No Buy', symbol: 'NOBUY', uri: 'ipfs://bafyNEW', you: ME, deadline: deadline() };
    const m68 = await mineForRecipe(pub, r68, { ...v68, factory: t68.factory });
    const out = await pub.call({ account: ME, to: t68.factory, data: buildCalldata(t68, v68, { ...noBuyEdits(t68), [r68.salt.path]: m68.value }), value: t68.value, stateOverride: [{ address: ME, balance: 10n ** 16n }] }).then((r) => r.data, (e) => 'ERR ' + (e.shortMessage || e.message));
    check(!out.startsWith('ERR') && getAddress('0x' + out.slice(26, 66)) === m68.address, 'and that launch simulates clean from an ETH-only wallet', out.slice(0, 80));
  } else check(false, 'the recipe is found for the 68 hXMAX coin too');
}

// salts hashed with the sender first are mined on the CPU through the same transform
{
  const env = { from: ME, factory: w.factory };
  const tr = { kind: 'encode', who: 'from' };
  const hash = '0x' + '11'.repeat(32), dep = '0x' + '33'.repeat(20);
  const r = await mineCpu({ deployer: dep, initCodeHash: hash, pattern: patternFrom({ suffix: '777' }), saltFn: (s) => create2Salt(s, tr, env) });
  const addr = getContractAddress({ opcode: 'CREATE2', from: dep, salt: create2Salt(r.salt, tr, env), bytecodeHash: hash });
  check(addr === r.address && matches(addr, patternFrom({ suffix: '777' })), 'a factory that hashes the salt with the sender is mined through that hash', addr);
}

// --- a live Pons v2 launch, rebuilt and simulated -------------------------------------
const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const head = await pub.getBlockNumber();
let logs = [];
for (let back = 50_000n; back <= 5_000_000n && !logs.length; back *= 4n) {
  logs = await pub.request({ method: 'eth_getLogs', params: [{ address: PONS, fromBlock: '0x' + (head - back).toString(16), toBlock: 'latest' }] }).catch(() => []);
}
let p = null;
for (const h of [...new Set(logs.map((l) => l.transactionHash))].reverse().slice(0, 15)) {
  const t = await loadTemplate(pub, h).catch(() => null);
  if (t && t.factory === getAddress(PONS) && t.item && t.token) { p = t; break; }
}
check(!!p, 'a recent Pons v2 launch is found and decoded', p ? `${p.name} / ${p.symbol}` : 'none');
if (p) {
  const strings = p.params.filter((x) => x.type === 'string' && x.value);
  const leaked = strings.filter((x) => !x.role);
  check(leaked.length === 0, "none of the original's text rides along untagged - name, ticker, URI, description and socials are all replaced",
    leaked.map((x) => `${x.path.join('.')}=${JSON.stringify(x.value).slice(0, 40)}`).join(', ') || `${strings.length} strings tagged`);
  const pd = buildCalldata(p, { name: 'Mimic Pons', symbol: 'MPONS', uri: 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', you: ME, deadline: deadline(), description: 'mimicked', twitter: '', website: '' });
  const decoded = decodeFunctionData({ abi: [p.item], data: pd }).args;
  const flat = JSON.stringify(decoded, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  check(!flat.includes(p.name) || p.name === 'Mimic Pons', "the original's name is nowhere in the rebuilt call");
  check(!/x\.com\/|twitter\.com\//.test(flat), "and neither is the original's X link");
  try {
    const out = await pub.call({ account: ME, to: p.factory, data: pd, value: p.value, stateOverride: [{ address: ME, balance: 10n ** 20n }] });
    // the first return word is the new token; Pons returns more after it
    check(/^0x0{24}(?!0{40})[0-9a-f]{40}/i.test(out.data || ''), 'Pons v2 accepts the rebuilt launch from a different wallet, returning the new token', (out.data || '').slice(0, 66));
  } catch (e) {
    check(false, 'Pons v2 accepts the rebuilt launch from a different wallet', (e.shortMessage || e.message).slice(0, 120));
  }
}

// --- parsing edits ------------------------------------------------------------------------
check(parseParam('uint256', ' 42 ') === 42n && parseParam('bool', 'true') === true && parseParam('address', ME.toLowerCase()) === getAddress(ME),
  'edited fields are parsed back into their ABI types');
let threw = false; try { parseParam('address', 'nope'); } catch { threw = true; }
check(threw, 'and a malformed address is refused, not sent');

// --- the pad --------------------------------------------------------------------------------
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'index.html'), 'utf8');
check(/id: 'mimic-robinhood'[^}]*family: 'mimic'/.test(MAIN), 'the app lists a Mimic · Any Factory pad');
check(/if \(pad\.family === 'mimic'\) \{\s*await launchMimic/.test(MAIN), 'launching on it goes through launchMimic');
check(['mimicToken', 'mimicTx', 'mimicLoad', 'mimicFactory', 'mimicValue', 'mimicParams', 'mimicSim'].every((id) => HTML.includes(`id="${id}"`)),
  'with a token field, an optional tx field, LOAD, an editable factory and value, the parameter editor and SIMULATE');
check(['mimicVanity', 'mimicSuffix', 'mimicMine', 'mimicMineOn', 'mimicVanityInfo'].every((id) => HTML.includes(`id="${id}"`)),
  'a vanity block: the ending to mine for, MINE, an on/off switch and progress');
const prep = MAIN.slice(MAIN.indexOf('async function mimicPrepare'), MAIN.indexOf('async function simulateMimic'));
check(HTML.includes('id="mimicDevBuy"') && !/id="mimicDevBuy"[^>]*checked/.test(HTML) && /const noBuy = t\.pulled\.length > 0 && !\$\('mimicDevBuy'\)\.checked/.test(prep),
  'the dev buy is off unless ticked, and off means the no-buy edits are applied');
check(prep.indexOf('mimicMine(') > -1 && prep.indexOf('mimicMine(') < prep.indexOf('buildCalldata') && prep.indexOf('uploadJsonToIpfs') < prep.indexOf('mimicMine('),
  'the salt is mined after the metadata is pinned (it can feed the init code hash) and before the call is built');
const launchFn = MAIN.slice(MAIN.indexOf('async function launchMimic'), MAIN.indexOf('async function updateHookeUI'));
check(launchFn.indexOf('simulateLaunch') > -1 && launchFn.indexOf('simulateLaunch') < launchFn.indexOf('sendTransaction'), 'a launch is simulated before it is sent');
check(launchFn.indexOf('approve') > -1 && launchFn.indexOf('approve') < launchFn.indexOf('sendTransaction'), 'and whatever the original paid in is approved first');

console.log('');
process.exit(fails.length ? 1 : 0);
