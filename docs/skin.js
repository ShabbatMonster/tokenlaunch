// Which look the launcher wears: Riso (the default) or Classic.
//
// Loaded as a plain script straight after the <link id="skin">, so the saved
// choice is applied before the first paint rather than flashing the default.
// The choice is a per-browser convenience in localStorage; if storage is
// unavailable (private window, blocked site data) the default simply applies.
(function () {
  var SKINS = {
    riso: { href: 'riso.css', next: 'classic', label: 'Classic look' },
    classic: { href: 'classic.css', next: 'riso', label: 'Riso look' },
  };
  var KEY = 'tokenlaunch.skin';
  var current = 'riso';
  try {
    var saved = localStorage.getItem(KEY);
    if (SKINS[saved]) current = saved;
  } catch (e) { /* storage blocked: keep the default */ }

  var link = document.getElementById('skin');
  function apply(name) {
    current = name;
    if (link && link.getAttribute('href') !== SKINS[name].href) link.setAttribute('href', SKINS[name].href);
    document.documentElement.setAttribute('data-skin', name);
  }
  apply(current);

  function mountToggle() {
    var bar = document.querySelector('nav.menubar');
    if (!bar || bar.querySelector('.mb-skin')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mb-skin';
    var paint = function () {
      b.textContent = '◐ ' + SKINS[current].label;
      b.title = 'switch between the Riso and Classic looks';
    };
    paint();
    b.addEventListener('click', function () {
      apply(SKINS[current].next);
      try { localStorage.setItem(KEY, current); } catch (e) { /* not remembered, still switched */ }
      paint();
    });
    bar.appendChild(b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountToggle);
  else mountToggle();
})();
