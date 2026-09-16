// Regression test for the Argus (argus.world) launch encoding on Arc.
//
// Argus publishes no ABI and its factory is unverified, so the argument layout
// was reconstructed from real launches. The reference is RAMBO / "Rambo Cat"
// 0x60f4D66B464bFCE01Ffa6B8145A1116Dc537de65, the launch you pointed at.
//
// This rebuilds that exact call from our own encoder, reusing only its salt and
// nonce, and asserts the calldata comes out byte for byte identical. If Argus
// changes its struct, this is what notices.
//
// Run: node test/js/argus-launch-encoding.test.mjs

import { createPublicClient, http, defineChain } from 'viem';
import { encodeArgusLaunch } from '../../src/argus.js';
const RPC='https://arc.drpc.org';
const ARC=defineChain({id:5042,name:'Arc',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:[RPC]}}});
const pub=createPublicClient({chain:ARC,transport:http(RPC,{retryCount:5,retryDelay:600})});

const blk = await pub.getBlock({ blockNumber: 21065630n, includeTransactions: true });
const real = blk.transactions.find((t) => t.input.startsWith('0x11b8f0f1')).input;

// rebuild RAMBO exactly, reusing its salt/nonce so only our encoding is tested
const w = real.slice(10).match(/.{64}/g);
const ours = encodeArgusLaunch({
  name: 'Rambo Cat', symbol: 'RAMBO',
  uri: 'ipfs://bafybeihtygw5rckhgibfcywrbmbpuilmv2kiruruqyghvps6v3wmhh3a74',
  description: '', creatorHandle: '0xrachelita', telegram: '', twitter: 'https://x.com/0xrachelita',
  feeBps: 100, feeMode: 'holders', devBuyUsdc: 460,
  salt: '0x' + w[2], nonce: '0x' + w[3],
}).data;

console.log('real  bytes:', (real.length - 2) / 2);
console.log('ours  bytes:', (ours.length - 2) / 2);
if (ours === real) { console.log('\nIDENTICAL - our encoder reproduces the live launch exactly'); process.exit(0); }
const a = real.slice(10).match(/.{64}/g), b = ours.slice(10).match(/.{64}/g);
console.log('\nword-by-word differences:');
let bad = 0;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) { bad++; console.log('  w' + String(i).padStart(2) + '\n    real ' + (a[i] ?? '(missing)') + '\n    ours ' + (b[i] ?? '(missing)')); }
}
console.log(bad + ' word(s) differ of ' + a.length);

process.exit(1);
