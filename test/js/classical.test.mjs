// The perps page's classical playlist (src/classical.js): every recording is
// free to use and credited, shuffle never repeats the piece just heard, and
// the composer filter is respected.
//   node test/js/classical.test.mjs           offline checks
//   node test/js/classical.test.mjs --live    also fetch the first bytes of every track (slow, paced for Wikimedia)
import { PLAYLIST, COMPOSERS, nextIndex, trackTitle } from '../../src/classical.js';

const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };

const FREE = new Set(['Public domain', 'CC0', 'CC BY 3.0']);
check(PLAYLIST.length >= 15 && PLAYLIST.every((p) => FREE.has(p.license)), 'every recording is public domain, CC0 or CC BY', `${PLAYLIST.length} tracks`);
check(PLAYLIST.filter((p) => p.license === 'CC BY 3.0').every((p) => p.by && p.page), 'CC BY recordings carry a credit and a licence link');
check(PLAYLIST.every((p) => /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/transcoded\/[0-9a-f]\/[0-9a-f]{2}\/[^/]+\/[^/]+\.mp3$/.test(p.src)), 'every track is a Wikimedia Commons MP3 transcode');
check(PLAYLIST.every((p) => p.page === 'https://commons.wikimedia.org/wiki/File:' + p.src.split('/')[8] && p.src.split('/')[9] === p.src.split('/')[8] + '.mp3'), 'licence page and stream name the same file');
check(new Set(PLAYLIST.map((p) => p.src)).size === PLAYLIST.length, 'no track is listed twice');
check(COMPOSERS[0] === 'Mozart' && COMPOSERS.length >= 6, 'Mozart first, and at least six composers', COMPOSERS.join(', '));
check(trackTitle(PLAYLIST[0]) === 'Mozart · Symphony No. 40 in G minor, K. 550 — I. Molto allegro', 'track titles read composer · work — movement');

{
  let ok = true;
  for (let i = 0; i < PLAYLIST.length; i++) for (const r of [0, 0.5, 0.999]) if (nextIndex(i, { rand: () => r }) === i) ok = false;
  check(ok, 'shuffle never picks the piece that just played');
  const seq = []; let i = 0; for (let k = 0; k < 30; k++) { i = nextIndex(i, { composer: 'Chopin', rand: Math.random }); seq.push(PLAYLIST[i].composer); }
  check(seq.every((c) => c === 'Chopin'), 'a composer filter only plays that composer');
  const firstBach = PLAYLIST.findIndex((p) => p.composer === 'Bach');
  check(nextIndex(firstBach, { shuffle: false }) === firstBach + 1 && nextIndex(PLAYLIST.length - 1, { shuffle: false }) === 0, 'in order: the next one, wrapping to the start');
}

if (process.argv.includes('--live')) {
  const UA = 'tokenlaunch-perps/1.0 (playlist check)';
  for (const p of PLAYLIST) {
    let r;
    for (let tries = 0; tries < 4; tries++) {
      // a timeout or a 429 is the network or Wikimedia's rate limit, not a bad file: wait and retry
      r = await fetch(p.src, { headers: { 'user-agent': UA, range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) }).catch(() => ({ status: 0 }));
      if (r.status && r.status !== 429) break;
      await new Promise((ok) => setTimeout(ok, 4000 * (tries + 1)));
    }
    const buf = r.arrayBuffer ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
    const mp3 = buf.subarray(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    check((r.status === 206 || r.status === 200) && mp3, 'streams: ' + trackTitle(p), String(r.status));
    await new Promise((ok) => setTimeout(ok, 1500));
  }
}
console.log('');
process.exit(fails.length ? 1 : 0);
