import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

// Run with:  node extension/test/axiom.test.mjs
//
// Axiom's markup is not ours and will change without warning, so the contract
// address is never read from a selector we guessed. It is gathered from every
// place it could be - explorer links, the URL, page text, data attributes - and
// the service worker decides which candidate is real by asking the chain.
//
// What this pins is that the gathering survives a page that looks nothing like
// the one it was written against, and that the panel can never reach the key.

const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', 'axiom.js'), 'utf8');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};

// Pull candidateMints() out of the content script and run it against a mock
// page. Taking the real function rather than a copy is the point: a change to
// the scraper is a change to what this tests.
function loadCandidateMints(dom) {
  const start = SRC.indexOf('function candidateMints()');
  const end = SRC.indexOf('\n}', SRC.indexOf('return out.slice', start)) + 2;
  const body = SRC.slice(start, end);
  const prelude = `
    const BASE58 = ${SRC.match(/const BASE58 = (.+);/)[1]};
    const MINT_IN_URL = ${SRC.match(/const MINT_IN_URL = (.+);/)[1]};
    const looksLikeMint = ${SRC.match(/const looksLikeMint = (.+);/)[1]};
  `;
  const fn = new Function('document', 'location', 'URLSearchParams', 'NodeFilter',
    prelude + body + '; return candidateMints();');
  return () => fn(dom.window.document, dom.window.location, dom.window.URLSearchParams, dom.window.NodeFilter);
}

const PUMP_MINT = '25UThw41PUqCTRpGSBzoZRB1MYEZsjVo7AUAn7Nupump';
const OTHER_MINT = 'GacgmKkuqxLfL7qox6YMeP7SWHdC1ayMsLUJcuKB5huf';
const WALLET = 'JDQKDrc1TQgBRvdFh56tkta5sYcDj1SoP52Eiu64rSrT';

// --- a page shaped roughly like the screenshot -------------------------------
{
  const dom = new JSDOM(`<!doctype html><body>
    <div class="header">
      <img src="/logo.png"><span>AlphaAI</span><span>AlphaAI</span>
      <button>copy</button><button>VAMP</button>
      <a href="https://x.com/kevinxu">@kevinxu</a>
      <span>$29.1K</span><span>Price</span><span>$0.043</span>
      <span>${PUMP_MINT}</span>
    </div>
    <div class="body"><span>holders</span><span>1641</span></div>
  </body>`, { url: 'https://axiom.trade/meme/' + PUMP_MINT });
  const out = loadCandidateMints(dom)();
  check(out[0] === PUMP_MINT, 'finds the mint on a header-shaped page', out[0]);
  check(out.length <= 8, 'never sends more than eight candidates to the worker', String(out.length));
}

// --- the mint only in an explorer link --------------------------------------
{
  const dom = new JSDOM(`<!doctype html><body>
    <a href="https://solscan.io/token/${PUMP_MINT}">chart</a>
    <div>nothing else useful here</div>
  </body>`, { url: 'https://axiom.trade/discover' });
  const out = loadCandidateMints(dom)();
  check(out.includes(PUMP_MINT), 'reads the mint out of a solscan link', out.join(',') || 'none');
}

// --- the mint only in the URL ------------------------------------------------
{
  const dom = new JSDOM('<!doctype html><body><div>no addresses rendered yet</div></body>',
    { url: 'https://axiom.trade/meme/' + OTHER_MINT + '?tab=chart' });
  const out = loadCandidateMints(dom)();
  check(out.includes(OTHER_MINT), 'reads the mint out of the URL when the page has not rendered', out.join(','));
}

// --- vanity ordering ---------------------------------------------------------
// A page usually shows several addresses - the pair, the creator, the wallet.
// The "...pump" one is pump.fun's own suffix, so it is tried first; but the
// others are still offered, because the chain has the final say, not the suffix.
{
  const dom = new JSDOM(`<!doctype html><body>
    <span>${WALLET}</span>
    <span>${OTHER_MINT}</span>
    <span>${PUMP_MINT}</span>
  </body>`, { url: 'https://axiom.trade/meme/whatever' });
  const out = loadCandidateMints(dom)();
  check(out[0] === PUMP_MINT, 'a ...pump address is tried before other addresses on the page', out[0]);
  check(out.includes(WALLET) && out.includes(OTHER_MINT),
    'the others are still offered, because the chain decides and not the suffix');
}

// --- a page with nothing on it ----------------------------------------------
{
  const dom = new JSDOM('<!doctype html><body><div>Axiom</div></body>', { url: 'https://axiom.trade/' });
  const out = loadCandidateMints(dom)();
  check(out.length === 0, 'a page with no addresses yields no candidates, rather than junk', String(out.length));
}

// --- things that merely look like base58 ------------------------------------
{
  const dom = new JSDOM(`<!doctype html><body>
    <span>0x60f4D66B464bFCE01Ffa6B8145A1116Dc537de65</span>
    <span>short</span>
    <span>IIIIOOOOllll0000IIIIOOOOllll0000IIII</span>
  </body>`, { url: 'https://axiom.trade/meme/x' });
  const out = loadCandidateMints(dom)();
  check(out.length === 0, 'an EVM address and base58-illegal characters are not offered', out.join(','));
}

// --- the security line -------------------------------------------------------
//
// The whole design is that the page side cannot reach the key. These are
// source-level assertions because it is a property of the file, not of a run.
check(!/secretKey|privateKey|keypairFrom|solAddressFromSecret/.test(SRC),
  'the content script never names a key at all');
check(!/vendor\/launcher|pumpSnipe|pumpMigrate/.test(SRC),
  'the content script does not import the signing code');
check(/pm:resolve/.test(SRC) && /pm:preview/.test(SRC) && /pm:migrate/.test(SRC),
  'it speaks only the resolve / preview / migrate vocabulary');
check(/e\.isTrusted/.test(SRC),
  'the one control that spends money refuses synthetic clicks');

// --- the mount, which is what failed the first time --------------------------
//
// The button has to exist before anything is awaited. The first version read a
// stored position first, so a slow or failing chrome.storage meant no button at
// all rather than a button in the default place.
// comments stripped first: this is an assertion about code, and the prose right
// above the mount uses the word "awaited"
const CODE = SRC.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const startFn = CODE.slice(CODE.indexOf('function start()'));
const firstAwait = startFn.indexOf('await');
const firstMount = startFn.indexOf('mount()');
check(firstMount !== -1 && (firstAwait === -1 || firstMount < firstAwait),
  'the button is mounted before anything is awaited');
check(/buildButton\(\);[\s\S]{0,80}buildPanel\(\);[\s\S]{0,40}mount\(\);/.test(startFn),
  'build and mount happen together at start');
check(/ANCHOR_LABELS/.test(SRC) && /'vamp'/.test(SRC),
  'it looks for Axiom’s own VAMP button to sit beside');
check(/setInterval\([\s\S]{0,200}mount\(\)/.test(SRC),
  're-mounts on a timer, because React re-renders that row and drops our node');
check(/document\.documentElement\.appendChild\(panel\)/.test(SRC),
  'the panel hangs off <html> so no ancestor can clip it');
check(/if \(!document\.body\)/.test(SRC),
  'it waits for a body rather than throwing when injected early');

// Meteora opens a DAMM v2 pool, so the pump first-buy does not apply there. The
// box must be hidden rather than shown and then failing.
check(/canBuy/.test(SRC) && /buybox'\)\.style\.display = info\.canBuy/.test(SRC),
  'the buy box is hidden on venues where the first buy is not wired');

// The worker must not hand back anything that cannot survive a structured
// clone into a content script - a BigInt throws, a PublicKey arrives as {}.
const BG = fs.readFileSync(path.join(import.meta.dirname, '..', 'background.js'), 'utf8');
const trim = BG.slice(BG.indexOf('function trimPump'), BG.indexOf('// --- messages'));
check(/toString\?\.\(\)/.test(trim) && /toBase58\?\.\(\)/.test(trim),
  'the worker converts BigInts and PublicKeys before replying', 'trimPump()');
check(!/curve:/.test(trim),
  'the raw curve object is never sent to the page');
check(/canBuy: true/.test(trim) && /canBuy: false/.test(trim),
  'each venue states whether a first buy is possible on it');

// A coin quoted in something other than SOL spends that token, and there is no
// wrapping step for it. The panel has to name the token or you cannot know what
// to hold.
check(/quoteMint\.slice/.test(SRC) && /not quoted in SOL/.test(SRC),
  'the panel names a non-SOL quote instead of calling it QUOTE');

// --- funding a non-SOL quote from inside the panel ---------------------------
//
// A non-SOL quote has to be held already, so the panel offers the way to get it
// (Jupiter) and the way to spend all of it (MAX). Both only make sense on a
// non-SOL quote, so both are hidden otherwise.
check(/pm:quoteSwap/.test(SRC) && /pm:swap/.test(SRC) && /pm:balance/.test(SRC),
  'the panel can quote a swap, run it, and read the balance');
check(/swapbox'\)\.classList\.toggle\(`\$\{ID\}-hidden`, !needsQuote\)/.test(SRC)
  && /max'\)\.classList\.toggle\(`\$\{ID\}-hidden`, !needsQuote\)/.test(SRC),
  'the swap row and MAX appear only when the quote is not SOL');
check(/e\.isTrusted/.test(SRC) && (SRC.match(/if \(!e\.isTrusted/g) || []).length >= 2,
  'the swap button refuses synthetic clicks too, not just the migrate button');

// MAX writes the balance into the amount box. Dividing a raw u64 by 10^decimals
// in a float loses the low digits of a large balance, and this is the number
// that then gets spent - so it is assembled as a string.
check(/padStart\(dec \+ 1/.test(SRC) && !/heldRaw \/ 10/.test(SRC),
  'MAX builds the amount as a string rather than through a float divide');

// --- Raydium must never be offered ------------------------------------------
//
// migrate_to_cpswap requires Raydium's own address as payer - the program says
// so itself. A button for it would fail every single time, so there is none.
const RAY = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'raydiumMigrate.js'), 'utf8');
check(/state: 'blocked'/.test(RAY) && !/state: 'migratable'/.test(RAY),
  'the Raydium path never reports a migratable state');
check(/RAYpQbFNq9i3mu6cKpTKKRwwHFDeK5AuZz8xvxUrCgw/.test(RAY),
  'it names the address Raydium requires, taken from the program’s own error');
check(/permissioned/.test(BG),
  'the worker refuses a Raydium migration rather than attempting one');

// --- j7 is gone --------------------------------------------------------------
check(!fs.existsSync(path.join(import.meta.dirname, '..', 'content.js'))
  && !fs.existsSync(path.join(import.meta.dirname, '..', 'overlay.css')),
  'the j7tracker fallback is removed');
// comments stripped again: the worker still explains in prose what it used to
// do, and that sentence is worth keeping
const BG_CODE = BG.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
check(!/j7|deployMirrored|uploadMetadata|pumpWarmup/.test(BG_CODE),
  'the worker keeps no j7 machinery');

console.log('');
process.exit(fails.length ? 1 : 0);
