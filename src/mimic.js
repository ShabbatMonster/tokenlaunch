// Mimic: launch on whatever Robinhood factory another token came from.
//
// Give it a token (or its launch transaction) and it recovers the call that
// launched it: which contract was called, which function, every argument, the
// ETH sent, and the tokens pulled. Your name, ticker, metadata, wallet and a
// fresh deadline replace the original's; everything else stays as it was and
// is editable. It is the manual process that recovered the Hooke factory from
// WOLFPACK, turned into a tool:
//
//   1. find the launch: the token's first mint (a Transfer from 0x0)
//   2. recover the function: look the selector up, and keep only a signature
//      that decodes the calldata AND re-encodes to it byte for byte - a
//      selector collision cannot pass that
//   3. mark what to substitute: strings equal to the token's name or symbol,
//      URIs, the launcher's own address, timestamps near the launch, a salt
//      that starts with the launcher's address
//   4. rebuild, approve whatever the original pulled, simulate, then send
//
// A factory that only accepts addresses ending 0000 or 7777 (Hooke, flap)
// needs a mined salt. The CREATE2 inputs are not in the calldata, so
// inferVanityRecipe works them out from the reference token - which contract
// deployed it, its init code hash (a minimal-proxy clone's is fixed; otherwise
// a view on the factory computes it), and how the calldata salt becomes the
// CREATE2 salt - and keeps a recipe only if it reproduces the reference
// address exactly. src/vanity.js then mines on the GPU (CPU fallback).

import {
  createPublicClient, http, defineChain, parseAbi, parseAbiItem, decodeFunctionData, encodeFunctionData,
  getAddress, keccak256, toBytes, isAddress, isHex, formatEther, formatUnits,
  getContractAddress, encodePacked, encodeAbiParameters, concat, toHex,
} from 'viem';

export const ROBINHOOD = defineChain({
  id: 4663, name: 'Robinhood',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
});
export const mimicPublicClient = (rpc = ROBINHOOD.rpcUrls.default.http[0]) =>
  createPublicClient({ chain: ROBINHOOD, transport: http(rpc, { retryCount: 6, retryDelay: 1500 }) });

const TRANSFER = keccak256(toBytes('Transfer(address,address,uint256)'));
const ZERO_TOPIC = '0x' + '0'.repeat(64);
const ERC20 = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. find the launch ------------------------------------------------------------
/// The transaction that first minted `token`. Walks back from the chain head in
/// windows, because the RPC caps how much one log query may return; a filter on
/// "from 0x0" keeps each window tiny.
export async function findLaunchTx(pub, token, { onProgress, maxWindows = 40 } = {}) {
  const addr = getAddress(token);
  const code = await pub.getCode({ address: addr });
  if (!code || code === '0x') throw new Error('no contract at that address on Robinhood chain');
  const head = await pub.getBlockNumber();
  const step = 2_000_000n;
  let to = head, earliest = null;
  for (let w = 0; w < maxWindows && to > 0n; w++) {
    const from = to > step ? to - step + 1n : 0n;
    onProgress?.(`scanning blocks ${from.toLocaleString()}–${to.toLocaleString()}…`);
    let logs;
    for (let t = 0; ; t++) {
      try {
        logs = await pub.request({ method: 'eth_getLogs', params: [{ address: addr, topics: [TRANSFER, ZERO_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }] });
        break;
      } catch (e) {
        if (t >= 5) throw e;
        await sleep(1500 * (t + 1));
      }
    }
    if (logs.length) earliest = logs[0];
    else if (earliest) break;          // found the mint and walked past it
    to = from - 1n;
  }
  if (!earliest) throw new Error('could not find this token\'s first mint - paste its launch transaction hash instead');
  return earliest.transactionHash;
}

// --- 2. recover the function --------------------------------------------------------
async function signaturesFor(selector) {
  const out = new Set();
  try {
    const j = await (await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=false`)).json();
    for (const s of j?.result?.function?.[selector] || []) out.add(s.name);
  } catch { /* try the other directory */ }
  try {
    const j = await (await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`)).json();
    for (const s of j?.results || []) out.add(s.text_signature);
  } catch { /* none */ }
  return [...out];
}

/// The function a calldata belongs to: the first known signature that decodes
/// it and re-encodes to exactly the same bytes.
export async function recoverFunction(input) {
  const selector = input.slice(0, 10).toLowerCase();
  for (const sig of await signaturesFor(selector)) {
    try {
      const item = parseAbiItem(`function ${sig}`);
      const { args } = decodeFunctionData({ abi: [item], data: input });
      const again = encodeFunctionData({ abi: [item], functionName: item.name, args });
      if (again.toLowerCase() === input.toLowerCase()) return { item, args, signature: sig };
    } catch { /* not this one */ }
  }
  return null;
}

// --- 3. mark what to substitute -------------------------------------------------------
// Metadata lives at content addresses; plain links are socials. Keeping them
// apart matters: a Pons v2 launch carries the creator's X link in its socials
// struct, and treating that as the metadata URI would both overwrite it with
// yours in the wrong slot and - if left alone - ship their X on your coin.
const META_RE = /^(ipfs:\/\/|ar:\/\/|data:)|\/ipfs\/|\.json(\?|$)/i;
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
const LINK_RE = /^https?:\/\//i;
const linkRole = (v) => {
  try {
    const host = new URL(v).hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'x.com' || host === 'twitter.com') return 'twitter';
    if (host === 't.me' || host === 'telegram.me') return 'telegram';
  } catch { /* not a URL */ }
  return 'website';
};

/// Every scalar argument, depth first, with where it lives and what it is for.
function flatten(inputs, values, path = [], out = []) {
  inputs.forEach((p, i) => {
    const v = Array.isArray(values) ? values[i] : values[p.name];
    const at = [...path, i];
    if (p.type === 'tuple') flatten(p.components, v, at, out);
    else if (p.type.endsWith('[]') || /\[\d+\]$/.test(p.type)) out.push({ path: at, name: p.name || `arg${i}`, type: p.type, value: v, array: true });
    else out.push({ path: at, name: p.name || `arg${i}`, type: p.type, value: v });
  });
  return out;
}

function roleOf(param, ctx) {
  const { type, value } = param;
  if (type === 'string') {
    if (ctx.name && value === ctx.name) return 'name';
    if (ctx.symbol && value === ctx.symbol) return 'symbol';
    if (META_RE.test(value) || CID_RE.test(value)) return 'uri';
    if (LINK_RE.test(value)) return linkRole(value);
    // free text - the original's description. Left alone it would ship their
    // blurb on your coin (a Pons v2 launch carries one right after the URI).
    if (value && /\s/.test(value) && value.length >= 12) return 'description';
    return null;
  }
  if (type === 'address') {
    if (value && ctx.from && value.toLowerCase() === ctx.from.toLowerCase()) return 'you';
    return null;
  }
  if (type === 'bytes32' && typeof value === 'string' && ctx.from) {
    if (value.slice(2, 42).toLowerCase() === ctx.from.slice(2).toLowerCase()) return 'salt-prefix';
    return 'bytes32';
  }
  if (/^uint/.test(type) && typeof value === 'bigint' && ctx.blockTime) {
    const days = 30n * 86400n;
    if (value > 1_000_000_000n && value < 4_000_000_000n && value > ctx.blockTime - days && value < ctx.blockTime + days) return 'deadline';
  }
  return null;
}

/// Everything needed to repeat a launch: the call, its decoded arguments with
/// their roles, the ETH sent, and the tokens it pulled from the launcher.
export async function loadTemplate(pub, txHash, { token = null } = {}) {
  const tx = await pub.getTransaction({ hash: txHash });
  const receipt = await pub.getTransactionReceipt({ hash: txHash });
  if (!tx.to) throw new Error('that token was deployed directly, not launched through a factory - there is no factory call to repeat');
  if (receipt.status !== 'success') throw new Error('that transaction reverted');
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });

  // the token(s) it minted; the one asked about, or the first new mint
  const minted = [...new Set(receipt.logs.filter((l) => l.topics[0] === TRANSFER && l.topics[1] === ZERO_TOPIC && l.topics.length === 3).map((l) => getAddress(l.address)))];
  const ref = token ? getAddress(token) : minted[0] || null;
  let name = null, symbol = null;
  if (ref) {
    [name, symbol] = await Promise.all([
      pub.readContract({ address: ref, abi: ERC20, functionName: 'name' }).catch(() => null),
      pub.readContract({ address: ref, abi: ERC20, functionName: 'symbol' }).catch(() => null),
    ]);
  }

  // tokens the launcher paid in - each needs an approval to repeat the call
  const fromTopic = '0x' + tx.from.slice(2).toLowerCase().padStart(64, '0');
  const pulled = [];
  for (const l of receipt.logs) {
    if (l.topics[0] !== TRANSFER || l.topics.length !== 3 || l.topics[1].toLowerCase() !== fromTopic) continue;
    if (ref && getAddress(l.address) === ref) continue;
    const amount = BigInt(l.data);
    const tokenAddr = getAddress(l.address);
    const [sym, dec] = await Promise.all([
      pub.readContract({ address: tokenAddr, abi: ERC20, functionName: 'symbol' }).catch(() => '?'),
      pub.readContract({ address: tokenAddr, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
    ]);
    pulled.push({ token: tokenAddr, symbol: sym, decimals: Number(dec), amount });
  }

  const recovered = await recoverFunction(tx.input);
  const ctx = { name, symbol, from: tx.from, blockTime: block.timestamp };
  const params = recovered ? flatten(recovered.item.inputs, recovered.args).map((p) => ({ ...p, role: p.array ? null : roleOf(p, ctx) })) : [];
  // an amount argument equal to what was pulled is the amount to approve
  for (const p of params) {
    if (/^uint/.test(p.type) && typeof p.value === 'bigint') {
      const hit = pulled.find((t) => t.amount === p.value);
      if (hit) { p.role = p.role || 'pay-amount'; p.pays = hit.token; }
    }
  }
  const vanity = ref && vanitySuffix(ref);
  return {
    txHash, factory: getAddress(tx.to), from: getAddress(tx.from), value: tx.value, input: tx.input,
    selector: tx.input.slice(0, 10), signature: recovered?.signature ?? null, item: recovered?.item ?? null,
    params, pulled, token: ref, name, symbol, minted, blockTime: block.timestamp, vanity: vanity || null,
    warnings: [
      ...(recovered ? [] : ['the function could not be recovered from any signature directory - only the raw calldata can be repeated']),
      ...(vanity ? [`the reference token's address ends in ${vanity}: this factory probably requires a mined vanity address`] : []),
    ],
  };
}

// --- vanity addresses -----------------------------------------------------------------
/// The vanity ending of an address, if it has one: a run of 4+ of the same
/// character, or one of the endings launchpads are known to mine for.
export function vanitySuffix(address) {
  const a = address.toLowerCase();
  const run = a.match(/([0-9a-f])\1{3,}$/);
  if (run) return run[0];
  const known = a.match(/(dead|beef|cafe|babe|face|ba5e|b00b|1337)$/);
  return known ? known[0] : null;
}

const CLONE_RE = /^0x363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3$/i;
const CLONE_INIT_PREFIX = '0x3d602d80600a3d3981f3';
const looksLikeAddress = (word) => /^0x0{24}[0-9a-f]{40}$/i.test(word) && !/^0x0{24}0{30}/i.test(word);

/// Every PUSH4 in a contract's code - its function selectors among them.
function pushedSelectors(code) {
  const b = hexToBytesLite(code), out = new Set();
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op === 0x63 && i + 4 < b.length) out.add('0x' + [...b.slice(i + 1, i + 5)].map((x) => x.toString(16).padStart(2, '0')).join(''));
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return [...out];
}
const hexToBytesLite = (h) => Uint8Array.from(h.slice(2).match(/../g) || [], (x) => parseInt(x, 16));

async function signaturesForMany(selectors) {
  const out = {};
  for (let i = 0; i < selectors.length; i += 80) {
    const chunk = selectors.slice(i, i + 80);
    try {
      const j = await (await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${chunk.join(',')}&filter=true`)).json();
      for (const [sel, list] of Object.entries(j?.result?.function || {})) if (list?.length) out[sel] = list.map((x) => x.name);
    } catch { /* this chunk stays unknown */ }
  }
  return out;
}

async function limited(tasks, n = 6) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i]().catch(() => null); }
  }));
  return out;
}

// How a calldata salt can become the CREATE2 salt. `who` is the launcher or
// the factory (whichever called the deployer); both are re-bound for your launch.
const SALT_TRANSFORMS = [
  { kind: 'raw' },
  { kind: 'keccak' },
  { kind: 'packed', who: 'from' }, { kind: 'packed', who: 'factory' },
  { kind: 'encode', who: 'from' }, { kind: 'encode', who: 'factory' },
  { kind: 'packed-rev', who: 'from' }, { kind: 'packed-rev', who: 'factory' },
  { kind: 'encode-rev', who: 'from' }, { kind: 'encode-rev', who: 'factory' },
];

/// The CREATE2 salt a calldata salt turns into, under a transform.
export function create2Salt(salt, transform, { from, factory }) {
  const who = transform.who === 'from' ? from : factory;
  switch (transform.kind) {
    case 'raw': return salt;
    case 'keccak': return keccak256(salt);
    case 'packed': return keccak256(encodePacked(['address', 'bytes32'], [who, salt]));
    case 'encode': return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [who, salt]));
    case 'packed-rev': return keccak256(encodePacked(['bytes32', 'address'], [salt, who]));
    case 'encode-rev': return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [salt, who]));
    default: throw new Error('unknown salt transform ' + transform.kind);
  }
}

// a view argument, re-bound for your launch: your name/ticker/metadata/wallet,
// or the value it had
function bindArg(src, v) {
  if (src.k === 'name') return v.name;
  if (src.k === 'symbol') return v.symbol;
  if (src.k === 'uri') return v.uri;
  if (src.k === 'from') return getAddress(v.you);
  if (src.k === 'factory') return getAddress(v.factory);
  return src.v;
}

/// Work out how this factory derives token addresses, from the reference
/// launch: the deployer, the init code hash and the salt. Returns a recipe only
/// if it reproduces the reference token's address exactly, else
/// { recipe: null, reason }.
export async function inferVanityRecipe(pub, t, { onProgress } = {}) {
  if (!t.token) return { recipe: null, reason: 'no reference token to learn from' };
  const target = getAddress(t.token);
  const say = (m) => onProgress?.(m);

  // salts: every bytes32 / uint256 argument that is not a known amount or time
  const salts = t.params
    .filter((p) => !p.array && (p.type === 'bytes32' || p.type === 'uint256') && p.value !== undefined && !['deadline', 'pay-amount'].includes(p.role))
    .map((p) => ({ path: p.path.join('.'), type: p.type, raw: p.type === 'bytes32' ? p.value : toHex(p.value, { size: 32 }), prefixed: p.role === 'salt-prefix' }));
  if (!salts.length) return { recipe: null, reason: 'the launch call has no salt argument to mine' };

  // candidate deployers: the factory, every contract that logged in the
  // launch, every address those logs mention, then whatever their zero-argument
  // getters point at
  say('finding the contract that deployed the token…');
  const receipt = await pub.getTransactionReceipt({ hash: t.txHash });
  const seen = new Set([t.factory.toLowerCase()]);
  for (const l of receipt.logs) {
    seen.add(l.address.toLowerCase());
    const words = [...l.topics.slice(1), ...((l.data || '0x').slice(2).match(/.{64}/g) || []).map((w) => '0x' + w)];
    for (const w of words) if (looksLikeAddress(w)) seen.add(('0x' + w.slice(26)).toLowerCase());
  }
  for (const p of t.params) if (p.type === 'address' && typeof p.value === 'string') seen.add(p.value.toLowerCase());
  seen.delete(target.toLowerCase());
  for (const x of t.pulled) seen.delete(x.token.toLowerCase());

  const codes = new Map();
  const loadCodes = async (addrs) => {
    const fresh = addrs.filter((a) => !codes.has(a));
    const got = await limited(fresh.map((a) => () => pub.getCode({ address: getAddress(a) })));
    fresh.forEach((a, i) => codes.set(a, got[i] && got[i] !== '0x' ? got[i] : null));
  };
  await loadCodes([...seen]);
  let contracts = [...seen].filter((a) => codes.get(a)).slice(0, 30);

  // what the candidates' functions are called
  say('reading the factory’s functions…');
  const selOf = new Map(contracts.map((a) => [a, pushedSelectors(codes.get(a))]));
  const sigs = await signaturesForMany([...new Set([...selOf.values()].flat())]);

  // zero-argument getters: addresses widen the deployer search, 32-byte values
  // that are not addresses or small numbers may be an init code hash
  const constHashes = new Set();
  const getterCalls = [];
  for (const a of contracts) for (const sel of selOf.get(a)) for (const sig of sigs[sel] || []) {
    if (sig.endsWith('()')) getterCalls.push({ a, sel, sig });
  }
  const getterOut = await limited(getterCalls.map((g) => () => pub.call({ to: getAddress(g.a), data: g.sel })));
  const more = new Set();
  getterOut.forEach((r) => {
    const d = r?.data;
    if (!d || d.length !== 66) return;
    if (looksLikeAddress(d)) more.add(('0x' + d.slice(26)).toLowerCase());
    else if (BigInt(d) > 2n ** 160n) constHashes.add(d);
  });
  more.delete(target.toLowerCase());
  await loadCodes([...more]);
  for (const a of more) if (codes.get(a) && !contracts.includes(a)) contracts.push(a);
  contracts = contracts.slice(0, 40);
  const added = contracts.filter((a) => !selOf.has(a));
  for (const a of added) selOf.set(a, pushedSelectors(codes.get(a)));
  Object.assign(sigs, await signaturesForMany([...new Set(added.flatMap((a) => selOf.get(a)))].filter((s) => !(s in sigs))));

  // init code hashes to try. A minimal-proxy clone's is fixed by its code.
  const hashes = [];      // { value, source }
  const tokenCode = await pub.getCode({ address: target });
  if (tokenCode && CLONE_RE.test(tokenCode)) hashes.push({ value: keccak256(concat([CLONE_INIT_PREFIX, tokenCode])), source: { kind: 'const', why: 'minimal-proxy clone' } });
  for (const h of constHashes) hashes.push({ value: h, source: { kind: 'const', why: 'a constant on the factory' } });

  // views that compute it from the launch's strings and addresses, e.g.
  // Hooke's initCodeHash(name, symbol, minter)
  say('asking the factory for its init code hash…');
  const strs = [{ k: 'name', v: t.name }, { k: 'symbol', v: t.symbol }, ...t.params.filter((p) => p.role === 'uri').map((p) => ({ k: 'uri', v: p.value }))].filter((x) => x.v != null);
  const addrSrc = [{ k: 'from', v: t.from }, { k: 'factory', v: t.factory },
    ...contracts.filter((a) => a !== t.factory.toLowerCase()).map((a) => ({ k: 'lit', v: getAddress(a) }))];
  const hashCalls = [];
  const HASH_NAME = /init.?code|bytecode.?hash|creation.?code/i;
  for (const a of contracts) for (const sel of selOf.get(a)) for (const sig of sigs[sel] || []) {
    if (!HASH_NAME.test(sig) || sig.endsWith('()')) continue;
    let item;
    try { item = parseAbiItem(`function ${sig} view returns (bytes32)`); } catch { continue; }
    const pools = item.inputs.map((inp) => inp.type === 'string' ? strs : inp.type === 'address' ? addrSrc : null);
    if (pools.some((x) => !x)) continue;
    // every assignment of sources to arguments, capped
    let combos = [[]];
    for (const pool of pools) combos = combos.flatMap((c) => pool.filter((s) => !c.includes(s)).map((s) => [...c, s])).slice(0, 400);
    for (const c of combos) hashCalls.push({ a, item, c });
  }
  const hashOut = await limited(hashCalls.map((h) => () => pub.readContract({ address: getAddress(h.a), abi: [h.item], functionName: h.item.name, args: h.c.map((s) => s.v) })));
  hashOut.forEach((v, i) => {
    if (typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v) && !hashes.some((h) => h.value === v)) {
      const h = hashCalls[i];
      hashes.push({ value: v, source: { kind: 'view', address: getAddress(h.a), item: h.item, args: h.c.map((s) => ({ k: s.k, v: s.v })) } });
    }
  });
  if (!hashes.length) return { recipe: null, reason: 'could not find the init code hash - the factory exposes no view for it and the token is not a clone' };

  // the combination that lands exactly on the reference token
  say('matching the reference address…');
  const env = { from: t.from, factory: t.factory };
  for (const h of hashes) for (const d of contracts) for (const s of salts) for (const tr of SALT_TRANSFORMS) {
    const salt = create2Salt(s.raw, tr, env);
    if (getContractAddress({ opcode: 'CREATE2', from: getAddress(d), salt, bytecodeHash: h.value }) === target) {
      return {
        recipe: {
          deployer: getAddress(d), hash: h.source.kind === 'const' ? { kind: 'const', value: h.value, why: h.source.why } : h.source,
          referenceHash: h.value, salt: { path: s.path, type: s.type, prefixed: s.prefixed, transform: tr },
          suffix: t.vanity || vanitySuffix(target) || '',
        },
      };
    }
  }
  return { recipe: null, reason: `found ${hashes.length} init code hash candidate(s) but none reproduces ${target}` };
}

/// The init code hash for your launch: fixed, or the factory's view re-asked
/// with your name, ticker, metadata and wallet.
export async function recipeHash(pub, recipe, v) {
  if (recipe.hash.kind === 'const') return recipe.hash.value;
  const { address, item, args } = recipe.hash;
  return pub.readContract({ address, abi: [item], functionName: item.name, args: args.map((a) => bindArg(a, v)) });
}

/// Mine a salt for your launch and return the calldata value to put in the
/// salt argument, the address it lands on, and how it was mined.
///   v: { name, symbol, uri, you, factory }
export async function mineForRecipe(pub, recipe, v, { suffix = recipe.suffix, prefix = '', onProgress, signal } = {}) {
  const { mineVanity, patternFrom } = await import('./vanity.js');
  const initCodeHash = await recipeHash(pub, recipe, v);
  const env = { from: getAddress(v.you), factory: getAddress(v.factory) };
  const tr = recipe.salt.transform;
  const res = await mineVanity({
    deployer: recipe.deployer, initCodeHash, pattern: patternFrom({ suffix, prefix }),
    saltPrefix: recipe.salt.prefixed ? v.you : null,
    saltFn: tr.kind === 'raw' ? null : (s) => create2Salt(s, tr, env),
    onProgress, signal,
  });
  const taken = await pub.getCode({ address: res.address });
  if (taken && taken !== '0x') throw new Error(`mined ${res.address}, but a contract already lives there - mine again`);
  const value = recipe.salt.type === 'uint256' ? BigInt(res.salt).toString() : res.salt;
  return { ...res, initCodeHash, value };
}

// --- 4. rebuild --------------------------------------------------------------------------
function setAt(args, path, value) {
  const copy = structuredClone(args);
  let cur = copy;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
  // viem decodes tuples to objects keyed by name when components are named
  const last = path[path.length - 1];
  if (Array.isArray(cur)) cur[last] = value;
  else cur[Object.keys(cur)[last]] = value;
  return copy;
}

/// Parse an edited field back into the type the ABI expects.
export function parseParam(type, text) {
  const s = String(text).trim();
  if (type === 'bool') return /^(true|1|yes)$/i.test(s);
  if (/^u?int/.test(type)) return BigInt(s);
  if (type === 'address') { if (!isAddress(s)) throw new Error(`${s} is not an address`); return getAddress(s); }
  if (/^bytes/.test(type)) { if (!isHex(s)) throw new Error(`${s} is not hex`); return s; }
  if (type.endsWith(']')) return JSON.parse(s);
  return s;
}

/// The calldata for your launch: substitutions by role, then your edits.
///   values: { name, symbol, uri, you, deadline, twitter, website }
///   edits:  { 'path.join': text }
/// Socials are always replaced - with yours, or with '' - so the original
/// creator's links never ride along on your coin.
export function buildCalldata(template, values, edits = {}) {
  if (!template.item) {
    if (edits.rawCalldata) return edits.rawCalldata;
    throw new Error('this launch could not be decoded; paste edited calldata to send it raw');
  }
  let args = structuredClone(decodeFunctionData({ abi: [template.item], data: template.input }).args);
  for (const p of template.params) {
    const key = p.path.join('.');
    let v;
    if (edits[key] !== undefined && edits[key] !== '') v = parseParam(p.type, edits[key]);
    else if (p.role === 'name' && values.name) v = values.name;
    else if (p.role === 'symbol' && values.symbol) v = values.symbol;
    else if (p.role === 'uri' && values.uri) v = values.uri;
    else if (p.role === 'description' && values.description !== undefined) v = values.description;
    else if (p.role === 'twitter') v = values.twitter || '';
    else if (p.role === 'website') v = values.website || '';
    else if (p.role === 'telegram') v = values.telegram || '';
    else if (p.role === 'you' && values.you) v = getAddress(values.you);
    else if (p.role === 'deadline' && values.deadline) v = values.deadline;
    else if (p.role === 'salt-prefix' && values.you) v = ('0x' + values.you.slice(2).toLowerCase() + p.value.slice(42));
    else continue;
    args = setAt(args, p.path, v);
  }
  return encodeFunctionData({ abi: [template.item], functionName: template.item.name, args });
}

/// Approvals the rebuilt call needs, from what the original pulled; an edited
/// amount argument that matched a pulled amount sets the new amount, and an
/// amount of 0 needs no approval at all.
export function approvalsFor(template, edits = {}) {
  return template.pulled.map((t) => {
    const p = template.params.find((x) => x.role === 'pay-amount' && x.pays === t.token);
    const edited = p && edits[p.path.join('.')];
    return { ...t, amount: edited ? BigInt(edited) : t.amount, spender: template.factory };
  }).filter((a) => a.amount > 0n);
}

/// Edits that launch with no dev buy. Every pay-amount goes to 0, and with it
/// the other numbers in the same struct (mode, minimum out...) - a buy struct
/// of zeros is how factories spell "no buy" (Hooke: mode 0, amounts 0). A
/// top-level amount takes its minimum-out siblings with it. Deadlines stay.
export function noBuyEdits(template) {
  const edits = {};
  const isNum = (q) => /^u?int\d*$/.test(q.type) && q.role !== 'deadline';
  for (const p of template.params.filter((x) => x.role === 'pay-amount')) {
    edits[p.path.join('.')] = '0';
    const parent = p.path.slice(0, -1).join('.');
    for (const q of template.params) {
      if (q.path.length !== p.path.length || q.path.slice(0, -1).join('.') !== parent || !isNum(q)) continue;
      if (p.path.length > 1 || /min|out|slippage/i.test(q.name)) edits[q.path.join('.')] = '0';
    }
  }
  return edits;
}

/// Simulate the launch as `account`. Returns the raw return data, or throws
/// with the revert reason decoded where any directory knows it.
export async function simulateLaunch(pub, { account, to, data, value }) {
  try {
    const r = await pub.call({ account, to, data, value });
    return r.data ?? '0x';
  } catch (e) {
    const raw = e?.cause?.data ?? e?.data ?? (String(e?.message || '').match(/0x[0-9a-f]{8,}/i) || [])[0];
    let reason = e?.shortMessage || e?.message || String(e);
    if (typeof raw === 'string' && raw.length >= 10) {
      const sel = raw.slice(0, 10);
      try {
        const j = await (await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${sel}&filter=true`)).json();
        const nm = j?.result?.function?.[sel]?.[0]?.name;
        if (nm) reason = `${nm} (${sel})`;
      } catch { /* keep the raw reason */ }
    }
    throw new Error('the factory would reject this launch: ' + reason);
  }
}

/// Plain-language view of an argument for the editor.
export function describeValue(p) {
  if (typeof p.value === 'bigint') return p.value.toString();
  if (p.array) return JSON.stringify(p.value, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return String(p.value);
}

export const fmtEth = (wei) => formatEther(wei);
export const fmtUnits = formatUnits;
export { ERC20 as MIMIC_ERC20 };
