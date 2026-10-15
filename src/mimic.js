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
// What it cannot do is mine a vanity address: a factory that only accepts
// addresses ending 0000 or 7777 (Hooke, flap) needs the CREATE2 inputs, which
// the calldata alone does not reveal. Those keep their dedicated pads; here the
// simulation reports the factory's refusal.

import {
  createPublicClient, http, defineChain, parseAbi, parseAbiItem, decodeFunctionData, encodeFunctionData,
  getAddress, keccak256, toBytes, isAddress, isHex, formatEther, formatUnits,
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
  const vanity = ref && /(0000|7777|4444|8888|ffff|1111|aaaa)$/i.test(ref);
  return {
    txHash, factory: getAddress(tx.to), from: getAddress(tx.from), value: tx.value, input: tx.input,
    selector: tx.input.slice(0, 10), signature: recovered?.signature ?? null, item: recovered?.item ?? null,
    params, pulled, token: ref, name, symbol, minted, blockTime: block.timestamp,
    warnings: [
      ...(recovered ? [] : ['the function could not be recovered from any signature directory - only the raw calldata can be repeated']),
      ...(vanity ? [`the reference token's address ends in ${ref.slice(-4)}: this factory may require a mined vanity address, which Mimic cannot produce - if the simulation reverts, use the factory's dedicated pad`] : []),
    ],
  };
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
/// amount argument that matched a pulled amount sets the new amount.
export function approvalsFor(template, edits = {}) {
  return template.pulled.map((t) => {
    const p = template.params.find((x) => x.role === 'pay-amount' && x.pays === t.token);
    const edited = p && edits[p.path.join('.')];
    return { ...t, amount: edited ? BigInt(edited) : t.amount, spender: template.factory };
  });
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
