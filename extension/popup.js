// The toolbar popup.
//
// It used to be a read-only status box, on the assumption that every migration
// starts from a coin page. That assumption is wrong for the case this tool
// exists for: a curve that has bonded but NOT migrated has no AMM pool yet, so
// no DEX indexes it, so there is no page anywhere for the content script to
// scrape. The only way to reach such a coin is to type its address.
//
// So the popup can now drive the whole thing. The venue is decided by the
// worker asking the chain, exactly as it is for the panel - nothing here knows
// or cares whether an address is a pump coin or a Meteora one.
//
// The key never comes near this file. It is held in the worker, and the only
// things crossing the boundary are an address going in and status coming out.

const $ = (id) => document.getElementById(id);

const VENUE_LABEL = {
  pump: 'pump.fun', meteora: 'Meteora DBC', raydium: 'Raydium LaunchLab', pons: 'Pons v2',
};
// What the migration opens, which is the thing worth knowing before signing.
const VENUE_DEST = {
  pump: 'PumpSwap', meteora: 'DAMM v2', pons: 'Uniswap v4', raydium: null,
};

let state = { mint: null, info: null, busy: false };

function setStatus(text, cls = 'muted') {
  const el = $('status');
  el.textContent = text || '';
  el.className = cls;
}

const fmt = (raw, decimals) => {
  if (raw == null || decimals == null) return null;
  const s = String(raw).padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};

(async () => {
  const s = await chrome.runtime.sendMessage({ type: 'pm:getSettings' });
  $('who').textContent = s?.hasKey ? s.address : 'no key imported';
  $('who').className = s?.hasKey ? 'ok' : 'warn';
  $('rpc').textContent = s?.rpcUrl ? new URL(s.rpcUrl).host : '—';

  // The worker outlives this popup, so a migration started here keeps running
  // after it closes. Show whatever it last said rather than an empty box.
  const { lastStatus, lastResult } = await chrome.storage.local.get(['lastStatus', 'lastResult']);
  const fresh = (x) => x && Date.now() - x.at < 10 * 60 * 1000;
  if (fresh(lastResult)) {
    setStatus(lastResult.ok ? `last: migrated · ${lastResult.sig || ''}` : `last: ${lastResult.error}`,
      lastResult.ok ? 'ok' : 'bad');
  } else if (fresh(lastStatus)) {
    setStatus(`last: ${lastStatus.text}`);
  }

  // prefill from the tab, so the common case is still one click
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const m = /([1-9A-HJ-NP-Za-km-z]{32,44})|0x[0-9a-fA-F]{40}/.exec(tab?.url || '');
    if (m) $('ca').value = m[0];
  } catch { /* no tabs permission on this page, which is fine */ }
})();

// live progress while the popup happens to be open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'pm:status') setStatus(msg.text);
});

$('resolve').onclick = async () => {
  const ca = $('ca').value.trim();
  if (!ca) { setStatus('paste an address first', 'warn'); return; }
  $('info').style.display = 'none';
  state = { mint: null, info: null, busy: false };
  setStatus('asking the chain which venue this is…');
  const r = await chrome.runtime.sendMessage({ type: 'pm:resolve', candidates: [ca] });
  if (!r?.ok) { setStatus(r?.error || 'could not identify it', 'bad'); return; }

  state.mint = r.mint;
  state.info = r.info;
  const i = r.info;
  const dest = VENUE_DEST[i.venue];
  $('venue').textContent = (VENUE_LABEL[i.venue] || i.venue) + (dest ? ` → ${dest}` : '');
  $('state').textContent = i.state + (i.reason ? ` · ${i.reason}` : '');
  $('state').className = i.state === 'migratable' ? 'ok' : 'warn';
  $('quote').textContent = i.quoteMint
    ? (i.isNativeQuote ? 'native' : i.quoteMint.slice(0, 8) + '…')
    : '—';
  const raised = fmt(i.raisedQuote, i.venue === 'pons' ? 18 : i.quoteDecimals);
  $('raised').textContent = raised ?? '—';

  // A first buy only rides along where the destination pool can be swapped in
  // the same transaction. Hide the box rather than take an amount that would be
  // silently dropped.
  $('spend').style.display = i.canBuy ? '' : 'none';
  $('info').style.display = '';
  $('migrate').disabled = i.state !== 'migratable';
  $('migrate').textContent = i.canBuy ? 'MIGRATE + BUY' : 'MIGRATE';
  if (i.state !== 'migratable') {
    setStatus(i.reason || `not migratable: ${i.state}`, 'warn');
  } else if (!i.canBuy && i.venue === 'meteora') {
    setStatus('migratable. No same-tx buy on this venue — it opens a DAMM v2 pool.', 'muted');
  } else {
    setStatus('migratable.', 'ok');
  }
};

$('migrate').onclick = async () => {
  if (state.busy || !state.mint) return;
  const i = state.info;
  let spendQuote = '0';
  if (i.canBuy) {
    const typed = $('spend').value.trim();
    if (typed) {
      const dec = i.venue === 'pons' ? 18 : (i.quoteDecimals ?? 9);
      if (!/^\d*\.?\d*$/.test(typed)) { setStatus('that is not a number', 'warn'); return; }
      const [w, f = ''] = typed.split('.');
      spendQuote = ((BigInt(w || '0') * 10n ** BigInt(dec)) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0')).toString();
    }
  }
  state.busy = true;
  $('migrate').disabled = true;
  setStatus('migrating…');
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'pm:migrate', mint: state.mint, venue: i.venue, spendQuote,
    });
    if (!r?.ok) { setStatus(r.error || 'migration failed', 'bad'); return; }
    const sig = r.result?.sig || r.result?.hash || '';
    setStatus(`migrated ✓ ${sig}`, 'ok');
  } catch (e) {
    // the popup closing mid-flight rejects the sendMessage, but the worker
    // carries on - reopening shows the stored result
    setStatus('lost the reply (the migration may still be running): ' + (e?.message || e), 'warn');
  } finally {
    state.busy = false;
    $('migrate').disabled = false;
  }
};

$('ca').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('resolve').click(); });

$('options').onclick = () => chrome.runtime.openOptionsPage();
