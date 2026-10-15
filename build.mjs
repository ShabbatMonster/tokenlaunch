// Build all three bundles. main.js/fees.js are browser-native (viem); solana.js
// pulls in web3.js + Anchor + Meteora, which need Node globals (Buffer/process/
// global) polyfilled for the browser. main.js loads ./solana.js at runtime via
// dynamic import, so it's marked external in the main build (kept as a runtime
// import of docs/solana.js rather than inlined).
import esbuild from 'esbuild';
import fs from 'node:fs';
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

// pump.fun migration: web3.js, so it needs the same Node-globals treatment as
// the solana bundle rather than the plain browser one
await esbuild.build({
  ...base,
  entryPoints: ['src/pumpMigrate-page.js'],
  outfile: 'docs/pump-migrate.js',
  inject: ['src/node-shim.js'],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  plugins: [singleBufferProcess, NodeModulesPolyfillPlugin()],
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

// Arc swap page: plain viem, its own bundle
await esbuild.build({
  ...base,
  entryPoints: ['src/arcswap-page.js'],
  outfile: 'docs/arc.js',
});

// Bordrless coordinated-sell page: web3.js + @bordrless/sdk, so the same
// Node-globals treatment as the Solana bundle. @bordrless/shared ships only a
// dist but its package.json points main at a src it does not publish, so fix
// that in node_modules before bundling (reset by any reinstall).
for (const pkg of ['shared', 'sdk']) {
  const p = `node_modules/@bordrless/${pkg}/package.json`;
  if (!fs.existsSync(p)) continue;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const fix = (s) => (typeof s === 'string' ? s.replace('./src/index.ts', './dist/index.js') : s);
  const fixt = (s) => (typeof s === 'string' ? s.replace('./src/index.ts', './dist/index.d.ts') : s);
  j.main = fix(j.main); j.types = fixt(j.types);
  if (j.exports) for (const k of Object.keys(j.exports)) {
    const v = j.exports[k];
    if (typeof v === 'string') j.exports[k] = k.includes('types') ? fixt(v) : fix(v);
    else if (v && typeof v === 'object') for (const kk of Object.keys(v)) v[kk] = kk.includes('types') ? fixt(v[kk]) : fix(v[kk]);
  }
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
}
// The SDK reaches for three Node things the polyfill does not cover: a
// createRequire that loads its IDL JSON, crypto.createHash('sha256'), and a
// default export from @anchor-lang/core (which has only named ones). Shim each.
const require2 = createRequire(import.meta.url);
const bordrShims = {
  name: 'bordr-shims',
  setup(b) {
    b.onResolve({ filter: /^(node:)?module$/ }, () => ({ path: require2.resolve('./src/bordr-shims/module.js') }));
    b.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: require2.resolve('./src/bordr-shims/crypto.js') }));
    b.onResolve({ filter: /^@anchor-lang\/core$/ }, () => ({ path: require2.resolve('./src/bordr-shims/anchor-default.js') }));
  },
};
await esbuild.build({
  ...base,
  entryPoints: ['src/bordrSell-page.js'],
  outfile: 'docs/bordr-sell.js',
  inject: ['src/node-shim.js'],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  loader: { '.json': 'json' },
  plugins: [bordrShims, singleBufferProcess, NodeModulesPolyfillPlugin()],
});

console.log('build complete');
