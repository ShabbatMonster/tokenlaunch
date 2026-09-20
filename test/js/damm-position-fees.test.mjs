// Regression test for post-migration (DAMM v2) fee claiming.
//
// After a Meteora curve graduates, its liquidity becomes a DAMM v2 position and
// the DBC partner/creator buckets go empty for good. Two traps this pins down:
//
//   - position NFTs are Token-2022, so a classic-token-only scan finds nothing
//   - Position.fee_a_pending / fee_b_pending are checkpoints, not balances. They
//     read zero on positions holding real fees, so the claimable amount is only
//     knowable by simulating the claim.
//
// Asserts against a live position known to hold fees.
//
// Run: node test/js/damm-position-fees.test.mjs

import { findDammPositions, previewDammClaim, POOL_AUTHORITY } from '../../src/dammFees.js';

const RPC = 'https://mainnet.helius-rpc.com/?api-key=3fb08d49-71d7-492b-84f1-9ff0e3eb95ea';
const OWNER = 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT';

let ok = true;
const check = (cond, label) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label); ok &&= cond; };

check(POOL_AUTHORITY.toBase58() === 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC',
  'pool authority PDA derives to the known cp-amm address');

const positions = await findDammPositions({ rpcUrl: RPC, owner: OWNER });
check(positions.length > 0, 'finds DAMM v2 positions via Token-2022 position NFTs (' + positions.length + ')');

let withFees = 0;
let checkpointsAllZero = true;
for (const p of positions) {
  const q = await previewDammClaim({ rpcUrl: RPC, owner: OWNER, position: p });
  if (q.error) { console.log('      ' + p.position.slice(0, 10) + '.. would fail: ' + q.error); continue; }
  const any = BigInt(q.claimableA || '0') > 0n || BigInt(q.claimableB || '0') > 0n;
  if (any) withFees++;
  if (p.feeAPendingCheckpoint !== '0' || p.feeBPendingCheckpoint !== '0') checkpointsAllZero = false;
}
check(withFees > 0, 'simulation finds claimable fees on ' + withFees + ' position(s)');
check(checkpointsAllZero, 'and the on-account pending fields read zero throughout, as expected');

process.exit(ok ? 0 : 1);
