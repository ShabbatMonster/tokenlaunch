// Minimal `node:crypto` for the browser: the Bordrless SDK only needs
// createHash('sha256').update(bytes).digest('hex'|buffer).
import { sha256 } from '@noble/hashes/sha256';
import { Buffer as _Buffer } from 'buffer';
export function createHash(algo) {
  if (algo !== 'sha256') throw new Error('crypto shim: only sha256 is supported, got ' + algo);
  const chunks = [];
  return {
    update(data) { chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : Uint8Array.from(data)); return this; },
    digest(enc) {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const buf = new Uint8Array(total);
      let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
      const out = sha256(buf);
      if (enc === 'hex') return _Buffer.from(out).toString('hex');
      return _Buffer.from(out);
    },
  };
}
export function randomBytes(n) {
  const b = new Uint8Array(n);
  (globalThis.crypto || globalThis.msCrypto).getRandomValues(b);
  return _Buffer.from(b);
}
export default { createHash, randomBytes };
