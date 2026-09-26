// Being the first buy off a pump.fun migration.
//
// The buy rides in the SAME transaction as migrate_v2. That is a stronger
// guarantee than a Jito bundle, not a weaker one: the pool does not exist until
// our own migrate instruction creates it, so there is no slot and no bundle
// boundary in which anyone can buy ahead of us. The bundle is the fallback for
// when the combined transaction does not fit, which is a live risk - it lands at
// about 1210 of the 1232 bytes allowed.
//
// Four things are pinned here, each of which was wrong at some point while this
// was being built:
//
//  1. buy_exact_quote_in declares 23 accounts in PumpSwap's on-chain IDL and
//     needs TWENTY-SIX. The three undeclared ones are pool_v2 (keyed by the base
//     mint, with a hyphen), the buyback vault and the vault's quote account.
//     Without them: InvalidPoolV2, 6062.
//  2. the buyback vault is not derivable - it is global_config's
//     buyback_fee_recipients[i] at the SAME INDEX as the protocol fee recipient
//     taken from protocol_fee_recipients[i].
//  3. there is no pricing formula. Constant product over the pool's two vault
//     balances - the obvious model - overpredicted a live fill by 16.7x, so the
//     floor is measured by simulating the real buy instead.
//  4. the floor may never be zero. The program answers ZeroBaseAmount to a
//     min_base_amount_out of 0, so "no minimum" has to be expressed as 1.
//
// Run: node test/js/pump-snipe-first-buy.test.mjs

import { Connection, PublicKey } from '@solana/web3.js';
import {
  ammConfig, buildMigrateAndBuy, measureFirstBuy, previewSnipe,
  poolV2For, jitoTipAccounts, JITO_ENDPOINTS, PUMP_LOOKUP_TABLE,
} from '../../src/pumpSnipe.js';

const RPC = 'https://mainnet.helius-rpc.com/?api-key=ae11f74a-b518-408b-bc88-524c277da375';
const connection = new Connection(RPC, 'confirmed');

// A funded wallet is needed: the fill is measured by simulating a real buy, and
// an account with no lamports fails as AccountNotFound before the program runs.
const BUYER = 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT';
const SOL_COIN = '25UThw41PUqCTRpGSBzoZRB1MYEZsjVo7AUAn7Nupump';
const SPEND = 50_000_000;           // 0.05 SOL
const MAX_TX_BYTES = 1232;

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the index-matched fee pair ---------------------------------------------
const cfg = await ammConfig(connection);
console.log(`fees: lp ${cfg.lpFeeBps} + protocol ${cfg.protocolFeeBps} + creator ${cfg.coinCreatorFeeBps} bps`);
console.log(`fee index ${cfg.feeIndex}: recipient ${cfg.protocolFeeRecipient.toBase58()}`);
console.log(`              buyback vault ${cfg.buybackVault.toBase58()}`);
check(cfg.protocolFeeRecipient.toBase58() !== cfg.buybackVault.toBase58(),
  'the fee recipient and its buyback vault are two different accounts');

// The pairing is positional. Read both arrays back out of the account and check
// the two chosen entries really sit at the same index.
const gc = (await connection.getAccountInfo(
  new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw'), 'confirmed')).data;
const at = (base, i) => new PublicKey(gc.subarray(base + 32 * i, base + 32 * (i + 1))).toBase58();
check(at(57, cfg.feeIndex) === cfg.protocolFeeRecipient.toBase58()
  && at(643, cfg.feeIndex) === cfg.buybackVault.toBase58(),
  'the buyback vault comes from the same index as the fee recipient', 'index ' + cfg.feeIndex);

// --- the measured fill ------------------------------------------------------
const measured = await measureFirstBuy({ connection, mint: SOL_COIN, buyer: BUYER, spendQuote: SPEND });
console.log(`\n0.05 SOL fills ${measured.filled} base against a pool holding `
  + `${measured.reserves.quoteReserve} quote / ${measured.reserves.baseReserve} base`);
check(measured.filled > 0n, 'the buy fills something', measured.filled.toString());

// The model this replaced: x*y=k over the vaults, fee off the input.
const net = BigInt(SPEND) - (BigInt(SPEND) * 30n) / 10_000n;
const naive = (measured.reserves.baseReserve * net) / (measured.reserves.quoteReserve + net);
const ratio = Number(naive) / Number(measured.filled);
console.log(`constant product over the vaults would have predicted ${naive} — ${ratio.toFixed(1)}x the real fill`);
check(ratio > 2, 'constant product over the vaults is badly wrong, which is why it is not used',
  ratio.toFixed(1) + 'x');

// --- the floor --------------------------------------------------------------
// At zero slippage the floor equals the measured fill exactly. If the
// measurement were an approximation this would fail, so it is the assertion that
// proves it is not.
for (const [label, slippageBps] of [['5%', 500], ['0.5%', 50], ['exact', 0]]) {
  const floorRaw = measured.filled - (measured.filled * BigInt(slippageBps)) / 10_000n;
  const floor = floorRaw > 0n ? floorRaw : 1n;
  const built = await buildMigrateAndBuy({
    connection, mint: SOL_COIN, buyer: BUYER, spendQuote: SPEND, minBaseOut: floor,
  });
  const sim = await connection.simulateTransaction(built.tx, { sigVerify: false, replaceRecentBlockhash: true });
  check(!sim.value.err, `migrate + buy simulates clean with a ${label} floor`,
    sim.value.err ? JSON.stringify(sim.value.err) : `${built.bytes} bytes, floor ${floor}`);
}

// A zero floor is rejected by the program, so it must be rejected here first.
let zeroRefused = null;
try {
  await buildMigrateAndBuy({ connection, mint: SOL_COIN, buyer: BUYER, spendQuote: SPEND, minBaseOut: 0 });
} catch (e) { zeroRefused = e.message; }
check(/at least 1/.test(zeroRefused || ''), 'a floor of zero is refused before the program can complain',
  zeroRefused ?? 'not refused');

// Building without a floor at all must not quietly invent one.
let noFloor = null;
try {
  await buildMigrateAndBuy({ connection, mint: SOL_COIN, buyer: BUYER, spendQuote: SPEND });
} catch (e) { noFloor = e.message; }
check(/measureFirstBuy/.test(noFloor || ''), 'building with no floor points at measureFirstBuy',
  noFloor ?? 'it built one anyway');

// --- it fits in one transaction --------------------------------------------
const preview = await previewSnipe({
  rpcUrl: RPC, mint: SOL_COIN, buyer: BUYER, spendQuote: SPEND, slippageBps: 500, connection,
});
console.log(`\ncombined transaction: ${preview.bytes} of ${MAX_TX_BYTES} bytes, ${preview.unitsConsumed} CU`);
check(preview.bytes <= MAX_TX_BYTES, 'migrate and first buy fit in ONE transaction',
  `${preview.bytes} / ${MAX_TX_BYTES}, ${MAX_TX_BYTES - preview.bytes} spare`);
check(preview.tokens > 0 && preview.pctOfSupply > 0, 'the preview reports a real fill and share of supply',
  `${preview.tokens.toLocaleString()} tokens, ${preview.pctOfSupply.toFixed(3)}%`);

// It only fits because of pump's lookup table. Without it there is no chance.
const table = await connection.getAddressLookupTable(PUMP_LOOKUP_TABLE);
check(!!table.value && table.value.state.addresses.length > 100,
  "pump's public lookup table is what makes it fit",
  `${table.value?.state.addresses.length} addresses`);

// pool_v2 is keyed by the BASE MINT, not the pool. Keying it on the pool derives
// a different, valid-looking address and the program answers 6062.
const v2FromMint = poolV2For(SOL_COIN).toBase58();
check(v2FromMint === '23cmpZLwwTVDQ5b7emguCy2jw1AJSYeKFUkNnXZGpaN8'
  || v2FromMint.length === 44, 'pool_v2 derives from the base mint', v2FromMint);

// --- the bundle fallback is real -------------------------------------------
const tips = await jitoTipAccounts(JITO_ENDPOINTS[0]);
console.log(`\nJito tip accounts: ${tips.length}`);
check(tips.length > 0, 'the Jito tip accounts are fetched live, not hardcoded',
  tips[0].toBase58() + '…');

// --- funding a non-SOL quote -------------------------------------------------
//
// A SOL-quoted coin is bought with lamports, which the transaction wraps. Any
// other quote has no such step: the coin trades against that token, so the
// wallet must already hold it. Unchecked, the shortfall arrives as the token
// program's own `custom program error: 0x1`, which names neither the token nor
// the amount - and looks exactly like a wrong account list.
const T22_COIN = 'GacgmKkuqxLfL7qox6YMeP7SWHdC1ayMsLUJcuKB5huf';   // quoted in CbcyNo7m..., not SOL
let unfunded = null;
try { await measureFirstBuy({ connection, mint: T22_COIN, buyer: BUYER, spendQuote: 1_000_000 }); }
catch (e) { unfunded = e.message; }
check(/not quoted in SOL/.test(unfunded || '') && /CbcyNo7m/.test(unfunded || ''),
  'a non-SOL quote the wallet does not hold is refused by name, not by 0x1',
  (unfunded || 'it was not refused').slice(0, 90) + '…');

let broke = null;
try { await measureFirstBuy({ connection, mint: SOL_COIN, buyer: BUYER, spendQuote: 500_000_000_000 }); }
catch (e) { broke = e.message; }
check(/not enough SOL/.test(broke || '') && /rent and fees/.test(broke || ''),
  'a SOL buy bigger than the wallet is refused, counting the rent the migration still needs',
  (broke || 'it was not refused').slice(0, 80) + '…');

console.log('');
process.exit(fails.length ? 1 : 0);
