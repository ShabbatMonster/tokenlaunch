# launcher

Bare-bones self-custody token launcher for launchpads. One page, no wallet popups:
paste your private key once, it's encrypted with your password (PBKDF2 + AES-256-GCM)
and stored only in your browser's localStorage. Signing happens client-side with viem;
the key never leaves the device — only signed transactions go out, straight to the RPC.

## Live pads

- **Noxa · Robinhood Chain** (chain 4663) — calls `launchToken` on the factory at
  `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB`. Cost = 0.0005 ETH launch fee + optional
  dev buy + gas, all in one tx. Logo is uploaded to IPFS first.

More Noxa chains (Monad, MegaETH, …) share the same factory ABI — flip `enabled: true`
in `PADS` in `src/main.js` and add an RPC. Solana pads (pump.fun etc.) are stubbed in
the registry; the vault already stores a SOL key for when they're wired up.

## Dev

```
npm i
npm run dev     # watch build -> docs/app.js
npm run build   # minified build
```

Site is static, served from `docs/` (GitHub Pages).
