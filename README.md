# launcher

Bare-bones self-custody token launcher for launchpads. One page, no wallet popups:
paste your private key once, it's encrypted with your password (PBKDF2 + AES-256-GCM)
and stored only in your browser's localStorage. Signing happens client-side with viem;
the key never leaves the device — only signed transactions go out, straight to the RPC.

## Live pads

- **RobinFun · Robinhood Chain** (default, chain 4663, robinfun.live) — Noxa contract
  fork. Factory `0x52453b4289a6c3a70bb8b4682bcd3d8731267e28`, locker
  `0x173d8370B4F67535D406F2F46168ec48aa03d26E` (claims via `claimFees`). 0.0002 ETH
  launch fee + optional dev buy + gas, one tx.
- **Noxa · Robinhood Chain** (chain 4663, fun.noxa.fi) — factory
  `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB`, locker claims via `collectFees`.
  0.0005 ETH launch fee + optional dev buy + gas.

Both share the same `launchToken` ABI and the same launch buy curve.

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
