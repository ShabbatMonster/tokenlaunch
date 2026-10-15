// Vanity CREATE2 mining - on the GPU when there is one, the CPU otherwise.
//
// A CREATE2 address is keccak256(0xff ++ deployer ++ salt ++ initCodeHash)[12:].
// That message is 85 bytes - one keccak block - so each attempt is a single
// keccak-f[1600] permutation. The GPU path runs it in a WebGPU compute shader,
// tens of millions of attempts per pass; the CPU path is a plain loop.
//
// The salt is laid out as  prefix(0..20) ++ random(20..24) ++ counter(24..32):
// a factory that requires the launcher's address at the front of the salt
// gets it, the random word makes every run search fresh ground, and the
// counter is what the threads step through.
//
// Every GPU hit is recomputed on the CPU with viem before it is returned. A
// shader that hashed wrongly cannot hand back a salt that misses the pattern;
// it fails loudly and the CPU finishes the job.

import { getContractAddress, getAddress, hexToBytes, bytesToHex } from 'viem';

/// "0000" (suffix), "dead…" (prefix) -> what an address must look like.
export function patternFrom({ suffix = '', prefix = '' }) {
  const s = suffix.toLowerCase().replace(/^0x/, ''), p = prefix.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]*$/.test(s) || !/^[0-9a-f]*$/.test(p)) throw new Error('the pattern must be hex characters');
  if (s.length + p.length > 40) throw new Error('the pattern is longer than an address');
  return { suffix: s, prefix: p, difficulty: 16 ** (s.length + p.length) };
}

export const matches = (address, pat) => {
  const a = address.toLowerCase().slice(2);
  return a.endsWith(pat.suffix) && a.startsWith(pat.prefix);
};

const saltOf = (prefix20, rand4, lo, hi) => {
  const b = new Uint8Array(32);
  b.set(prefix20, 0);
  b.set(rand4, 20);
  for (let i = 0; i < 4; i++) { b[24 + i] = (lo >>> (8 * i)) & 0xff; b[28 + i] = (hi >>> (8 * i)) & 0xff; }
  return bytesToHex(b);
};

// --- CPU -------------------------------------------------------------------------
/// saltFn, if given, maps the mined salt to the CREATE2 salt (for factories
/// that hash the salt with the sender first); only the CPU does that.
export async function mineCpu({ deployer, initCodeHash, saltPrefix, pattern, saltFn = null, maxTries = 50_000_000, onProgress, signal }) {
  const prefix20 = saltPrefix ? hexToBytes(saltPrefix).slice(0, 20) : crypto.getRandomValues(new Uint8Array(20));
  const rand4 = crypto.getRandomValues(new Uint8Array(4));
  const t0 = performance.now();
  for (let n = 0; n < maxTries; n++) {
    const salt = saltOf(prefix20, rand4, n >>> 0, Math.floor(n / 2 ** 32));
    const address = getContractAddress({ opcode: 'CREATE2', from: deployer, salt: saltFn ? saltFn(salt) : salt, bytecodeHash: initCodeHash });
    if (matches(address, pattern)) return { salt, address, tries: n + 1, ms: performance.now() - t0, engine: 'cpu' };
    if ((n & 0x3fff) === 0x3fff) {
      onProgress?.({ tries: n + 1, ms: performance.now() - t0, engine: 'cpu' });
      if (signal?.aborted) throw new Error('mining stopped');
      await new Promise((r) => setTimeout(r, 0));    // keep the page responsive
    }
  }
  throw new Error(`no match in ${maxTries.toLocaleString()} CPU attempts`);
}

// --- GPU ---------------------------------------------------------------------------
const RC = [
  '0000000000000001', '0000000000008082', '800000000000808a', '8000000080008000', '000000000000808b', '0000000080000001',
  '8000000080008081', '8000000000008009', '000000000000008a', '0000000000000088', '0000000080008009', '000000008000000a',
  '000000008000808b', '800000000000008b', '8000000000008089', '8000000000008003', '8000000000008002', '8000000000000080',
  '000000000000800a', '800000008000000a', '8000000080008081', '8000000000008080', '0000000080000001', '8000000080008008',
];
const RHO = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

const SHADER = /* wgsl */ `
struct Params {
  base_lo: u32, base_hi: u32, _p0: u32, _p1: u32,
  lanes: array<vec4<u32>, 9>,     // 17 message lanes as (lo, hi) pairs, packed two per vec4
  mask: array<vec4<u32>, 2>,      // 5 address words, as packed by the host
  want: array<vec4<u32>, 2>,
};
struct Found { flag: atomic<u32>, lo: u32, hi: u32, _p: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> F: Found;

const RC = array<vec2<u32>, 24>(${RC.map((h) => `vec2<u32>(0x${h.slice(8)}u, 0x${h.slice(0, 8)}u)`).join(', ')});
const RHO = array<u32, 25>(${RHO.map((r) => `${r}u`).join(', ')});

fn rotl(v: vec2<u32>, n: u32) -> vec2<u32> {
  if (n == 0u) { return v; }
  if (n == 32u) { return vec2<u32>(v.y, v.x); }
  if (n < 32u) { return vec2<u32>((v.x << n) | (v.y >> (32u - n)), (v.y << n) | (v.x >> (32u - n))); }
  let m = n - 32u;
  return vec2<u32>((v.y << m) | (v.x >> (32u - m)), (v.x << m) | (v.y >> (32u - m)));
}
fn lane(i: u32) -> vec2<u32> {
  let q = P.lanes[i / 2u];
  if ((i & 1u) == 0u) { return q.xy; }
  return q.zw;
}
fn word(a: array<vec4<u32>, 2>, i: u32) -> u32 { return a[i / 4u][i % 4u]; }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let idx = gid.x + gid.y * nwg.x * 256u;
  let lo = P.base_lo + idx;
  let hi = P.base_hi + select(0u, 1u, lo < P.base_lo);

  var a: array<vec2<u32>, 25>;
  for (var i = 0u; i < 17u; i++) { a[i] = lane(i); }
  for (var i = 17u; i < 25u; i++) { a[i] = vec2<u32>(0u, 0u); }
  // the counter is salt bytes 24..31 = message bytes 45..52, little-endian,
  // which straddle lanes 5 and 6
  a[5].y = a[5].y | ((lo & 0xffffffu) << 8u);
  a[6].x = a[6].x | (lo >> 24u) | ((hi & 0xffffffu) << 8u);
  a[6].y = a[6].y | (hi >> 24u);

  var c: array<vec2<u32>, 5>;
  var b: array<vec2<u32>, 25>;
  for (var r = 0u; r < 24u; r++) {
    for (var x = 0u; x < 5u; x++) { c[x] = a[x] ^ a[x + 5u] ^ a[x + 10u] ^ a[x + 15u] ^ a[x + 20u]; }
    for (var x = 0u; x < 5u; x++) {
      let d = c[(x + 4u) % 5u] ^ rotl(c[(x + 1u) % 5u], 1u);
      for (var y = 0u; y < 25u; y += 5u) { a[x + y] = a[x + y] ^ d; }
    }
    for (var x = 0u; x < 5u; x++) {
      for (var y = 0u; y < 5u; y++) {
        b[y + 5u * ((2u * x + 3u * y) % 5u)] = rotl(a[x + 5u * y], RHO[x + 5u * y]);
      }
    }
    for (var y = 0u; y < 25u; y += 5u) {
      for (var x = 0u; x < 5u; x++) {
        a[x + y] = b[x + y] ^ ((~b[(x + 1u) % 5u + y]) & b[(x + 2u) % 5u + y]);
      }
    }
    a[0] = a[0] ^ RC[r];
  }
  // address = hash bytes 12..31 = lane1.hi, lane2, lane3
  let w = array<u32, 5>(a[1].y, a[2].x, a[2].y, a[3].x, a[3].y);
  for (var i = 0u; i < 5u; i++) {
    if ((w[i] & word(P.mask, i)) != word(P.want, i)) { return; }
  }
  if (atomicCompareExchangeWeak(&F.flag, 0u, 1u).exchanged) { F.lo = lo; F.hi = hi; }
}`;

// message lanes for one keccak block: 0xff ++ deployer ++ salt(counter zeroed) ++ hash, padded
function messageLanes(deployer, prefix20, rand4, initCodeHash) {
  const m = new Uint8Array(136);
  m[0] = 0xff;
  m.set(hexToBytes(getAddress(deployer)), 1);
  m.set(prefix20, 21);
  m.set(rand4, 41);
  // bytes 45..52 (the counter) stay zero; the shader ORs them in
  m.set(hexToBytes(initCodeHash), 53);
  m[85] ^= 0x01;      // keccak (not SHA-3) padding
  m[135] ^= 0x80;
  const dv = new DataView(m.buffer);
  const out = new Uint32Array(36);
  for (let i = 0; i < 17; i++) { out[2 * i] = dv.getUint32(8 * i, true); out[2 * i + 1] = dv.getUint32(8 * i + 4, true); }
  return out;
}

// the pattern as masks over the 5 little-endian address words the shader reads
function patternWords(pat) {
  const mask = new Uint32Array(8), target = new Uint32Array(8);
  const want = '?'.repeat(40).split('');
  [...pat.prefix].forEach((ch, i) => { want[i] = ch; });
  [...pat.suffix].forEach((ch, i) => { want[40 - pat.suffix.length + i] = ch; });
  want.forEach((ch, j) => {
    if (ch === '?') return;
    const byte = j >> 1, word = byte >> 2, shift = (byte & 3) * 8 + ((j & 1) ? 0 : 4);
    mask[word] |= (0xf << shift) >>> 0;
    target[word] |= (parseInt(ch, 16) << shift) >>> 0;
  });
  return { mask, target };
}

export async function gpuAvailable() {
  try {
    if (!globalThis.navigator?.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const info = adapter.info || {};
    return { adapter, name: [info.vendor, info.architecture].filter(Boolean).join(' ') || 'GPU' };
  } catch { return null; }
}

export async function mineGpu({ deployer, initCodeHash, saltPrefix, pattern, maxTries = 2 ** 40, onProgress, signal }) {
  const gpu = await gpuAvailable();
  if (!gpu) throw new Error('no WebGPU adapter');
  const device = await gpu.adapter.requestDevice();
  try {
    const prefix20 = saltPrefix ? hexToBytes(saltPrefix).slice(0, 20) : crypto.getRandomValues(new Uint8Array(20));
    const rand4 = crypto.getRandomValues(new Uint8Array(4));
    const lanes = messageLanes(deployer, prefix20, rand4, initCodeHash);
    const { mask, target } = patternWords(pattern);

    const module = device.createShaderModule({ code: SHADER });
    const info = await module.getCompilationInfo?.();
    const errs = info?.messages?.filter((m) => m.type === 'error') || [];
    if (errs.length) throw new Error('shader did not compile: ' + errs.map((m) => m.message).join('; '));
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });

    const uniform = device.createBuffer({ size: 16 + 36 * 4 + 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const found = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: found } }] });

    const GROUPS_X = 4096, GROUPS_Y = 16;                 // 4096 * 16 * 256 = 16.7M attempts per pass
    const perPass = GROUPS_X * GROUPS_Y * 256;
    const params = new Uint32Array(4 + 36 + 16);
    params.set(lanes, 4);
    params.set(mask, 40);
    params.set(target, 48);
    device.queue.writeBuffer(found, 0, new Uint32Array(4));

    const t0 = performance.now();
    for (let done = 0; done < maxTries; done += perPass) {
      if (signal?.aborted) throw new Error('mining stopped');
      params[0] = done >>> 0;
      params[1] = Math.floor(done / 2 ** 32);
      device.queue.writeBuffer(uniform, 0, params);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(GROUPS_X, GROUPS_Y);
      pass.end();
      enc.copyBufferToBuffer(found, 0, read, 0, 16);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const r = new Uint32Array(read.getMappedRange().slice(0));
      read.unmap();
      onProgress?.({ tries: done + perPass, ms: performance.now() - t0, engine: 'gpu', gpu: gpu.name });
      if (r[0]) {
        const salt = saltOf(prefix20, rand4, r[1], r[2]);
        const address = getContractAddress({ opcode: 'CREATE2', from: deployer, salt, bytecodeHash: initCodeHash });
        // the CPU recomputes every GPU hit; a wrong shader can never pass a bad salt through
        if (!matches(address, pattern)) throw new Error(`GPU result failed CPU verification (${address})`);
        const tries = done + perPass;      // attempts searched, not the index of the hit
        return { salt, address, tries, ms: performance.now() - t0, engine: 'gpu', gpu: gpu.name };
      }
    }
    throw new Error(`no match in ${maxTries.toLocaleString()} GPU attempts`);
  } finally {
    device.destroy();
  }
}

/// Mine with the GPU if there is one, else the CPU. A GPU failure of any kind
/// falls back to the CPU rather than failing the launch.
export async function mineVanity(opts) {
  if (!opts.saltFn && await gpuAvailable()) {
    try { return await mineGpu(opts); }
    catch (e) {
      if (/stopped/.test(e.message)) throw e;
      opts.onProgress?.({ note: `GPU unavailable (${e.message}) - mining on the CPU instead` });
    }
  }
  return mineCpu(opts);
}
