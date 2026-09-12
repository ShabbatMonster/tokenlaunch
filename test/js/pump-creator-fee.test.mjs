// Regression test for the pump.fun creator fee, the field that decides what a
// holder-rewards coin actually pays out.
//
// create_v2's last three arguments are trailing optionals whose Option types are
// bare payloads, not Rust Options:
//
//   is_cashback_enabled  OptionBool  1 byte
//   creator_fee_bps      OptionU64   8 bytes
//   is_holder_reward     OptionBool  1 byte
//
// The reference is HODL / AmPojoiSMGzwMMmrXFzovcnUA8UuwSTBf1myCBbhR4Mf, a live
// 3% holder-rewards coin. Its real create_v2 ends in 0,44,1,0,0,0,0,0,0,1 -
// cashback off, 300 bps little-endian, holder rewards on - and this asserts we
// still build exactly that.
//
// Run: node test/js/pump-creator-fee.test.mjs

import { pumpWarmup, buildPumpLaunch, PUMP_PROGRAM } from '../../src/pump.js';
import { Connection, Keypair } from '@solana/web3.js';
const RPC = 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');
const DISC = Buffer.from('d6904cec5f8b31b4', 'hex');

const warm = await pumpWarmup({ rpcUrl: RPC });
const payer = Keypair.generate();
const mint = Keypair.generate();
const tx = await buildPumpLaunch({
  connection: conn, payer, mint,
  name: 'HODL', symbol: 'HODL', uri: 'https://x/m.json',
  devBuySol: 0, slippageBps: 1000,
  global: warm.global, quote: warm.quote, lookupTable: warm.lookupTable,
  cashback: false, feesToHolders: true, creatorFeeBps: 300,
});

const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: warm.lookupTable?.value ? [warm.lookupTable.value] : [] });
let data = null;
for (const ix of tx.message.compiledInstructions) {
  const pid = keys.get(ix.programIdIndex);
  const d = Buffer.from(ix.data);
  if (pid?.equals(PUMP_PROGRAM) && d.subarray(0, 8).equals(DISC)) { data = d; break; }
}
if (!data) { console.log('could not find create_v2 in the tx we built'); process.exit(1); }

const tail = [...data.subarray(data.length - 10)];
const expected = [0, 44, 1, 0, 0, 0, 0, 0, 0, 1];   // cashback=false, 300 LE u64, holder=true
console.log('trailing 10 bytes we build :', tail.join(','));
console.log('trailing 10 bytes on-chain :', expected.join(','), '(from HODL, the 3% coin)');
console.log(JSON.stringify(tail) === JSON.stringify(expected)
  ? '\nMATCH - our create_v2 args are byte-identical to the live 3% coin'
  : '\nMISMATCH');
