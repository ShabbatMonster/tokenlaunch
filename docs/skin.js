// Which look the launcher wears: Petunia (the default), Riso or Classic.
//
// Loaded as a plain script straight after the <link id="skin">, so the saved
// choice is applied before the first paint rather than flashing the default.
// The choice is a per-browser convenience in localStorage; if storage is
// unavailable (private window, blocked site data) the default simply applies.
// The menu-bar button cycles through the looks in ORDER.
(function () {
  var SKINS = {
    petunia: { href: 'petunia.css', label: 'Petunia' },
    riso: { href: 'riso.css', label: 'Riso' },
    classic: { href: 'classic.css', label: 'Classic' },
  };
  var ORDER = ['petunia', 'riso', 'classic'];
  var KEY = 'tokenlaunch.skin';
  var current = 'petunia';
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
  function next(name) { return ORDER[(ORDER.indexOf(name) + 1) % ORDER.length]; }
  apply(current);

  function mountToggle() {
    var bar = document.querySelector('nav.menubar');
    if (!bar || bar.querySelector('.mb-skin')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mb-skin';
    var paint = function () {
      b.textContent = '◐ Look: ' + SKINS[current].label;
      b.title = 'change the look - next: ' + SKINS[next(current)].label;
    };
    paint();
    b.addEventListener('click', function () {
      apply(next(current));
      try { localStorage.setItem(KEY, current); } catch (e) { /* not remembered, still switched */ }
      paint();
    });
    bar.appendChild(b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountToggle);
  else mountToggle();
})();
