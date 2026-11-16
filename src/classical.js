// Classical music for the perps page (only perps.js imports this).
//
// The compositions are centuries old, but a RECORDING has its own copyright,
// so every track here is a recording that is itself free to use: public domain
// or CC0 (mostly Musopen's, released to the public domain), and two Chopin
// recordings under CC BY 3.0, which require the credit shown in the playlist.
// They stream from Wikimedia Commons' MP3 transcodes, the same files the
// Commons player uses; the `page` link is each file's licence page.

const C = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/';
const t = (path, name) => `${C}${path}/${name}/${name}.mp3`;

export const PLAYLIST = [
  { composer: 'Mozart', work: 'Symphony No. 40 in G minor, K. 550', part: 'I. Molto allegro', by: 'Musopen Symphony', license: 'Public domain',
    src: t('a/a8', 'Mozart_-_Symphony_No._40_in_G_minor%2C_K550_-_I._Molto_allegro_%28Musopen_Symphony%29.flac') },
  { composer: 'Mozart', work: 'Symphony No. 40 in G minor, K. 550', part: 'II. Andante', by: 'Musopen Symphony', license: 'Public domain',
    src: t('4/43', 'Mozart_-_Symphony_No._40_in_G_minor%2C_K550_-_II._Andante_%28Musopen_Symphony%29.flac') },
  { composer: 'Mozart', work: 'The Magic Flute, K. 620', part: 'Overture', by: 'Musopen Symphony', license: 'Public domain',
    src: t('c/c9', 'Mozart_-_Die_Zauberfl%C3%B6te%2C_K620_-_Overture_%28Musopen_Symphony%29.flac') },
  { composer: 'Mozart', work: 'String Quartet No. 19 "Dissonance", K. 465', part: 'II. Andante cantabile', by: 'Musopen String Quartet', license: 'Public domain',
    src: t('7/7f', 'Mozart_-_String_Quartet_No._19_in_C_major%2C_K465_%27Dissonance%27_-_II._Andante_cantabile_%28Musopen_String_Quartet%29.flac') },
  { composer: 'Mozart', work: 'String Quartet No. 15 in D minor, K. 421', part: 'I. Allegro moderato', by: 'Musopen String Quartet', license: 'Public domain',
    src: t('3/3a', 'Mozart_-_String_Quartet_No._15_in_D_minor%2C_K421_-_I._Allegro_moderato_%28Musopen_String_Quartet%29.flac') },
  { composer: 'Beethoven', work: 'Egmont Overture, Op. 84', part: '', by: 'Musopen Symphony', license: 'Public domain',
    src: t('8/85', 'Beethoven_-_Egmont_Overture%2C_Op._84_%28Musopen_Symphony%29.flac') },
  { composer: 'Beethoven', work: 'Symphony No. 3 "Eroica", Op. 55', part: 'III. Scherzo. Allegro vivace', by: 'Musopen Symphony', license: 'Public domain',
    src: t('8/8a', 'Beethoven_-_Symphony_No._3_in_E_flat_major%2C_Op._55_%27Eroica%27_-_III._Scherzo._Allegro_vivace_%28Musopen_Symphony%29.flac') },
  { composer: 'Beethoven', work: 'String Quartet No. 6, Op. 18 No. 6', part: 'II. Adagio, ma non troppo', by: 'Musopen String Quartet', license: 'Public domain',
    src: t('3/33', 'Beethoven_-_String_Quartet_No._6_in_B_flat_major%2C_Op._18_No._6_-_II._Adagio%2C_ma_non_troppo_%28Musopen_String_Quartet%29.flac') },
  { composer: 'Bach', work: 'Goldberg Variations, BWV 988', part: 'Aria', by: 'Shelley Katz', license: 'Public domain',
    src: t('e/e6', 'Bach%2C_J_S_-_Goldberg_Variations%2C_BWV988_-_01._Aria_%28Shelley_Katz%29.flac') },
  { composer: 'Bach', work: 'Goldberg Variations, BWV 988', part: 'Variation 1', by: 'Shelley Katz', license: 'Public domain',
    src: t('0/08', 'Bach%2C_J_S_-_Goldberg_Variations%2C_BWV988_-_02._Variation_1_%28Shelley_Katz%29.flac') },
  { composer: 'Bach', work: 'Goldberg Variations, BWV 988', part: 'Variation 13', by: 'Shelley Katz', license: 'Public domain',
    src: t('1/1c', 'Bach%2C_J_S_-_Goldberg_Variations%2C_BWV988_-_14._Variation_13_%28Shelley_Katz%29.flac') },
  { composer: 'Chopin', work: 'Nocturne in C-sharp minor, Op. posth.', part: '', by: 'Musopen', license: 'CC BY 3.0',
    src: t('1/12', 'Chopin%2C_Nocturne_in_C-sharp_minor%2C_Op._Posth.ogg') },
  { composer: 'Chopin', work: 'Waltz in C-sharp minor, Op. 64 No. 2', part: '', by: 'Musopen', license: 'CC0',
    src: t('1/17', 'Chopin-waltz-op-64-no-2-in-c-sharp-minor.oga') },
  { composer: 'Chopin', work: 'Barcarolle in F-sharp major, Op. 60', part: '', by: 'Musopen', license: 'CC BY 3.0',
    src: t('7/7e', 'Chopin_-_Barcarole-op-60.ogg') },
  { composer: 'Vivaldi', work: 'The Four Seasons: Spring, RV 269', part: 'I. Allegro', by: 'The Modena Chamber Orchestra', license: 'Public domain',
    src: t('1/18', 'The_Modena_Chamber_Orchestra_-_Vivaldi%27s_Spring%2C_RV_269_-_I._Allegro.ogg') },
  { composer: 'Vivaldi', work: 'The Four Seasons: Summer, RV 315', part: 'III. Presto', by: 'The Modena Chamber Orchestra', license: 'Public domain',
    src: t('1/17', 'The_Modena_Chamber_Orchestra_-_Vivaldi%27s_Summer%2C_RV_315_-_III._Presto.ogg') },
  { composer: 'Vivaldi', work: 'The Four Seasons: Winter, RV 297', part: 'II. Largo', by: 'The Modena Chamber Orchestra', license: 'Public domain',
    src: t('8/8b', 'The_Modena_Chamber_Orchestra_-_Vivaldi%27s_Winter%2C_RV_297_-_II._Largo.ogg') },
  { composer: 'Satie', work: 'Gymnopédie No. 1', part: '', by: 'Michael Laucke', license: 'Public domain',
    src: t('a/a6', 'Satie_Gymnopedie_No_1_performed_by_Michael_Laucke.flac') },
  { composer: 'Satie', work: 'Gymnopédie No. 2', part: '', by: 'Michael Laucke', license: 'Public domain',
    src: t('3/3d', 'Satie_Gymnopedie_No_2_performed_by_Michael_Laucke.flac') },
  { composer: 'Tchaikovsky', work: 'Symphony No. 6 "Pathétique", Op. 74', part: 'II. Allegro con grazia', by: 'Musopen Symphony', license: 'Public domain',
    src: t('b/b3', 'Tchaikovsky_-_Symphony_No._6_in_B_minor%2C_Op._74_%27Path%C3%A9tique%27_-_II._Allegro_con_grazia_%28Musopen_Symphony%29.flac') },
];
for (const p of PLAYLIST) p.page = 'https://commons.wikimedia.org/wiki/File:' + p.src.split('/')[8];
export const COMPOSERS = [...new Set(PLAYLIST.map((p) => p.composer))];
export const trackTitle = (p) => `${p.composer} · ${p.work}${p.part ? ' — ' + p.part : ''}`;

/// Which track plays after `idx`. In shuffle, a random one from the filter that
/// is not the one just heard; otherwise the next in list order (wrapping).
export function nextIndex(idx, { shuffle = true, composer = 'all', rand = Math.random } = {}) {
  const pool = PLAYLIST.map((p, i) => i).filter((i) => composer === 'all' || PLAYLIST[i].composer === composer);
  if (!pool.length) return idx;
  if (shuffle) {
    const others = pool.filter((i) => i !== idx);
    const from = others.length ? others : pool;
    return from[Math.floor(rand() * from.length)];
  }
  const after = pool.find((i) => i > idx);
  return after ?? pool[0];
}

/// The player. `els` holds the page's controls; state lives in localStorage
/// under perps.music so the piece and position survive a reload.
export function createMusicPlayer(els, store) {
  const KEY = 'perps.music';
  const st = { on: true, muted: false, vol: 0.35, idx: 0, t: 0, shuffle: true, composer: 'all', ...store.get(KEY, {}) };
  if (!PLAYLIST[st.idx]) st.idx = 0;
  const save = () => store.set(KEY, { ...st, t: Math.floor(audio.currentTime || st.t || 0) });
  const audio = new Audio();
  audio.preload = 'auto';
  audio.volume = st.vol; audio.muted = st.muted;
  let errors = 0, blocked = false, duckTimer = 0;

  function load(i, at = 0) {
    st.idx = i; st.t = at;
    audio.src = PLAYLIST[i].src;
    if (at) audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = at; } catch { /* not seekable yet */ } }, { once: true });
    media(); paint(); save();
  }
  async function play() {
    st.on = true; save();
    if (!audio.src) load(st.idx, st.t);
    try { await audio.play(); blocked = false; } catch (e) { blocked = e?.name === 'NotAllowedError'; }
    paint();
  }
  function pause() { st.on = false; audio.pause(); save(); paint(); }
  function next() { load(nextIndex(st.idx, st)); if (st.on) play(); }
  function prev() { if (audio.currentTime > 5) { audio.currentTime = 0; return; } load(st.idx > 0 ? st.idx - 1 : PLAYLIST.length - 1); if (st.on) play(); }
  function mute(on = !st.muted) { st.muted = on; audio.muted = on; save(); paint(); }
  function volume(v) { st.vol = Math.max(0, Math.min(1, v)); audio.volume = st.vol; if (st.muted && v > 0) mute(false); save(); paint(); }
  /// lower the music while something else needs to be heard (a price alert)
  function duck(ms = 3500) {
    clearTimeout(duckTimer);
    audio.volume = st.vol * 0.2;
    duckTimer = setTimeout(() => { audio.volume = st.vol; }, ms);
  }

  audio.addEventListener('ended', () => { errors = 0; next(); });
  audio.addEventListener('playing', () => { errors = 0; blocked = false; paint(); });
  audio.addEventListener('pause', () => paint());
  audio.addEventListener('error', () => {
    // a missing or rate-limited file: skip it, but stop after a run of failures
    if (++errors >= 4) { st.on = false; paint('music could not load — try again later'); return; }
    setTimeout(next, 1200);
  });
  setInterval(() => { if (!audio.paused) save(); }, 5000);
  addEventListener('pagehide', save);

  // browsers refuse sound before the first click; start then if music is on
  // (not for clicks on the player itself, whose own buttons decide)
  const kick = (e) => { if (els.play.parentElement?.contains(e.target)) return; if (st.on && audio.paused) play(); };
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, kick, { capture: true });

  // media keys and the OS "now playing" panel
  function media() {
    if (!('mediaSession' in navigator)) return;
    const p = PLAYLIST[st.idx];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: p.part ? `${p.work} — ${p.part}` : p.work, artist: `${p.composer} · ${p.by}`, album: 'ShabbatLiquid' });
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', pause);
      navigator.mediaSession.setActionHandler('nexttrack', next);
      navigator.mediaSession.setActionHandler('previoustrack', prev);
    } catch { /* older browsers */ }
  }

  function paint(note = '') {
    const p = PLAYLIST[st.idx];
    const playing = !audio.paused;
    els.play.textContent = playing ? '❚❚' : '▶';
    els.play.title = playing ? 'pause the music (P)' : 'play classical music (P)';
    els.mute.textContent = st.muted || st.vol === 0 ? '🔇' : '🔊';
    els.mute.title = st.muted ? 'unmute' : 'mute';
    els.now.textContent = note || (st.on && blocked ? 'click anywhere to start the music' : trackTitle(p));
    els.now.title = trackTitle(p) + ' · ' + p.by;
    if (els.vol && document.activeElement !== els.vol) els.vol.value = st.vol;
    if (els.shuffle) els.shuffle.checked = st.shuffle;
    if (els.list) {
      els.list.innerHTML = PLAYLIST.map((x, i) => (st.composer !== 'all' && x.composer !== st.composer) ? '' : `
        <div class="mtrack ${i === st.idx ? 'on' : ''}" data-i="${i}">
          <div><b>${x.composer}</b> · ${x.work}${x.part ? ' — ' + x.part : ''}</div>
          <div class="dim">${x.by} · <a href="${x.page}" target="_blank" rel="noopener">${x.license}</a></div>
        </div>`).join('');
    }
    if (els.composers) {
      els.composers.innerHTML = ['all', ...COMPOSERS].map((c) => `<button data-c="${c}" class="${st.composer === c ? 'on' : ''}">${c === 'all' ? 'All' : c}</button>`).join('');
    }
  }

  els.play.onclick = () => (audio.paused ? play() : pause());
  els.next.onclick = next;
  els.mute.onclick = () => mute();
  if (els.vol) els.vol.oninput = () => volume(+els.vol.value);
  if (els.shuffle) els.shuffle.onchange = () => { st.shuffle = els.shuffle.checked; save(); };
  if (els.list) els.list.onclick = (e) => { if (e.target.closest('a')) return; const r = e.target.closest('[data-i]'); if (r) { load(+r.dataset.i); play(); } };
  if (els.composers) els.composers.onclick = (e) => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    st.composer = b.dataset.c; save();
    if (st.composer !== 'all' && PLAYLIST[st.idx].composer !== st.composer) next(); else paint();
  };

  load(st.idx, st.t);
  if (st.on) play();
  return { play, pause, next, prev, mute, volume, duck, toggle: () => (audio.paused ? play() : pause()), state: st, audio };
}
