// Regression test for long.xyz launches.
//
// The reference is PDOOM / p(doom) 0x4c3A56523Ad6a77e5e3743DFAF16AFBb8b031e18,
// launched through long.xyz's own router. Its Airlock call carries the curve
// config asserted below, and this builds the same thing and compares it word
// for word.
//
// Two things this catches, both of which shipped broken once:
//   - the curve shape: two curves with ONE position each, not eleven
//   - the Rehype calldata layout: fifteen flat words, 480 bytes. The SDK's
//     encoder wraps them and appends an empty feeBeneficiaries array, making
//     the blob 1376 bytes instead of 1280 and shifting every later offset.
//
// Run: node test/js/long-curve-shape.test.mjs

import { launchLong } from '../../src/long.js';
const THEIRS = ['0000000000000000000000000000000000000000000000000000000000000020',
'00000000000000000000000000000000000000000000000000000000000007d0','0000000000000000000000000000000000000000000000000000000000000008',
'00000000000000000000000000000000000000000000000000000000000d89d8','0000000000000000000000000000000000000000000000000000000000000100',
'0000000000000000000000000000000000000000000000000000000000000220','0000000000000000000000006f02324d20cc679d0e585290caa6b16bacbc0f77',
'00000000000000000000000000000000000000000000000000000000000002c0','00000000000000000000000000000000000000000000000000000000000004c0',
'0000000000000000000000000000000000000000000000000000000000000002','fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe59c8',
'0000000000000000000000000000000000000000000000000000000000000928','0000000000000000000000000000000000000000000000000000000000000001',
'000000000000000000000000000000000000000000000000058d15e176280000','0000000000000000000000000000000000000000000000000000000000000928',
'00000000000000000000000000000000000000000000000000000000000d89e0','0000000000000000000000000000000000000000000000000000000000000001',
'0000000000000000000000000000000000000000000000000853a0d2313c0000'];
const LABELS=['header','fee','tickSpacing','farTick','curves off','benef off','dopplerHook','onInit off','grad off',
  'curve count','c1 lower','c1 upper','c1 positions','c1 shares','c2 lower','c2 upper','c2 positions','c2 shares'];

const r = await launchLong({
  privateKey: '0x' + '11'.repeat(32), name: 'p(doom)', symbol: 'PDOOM', tokenURI: 'ipfs://x',
  numeraire: '0x1937caD42b17D43bB2b347ce16d5288887C46c33',
  buybackDestination: '0x92d435C96E63c43E12d6D0AB28f6b0B04072F765',
  dryRun: true, onStatus: (m) => console.log('  ' + m),
});
console.log('\nwould launch', r.token);
const ours = r.poolInitializerData.slice(2);
let bad = 0;
for (let i = 0; i < THEIRS.length; i++) {
  const o = ours.slice(i*64, i*64+64);
  if (o !== THEIRS[i]) { bad++; console.log('  X  ' + LABELS[i] + '\n       ours   ' + o + '\n       theirs ' + THEIRS[i]); }
}
// and the rehype blob length, the thing that was wrong
const onInitOff = parseInt(ours.slice(7*64, 7*64+64), 16) * 2;
const len = parseInt(ours.slice(onInitOff, onInitOff+64), 16);
console.log('\nrehype calldata:', len, 'bytes (long.xyz sends 480)');
console.log(bad === 0 && len === 480
  ? '\nMATCH - byte-identical curve config to the live long.xyz launch'
  : '\n' + bad + ' field(s) still differ');

const bytes = ours.length / 2;
console.log('poolInitializerData size:', bytes, 'bytes   (long.xyz 1280, SDK encoder 1376)');
console.log(bad === 0 && bytes === 1280
  ? 'MATCH - byte-identical initializer data to the live long.xyz launch'
  : 'STILL OFF - ' + bad + ' fields differ, size ' + bytes);

process.exit(bad === 0 && bytes === 1280 ? 0 : 1);
