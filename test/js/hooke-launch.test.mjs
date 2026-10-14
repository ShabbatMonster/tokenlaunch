// Launching on the Hooke factory - the one WOLFPACK (0x5199...0000) came from.
//
// There is no site, no ABI and no verified source; three launches have ever gone
// through this hook, all WOLFPACK. So every claim below is checked against
// either WOLFPACK's own launch transaction or a simulation of the live contract,
// and nothing is signed or sent: balances and approvals are supplied by state
// override.
//
// Run: node test/js/hooke-launch.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { decodeFunctionData, keccak256, encodeAbiParameters, pad, toHex, getAddress, encodeFunctionData } from 'viem';
import {
  HOOKE, HOOKE_ABI, HOOKE_FACTORY_ABI, HOOKE_PAY, hookePublicClient, hookeStatus, mineHookeSalt,
  prepareHookeSalt, hookeCreateArgs, buildEthToUsdg, hookeLaunchInfo, hookeCoinsOf,
} from '../../src/hooke.js';

const pub = hookePublicClient();
const WOLFPACK = getAddress('0x5199ea953d71d6a5413be1b2efecd26aacab0000');
const ME = getAddress('0x1111111111111111111111111111111111111234');
const META = 'ipfs://bafybeidzgn7u2ppldy4yp4lyxch7cnd7kzvp2iiq3zswfjpsw3o4gbjpx4';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

// --- the live config is the one decoded -------------------------------------------
const st = await hookeStatus(pub);
check(st.ok, 'the hook still pairs with hXMAX, settles in USDG and deploys through the same factory', st.problems.join('; '));
check(st.launchFee === 250000000000000n, 'launch fee is 0.00025 ETH', String(st.launchFee));
check(st.vanitySuffix === '0000', "the factory's VANITY_SUFFIX_MASK means addresses end 0000", st.vanitySuffix);
check(st.maxMetadataBytes === 128, 'metadata is capped at 128 bytes', String(st.maxMetadataBytes));

// --- WOLFPACK's launch, read back through this module's ABI ------------------------
const tx = await pub.getTransaction({ hash: HOOKE.referenceTx });
const { args } = decodeFunctionData({ abi: HOOKE_ABI, data: tx.input });
const [salt, name, symbol, metadata, creator, flag, buy] = args;
check(getAddress(tx.to) === HOOKE.hook, 'WOLFPACK was launched by calling the hook directly');
check(tx.value === st.launchFee, 'with exactly the launch fee as value, nothing more');
check(salt.slice(0, 42).toLowerCase() === tx.from.toLowerCase(), "its salt starts with the creator's own address");
check(getAddress(creator) === getAddress(tx.from), 'creator fees go to the launching wallet');
check(flag === true, 'the flag is true');
check(buy.mode === HOOKE_PAY.USDG.mode && buy.amountIn === 50_000_000n, 'the dev buy is mode 2: 50 USDG', `mode ${buy.mode}, ${buy.amountIn}`);
check(buy.minIntermediateOut === 0n, 'with no intermediate minimum, as this module sends');
const rebuilt = hookeCreateArgs({ salt, name, symbol, metadata, creator, mode: buy.mode, amountIn: buy.amountIn, minTokensOut: buy.minTokensOut, deadline: buy.deadline });
check(encodeFunctionData({ abi: HOOKE_ABI, functionName: 'createMeme', args: rebuilt }) === tx.input,
  "hookeCreateArgs rebuilds WOLFPACK's calldata byte for byte");
const wolfAddr = await pub.readContract({ address: HOOKE.factory, abi: HOOKE_FACTORY_ABI, functionName: 'computeAddress', args: [salt, name, symbol, HOOKE.hook] });
check(getAddress(wolfAddr) === WOLFPACK, "and the factory places that salt at WOLFPACK's address", wolfAddr);

// --- mining ------------------------------------------------------------------------
const ich = await pub.readContract({ address: HOOKE.factory, abi: HOOKE_FACTORY_ABI, functionName: 'initCodeHash', args: [name, symbol, HOOKE.hook] });
const local = mineHookeSalt({ creator: tx.from, initCodeHash: ich, start: BigInt('0x' + salt.slice(42)) });
check(getAddress(local.token) === WOLFPACK && local.tries === 1, "the local CREATE2 derivation lands on WOLFPACK from WOLFPACK's salt");
const t0 = Date.now();
const mined = await prepareHookeSalt(pub, { creator: ME, name: 'Hooke Test', symbol: 'HKT', status: st });
check(mined.token.toLowerCase().endsWith('0000'), 'a freshly mined address ends in 0000', `${mined.token} in ${mined.tries} tries, ${Date.now() - t0}ms`);
check(mined.salt.slice(0, 42).toLowerCase() === ME.toLowerCase(), "and its salt carries the launcher's address");
const again = await prepareHookeSalt(pub, { creator: ME, name: 'Hooke Test', symbol: 'HKT', status: st });
check(again.token !== mined.token, 'two launches of the same name mine different addresses (WOLFPACK was launched three times)');

// --- simulate the launch, both ways of paying -----------------------------------------
const slot = (a, s) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a, BigInt(s)]));
const allowSlot = (owner, spender, s) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, slot(owner, s)]));
const BIG = pad(toHex(10n ** 24n));
const funded = (tokenAddr, balBase, allowBase) => [
  { address: ME, balance: 10n ** 20n },
  { address: tokenAddr, stateDiff: [{ slot: slot(ME, balBase), value: BIG }, { slot: allowSlot(ME, HOOKE.hook, allowBase), value: BIG }] },
];
const simulate = (mode, amountIn, overrides, value = st.launchFee) => pub.simulateContract({
  address: HOOKE.hook, abi: HOOKE_ABI, functionName: 'createMeme', account: ME, value, stateOverride: overrides,
  args: hookeCreateArgs({ salt: mined.salt, name: 'Hooke Test', symbol: 'HKT', metadata: META, creator: ME, mode, amountIn, minTokensOut: 1n, deadline: deadline() }),
});
// hXMAX is a plain OZ ERC20 (balances slot 0, allowances slot 1); USDG keeps them at 1 and 3
const hx = await simulate(HOOKE_PAY.HXMAX.mode, 10n ** 18n, funded(HOOKE.hxmax, 0, 1));
check(getAddress(hx.result[0]) === getAddress(mined.token), 'paying in hXMAX launches at the mined address', `${hx.result[1]} tokens out`);
const us = await simulate(HOOKE_PAY.USDG.mode, 50_000_000n, funded(HOOKE.usdg, 1, 3));
check(getAddress(us.result[0]) === getAddress(mined.token), 'paying 50 USDG - the WOLFPACK way - launches at the mined address');
const usOut = Number(us.result[1]) / 1e18;
check(usOut > 5e6 && usOut < 3e7, 'and buys a WOLFPACK-sized bag (WOLFPACK got ~11.4M for 50 USDG)', `${Math.round(usOut).toLocaleString()} tokens`);

// --- the refusals this module guards against -------------------------------------------
const reverts = async (p) => { try { await p; return ''; } catch (e) { return String(e?.message || e); } };
const noBuy = await reverts(simulate(0, 0n, funded(HOOKE.usdg, 1, 3)));
check(/InvalidInitialBuy|0x4fb6a7b3/.test(noBuy), 'a launch with no dev buy is refused (InvalidInitialBuy)', noBuy.slice(0, 60));
const extra = await reverts(simulate(HOOKE_PAY.USDG.mode, 50_000_000n, funded(HOOKE.usdg, 1, 3), st.launchFee + 10n ** 16n));
check(/InvalidLaunchFee|0x26e49117/.test(extra), 'and so is sending ETH beyond the fee - ETH is not a payment mode', extra.slice(0, 60));
const unapproved = await reverts(simulate(HOOKE_PAY.USDG.mode, 50_000_000n, [{ address: ME, balance: 10n ** 20n }]));
check(unapproved.length > 0, 'and an unapproved USDG buy, which is why the approval comes first');

// --- funding from ETH -----------------------------------------------------------------
const sw = await buildEthToUsdg(pub, { recipient: ME, usdgOut: 50_000_000n, deadline: deadline() });
const swapOk = await pub.call({ account: ME, to: sw.to, data: sw.data, value: sw.value, stateOverride: [{ address: ME, balance: 10n ** 20n }] }).then(() => true, () => false);
check(swapOk, 'ETH -> at least 50 USDG through the Universal Router simulates', `${Number(sw.value) / 1e18} ETH at ${sw.price.toFixed(0)} USDG/ETH`);
check(sw.data.startsWith('0x3593564c'), "using the router's execute(), the call WOLFPACK's own buyers make");

// --- creator fees ------------------------------------------------------------------------
const CREATOR = getAddress(tx.from);
const info = await hookeLaunchInfo(pub, WOLFPACK);
check(!!info && info.launcher === CREATOR && info.feeRecipient === CREATOR, "WOLFPACK's record names its creator as launcher and fee recipient");
check(info.unclaimed > 0n, 'and holds unclaimed creator fees in hXMAX', `${Number(info.unclaimed) / 1e18} hXMAX`);
const claimSim = await pub.simulateContract({ address: HOOKE.hook, abi: HOOKE_ABI, functionName: 'claimCreatorFees', args: [WOLFPACK], account: CREATOR });
const drift = claimSim.result > info.unclaimed ? claimSim.result - info.unclaimed : info.unclaimed - claimSim.result;
check(drift * 100n <= info.unclaimed, 'which is what a claim pays (within live trading drift)', `claim ${Number(claimSim.result) / 1e18}`);
check((await hookeLaunchInfo(pub, HOOKE.usdg)) === null, 'a coin that is not from Hooke reads as null');
const mine = await hookeCoinsOf(pub, CREATOR);
// 0x7D0F launched two WOLFPACKs; a third WOLFPACK (0x54a089...) is a different
// wallet's, and must not be listed as this one's
check(mine.some((c) => c.token === WOLFPACK) && mine.length >= 2, "the fee panel finds the creator's coins", `${mine.length} coins`);
check(!mine.some((c) => c.token === getAddress('0x54a089f37db7b66a0ecd6661863f758371210000')), "but not the WOLFPACK another wallet launched");
check(mine.every((c) => c.launcher === CREATOR || c.feeRecipient === CREATOR), 'every coin listed was launched by, or pays, this wallet');
check(mine.find((c) => c.token === WOLFPACK)?.symbol === 'WOLFPACK', 'symbols come straight from the launch event');
check((await hookeCoinsOf(pub, ME)).length === 0, 'and nothing for a wallet that launched nothing');
const MAIN_SRC = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
check(/if \(activePad\.family === 'hooke'\) return renderHookeClaims/.test(MAIN_SRC), 'MY TOKENS · CLAIM FEES lists Hooke coins with their unclaimed hXMAX');
check(/if \(activePad\.family === 'hooke'\) \{ await claimAllHooke/.test(MAIN_SRC), 'and CLAIM ALL claims every coin that has fees');

// --- the pad -------------------------------------------------------------------------
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'index.html'), 'utf8');
check(/id: 'hooke-robinhood'[^}]*family: 'hooke'/.test(MAIN), 'the app lists a Hooke pad');
check(/if \(pad\.family === 'hooke'\) \{\s*await launchHooke/.test(MAIN), 'and launching on it goes through launchHooke');
check(/id="hookeRow"/.test(HTML) && /value="ETH"/.test(HTML) && /value="USDG"/.test(HTML) && /value="HXMAX"/.test(HTML),
  'with ETH, USDG and hXMAX as ways to pay the dev buy');
check(/id="hookeBuy" value="50"/.test(HTML), 'defaulting to the 50 WOLFPACK used');
check(/hookeStatus\(pub\)[\s\S]{0,200}if \(!st\.ok\)/.test(MAIN), 'and it refuses to launch if the contracts moved');
check(/getAddress\(result\[0\]\) !== getAddress\(predicted\)/.test(MAIN), 'or if the simulation would create anything but the mined address');

console.log('');
process.exit(fails.length ? 1 : 0);
