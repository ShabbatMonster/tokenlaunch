# launcher

Bare-bones self-custody token launcher for launchpads. One page, no wallet popups:
paste your private key once, it's encrypted with your password (PBKDF2 + AES-256-GCM)
and stored only in your browser's localStorage. Signing happens client-side with viem;
the key never leaves the device — only signed transactions go out, straight to the RPC.

## Live pads

- **Ours · Robinhood Chain** (default, chain 4663) — our own factory,
  `contracts/LaunchFactory.sol`, deployed at
  `0x159331ec96486EC926403e504E6FCf217d6008AB`. Arbitrary token supply, 0 launch
  fee, single-sided V3 liquidity, no transfer restrictions. Factory is its own
  locker (`claimFees`). Full flow fork-tested (`forge test --fork-url …`) and
  proven with a live mainnet launch.
  - **Testing config:** trading fees are 100% to `0xbE8a…04dA`; owner is the
    deployer key so the split is adjustable without the main wallet. To finalize
    (e.g. 90/10) and lock control, `setProtocolFee(<bps>)` then
    `transferOwnership(0xbE8a…04dA)` from the deployer.
  - (Prior 90/10 deploy `0xcEdA…c795` is now retired.)
- **RobinFun · Robinhood Chain** (chain 4663, robinfun.live) — Noxa contract
  fork. Factory `0x52453b4289a6c3a70bb8b4682bcd3d8731267e28`, locker
  `0x173d8370B4F67535D406F2F46168ec48aa03d26E` (claims via `claimFees`). 0.0002 ETH
  launch fee + optional dev buy + gas, one tx.
- **Noxa · Robinhood Chain** (chain 4663, fun.noxa.fi) — factory
  `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB`, locker claims via `collectFees`.
  0.0005 ETH launch fee + optional dev buy + gas.

Both share the same `launchToken` ABI and the same launch buy curve.

## Pending pads

## Rialto · Stocks (live)

[varo.rialto.xyz](https://varo.rialto.xyz), chain 4663 — pair your token against a
**tokenized stock/ETF** (NVDA, SPCX) or WETH/USDG instead of ETH. Pick the pair in
the "PAIR AGAINST" dropdown (populated live from `GET /api/v1/config`).

Rialto is a **permissioned** launchpad, not an open factory — reverse-engineered from
the live web app bundle. A launch is a Rialto-signed *intent*; the whole flow the app
drives:

1. **SIWE auth** — `POST /auth/challenge {wallet}` → sign the message with the imported
   key → `POST /auth/verify {wallet,signature,nonce}` → JWT.
2. **Image** — `POST /assets/images` (multipart) → hosted URL (skips IPFS for Rialto).
3. **Signed intent** — `POST /intents/create-token {name,symbol,image_uri,quote_token,
   fee_recipients,request_id}` → `{ signature, valid_after, valid_before, transaction }`.
   The pool economics (tick, sqrtPrice, supply) are computed server-side per quote token
   and baked into the signed intent; authorized by Rialto's backend signer and valid ~6 min.
4. **Submit** — send the returned `transaction` (to = intent executor
   `0x1FaE6f16…dAd4Ecb`) from the wallet. On-chain:
   `executeLaunch(params, authorization, signature)` → `(token, locker)`. Launchpad
   `0x851153fe…20a6d0b8`.

The full flow (auth → upload → signed intent) is verified end-to-end against the live
API. Fee claiming isn't wired (Rialto uses per-launch lockers, not the Noxa
`claimFees`/`collectFees` model), so launches don't appear under "MY TOKENS · CLAIM
FEES" for this pad.

## Pending pads

- **Pons v2** ([docs.ponsfamily.com/v2](https://docs.ponsfamily.com/v2)) — wired up
  but `enabled: false`: v2 contract addresses aren't published yet (three audits in
  progress; docs say treat as unaudited until reports close). Different family from
  Noxa: `launchToken(params, launchConfigId, pairToken)` with an economics pin from
  `previewLaunchEconomics()`, optional `creatorTaxBps` (capped by
  `maxCreatorTaxBps()`), dev buys as a separate `buy()` on the returned bonding
  curve, and fee claims through the Fee Escrow (`claim()` native /
  `claimToken(addr)` ERC-20) instead of a per-token locker. To go live, fill in
  `factory`/`escrow`/`rpc`/`startBlock` on the `pons-v2` entry in `src/main.js`,
  diff `PONS_FACTORY_ABI` against the published ABI, and flip `enabled`.
  Integration/testnet contact: contact@ponsfamily.com.

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
