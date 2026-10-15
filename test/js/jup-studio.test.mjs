// Jupiter Studio: launch parameters, the allocation claimable at migration,
// and the claim panel - against Studio's live backend.
//
// Launch transactions are BUILT by Studio for a throwaway wallet and decoded,
// never submitted. Claims are built for a real Studio creator (DFVeSF..., whose
// allocation unlocked in December) and simulated with signature checks off,
// so nothing needs a key and nothing is sent.
//
// Run: node test/js/jup-studio.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { SOL_RPC } from '../../src/rpc.js';
import { studioVesting, studioRaise, studioCreateTx, studioClaimables, studioClaimDryRun, studioCreatorTokens, studioBuildBuy } from '../../src/jupstudio.js';

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};
const connection = new Connection(SOL_RPC, 'confirmed');

// --- the allocation, as Studio's form computes it -------------------------------------
const at = studioVesting({ pct: 40 });
check(at.totalLockedVestingAmount === 400_000_000 && at.cliffUnlockAmount === 400_000_000 && at.cliffDurationFromMigrationTime === 0 && at.totalVestingDuration === 0,
  '40% at migration is 400M tokens, all of it a cliff at the moment of migration');
const y = studioVesting({ pct: 40, months: 12 });
check(y.cliffUnlockAmount === 0 && y.numberOfVestingPeriod === 365 && y.totalVestingDuration === 365 * 86400, 'vested over 12 months daily: nothing at the cliff, 365 daily unlocks');
const half = studioVesting({ pct: 20, months: 12, cliffMonths: 6 });
check(half.cliffUnlockAmount === 100_000_000 && half.numberOfVestingPeriod === 183 && half.cliffDurationFromMigrationTime === 183 * 86400, 'a 6-month cliff inside 12 months releases half at the cliff, then vests the rest');
let threw = 0;
for (const bad of [{ pct: 81 }, { pct: 10, months: 6, cliffMonths: 12 }]) { try { studioVesting(bad); } catch { threw++; } }
check(threw === 2, 'more than 80%, or a cliff longer than the schedule, is refused as Studio refuses it');

// --- the raise -------------------------------------------------------------------------------
const meme = await studioRaise({ initialMarketCap: 5000, migrationMarketCap: 75000, vesting: { pct: 0 } });
const low = await studioRaise({ initialMarketCap: 5000, migrationMarketCap: 75000, vesting: { pct: 40 } });
const fixed = await studioRaise({ initialMarketCap: 10000, migrationMarketCap: 150000, vesting: { pct: 40 } });
check(Math.round(meme.raise) === 15391, "Studio's Meme preset raises ~15,391 USDC, as their docs say", `${meme.raise}`);
check(low.raise < 15000 && fixed.raise >= 15000, 'holding 40% back drops the raise below the floor at 5k->75k; 10k->150k clears it', `${low.raise.toFixed(0)} vs ${fixed.raise.toFixed(0)}`);

// --- a launch, built by Studio for a throwaway wallet ------------------------------------------
const kp = Keypair.generate();
const sk = bs58.encode(kp.secretKey);
let refused = '';
try { await studioCreateTx(sk, { name: 'Test', symbol: 'TST', quote: 'USDC', initialMarketCap: 5000, migrationMarketCap: 75000, vesting: { pct: 40 } }); } catch (e) { refused = e.message; }
check(/threshold is too low/i.test(refused), 'Studio refuses the under-raising curve, exactly as the raise check predicts', refused.slice(0, 80));

const built = await studioCreateTx(sk, { name: 'Studio Test', symbol: 'STEST', quote: 'USDC', initialMarketCap: 10000, migrationMarketCap: 150000, vesting: { pct: 40 } });
const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, 'base64'));
const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
const missing = tx.signatures.map((s, i) => (s.some((b) => b) ? null : keys[i])).filter(Boolean);
check(keys[0] === kp.publicKey.toBase58() && missing.length === 1 && missing[0] === kp.publicKey.toBase58(),
  'Studio builds and co-signs the launch; only the creator\'s signature is left to add', `${tx.signatures.length} signers`);
const coder = new DynamicBondingCurveClient(connection, 'confirmed').creator.program.coder;
let cfg = null;
for (const ix of tx.message.compiledInstructions) {
  if (keys[ix.programIdIndex] !== 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN') continue;
  const d = coder.instruction.decode(Buffer.from(ix.data));
  if (d?.name === 'createConfig' || d?.name === 'create_config') cfg = d.data.config_parameters || d.data.configParameters;
}
const lv = cfg && (cfg.locked_vesting || cfg.lockedVesting);
const lockedTotal = lv ? BigInt(String(lv.cliff_unlock_amount ?? lv.cliffUnlockAmount)) + BigInt(String(lv.amount_per_period ?? lv.amountPerPeriod)) * BigInt(String(lv.number_of_period ?? lv.numberOfPeriod)) : 0n;
check(lockedTotal === 400_000_000n * 10n ** 6n && String(lv.cliff_duration_from_migration_time ?? lv.cliffDurationFromMigrationTime) === '0',
  'and the curve config it creates locks exactly 400,000,000 tokens for the creator, released at migration', `${lockedTotal / 10n ** 6n} tokens`);

// --- claiming, as a real Studio creator ---------------------------------------------------------
const CREATOR = 'CCFRRLa5qvykEuxN5XjwBGGj9QNrBmpa4NegyfbVk5Tk';
const MINT = 'DFVeSFxNohR5CVuReaXSz6rGuJ62LsKhxFpWsDbbjups';
check((await studioCreatorTokens(CREATOR)).includes(MINT), "a creator's Studio coins are listed from their wallet alone");
const c = await studioClaimables(MINT, CREATOR);
check(c.mine && c.graduated && c.dbcPoolAddress && c.dammv2PoolAddress, 'its pools, owner and graduation are read', `${c.dbcPoolAddress?.slice(0, 6)} / ${c.dammv2PoolAddress?.slice(0, 6)}`);
check(c.vesting && BigInt(c.vesting.claimable) > 0n && c.vesting.mine, 'its migration allocation shows as claimable', `${Number(c.vesting.claimable) / 1e6} tokens`);
for (const kind of ['allocation', 'dbc-fees']) {
  const d = await studioClaimDryRun(connection, CREATOR, kind, c).catch((e) => ({ err: e.message }));
  check(!d.err, `claiming the ${kind === 'allocation' ? 'allocation' : 'curve trading fees'} simulates clean for the creator`, d.err ? JSON.stringify(d.err).slice(0, 100) : (d.logs.find((l) => /Instruction: Claim/.test(l)) || '').replace('Program log: ', ''));
}
const other = await studioClaimables(MINT, kp.publicKey.toBase58());
check(other.mine === false, 'and to any other wallet the coin reads as not theirs');

// --- the dev buy: our own buy on the pool, right after launch ------------------------------------
// simulated on a live USDC Studio pool as a large USDC holder, and on a SOL pool
for (const [mint, holder, amount, label] of [
  ['C9vSTnueJpRRcxKJCtn8f3XmCkrGFd4FWqhk6rfXjups', 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', '50000000', '50 USDC on a Studio pool'],
  ['6G3JsxAAjBwQT2gqAUT7ijYm9NZs8fkbkAGSy1mgnCRV', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', '50000000', '0.05 SOL on a SOL pool (Token-2022 coin)'],
]) {
  const b = await studioBuildBuy(connection, new PublicKey(holder), mint, amount).catch((e) => ({ err: e.message }));
  if (!b || b.err) { check(false, `a dev buy of ${label} is built`, b?.err || 'no pool (graduated?)'); continue; }
  b.tx.feePayer = new PublicKey(holder);
  b.tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(new VersionedTransaction(b.tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
  check(!sim.value.err && BigInt(b.minOut) > 0n && BigInt(b.minOut) < BigInt(b.tokensOut), `a dev buy of ${label} simulates clean, with a slippage floor`,
    sim.value.err ? JSON.stringify(sim.value.err) : `${Number(b.tokensOut) / 1e6} tokens, at least ${Number(b.minOut) / 1e6}`);
}

// --- the pad ------------------------------------------------------------------------------------
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'index.html'), 'utf8');
check(/id: 'jup-studio'[^}]*family: 'jupstudio'/.test(MAIN), 'the app lists a Jupiter Studio pad');
check(/if \(pad\.family === 'jupstudio'\) \{\s*await launchJupStudio/.test(MAIN), 'launching on it goes through launchJupStudio, before any IPFS upload');
check(/id="jupAllocOn" checked/.test(HTML) && /id="jupAllocPct" value="40"/.test(HTML), 'with "give me 40% of the supply at migration" ticked by default');
check(['jupQuote', 'jupInitMc', 'jupMigMc', 'jupVest', 'jupCliff', 'jupFreq', 'jupFee', 'jupAnti', 'jupPreset', 'jupLine'].every((id) => HTML.includes(`id="${id}"`)),
  'every Studio launch parameter: quote, market caps, vesting, cliff, unlocks, fee, anti-sniping, presets, live raise');
check(['jupClaimMint', 'jupClaimLoad', 'jupClaims'].every((id) => HTML.includes(`id="${id}"`)) && /studioClaim\(solKeyB58, kind, c, activePad\.rpc\)/.test(MAIN),
  'and a Studio Rewards panel whose claims are simulated before they are sent');

const launchJ = MAIN.slice(MAIN.indexOf('async function launchJupStudio'), MAIN.indexOf('// The claim panel'));
check(HTML.includes('id="jupDevBuy"') && launchJ.indexOf('swapIntoQuote') > -1 && launchJ.indexOf('swapIntoQuote') < launchJ.indexOf('launchStudio(')
  && launchJ.indexOf('studioDevBuy') > launchJ.indexOf('launchStudio('), 'a dev buy: SOL swapped to the pair before the launch, bought the moment the pool lands');
check(/if \(f\.antiSniping\) throw/.test(launchJ) && /graduate it on the spot/.test(launchJ), 'refused with anti-sniping on, or when it would fill the curve by itself');

console.log('');
process.exit(fails.length ? 1 : 0);
