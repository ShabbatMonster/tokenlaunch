# pump migrate

A Chrome extension that puts a **MIGRATE** button on a coin's page on
[axiom.trade](https://axiom.trade). Click it, and a panel tells you what state the
coin is in — read off the chain, not off the page. On pump.fun you can also type a
buy amount and take the **first buy off the migration, in the same transaction**.

A bonding curve that fills does not migrate itself. The venue's own keeper normally
cranks it within seconds; when it doesn't, the coin sits there untradeable with
everything it raised locked in the curve. This is for those.

> The j7tracker deploy fallback that used to live here has been removed. The
> extension now does one job.

## Install

1. `npm run build` in the repo root (this writes `extension/vendor/launcher.js`).
2. `chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.
3. Open the extension's options and press **import from launcher**, or paste a
   Solana key. The key is stored by the extension and read only by its service
   worker.

## Venues

| venue | migrate | first buy | why |
| --- | --- | --- | --- |
| **pump.fun** | yes | **yes** | `migrate_v2` is permissionless; the buy rides in the same transaction |
| **Meteora DBC** | yes | not yet | `migration_damm_v2` is permissionless — simulated clean from an address that is neither the creator nor the fee claimer |
| **Raydium LaunchLab** | **no** | no | permissioned — see below |

### Raydium LaunchLab cannot be migrated

`migrate_to_cpswap` takes no arguments and declares no admin account, so it reads
as permissionless. It isn't. Replaying a real migration with only the payer
swapped, everything else identical, gets:

```
AnchorError caused by account: payer. Error Code: InvalidOwner. Error Number: 6001.
Left:  Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS   (our payer)
Right: RAYpQbFNq9i3mu6cKpTKKRwwHFDeK5AuZz8xvxUrCgw    (what it wants)
```

The program names the address it requires, and that address is Raydium's own
migrator — 15 of 15 sampled migrations were signed by it. There is no rescue path
and no delay after which it opens up, unlike Pons. So the panel diagnoses a
LaunchLab coin and offers no button, because a button would fail every time.

### Meteora's first buy is not wired yet

A DBC migration opens a **DAMM v2** pool, which is a different program from
PumpSwap with its own swap encoding. The migration works; the buy does not carry
over, and the buy box hides itself on that venue rather than offering something
that would fail.

## How it finds the contract address

It does not trust a selector. Axiom's markup is theirs and will change, so the
address is gathered from everywhere it could be — explorer links, the URL, any text
shaped like base58, data attributes — and the **service worker decides which
candidate is real by asking the chain** which venue it belongs to. Being wrong
about the DOM is therefore cheap and self-correcting.

Addresses ending in `pump` are tried first, because that is pump.fun's own vanity
suffix, but every other candidate is still offered: the chain has the final say.

## Where the button goes

Next to Axiom's own **VAMP** button, found by its label rather than a class name.
If no such button is on the page it floats in the top right instead. Either way you
can drag it, and it remembers where you put it.

React owns that row and re-renders it, which silently removes anything we put
inside, so the button re-mounts itself on a timer. The panel is a separate
fixed-position element rather than a child of the button, so an ancestor with
`overflow: hidden` cannot clip it. The button is also built and attached before
anything is awaited — an earlier version read a stored position first, so any
hiccup in `chrome.storage` meant no button at all.

## What the panel tells you

| state | means |
| --- | --- |
| READY TO MIGRATE | the curve has filled, no pool exists, and the call simulates |
| STILL ON THE CURVE | not full yet |
| ALREADY MIGRATED | somebody beat you to it, or it never needed you |
| BLOCKED | it does not simulate; the reason is the program's own |

On pump.fun the fill under the amount box is **measured, not estimated**: the
worker simulates the real buy and reads how much base actually arrives. Constant
product over the pool's vaults — the obvious formula — overpredicted a live fill by
16.7x, so no formula is used.

## Route (pump.fun only)

One transaction by default. It lands at about 1210 of the 1232 bytes a transaction
may be, so when a coin's shape does not fit it goes as a **Jito bundle** instead —
migrate first, buy second, one slot, all or nothing. You can also force the bundle.
Tip accounts are fetched from the block engine rather than hardcoded, because Jito
rotates them and a tip to a stale address is a tip to nobody.

## The key

The key lives in the service worker. `axiom.js` never names it, never imports the
signing code, and speaks four message types: `pm:resolve`, `pm:preview`,
`pm:migrate`, and a status channel back. A page that turns hostile can at worst
watch you press a button you were already pressing. The one control that spends
money also refuses untrusted clicks, so a script on the page cannot press it.

## Test

```
node extension/test/axiom.test.mjs
```

Runs the real address scraper against mock pages that look nothing like each other,
and asserts the mount order, the venue handling and the security properties at the
source level.
