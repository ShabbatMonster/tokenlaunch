// Bordrless timed-sell: the core module, checked against the live coin the tool
// was built for. Live data, so it SKIPS cleanly if the coin is gone or the RPC
// is unset. Set RPC=<solana rpc url> to run (CI without one just skips).
//
//   node test/js/bordr-sell.test.mjs
import { Connection, PublicKey } from '@solana/web3.js';
import { loadBordrCoin, walletHolding, sellIx, simulateSell, classifyError, BORDRLESS_PROGRAMS } from '../../src/bordrSell.js';

const RPC = process.env.RPC || process.env.SOL_RPC;
const MINT = process.env.BORDR_MINT || '28mBhtXnDpLRwSDHQ5F79QHs744XYy6dHXoaXasUUjPx';
const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
if (!RPC) { console.log('SKIP  set RPC=<url> to run the live Bordrless check'); process.exit(0); }

// classifyError is pure: EarlyLocked is retryable and named
const locked = classifyError({ InstructionError: [2, { Custom: 6007 }] }, ['Error Message: tokens bought in the early window are locked.']);
check(locked.kind === 'locked' && locked.retry, 'EarlyLocked (6007) is recognised as the lock and marked retryable');
check(classifyError({ InstructionError: [2, { Custom: 6039 }] }, []).retry === false, 'a non-lock custom error is not retried');

let coin;
try { coin = await loadBordrCoin(RPC, MINT); } catch (e) { console.log('SKIP  coin not found (aged out?): ' + e.message); process.exit(0); }
check(!!coin.earlyUnlockAt && coin.earlyUnlockAt === coin.createdAt + 3600, 'the lock is read off-chain: earlyUnlockAt = createdAt + 1h', new Date(coin.earlyUnlockAt * 1000).toISOString());
check(coin.earlyWindowEnd === coin.createdAt + 300, 'and the early window is the first 5 minutes');

// find a current holder and build+simulate a real sell
const conn = new Connection(RPC, 'confirmed');
const rpc = async (m, p) => { for (let i = 0; i < 6; i++) { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); if (r.status === 429) { await new Promise((x) => setTimeout(x, 1200)); continue; } return (await r.json()).result; } };
const sigs = (await conn.getSignaturesForAddress(new PublicKey(MINT), { limit: 150 })).filter((s) => !s.err);
let holder = null, bal = 0n;
for (const s of sigs) { const t = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]); if (!t) continue; const sg = t.transaction.message.accountKeys.find((k) => k.signer)?.pubkey; if (!sg) continue; const h = await walletHolding(RPC, MINT, sg); if (h.balance > 0n) { holder = sg; bal = h.balance; break; } }
check(!!holder, 'a current holder is found', holder ? `${holder.slice(0, 6)}… holds ${(Number(bal) / 1e6).toFixed(2)}` : 'none');
if (holder) {
  check(typeof sellIx(coin.keys, holder, bal).programId !== 'undefined', 'a sell instruction builds for them');
  const sim = await simulateSell(RPC, { keys: coin.keys, owner: holder, amountIn: bal, minOut: 0n });
  // before unlock: EarlyLocked (structurally correct). after unlock: would sell now.
  check(sim.locked || sim.ok, 'and it either sells now (unlocked) or reverts only on the lock (locked) — proven correct either way', sim.message);
}
check(BORDRLESS_PROGRAMS.dex === 'GyzKSnnEu2uN5bBRecE4XYY2enbfR2D2MtxnbJPGy7hk', 'the Bordrless program ids match the docs');
console.log('');
process.exit(fails.length ? 1 : 0);
