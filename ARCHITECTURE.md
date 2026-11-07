# Architecture review (issue #16)

One step back after the issue-by-issue rounds, looking at the design as a
whole. Measured where it could be measured headlessly; the rest is answered
from the code and the test record. Follow-up work is filed as issues;
what the later improvement pass fixed and measured is under
"Improvement pass (2026-11-06)".

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
guard cheaper only where that is safe (#36; #35 turned out unsafe, see
"Measured cost").

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
the harness-driven unit tests (`test/unit-prune.mjs`,
`unit-fallbacks.mjs`, `unit-state.mjs`, `unit-background.mjs`) pin every
fallback path, checked by `test/mutants.mjs`. Do not unify the three judging paths (nav source,
opener top page, restored frames): the browser does not always provide
a source, so the layers are load-bearing, not redundant.

**Context-menu exemption stays guessy — for now.** The record (selection
+ image srcs at the trusted pointer, single-use, 30-second expiry,
`MENU_WINDOW_MS`)
cannot prove the user chose the tab; it only makes page forgery hard.
A sturdy signal would need the browser's help: the extension's own
`chrome.contextMenus` items only cover clicks on *its* items (worse UX,
menu clutter), and whether a menu-opened tab carries a distinguishing
`transitionType` on its first commit can only be checked in a real
browser with real input (#38, needs the Brave phase).

**Code structure: split the background, not the guard.** `background.js`
already runs as a real ES module (`"type": "module"`), and `lib.js` is
already shared with the options and popup pages — so it can be split
into `history.js` / `decide.js` / `menus.js` with no build step, which
also lets the harness import units directly (#37).
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

The per-read `contentWindow` cost is about 0.13 µs ((14.6 − 1.9) ms /
100,000), not ms: the adoption check on every access. Repeat reads
already return early in `install()` on the realm check
(`wmHas(records, win.Function)`), so what is left is a few operations.
That realm check is required for security and must not be replaced by a
cache keyed on the window (#35): `contentWindow` returns the frame's
`WindowProxy`, which stays the same across navigations, so a WeakSet of
windows would skip `install()` for a re-navigated same-origin frame that
gets no content script of its own (a `javascript:` document, a frame
sandboxed without scripts). Its `window.open` would stay native from
commit until the `load` re-adoption, and the getter is the only
synchronous trigger in that window. Not worth reopening a bypass for
~0.1 µs; #35 should be closed.

The 200-iframe overhead is almost all per-child setup, not the
insertion wrapper. Each new `about:blank` child evaluates `guard.js`
(`install()` with its ~45 patches, or the marker early-out when the
parent already adopted it) and `arm.js` (handshake,
`chrome.storage.sync.get` IPC, observer, listeners). Evidence: listed
and unlisted pages time the same (table below), and on an unlisted page
the parent's insertion wrappers are already removed. `framesAfter`
reads the frame count (one native getter call, not a walk) before and
after the call; for element arguments it adopts the frames among and
inside them (a `querySelector` existence test first) and sweeps only when
the count grew by more than it found. So #36's fast path ("skip the work
when no argument holds a frame") is a minor item
and cannot move the 200-iframe number; profiling one child frame's
`install()` and `arm.js` startup has to come first (a `performance.now()`
delta behind a debug flag, guard-only and arm-only variants). Any
slimming must keep every pre-arm patch and register listeners before
page script runs.

Service-worker CPU per event and ad-heavy storage writes were not
measured headlessly — #10 already debounced and key-split the writes;
real-page profiling still needs a browser.

### Re-measured with `test/bench.mjs` (medians of 7)

`node test/bench.mjs [ext-dir ...]` times hot DOM paths inside the page
(`performance.now()`, 0.1 ms resolution) on a listed and an unlisted
page, against a browser with no extension. "Before" is the guard as of
the review; "after" is the guard with the fixes below. The two are
within run-to-run noise of each other everywhere; compare within one
run only.

| Operation (listed page) | No extension | Before | After |
|---|---|---|---|
| 200 iframe inserts | 301 ms | 631 ms | 595 ms |
| 10k `appendChild` of a `div` | 1.5 ms | 5.8 ms | 5.5 ms |
| 10k `appendChild` of a `div>span` | 3.0 ms | 9.7 ms | 9.2 ms |
| 10k `setAttribute` | 1.9 ms | 2.3 ms | 2.1 ms |
| 10k `classList.add` | 7.8 ms | 7.8 ms | 7.9 ms |
| 10k `textContent` sets | 1.9 ms | 5.5 ms | 5.0 ms |
| 100k `contentWindow` reads | 2.2 ms | 22.8 ms | 20.3 ms |

On the unlisted page every row is within about 1 ms of "no extension"
(100k `contentWindow` reads: 2.2 → 3.4 ms in a re-run on 2026-11-07)
except the 200 iframe inserts (586 / 596 ms, the same per-child cost as
listed). A non-frame insertion costs about 0.4 µs extra. The
`textContent` row shows a cost that predates this change: the guard's
`childList`/`subtree` MutationObserver (needed for parser-inserted
frames) makes every DOM mutation on a listed page queue a record.

## Duplication cleaned up in this change

- `guard.js`: `hasSandboxToken` and `stripPopups` ran the same
  character loop twice; both now use one `eachToken` walker.
  Covered by the opaque-sandbox end-to-end test.
- `test/run.mjs`: ~25 ad-hoc `for (const end = ...)` poll loops now
  go through `pollPage` / `poll` helpers. Same caps, same assertions.

## Left as is, deliberately

- `hiddenLinkOpensNew` vs the `onActivate` link branch, and the
  `frameWasListed` vs `openerWasListed` live-frame consults, overlap —
  but each serves a distinct event path; unifying them risks behavior
  change for little gain (candidate for #37 if the split happens).
- No cache in front of the `contentWindow` adoption check (#35): see
  "Measured cost". The realm check is what keeps re-navigated frames
  guarded.

## Improvement pass (2026-11-06)

A pass for efficiency and generality after the review. Everything below
is in the working tree, covered by tests, and described in the README.

### Bugs fixed

In the page (`arm.js`, `guard.js`):

- `arm.js` host matching no longer duplicates `lib.js`: both use
  `match.js`, loaded as a classic script before `arm.js` in the same
  isolated world.
- `arm.js` re-ran `listenMenus()` on every document `childList`
  mutation with fresh anonymous closures, piling up duplicate listeners
  (#39). That was a hole, not just waste: with two `contextmenu`
  listeners the first used up the gesture-time selection and reported
  `""`, and the second then saw no press and reported the selection the
  page planted on `mousedown`, replacing the first record (issue 6 part
  A again). The handlers are now named functions, so the browser drops a
  second add. `untrustedActivation` is still sent for every synthetic
  click, never coalesced: the record belongs to the whole tab, and
  another frame (another process) can write a fresh one in the middle of
  a task. `arm.js` listens on `chrome.storage.sync.onChanged`, so frames
  are not woken by the background's session-storage writes.
- `guard.js` adopted nothing nested inside an inserted element:
  `querySelector` returned one element, which was then walked as a list,
  and the count-based sweep was skipped for element arguments (a
  regression from #13). Inserted subtrees are now walked with
  `querySelectorAll` after a `querySelector` existence test, and a sweep
  runs whenever the frame count grew by more than the frame elements
  found. `<frame>` and `<object>` windows are read through their own
  saved native getters, never `el.contentWindow`.
- `tameSandbox` never stripped anything: it called the already-uncurried
  `setAttr` through `Reflect.apply`, which threw and was swallowed. Only
  the `setAttribute` and IDL setter wrappers worked. Stripping alone
  would not have been enough either: Chromium takes a frame's sandbox
  flags when a navigation starts (for the first document, at insertion),
  so stripping a frame already in the document only affects its next
  navigation. The guard now navigates the frame again (same `src` or
  `srcdoc`) whenever it actually strips `allow-popups`.
- Sandbox escalation after insertion went around the two wrappers:
  `setAttributeNS`, `setAttributeNode(NS)`, `attributes.setNamedItem(NS)`,
  `toggleAttribute`, the `sandbox` DOMTokenList (`add`, `remove`, `toggle`,
  `replace`, `value`), the `Attr` node (`value`, `nodeValue`,
  `textContent`), and a name object whose `toString` answered
  differently to the guard and to the browser. Every route now re-tames
  the iframe after the write, from the value the browser stored. The
  cost on unrelated calls (`classList.add`, `textContent`) is within
  measurement noise (table above).

In the background (`background.js`):

- `left` stamps written by a same-site top commit were never saved: the
  commit recorded no new row, so the tab was not marked dirty, and a
  restore after a worker stop brought the old page's frames back as
  never left. The tab is now saved whenever a stamp or removal happened.
- A cold start forgot tabs closed over 30 s ago in memory but never
  removed their `h.<id>` rows from session storage. The forgotten tabs
  are now marked dirty, so the next save removes them.
- `liveFrames` turned an unreadable frame list into an empty map, so
  `pruneDead` treated every subframe of a closed or invalid tab as dead.
  It now returns `null`: decisions read that as "no frames", pruning
  keeps the rows.
- `unknownTabs` (tabs seeded with no saved rows) was never cleared when
  a tab was forgotten. `forgetGone` now clears every per-tab set listed
  once in `PER_TAB`.
- Smaller: the two copies of the 1000-row cap are one `capHistory`;
  `openerWasListed` shares one `getAllFrames` snapshot across its frame
  walks; the migration of the old single-key history is gone (Chrome
  clears session storage when the extension is reloaded or updated, so
  no version ever reads another's state); the context-menu matchers moved
  to `menu-match.js` as pure functions the unit tests import.

### Generality: site rules

`match.js` is now the one rule matcher, loaded as a classic content
script before `arm.js` and imported by `lib.js`. Rules: `example.com`
(host and subdomains), `=host` (exact), `*` (every site), `!host` and
`!=host` (exceptions, which beat everything), so `*` plus exceptions is
an allowlist. A rule array is compiled once into exact and suffix maps,
so a lookup costs O(labels in the host), not O(rules). The popup offers
add, remove, "allow this site" (adds `!host`) and remove-exception; the
options page explains the grammar, lists rejected lines, and a list over
the sync per-item quota is refused with a message instead of a bare
storage error.

### Measured

| What | Before | After |
|---|---|---|
| Unit tests | 30 tests, 9.3 s | 181 tests, 0.2 s (virtual clock in `harness.mjs`) |
| Mutation check | none | 54 mutants, all killed, ~2.3 s (`mutants.mjs`) |
| End-to-end, `parallel.mjs` | 30 steps, ~66 s | 32 steps, 405 checks, ~66 s |
| Guard cost (`bench.mjs`) | see "Re-measured" above | within noise of before |

A re-run of `bench.mjs` on 2026-11-07 (medians of 7, listed page, no
extension / before / after) agrees: 200 iframe inserts 337 / 582 / 545 ms,
10k `appendChild` 1.6 / 5.6 / 5.3 ms, 10k `textContent` sets 1.8 / 4.8 /
5.0 ms, 100k `contentWindow` reads 2.4 / 19.0 / 20.2 ms.

The end-to-end waits were left as they were, on purpose. The check
"parser-inserted opaque sandbox _blank click" first asserted that no tab
was created and failed intermittently: a parser-inserted frame commits its
first document before any script can strip `allow-popups`, so a click can
land before the guard's re-navigation. It now asserts what is guaranteed
(attribute stripped, no surviving tab) and reports the flash count.

A final review pass also fixed: a failed session write now re-marks every
tab and the small sets dirty (a trimmed tab kept its fail-closed flag only
until the next restart otherwise); `sandbox.remove` is wrapped too; an
exception keeps a typed `www.` (`!www.bank.com` must not except all of
`bank.com`); the popup and options buttons always change whether the site
is listed; `parallel.mjs` rejects reversed ranges and a bad `SHARDS`.

### Follow-ups

- An older version of the extension on another synced device never
  matches `*`, `=` or `!` rules, and if it saves the list, it drops them
  from sync for every device.
- A failed domain-list read stays cached in the worker (`getDomains`)
  until the list changes or the worker restarts.
- Opaque `allow-popups` iframes written through `shadowRoot.innerHTML` are
  not stripped (predates this pass; the background still closes the tab).
- A `<script>` inserted in the same call as a `javascript:false` iframe
  could reach the frame before adoption (untested).
- Firefox port.
- Background module split (#37).
- Close #35: a `contentWindow` cache would reopen a bypass.

## Follow-ups

Filed as issues: guard fast paths (#35 contentWindow — should be
closed, see "Measured cost"; #36 insertion sweep — re-scoped to
"profile one child frame first"), background module split (#37), menu
`transitionType` verification in a real browser (#38), arm.js listener
hoisting (#39, done in the improvement pass). The pass's own follow-ups
are listed in its section above.
