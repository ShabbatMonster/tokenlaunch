// @anchor-lang/core ships named exports but no default; the Bordrless SDK does
// `import anchor from '@anchor-lang/core'`. Re-export the namespace as default.
import * as ns from '@anchor-lang/core/dist/browser/index.js';
export * from '@anchor-lang/core/dist/browser/index.js';
export default ns;
