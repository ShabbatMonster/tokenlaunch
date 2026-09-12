const $ = (id) => document.getElementById(id);
const tab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

async function load() {
  const s = await chrome.runtime.sendMessage({ type: 'j7fb:getSettings' });
  const st = await chrome.runtime.sendMessage({ type: 'j7fb:state' });
  $('armed').innerHTML = s.armed ? '<span class="ok">yes</span>' : '<span class="err">no</span>';
  $('auto').textContent = s.autoFire ? 'yes' : 'no';
  $('addr').textContent = s.hasKey ? String(s.address).slice(0, 4) + '…' + String(s.address).slice(-4) : 'none';
  $('busy').textContent = st?.inFlight ? 'yes' : 'no';
}

// the content script owns the mirrored values, so ask it to fire rather than
// guessing them here
$('fire').onclick = async () => { chrome.tabs.sendMessage((await tab()).id, { type: 'j7fb:fire' }); window.close(); };
$('refresh').onclick = async () => { chrome.tabs.sendMessage((await tab()).id, { type: 'j7fb:refresh' }); window.close(); };
$('reset').onclick = async () => { await chrome.runtime.sendMessage({ type: 'j7fb:reset' }); load(); };
$('opts').onclick = () => chrome.runtime.openOptionsPage();

load();
