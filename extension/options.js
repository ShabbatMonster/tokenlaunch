// Options page. Runs inside the extension, which is what lets it write settings
// and ask for the key import - the worker checks the sender's URL, not merely
// whether it came from a tab, because this page IS a tab.

const $ = (id) => document.getElementById(id);
const say = (id, msg, cls = '') => { const n = $(id); n.className = cls; n.textContent = msg; };

async function load() {
  const s = await chrome.runtime.sendMessage({ type: 'pm:getSettings' });
  $('rpcUrl').value = s.rpcUrl || '';
  $('slippage').value = ((s.slippageBps ?? 500) / 100).toString();
  $('route').value = s.route || 'auto';
  $('tip').value = ((s.tipLamports ?? 1_000_000) / 1e9).toString();
  $('secretKey').value = '';
  say('keyState', s.hasKey ? 'key loaded: ' + s.address : 'no key yet', s.hasKey ? 'ok' : 'warn');
}

$('save').onclick = async () => {
  const values = {
    rpcUrl: $('rpcUrl').value.trim(),
    slippageBps: Math.round(Number($('slippage').value || '5') * 100),
    route: $('route').value,
    tipLamports: Math.round(Number($('tip').value || '0.001') * 1e9),
  };
  const key = $('secretKey').value.trim();
  if (key) values.secretKey = key;
  const res = await chrome.runtime.sendMessage({ type: 'pm:setSettings', values });
  say('saveState', res?.ok ? 'saved' : (res?.error || 'could not save'), res?.ok ? 'ok' : 'err');
  load();
};

$('import').onclick = async () => {
  say('saveState', 'reading the launcher…');
  const res = await chrome.runtime.sendMessage({ type: 'pm:importKey' });
  say('saveState', res?.ok ? 'imported ' + res.address : (res?.error || 'import failed'), res?.ok ? 'ok' : 'err');
  load();
};

// Every DBC pool this wallet launched that finished its curve and never
// migrated. This is the whole point of the tool, so it is worth showing without
// having to find each coin on a website first.
$('scan').onclick = async () => {
  say('stuckState', 'scanning Meteora for stuck pools…');
  const res = await chrome.runtime.sendMessage({ type: 'pm:stuck' });
  if (!res?.ok) { say('stuckState', res?.error || 'scan failed', 'err'); return; }
  if (!res.pools.length) { say('stuckState', 'nothing stuck', 'ok'); $('stuck').innerHTML = ''; return; }
  say('stuckState', res.pools.length + ' stuck', 'warn');
  $('stuck').innerHTML = res.pools.map((p) => `<div class="row">`
    + `<a href="https://solscan.io/token/${p.baseMint}" target="_blank" rel="noopener">${p.baseMint.slice(0, 8)}…</a>`
    + ` <span class="dim">raised ${p.quoteReserve} (raw) · progress ${p.migrationProgress}</span></div>`).join('');
};

load();
