// Bags (bags.fm) launches, checked against Bags' own published contract.
//
// Every Bags endpoint needs an API key, and a real launch is co-signed by Bags,
// so the launch flow cannot be run for real here. Instead the whole flow runs
// against a stand-in for the Bags API that checks every request body against
// Bags' LIVE OpenAPI spec (fetched fresh each run, so a change on their side
// shows up here), signs its transactions the way Bags does - its creation
// authority plus a mint it holds - and against a stand-in RPC that verifies
// every ed25519 signature on what is finally sent. That proves the requests are
// what Bags documents, Bags' signatures survive, the creator's is added, and
// nothing is signed that would take more SOL than the launch should.
//
// The parts that need no key are checked live: Bags' sign-in challenge, the
// partner-config PDA against a real partner account, the payout wallet.
//   node test/js/bags-launch.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  Keypair, PublicKey, VersionedTransaction, TransactionMessage, SystemProgram, Connection, Transaction,
} from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {
  BAGS_API, BAGS_FEE_MODES, BAGS_DEFAULT_MODE, BAGS_PAYOUT_WALLET, BAGS_FEE_SHARE_V2, BAGS_PROVIDERS,
  bagsLogin, bagsApi, bagsPartnerConfig, parseBagsClaimers, bagsSplit, bagsFeeBreakdown, checkBagsLaunch,
  bagsClaimables, bagsClaim, bagsManaged, bagsUpdateSplit, bagsTransferManager, bagsPaySetHandle, bagsCreatePartnerKey, decodeBagsTx,
  launchBags, bagsQuotes, bagsFeeMode,
} from '../../src/bags.js';
import { SOL_RPC, SCAN_RPCS } from '../../src/rpc.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const MAIN = read(path.join(ROOT, 'src', 'main.js'));
const HTML = read(path.join(ROOT, 'docs', 'index.html'));

// --- Bags' live contract -------------------------------------------------------------
let spec = null;
for (let i = 0; i < 4 && !spec?.paths; i++) {
  spec = await fetch('https://docs.bags.fm/api-reference/openapi.json').then((r) => r.json()).catch(() => null);
  if (!spec?.paths) await new Promise((r) => setTimeout(r, 2000));
}
if (!spec?.paths) { console.log('SKIP  could not fetch Bags\' OpenAPI spec'); process.exit(1); }
const deref = (x) => (x && x.$ref ? deref(x.$ref.split('/').slice(1).reduce((a, k) => a[k], spec)) : x);
const bodySchema = (method, p) => deref(Object.values(spec.paths[p][method].requestBody.content)[0].schema);

/// Enough JSON Schema to hold a request to Bags' spec: types, required, enums,
/// lengths, item counts, allOf/oneOf. Returns the problems found.
function validate(schema, value, at = 'body') {
  schema = deref(schema);
  if (!schema) return [];
  const errs = [];
  if (schema.allOf) for (const s of schema.allOf) errs.push(...validate(s, value, at));
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => validate(s, value, at).length === 0);
    if (ok.length === 0) errs.push(`${at}: matches none of the oneOf shapes`);
  }
  if (value === undefined || value === null) return errs;
  const t = schema.type;
  const types = Array.isArray(t) ? t : t ? [t] : [];
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (types.length && !types.some((x) => x === actual || (x === 'integer' && Number.isInteger(value)) || (x === 'number' && actual === 'number'))) {
    errs.push(`${at}: is ${actual}, the spec says ${types.join('|')}`);
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: "${value}" is not one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string' && schema.maxLength && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (actual === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${at}: missing required "${r}"`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in value) errs.push(...validate(s, value[k], `${at}.${k}`));
  }
  return errs;
}
// The SOL config schema nests payoutCashout under tipLamports (a slip in Bags'
// spec); lift it to where the endpoint and the payout guide actually take it.
{
  const s = bodySchema('post', '/fee-share/config');
  if (!s.properties.payoutCashout && s.properties.tipLamports?.payoutCashout) s.properties.payoutCashout = s.properties.tipLamports.payoutCashout;
}

// --- the fee modes are Bags' own ------------------------------------------------------
{
  // a property, wherever the schema keeps it (directly, or inside an allOf)
  const prop = (sch, name) => { sch = deref(sch); return deref(sch.properties?.[name]) || (sch.allOf || []).map((x) => prop(x, name)).find(Boolean); };
  const e = prop(bodySchema('post', '/fee-share/config'), 'bagsConfigType');
  const ids = BAGS_FEE_MODES.map((m) => m.id);
  check(e.enum.length === ids.length && e.enum.every((x) => ids.includes(x)),
    'the pad offers exactly the seven fee modes in Bags\' spec', `${ids.length} modes`);
  check(e.default === BAGS_DEFAULT_MODE, 'and defaults to Bags\' own default mode');
  const v2 = prop(bodySchema('post', '/fee-share/config/v2'), 'bagsConfigType');
  check(!!v2?.enum && v2.enum.every((x) => ids.includes(x)), 'the custom-quote config takes the same mode ids');
  const providers = deref(spec.paths['/token-launch/fee-share/wallet/v2'].get.parameters.find((x) => x.name === 'provider').schema).enum;
  check(BAGS_PROVIDERS.every((p) => providers.includes(p)) && providers.every((p) => BAGS_PROVIDERS.includes(p)),
    'and names claimers by every provider Bags resolves', providers.join(' '));
}

// --- the split and what each mode pays -----------------------------------------------
{
  const cl = parseBagsClaimers('@alice 30\ngithub:bob 20\n# a comment\n7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU 10%');
  check(cl.length === 3 && cl[0].provider === 'twitter' && cl[0].username === 'alice' && cl[1].provider === 'github' && cl[2].kind === 'wallet',
    'claimers are read as @handle, provider:username or a wallet, with a percentage');
  check(cl.map((c) => c.bps).join(',') === '3000,2000,1000', 'and percentages become bps');
  let bad = '';
  try { parseBagsClaimers('myspace:tom 10'); } catch (e) { bad = e.message; }
  check(/not a provider Bags resolves/.test(bad), 'an unknown provider is refused', bad.slice(0, 70));
  try { bad = ''; parseBagsClaimers('@alice'); } catch (e) { bad = e.message; }
  check(/recipient and a percentage/.test(bad), 'a line with no share is refused');
  const creator = Keypair.generate().publicKey.toBase58();
  const s = bagsSplit(creator, [{ wallet: 'A1'.padEnd(44, 'A'), bps: 3000 }, { wallet: creator, bps: 1000 }]);
  check(s.basisPointsArray.reduce((a, b) => a + b, 0) === 10000 && s.claimersArray.length === 2,
    'the creator takes whatever is left, and a wallet listed twice is merged', s.basisPointsArray.join('+'));
  try { bad = ''; bagsSplit(creator, [{ wallet: 'B', bps: 6000 }, { wallet: 'C', bps: 5000 }]); } catch (e) { bad = e.message; }
  check(/more than the whole creator pool/.test(bad), 'shares over 100% are refused');
  const d = bagsFeeBreakdown(bagsFeeMode(BAGS_DEFAULT_MODE)).pre;
  check(d.bags === 100 && d.deployer === 25 && d.recipients === 75,
    'Default 2%: 1% to Bags, 0.25% to the deployer, 0.75% to the recipients — as Bags\' guide says', `${d.bags}/${d.deployer}/${d.recipients} bps`);
  const lp = bagsFeeBreakdown(bagsFeeMode('d16d3585-6488-4a6c-9a6f-e6c39ca0fda3')).post;
  check(lp.compounding === 50 && lp.bags === 25 && lp.deployer + lp.recipients === 25,
    'a 1% post-graduation fee with 50% compounding: 0.5% back to liquidity, 0.25% each to Bags and the creator pool');
  check(bagsFeeBreakdown(bagsFeeMode('d16d3585-6488-4a6c-9a6f-e6c39ca0fda3'), { custom: true }).post.compounding === 0,
    'and a custom-quote launch compounds nothing, as Bags documents');
}

// --- refusals before anything is sent ---------------------------------------------------
{
  const quote = { mint: 'Q', symbol: 'NVDAx', available: true, decimals: 8, configs: [{ id: BAGS_DEFAULT_MODE }] };
  const base = { name: 'Coin', symbol: 'COIN', description: '', mode: BAGS_DEFAULT_MODE };
  const refuses = (o, re, label) => {
    let msg = '';
    try { checkBagsLaunch({ ...base, ...o }); } catch (e) { msg = e.message; }
    check(re.test(msg), label, msg.slice(0, 90) || 'it was ACCEPTED');
  };
  refuses({ mode: '810faadb-030b-47de-a68b-7211c1cbbee3', quote }, /only offered for SOL pairs/, 'the 85%-locked mode is refused on a custom quote, as Bags documents');
  refuses({ mode: '48e26d2f-0a9d-4625-a3cc-c3987d874b9e', quote }, /has not set up/, 'a mode Bags has not configured for that quote is refused, naming the ones it has');
  refuses({ quote: { ...quote, available: false, reason: 'paused' } }, /not launchable on Bags right now \(paused\)/, 'an unavailable quote is refused with Bags\' reason');
  refuses({ quote, payout: { method: 'xmoney', username: '@a' } }, /only for SOL-paired/, 'a cash payout on a custom quote is refused');
  refuses({ payout: { method: 'xmoney', username: '@far_too_long_for_x' } }, /not a valid X Money handle/, 'a bad X Money handle is refused with the rule');
  refuses({ payout: { method: 'cashapp', username: '$1234' } }, /at least one letter/, 'a cashtag with no letter is refused');
  refuses({ payout: { method: 'venmo', username: 'abc' } }, /5–30/, 'a too-short Venmo handle is refused');
  refuses({ admin: BAGS_PAYOUT_WALLET }, /cannot be the fee-share manager/, 'the payout wallet is refused as fee-share manager');
  refuses({ name: 'x'.repeat(33) }, /at most 32/, 'a 33-character name is refused');
  refuses({ symbol: 'ELEVENCHARS' }, /1–10 characters/, 'an 11-character ticker is refused');
  let ok = true;
  try { checkBagsLaunch({ ...base, payout: { method: 'cashapp', username: '$coin-pay' } }); checkBagsLaunch({ ...base, quote }); } catch { ok = false; }
  check(ok, 'and a valid payout or quote launch passes');
}

// --- a stand-in Bags API and RPC ----------------------------------------------------------
const BAGS_AUTH = Keypair.generate();     // plays Bags' creation authority BAGSB9Tp…
const calls = [];                          // every request the pad made, checked against the spec
const sent = [];                           // every transaction that reached the RPC, signatures verified
const mints = new Map();                   // mint keypairs Bags "holds"
let rpcSlot = 1000;
const rpcHooks = { spend: 0.02e9, partnerExists: true, quoteHeld: 10n ** 12n };
const users = { 'twitter:alice': Keypair.generate().publicKey.toBase58(), 'github:bob': Keypair.generate().publicKey.toBase58() };
const QUOTE_MINT = Keypair.generate().publicKey.toBase58();
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
let blockhash = bs58.encode(Buffer.alloc(32, 7));
let mfaFor = null;                         // address whose login needs an MFA step
let challengeOverride = null;              // a challenge that is not the wallet check

const sha = (b) => createHash('sha256').update(b).digest('hex');
/// A transaction the way Bags returns one: fee paid by its authority, with the
/// creator (and for a launch, the mint) as further signers, Bags' part signed.
function bagsTx(user, { mint = null } = {}) {
  const ix = SystemProgram.transfer({ fromPubkey: new PublicKey(user), toPubkey: BAGS_AUTH.publicKey, lamports: 1 });
  ix.keys.push({ pubkey: (mint ? mint.publicKey : Keypair.generate().publicKey), isSigner: !!mint, isWritable: false });
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: BAGS_AUTH.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
  tx.sign([BAGS_AUTH, ...(mint ? [mint] : [])]);
  return tx;
}
/// Older Bags claim endpoints can still return legacy transactions; one of those,
/// fee paid by Bags' gas sponsor, the claimer as the second signer.
function legacyClaimTx(user) {
  const tx = new Transaction({ feePayer: BAGS_AUTH.publicKey, recentBlockhash: blockhash })
    .add(SystemProgram.transfer({ fromPubkey: new PublicKey(user), toPubkey: BAGS_AUTH.publicKey, lamports: 1 }));
  tx.partialSign(BAGS_AUTH);
  return tx;
}
const MANAGED_MINT = Keypair.generate().publicKey.toBase58();
const planStage = (id, kind, tx, dependsOn = []) => ({
  id, kind, dependsOn, format: 'v0', encoding: 'base64', transaction: Buffer.from(tx.serialize()).toString('base64'),
  messageSha256: sha(tx.message.serialize()),
  requiredSigners: tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58()),
  lifetime: { blockhash, lastValidBlockHeight: '999999999' },
  budget: { computeUnitLimit: 200000, loadedAccountsDataSizeLimit: 0, priorityFee: { unit: 'micro_lamports_per_compute_unit', amount: '1' } },
  size: { bytes: tx.serialize().length, accounts: tx.message.staticAccountKeys.length, signatures: tx.message.header.numRequiredSignatures },
});
let v2Rounds = 0;

const readBody = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });
const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/api\/v1/, '');
  const raw = await readBody(req);
  const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const ok = (response) => reply(200, { success: true, response });
  const fail = (status, error) => reply(status, { success: false, error });
  const keyed = req.headers['x-api-key'] === 'test-key';
  let json = null;
  if ((req.headers['content-type'] || '').includes('application/json')) json = JSON.parse(raw.toString() || '{}');
  const method = req.method.toLowerCase();
  const op = spec.paths[p]?.[method];
  const problems = op?.requestBody && json ? validate(bodySchema(method, p), json) : [];
  calls.push({ method, path: p, json, query: Object.fromEntries(url.searchParams), problems, keyed, documented: !!op });
  if (!p.startsWith('/agent/') && !keyed) return fail(401, 'API key is required. Please provide x-api-key header.');
  if (problems.length) return fail(400, problems.join('; '));

  if (p === '/agent/v2/auth/init') {
    const nonce = 'n-' + Math.random().toString(36).slice(2);
    const message = challengeOverride || `Verify Your Wallet.\n\nThis request will not ask for a transaction or cost any gas fee.\n\nnonce: ${nonce}`;
    return ok({ message: bs58.encode(Buffer.from(message)), nonce });
  }
  if (p === '/agent/v2/auth/callback') {
    if (json.authCode) return json.mfaCode === '123456' ? ok({ apiKey: 'test-key', keyId: 'k1' }) : fail(401, 'bad MFA code');
    const message = Buffer.from(`Verify Your Wallet.\n\nThis request will not ask for a transaction or cost any gas fee.\n\nnonce: ${json.nonce}`);
    const valid = ed25519.verify(bs58.decode(json.signature), message, new PublicKey(json.address).toBytes());
    if (!valid) return fail(401, 'signature does not verify');
    return json.address === mfaFor ? ok({ mfaRequired: true, authCode: 'auth-1' }) : ok({ apiKey: 'test-key', keyId: 'k1' });
  }
  if (p === '/auth/me') return ok({ user: { username: 'tester' } });
  if (p === '/token-launch/fee-share/wallet/v2') {
    const w = users[`${url.searchParams.get('provider')}:${url.searchParams.get('username')}`];
    return w ? ok({ provider: url.searchParams.get('provider'), platformData: { username: url.searchParams.get('username') }, wallet: w, chain: 'SOL' }) : fail(404, 'user not found');
  }
  if (p === '/token-launch/create-token-info') {
    const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
    const fields = Object.fromEntries([...form.keys()].map((k) => [k, form.get(k)]));
    calls.at(-1).form = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.size}B>`]));
    const s = bodySchema('post', p);
    const missing = s.required.filter((r) => !fields[r]);
    if (missing.length || !(fields.image || fields.imageUrl)) return fail(400, `missing ${missing.join(',') || 'image'}`);
    if (fields.name.length > 32 || fields.symbol.length > 10) return fail(400, 'too long');
    const mint = Keypair.generate();
    mints.set(mint.publicKey.toBase58(), mint);
    return ok({ tokenMint: mint.publicKey.toBase58(), tokenMetadata: 'https://ipfs.io/ipfs/bafkreibagsmetadatatest', tokenLaunch: {} });
  }
  if (p === '/fee-share/config') {
    const tx = bagsTx(json.payer);
    return ok({ needsCreation: true, feeShareAuthority: BAGS_AUTH.publicKey.toBase58(), meteoraConfigKey: Keypair.generate().publicKey.toBase58(),
      transactions: [{ blockhash: { blockhash, lastValidBlockHeight: 999999999 }, transaction: bs58.encode(tx.serialize()) }] });
  }
  if (p === '/token-launch/create-launch-transaction') {
    const tx = bagsTx(json.wallet, { mint: mints.get(json.tokenMint) });
    return ok(bs58.encode(tx.serialize()));
  }
  if (p === '/token-launch/supported-quote-tokens') {
    return ok({ contractVersion: 1, tokens: [{
      asset: { mint: QUOTE_MINT, tokenProgram: TOKEN_2022, decimals: 6 }, observedAt: 1, observedSlot: '1',
      flows: [{ flow: 'dbc', profileEligible: true, reviewedForLaunch: true, launchAvailability: { status: 'available' },
        configs: [{ configType: BAGS_DEFAULT_MODE, graduationThresholdRaw: '85000000' }, { configType: 'd16d3585-6488-4a6c-9a6f-e6c39ca0fda3', graduationThresholdRaw: '170000000' }] }],
    }] });
  }
  if (p === '/fee-share/config/v2') {
    v2Rounds++;
    const meta = { feeShareConfig: Keypair.generate().publicKey.toBase58(), meteoraConfigKey: Keypair.generate().publicKey.toBase58(),
      asset: { mint: QUOTE_MINT, tokenProgram: TOKEN_2022, decimals: 6 }, flow: 'dbc', needsCreation: true };
    if (!(json.additionalLookupTables || []).length) {
      // first: Bags wants a lookup table made and warmed up before the real stage
      return ok({ ...meta, plan: { contractVersion: 1, operation: { kind: 'config', baseMint: json.baseMint, flow: 'dbc' }, asset: meta.asset, feeLimits: [],
        transactions: [planStage('lut-1', 'lookup_table_setup', bagsTx(json.payer))],
        readiness: { status: 'setup_required', lookupTables: ['LUT1111111111111111111111111111111111111111'], minimumSlotExclusive: String(rpcSlot + 2), action: 'confirm_setup_refetch_and_rebuild' } } });
    }
    return ok({ ...meta, plan: { contractVersion: 1, operation: { kind: 'config', baseMint: json.baseMint, flow: 'dbc' }, asset: meta.asset, feeLimits: [],
      transactions: [planStage('cfg-1', 'config', bagsTx(json.payer)), planStage('cfg-2', 'config', bagsTx(json.payer), ['cfg-1'])],
      readiness: { status: 'ready' } } });
  }
  if (p === '/token-launch/create-transaction/v2') {
    const stage = planStage('launch-1', 'launch', bagsTx(json.wallet, { mint: mints.get(json.tokenMint) }));
    if (json.ipfs === 'tamper') stage.messageSha256 = '00'.repeat(32);
    return ok({ contractVersion: 1, operation: { kind: 'launch', baseMint: json.tokenMint, flow: 'dbc' }, asset: { mint: QUOTE_MINT, tokenProgram: TOKEN_2022, decimals: 6 },
      feeLimits: [], transactions: [stage], readiness: { status: 'ready' } });
  }
  // --- managing fees after launch
  const wsol = 'So11111111111111111111111111111111111111112';
  const claimant = url.searchParams.get('wallet') || json?.feeClaimer || json?.wallet || json?.partnerWallet || json?.payer;
  if (p === '/token-launch/claimable-positions') return ok([
    { baseMint: MANAGED_MINT, quoteMint: wsol, isCustomFeeVault: true, isMigrated: false, userBps: 6000, totalClaimableLamportsUserShare: 70000000 },
    { baseMint: MANAGED_MINT, quoteMint: wsol, isCustomFeeVault: true, isMigrated: true, userBps: 6000, totalClaimableLamportsUserShare: 5000000 },
    { baseMint: 'Empty1111111111111111111111111111111111111', quoteMint: wsol, isCustomFeeVault: true, isMigrated: false, totalClaimableLamportsUserShare: 0 },
  ]);
  if (p === '/fee-share/deployer/claimable-positions') return ok({ wallet: claimant, quoteMint: wsol, positions: [{ tokenMint: MANAGED_MINT, pendingDbcLamports: '1000', pendingDammLamports: '0', accruedLamports: '0', totalClaimableLamports: '1000' }], vaultClaimableLamports: '0', unattributedVaultLamports: '0', totalClaimableLamports: '1000' });
  if (p === '/token-launch/claimable-positions/v2') return ok({ contractVersion: 1, wallet: claimant, complete: true, issues: [], items: [
    { id: 'pair:x', wallet: claimant, asset: { mint: QUOTE_MINT, tokenProgram: TOKEN_2022, decimals: 6 }, source: { kind: 'pair_entitlement', baseMint: MANAGED_MINT, config: 'C', authority: 'A', claimerIndex: 0 }, rawAmount: '2500000', availability: { status: 'available' } }] });
  if (p === '/fee-share/partner-config/stats') return ok({ claimedFees: '0', unclaimedFees: '42000' });
  if (p === '/token-launch/claim-txs/v3') return ok([{ tx: bs58.encode(legacyClaimTx(json.feeClaimer).serialize({ requireAllSignatures: false })), blockhash: { blockhash, lastValidBlockHeight: 999999999 } }]);
  if (p === '/fee-share/deployer/claim-txs' || p === '/fee-share/partner-config/claim-tx' || p === '/fee-share/admin/update-config') {
    const transactions = [{ blockhash: { blockhash, lastValidBlockHeight: 999999999 }, transaction: bs58.encode(bagsTx(claimant).serialize()) }];
    return ok(p === '/fee-share/deployer/claim-txs' ? { wallet: claimant, quoteMint: wsol, transactions, remainingTokenMints: [], deferredClaims: [{ tokenMint: null, protocol: 'vault', reason: 'needs_wallet_sol' }], transactionVersion: 0 } : { transactions });
  }
  if (p === '/token-launch/create-claim-txs/v2' || p === '/fee-share/admin/update-config/v2') {
    return ok({ contractVersion: 1, operation: { kind: p.includes('claim') ? 'position_claim' : 'manager_update', baseMint: json.tokenMint || json.baseMint, wallet: claimant },
      asset: { mint: QUOTE_MINT, tokenProgram: TOKEN_2022, decimals: 6 }, feeLimits: [], transactions: [planStage('s-1', p.includes('claim') ? 'claim' : 'manager_update', bagsTx(claimant))], readiness: { status: 'ready' } });
  }
  if (p === '/fee-share/admin/transfer-tx' || p === '/fee-share/partner-config/creation-tx') {
    return ok({ blockhash: { blockhash, lastValidBlockHeight: 999999999 }, transaction: bs58.encode(bagsTx(claimant).serialize()) });
  }
  if (p === '/fee-share/admin/list') return ok({ tokenMints: [MANAGED_MINT] });
  if (p === '/token-launch/creator/v3') return ok([{ provider: 'twitter', providerUsername: 'alice', royaltyBps: 6000, wallet: users['twitter:alice'], isAdmin: true }, { provider: 'unknown', royaltyBps: 4000, wallet: creator.publicKey.toBase58() }]);
  if (p === '/token-launch/lifetime-fees') return ok('123000000');
  if (p === '/bags-payout/token') return ok({ tokenMint: MANAGED_MINT, cashoutMethod: 'cashapp', cashoutMethodLabel: 'Cash App', username: '$coin', status: 'active', paysPayoutBot: true, stats: { totalFiatPaidCents: '1234', openPayoutCount: 1 }, pendingClaims: [] });
  if (p === '/bags-payout/token/cashout') return ok({ tokenMint: json.tokenMint, cashoutMethod: json.cashout.method, username: json.cashout.username, status: 'active' });
  if (p === '/token-launch') return ok({ name: 'Managed', symbol: 'MGD', tokenMint: MANAGED_MINT, quoteMint: wsol });
  return fail(404, 'not in the stand-in');
});

const rpc = http.createServer(async (req, res) => {
  const msg = JSON.parse((await readBody(req)).toString());
  const one = async (m) => {
    const ctx = { context: { slot: rpcSlot } };
    switch (m.method) {
      case 'getBalance': return { ...ctx, value: 50e9 };
      case 'getLatestBlockhash': return { ...ctx, value: { blockhash, lastValidBlockHeight: 999999999 } };
      case 'getBlockHeight': return 1000;
      case 'getSlot': return ++rpcSlot;
      case 'getAccountInfo': return { ...ctx, value: rpcHooks.partnerExists ? { lamports: 1e6, owner: BAGS_FEE_SHARE_V2.toBase58(), data: ['', 'base64'], executable: false, rentEpoch: 0, space: 0 } : null };
      case 'getTokenAccountBalance': return { ...ctx, value: { amount: rpcHooks.quoteHeld.toString(), decimals: 6, uiAmount: 0, uiAmountString: '0' } };
      case 'simulateTransaction': return { ...ctx, value: { err: null, logs: [], unitsConsumed: 1, accounts: [{ lamports: 50e9 - rpcHooks.spend, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false, rentEpoch: 0 }] } };
      case 'sendTransaction': {
        const tx = VersionedTransaction.deserialize(Buffer.from(m.params[0], 'base64'));
        const keys = tx.message.staticAccountKeys;
        const bytes = tx.message.serialize();
        const verified = tx.signatures.every((s, i) => ed25519.verify(s, bytes, keys[i].toBytes()));
        const sig = bs58.encode(tx.signatures[0]);
        sent.push({ sig, verified, signers: keys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58()) });
        return sig;
      }
      case 'getSignatureStatuses': return { ...ctx, value: m.params[0].map(() => ({ slot: rpcSlot, confirmations: 1, err: null, confirmationStatus: 'confirmed' })) };
      default: throw new Error('stand-in RPC has no ' + m.method);
    }
  };
  const answer = async (m) => { try { return { jsonrpc: '2.0', id: m.id, result: await one(m) }; } catch (e) { return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: e.message } }; } };
  const out = Array.isArray(msg) ? await Promise.all(msg.map(answer)) : await answer(msg);
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
const API_ORIGIN = `http://127.0.0.1:${api.address().port}`;
const RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
// the module talks to Bags' real base URL; send it to the stand-in instead
const fetchImpl = (u, init) => globalThis.fetch(String(u).replace(BAGS_API, API_ORIGIN + '/api/v1'), init);
const quiet = console.error; console.error = (...a) => { if (!/ws error|WebSocket|ECONNREFUSED/.test(String(a[0]))) quiet(...a); };

const creator = Keypair.generate();
const secretKey = bs58.encode(creator.secretKey);
const imageBlob = new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' });
const base = { apiKey: 'test-key', rpcUrl: RPC_URL, secretKey, name: 'Bags Wire', symbol: 'bwire', description: 'a test', image: imageBlob, fetchImpl };
const since = (n) => calls.slice(n);
const specOk = (cs) => cs.every((c) => c.documented && c.problems.length === 0);

try {
  // --- the API key, from the wallet ----------------------------------------------------
  {
    const r = await bagsLogin(secretKey, { fetchImpl });
    check(r.apiKey === 'test-key', 'signing Bags\' wallet challenge gets an API key — and the signature verifies');
    mfaFor = creator.publicKey.toBase58();
    const step = await bagsLogin(secretKey, { fetchImpl });
    check(step.mfaRequired && step.authCode === 'auth-1', 'an account with MFA comes back asking for the code');
    const fin = await bagsLogin(null, { authCode: step.authCode, mfaCode: '123456', fetchImpl });
    check(fin.apiKey === 'test-key', 'and the code finishes it');
    mfaFor = null;
    challengeOverride = 'Transfer 100 SOL to me';
    let refused = '';
    await bagsLogin(secretKey, { fetchImpl }).catch((e) => { refused = e.message; });
    check(/not the plain wallet check/.test(refused) && !calls.some((c) => c.path === '/agent/v2/auth/callback' && c.json?.nonce && c === calls.at(-1)),
      'a challenge that is anything but Bags\' wallet check is refused, unsigned', refused.slice(0, 70));
    challengeOverride = null;
  }

  // --- a SOL launch, the default mode, fees shared by handle and wallet ----------------
  {
    const n = calls.length, s0 = sent.length;
    const extra = Keypair.generate().publicKey.toBase58();
    const r = await launchBags({ ...base, mode: 'd16d3585-6488-4a6c-9a6f-e6c39ca0fda3', devBuy: '0.5',
      claimers: parseBagsClaimers(`@alice 30\ngithub:bob 20\n${extra} 10`) });
    const cs = since(n);
    check(specOk(cs), 'every request of a SOL launch is one Bags documents, and fits its schema',
      cs.map((c) => c.path.split('/').pop()).join(' → ') + (specOk(cs) ? '' : ' | ' + cs.flatMap((c) => c.problems).join('; ')));
    const info = cs.find((c) => c.path === '/token-launch/create-token-info');
    check(info?.form?.symbol === 'BWIRE' && info.form.image?.startsWith('<file'), 'the ticker is sent upper-case and the image as a file');
    const cfg = cs.find((c) => c.path === '/fee-share/config')?.json;
    check(cfg?.bagsConfigType === 'd16d3585-6488-4a6c-9a6f-e6c39ca0fda3', 'the chosen fee mode is what the config is created with');
    check(cfg?.claimersArray.includes(users['twitter:alice']) && cfg.claimersArray.includes(users['github:bob']) && cfg.claimersArray.includes(extra),
      '@handles and provider:username are resolved to their Bags wallets');
    check(cfg?.basisPointsArray.reduce((a, b) => a + b, 0) === 10000 && cfg.claimersArray[cfg.claimersArray.length - 1] === creator.publicKey.toBase58()
      && cfg.basisPointsArray.at(-1) === 4000, 'the creator gets the 40% left over, and the split sums to 10,000 bps');
    const launch = cs.find((c) => c.path === '/token-launch/create-launch-transaction')?.json;
    check(launch?.initialBuyLamports === 0.5e9 && launch.configKey && launch.ipfs, 'the dev buy goes in lamports, with the config key and metadata from the steps before');
    const mine = sent.slice(s0);
    check(mine.length === 2 && mine.every((t) => t.verified), 'both transactions reach the chain with every signature valid');
    const last = mine.at(-1);
    check(last?.signers.includes(BAGS_AUTH.publicKey.toBase58()) && last.signers.includes(r.mint) && last.signers.includes(creator.publicKey.toBase58()),
      'the launch carries Bags\' authority, the Bags-held mint and the creator — Bags\' signatures kept, ours added');
    check(r.url === `https://bags.fm/${r.mint}`, 'and links the coin on bags.fm');
  }

  // --- a transaction that would take too much is never signed ---------------------------
  {
    const s0 = sent.length;
    rpcHooks.spend = 3e9;
    let msg = '';
    await launchBags({ ...base, devBuy: '0.1' }).catch((e) => { msg = e.message; });
    rpcHooks.spend = 0.02e9;
    check(/would take 3\.0000 SOL .* not signed/.test(msg) && sent.length === s0,
      'a Bags transaction that would take more SOL than the launch should is refused and never sent', msg.slice(0, 90));
  }

  // --- cash payouts -------------------------------------------------------------------
  {
    const n = calls.length;
    await launchBags({ ...base, payout: { method: 'xmoney', username: '@creator' } });
    const cfg = since(n).find((c) => c.path === '/fee-share/config')?.json;
    check(cfg?.claimersArray.length === 1 && cfg.claimersArray[0] === BAGS_PAYOUT_WALLET && cfg.basisPointsArray[0] === 10000
      && cfg.payoutCashout?.method === 'xmoney' && cfg.payoutCashout.username === '@creator' && specOk(since(n)),
      'a cash payout names Bags\' payout wallet as the only claimer at 100%, with the handle — as Bags\' payout guide says');
  }

  // --- partner, manager, and a big split that needs a lookup table ----------------------
  {
    const n = calls.length;
    const partner = Keypair.generate().publicKey.toBase58();
    const admin = Keypair.generate().publicKey.toBase58();
    const many = [...Array(9)].map(() => `${Keypair.generate().publicKey.toBase58()} 5`).join('\n');
    await launchBags({ ...base, partner, admin, claimers: parseBagsClaimers(many) });
    const cfg = since(n).find((c) => c.path === '/fee-share/config')?.json;
    check(cfg?.partner === partner && cfg.partnerConfig === bagsPartnerConfig(partner).toBase58() && cfg.admin === admin,
      'a partner is sent with the config PDA derived from its wallet, and the manager as admin');
    check(cfg?.claimersArray.length === 10 && cfg.additionalLookupTables?.length === 1,
      'with 10 recipients a lookup table is made first and passed along', `${cfg?.additionalLookupTables?.[0]?.slice(0, 8)}…`);
    rpcHooks.partnerExists = false;
    let msg = '';
    await launchBags({ ...base, partner }).catch((e) => { msg = e.message; });
    rpcHooks.partnerExists = true;
    check(/has no Bags partner key/.test(msg), 'a partner wallet with no partner key is refused before Bags is asked for anything');
  }

  // --- a custom-quote launch, through Bags' transaction plans ---------------------------
  {
    const quotes = await bagsQuotes('test-key', { fetchImpl });
    const q = quotes.find((x) => x.mint === QUOTE_MINT);
    check(q?.available && q.configs.length === 2 && q.decimals === 6, 'the custom quotes come from Bags\' catalog, with the modes configured for each');
    const n = calls.length, s0 = sent.length;
    v2Rounds = 0;
    const r = await launchBags({ ...base, quote: { ...q, symbol: 'TESTx' }, mode: BAGS_DEFAULT_MODE, devBuy: '12.5' });
    const cs = since(n);
    check(specOk(cs), 'every request of a custom-quote launch fits Bags\' schema',
      cs.map((c) => c.path.split('/').pop()).join(' → ') + (specOk(cs) ? '' : ' | ' + cs.flatMap((c) => c.problems).join('; ')));
    check(v2Rounds === 2 && cs.filter((c) => c.path === '/fee-share/config/v2')[1]?.json?.additionalLookupTables?.[0] === 'LUT1111111111111111111111111111111111111111',
      'when Bags asks for lookup-table setup, it is sent, the slot waited out, and the plan fetched again with the table');
    const launch = cs.find((c) => c.path === '/token-launch/create-transaction/v2')?.json;
    check(launch?.initialBuyQuoteRaw === '12500000' && launch.feeShareConfig && launch.quoteMint === QUOTE_MINT,
      'the dev buy goes as raw quote units (12.5 at 6 decimals), with the issued fee-share config');
    check(sent.slice(s0).length === 4 && sent.slice(s0).every((t) => t.verified), 'setup, both config stages and the launch all land, every signature valid');
    check(!!r.mint, 'and the coin is launched');
    let msg = '';
    await launchBags({ ...base, quote: { ...q, symbol: 'TESTx' }, resume: { tokenMint: r.mint, tokenMetadata: 'tamper', configKey: r.configKey, feeShareConfig: r.feeShareConfig } })
      .catch((e) => { msg = e.message; });
    check(/not the message Bags described/.test(msg), 'a plan stage whose bytes do not match its stated hash is refused', msg.slice(0, 80));
  }

  // --- an interrupted launch is finished, not repeated ------------------------------------
  {
    let saved = null;
    rpcHooks.spend = 3e9;
    await launchBags({ ...base, onProgress: (s) => { saved = s; } }).catch(() => {});
    rpcHooks.spend = 0.02e9;
    check(!!saved?.tokenMint && !saved.launched, 'a launch stopped after Bags made the token info keeps the mint it was given');
    const n = calls.length;
    const r = await launchBags({ ...base, resume: saved });
    const cs = since(n);
    check(r.mint === saved.tokenMint && !cs.some((c) => c.path === '/token-launch/create-token-info'),
      'resuming it launches that same mint and never asks Bags for a second one');
  }
  // --- managing fee sharing after launch ---------------------------------------------
  {
    const opts = { rpcUrl: RPC_URL, secretKey, fetchImpl };
    // a claim pays the wallet, so the stand-in RPC simulates a gain
    rpcHooks.spend = -0.05e9;
    const n = calls.length;
    const c = await bagsClaimables('test-key', creator.publicKey.toBase58(), { fetchImpl, rpcUrl: RPC_URL });
    check(c.creator.rows.length === 1 && c.creator.rows[0].lamports === 75000000, 'SOL earnings are added up per coin, and empty ones left out', `${c.creator.rows[0]?.lamports / 1e9} SOL`);
    check(c.deployer.totalLamports === 1000 && c.custom.rows.length === 1 && c.partner?.unclaimedFees === '42000',
      'and the deployer share, custom-quote earnings and partner fees are read too');
    let s0 = sent.length;
    await bagsClaim('test-key', { ...opts, kind: 'creator', mint: MANAGED_MINT });
    check(sent.length === s0 + 1 && sent.at(-1).verified, "a creator claim (a legacy transaction from Bags) is co-signed and sent, Bags' signature kept");
    const dep = await bagsClaim('test-key', { ...opts, kind: 'deployer' });
    check(dep.sigs.length === 1 && dep.deferred[0]?.reason === 'needs_wallet_sol', 'the deployer claim is sent, and what Bags deferred is reported with its reason');
    await bagsClaim('test-key', { ...opts, kind: 'custom', item: c.custom.rows[0] });
    const cq = calls.filter((x) => x.path === '/token-launch/create-claim-txs/v2').at(-1)?.json;
    check(cq?.tokenMint === MANAGED_MINT && cq.quoteMint === QUOTE_MINT && cq.source?.kind === 'pair', "a custom-quote claim goes through Bags' plan with the entitlement it is for");
    await bagsClaim('test-key', { ...opts, kind: 'partner' });
    check(specOk(since(n)), "every claim request fits Bags' schema", since(n).filter((x) => x.problems.length).flatMap((x) => x.problems).join('; '));
    rpcHooks.spend = 1e9;
    let msg = '';
    s0 = sent.length;
    await bagsClaim('test-key', { ...opts, kind: 'creator', mint: MANAGED_MINT }).catch((e) => { msg = e.message; });
    rpcHooks.spend = -0.05e9;
    check(/not signed/.test(msg) && sent.length === s0, 'a "claim" that would take SOL from the wallet instead of paying it is refused unsigned');

    const managed = await bagsManaged('test-key', creator.publicKey.toBase58(), { fetchImpl });
    const m = managed[0];
    check(m?.mint === MANAGED_MINT && m.recipients.length === 2 && m.recipients[0].who === '@alice' && m.lifetimeLamports === 123000000 && m.bagsPay?.label === 'Cash App',
      'the coins this wallet manages are listed with who is paid, lifetime fees and their BagsPay handle');
    const n2 = calls.length;
    await bagsUpdateSplit('test-key', { ...opts, mint: MANAGED_MINT, claimers: parseBagsClaimers('@alice 50\ngithub:bob 25') });
    const up = calls.filter((x) => x.path === '/fee-share/admin/update-config').at(-1)?.json;
    check(up?.claimersArray.length === 3 && up.basisPointsArray.join(',') === '5000,2500,2500' && up.baseMint === MANAGED_MINT,
      'as manager, the split is replaced: handles resolved, the rest to the manager', up?.basisPointsArray.join('+'));
    await bagsUpdateSplit('test-key', { ...opts, mint: MANAGED_MINT, quoteMint: QUOTE_MINT, claimers: parseBagsClaimers('@alice 100') });
    check(calls.some((x) => x.path === '/fee-share/admin/update-config/v2'), 'and on a custom-quote coin through the v2 plan');
    const newAdmin = Keypair.generate().publicKey.toBase58();
    await bagsTransferManager('test-key', { ...opts, mint: MANAGED_MINT, newAdmin });
    const tr = calls.filter((x) => x.path === '/fee-share/admin/transfer-tx').at(-1)?.json;
    check(tr?.newAdmin === newAdmin && tr.currentAdmin === creator.publicKey.toBase58(), 'the manager role can be handed to another wallet');
    msg = '';
    await bagsTransferManager('test-key', { ...opts, mint: MANAGED_MINT, newAdmin: BAGS_PAYOUT_WALLET }).catch((e) => { msg = e.message; });
    check(/cannot be the fee-share manager/.test(msg), 'but never to the BagsPay wallet');
    const pay = await bagsPaySetHandle('test-key', MANAGED_MINT, { method: 'venmo', username: 'new-handle' }, { fetchImpl });
    const ca = calls.filter((x) => x.path === '/bags-payout/token/cashout').at(-1)?.json;
    check(pay.username === 'new-handle' && ca?.cashout?.method === 'venmo', 'BagsPay can be pointed at a different cash handle');
    msg = '';
    await bagsPaySetHandle('test-key', MANAGED_MINT, { method: 'xmoney', username: '@way_too_long_handle' }, { fetchImpl }).catch((e) => { msg = e.message; });
    check(/not a valid X Money handle/.test(msg), 'and a bad handle is refused before Bags is asked');
    msg = '';
    await bagsCreatePartnerKey('test-key', opts).catch((e) => { msg = e.message; });
    check(/already has a Bags partner key/.test(msg), 'a wallet that already is a partner is not charged for a second key');
    rpcHooks.partnerExists = false;
    const pk = await bagsCreatePartnerKey('test-key', opts);
    rpcHooks.partnerExists = true;
    check(pk.partnerConfig === bagsPartnerConfig(creator.publicKey).toBase58() && pk.sigs.length === 1, 'and a new partner key is created at the PDA launches will name');
    check(specOk(since(n2)), "every management request fits Bags' schema", since(n2).filter((x) => x.problems.length).flatMap((x) => x.problems).join('; '));
    rpcHooks.spend = 0.02e9;
  }
} finally {
  console.error = quiet;
  api.close(); rpc.close();
}

// --- live, no key needed ------------------------------------------------------------------
{
  const init = await bagsApi(null, 'POST', '/agent/v2/auth/init', { json: { address: Keypair.generate().publicKey.toBase58() } }).catch((e) => ({ err: e.message }));
  const text = init.message ? Buffer.from(bs58.decode(init.message)).toString() : '';
  check(/^Verify Your Wallet\./.test(text) && text.includes(`nonce: ${init.nonce}`),
    'Bags\' live sign-in challenge is the plain wallet check the pad will sign', init.err || JSON.stringify(text.split('\n')[0]));
  const c = new Connection(SOL_RPC, 'confirmed');
  const pays = await c.getAccountInfo(new PublicKey(BAGS_PAYOUT_WALLET)).catch(() => null);
  check(!!pays, 'Bags\' payout wallet exists on chain', BAGS_PAYOUT_WALLET.slice(0, 8) + '…');
  // real partner keys (Anchor discriminator of PartnerConfig): the partner wallet
  // each one stores derives back to its own address
  const disc = createHash('sha256').update('account:PartnerConfig').digest().subarray(0, 8);
  const scan = new Connection(SCAN_RPCS[0], 'confirmed');
  const partners = await scan.getProgramAccounts(BAGS_FEE_SHARE_V2, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }] }).catch(() => []);
  if (!partners.length) console.log('SKIP  could not list Bags partner keys to check the PDA against');
  else {
    const sample = partners.slice(0, 10);
    const good = sample.filter((a) => bagsPartnerConfig(new PublicKey(a.account.data.subarray(8 + 40, 8 + 72))).equals(a.pubkey)).length;
    check(good === sample.length, 'the partner-config PDA derives the address of real Bags partner keys', `${good} of ${sample.length} (of ${partners.length} on chain)`);
  }
}

// --- live, with a key (BAGS_API_KEY in the environment; never stored) ---------------------
if (process.env.BAGS_API_KEY) {
  const key = process.env.BAGS_API_KEY;
  const me = await bagsApi(key, 'GET', '/auth/me').catch((e) => ({ err: e.message }));
  check(!me.err, 'the key is accepted by Bags', me.err || 'auth/me ok');
  // a real coin's real manager: read-only, and the claim transaction is only
  // decoded and simulated, never signed
  const W = '3wruVjV7iftKiQwoUwNNNDBd5JiZm2wW4yixscHv7Gwd', M = '4rRkeKx9qDwrebNeRy9Nmf5cATTPYoG9DXpRpH5ABAGS';
  const cl = await bagsClaimables(key, W, { rpcUrl: SOL_RPC });
  check(!cl.creator.error && !cl.deployer.error && !cl.custom.error, "live: a wallet's creator, deployer and custom-quote earnings all read", `${cl.creator.rows.length} coins with SOL to claim`);
  const mg = await bagsManaged(key, W);
  check(mg.some((t) => t.mint === M && t.recipients.length > 0), 'live: the coins a wallet manages read back with their split', mg.map((t) => t.symbol).join(' '));
  const txs = await bagsApi(key, 'POST', '/token-launch/claim-txs/v3', { json: { feeClaimer: W, tokenMint: M } }).catch(() => []);
  if (!txs.length) console.log('SKIP  live: nothing to claim on the reference coin right now');
  else {
    const tx = decodeBagsTx(txs[0].tx);
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
    const c = new Connection(SOL_RPC, 'confirmed');
    const before = await c.getBalance(new PublicKey(W));
    const sim = await c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { addresses: [W], encoding: 'base64' } });
    const gain = (sim.value.accounts?.[0]?.lamports ?? before) - before;
    check(signers.includes(W) && !sim.value.err && gain > 0, "live: a real claim from Bags needs the claimer's signature and pays the claimer", `+${(gain / 1e9).toFixed(4)} SOL`);
  }
  const qs = await bagsQuotes(key, { connection: new Connection(SOL_RPC, 'confirmed') });
  check(qs.length > 0 && qs.every((q) => q.mint && q.configs.every((x) => BAGS_FEE_MODES.some((m) => m.id === x.id))),
    "live: Bags' custom quotes read, and every mode they offer is one the pad knows", `${qs.length} quotes`);
} else console.log('SKIP  set BAGS_API_KEY to run the live reads');

// --- the pad ------------------------------------------------------------------------------
check(/id: 'bags-sol'/.test(MAIN) && /family: 'bags'/.test(MAIN), 'main.js has the Bags pad');
for (const id of ['bagsRow', 'bagsApiKey', 'bagsLoginBtn', 'bagsMfa', 'bagsQuote', 'bagsMode', 'bagsDevBuy', 'bagsFeesTo', 'bagsClaimers', 'bagsPayoutMethod', 'bagsPayoutHandle', 'bagsAdmin', 'bagsPartner', 'bagsSummary']) {
  check(HTML.includes(`id="${id}"`), `UI has #${id}`);
}
check(/bags\.apikey/.test(MAIN) && !/test-key/.test(MAIN), 'the API key is kept in this browser only, never in the code');
check(/async function launchBagsPad/.test(MAIN) && /resume: bagsPending/.test(MAIN), 'the pad launches through the module and resumes an interrupted launch');
check(/if \(activePad\.family === 'bags'\) return renderBagsClaims\(box\)/.test(MAIN) && /if \(activePad\.family === 'bags'\) \{ await claimAllBags\(btn\)/.test(MAIN),
  'MY TOKENS shows Bags earnings and coins managed, and CLAIM ALL claims every kind');
check(['data-bags-claim', 'data-bags-partner', 'data-bags-edit="split"', 'data-bags-edit="admin"', 'data-bags-edit="pay"'].every((a) => MAIN.includes(a)),
  "with a claim for each earning, partner-key creation, and the manager's edit split / move manager / BagsPay");
check(['twitter:', 'tiktok:', 'kick:', 'github:', 'instagram:', 'domain:'].every((x) => HTML.includes(x)), 'the pad lists every provider Bags resolves');

console.log('');
process.exit(fails.length ? 1 : 0);
