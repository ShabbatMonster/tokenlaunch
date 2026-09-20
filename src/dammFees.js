import {
  Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram,
  Keypair, sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Post-migration fees: Meteora DAMM v2.
//
// When a bonding curve graduates, its liquidity leaves the curve entirely and
// becomes a position in DAMM v2, a different program. The DBC partner and
// creator buckets are empty from that moment on - correctly - so a launcher
// that only reads those reports nothing while the fees pile up somewhere else.
//
// Two things make these positions easy to miss:
//
//   - the position is owned by an NFT, not by an address, and the NFTs are
//     Token-2022. Scanning only the classic token program finds nothing.
//   - Position.fee_a_pending / fee_b_pending are checkpoints, not balances.
//     They read zero on positions holding real fees, so the only honest way to
//     learn what is claimable is to simulate the claim and see what moves.
//
// Layout offsets below were read off live accounts rather than computed: the
// Pool struct starts with a nested fee config whose size is not obvious, and
// guessing it puts every later field in the wrong place.
// ---------------------------------------------------------------------------

export const DAMM_V2_PROGRAM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM = new PublicKey('11111111111111111111111111111111');

const CLAIM_POSITION_FEE = Buffer.from('b4269a118521a2d3', 'hex');

// Position: verified against five live positions
const POS_POOL = 8;
const POS_NFT_MINT = 40;
const POS_FEE_A_PENDING = 136;
const POS_FEE_B_PENDING = 144;
const POS_PERMANENT_LOCKED = 184;

// Pool: found by searching live accounts for the known mint and vault keys
const POOL_TOKEN_A_MINT = 168;
const POOL_TOKEN_B_MINT = 200;
const POOL_TOKEN_A_VAULT = 232;
const POOL_TOKEN_B_VAULT = 264;

export const POOL_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('pool_authority')], DAMM_V2_PROGRAM)[0];
const EVENT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')], DAMM_V2_PROGRAM)[0];

const pk = (data, off) => new PublicKey(data.subarray(off, off + 32));
const key = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

const ataFor = (mint, owner, program) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/// Create an associated token account only if it is missing. One position here
/// failed to claim purely because its token A account did not exist yet.
function createAtaIdempotentIx(payer, owner, mint, program) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.from([1]),   // CreateIdempotent
    keys: [
      key(payer, true, true), key(ataFor(mint, owner, program), true), key(owner),
      key(mint), key(SYSTEM), key(program),
    ],
  });
}

async function tokenProgramOf(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error('mint not found: ' + mint.toBase58());
  return info.owner.equals(TOKEN_2022) ? TOKEN_2022 : TOKEN_PROGRAM;
}

/// Every DAMM v2 position this wallet holds, found through the position NFTs it
/// owns. Both token programs are scanned because these NFTs are Token-2022.
export async function findDammPositions({ rpcUrl, owner }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const who = new PublicKey(owner);

  const nfts = [];
  for (const program of [TOKEN_PROGRAM, TOKEN_2022]) {
    const res = await connection.getParsedTokenAccountsByOwner(who, { programId: program });
    for (const a of res.value) {
      const info = a.account.data.parsed.info;
      if (info.tokenAmount.decimals === 0 && info.tokenAmount.uiAmount === 1) {
        nfts.push({ mint: info.mint, account: a.pubkey });
      }
    }
  }

  const out = [];
  for (const nft of nfts) {
    // dataSlice keeps this cheap; asking for full account data across the
    // program times out and, caught, would look like "no positions"
    const hits = await connection.getProgramAccounts(DAMM_V2_PROGRAM, {
      filters: [{ memcmp: { offset: POS_NFT_MINT, bytes: nft.mint } }],
      dataSlice: { offset: 0, length: 0 },
    });
    if (!hits.length) continue;

    const position = hits[0].pubkey;
    const posData = (await connection.getAccountInfo(position)).data;
    const pool = pk(posData, POS_POOL);
    const poolData = (await connection.getAccountInfo(pool)).data;

    const tokenAMint = pk(poolData, POOL_TOKEN_A_MINT);
    const tokenBMint = pk(poolData, POOL_TOKEN_B_MINT);
    const [tokenAProgram, tokenBProgram] = await Promise.all([
      tokenProgramOf(connection, tokenAMint), tokenProgramOf(connection, tokenBMint),
    ]);
    const decOf = async (mint) => {
      const p = await connection.getParsedAccountInfo(mint);
      return p.value?.data?.parsed?.info?.decimals ?? null;
    };

    out.push({
      position: position.toBase58(),
      pool: pool.toBase58(),
      nftMint: nft.mint,
      nftAccount: nft.account.toBase58(),
      tokenAMint: tokenAMint.toBase58(),
      tokenBMint: tokenBMint.toBase58(),
      tokenAVault: pk(poolData, POOL_TOKEN_A_VAULT).toBase58(),
      tokenBVault: pk(poolData, POOL_TOKEN_B_VAULT).toBase58(),
      tokenAProgram: tokenAProgram.toBase58(),
      tokenBProgram: tokenBProgram.toBase58(),
      decimalsA: await decOf(tokenAMint),
      decimalsB: await decOf(tokenBMint),
      // kept only so callers can see how misleading they are
      feeAPendingCheckpoint: posData.readBigUInt64LE(POS_FEE_A_PENDING).toString(),
      feeBPendingCheckpoint: posData.readBigUInt64LE(POS_FEE_B_PENDING).toString(),
      permanentlyLocked: posData.readBigUInt64LE(POS_PERMANENT_LOCKED) > 0n,
    });
  }
  return out;
}

function buildClaimIxs(p, owner) {
  const tokenAProgram = new PublicKey(p.tokenAProgram);
  const tokenBProgram = new PublicKey(p.tokenBProgram);
  const tokenAMint = new PublicKey(p.tokenAMint);
  const tokenBMint = new PublicKey(p.tokenBMint);
  const accA = ataFor(tokenAMint, owner, tokenAProgram);
  const accB = ataFor(tokenBMint, owner, tokenBProgram);

  const claim = new TransactionInstruction({
    programId: DAMM_V2_PROGRAM,
    data: CLAIM_POSITION_FEE,
    keys: [
      key(POOL_AUTHORITY), key(new PublicKey(p.pool), true), key(new PublicKey(p.position), true),
      key(accA, true), key(accB, true),
      key(new PublicKey(p.tokenAVault), true), key(new PublicKey(p.tokenBVault), true),
      key(tokenAMint), key(tokenBMint),
      key(new PublicKey(p.nftAccount)), key(owner, false, true),
      key(tokenAProgram), key(tokenBProgram), key(EVENT_AUTHORITY), key(DAMM_V2_PROGRAM),
    ],
  });

  return {
    ixs: [
      createAtaIdempotentIx(owner, owner, tokenAMint, tokenAProgram),
      createAtaIdempotentIx(owner, owner, tokenBMint, tokenBProgram),
      claim,
    ],
    accA, accB,
  };
}

/// What this position would actually pay out, learned by simulating the claim.
/// The pending fields on the account read zero even when fees are waiting, so
/// this is the only number worth showing next to a button.
export async function previewDammClaim({ rpcUrl, owner, position }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const who = new PublicKey(owner);
  const { ixs, accA, accB } = buildClaimIxs(position, who);

  const tx = new Transaction().add(...ixs);
  tx.feePayer = who;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

  const sim = await connection.simulateTransaction(tx, undefined, [accA, accB]);
  if (sim.value.err) {
    return {
      claimableA: null, claimableB: null,
      error: JSON.stringify(sim.value.err),
      logs: sim.value.logs || [],
    };
  }
  // an SPL token account holds its amount as a u64 at offset 64
  const amountAt = (i) => {
    const d = sim.value.accounts?.[i]?.data;
    if (!d) return null;
    return Buffer.from(d[0], 'base64').readBigUInt64LE(64).toString();
  };
  return { claimableA: amountAt(0), claimableB: amountAt(1), error: null, logs: [] };
}

/// Claim one position's fees, creating either token account if it is missing.
export function keypairFrom(secret) {
  const s = String(secret).trim();
  if (s.startsWith('[')) {
    const arr = Uint8Array.from(JSON.parse(s));
    if (arr.length !== 64) throw new Error('SOL key array must be 64 bytes');
    return Keypair.fromSecretKey(arr);
  }
  return Keypair.fromSecretKey(bs58.decode(s));
}

export async function claimDammFees({ rpcUrl, secretKey, position, keypair, onStatus }) {
  const say = (m) => onStatus && onStatus(m);
  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = keypair || (secretKey ? keypairFrom(secretKey) : null);
  if (!payer) throw new Error('claimDammFees needs a key');

  say('checking what this position pays out…');
  const preview = await previewDammClaim({ rpcUrl, owner: payer.publicKey.toBase58(), position });
  if (preview.error) throw new Error('this claim would fail: ' + preview.error);
  if (preview.claimableA === '0' && preview.claimableB === '0') {
    throw new Error('nothing has accrued on this position yet');
  }

  const { ixs } = buildClaimIxs(position, payer.publicKey);
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }));
  tx.add(...ixs);

  say('claiming…');
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
  return { sig, claimedA: preview.claimableA, claimedB: preview.claimableB };
}
