// The WebGPU vanity miner, run on the real GPU in headless Chrome.
//
// src/vanity.js is bundled, served from 127.0.0.1 (WebGPU needs a secure
// origin) and asked to mine suffixes, a prefix+suffix, and a launcher-prefixed
// salt. Every salt it returns is recomputed here in Node with viem - an answer
// the shader got wrong cannot pass. Skips (exit 0) when there is no Chrome or
// no GPU adapter.
//
// Run: node test/js/vanity-gpu.test.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import esbuild from 'esbuild';
import { getContractAddress } from 'viem';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome']
  .find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP  no Chrome to run WebGPU in'); process.exit(0); }

const fails = [];
const check = (ok, label, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : ''));
  if (!ok) fails.push(label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = await esbuild.build({ entryPoints: [path.join(import.meta.dirname, '..', '..', 'src', 'vanity.js')], bundle: true, format: 'iife', globalName: 'V', write: false, logLevel: 'silent' });
const js = out.outputFiles[0].text;
const server = http.createServer((req, res) => {
  if (req.url === '/v.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(js); return; }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><script src="/v.js"></script>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}/`;

const port = 9300 + Math.floor(Math.random() * 500);
const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'vgpu-'));
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
const done = (code) => { try { proc.kill(); } catch {} server.close(); process.exit(code); };
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try { ws = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
  if (!ws) await sleep(250);
}
if (!ws) { console.log('SKIP  Chrome did not start'); done(0); }
const sock = new WebSocket(ws);
await new Promise((r) => { sock.onopen = r; });
let id = 0;
const pend = new Map();
sock.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => { try { return JSON.stringify(await (${expr})); } catch (e) { return JSON.stringify({ error: e.message }); } })()` });
  return JSON.parse(r.result?.result?.value ?? '{"error":"no result"}');
};
await send('Page.navigate', { url: site });
await sleep(1500);

const gpu = await ev(`V.gpuAvailable().then((g) => g && g.name)`);
if (!gpu || gpu.error) { console.log('SKIP  no WebGPU adapter in this browser'); done(0); }
console.log(`      GPU: ${gpu}`);

const deployer = '0xe0CbeFB318A7CDbCe6330dC7FAB6FADc679CD6D1';
const initCodeHash = '0x7dc06de8c9bba94ba4cee8aa2cdc1ed829038c2492f297224caf08a6ce1886ea';
const ME = '0x2222222222222222222222222222222222225678';
const cases = [
  { suffix: '0' }, { suffix: 'ab' }, { suffix: '777' }, { suffix: '0000' }, { suffix: '000000' },
  { prefix: 'dead', suffix: '00' }, { suffix: '0000', saltPrefix: ME },
];
for (const c of cases) {
  const r = await ev(`V.mineGpu({ deployer: '${deployer}', initCodeHash: '${initCodeHash}', saltPrefix: ${c.saltPrefix ? `'${c.saltPrefix}'` : 'null'}, pattern: V.patternFrom(${JSON.stringify({ suffix: c.suffix || '', prefix: c.prefix || '' })}), maxTries: 2 ** 32 })`);
  if (r.error) { check(false, `GPU mines ${JSON.stringify(c)}`, r.error); continue; }
  const addr = getContractAddress({ opcode: 'CREATE2', from: deployer, salt: r.salt, bytecodeHash: initCodeHash }).toLowerCase();
  const ok = addr === r.address.toLowerCase() && addr.endsWith(c.suffix || '') && addr.slice(2).startsWith(c.prefix || '')
    && (!c.saltPrefix || r.salt.toLowerCase().startsWith(c.saltPrefix.toLowerCase()));
  check(ok && r.engine === 'gpu', `GPU mines ${c.prefix ? c.prefix + '…' : '…'}${c.suffix}${c.saltPrefix ? ' with the launcher at the front of the salt' : ''}, and Node agrees`, `${r.address} in ${(r.ms / 1000).toFixed(2)}s`);
}

// throughput, for the record: a 7-character pattern is ~268M attempts
const big = await ev(`V.mineGpu({ deployer: '${deployer}', initCodeHash: '${initCodeHash}', pattern: V.patternFrom({ suffix: '0000000' }) })`);
if (!big.error) {
  const addr = getContractAddress({ opcode: 'CREATE2', from: deployer, salt: big.salt, bytecodeHash: initCodeHash });
  check(addr.toLowerCase().endsWith('0000000'), 'a 7-zero ending is mined on the GPU', `${addr} · ${(big.tries / big.ms / 1000).toFixed(0)}M attempts/s`);
} else check(false, 'a 7-zero ending is mined on the GPU', big.error);

// mineVanity picks the GPU when there is one
const auto = await ev(`V.mineVanity({ deployer: '${deployer}', initCodeHash: '${initCodeHash}', pattern: V.patternFrom({ suffix: '0000' }) })`);
check(auto.engine === 'gpu', 'mineVanity uses the GPU when one is available', auto.engine || auto.error);

console.log('');
sock.close();
done(fails.length ? 1 : 0);
