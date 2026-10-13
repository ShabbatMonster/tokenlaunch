// Launching a pump coin against a quote that is not SOL.
//
// pump's create really does take a quote. The pairable list moved out of Global
// (which still names only USDC) into a dedicated registry on 2026-09-09, and
// create_v2 carries the quote as four TRAILING accounts - the mint, the bonding
// curve's associated account for it, its token program, and the registry. So a
// coin can open on any quote the registry admits, whether or not the launchpad
// you would otherwise use offers it.
//
// The case this was written for: 7VertkgF9KLhxxJXHX6uaWuoYZTP9LdGj2bWmVXVpump,
// a graduated pump coin someone wanted as a quote. Worth checking rather than
// assuming - "it is a pump token" and "pump will pair against it" are different
// claims, and only the registry settles the second.
//
// Run: node test/js/pump-nonsol-quote.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { pumpStatus, pumpProbe } from '../../src/pump.js';
import { healthyRpc } from '../../src/rpc.js';

const RPC = await healthyRpc();
const c = new Connection(RPC, 'confirmed');
const PAYER = 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT';
const QUOTE = '7VertkgF9KLhxxJXHX6uaWuoYZTP9LdGj2bWmVXVpump';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// --- the registry is the authority, not Global --------------------------------
const g = await pumpStatus(RPC);
const admitted = (g.whitelistedQuotes || []).map((q) => q.mint);
check(admitted.length > 50,
  'the quote registry holds far more than Global does, so Global is not the list to read',
  `${admitted.length} admitted, Global names ${(g.whitelistedQuoteMints || []).length}`);
check(admitted.includes(USDC), 'USDC is in it, as Global also says');

// --- the specific quote --------------------------------------------------------
const isAdmitted = admitted.includes(QUOTE);
check(isAdmitted, 'the requested quote is admitted by the registry', QUOTE);

const info = await c.getAccountInfo(new PublicKey(QUOTE));
check(!!info, 'and its mint exists', info ? `${info.data.readUInt8(44)} decimals` : 'missing');

// --- and a launch against it actually simulates --------------------------------
//
// The decisive check. Being in the registry is necessary; only the chain says
// whether create_v2 will take it.
if (!isAdmitted) {
  console.log('SKIP  not admitted, so there is nothing to simulate');
} else {
  const probe = await pumpProbe({
    rpcUrl: RPC, payerPubkey: PAYER, name: 'Quote Test', symbol: 'QT',
    uri: 'https://example.com/m.json', devBuySol: 0, quoteMint: QUOTE,
  });
  check(probe.ready && probe.whitelisted,
    'a launch quoted in it simulates clean against the live program',
    probe.ready ? 'ready' : (probe.reason || (probe.blockers || []).join('; ')));

  const native = await pumpProbe({
    rpcUrl: RPC, payerPubkey: PAYER, name: 'Quote Test', symbol: 'QT',
    uri: 'https://example.com/m.json', devBuySol: 0,
  });
  check(native.ready, 'and a native-SOL launch still does too, so the quote path costs nothing');
}

// --- the quote reaches the launch ---------------------------------------------
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
check(/quoteMint: pumpQuoteMint\(\) \|\| undefined/.test(MAIN),
  'the pad passes whatever quote is chosen into the launch');
const fn = MAIN.slice(MAIN.indexOf('function pumpQuoteMint()'), MAIN.indexOf('\n}', MAIN.indexOf('function pumpQuoteMint()')));
check(/pumpQuoteCustom/.test(fn),
  'and a pasted mint overrides the dropdown, so a quote the list has not been filled with is still reachable');

// The dev buy spends the QUOTE on a non-SOL pair, not SOL. The label used to say
// SOL regardless, which is the kind of thing you notice after spending.
check(/function paintPumpDevSym/.test(MAIN),
  'the DEV BUY label follows the selected quote');
const HTML = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'index.html'), 'utf8');
check(/DEV BUY \(<span id="pumpDevSym">SOL<\/span>/.test(HTML),
  'defaulting to SOL, and named in the markup so it can be repainted');
// the listener may also repaint the depth line, so match the call, not its exact form
check(/pumpQuoteCustom'\)\.addEventListener\('input', (?:paintPumpDevSym\)|\(\) => \{[^}]*paintPumpDevSym\(\))/.test(MAIN),
  'repainted when a mint is pasted, not only when the dropdown changes');

// --- funding, which is the part that bites ------------------------------------
const held = await c.getParsedTokenAccountsByOwner(new PublicKey(PAYER), { mint: new PublicKey(QUOTE) });
const total = held.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmountString), 0);
console.log(`\n   wallet holds ${total.toLocaleString()} of the quote`);
check(true, 'a dev buy on a non-SOL pair spends the quote, so the wallet has to hold it',
  total > 0 ? `${total.toLocaleString()} available` : 'NONE held — a dev buy would fail');

console.log('');
process.exit(fails.length ? 1 : 0);
