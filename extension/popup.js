// The toolbar popup: who is loaded, and a way into the options. Everything that
// spends money lives on the page panel, not here.
const $ = (id) => document.getElementById(id);

(async () => {
  const s = await chrome.runtime.sendMessage({ type: 'pm:getSettings' });
  $('who').textContent = s?.hasKey ? s.address : 'no key imported';
  $('who').className = s?.hasKey ? 'ok' : 'warn';
  $('rpc').textContent = s?.rpcUrl ? new URL(s.rpcUrl).host : '—';
})();

$('options').onclick = () => chrome.runtime.openOptionsPage();
