// Build all three bundles. main.js/fees.js are browser-native (viem); solana.js
// pulls in web3.js + Anchor + Meteora, which need Node globals (Buffer/process/
// global) polyfilled for the browser. main.js loads ./solana.js at runtime via
// dynamic import, so it's marked external in the main build (kept as a runtime
// import of docs/solana.js rather than inlined).
import esbuild from 'esbuild';
import { createRequire } from 'module';
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill';

const require = createRequire(import.meta.url);

// Force every `buffer`/`process` import (ours AND deps') to the one real package.
// Runs before NodeModulesPolyfillPlugin so its (different) buffer never loads —
// two Buffer impls in one bundle causes "Argument must be a Buffer" when one
// impl's buffer is passed to the other's Buffer.prototype.equals.
const singleBufferProcess = {
  name: 'single-buffer-process',
  setup(build) {
    const bufferPath = require.resolve('buffer/');
    const processPath = require.resolve('process/browser.js');
    build.onResolve({ filter: /^buffer$/ }, () => ({ path: bufferPath }));
    build.onResolve({ filter: /^process$/ }, () => ({ path: processPath }));
  },
};

const minify = !process.argv.includes('--dev');
const base = { bundle: true, minify, format: 'esm', logLevel: 'info', target: 'es2020' };

await esbuild.build({
  ...base,
  entryPoints: ['src/main.js'],
  outfile: 'docs/app.js',
  external: ['./solana.js', './long.js'],
});

await esbuild.build({
  ...base,
  entryPoints: ['src/fees.js'],
  outfile: 'docs/fees.js',
});

await esbuild.build({
  ...base,
  entryPoints: ['src/force-migrate.js'],
  outfile: 'docs/force-migrate.js',
});

await esbuild.build({
  ...base,
  entryPoints: ['src/swap.js'],
  outfile: 'docs/swap.js',
});

await esbuild.build({
  ...base,
  entryPoints: ['src/openfour.js'],
  outfile: 'docs/openfour.js',
});

// long.xyz pad: pulls in the Doppler SDK, so it is its own lazily-imported
// bundle rather than bloating app.js
await esbuild.build({
  ...base,
  entryPoints: ['src/long.js'],
  outfile: 'docs/long.js',
  inject: ['src/node-shim.js'],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  plugins: [singleBufferProcess, NodeModulesPolyfillPlugin()],
});

// trade page: browser-native shell that lazy-imports the Solana bundle
await esbuild.build({
  ...base,
  entryPoints: ['src/trade.js'],
  outfile: 'docs/trade.js',
  external: ['./solana.js'],
});

await esbuild.build({
  ...base,
  entryPoints: ['src/solana.js'],
  outfile: 'docs/solana.js',
  // one consistent Buffer/process/global from node-shim.js, resolved through the
  // same node-modules polyfill every dep uses (see the shim for why)
  inject: ['src/node-shim.js'],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  plugins: [singleBufferProcess, NodeModulesPolyfillPlugin()],
});

// the browser-extension fallback for j7tracker's deploy panel. Same Solana
// stack as docs/solana.js, bundled into the extension's service worker - which
// is the only place the private key is ever read.
await esbuild.build({
  ...base,
  entryPoints: ['src/ext-launcher.js'],
  outfile: 'extension/vendor/launcher.js',
  inject: ['src/node-shim.js'],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  plugins: [singleBufferProcess, NodeModulesPolyfillPlugin()],
});

console.log('build complete');
