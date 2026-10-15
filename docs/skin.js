// Which look the launcher wears. Crescent is the default; the menu bar gets a
// dropdown listing the three presets first, then the earlier looks.
//
// Loaded as a plain script straight after the <link id="skin">, so the saved
// choice is applied before the first paint rather than flashing the default.
// The choice is a per-browser convenience in localStorage; if storage is
// unavailable (private window, blocked site data) the default simply applies.
(function () {
  var SKINS = {
    crescent: { href: 'crescent.css', label: 'Crescent' },
    byakko: { href: 'byakko.css', label: 'Byakko' },
    babel: { href: 'babel.css', label: 'Babel' },
    deco: { href: 'deco.css', label: 'Deco' },
    petunia: { href: 'petunia.css', label: 'Petunia' },
    riso: { href: 'riso.css', label: 'Riso' },
    classic: { href: 'classic.css', label: 'Classic' },
  };
  var PRESETS = ['crescent', 'byakko', 'babel'];
  var ORDER = ['crescent', 'byakko', 'babel', 'deco', 'petunia', 'riso', 'classic'];
  var KEY = 'tokenlaunch.skin';
  var current = 'crescent';
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

  function option(name) {
    var o = document.createElement('option');
    o.value = name;
    o.textContent = SKINS[name].label;
    return o;
  }

  function mountPicker() {
    var bar = document.querySelector('nav.menubar');
    if (!bar || bar.querySelector('.mb-skin')) return;
    var sel = document.createElement('select');
    sel.className = 'mb-skin';
    sel.setAttribute('aria-label', 'Look');
    sel.title = 'change the look';
    // the pages make every <select> full width; this one sits in the menu bar
    sel.style.width = 'auto';
    sel.style.flex = 'none';
    var presets = document.createElement('optgroup');
    presets.label = 'Presets';
    var more = document.createElement('optgroup');
    more.label = 'More looks';
    ORDER.forEach(function (name) { (PRESETS.indexOf(name) > -1 ? presets : more).appendChild(option(name)); });
    sel.appendChild(presets);
    sel.appendChild(more);
    sel.value = current;
    sel.addEventListener('change', function () {
      if (!SKINS[sel.value]) return;
      apply(sel.value);
      try { localStorage.setItem(KEY, current); } catch (e) { /* not remembered, still switched */ }
    });
    bar.appendChild(sel);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPicker);
  else mountPicker();
})();
