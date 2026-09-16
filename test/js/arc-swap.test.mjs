// Regression test for swapping on Arc's V3 DEX.
//
// Both halves are checked against a real trade rather than against themselves:
// an 804.093593 USDC buy of ARCADE (0x832a5e1a...) that received exactly
// 19212047.93637205573986821 ARCADE.
//
//   1. quoteInRange, fed the pool as it stood the block before, must predict
//      that output to the wei.
//   2. our exactInputSingle encoding, simulated as that trader at that block,
//      must return the same number - which proves the flat-argument router
//      call, not just the maths.
//
// Uses an archive-capable endpoint; the swap module itself never needs one.
//
// Run: node test/js/arc-swap.test.mjs

import { getAddress, encodeFunctionData, decodeFunctionResult } from 'viem';
import { findArcPools, quoteInRange, ARC_V3_ROUTER } from '../../src/arcswap.js';
import { ARC_USDC } from '../../src/argus.js';

const ARCHIVE = 'https://5042.rpc.thirdweb.com';
const HASH = '0x832a5e1a657dc7cafb93815f302fa062341c242e097b6c8b38d7b516dbbca835';
const ACTUAL = 19212047936372055739868210n;
const ABI = [{ type: 'function', name: 'exactInputSingle', stateMutability: 'nonpayable',
  inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
  outputs: [{ type: 'uint256' }] }];
const rpc = async (m, p) => {
  const r = await fetch(ARCHIVE, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) });
  const j = await r.json();
  if (j.error) throw new Error(m + ': ' + j.error.message);
  return j.result;
};

const tx = await rpc('eth_getTransactionByHash', [HASH]);
const w = tx.input.slice(10).match(/.{64}/g);
const trader = getAddress(tx.from);
const token = getAddress('0x' + w[1].slice(24));
const amountIn = BigInt('0x' + w[4]);
const before = BigInt(tx.blockNumber) - 1n;

let ok = true;

const [pool] = await findArcPools(token, { blockNumber: before });
const quoted = quoteInRange({ ...pool, zeroForOne: getAddress(ARC_USDC) === pool.token0, amountIn });
const quoteOk = quoted === ACTUAL;
console.log((quoteOk ? 'PASS' : 'FAIL') + '  pool quote   ' + quoted + (quoteOk ? '' : '  expected ' + ACTUAL));
ok &&= quoteOk;

const data = encodeFunctionData({ abi: ABI, functionName: 'exactInputSingle',
  args: [getAddress(ARC_USDC), token, pool.fee, trader, amountIn, 0n, BigInt('0x' + w[6])] });
const sim = decodeFunctionResult({ abi: ABI, functionName: 'exactInputSingle',
  data: await rpc('eth_call', [{ from: trader, to: ARC_V3_ROUTER, data }, '0x' + before.toString(16)]) });
const simOk = sim === ACTUAL;
console.log((simOk ? 'PASS' : 'FAIL') + '  router call  ' + sim + (simOk ? '' : '  expected ' + ACTUAL));
ok &&= simOk;

process.exit(ok ? 0 : 1);
