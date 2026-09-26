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
check(/pm:resolve|pm:preview|pm:migrate/.test(SRC) && (SRC.match(/type: 'pm:/g) || []).length === 3,
  'it speaks exactly three message types to the worker');
check(/e\.isTrusted/.test(SRC),
  'the one control that spends money refuses synthetic clicks');

// The worker must not hand back anything that cannot survive a structured
// clone into a content script - a BigInt throws, a PublicKey arrives as {}.
const BG = fs.readFileSync(path.join(import.meta.dirname, '..', 'background.js'), 'utf8');
const trim = BG.slice(BG.indexOf('function trimInfo'), BG.indexOf('\n}', BG.indexOf('function trimInfo')) + 2);
check(/toString\?\.\(\)|toBase58\?\.\(\)/.test(trim),
  'the worker converts BigInts and PublicKeys before replying', 'trimInfo()');
check(!/curve:|info\.curve\b(?!\?)/.test(trim.replace(/info\.curve\?\./g, '')),
  'the raw curve object is never sent to the page');

console.log('');
process.exit(fails.length ? 1 : 0);
