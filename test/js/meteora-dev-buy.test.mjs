// Dev buy on Meteora DBC ("first buy").
//
// Three things have to hold, and each one has a way of failing quietly:
//
//  1. the buy lands in the SAME transaction as pool creation. In a transaction
//     of its own it sits a block behind a pool the whole world can already
//     trade, which is not a dev buy at all.
//  2. that combined transaction still fits. A Solana transaction is capped at
//     1232 bytes and pool creation is already heavy (metadata, two vaults, a
//     mint), so the buy is not free to be any shape it likes.
//  3. the swap's token_quote_program is the quote's REAL program. The SDK's own
//     first-buy helper hardcodes the classic Token program, which is the exact
//     assumption buildCreatePoolTx exists to avoid - and a Token-2022 quote
//     would fail on it.
//
// The pricing is checked separately and offline: a dev buy walks the curve we
// are about to create, so it can be priced with no pool and no network.
//
// Run: node test/js/meteora-dev-buy.test.mjs

import { launchMeteora, previewMeteoraDevBuy } from '../../src/solana.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const RPC = 'https://api.mainnet-beta.solana.com';
const SOL = 'So11111111111111111111111111111111111111112';
const kp = Keypair.generate();
const params = {
  feeClaimer: kp.publicKey.toBase58(), baseDecimals: 6, totalSupply: 1_000_000_000,
  feeBps: 100, migrationThreshold: 85, pctSupplyOnMigration: 20.69,
};
const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- pricing, offline -------------------------------------------------------
const one = previewMeteoraDevBuy({ quoteDecimals: 9, params, devBuyQuote: '1' });
console.log(`1 SOL buys ${one.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens `
  + `(${one.pctOfSupply.toFixed(2)}% of supply), fee ${Number(one.feeRaw) / 1e9} SOL`);
check(one.pctOfSupply > 0.5 && one.pctOfSupply < 5,
  '1 SOL into a pump-shaped curve buys a plausible slice', one.pctOfSupply.toFixed(2) + '%');
check(one.feeRaw === '10000000', 'the 100 bps fee is taken off the input, not the output');
check(!one.completesCurve, 'a 1 SOL buy is well inside the curve');

// Bigger buys must cost more per token: the curve only goes one way.
const ten = previewMeteoraDevBuy({ quoteDecimals: 9, params, devBuyQuote: '10' });
check(ten.tokens < one.tokens * 10, 'ten times the money buys less than ten times the tokens',
  `${(ten.tokens / one.tokens).toFixed(2)}x for 10x`);

// Past the migration threshold there is nothing left on the curve to sell, and
// the program refuses rather than partially filling.
const huge = previewMeteoraDevBuy({ quoteDecimals: 9, params, devBuyQuote: '200' });
check(huge.completesCurve, 'a buy past the migration threshold is caught before signing');

check(previewMeteoraDevBuy({ quoteDecimals: 9, params, devBuyQuote: '0' }) === null,
  'no dev buy means no dev buy');

// --- shape, against the live program ---------------------------------------
const r = await launchMeteora({
  rpcUrl: RPC, secretKey: bs58.encode(kp.secretKey), quoteMint: SOL,
  name: 'Dev Buy Test', symbol: 'DEVBUY', uri: 'https://example.com/m.json',
  params, devBuyQuote: '0.5', dryRun: true,
  onStatus: (m) => console.log('  ' + m),
});

console.log(`\npool tx: ${r.poolTxInstructions} instructions, ${r.poolTxBytes} bytes`);
r.firstBuyAccounts.forEach((a, i) => console.log('  ' + String(i).padStart(2), a));

// Fifteen from the IDL, plus the instructions sysvar that Meteora's own
// first-buy path always appends.
check(r.firstBuyAccounts.length === 16, 'the swap carries the IDL’s fifteen accounts plus the sysvar',
  String(r.firstBuyAccounts.length));
check(r.firstBuyAccounts[15] === 'Sysvar1nstructions1111111111111111111111111',
  'the instructions sysvar is last, as in createPoolWithFirstBuy', r.firstBuyAccounts[15]);
check(r.poolTxBytes <= 1232, 'pool creation and the buy fit in one transaction',
  r.poolTxBytes + ' / 1232 bytes');
check(r.devBuy && r.devBuy.tokensOutRaw !== '0', 'the launch prices the buy before it signs anything');

// token_quote_program is account 11 (0-indexed) in the swap. For a SOL quote it
// is the classic Token program; the point is that it is READ, not assumed.
check(r.firstBuyAccounts[11] === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'the swap is given the quote mint’s own token program', r.firstBuyAccounts[11]);

console.log('');
process.exit(fails.length ? 1 : 0);
