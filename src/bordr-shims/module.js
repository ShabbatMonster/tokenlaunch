// Shim for node:module createRequire in @bordrless/sdk/dist/coders.js.
// coders.js does require("../idl/<name>.json"); map those to bundled JSON.
import idl0 from '../../node_modules/@bordrless/sdk/idl/bordrless_bridge.json';
import idl1 from '../../node_modules/@bordrless/sdk/idl/bordrless_companion.json';
import idl2 from '../../node_modules/@bordrless/sdk/idl/bordrless_kit.json';
import idl3 from '../../node_modules/@bordrless/sdk/idl/bordrless_launch.json';
import idl4 from '../../node_modules/@bordrless/sdk/idl/bordrless_router.json';
import idl5 from '../../node_modules/@bordrless/sdk/idl/bordrless_swap.json';
import idl6 from '../../node_modules/@bordrless/sdk/idl/bordrless_token.json';
import idl7 from '../../node_modules/@bordrless/sdk/idl/half_life.json';
import idl8 from '../../node_modules/@bordrless/sdk/idl/hook_timelock.json';
import idl9 from '../../node_modules/@bordrless/sdk/idl/hook_vault.json';
import idl10 from '../../node_modules/@bordrless/sdk/idl/loss_cover_hook.json';
import idl11 from '../../node_modules/@bordrless/sdk/idl/loss_cover_script.json';
import idl12 from '../../node_modules/@bordrless/sdk/idl/lottery_hook.json';
import idl13 from '../../node_modules/@bordrless/sdk/idl/rules_hook.json';
import idl14 from '../../node_modules/@bordrless/sdk/idl/tax_hook.json';
const MAP = {
  'bordrless_bridge.json': idl0,
  'bordrless_companion.json': idl1,
  'bordrless_kit.json': idl2,
  'bordrless_launch.json': idl3,
  'bordrless_router.json': idl4,
  'bordrless_swap.json': idl5,
  'bordrless_token.json': idl6,
  'half_life.json': idl7,
  'hook_timelock.json': idl8,
  'hook_vault.json': idl9,
  'loss_cover_hook.json': idl10,
  'loss_cover_script.json': idl11,
  'lottery_hook.json': idl12,
  'rules_hook.json': idl13,
  'tax_hook.json': idl14,
};
export function createRequire() {
  return (p) => { const name = String(p).split(/[/]/).pop(); if (MAP[name]) return MAP[name]; throw new Error('bordr require shim: no ' + p); };
}
export default { createRequire };
