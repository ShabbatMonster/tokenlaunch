# j7 deploy fallback

A Chrome/Edge extension that sits on **j7tracker.io**'s Token Deploy panel, mirrors
whatever you have set up there, and finishes the launch itself when j7 can't — a
timeout, an expired blockhash, an error toast, or j7 simply never confirming.

You set `$POOP — Poopcoin` up on j7 with an image and a dev buy, press Deploy, and
if j7 falls over, the bar covers the error and launches the same coin through this
repo's own launch path instead.

## Install

```
node build.mjs          # writes extension/vendor/launcher.js
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.

Open the extension's **Options** and:

1. paste your Solana private key (base58), or press **IMPORT FROM LAUNCHER** to
   reuse the one the launcher already has in this browser,
2. tick **Armed**,
3. leave **Fire automatically** off until you've watched it mirror a panel correctly at least once.

## The button in j7's toolbar

A **FALLBACK** button with its own buy-amount box is injected into j7's own
toolbar, next to its Panel control, so it is already under your hand when a
deploy dies. The unit follows the pad — SOL for Pump/BONK/Stonk, ETH for the
Robinhood-chain pads, BNB for Flap and four.meme.

It takes two clicks (the second says `FIRE?`) so a stray click in a dense
toolbar can't spend money — **except** once j7 has actually failed, when it
pre-arms itself and taking over is the single click it should be.

Type an amount in its box and that number is what launches; it stops mirroring
j7's field until the launch is done, so clicking the button can't quietly
restore the old size.

Press **⇱** on the bar to move the button somewhere else, then click where it
should sit. The bar itself you drag by its header — it remembers where you put
it and stays on screen if the window changes size.

## Which pad it thinks is selected

This is the one that must not guess, because a wrong answer launches on the
wrong chain. It used to fall through to the first pad in the DOM — Pump — when
it could not tell, so a Robinhood-chain coin could have gone to pump.fun.

Now it compares every pad chip's computed style against the others and takes the
odd one out, after first honouring any explicit `aria-pressed` / `data-state` /
`active` class. If nothing distinguishes them it says so and **refuses to
launch** rather than picking one. Type the pad into the bar to override, and
whatever you type sticks until the launch is done.

## Why a launch used to take ten seconds

Not the transaction — the setup before it. Three reads that have nothing to do
with your coin (pump's global config, the quote, the address lookup table) plus
pinning the metadata, all on the critical path after you clicked.

- **the setup is pre-read** while you fill the panel in and handed to the
  launch, so a warm launch starts at its simulation.
- **the metadata is pinned early** too (the slowest single step). Turn this off
  in options if you would rather nothing is uploaded until you fire.
- **a throttled RPC is abandoned, not waited out.** This was the real cost: a
  rate-limited Helius key answers `429` and web3.js retries *the same host* with
  a 500ms, 1000ms, 2000ms backoff. The worker now probes and moves to the next
  endpoint instead — 91ms to skip a dead host and pick a live one.

Firing the three reads off together was the obvious fix and measured *worse* —
158ms against 72ms on one key — because the provider throttles concurrent
requests per key. They stay sequential.

## Where the key lives

In `chrome.storage.local`, read **only** by the background service worker. The content
script running inside j7tracker.io never receives it and has no message that can ask
for it — its entire vocabulary is "here are the parameters I read" and "show this
status". So a compromised j7 page can at worst request a launch it could already watch
you configure; it cannot get the key. `FORGET THE KEY` in options wipes it.

## How the panel is read

j7's markup isn't ours and will change, so nothing here relies on a class name.
Fields are found the way a person finds them — by the small uppercase label sitting
above each one — and the selected pad is found by comparing the buttons against each
other and taking the odd one out (`aria-pressed`, an `active` class, a border the
others don't have).

Everything read is **shown in the bar before it is used**, in editable boxes. If a
field comes out wrong you can type over it, or press **◎** and click j7's fields in
turn to teach it permanently; taught selectors are stored and take priority.

This matters: a fallback that silently mirrors the wrong symbol is worse than one
that admits it is unsure. The dot goes amber and the button still works, but you can
see what it's about to do.

## When it takes over

- j7 renders anything matching *timeout / failed / error / rejected / insufficient /
  expired* → immediately.
- You press Deploy and nothing confirms within the take-over delay (20s default) →
  on the timer.
- A success toast cancels the timer, so a launch that works is left alone.

It won't fire twice for the same panel — name, symbol, pad and dev buy form a
fingerprint, and a repeat needs **DEPLOY NOW (FORCE)** in the popup. Failures clear
the fingerprint so a retry is allowed.

## Which pads it can cover

| j7 pad | covered by |
| --- | --- |
| Pump | `launchPump` — pump.fun `create_v2`, cashback and fees-to-holders supported |
| BONK | Raydium LaunchLab, bonk platform id |
| Stonk | Raydium LaunchLab, stonkfun platform id |

Everything else is refused with a reason rather than launched somewhere else.
OTC / Ansem / o1 aren't implemented; four.meme, Flap, ETH, Pons and Pools are EVM
chains and would need an EVM key rather than your Solana one.

## Test

```
npm i --no-save jsdom
node extension/test/panel.test.mjs
```

Mocks the panel from the screenshot and asserts the scrape, then the three cases that
decide whether money moves: j7 errors, j7 stays silent, j7 succeeds.
