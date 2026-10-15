// Mimic: launch on whatever Robinhood factory another token came from.
//
// Paste a token; its launch call is found, the function recovered (a signature
// only counts if it re-encodes the calldata byte for byte), the arguments
// tagged by role, your values swapped in, and the result simulated. Pinned to
// two real launches:
//
//   WOLFPACK (Hooke)  - discovery from the token alone, every role, the USDG it
//                       paid, the vanity-address warning
//   a live Pons v2    - rebuilt as a different coin from a different wallet,
//                       and the factory accepts it in simulation
//
// Run: node test/js/mimic-factory.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { decodeFunctionData, getAddress } from 'viem';
import { mimicPublicClient, findLaunchTx, loadTemplate, buildCalldata, approvalsFor, parseParam } from '../../src/mimic.js';

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
const launchFn = MAIN.slice(MAIN.indexOf('async function launchMimic'), MAIN.indexOf('async function updateHookeUI'));
check(launchFn.indexOf('simulateLaunch') > -1 && launchFn.indexOf('simulateLaunch') < launchFn.indexOf('sendTransaction'), 'a launch is simulated before it is sent');
check(launchFn.indexOf('approve') > -1 && launchFn.indexOf('approve') < launchFn.indexOf('sendTransaction'), 'and whatever the original paid in is approved first');

console.log('');
process.exit(fails.length ? 1 : 0);
