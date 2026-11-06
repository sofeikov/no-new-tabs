# Architecture review (issue #16)

One step back after the issue-by-issue rounds, looking at the design as a
whole. Measured where it could be measured headlessly; the rest is answered
from the code and the test record. Follow-up work is filed as issues, not
done here.

## Verdicts

**Keep the two layers.** The in-page guard (`extension/guard.js`) exists
only to prevent flashes; the background layer is the actual guarantee. Every
review round found new guard bypasses that are hard to close completely
(stack exhaustion has no in-page fix; a stopped event beats the late
check; extension-frame UI is a known gap). But the background-only test
mode closes everything the suite throws at it, and the guard's cost is
bounded (table below). A smaller guard covering "only the common ad routes"
would re-open the shadow-DOM, `document.open`, named-frame and sandbox
tricks that issues #3–#5 and #7–#9 closed one by one. Keep both; make the
guard cheaper instead (follow-ups #1, #2).

**Injection scope cannot be narrowed.** `guard.js` and `arm.js` run in
every frame of every site (`all_urls`, `all_frames`,
`match_origin_as_fallback`). Limiting matches to listed hosts would miss
exactly what the guard is for: cross-origin ad iframes inside listed
pages, whose hosts are not known in advance. `registerContentScripts`
has the same problem — matches are host patterns, not "frames of listed
tabs". The unlisted cost is one install-then-remove per frame, about
9 ms of page load (table below). Keep the scope; document the rationale
(done here).

**Background state is the simplest model that works.** Per-frame site
history with sequence numbers *and* wall-clock timestamps, one storage
key per tab, 60 s / 200-entry prune rules, restore after worker stops —
each piece answers a real case (tab-unders need `atSeq` moments,
leave-pruning needs `left` stamps, cold workers need the restore), and
`test/unit-prune.mjs` + `test/unit-fallbacks.mjs` pin every fallback
path against mutants. Do not unify the three judging paths (nav source,
opener top page, restored frames): the browser does not always provide
a source, so the layers are load-bearing, not redundant.

**Context-menu exemption stays guessy — for now.** The record (selection
+ image srcs at the trusted pointer, single-use, five-minute expiry)
cannot prove the user chose the tab; it only makes page forgery hard.
A sturdy signal would need the browser's help: the extension's own
`chrome.contextMenus` items only cover clicks on *its* items (worse UX,
menu clutter), and whether a menu-opened tab carries a distinguishing
`transitionType` on its first commit can only be checked in a real
browser with real input (follow-up #4, needs the Brave phase).

**Code structure: split the background, not the guard.** `background.js`
already runs as a real ES module (`"type": "module"`), and `lib.js` is
already shared with the options and popup pages — so it can be split
into `history.js` / `decide.js` / `menus.js` with no build step, which
also lets the harness import units directly (follow-up #3).
`guard.js`/`arm.js` are classic content scripts in opposite worlds
(`MAIN` vs isolated) and cannot use modules without a bundler; the repo
has no build and should not gain one for this. Keep them single-file.

## Measured cost (headless Chromium, medians of 3, local server)

| Operation | Without extension | With extension |
|---|---|---|
| Insert 200 iframes, listed page | 289 ms | 667 ms (2.3x) |
| 2000 `document.write` with 100 frames | 141 ms | 283 ms (2.0x) |
| 100,000 `contentWindow` reads | 1.9 ms | 14.6 ms (7.7x) |
| Page load, listed / unlisted | 105 / 106 ms | 114 / 115 ms (+9 ms) |

The per-read `contentWindow` cost (~0.13 ms) is the adoption check on
every access; the frame-insertion cost is the before/after frame-count
walk on every DOM insertion. Both are guard fast-path opportunities
(follow-ups #1, #2). Service-worker CPU per event and ad-heavy storage
writes were not measured headlessly — #10 already debounced and
key-split the writes; real-page profiling still needs a browser.

## Duplication cleaned up in this change

- `guard.js`: `hasSandboxToken` and `stripPopups` ran the same
  character loop twice; both now use one `eachToken` walker.
  Covered by the opaque-sandbox end-to-end test.
- `test/run.mjs`: ~25 ad-hoc `for (const end = ...)` poll loops now
  go through `pollPage` / `poll` helpers. Same caps, same assertions.

## Left as is, deliberately

- `arm.js` duplicates 4 lines of host matching from `lib.js`
  (`blocked` vs `hostIsBlocked`): content scripts cannot import modules,
  and the copy is trivial.
- `hiddenLinkOpensNew` vs the `onActivate` link branch, and the
  `frameWasListed` vs `openerWasListed` live-frame consults, overlap —
  but each serves a distinct event path; unifying them risks behavior
  change for little gain (candidate for #3 if the split happens).
- `arm.js` re-runs `listenMenus()` on every document `childList`
  mutation with fresh anonymous closures, piling up duplicate listeners
  (bounded in practice — document-level `childList` without `subtree`
  fires rarely — but still wrong). Fix: hoist to named handlers so
  `addEventListener` dedupes (follow-up #5).

## Follow-ups

Filed as issues: guard fast paths (#1 contentWindow, #2 insertion
sweep), background module split (#3), menu `transitionType`
verification in a real browser (#4), arm.js listener hoisting (#5).
