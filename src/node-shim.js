// Injected at the top of the Solana bundle (build.mjs). Provides the Node
// globals web3.js/Anchor/bn.js expect in the browser. Buffer is imported from
// the `buffer` module so it goes through the SAME node-modules polyfill every
// other dep resolves `buffer` to — one consistent Buffer implementation, which
// avoids the cross-implementation "Argument must be a Buffer" failures the
// node-globals-polyfill Buffer caused.
import { Buffer as _Buffer } from 'buffer';

globalThis.Buffer = globalThis.Buffer || _Buffer;
globalThis.global = globalThis;
globalThis.process = globalThis.process || {
  env: { NODE_ENV: 'production' },
  browser: true,
  version: '',
  versions: {},
  nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)),
};

export { _Buffer as Buffer };
