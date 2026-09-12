import {
  createPublicClient, createWalletClient, http, defineChain,
  formatEther, parseEventLogs, getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  dopplerFeeReport, collectDopplerFees, formatAmount, feePercent,
} from './dopplerFees.js';

// ---------------------------------------------------------------------------
// fee sweeper — scans EVERY token launched on our factory and claims the ones
// that have accrued trading fees. The protocol share routes to the fee
// recipient (set on the factory) automatically; claiming is permissionless, so
// the unlocked wallet only pays gas.
// ---------------------------------------------------------------------------
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const EXPLORER = 'https://robinhoodchain.blockscout.com';
// sweep every factory that routes fees to the recipient, so nothing is stranded
// on a retired contract. All are our LaunchFactory (claimFees / same events).
const FACTORIES = [
  { addr: '0x159331ec96486EC926403e504E6FCf217d6008AB', start: 8242608n }, // active (100%, plain)
  { addr: '0x5251BA272d759B5757983D928AC89B47a64b7d8e', start: 8274231n }, // retired (100% + 2% cap)
  { addr: '0xcEdA535D923dAA5c222833a917Ac2F944bF9c795', start: 8235897n }, // retired (90/10)
];
const CHAIN = defineChain({
  id: 4663, name: 'Robinhood',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const ABI = [
  { type: 'function', name: 'claimFees', inputs: [{ name: 'token', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'protocolFeeRecipient', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'protocolFeeBps', inputs: [], outputs: [{ type: 'uint16' }], stateMutability: 'view' },
  {
    type: 'event', name: 'TokenLaunched', inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'deployer', type: 'address', indexed: true },
      { name: 'dexFactory', type: 'address', indexed: true },
      { name: 'pairToken', type: 'address', indexed: false },
      { name: 'pool', type: 'address', indexed: false },
      { name: 'dexId', type: 'uint256', indexed: false },
      { name: 'launchConfigId', type: 'uint256', indexed: false },
      { name: 'positionId', type: 'uint256', indexed: false },
      { name: 'restrictionsEndBlock', type: 'uint256', indexed: false },
      { name: 'initialBuyAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'FeesClaimed', inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'devWallet', type: 'address', indexed: true },
      { name: 'wethToDev', type: 'uint256', indexed: false },
      { name: 'tokenToDev', type: 'uint256', indexed: false },
      { name: 'wethToProtocol', type: 'uint256', indexed: false },
      { name: 'tokenToProtocol', type: 'uint256', indexed: false },
    ],
  },
];
const ERC20_SYMBOL = [{ type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' }];

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const $ = (id) => document.getElementById(id);

// keys are stored in plaintext (shared with the launcher: keys.v1) — private/
// local tool, no password, no login gate
const KEYS_KEY = 'keys.v1';
const loadKeys = () => { try { return JSON.parse(localStorage.getItem(KEYS_KEY) || 'null'); } catch { return null; } };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// wallet (pays gas; fees still route to the recipient)
// ---------------------------------------------------------------------------
let account = null;
let wallet = null;

function useKey(pk) {
  account = privateKeyToAccount(pk);
  wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
  $('walletAddr').textContent = account.address.slice(0, 6) + '…' + account.address.slice(-4);
  scan();
}


// ---------------------------------------------------------------------------
// scan + claim
// ---------------------------------------------------------------------------
let recipient = '';
let claimable = [];

async function scan() {
  $('scanStatus').textContent = 'scanning factories for tokens with fees…';
  $('claimBtn').disabled = true;
  try {
    const [recip, bps] = await Promise.all([
      pub.readContract({ address: FACTORIES[0].addr, abi: ABI, functionName: 'protocolFeeRecipient' }),
      pub.readContract({ address: FACTORIES[0].addr, abi: ABI, functionName: 'protocolFeeBps' }),
    ]);
    recipient = getAddress(recip);
    $('recipient').innerHTML = `fees route to <a href="${EXPLORER}/address/${recipient}" target="_blank" rel="noopener">${recipient}</a> · protocol share <b>${bps / 100}%</b>`;

    // gather (token, factory) pairs across every factory
    const pairs = [];
    for (const f of FACTORIES) {
      const logs = await pub.getLogs({ address: f.addr, event: ABI.find((x) => x.name === 'TokenLaunched'), fromBlock: f.start, toBlock: 'latest' });
      for (const token of new Set(logs.map((l) => l.args.token.toLowerCase()))) pairs.push({ token, factory: f.addr });
    }

    // find which have claimable fees by simulating claimFees on their factory
    const results = await Promise.all(pairs.map((p) =>
      pub.simulateContract({ address: p.factory, abi: ABI, functionName: 'claimFees', args: [p.token], account: account.address })
        .then(() => p).catch(() => null),
    ));
    claimable = results.filter(Boolean);

    const box = $('list');
    if (!pairs.length) { box.innerHTML = '<div class="empty">no tokens launched yet</div>'; $('scanStatus').textContent = ''; return; }
    box.innerHTML = '';
    for (const p of claimable) {
      const sym = await pub.readContract({ address: p.token, abi: ERC20_SYMBOL, functionName: 'symbol' }).catch(() => '?');
      const row = document.createElement('div');
      row.className = 'token-row';
      row.innerHTML = `<span class="sym">${esc(sym)}</span><span class="addr"><a href="${EXPLORER}/token/${esc(p.token)}" target="_blank" rel="noopener">${esc(p.token)}</a></span><span class="ready">ready</span>`;
      box.appendChild(row);
    }
    $('scanStatus').textContent = `${pairs.length} token${pairs.length > 1 ? 's' : ''} across ${FACTORIES.length} factories · ${claimable.length} with fees to claim`;
    if (!claimable.length) box.innerHTML = '<div class="empty">nothing to claim right now (fees accrue as tokens trade)</div>';
    $('claimBtn').disabled = claimable.length === 0;
    $('claimBtn').textContent = claimable.length ? `CLAIM ALL (${claimable.length})` : 'NOTHING TO CLAIM';
  } catch (e) {
    $('scanStatus').innerHTML = `<span class="err">scan failed: ${e.shortMessage || e.message}</span>`;
  }
}

async function claimAll() {
  if (!claimable.length) return;
  $('claimBtn').disabled = true;
  const out = $('claimStatus');
  out.innerHTML = `claiming ${claimable.length}…`;
  try {
    let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const hashes = [];
    for (const p of claimable) {
      hashes.push(await wallet.writeContract({ address: p.factory, abi: ABI, functionName: 'claimFees', args: [p.token], nonce: nonce++ }));
    }
    const receipts = await Promise.all(hashes.map((h) =>
      pub.waitForTransactionReceipt({ hash: h, confirmations: 1 }).then((r) => r).catch(() => null),
    ));
    let wethProt = 0n, tokProt = 0n, ok = 0;
    for (const r of receipts) {
      if (!r || r.status !== 'success') continue;
      ok++;
      const evs = parseEventLogs({ abi: ABI, eventName: 'FeesClaimed', logs: r.logs });
      for (const ev of evs) { wethProt += ev.args.wethToProtocol; tokProt += ev.args.tokenToProtocol; }
    }
    out.innerHTML =
      `<span class="ok">SWEPT ${ok}/${claimable.length} ✓</span><br>` +
      `to ${recipient.slice(0, 6)}…${recipient.slice(-4)}: <b>${formatEther(wethProt)} WETH</b>` +
      (tokProt > 0n ? ` + tokens` : '');
    scan();
  } catch (e) {
    out.innerHTML = `<span class="err">${e.shortMessage || e.message}</span>`;
    $('claimBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// long.xyz / Doppler coins
//
// Separate from the sweeper above because the money moves differently: there is
// no per-creator balance sitting in a factory waiting to be pulled. The hook
// splits each fee by a matrix set at launch and pushes the buyback share
// straight out to the pool's buyback destination. So the useful action is not
// "claim mine", it is "run the split" - which anyone may do.
// ---------------------------------------------------------------------------
let dopReport = null;

function dopRow(k, v) {
  return `<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0">
    <span style="color:var(--dim)">${esc(k)}</span><span style="text-align:right">${v}</span></div>`;
}

async function dopplerInspect() {
  const addr = $('dopAddr').value.trim();
  const out = $('dopReport');
  const st = $('dopStatus');
  $('dopCollect').classList.add('hidden');
  $('dopClaimStatus').textContent = '';
  out.innerHTML = '';
  dopReport = null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) { st.innerHTML = '<span class="err">enter a token address</span>'; return; }

  st.textContent = 'reading the pool…';
  try {
    const r = await dopplerFeeReport(addr, account?.address);
    dopReport = r;
    st.textContent = '';

    if (!r.found) { out.innerHTML = `<p class="note" style="color:var(--dim)">${esc(r.reason)}</p>`; return; }

    let html = dopRow('pair', `<b>${esc(r.assetMeta.symbol)}</b> / ${esc(r.numMeta.symbol)}`);
    html += dopRow('pool fee', r.dynamicFee ? 'dynamic (hook sets it)' : `static ${feePercent(r.pool.lpFee)}%`);

    if (r.hasHook) {
      html += dopRow('fee right now', `<b>${feePercent(r.currentFee)}%</b>`);
      html += dopRow('fee schedule',
        `${feePercent(r.schedule.startFee)}% → ${feePercent(r.schedule.endFee)}% over ${r.schedule.durationSeconds}s`);
      const toStock = Number(r.distribution.assetToNumeraireBuyback) / 1e16;
      html += dopRow('fees spent buying ' + esc(r.numMeta.symbol), `${toStock}%`);
      html += dopRow('buyback goes to', r.youAreBuybackDst
        ? '<span class="ok">you</span>'
        : `<a href="${EXPLORER}/address/${r.buybackDst}" target="_blank" rel="noopener">${r.buybackDst.slice(0, 6)}…${r.buybackDst.slice(-4)}</a>`);
      if (r.collectable) {
        html += dopRow('<b>collectable now</b>',
          `<b>${formatAmount(r.collectable.asset, r.assetMeta)} ${esc(r.assetMeta.symbol)} + ${formatAmount(r.collectable.numeraire, r.numMeta)} ${esc(r.numMeta.symbol)}</b>`);
      }
      html += dopRow('waiting in the hook',
        `${formatAmount(r.pending.asset, r.assetMeta)} ${esc(r.assetMeta.symbol)} + ${formatAmount(r.pending.numeraire, r.numMeta)} ${esc(r.numMeta.symbol)}`);
      html += dopRow('Airlock owner’s cut',
        `${formatAmount(r.ownerFees.asset, r.assetMeta)} ${esc(r.assetMeta.symbol)} + ${formatAmount(r.ownerFees.numeraire, r.numMeta)} ${esc(r.numMeta.symbol)}`);
    }

    out.innerHTML = `<div style="font-size:12px;margin-top:10px">${html}</div>`;

    if (r.claimable) {
      $('dopCollect').classList.remove('hidden');
      $('dopCollect').disabled = false;
      $('dopCollect').textContent = r.youAreBuybackDst ? 'COLLECT FEES (PAID TO YOU)' : 'RUN THE FEE SPLIT';
    } else {
      out.innerHTML += `<p class="note">${esc(r.reason)}</p>`;
    }
  } catch (e) {
    st.innerHTML = `<span class="err">${esc(e.shortMessage || e.message)}</span>`;
  }
}

async function dopplerCollect() {
  if (!dopReport?.claimable) return;
  const btn = $('dopCollect');
  const out = $('dopClaimStatus');
  btn.disabled = true;
  try {
    const keys = loadKeys();
    if (!keys?.evm) throw new Error('no key loaded — import it in the launcher first');
    const res = await collectDopplerFees({
      privateKey: keys.evm, asset: dopReport.asset, onStatus: (m) => { out.textContent = m; },
    });
    const r = dopReport;
    out.innerHTML =
      `<span class="ok">COLLECTED ✓</span> ${formatAmount(res.collected.asset, r.assetMeta)} ${esc(r.assetMeta.symbol)}`
      + ` + ${formatAmount(res.collected.numeraire, r.numMeta)} ${esc(r.numMeta.symbol)}<br>`
      + `split sent to ${res.buybackDst.slice(0, 6)}…${res.buybackDst.slice(-4)}`
      + (r.youAreBuybackDst ? ' <span class="ok">(you)</span>' : '') + '<br>'
      + `<a href="${EXPLORER}/tx/${res.hash}" target="_blank" rel="noopener">tx on explorer</a>`;
    dopplerInspect();
  } catch (e) {
    out.innerHTML = `<span class="err">${esc(e.shortMessage || e.message)}</span>`;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function start() {
  $('appRoot').style.display = '';
  $('dopInspect').onclick = dopplerInspect;
  $('dopCollect').onclick = dopplerCollect;
  $('dopAddr').addEventListener('keydown', (e) => { if (e.key === 'Enter') dopplerInspect(); });
  const keys = loadKeys();
  if (!keys?.evm) { $('noVault').classList.remove('hidden'); return; }
  $('claimBtn').onclick = claimAll;
  $('rescan').onclick = scan;
  try { useKey(keys.evm); } catch { $('noVault').classList.remove('hidden'); }
}

start();
