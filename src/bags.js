// Bags (bags.fm): Meteora DBC launches through Bags' own API, with its current
// fee sharing - read off the official SDK (@bagsfm/bags-sdk 1.4.4), the OpenAPI
// spec at docs.bags.fm/api-reference/openapi.json and the guides, 2026-11-07.
//
// A real Bags launch cannot be built without Bags: every one carries three
// signatures - Bags' creation authority BAGSB9Tp…, a …BAGS mint whose key Bags
// holds, and the creator - so the transactions come from their API, partially
// signed, and this module adds the creator's signature. Every endpoint wants an
// x-api-key; one can be minted by signing Bags' wallet challenge (the agent
// auth flow), so no dashboard sign-up is needed.
//
// The flow:
//   1. create-token-info: image + metadata, and Bags hands back the mint
//   2. a fee-share config: who the creator fees go to, and the fee mode
//      - SOL: POST /fee-share/config (transactions, or Jito bundles)
//      - any other quote: POST /fee-share/config/v2, a "transaction plan"
//   3. the launch: create-launch-transaction (SOL) or create-transaction/v2
//
// Bags builds these transactions, so nothing is signed on trust: each one is
// simulated first and refused if it would take more SOL from the wallet than
// the launch should cost.
import {
  Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram,
  SystemProgram, AddressLookupTableProgram,
} from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';

export const BAGS_API = 'https://public-api-v2.bags.fm/api/v1';
export const bagsCoinUrl = (mint) => `https://bags.fm/${mint}`;
export const BAGS_FEE_SHARE_V2 = new PublicKey('FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK');
/// Bags Payouts: name this wallet as the only claimer and Bags claims the fees,
/// converts them and pays them out as cash to an X Money / Cash App / Venmo handle.
export const BAGS_PAYOUT_WALLET = 'PAY9yjtc5nkuQL3yFd6yV3M1WoX7uNfFMAQdB9tHjSR';
export const BAGS_MAX_CLAIMERS = 100;
/// Above this many claimers a SOL config needs a lookup table (the OpenAPI spec
/// says 7; the 1.4.4 SDK still says 15 - the stricter one is used).
export const BAGS_CLAIMERS_WITHOUT_LUT = 7;
export const BAGS_NAME_MAX = 32;
export const BAGS_SYMBOL_MAX = 10;
export const BAGS_DESCRIPTION_MAX = 1000;
const WSOL = 'So11111111111111111111111111111111111111112';

/// The seven fee modes ("bagsConfigType"), as docs.bags.fm/how-to-guides/customize-token-fees
/// lays them out. Fees in bps; `post` is the post-graduation pool fee; `compounding`
/// is the % of post-graduation fees put back into liquidity (SOL launches only -
/// a custom quote keeps the rates and compounds nothing). Of what is left, half
/// goes to Bags and half to the creator pool, and the deployer (whoever pays for
/// the config) takes 25% of the creator pool before the recipients split the rest.
export const BAGS_FEE_MODES = [
  { id: 'fa29606e-5e48-4c37-827f-4b03d58ee23d', label: 'Default — 2% / 2%', pre: 200, post: 200, compounding: 25, gradSol: 85 },
  { id: 'd16d3585-6488-4a6c-9a6f-e6c39ca0fda3', label: 'Low pre / high post — 0.25% → 1%', pre: 25, post: 100, compounding: 50, gradSol: 85 },
  { id: 'a7c8e1f2-3d4b-5a6c-9e0f-1b2c3d4e5f6a', label: 'High pre / low post — 1% → 0.25%', pre: 100, post: 25, compounding: 50, gradSol: 85 },
  { id: '48e26d2f-0a9d-4625-a3cc-c3987d874b9e', label: 'High flat — 10% / 10%', pre: 1000, post: 1000, compounding: 50, gradSol: 85 },
  { id: '810faadb-030b-47de-a68b-7211c1cbbee3', label: '2% flat, 85% of supply locked', pre: 200, post: 200, compounding: 25, gradSol: 100, locked: 85, solOnly: true },
  { id: 'e2963a6c-441a-4862-9d80-b94e3a481cd7', label: 'Default, 1,000 supply', pre: 200, post: 200, compounding: 25, gradSol: 85, supply: 1000 },
  { id: 'ba28db46-ea6f-4452-8218-5587f6aca0a1', label: '2% base, 96% locked, falls to 0.5% as it grows', pre: 200, post: 200, postFloor: 50, compounding: 25, gradSol: 80, locked: 96 },
];
export const BAGS_DEFAULT_MODE = BAGS_FEE_MODES[0].id;
export const bagsFeeMode = (id) => BAGS_FEE_MODES.find((m) => m.id === id) || null;

/// Where a claimer can be named by handle instead of wallet (Bags resolves the
/// handle to that account's Bags wallet). `domain` means bags@<domain>.
export const BAGS_PROVIDERS = ['twitter', 'tiktok', 'kick', 'github', 'instagram', 'onlyfans', 'domain',
  'email', 'google', 'apple', 'solana', 'moltbook'];

/// The cash payout handles, with Bags' own format rules.
export const BAGS_PAYOUT_METHODS = {
  xmoney: { label: 'X Money', rule: /^@?[A-Za-z0-9_]{1,15}$/, hint: '1–15 letters, digits or _ — an X account with X Money turned on' },
  cashapp: { label: 'Cash App', rule: /^\$?(?=[^$]*[A-Za-z])[A-Za-z0-9_-]{1,20}$/, hint: '$cashtag, 1–20 characters with at least one letter' },
  venmo: { label: 'Venmo', rule: /^@?[A-Za-z0-9_-]{5,30}$/, hint: '5–30 letters, digits, - or _' },
};

export class BagsApiError extends Error {
  constructor(status, message) { super(message); this.name = 'BagsApiError'; this.status = status; }
}

/// One call to the Bags API. Errors come back as { success: false } with the
/// reason in `error` (or, on some endpoints, `response`).
export async function bagsApi(apiKey, method, path, { query, json, form, fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(BAGS_API + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const headers = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  let body;
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); } else if (form) body = form;
  const res = await fetchImpl(url.toString(), { method, headers, body });
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok || !data || data.success === false) {
    const why = (data && (typeof data.error === 'string' ? data.error : typeof data.response === 'string' ? data.response : null))
      || `HTTP ${res.status}`;
    throw new BagsApiError(res.status, res.status === 401 ? `Bags refused the API key (${why})` : why);
  }
  return data.response;
}

const keypairOf = (secret) => (secret instanceof Keypair ? secret : Keypair.fromSecretKey(bs58.decode(secret)));

/// Mint a Bags API key with the wallet itself (POST /agent/v2/auth/init, then
/// /callback). Only Bags' plain-text wallet check is ever signed: a challenge
/// that is anything else - a transaction, say - is refused unsigned. When the
/// account has MFA on, this returns { mfaRequired, authCode } instead, and the
/// same call with { authCode, mfaCode } finishes it.
export async function bagsLogin(secret, { keyName = 'tokenlaunch', authCode, mfaCode, fetchImpl } = {}) {
  const done = (r) => (r?.mfaRequired ? { mfaRequired: true, authCode: r.authCode }
    : r?.apiKey ? { apiKey: r.apiKey, keyId: r.keyId || null } : (() => { throw new Error('Bags did not return an API key'); })());
  if (authCode) {
    if (!/^\d{4,8}$/.test(String(mfaCode || ''))) throw new Error('enter the MFA code from your authenticator');
    return done(await bagsApi(null, 'POST', '/agent/v2/auth/callback', { json: { authCode, mfaCode: String(mfaCode), keyName }, fetchImpl }));
  }
  const kp = keypairOf(secret);
  const address = kp.publicKey.toBase58();
  const init = await bagsApi(null, 'POST', '/agent/v2/auth/init', { json: { address }, fetchImpl });
  const message = bs58.decode(init.message);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(message);
  if (!/^Verify Your Wallet\./.test(text) || !text.includes(`nonce: ${init.nonce}`)) {
    throw new Error('Bags\' sign-in challenge is not the plain wallet check it should be, so it was not signed');
  }
  const signature = bs58.encode(ed25519.sign(message, kp.secretKey.slice(0, 32)));
  return done(await bagsApi(null, 'POST', '/agent/v2/auth/callback', {
    json: { signature, address, nonce: init.nonce, keyName }, fetchImpl,
  }));
}

/// Whose key this is, as Bags sees it - a cheap check that a pasted key works.
export const bagsWhoAmI = (apiKey, o = {}) => bagsApi(apiKey, 'GET', '/auth/me', o).then((r) => r?.user || r);

/// The partner config is a PDA of the partner's wallet on fee-share v2, so a
/// partner is named by wallet alone; the pad checks it exists before launching.
export const bagsPartnerConfig = (partner) => PublicKey.findProgramAddressSync(
  [Buffer.from('partner_config'), new PublicKey(partner).toBuffer()], BAGS_FEE_SHARE_V2)[0];

const isWallet = (s) => { try { return new PublicKey(s).toBase58() === s; } catch { return false; } };

/// Read the FEES GO TO lines, one recipient per line with a percentage:
///   @alice 30           (an X handle)
///   github:bob 20       (any provider Bags resolves)
///   7xKX…AsU 10         (a wallet)
/// Whatever is left over goes to the creator. Percentages are of the creator
/// pool, after Bags' share and the deployer's 25%.
export function parseBagsClaimers(text) {
  const out = [];
  for (const raw of String(text || '').split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s+([\d.]+)\s*%?$/);
    if (!m) throw new Error(`"${line}" should be a recipient and a percentage, like "@alice 30"`);
    const [, who, pctStr] = m;
    const pct = Number(pctStr);
    if (!(pct > 0 && pct <= 100)) throw new Error(`"${line}": the share has to be more than 0% and at most 100%`);
    const bps = Math.round(pct * 100);
    if (Math.abs(bps - pct * 100) > 1e-6) throw new Error(`"${line}": shares go to 0.01%`);
    if (isWallet(who)) { out.push({ kind: 'wallet', wallet: who, bps }); continue; }
    const [provider, username] = who.startsWith('@') ? ['twitter', who.slice(1)]
      : who.includes(':') ? [who.slice(0, who.indexOf(':')).toLowerCase(), who.slice(who.indexOf(':') + 1)] : [null, null];
    if (!provider || !username) throw new Error(`"${who}" is not a wallet, an @handle, or provider:username`);
    if (!BAGS_PROVIDERS.includes(provider)) throw new Error(`"${provider}" is not a provider Bags resolves (${BAGS_PROVIDERS.join(', ')})`);
    out.push({ kind: 'social', provider, username, bps });
  }
  return out;
}

/// The recipients as the config wants them: wallets and bps, summing to 10000,
/// the creator taking whatever the others leave, no wallet listed twice.
export function bagsSplit(creator, resolved) {
  const total = resolved.reduce((s, r) => s + r.bps, 0);
  if (total > 10000) throw new Error(`the shares add up to ${total / 100}% — more than the whole creator pool`);
  const merged = new Map();
  const add = (wallet, bps) => merged.set(wallet, (merged.get(wallet) || 0) + bps);
  for (const r of resolved) add(r.wallet, r.bps);
  if (total < 10000) add(creator, 10000 - total);
  if (merged.size > BAGS_MAX_CLAIMERS) throw new Error(`Bags allows ${BAGS_MAX_CLAIMERS} fee recipients at most; this is ${merged.size}`);
  return { claimersArray: [...merged.keys()], basisPointsArray: [...merged.values()] };
}

/// What one trade fee pays, by party, for a mode - so the pad can say it plainly.
export function bagsFeeBreakdown(mode, { custom = false, recipientBps = 10000 } = {}) {
  const split = (bps, compound) => {
    const kept = bps * (1 - compound / 100);
    const pool = kept / 2;                                   // the creator pool
    return { total: bps, bags: kept / 2, compounding: bps - kept, deployer: pool * 0.25, recipients: pool * 0.75 * recipientBps / 10000 };
  };
  return { pre: split(mode.pre, 0), post: split(mode.post, custom ? 0 : mode.compounding) };
}

/// Every claimer handle resolved to its Bags wallet (GET /token-launch/fee-share/wallet/v2).
export async function resolveBagsClaimers(apiKey, claimers, { fetchImpl, onStatus } = {}) {
  const out = [];
  for (const c of claimers) {
    if (c.kind === 'wallet') { out.push({ ...c }); continue; }
    onStatus && onStatus(`looking up ${c.provider}:${c.username} on Bags…`);
    const r = await bagsApi(apiKey, 'GET', '/token-launch/fee-share/wallet/v2', {
      query: { provider: c.provider, username: c.username, chain: 'SOL' }, fetchImpl,
    }).catch((e) => { throw new Error(`could not find ${c.provider}:${c.username} on Bags — ${e.message}`); });
    if (!r?.wallet || !isWallet(r.wallet)) throw new Error(`Bags has no Solana wallet for ${c.provider}:${c.username}`);
    out.push({ ...c, wallet: r.wallet, display: r.platformData?.username || c.username });
  }
  return out;
}

/// The non-SOL quotes Bags has approved for DBC launches, each with the fee modes
/// configured for it and their graduation thresholds (GET /token-launch/supported-quote-tokens).
export async function bagsQuotes(apiKey, { connection, fetchImpl } = {}) {
  const r = await bagsApi(apiKey, 'GET', '/token-launch/supported-quote-tokens', { query: { flow: 'dbc' }, fetchImpl });
  const rows = [];
  for (const t of r?.tokens || []) {
    const flow = (t.flows || []).find((f) => f.flow === 'dbc');
    if (!flow || t.asset?.mint === WSOL) continue;
    rows.push({
      mint: t.asset.mint, tokenProgram: t.asset.tokenProgram, decimals: t.asset.decimals,
      available: flow.profileEligible && flow.launchAvailability?.status === 'available',
      reason: flow.launchAvailability?.reason || (flow.profileEligible ? null : 'not eligible for DBC'),
      configs: (flow.configs || []).map((c) => ({ id: c.configType, graduationThresholdRaw: c.graduationThresholdRaw })),
    });
  }
  if (connection && rows.length) {
    const names = await mintSymbols(connection, rows.map((q) => q.mint));
    rows.forEach((q, i) => { q.symbol = names[i].symbol; q.name = names[i].name; });
  }
  return rows.sort((a, b) => (b.available - a.available) || String(a.symbol).localeCompare(String(b.symbol)));
}

const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
/// Tickers for a list of mints: a Token-2022 mint's own metadata, else Metaplex.
async function mintSymbols(connection, mints) {
  const keys = mints.map((m) => new PublicKey(m));
  const meta = keys.map((k) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), k.toBuffer()], METAPLEX)[0]);
  const out = [];
  for (let i = 0; i < keys.length; i += 90) {
    const [infos, metas] = await Promise.all([
      connection.getMultipleParsedAccounts(keys.slice(i, i + 90)), connection.getMultipleAccountsInfo(meta.slice(i, i + 90)),
    ]);
    infos.value.forEach((v, j) => {
      const md = (v?.data?.parsed?.info?.extensions || []).find((e) => e.extension === 'tokenMetadata')?.state;
      let symbol = md?.symbol, name = md?.name;
      if (!symbol && metas[j]) {
        const d = metas[j].data; let o = 65;
        const str = () => { const n = d.readUInt32LE(o); o += 4; const s = d.subarray(o, o + n).toString('utf8').replace(/\0+$/, ''); o += n; return s.trim(); };
        name = str(); symbol = str();
      }
      out.push({ symbol: symbol || mints[i + j].slice(0, 6), name: name || '' });
    });
  }
  return out;
}

// --- signing what Bags builds -------------------------------------------------

/// Simulate, check what it costs the wallet, sign, send, confirm. `maxSpendLamports`
/// is everything the launch may take: a transaction that would take more is
/// refused unsigned, because the bytes came from Bags, not from us.
async function signAndSend(connection, tx, signer, { maxSpendLamports, lifetime, label = 'transaction', onStatus } = {}) {
  const who = signer.publicKey.toBase58();
  const required = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
  if (!required.includes(who)) throw new Error(`Bags' ${label} is not signed by this wallet, so it is not ours to send`);
  const before = await connection.getBalance(signer.publicKey, 'confirmed');
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed',
    accounts: { addresses: [who], encoding: 'base64' },
  });
  if (sim.value.err) {
    const why = (sim.value.logs || []).find((l) => /Error Message:|failed:|insufficient/i.test(l)) || JSON.stringify(sim.value.err);
    throw new Error(`Bags' ${label} would fail: ${why.replace(/^Program log: /, '')}`);
  }
  const after = sim.value.accounts?.[0]?.lamports;
  if (after != null && maxSpendLamports != null && before - after > maxSpendLamports) {
    throw new Error(`Bags' ${label} would take ${((before - after) / 1e9).toFixed(4)} SOL from the wallet, more than the `
      + `${(maxSpendLamports / 1e9).toFixed(4)} SOL this launch should cost — not signed`);
  }
  tx.sign([signer]);   // keeps the signatures Bags already put on it
  if (tx.signatures.some((s) => s.every((b) => b === 0))) throw new Error(`Bags' ${label} still needs a signature this wallet cannot give`);
  onStatus && onStatus(`sending ${label}…`);
  return sendAndConfirm(connection, tx.serialize(), label, lifetime);
}

/// Send, then poll the signature and re-send until it confirms or its blockhash
/// expires - as Bags' SDK does. No websocket, so it works on any RPC.
async function sendAndConfirm(connection, raw, label, lifetime) {
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  const lastValid = Number(lifetime?.lastValidBlockHeight ?? (await connection.getLatestBlockhash('confirmed')).lastValidBlockHeight);
  for (;;) {
    const { value } = await connection.getSignatureStatuses([sig]);
    const st = value?.[0];
    if (st?.err) throw new Error(`${label} failed on chain: ${JSON.stringify(st.err)} (${sig})`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    if (await connection.getBlockHeight('confirmed') > lastValid) {
      throw new Error(`${label} was not confirmed before its blockhash expired (${sig}) — check the wallet before launching again`);
    }
    await sleep(1000);
    await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
  }
}

const sha256Hex = async (bytes) => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

/// One stage of a Bags transaction plan (the custom-quote endpoints), checked the
/// way docs.bags.fm/principles/transaction-plans says: its message hash and
/// blockhash match what the plan claims, it has not expired, and the wallet is
/// one of its signers. Bags' own signatures are kept.
export async function decodePlanStage(stage) {
  if (stage.format !== 'v0' || stage.encoding !== 'base64') throw new Error(`a ${stage.format}/${stage.encoding} plan stage is not one this pad can sign`);
  const tx = VersionedTransaction.deserialize(Buffer.from(stage.transaction, 'base64'));
  if (await sha256Hex(tx.message.serialize()) !== stage.messageSha256) throw new Error(`plan stage ${stage.id}: its bytes are not the message Bags described`);
  if (tx.message.recentBlockhash !== stage.lifetime?.blockhash) throw new Error(`plan stage ${stage.id}: its blockhash is not the one Bags described`);
  return tx;
}

async function runPlanStages(connection, stages, signer, { maxSpendLamports, onStatus } = {}) {
  const done = new Set();
  const sigs = [];
  for (const stage of stages) {
    for (const dep of stage.dependsOn || []) if (!done.has(dep)) throw new Error(`plan stage ${stage.id} depends on ${dep}, which has not landed`);
    if (!(stage.requiredSigners || []).includes(signer.publicKey.toBase58())) {
      throw new Error(`plan stage ${stage.id} is not signed by this wallet`);
    }
    if (await connection.getBlockHeight('confirmed') > Number(stage.lifetime.lastValidBlockHeight)) {
      throw new Error(`plan stage ${stage.id} expired before it could be sent — launch again to resume`);
    }
    const tx = await decodePlanStage(stage);
    sigs.push(await signAndSend(connection, tx, signer, { maxSpendLamports, lifetime: stage.lifetime, label: `${stage.kind} (${stage.id})`, onStatus }));
    done.add(stage.id);
  }
  return sigs;
}

/// Run a plan endpoint to completion: lookup-table setup first when Bags asks
/// for it (confirm, wait for the slot it names, fetch the plan again with the
/// tables), then the business stages in order.
async function runPlan(connection, signer, fetchPlan, { maxSpendLamports, onStatus } = {}) {
  let tables = [];
  for (let round = 0; round < 8; round++) {
    const plan = await fetchPlan(tables);
    if (!plan) return { sigs: [] };
    if (plan.readiness?.status === 'setup_required') {
      onStatus && onStatus('setting up a lookup table for Bags…');
      await runPlanStages(connection, plan.transactions || [], signer, { maxSpendLamports, onStatus });
      tables = [...new Set([...tables, ...(plan.readiness.lookupTables || [])])];
      const min = plan.readiness.minimumSlotExclusive;
      if (min) { while (await connection.getSlot('confirmed') <= Number(min)) await sleep(400); } else await sleep(1500);
      continue;
    }
    return { plan, sigs: await runPlanStages(connection, plan.transactions || [], signer, { maxSpendLamports, onStatus }) };
  }
  throw new Error('Bags\' lookup table never became ready; launch again to resume');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A lookup table of the claimers, for a SOL config with more than 7 of them
/// (the SDK's getConfigCreationLookupTableTransactions, done here).
async function claimersLookupTable(connection, signer, wallets, { onStatus } = {}) {
  const slot = await connection.getSlot('finalized');
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: signer.publicKey, payer: signer.publicKey, recentSlot: slot });
  const send = async (ixs, label) => {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: signer.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 40_000 }), ...ixs],
    }).compileToV0Message());
    return signAndSend(connection, tx, signer, { maxSpendLamports: 0.05e9, lifetime: { blockhash, lastValidBlockHeight }, label, onStatus });
  };
  onStatus && onStatus(`creating a lookup table for ${wallets.length} fee recipients…`);
  await send([create], 'the lookup table');
  const start = await connection.getSlot('confirmed');
  while (await connection.getSlot('confirmed') <= start) await sleep(400);
  for (let i = 0; i < wallets.length; i += 25) {
    await send([AddressLookupTableProgram.extendLookupTable({
      lookupTable: table, authority: signer.publicKey, payer: signer.publicKey, addresses: wallets.slice(i, i + 25).map((w) => new PublicKey(w)),
    })], 'the lookup table entries');
  }
  return table.toBase58();
}

/// Jito bundles Bags returns for a big SOL config: a tip transaction in front,
/// relayed through Bags (/solana/send-bundle), then polled until it lands.
const JITO_TIPS = ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49'];
async function sendBagsBundle(apiKey, connection, signer, bundle, { maxSpendLamports, fetchImpl, onStatus } = {}) {
  const txs = bundle.map((b) => VersionedTransaction.deserialize(bs58.decode(b.transaction)));
  const fees = await bagsApi(apiKey, 'GET', '/solana/jito-recent-fees', { fetchImpl }).catch(() => null);
  // Bags' guide tips at the 95th percentile of landed tips; capped here so one
  // spike cannot make the bundle cost more than it needs to
  const tipLamports = Math.min(0.01e9, Math.max(10_000, Math.floor(Number(fees?.landed_tips_95th_percentile ?? 0.001) * 1e9)));
  const tip = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey, recentBlockhash: txs[0].message.recentBlockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(JITO_TIPS[Math.floor(Math.random() * JITO_TIPS.length)]), lamports: tipLamports })],
  }).compileToV0Message());
  for (const tx of txs) {
    // each one checked on its own first, as any other transaction from Bags
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) throw new Error(`a transaction in Bags' bundle would fail: ${JSON.stringify(sim.value.err)}`);
  }
  if (tipLamports > maxSpendLamports) throw new Error('the Jito tip for Bags\' bundle is more than this launch should cost');
  const signed = [tip, ...txs].map((tx) => { tx.sign([signer]); return bs58.encode(tx.serialize()); });
  onStatus && onStatus(`sending Bags' bundle (${txs.length} transactions, ${(tipLamports / 1e9).toFixed(4)} SOL tip)…`);
  const bundleId = await bagsApi(apiKey, 'POST', '/solana/send-bundle', { json: { transactions: signed, region: 'mainnet' }, fetchImpl });
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const st = await bagsApi(apiKey, 'POST', '/solana/get-bundle-statuses', { json: { bundleIds: [bundleId], region: 'mainnet' }, fetchImpl }).catch(() => null);
    const s = st?.value?.[0];
    if (s && (s.confirmation_status === 'confirmed' || s.confirmation_status === 'finalized')) {
      if (s.err && s.err.Ok === undefined) throw new Error('Bags\' bundle landed with an error');
      return bundleId;
    }
  }
  throw new Error('Bags\' bundle did not confirm in time; check the wallet before launching again');
}

// --- the launch -----------------------------------------------------------------

/// Everything a launch needs, checked without touching Bags: field limits, the
/// fee mode against the quote, the payout handle, the split.
export function checkBagsLaunch({ name, symbol, description, mode, quote, payout, partner, admin }) {
  const bytes = (s) => new TextEncoder().encode(s || '').length;
  if (!name) throw new Error('the coin needs a name');
  if ([...name].length > BAGS_NAME_MAX) throw new Error(`Bags names are at most ${BAGS_NAME_MAX} characters`);
  if (bytes(name) > 32) throw new Error(`the name is ${bytes(name)} bytes and the coin's metadata holds 32`);
  if (!symbol || [...symbol].length > BAGS_SYMBOL_MAX) throw new Error(`Bags tickers are 1–${BAGS_SYMBOL_MAX} characters`);
  if ((description || '').length > BAGS_DESCRIPTION_MAX) throw new Error(`Bags descriptions are at most ${BAGS_DESCRIPTION_MAX} characters`);
  const m = bagsFeeMode(mode);
  if (!m) throw new Error('pick one of Bags\' fee modes');
  if (quote) {
    if (m.solOnly) throw new Error(`"${m.label}" is only offered for SOL pairs`);
    if (!quote.configs.some((c) => c.id === m.id)) {
      throw new Error(`Bags has not set up "${m.label}" for ${quote.symbol || 'that quote'}; it offers ${quote.configs.map((c) => bagsFeeMode(c.id)?.label || c.id).join(', ')}`);
    }
    if (!quote.available) throw new Error(`${quote.symbol || 'that quote'} is not launchable on Bags right now${quote.reason ? ` (${quote.reason})` : ''}`);
    if (payout) throw new Error('cash payouts are only for SOL-paired coins');
  }
  if (payout) {
    const rule = BAGS_PAYOUT_METHODS[payout.method];
    if (!rule) throw new Error('pick X Money, Cash App or Venmo for the payout');
    if (!rule.rule.test(payout.username || '')) throw new Error(`"${payout.username}" is not a valid ${rule.label} handle: ${rule.hint}`);
  }
  if (partner && !isWallet(partner)) throw new Error('the partner is not a valid Solana wallet');
  if (admin && !isWallet(admin)) throw new Error('the fee-share manager is not a valid Solana wallet');
  if (admin && admin === BAGS_PAYOUT_WALLET) throw new Error('the Bags payout wallet cannot be the fee-share manager');
  return m;
}

/// Launch on Bags. `resume` carries the mint (and config) of a launch that was
/// interrupted after Bags made its token info, so it is finished rather than a
/// second coin being made - the docs are explicit that metadata must not be
/// created twice for one launch.
export async function launchBags(opts) {
  const {
    apiKey, rpcUrl, secretKey, name, symbol, description, image, imageUrl, twitter, website, telegram,
    mode = BAGS_DEFAULT_MODE, quote = null, devBuy = '0', claimers = [], payout = null, admin = null, partner = null,
    resume = null, onProgress, onStatus, fetchImpl, dryRun = false,
  } = opts;
  if (!apiKey) throw new Error('add a Bags API key first (or get one with your wallet)');
  const say = (m) => onStatus && onStatus(m);
  const feeMode = checkBagsLaunch({ name, symbol, description, mode, quote, payout, partner, admin });
  const connection = new Connection(rpcUrl, 'confirmed');
  const signer = keypairOf(secretKey);
  const wallet = signer.publicKey.toBase58();

  // the split
  let split;
  if (payout) {
    split = { claimersArray: [BAGS_PAYOUT_WALLET], basisPointsArray: [10000] };
  } else {
    const resolved = await resolveBagsClaimers(apiKey, claimers, { fetchImpl, onStatus: say });
    split = bagsSplit(wallet, resolved);
  }
  let partnerConfig = null;
  if (partner) {
    partnerConfig = bagsPartnerConfig(partner).toBase58();
    const acct = await connection.getAccountInfo(new PublicKey(partnerConfig));
    if (!acct || !acct.owner.equals(BAGS_FEE_SHARE_V2)) throw new Error(`${partner.slice(0, 8)}… has no Bags partner key (no partner config at ${partnerConfig.slice(0, 8)}…)`);
  }

  // the dev buy, in the pair's own units, and what the wallet may be charged
  const decimals = quote ? quote.decimals : 9;
  if (quote && decimals == null && Number(devBuy) > 0) throw new Error(`Bags could not read ${quote.symbol}'s decimals, so a dev buy in it cannot be sized`);
  const devRaw = toRaw(devBuy, decimals ?? 0);
  const solBal = await connection.getBalance(signer.publicKey, 'confirmed');
  const rentHeadroom = 0.1e9;
  const solNeeded = (quote ? 0 : Number(devRaw)) + 0.03e9;
  if (solBal < solNeeded) {
    throw new Error(`the launch needs about ${(solNeeded / 1e9).toFixed(3)} SOL${quote ? ' for rent and fees' : ' with the dev buy'}; the wallet holds ${(solBal / 1e9).toFixed(4)}`);
  }
  if (quote && devRaw > 0n) {
    const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
    const ata = getAssociatedTokenAddressSync(new PublicKey(quote.mint), signer.publicKey, false, new PublicKey(quote.tokenProgram));
    const held = await connection.getTokenAccountBalance(ata).then((r) => BigInt(r.value.amount)).catch(() => 0n);
    if (held < devRaw) {
      const whole = (v) => (Number(v) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: decimals });
      throw new Error(`the dev buy is ${whole(devRaw)} ${quote.symbol} and the wallet holds ${whole(held)} — Bags pays the buy in the pair token and does not swap SOL into it`);
    }
  }
  const maxSpend = (quote ? 0 : Number(devRaw)) + rentHeadroom;
  if (dryRun) return { dryRun: true, wallet, feeMode, split, partnerConfig, devRaw: devRaw.toString(), maxSpend };

  const state = { ...(resume || {}) };
  const progress = () => onProgress && onProgress({ ...state, wallet, name, symbol });

  // 1. token info: Bags uploads the image and metadata and picks the mint
  if (!state.tokenMint) {
    say('uploading the image and metadata to Bags…');
    const form = new FormData();
    if (image) form.append('image', image, 'image.' + ((image.type || 'image/png').split('/')[1] || 'png'));
    else if (imageUrl) form.append('imageUrl', imageUrl);
    else throw new Error('the coin needs an image');
    form.append('name', name);
    form.append('symbol', symbol.toUpperCase().replace(/^\$/, ''));
    form.append('description', description || name);
    const links = { telegram: bagsLink(telegram, 'https://t.me/'), twitter: bagsLink(twitter, 'https://x.com/'), website: bagsLink(website) };
    for (const [k, v] of Object.entries(links)) if (v) form.append(k, v);
    const info = await bagsApi(apiKey, 'POST', '/token-launch/create-token-info', { form, fetchImpl });
    state.tokenMint = info.tokenMint;
    state.tokenMetadata = info.tokenMetadata;
    progress();
  }
  if (new TextEncoder().encode(state.tokenMetadata).length > 200) throw new Error('Bags\' metadata URI is over the 200-byte limit');

  // 2. the fee-share config
  if (!state.configKey) {
    say(`creating the fee-share config (${feeMode.label})…`);
    const common = {
      payer: wallet, baseMint: state.tokenMint, ...split, bagsConfigType: feeMode.id,
      ...(partner ? { partner, partnerConfig } : {}), ...(admin ? { admin } : {}),
    };
    if (!quote) {
      if (split.claimersArray.length > BAGS_CLAIMERS_WITHOUT_LUT && !state.lookupTable) {
        state.lookupTable = await claimersLookupTable(connection, signer, split.claimersArray, { onStatus: say });
        progress();
      }
      const r = await bagsApi(apiKey, 'POST', '/fee-share/config', {
        json: { ...common, ...(state.lookupTable ? { additionalLookupTables: [state.lookupTable] } : {}), ...(payout ? { payoutCashout: payout } : {}) },
        fetchImpl,
      });
      if (r.needsCreation) {
        for (const bundle of r.bundles || []) await sendBagsBundle(apiKey, connection, signer, bundle, { maxSpendLamports: maxSpend, fetchImpl, onStatus: say });
        for (const t of r.transactions || []) {
          const tx = VersionedTransaction.deserialize(bs58.decode(t.transaction));
          await signAndSend(connection, tx, signer, { maxSpendLamports: maxSpend, lifetime: t.blockhash, label: 'the fee-share config', onStatus: say });
        }
      }
      state.configKey = r.meteoraConfigKey;
    } else {
      await runPlan(connection, signer, async (tables) => {
        const r = await bagsApi(apiKey, 'POST', '/fee-share/config/v2', {
          json: {
            ...common, flow: 'dbc', quoteMint: quote.mint, quoteTokenProgram: quote.tokenProgram, transactionFormat: 'v0',
            ...(tables.length ? { additionalLookupTables: tables } : {}),
          },
          fetchImpl,
        });
        state.feeShareConfig = r.feeShareConfig;
        state.configKey = r.meteoraConfigKey;
        return r.needsCreation ? r.plan : null;
      }, { maxSpendLamports: maxSpend, onStatus: say });
    }
    if (!state.configKey) throw new Error('Bags did not return a config key');
    progress();
  }

  // 3. the launch itself
  say('building the launch with Bags…');
  let sigs;
  if (!quote) {
    const b58 = await bagsApi(apiKey, 'POST', '/token-launch/create-launch-transaction', {
      json: { ipfs: state.tokenMetadata, tokenMint: state.tokenMint, wallet, initialBuyLamports: Number(devRaw), configKey: state.configKey },
      fetchImpl,
    });
    const tx = VersionedTransaction.deserialize(bs58.decode(b58));
    sigs = [await signAndSend(connection, tx, signer, { maxSpendLamports: maxSpend, label: 'the launch', onStatus: say })];
  } else {
    ({ sigs } = await runPlan(connection, signer, (tables) => bagsApi(apiKey, 'POST', '/token-launch/create-transaction/v2', {
      json: {
        tokenMint: state.tokenMint, wallet, feeShareConfig: state.feeShareConfig, configKey: state.configKey,
        quoteMint: quote.mint, quoteTokenProgram: quote.tokenProgram, ipfs: state.tokenMetadata,
        initialBuyQuoteRaw: devRaw.toString(), transactionFormat: 'v0', ...(tables.length ? { additionalLookupTables: tables } : {}),
      },
      fetchImpl,
    }), { maxSpendLamports: maxSpend, onStatus: say }));
  }
  state.launched = true;
  progress();
  return { mint: state.tokenMint, configKey: state.configKey, feeShareConfig: state.feeShareConfig || null, sigs, url: bagsCoinUrl(state.tokenMint), feeMode, split };
}

/// Bags wants every social as a full URL; a bare @handle or domain is made into
/// one, and anything that cannot be a link is left out rather than refused.
export function bagsLink(value, base) {
  const v = String(value || '').trim();
  if (!v) return undefined;
  const handle = /^@?[A-Za-z0-9_]{1,64}$/;
  const candidate = /^https?:\/\//i.test(v) ? v : base && handle.test(v) ? base + v.replace(/^@/, '') : 'https://' + v.replace(/^\/+/, '');
  try { return new URL(candidate).toString(); } catch { return undefined; }
}

function toRaw(ui, decimals) {
  const s = String(ui ?? '0').trim().replace(/,/g, '') || '0';
  if (!/^\d*\.?\d*$/.test(s)) throw new Error(`"${ui}" is not an amount`);
  const [w, f = ''] = s.split('.');
  return BigInt((w || '0') + f.padEnd(decimals, '0').slice(0, decimals));
}
