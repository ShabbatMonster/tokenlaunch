// Jupiter Studio (studio.jup.ag) - launch and claim through Studio's own API.
//
// Studio is a Meteora DBC launchpad: Jupiter's backend builds the config and
// the pool, co-signs with the mint it generated, and we add the creator's
// signature. Recovered from studio.jup.ag's own bundle; the site calls
// https://studio-api.jup.ag straight from the browser and that API answers any
// origin, so this does the same - no key, no proxy.
//
//   launch   sign "<ms>:<uuid>" with the wallet (proves the wallet is yours)
//            -> POST /dbc-pool/create-tx  { curve by market cap, vesting, fees }
//            <- a versioned tx, already signed by Jupiter
//            -> sign it, POST /dbc-pool/submit (multipart: tx, owner, image)
//
//   claim    POST /dbc/fee/create-tx           trading fees on the curve
//            POST /damm/v2/fee/create-tx       trading fees after graduation
//            POST /vesting/create-claim        your allocation, once migrated
//            POST /damm/v2/claim/create-tx     graduated LP, once unlocked
//            each returns a tx to sign; POST /submit-tx sends it
//
// "Claimable after migration" is a DBC locked-vesting allocation: N% of the
// fixed 1B supply is held back from the curve and paid to the creator through
// a Jupiter Lock escrow that opens at migration. Studio allows 0-80%. With no
// vesting schedule the whole amount is a cliff at migration - "40% at
// migration" is exactly that, 400M tokens claimable the moment it graduates.

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';

export const STUDIO_API = 'https://studio-api.jup.ag';

/// The quotes Studio accepts.
export const STUDIO_QUOTES = {
  USDC: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' },
  SOL: { address: 'So11111111111111111111111111111111111111112', decimals: 9, symbol: 'SOL' },
  JUP: { address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6, symbol: 'JUP' },
};

/// Studio's own presets ("Meme" is LOW).
export const STUDIO_SUPPLY = 1_000_000_000;
export const STUDIO_MAX_CLAIMABLE_PCT = 80;

const toBytes = (s) => new TextEncoder().encode(s);
const b64 = (u8) => (typeof Buffer !== 'undefined' ? Buffer.from(u8).toString('base64') : btoa(String.fromCharCode(...u8)));
const fromB64 = (s) => (typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(s, 'base64')) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

const keypairOf = (secret) => (secret instanceof Keypair ? secret : Keypair.fromSecretKey(bs58.decode(secret)));

async function api(path, { json, body, method } = {}) {
  const r = await fetch(STUDIO_API + path, {
    method: method || (json || body ? 'POST' : 'GET'),
    ...(json ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) } : {}),
    ...(body ? { body } : {}),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) {
    const why = data?.error?.message || data?.error || data?.message || text.slice(0, 200);
    throw new Error(`Jupiter Studio ${path.split('?')[0]}: ${typeof why === 'string' ? why : JSON.stringify(why)}`);
  }
  return data ?? text;
}

/// Studio's vesting maths, as its form does it.
///   pct          share of the 1B supply claimable after migration, 0-80
///   months       vesting schedule: 0 (all at once), 6 or 12
///   cliffMonths  0, 6 or 12 - and no longer than the schedule
///   frequency    'daily' or 'monthly' unlocks after the cliff
/// With months 0 everything is a cliff at migration.
export function studioVesting({ pct = 0, months = 0, cliffMonths = 0, frequency = 'daily' } = {}) {
  pct = Number(pct) || 0;
  if (pct < 0 || pct > STUDIO_MAX_CLAIMABLE_PCT) throw new Error(`claimable after migration must be 0-${STUDIO_MAX_CLAIMABLE_PCT}% of supply`);
  if (![0, 6, 12].includes(months) || ![0, 6, 12].includes(cliffMonths)) throw new Error('vesting and cliff are 0, 6 or 12 months');
  if (cliffMonths > months) throw new Error('the cliff cannot be longer than the vesting schedule');
  if (pct === 0) {
    return { numberOfVestingPeriod: 0, totalVestingDuration: 0, totalLockedVestingAmount: 0, cliffUnlockAmount: 0, cliffDurationFromMigrationTime: 0 };
  }
  const days = (m) => (m === 6 ? 183 : m === 12 ? 365 : 0);
  const secs = (m) => days(m) * 24 * 3600;
  const total = (STUDIO_SUPPLY * pct) / 100;
  // the share that unlocks at the cliff: all of it when there is no schedule
  // or the cliff is the whole schedule, none when vesting starts at migration,
  // half when the cliff falls midway
  const cliffShare = months === 0 || cliffMonths === months ? 100 : cliffMonths === 0 ? 0 : 50;
  const same = months === cliffMonths;
  return {
    numberOfVestingPeriod: same ? 0 : frequency === 'monthly' ? months - cliffMonths : days(months - cliffMonths),
    totalVestingDuration: same ? 0 : secs(months - cliffMonths),
    totalLockedVestingAmount: total,
    cliffUnlockAmount: (total * cliffShare) / 100,
    cliffDurationFromMigrationTime: secs(cliffMonths),
  };
}

/// The create-tx request Studio's form sends. A wallet signature over
/// "<ms>:<uuid>" goes with it; nothing is sent here.
export function studioCreateRequest(secret, {
  name, symbol, imageContentType = 'image/png', quote = 'USDC',
  initialMarketCap, migrationMarketCap, antiSniping = false,
  feeBps = 100, antiSnipingDuration, antiSnipingType = 'linear',
  website, twitter, telegram, vesting = {},
}) {
  const kp = keypairOf(secret);
  const q = typeof quote === 'string' ? STUDIO_QUOTES[quote] : quote;
  if (!q) throw new Error('Studio pairs with USDC, SOL or JUP');
  if (!name || !symbol) throw new Error('name and ticker are required');
  if (name.length > 32) throw new Error('Studio caps the name at 32 characters');
  if (symbol.length > 10) throw new Error('Studio caps the ticker at 10 characters');
  if (![100, 200].includes(Number(feeBps))) throw new Error('Studio trading fee is 1% or 2%');
  if (!(initialMarketCap > 0) || !(migrationMarketCap > initialMarketCap)) throw new Error('graduation market cap must be above the starting one');
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const message = `${timestamp}:${nonce}`;
  const signature = b64(ed25519.sign(toBytes(message), kp.secretKey.slice(0, 32)));
  const wallet = kp.publicKey.toBase58();
  return {
    buildCurveByMarketCapParam: {
      initialMarketCap: Number(initialMarketCap),
      migrationMarketCap: Number(migrationMarketCap),
      tokenQuoteDecimal: q.decimals,
      quoteMint: q.address,
      lockedVestingParam: studioVesting(vesting),
    },
    tokenName: name, tokenSymbol: symbol,
    antiSniping: !!antiSniping,
    creator: wallet,
    tokenImageContentType: imageContentType,
    website: website || undefined, twitter: twitter || undefined, telegram: telegram || undefined,
    fee: { feeBps: Number(feeBps), totalDuration: antiSniping ? antiSnipingDuration : undefined, baseFeeMode: antiSnipingType },
    wallet, message, signature, timestamp, nonce, type: 'msg',
  };
}

/// Ask Studio for the launch transaction (signed by Jupiter, not yet by you).
export async function studioCreateTx(secret, opts) {
  const req = studioCreateRequest(secret, opts);
  const res = await api('/dbc-pool/create-tx', { json: req });
  if (!res?.transaction) throw new Error('Jupiter Studio returned no transaction');
  return { request: req, transaction: res.transaction, raw: res };
}

const signB64 = (secret, txB64) => {
  const tx = VersionedTransaction.deserialize(fromB64(txB64));
  tx.sign([keypairOf(secret)]);       // adds ours, keeps Jupiter's
  return { tx, b64: b64(tx.serialize()) };
};

/// Launch on Jupiter Studio. `image` is a Blob/File (the logo); returns the mint.
///   simulateWith: a Connection - simulate the signed launch and stop
export async function launchStudio(secret, opts, { image, description, onStatus, simulateWith } = {}) {
  const say = (m) => onStatus?.(m);
  say('asking Jupiter Studio to build the launch…');
  const { transaction, request } = await studioCreateTx(secret, { ...opts, imageContentType: image?.type || opts.imageContentType || 'image/png' });
  const { tx, b64: signed } = signB64(secret, transaction);
  if (simulateWith) {
    const sim = await simulateWith.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    return { dryRun: true, request, tx, err: sim.value.err, logs: sim.value.logs || [] };
  }
  if (!image) throw new Error('Studio needs a logo image');
  say('submitting to Jupiter Studio…');
  const form = new FormData();
  form.append('headerImage', image);
  if (description) form.append('content', description);
  form.append('transaction', signed);
  form.append('owner', keypairOf(secret).publicKey.toBase58());
  const res = await api('/dbc-pool/submit', { body: form });
  const mint = res?.data?.mint || res?.mint;
  if (!mint) throw new Error('Jupiter Studio accepted the launch but returned no mint: ' + JSON.stringify(res).slice(0, 200));
  return { mint, request };
}

// --- claiming ------------------------------------------------------------------

/// Everything claimable on a Studio coin, for its creator.
export async function studioClaimables(mint, wallet) {
  const addrs = (await api(`/dbc-pool/addresses/${mint}`))?.data || {};
  const [dbcFee, dammFee, state, escrow, lockedLp, info] = await Promise.all([
    addrs.dbcPoolAddress ? api('/dbc/fee', { json: { poolAddress: addrs.dbcPoolAddress } }).catch(() => null) : null,
    addrs.dammv2PoolAddress ? api('/damm/v2/fee', { json: { poolAddress: addrs.dammv2PoolAddress, mintAddress: mint, ownerWallet: wallet } }).catch(() => null) : null,
    addrs.dbcPoolAddress ? api(`/dbc-pool/state/${addrs.dbcPoolAddress}`).catch(() => null) : null,
    api(`/vesting/${mint}`).catch(() => null),
    api(`/tokens/${mint}/locked-lp`).catch(() => null),
    api(`/tokens/${mint}/info`).catch(() => null),
  ]);
  const owner = info?.data?.owner || null;
  // the allocation: what has unlocked so far, minus what was taken
  let vesting = null;
  const e = escrow?.escrow;
  if (e?.account) {
    const a = e.account;
    const now = Math.floor(Date.now() / 1000);
    const cliff = Number(a.cliffTime);
    let unlocked = 0n;
    if (now >= cliff) {
      const periods = BigInt(Math.min(Math.floor((now - cliff) / Math.max(1, Number(a.frequency))), Number(a.numberOfPeriod)));
      unlocked = BigInt(a.cliffUnlockAmount) + BigInt(a.amountPerPeriod) * periods;
    }
    const total = BigInt(a.cliffUnlockAmount) + BigInt(a.amountPerPeriod) * BigInt(a.numberOfPeriod);
    const claimed = BigInt(a.totalClaimedAmount);
    vesting = {
      escrow: e.publicKey, recipient: a.recipient, total: total.toString(), claimed: claimed.toString(),
      claimable: (unlocked > claimed ? unlocked - claimed : 0n).toString(), cliffTime: cliff,
      mine: a.recipient === wallet,
    };
  }
  return {
    mint, ...addrs,
    owner, mine: owner === wallet,
    graduated: !!state?.hasGraduated,
    progress: state?.poolCurveProgress ?? null,
    dbcFee: dbcFee ? { unclaimed: dbcFee.unclaimed, total: dbcFee.total } : null,
    dammFee: dammFee?.unclaimed != null ? { unclaimed: dammFee.unclaimed, total: dammFee.total, quoteMint: dammFee.quoteMint } : null,
    vesting,
    lockedLp,
  };
}

/// Coins this wallet launched on Studio.
export async function studioCreatorTokens(wallet) {
  const r = await api(`/tokens?wallet=${wallet}`);
  return (r?.tokens || []).map((t) => t.mint);
}

async function signAndSubmit(secret, txB64, connection) {
  const { tx, b64: signed } = signB64(secret, txB64);
  // ask the chain first: a claim that is not open yet (LP before its unlock,
  // an allocation before migration) fails here with the program's reason
  // instead of as a paid, failed transaction
  if (connection) {
    if (typeof connection === 'string') connection = new Connection(connection, 'confirmed');
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) {
      const why = (sim.value.logs || []).find((l) => /Error Message|Error:|failed/i.test(l)) || JSON.stringify(sim.value.err);
      throw new Error('this claim would fail: ' + why.replace(/^Program log: /, ''));
    }
  }
  const r = await api('/submit-tx', { json: { transaction: signed } });
  return r?.data?.txSig || r?.txSig || r?.data || r;
}

/// Claim one kind of reward: 'dbc-fees' | 'damm-fees' | 'allocation' | 'lp'.
/// With a connection, the claim is simulated before it is sent.
export async function studioClaim(secret, kind, c, connection = null) {
  const ownerWallet = keypairOf(secret).publicKey.toBase58();
  let res;
  if (kind === 'dbc-fees') res = await api('/dbc/fee/create-tx', { json: { ownerWallet, poolAddress: c.dbcPoolAddress, maxQuoteAmount: Number(c.dbcFee.unclaimed) } });
  else if (kind === 'damm-fees') res = await api('/damm/v2/fee/create-tx', { json: { ownerWallet, poolAddress: c.dammv2PoolAddress, mintAddress: c.mint } });
  else if (kind === 'allocation') res = await api('/vesting/create-claim', { json: { ownerWallet, escrowAddress: c.vesting.escrow } });
  else if (kind === 'lp') res = await api('/damm/v2/claim/create-tx', { json: { ownerWallet, poolAddress: c.dammv2PoolAddress, mintAddress: c.mint } });
  else throw new Error('unknown claim ' + kind);
  const tx = res?.transaction || res?.data?.transaction;
  if (!tx) throw new Error('Jupiter Studio returned no claim transaction');
  return signAndSubmit(secret, tx, connection);
}

/// What a launch would raise before graduating, from Studio's own curve maths.
/// Studio refuses a curve that raises less than about 15,000 USDC (or the SOL
/// or JUP equivalent), and holding supply back for yourself lowers the raise.
export async function studioRaise({ quote = 'USDC', initialMarketCap, migrationMarketCap, vesting = {} }) {
  const q = typeof quote === 'string' ? STUDIO_QUOTES[quote] : quote;
  const v = studioVesting(vesting);
  const r = await api('/dbc-pool/simulate-curve', {
    json: {
      initialMarketCap: Number(initialMarketCap), migrationMarketCap: Number(migrationMarketCap), tokenQuoteDecimal: q.decimals,
      lockedVestingParam: {
        totalLockedVestingAmount: v.totalLockedVestingAmount, cliffUnlockAmount: v.totalLockedVestingAmount,
        cliffDurationFromMigrationTime: 0, numberOfVestingPeriod: 12, totalVestingDuration: 365 * 86400,
      },
    },
  });
  const raw = BigInt(r.migrationQuoteThreshold);
  return { raise: Number(raw) / 10 ** q.decimals, symbol: q.symbol, config: r };
}

/// Simulate a Studio claim transaction without sending it (tests, previews).
/// `owner` is a wallet address: the claim is built for it and simulated with
/// signature checks off, so no key is needed.
export async function studioClaimDryRun(connection, owner, kind, c) {
  const ownerWallet = String(owner);
  const paths = {
    'dbc-fees': ['/dbc/fee/create-tx', { ownerWallet, poolAddress: c.dbcPoolAddress, maxQuoteAmount: Number(c.dbcFee?.unclaimed || 0) }],
    allocation: ['/vesting/create-claim', { ownerWallet, escrowAddress: c.vesting?.escrow }],
  };
  const [p, json] = paths[kind];
  const res = await api(p, { json });
  const tx = VersionedTransaction.deserialize(fromB64(res.transaction));
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  return { err: sim.value.err, logs: sim.value.logs || [], tx };
}

export { PublicKey, Connection };
