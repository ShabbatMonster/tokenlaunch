// StonkFun "arm for approval": the helpers that watch a quote's LaunchpadConfig
// and pre-warm the launch. Live (skips without RPC); the config check is the
// gate the arm loop polls - it is true for an admitted quote, false otherwise.
//   node test/js/raydium-arm.test.mjs
import fs from 'node:fs'; import path from 'node:path';
import { Keypair } from '@solana/web3.js'; import bs58 from 'bs58';
import { raydiumConfigId, raydiumConfigExists, loadRaydiumClient, raydiumQuoteInfo } from '../../src/solana.js';
const RPC = process.env.RPC || process.env.SOL_RPC;
const fails = [];
const check = (ok, label, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  — ' + detail : '')); if (!ok) fails.push(label); };
const SOL = 'So11111111111111111111111111111111111111112';

// pure + wiring checks run without RPC
check(raydiumConfigId(SOL).toBase58() === '6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX', 'the config PDA for a quote is derived deterministically');
const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'index.html'), 'utf8');
check(/async function armRaydium/.test(MAIN) && /raydiumConfigExists/.test(MAIN), 'the pad has an arm flow that polls the config');
check(/raydiumInputsSig\(a\.pad\) !== a\.sig \|\| logoBlob !== a\.logoBlob/.test(MAIN), 'and disarms when the token (any field or the image) changes');
check(/client, mintBInfo/.test(MAIN) && /loadRaydiumClient/.test(MAIN), 'firing reuses a pre-warmed Raydium client and pre-fetched quote info');
check(HTML.includes('id="raydiumArmBtn"') && HTML.includes('id="raydiumArmPoll"'), 'with an ARM button and a poll interval in the UI');

if (!RPC) { console.log('SKIP  set RPC=<url> for the live config checks'); process.exit(fails.length ? 1 : 0); }
check(await raydiumConfigExists(RPC, SOL), 'an admitted quote (SOL) reads as approved');
check(!(await raydiumConfigExists(RPC, Keypair.generate().publicKey.toBase58())), 'a random mint reads as not approved (the loop keeps watching)');
const client = await loadRaydiumClient(RPC, bs58.encode(Keypair.generate().secretKey));
const info = await raydiumQuoteInfo(client, SOL).catch(() => null);
check(info?.decimals === 9, 'the client + quote info pre-warm works', `SOL decimals ${info?.decimals}`);
console.log('');
process.exit(fails.length ? 1 : 0);
