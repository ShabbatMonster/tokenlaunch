// Abyss / Black Market launches on Robinhood Chain, driven by the project's own
// SDK. Every live case plans the launch and then eth_calls the transaction the
// SDK builds, so a pass means the launch would actually execute.
//
// The three rules that cause almost every rejection are each covered:
//   * fee rows unique + ascending, summing to 10000bps per asset
//   * rewardMode must agree with whether any row pays holders
//   * no interior tick gaps, ticks aligned to the tier's spacing
// Plus the one that is easy to miss: the launched token has to sort ABOVE the
// pair token or the one-sided ladder is upside down (TOPOLOGY_OPENING_GAP).
//   node test/js/abyss-launch.test.mjs
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib';
import { createProtocolPublicClient, getAddresses } from '@black-market/sdk';
import {
  abyssPlan, abyssPlanDraft, abyssGeometry, abyssQuotes, abyssTier, abyssAddresses, resolveAbyssQuote,
  ABYSS_FEE_TIER_LIST, ABYSS_PROFILES, ABYSS_PRESETS, ABYSS_CHAIN_ID, ABYSS_MAX_ERC404_SUPPLY,
  abyssApiBase, abyssMetadata, abyssStageMetadata, abyssImageDescriptor,
  LifecycleRewardMode, LifecycleTokenKind,
} from '../../src/abyssLaunch.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const ROOT = path.join(import.meta.dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
const RPC = process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const E = 10n ** 18n;

// a real PNG of a given size, so the API's image verification has something to
// verify (it rejects anything it cannot decode)
function testPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) { raw[o++] = (x * 2) & 255; raw[o++] = (y * 2) & 255; raw[o++] = 128; raw[o++] = 255; }
  }
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// --- wiring -------------------------------------------------------------------
check(ABYSS_CHAIN_ID === 4663, 'the pad is on Robinhood Chain');
check(abyssAddresses().launchOrchestrator.toLowerCase() === '0x91560876033d568d25cde98c78c33ff8fc43962c',
  'and points at LaunchOrchestratorV1 from the SDK, not a hardcoded guess');
check(ABYSS_FEE_TIER_LIST.length === 8 && ABYSS_FEE_TIER_LIST.some((t) => t.label === '0.01%') && ABYSS_FEE_TIER_LIST.some((t) => t.label === '15%'),
  'all 8 fee tiers are offered, including the ones the site does not advertise', ABYSS_FEE_TIER_LIST.map((t) => t.label).join(' '));
check(ABYSS_PROFILES.length === 4 && ABYSS_PROFILES.every((p) => typeof p.poolProfile === 'number' && typeof p.oracle === 'boolean'),
  'each pool profile carries its config byte and whether it takes an oracle');
const pad = MAIN.slice(MAIN.indexOf("id: 'abyss-robinhood'"), MAIN.indexOf("id: 'abyss-robinhood'") + 700);
check(pad.length > 100 && /family: 'abyss'/.test(pad) && /chainId: 4663/.test(pad), 'main.js has the Abyss pad');
for (const id of ['abyssQuote', 'abyssCap', 'abyssFee', 'abyssRewardMode', 'abyssShare', 'abyssBurn', 'abyssPreset', 'abyssPositions', 'abyssProfile', 'abyssKind', 'abyssDevBuy', 'abyssSummary']) {
  check(HTML.includes(`id="${id}"`), `UI has #${id}`);
}
check(/STARTING MARKET CAP \(<span id="abyssCapSym">/.test(HTML), 'the starting market cap is a field, priced in the pair token');
check(HTML.includes('id="abyssQuoteCustom"') && /'custom…'/.test(MAIN), 'and any ERC-20 can be pasted as the pair token');
check(/resolveAbyssCustomQuote/.test(MAIN) && /abyssSelectedQuote/.test(MAIN), 'a pasted pair token is resolved off chain, not assumed');
check(/for \(const pre of built\.planned\.prerequisites/.test(MAIN), 'an ERC-20 dev buy approves the funding escrow first');
check(/async function launchAbyss/.test(MAIN) && /abyssPlan\(client, \{ \.\.\.f, metadataURI: f\.nftBaseUri \}\)/.test(MAIN),
  'the launch goes through the SDK plan, and the only URI it carries is an ERC-404 base URI');
check(/abyssStageMetadata/.test(MAIN) && /abyssPublishMetadata/.test(MAIN),
  'the name, image and links are staged with Abyss before the launch and bound to it after');
check(/stageAbyssMetadata/.test(MAIN) && /never throws/.test(MAIN), 'and a metadata failure does not cost the launch');
for (const id of ['abyssTelegram', 'abyssDiscord', 'abyssNftUri']) check(HTML.includes(`id="${id}"`), `UI has #${id}`);
check(/id="abyssNftUriWrap"[^>]*class="row hidden"|class="row hidden"[^>]*id="abyssNftUriWrap"/.test(HTML),
  'the NFT base URI is only shown for an ERC-404');

// --- the geometry, no RPC -------------------------------------------------------
{
  const [eth] = abyssQuotes();
  check(eth.symbol === 'ETH', 'ETH is the default pair');
  const usdg = abyssQuotes().find((q) => q.symbol === 'USDG');
  check(usdg.decimals === 6 && usdg.address === '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    'USDG is carried as 6 decimals with a valid checksum (18 would be wrong by 1e12)');
  // the opening market cap is what sets the price
  const g = (cap) => abyssGeometry({ supply: 1_000_000_000n * E, openingValuationQuote: cap, feePips: 20000, positions: 6, preset: 'staircase' });
  const a = g(10n * E), b = g(100n * E);
  // the launched token is the pool's token1, so a higher token price is a LOWER
  // tick - the direction matters when reading these numbers
  check(b.recipe.launchTick < a.recipe.launchTick, 'a higher opening market cap prices the token higher (lower tick, since it is token1)', `${a.recipe.launchTick} -> ${b.recipe.launchTick}`);
  check(a.ranges.positions.length === 6 && a.ranges.tokenAmountMaximum === 1_000_000_000n * E,
    'the whole supply goes into the ladder, nothing pre-sold', `${(Number(a.ranges.tokenAmountMaximum) / 1e18).toLocaleString()} tokens`);
  check(a.ranges.positions.every((p, i, all) => i === 0 || all[i - 1].tickLower === p.tickUpper),
    'the bands are contiguous, which is what the orchestrator demands');
  check(abyssTier(20000).tickSpacing === 400 && a.ranges.positions.every((p) => p.tickLower % 400 === 0 || p.tickLower === -887200),
    'and aligned to the fee tier\'s tick spacing');
  let threw = '';
  try { abyssTier(1234); } catch (e) { threw = e.message; }
  check(/not an Abyss fee tier/.test(threw), 'an invalid fee tier is refused with the valid list');
}

// --- the rules the orchestrator enforces, refused up front ------------------------
{
  const [eth] = abyssQuotes();
  const base = { creator: '0x7cb44b8693b3c350a2bcd4b681af85365aa27783', name: 'A', symbol: 'A', supply: 1_000_000_000n * E, quote: eth, feePips: 20000, positions: 6, preset: 'staircase', openingValuationQuote: 10n * E };
  const refuses = (o, re, label) => {
    let msg = '';
    try { abyssPlanDraft({ ...base, ...o }); } catch (e) { msg = e.message; }
    check(re.test(msg), label, msg.slice(0, 85) || 'it was ACCEPTED');
  };
  refuses({ rewardsBps: 5000 }, /reward mode set to staking or dividends/, 'a holders\' share without a reward mode is refused');
  refuses({ rewardMode: LifecycleRewardMode.Dividends }, /need a share of the fees pointed at holders/, 'dividends with no holders\' share is refused');
  refuses({ tokenKind: LifecycleTokenKind.ERC404 }, /at least 1 whole token per NFT/, 'an ERC-404 with no unit size is refused');
  refuses({ preset: 'nope' }, /not an Abyss liquidity preset/, 'an unknown liquidity preset is refused');
  refuses({ positions: 0 }, /between 1 and 16/, 'zero positions is refused');
  // the token rules the chain runs inside predictToken, before anything else:
  // every one of these comes back as a bare InvalidTokenConfiguration (0xdf450632)
  refuses({ name: '' }, /needs a name and a ticker/, 'a launch with no name is refused');
  refuses({ symbol: '' }, /needs a name and a ticker/, 'a launch with no ticker is refused');
  refuses({ supply: 0n }, /set a total supply/, 'a zero supply is refused');
  refuses({ nftUnit: E }, /only an ERC-404 launch has a tokens-per-NFT/, 'a tokens-per-NFT size on an ERC-20 is refused');
  refuses({ tokenKind: LifecycleTokenKind.ERC404, nftUnit: E }, /1,000,000,000 NFTs.*caps at 10,000/,
    'an ERC-404 whose unit size would mint over 10,000 NFTs is refused');
  refuses({ tokenKind: LifecycleTokenKind.ERC404, nftUnit: E, supply: 1_000_000_000n * E },
    /put at least 100,000 tokens in each NFT/, 'and it says what the smallest workable unit size is');
  refuses({ tokenKind: LifecycleTokenKind.ERC404, nftUnit: 2_000_000_000n * E },
    /more than the whole supply/, 'a unit size bigger than the supply is refused');
  refuses({ tokenKind: LifecycleTokenKind.ERC404, nftUnit: 100_000n * E, supply: ABYSS_MAX_ERC404_SUPPLY + 1n },
    /fit in 96 bits/, 'an ERC-404 supply over 96 bits is refused');
  // metadataURI is the ERC-404 base URI and nothing else: the chain refuses an
  // ERC-20 that carries one, so the pad never sends it on an ERC-20
  {
    const erc20 = abyssPlanDraft({ ...base, metadataURI: 'ipfs://whatever' });
    check(erc20.plan.token.metadataURI === '', 'an ERC-20 is planned with no metadata URI, whatever was passed');
    const nft = abyssPlanDraft({ ...base, tokenKind: LifecycleTokenKind.ERC404, nftUnit: 100_000n * E, metadataURI: 'ipfs://art/' });
    check(nft.plan.token.metadataURI === 'ipfs://art/', 'and an ERC-404 keeps its base URI, which is what the field is for');
  }
}

// --- the metadata API: what the coin shows on abyss.trading -----------------------
{
  check(abyssApiBase('https://abyss.trading') === 'https://api.abyss.trading',
    'on abyss.trading the metadata API is called directly');
  check(abyssApiBase('https://app.abyss.trading') === 'https://api.abyss.trading', 'and from its subdomains too');
  check(abyssApiBase('http://localhost:8080') === 'http://localhost:8080/abyss-api',
    'anywhere else it goes through the local proxy, since the API allows no other origin', abyssApiBase('http://localhost:8080'));
  check(abyssApiBase('https://shabbatmonster.github.io') === 'https://shabbatmonster.github.io/abyss-api', 'including GitHub Pages');
  const SERVE = fs.readFileSync(path.join(ROOT, 'serve.mjs'), 'utf8');
  const PROXY = fs.readFileSync(path.join(ROOT, 'abyssProxy.mjs'), 'utf8');
  check(/handleAbyssProxy/.test(SERVE) && /api\.abyss\.trading/.test(PROXY), 'and the local server has that proxy');
  check(/cloudflarestorage/.test(PROXY) && /ABYSS_UPLOAD_HOST\.test\(/.test(PROXY),
    'whose image hop only ever forwards to the API\'s own storage host');
  check(/idempotency-key/.test(PROXY) && /authorization/.test(PROXY), 'passing the headers the session flow needs');
  // the hash is signed, so the links have to be canonical URLs before signing
  const m = abyssMetadata({ name: 'Coin', symbol: 'COIN', description: ' hi ', twitter: '@coin', telegram: 't.me/coin', website: 'coin.xyz' });
  check(m.twitterUrl === 'https://x.com/coin', 'a bare @handle becomes the twitter URL the API canonicalises', m.twitterUrl);
  check(m.telegramUrl === 'https://t.me/coin' && m.websiteUrl === 'https://coin.xyz/', 'bare links are made absolute', `${m.telegramUrl} ${m.websiteUrl}`);
  check(m.description === 'hi', 'the description is trimmed exactly as the hash expects');
  check(!('discordUrl' in m), 'and an empty social is left out rather than sent as an empty string');
  const bad = abyssMetadata({ name: 'Coin', symbol: 'COIN', twitter: 'not a url at all' });
  check(!('twitterUrl' in bad), 'something that cannot be a URL is dropped instead of breaking the signature');
}

// --- live: the whole metadata session, through the real proxy ----------------------
// A throwaway key signs the attribution; the session is staged and the image is
// uploaded and verified, which is everything that happens before a launch. No
// transaction is sent, so the session simply expires.
{
  const { createServer } = await import('node:http');
  const { handleAbyssProxy } = await import('../../abyssProxy.mjs');
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
  const server = createServer(async (req, res) => {
    if (!(await handleAbyssProxy(req, res))) res.writeHead(404).end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const acct = privateKeyToAccount(generatePrivateKey());
    const staged = await abyssStageMetadata({
      wallet: acct, creator: acct.address, baseUrl: abyssApiBase(origin),
      metadata: abyssMetadata({ name: 'Abyss Wire', symbol: 'AWIRE', description: 'wiring check', twitter: '@awire', website: 'awire.xyz' }),
      image: new Blob([testPng(192)], { type: 'image/png' }),
    });
    const s = staged.session;
    check(s.status === 'ready_to_launch' && s.imageStatus === 'ready',
      'the metadata session stages through the proxy and the image is verified', `${s.status} · ${s.image?.width}x${s.image?.height}`);
    check(s.metadata.twitterUrl === 'https://x.com/awire' && s.metadata.websiteUrl === 'https://awire.xyz/',
      'and the API stores the links as the signed hash claimed they were');
    check(typeof staged.capability === 'string' && staged.capability.length > 0,
      'with the one-time capability the publish after the launch needs');
  } catch (e) {
    check(false, 'the metadata session stages through the proxy', (e.message || String(e)).slice(0, 120));
  } finally {
    server.close();
  }
  let refused = '';
  try { await abyssImageDescriptor(new Blob([testPng(64)], { type: 'image/gif' })); } catch (e) { refused = e.message; }
  check(/takes png, jpeg, webp/.test(refused), 'an image Abyss does not accept is refused by name', refused);
}

const client = createProtocolPublicClient({ chainId: ABYSS_CHAIN_ID });
if (!(await client.getBlockNumber().catch(() => null))) { console.log('SKIP  Robinhood RPC unreachable'); process.exit(fails.length ? 1 : 0); }

// --- live: plan it, then prove the built transaction executes ----------------------
const CREATOR = '0x7cb44b8693b3c350a2bcd4b681af85365aa27783';   // funded on RH chain; read-only
const [ETHQ, USDGQ] = abyssQuotes();
const base = { creator: CREATOR, name: 'Abyss Wire', symbol: 'AWIRE', supply: 1_000_000_000n * E, quote: ETHQ, feePips: 20000, positions: 6, preset: 'staircase', openingValuationQuote: 10n * E };
// a generous gas cap: these launches mint several liquidity positions and the
// node's default eth_call cap is far below what 6+ bands need
const exec = async (tx) => (await (await fetch(RPC, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: CREATOR, to: tx.to, data: tx.data, value: '0x' + BigInt(tx.value ?? 0n).toString(16), gas: '0x3b9aca00' }, 'latest'] }),
})).json());

async function live(label, o, extra) {
  try {
    const r = await abyssPlan(client, { ...base, ...o });
    const x = await exec(r.tx);
    check(!!x.result, label, x.result ? (extra ? extra(r) : `token ${r.token.slice(0, 10)}… tick ${r.recipe.launchTick}`)
      : 'revert ' + JSON.stringify(x.error?.data ?? x.error?.message).slice(0, 60));
    return r;
  } catch (e) { check(false, label, 'ERR ' + (e.message || '').split('\n')[0].slice(0, 80)); return null; }
}

const first = await live('a launch executes: 1B supply, ETH pair, 2% fee', {});
if (first) {
  check(BigInt(first.token) > BigInt(ETHQ.address), 'the launched token sorts above the pair token, so the ladder is the right way up');
  check(first.plan.feeAssets.length === 2
    && BigInt(first.plan.feeAssets[0].asset) < BigInt(first.plan.feeAssets[1].asset)
    && first.plan.feeAssets.every((f) => f.ownerBps + f.rewardsBps + f.burnBps === 10000),
    'the fee rows are unique, ascending, and each sums to 100%');
}
for (const cap of [1n * E, 50n * E, 250n * E]) {
  await live(`the opening market cap is editable: ${Number(cap) / 1e18} ETH`, { openingValuationQuote: cap },
    (r) => `tick ${r.recipe.launchTick}`);
}
for (const t of ABYSS_FEE_TIER_LIST) await live(`fee tier ${t.label} launches`, { feePips: t.feePips });
await live('a USDG pair launches (6 decimals)', { quote: USDGQ, openingValuationQuote: 20000n * 10n ** 6n });
await live('dividends to holders launches', { rewardMode: LifecycleRewardMode.Dividends, rewardsBps: 7500 });
await live('staking rewards launch', { rewardMode: LifecycleRewardMode.Staking, rewardsBps: 5000 });
await live('burning part of the token fees launches', { burnBps: 1000 });
for (const p of ABYSS_PRESETS) await live(`the ${p} liquidity shape launches`, { preset: p, positions: 4 });
for (const prof of ABYSS_PROFILES) await live(`pool profile ${prof.key} launches`, { profileKey: prof.key });
await live('an atomic dev buy launches', { devBuyRaw: 5n * 10n ** 16n }, (r) => `${r.plan.buys.length} buy, ${Number(r.tx.value) / 1e18} ETH attached`);
// an ERC-404 at the 10,000-NFT ceiling and well under it, both carrying the base
// URI that is the only metadata the chain itself stores
for (const [nfts, unit] of [[10_000, 100_000n * E], [1_000, 1_000_000n * E]]) {
  await live(`an ERC-404 of ${nfts.toLocaleString()} NFTs launches`,
    { tokenKind: LifecycleTokenKind.ERC404, nftUnit: unit, metadataURI: 'ipfs://art/' },
    (r) => `${(unit / E).toLocaleString()} tokens per NFT, base URI ${r.plan.token.metadataURI}`);
}

// --- a custom pair token ----------------------------------------------------------
{
  const custom = await resolveAbyssQuote(client, '0x15f3385625D7e364C5a6216FBbceadf10fa90e7d');   // the ABYSS token
  check(custom.symbol === 'ABYSS' && custom.decimals === 18 && custom.custom === true,
    'a pasted pair token is read off chain for its symbol and decimals', `${custom.symbol} / ${custom.decimals}dp`);
  for (const bad of ['0xdeadbeef', '']) {
    let msg = '';
    try { await resolveAbyssQuote(client, bad); } catch (e) { msg = e.message; }
    check(/paste a pair token address/.test(msg), `a malformed pair token address is refused (${bad || 'empty'})`, msg.slice(0, 60));
  }
  {
    let msg = '';
    try { await resolveAbyssQuote(client, '0x000000000000000000000000000000000000dEaD'); } catch (e) { msg = e.message; }
    check(/not a contract/.test(msg), 'and an address with no contract behind it is refused', msg.slice(0, 60));
  }
  for (const prof of ABYSS_PROFILES) {
    await live(`a custom pair token launches on ${prof.key}`, { quote: custom, quoteDecimals: 18, openingValuationQuote: 100n * E, profileKey: prof.key });
  }
  const r = await live('a custom pair token with a dev buy plans', { quote: custom, quoteDecimals: 18, openingValuationQuote: 100n * E, devBuyRaw: 10n * E },
    (x) => `prerequisite spender ${x.planned.prerequisites[0]?.spender?.slice(0, 10)}…`);
  if (r) check(r.planned.prerequisites.length === 1 && !!r.planned.prerequisites[0].spender,
    'and names the escrow that needs the approval', r.planned.prerequisites[0]?.spender);
}
console.log('');
process.exit(fails.length ? 1 : 0);
