const $ = (id) => document.getElementById(id);

const FLAGS = ['armed', 'autoFire', 'prePin', 'cashback', 'feesToHolders'];
const TEXTS = ['rpcUrl'];
const NUMS = ['slippageBps', 'defaultDevBuySol'];

async function load() {
  const s = await chrome.runtime.sendMessage({ type: 'j7fb:getSettings' });
  for (const k of TEXTS) $(k).value = s[k] ?? '';
  for (const k of NUMS) $(k).value = s[k] ?? 0;
  for (const k of FLAGS) $(k).checked = !!s[k];
  $('takeoverSec').value = Math.round((s.takeoverDelayMs ?? 20000) / 1000);
  $('addr').innerHTML = s.hasKey
    ? (s.address === 'invalid key'
      ? '<span class="err">saved key is not valid base58</span>'
      : `<span class="ok">key saved</span> — ${s.address}`)
    : '<span class="err">no key saved</span>';

  const sel = (await chrome.storage.local.get('selectors')).selectors || {};
  const keys = Object.keys(sel);
  $('taught').textContent = keys.length ? keys.join(', ') : 'none';
}

$('save').onclick = async () => {
  const values = {};
  for (const k of TEXTS) values[k] = $(k).value.trim();
  for (const k of NUMS) values[k] = Number($(k).value) || 0;
  for (const k of FLAGS) values[k] = $(k).checked;
  values.takeoverDelayMs = Math.max(3, Number($('takeoverSec').value) || 20) * 1000;

  const key = $('secretKey').value.trim();
  if (key) values.secretKey = key;

  // a custom RPC is not in the manifest's host list, so ask for it explicitly
  // rather than letting the launch fail later with an opaque fetch error
  try {
    const u = new URL(values.rpcUrl);
    const pattern = `${u.protocol}//${u.hostname}/*`;
    const has = await chrome.permissions.contains({ origins: [pattern] });
    if (!has) await chrome.permissions.request({ origins: [pattern] });
  } catch { /* an unparseable URL is reported by the save below */ }

  const res = await chrome.runtime.sendMessage({ type: 'j7fb:setSettings', values });
  $('secretKey').value = '';
  $('saved').innerHTML = res?.ok ? '<span class="ok">saved</span>' : `<span class="err">${res?.error || 'failed'}</span>`;
  load();
};

$('importKey').onclick = async () => {
  $('saved').textContent = 'looking for the launcher…';
  const res = await chrome.runtime.sendMessage({ type: 'j7fb:importKey' });
  $('saved').innerHTML = res?.ok
    ? `<span class="ok">imported</span> — ${res.address}`
    : `<span class="err">${res?.error || 'import failed'}</span>`;
  load();
};

$('clearKey').onclick = async () => {
  await chrome.storage.local.remove('secretKey');
  $('saved').innerHTML = '<span class="ok">key removed</span>';
  load();
};

$('clearSelectors').onclick = async () => {
  await chrome.storage.local.remove('selectors');
  load();
};

load();
