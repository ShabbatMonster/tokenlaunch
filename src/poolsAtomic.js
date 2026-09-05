// AUTO-GENERATED launch builder for the "Pools" launchpad on the CANONICAL
// LiquidityLauncher 0x0000ffff… — the one Axiom + gmgn both label "pools".
// A launch is launcher.multicall([createToken, distributeToken, distributeWithNative]).
//   createToken (recipient=launcher) mints the UERC20,
//   distributeToken(strategy 0x23f8… ) opens a fee-2500 / tickSpacing-25 v4 pool,
//   distributeWithNative(strategy 0x1242… , nativeAmount) does the ATOMIC dev buy.
// The DWN configData is templated from a real launch (tx 0xba8169d4…); we substitute
// the token, creator and buy amount. Validated live end-to-end. See buildPoolsLaunch().
import { encodeAbiParameters, encodeFunctionData } from 'viem';

export const POOLS_LAUNCHER      = '0x0000ffffbe8efe702c8703ae3477ff5de3d319c0';
export const POOLS_FACTORY       = '0x000000e200088D55C39a11F609E5F667729ad49b';
export const POOLS_POOL_STRATEGY = '0x23f8209572b4a1C2AD88A42749E830791Fb027f1'; // opens the tickSpacing-25 pool
export const POOLS_BUY_STRATEGY  = '0x1242c9439d589cAE85E121B1f79f2aF51e91DCEE'; // native dev-buy leg
const SUPPLY = 1000000000000000000000000000n; // 1e27
// distributeWithNative configData template (41 words). Substitution slots:
//   deadline @7 (MUST be refreshed — the template's is long expired) · token @24,38
//   · creator @2,39 · nativeAmount @29,36 · minOut @30(=0, atomic ⇒ no front-run)
const DWN_TEMPLATE = '00000000000000000000000000000000000000000000000000000000000000200000000000000000000000008876789976decbfcbbbe364623c63652db8c09040000000000000000000000002db02f4878b640f746321dfa1f4d8fec1f35da3600000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000480000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006a76506000000000000000000000000000000000000000000000000000000000000000011000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000380000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060c0e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000180000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007166ac8ba8ec4b9399ed7532ba161cea70308c0d00000000000000000000000000000000000000000000000000000000000009c4000000000000000000000000000000000000000000000000000000000000001900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000005a34f9affd7acb000000000000000000000000000000000000000000084595161401484b8baa7e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005a34f9affd7acb00000000000000000000000000000000000000000000000000000000000000600000000000000000000000007166ac8ba8ec4b9399ed7532ba161cea70308c0d0000000000000000000000002db02f4878b640f746321dfa1f4d8fec1f35da360000000000000000000000000000000000000000000000000000000000000000';

const CT_ABI  = [{ name:'createToken', type:'function', stateMutability:'payable', inputs:[{type:'address'},{type:'string'},{type:'string'},{type:'uint8'},{type:'uint128'},{type:'address'},{type:'bytes'}], outputs:[{type:'address'}] }];
const DT_ABI  = [{ name:'distributeToken', type:'function', stateMutability:'payable', inputs:[{type:'address'},{type:'tuple',components:[{type:'address'},{type:'uint128'},{type:'bytes'}]},{type:'bytes32'}], outputs:[] }];
const DWN_ABI = [{ name:'distributeWithNative', type:'function', stateMutability:'payable', inputs:[{type:'address'},{type:'bytes'},{type:'bytes32'},{type:'uint256'}], outputs:[] }];
const MC_ABI  = [{ name:'multicall', type:'function', stateMutability:'payable', inputs:[{type:'bytes[]'}], outputs:[{type:'bytes[]'}] }];
const TD_TUPLE = [{ type:'tuple', components:[{type:'string'},{type:'string'},{type:'string'},{type:'bytes'}] }];

const aw = (a) => '0'.repeat(24) + a.toLowerCase().replace('0x','');
const nw = (n) => BigInt(n).toString(16).padStart(64,'0');
const setW = (hex,i,w) => hex.slice(0,i*64) + w + hex.slice((i+1)*64);

// tokenData tuple -> tokenURI JSON: slot0=description, slot1=website, slot2=image.
export function buildPoolsTokenData({ logo, description, link } = {}) {
  return encodeAbiParameters(TD_TUPLE, [[description || '', link || '', logo || '', '0x']]);
}

// Build the launcher.multicall calldata for a Pools launch. devBuy>0 (wei) appends
// the atomic native dev-buy leg; devBuy=0 launches the pool only. tokenData from
// buildPoolsTokenData; token is the predicted UERC20 (getUERC20Address). msg.value must == devBuy.
export function buildPoolsLaunch({ name, symbol, tokenData, token, creator, devBuy, dtSalt, dwnSalt }) {
  const call0 = encodeFunctionData({ abi: CT_ABI, functionName: 'createToken', args: [POOLS_FACTORY, name, symbol, 18, SUPPLY, POOLS_LAUNCHER, tokenData || '0x'] });
  const configData = encodeAbiParameters([{ type: 'address' }], [creator]);
  const call1 = encodeFunctionData({ abi: DT_ABI, functionName: 'distributeToken', args: [token, [POOLS_POOL_STRATEGY, SUPPLY, configData], dtSalt] });
  const calls = [call0, call1];
  if (devBuy && devBuy > 0n) {
    let cfg = DWN_TEMPLATE;
    cfg = setW(cfg,7,nw(BigInt(Math.floor(Date.now() / 1000) + 1800))); // FRESH deadline (+30min); the template's expired
    cfg = setW(cfg,24,aw(token)); cfg = setW(cfg,38,aw(token));
    cfg = setW(cfg,2,aw(creator)); cfg = setW(cfg,39,aw(creator));
    cfg = setW(cfg,29,nw(devBuy)); cfg = setW(cfg,36,nw(devBuy));
    cfg = setW(cfg,30,nw(0n)); // minOut 0
    const call2 = encodeFunctionData({ abi: DWN_ABI, functionName: 'distributeWithNative', args: [POOLS_BUY_STRATEGY, '0x'+cfg, dwnSalt, devBuy] });
    calls.push(call2);
  }
  return encodeFunctionData({ abi: MC_ABI, functionName: 'multicall', args: [calls] });
}

// sanity: template is 41 words and the substitution slots are where we expect
export function selfTestPoolsLaunch() {
  if (DWN_TEMPLATE.length !== 41*64) throw new Error('poolsLaunch: DWN template wrong length');
  if (BigInt('0x'+DWN_TEMPLATE.slice(25*64,26*64)) !== 2500n) throw new Error('poolsLaunch: fee slot moved');
  if (BigInt('0x'+DWN_TEMPLATE.slice(26*64,27*64)) !== 25n) throw new Error('poolsLaunch: tickSpacing slot moved');
  return true;
}
