// Regression test for UsePaid coins on Pons.
//
// A "paid" coin is a Pons v2 launch through UsePaid's router carrying the line
// "Fees to @handle via UsePaid" in its description. The reference is VLAD,
// 0x2aa5bcAB85d4a04d2379b2Cd11Cd47108F7f7d07, launched in tx 0x408acb61...
//
// Two things are checked, both against the chain rather than against ourselves:
//   1. rebuilding that launch from our encoder gives byte-identical calldata
//   2. a launch that is entirely ours - our name, salt and fee recipient -
//      still simulates against the live router, which is what proves UsePaid
//      signs nothing
//
// Run: node test/js/usepaid-launch.test.mjs

import { createPublicClient, http, defineChain, getAddress } from 'viem';
import { encodePaidLaunch, USEPAID_ROUTER } from '../../src/usepaid.js';
const RPC='https://rpc.mainnet.chain.robinhood.com';
const CHAIN=defineChain({id:4663,name:'Robinhood',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[RPC]}}});
const pub=createPublicClient({chain:CHAIN,transport:http(RPC,{retryCount:8,retryDelay:800})});
const tx = await pub.getTransaction({ hash: '0x408acb61ad4fc815c30c2f1a478df5f0040c0552d75c4a48701e36bf39c42146' });
const w = tx.input.slice(10).match(/.{64}/g);

const ours = encodePaidLaunch({
  name: 'Vlad', symbol: 'VLAD',
  logo: 'https://usepaid.app/api/launch/image/83f1e55f-9192-4213-8bb7-dd02a9b6b347',
  handle: 'vladtenev',
  website: 'https://usepaid.app/t/jbrqs44z',
  creator: getAddress(tx.from),
  creatorFeeRecipient: '0xFEE40ADD9a2F8e2af8812e4ADE7CE8D789971e54',
  creatorTaxBps: 100, buybackEnabled: false,
  economics: '0x' + w[15], salt: '0x' + w[16],
  devBuyWei: BigInt('0x' + w[3]),
}).data;

console.log('real bytes', (tx.input.length - 2) / 2, '| ours', (ours.length - 2) / 2);
const identical = ours.toLowerCase() === tx.input.toLowerCase();
console.log((identical ? 'PASS' : 'FAIL') + '  replay of the VLAD launch is byte-identical');

// and a launch that is entirely ours still goes through the live router
const { paidLaunchTerms } = await import('../../src/usepaid.js');
const terms = await paidLaunchTerms();
const fresh = encodePaidLaunch({
  name: 'Paid Probe', symbol: 'PPROBE', logo: 'https://example.com/i.png',
  handle: 'someone', creator: getAddress(tx.from),
  creatorFeeRecipient: getAddress(tx.from), creatorTaxBps: 100,
  economics: terms.economics, devBuyWei: 10n ** 16n,
}).data;
let freshOk = false;
try {
  await pub.call({ to: USEPAID_ROUTER, data: fresh, value: terms.launchFee + 10n ** 16n, account: getAddress(tx.from) });
  freshOk = true;
} catch (e) { console.log('   fresh launch reverted: ' + String(e.shortMessage || e.message).slice(0, 110)); }
console.log((freshOk ? 'PASS' : 'FAIL') + '  a launch with our own name, salt and recipient simulates');
process.exit(identical && freshOk ? 0 : 1);
