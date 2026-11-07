# No New Tabs

A Brave/Chrome extension (Manifest V3). Sites on your list cannot open new
tabs or windows, by any method. Everything else on those sites, including
their JavaScript, keeps working. The list can also be turned around: block
every site except the ones you name.

A blocked link or `window.open` simply does nothing: the page stays where it
is, and the target is not opened in the current tab instead. `window.open`
returns `null`, as it does when the browser's popup blocker stops it.

This README has two halves. The first half says what the extension does and
how to install, use and test it. The second half,
[How it works: every trick](#how-it-works-every-trick), explains each
technique the code uses, what attack or problem it answers, and why the
obvious approach does not work. References such as
[background.js › pageCreated](extension/background.js) name the file and
the function or constant that does the work; search the file for the name.

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Use it](#use-it)
- [Tests](#tests)
- [Project layout](#project-layout)
- [How it works: every trick](#how-it-works-every-trick)
  - [Terms used below](#terms-used-below)
  - [Architecture overview](#architecture-overview)
  - [Background enforcer](#background-enforcer)
    - [Telling the user's tabs from the page's](#telling-the-users-tabs-from-the-pages)
    - [Finding the frame that opened a tab](#finding-the-frame-that-opened-a-tab)
    - [Frame history and timing](#frame-history-and-timing)
    - [Surviving service-worker restarts](#surviving-service-worker-restarts)
    - [Context-menu exemption](#context-menu-exemption)
    - [Other background details](#other-background-details)
  - [In-page guard](#in-page-guard)
    - [Arming and the handshake](#arming-and-the-handshake)
    - [Hardening against a hostile page](#hardening-against-a-hostile-page)
    - [window.open](#windowopen)
    - [Frames](#frames)
    - [Links, forms and clicks](#links-forms-and-clicks)
    - [Target-name rules](#target-name-rules)
    - [Removal on unlisted sites](#removal-on-unlisted-sites)
  - [Popup and options page](#popup-and-options-page)
  - [Testing techniques](#testing-techniques)
  - [Ad-script tricks seen in the wild and how each is defeated](#ad-script-tricks-seen-in-the-wild-and-how-each-is-defeated)
- [Known gaps](#known-gaps)

## What it does

There are two layers.

1. **Background enforcer** ([background.js](extension/background.js)). If a
   tab showing a listed site, or a listed site inside an iframe, causes a
   new tab or window to open, that tab is closed right away. This runs in
   the browser, so page code cannot get around it.
   - It judges a popup by what the opening tab, and the frame in it that
     opened it, showed **when the popup was created**, not by what they show
     a moment later. Ad scripts often open a tab and then at once send the
     listed tab (or the listed iframe) to an ad, back, or away, or close it.
     Every change of site in every frame is recorded with the browser's own
     timestamps and kept in session storage. This still works when Chrome
     has stopped the extension's worker, which it does after 30 seconds of
     quiet. Only host names are kept, not addresses. Each tab's rows are
     stored under their own key and written at most once per 150 ms (at
     once when a tab is blocked or a menu is recorded), so
     rapid frame commits don't rewrite the whole record on every commit.
   - A page can't shed its site by turning itself into a `blob:` copy (also
     one made in a sandboxed frame, `blob:null/…`) or an `about:blank`.
     Those count as the site that made them.
   - Once you follow a link off a listed site, the next site is not
     affected. Its own popups (such as a sign-in window) work.
   - Tabs you open yourself (Ctrl+T, Ctrl+N, the address bar, bookmarks,
     duplicate, reopen closed tab) are never closed. Tabs a page creates
     usually start with no address at all; tabs that already have one (the
     browser's middle- and ctrl-click tabs) are told apart by the new tab's
     first navigation: user navigations (typed, bookmark, duplicate,
     reopen) are kept, page links are closed. A popup with no navigation
     source is judged by its opener, including restored pages.
   - What you pick from the right-click menu on a listed page opens
     normally: **Search for the selected text** (also when the selection
     includes a link, or is inside a text box), **Go to <address>**
     (Brave's item, shown when the selection looks like an address),
     **Open image in new tab** (also on a linked image) and **Open video
     in new tab**. The extension
     notes what the menu offers when you right-click — the selection as it
     stood before the button went down (at least 3 characters), and loaded
     images that are not thumbnails linking to themselves — and keeps a tab
     from the menu only if its address is one of those and the page sent no
     synthetic click of its own afterwards, so a page can't use a faked
     record to keep a tab it opened itself. **Open link in new tab** opens
     the site's link, so it is closed like every other way the site's links
     open a tab. See [Known gaps](#known-gaps) for menu items that are
     still closed.
2. **In-page guard** ([guard.js](extension/guard.js) +
   [arm.js](extension/arm.js)). This stops new tabs from being created at
   all, so you don't see one flash open and close. `guard.js` is injected
   into every frame before any page script runs, but does nothing until
   `arm.js` switches it on. That happens only in frames that are on a listed
   site or sit inside a tab showing one. This covers video players and ad
   frames that come from other domains. On every other page `arm.js` tells
   the guard to remove itself, so unlisted sites run untouched. Once on, it:
   - makes `window.open` return `null`. This includes copies saved at page
     load, a `window.open` the page replaces, and the `open` of hidden
     `<iframe src="javascript:false">` frames that ad scripts (PopAds,
     Adcash) open popups from. Same-site frames are guarded the moment they
     are inserted, before the page can save their `open`. This includes
     frames sandboxed without scripts that stay readable (same-origin
     or `allow-same-origin`), and frames nested anywhere inside an
     inserted element. Opaque ones cannot be adopted; instead
     `allow-popups` is stripped from their `sandbox` attribute, however
     the page sets it, and the frame is loaded again so the stripped
     flags apply. The click then does nothing.
   - cancels `target=_blank` links and forms, `<base target=_blank>`,
     `formtarget`, links and forms in shadow DOM, SVG links, and targets a
     page handler changes after the guard has looked.
   - works in frames whose document a script wrote (`document.write`), in
     `data:` frames, and on plain-http sites.
   - refuses document picture-in-picture windows.
   - cancels ctrl-, shift- and middle-clicks on links and submit buttons.
   - cancels `form.submit()`, `form.requestSubmit()` and `.click()` on
     links that would open a tab.
   - reports its wrappers as native code, so ad scripts that check whether
     `window.open` was wrapped don't go looking for another way out.
   - mostly uses built-in functions it saved before any page script ran, so
     a page can't steer it by replacing `Set.prototype.has`,
     `Function.prototype.apply` and the like. Option and descriptor
     objects handed to the browser have no prototype (a poisoned
     `Object.prototype.signal` or `capture` is not inherited), argument
     copies are written as own properties (a setter on
     `Array.prototype[1]` cannot swallow them), and a listener that throws
     cancels the event instead of letting the tab through.

   Nothing else is changed. The site's scripts, click handlers, `fetch`,
   video playback and downloads keep working. So does every open that stays
   in the tab: `window.open(url, "_self")`, `_top`, `_parent`, links and
   opens aimed at a named iframe of the same site (including one in another
   frame on the page), and same-tab links. Names are matched the way the
   browser matches them, so `" _self"` (with a space) or a name the page
   faked is treated as the new window it really opens. The one exception:
   `window.open` (and three-argument `document.open`) to an `about:` or
   `javascript:` URL is blocked even when it would stay in the tab, because
   ad scripts use `open('about:blank', '_self')` to blank the page
   ([guard.js › blanksPage](extension/guard.js),
   [guard.js › inertUrl](extension/guard.js)).

   Until a page is known to be listed, `window.open` stays a plain
   property, so test tools and scripts that save and restore it work as
   usual. A function the site itself assigns to `window.open` (an analytics
   hook) is handed back unchanged; what it calls is still guarded.
   `requestSubmit()` on a `_blank` form still runs the site's validation and
   submit handlers; only the navigation is cancelled. A page hook assigned
   to `window.open` keeps its identity and still runs on blocked opens.

## Install

The extension is not in a web store. Load it unpacked.

1. Clone this repository.
2. Open `brave://extensions` (or `chrome://extensions`).
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and choose the `extension/` folder of your
   clone.
5. Click the puzzle-piece icon in the toolbar and pin **No New Tabs**.
6. Optional: on the extension's **Details** page, turn on **Allow in
   Private** (Brave) or **Allow in Incognito** (Chrome) if you want it in
   private windows too.

Unpacked extensions don't auto-update. After pulling or editing the files,
click the reload arrow on the extension's card.

It needs a recent Chromium-based browser. Content scripts declared with
`world: "MAIN"` need Chrome 111 or later, and the manifest also uses
`match_origin_as_fallback`
([manifest.json › content_scripts](extension/manifest.json)). The manifest sets
no `minimum_chrome_version`, so an older browser may load it without the
in-page guard working. Optional APIs (`documentPictureInPicture`,
`setHTMLUnsafe`) are wrapped only if the browser has them
([guard.js › method](extension/guard.js)).

## Use it

- **Quickest:** go to the site, click the extension icon, then click
  **+ Add example.com** (the button names the site). The tab reloads and
  the icon shows a red **ON** badge on that site. The popup always offers
  the one change that flips the site you are on:
  - listed by a rule naming this site: **Remove example.com**;
  - listed by a broader rule (a parent domain, or `*`), or still listed by
    one after its own rule is gone: **Allow this site (add !example.com)**,
    with the host exactly as shown (`!www.example.com` on www), and the
    status line says which rule lists it ("via …");
  - kept unlisted by an exception: **Remove exception !example.com**, which
    also adds the site when no other rule would list it;
  - unlisted: **+ Add example.com**.
- **List editor:** right-click the icon and choose **Options**. Use the
  **+ Add current domain** button (the same choice as the popup's, for
  the tab you were just on), or enter
  one rule per line and click **Save**. Adding a site takes effect at once,
  even in tabs that are already open. Removing one takes effect after the
  tab reloads.

One rule per line (commas work too):

| Rule | Lists |
| --- | --- |
| `example.com` | the site and every subdomain (`www.example.com`, `app.example.com`), never `evilexample.com` |
| `=app.example.com` | that exact host only |
| `*` | every site |
| `!docs.example.com` | an exception: never listed, with its subdomains |
| `!=docs.example.com` | an exception for that exact host only |

Exceptions beat every other rule, so `*` plus exceptions is an allowlist:
`*` and `!mail.example.com` block new tabs everywhere except on
`mail.example.com`. Input is lenient: case, a scheme, a path and a
trailing dot are dropped, and a leading `www.` is dropped from a domain
(`www.example.com` lists all of `example.com`), but kept in an exact rule,
which names one host, and in an exception: dropping it from
`!www.bank.com` would also except every other `bank.com` subdomain. IP addresses work (`127.0.0.1`,
`[::1]`). After saving, the editor shows the list as stored and names
every line it left out because it is not a domain or rule.

The list is stored as one `chrome.storage.sync` item, so with browser sync
on it follows you to other browsers signed in to the same profile. That
item is limited by Chrome's per-item sync quota (8 KB, a few hundred
domains). A list that would not fit is not saved: the options page and the
popup say how large it is and what the limit is, and nothing changes. A
copy of an older version of this extension on another synced device
understands only plain domains: it ignores `=`, `*` and `!` rules, and if
it saves the list there, it drops them for every device.

To check it's working, open DevTools on the site (F12, then Console). Each
blocked attempt is logged as `[no-new-tabs] blocked …`. The background
worker logs `[no-new-tabs] closed tab …` in its own console (open it from
the extension's card).

## Tests

```bash
cd test
npm install
npx playwright-core install chromium   # one-time browser download
npm test                               # unit tests, then the end-to-end suite in parallel
```

| Script | Runs | Time |
| --- | --- | --- |
| `npm run test:unit` | `node --test unit*.mjs`: 181 unit tests, no browser | under 1 s |
| `npm run test:e2e` | `node run.mjs`: the end-to-end suite, one browser | about 4 min |
| `npm run test:parallel` | `node parallel.mjs`: the same steps, split across browsers | about 70 s |
| `npm run test:mutants` | `node mutants.mjs`: checks that the unit tests catch broken rules | about 3 s |

**Browser.** The end-to-end suite loads the extension into Chromium. It
uses the browser you name with `CHROME=/path/to/chrome`, else the Chromium
build that the installed `playwright-core` downloads, found with
`chromium.executablePath()` on any OS, else an older Playwright build in
the Linux cache ([run.mjs › findChrome](test/run.mjs)). Recent branded
Chrome builds ignore `--load-extension`, so use Chromium. The test site
listens on port 8799; set `PORT=` if that is taken.

```bash
# from test/
CHROME=/usr/bin/chromium PORT=9000 node run.mjs
```

**Parallel run.** Most of the four minutes is waiting for tabs to
settle. `parallel.mjs` splits the same steps across workers, one browser
and one test server per shard, all assertions identical. It asks
`run.mjs` for the step table (`LIST_STEPS=1` prints it as JSON and exits),
so a new step needs no change there: steps added since the default
six-shard split was tuned join the last shard. Each worker takes its own
`PORT` (`8799` plus the shard number).

```bash
# from test/
node parallel.mjs                 # 6 shards by default
SHARDS=4 node parallel.mjs
node parallel.mjs 0-7,8-15,16-31  # explicit step ranges
```

`TEST_ONLY` runs a slice of the suite in one browser, for iterating on a
single area (`TEST_ONLY=menuKept`, or exact `index:id` steps like
`TEST_ONLY=3:,20:`; step ids are the test function names in the `STEPS`
table at the bottom of `run.mjs`).

**Unit tests** run the shipped code without a browser, for what a
headless browser cannot drive or would take minutes to wait for:

- [unit.mjs](test/unit.mjs): the context-menu matchers in
  `menu-match.js`, including Brave's native "Go to <address>" item.
- [unit-match.mjs](test/unit-match.mjs): the site rules in `match.js`
  (matching vectors, also with `match.js` run as a classic script the way
  `arm.js` gets it), `normalizeRule`, the change the popup offers, and
  saving at the sync quota.
- [unit-prune.mjs](test/unit-prune.mjs),
  [unit-fallbacks.mjs](test/unit-fallbacks.mjs),
  [unit-state.mjs](test/unit-state.mjs),
  [unit-background.mjs](test/unit-background.mjs): `background.js`
  driven through a fake `chrome` API ([harness.mjs](test/harness.mjs)):
  pruning 60 s after a frame leaves, cold-worker restore, the no-source
  fallbacks, closed tabs forgotten after 30 s, the 1000-row cap, failed
  saves, the menu record, the `inListedTab` reply, `*` and exceptions.

The harness owns a virtual clock: it replaces `setTimeout`, `setInterval`
and `Date.now`, and `settle(ms)` moves time forward by exactly that much,
running every timer that falls due in order. The worker's waits keep their
real lengths (50 ms, 150 ms, 3 s, 30 s, 60 s) but cost no wall time, and
runs are deterministic. That took the unit tests from 30 tests in 9.3 s
to 181 tests in about 0.2 s.

**Mutants.** `mutants.mjs` breaks one security-relevant rule at a time in
a temporary copy of `extension/` and the unit tests (54 mutants: pruning by
the wrong age, a label-unanchored domain match, an exception that no longer
wins, a menu record that is not single-use, and so on) and runs the unit
tests against each copy. A mutant counts as killed only when the tests it
names fail. A survivor is a test gap: fix the tests, never the mutant. A
mutant whose search text no longer occurs in the source is reported as
stale. All 54 are killed in about 2.5 s; `--list`, `--only <names>` and
`-v` help when one is not.

**Benchmark.** `node bench.mjs [ext-dir ...]` times hot DOM paths (frame
inserts, `appendChild`, `setAttribute`, `contentWindow` reads) inside a
listed and an unlisted page, against a browser with no extension. Pass two
extension folders to compare builds within one run. It is not part of the
suite, and it looks for Chromium only in the Linux cache; set `CHROME=`
elsewhere.

**What the end-to-end suite checks.** It lists `localhost`, uses
`127.0.0.1` as the unlisted control, and runs 32 steps with 405 checks
(the run prints PASS or FAIL for each and ends with ALL PASSED):

- **69 ways of opening a tab.** These include cross-origin and nested
  iframes, and the tricks from the ad scripts seen on a real streaming
  site: hidden `javascript:false` frames, a restored or bound
  `window.open`, detached links, shadow DOM (also built from HTML), SVG
  links, `<base target>`, `formtarget`, `requestSubmit()`, targets changed
  by page handlers, `" _self"`, faked window names, sandboxed frames, frames
  written with `document.write`, `data:` frames, a page that rewrites itself
  or turns itself into a `blob:` copy, and pages that fake the extension's
  own signals. On the listed site none of them may even create a tab. On
  the control site they all open, except the ones in the listed site's
  iframes.
- **The same 69 with the in-page guard removed,** to test the background
  layer on its own.
- **Tab-under cases.** The listed tab opens a tab and then leaves (also
  through six quick redirects), goes back or closes. A listed iframe opens
  one and then leaves or is removed. Four cases (plain `window.open`, the
  hidden-frame open with and without leaving, and the six-redirect chain)
  are also run with the worker stopped first, as Chrome does after 30 s
  idle, and so are the listed-iframe "leaves" and "is removed" cases
  ([run.mjs › tabUnder](test/run.mjs), [run.mjs › workerRestart](test/run.mjs)).
- **Plain-http sites** (not secure contexts), picture-in-picture windows,
  and context menus: a right-click must not open the door for a link click
  that gets past the guard.
- **Frames and sandboxes reached only one way** (`guardInsertions`):
  `javascript:false` frames nested inside an inserted element, and
  `allow-popups` added to an opaque sandbox by markup, by the parser
  ([sandboxparse.html](test/site/sandboxparse.html)), before the page was
  armed, or through each attribute-write route after insertion.
- **The rule grammar** (`ruleGrammar`): with `*` and `!a.test`, `b.test`
  is guarded while `a.test` and `x.a.test` are untouched.
- **The reverse.** After you follow a link off a listed site, that site's
  popups still open.
- **Your own tabs survive.** New tab, duplicate, extension-made tabs and
  windows are all kept.
- **The page keeps working, on listed and unlisted sites.** This covers
  click handlers, `fetch`, `_self` and named-iframe opens, downloads, and a
  page that touches an iframe before it loads. On unlisted sites
  `window.open` is a plain property (also while the page loads), nothing of
  the guard is left in the page or its frames, and no extension code
  appears in call stacks.
- **Live arming and the options page.** Adding a site guards open tabs
  without a reload, and the options page saves and cleans up the list.

The tests where the extension closes tabs use a small raw-CDP driver
([test/cdp.mjs](test/cdp.mjs)). Playwright pauses each new tab while it
attaches, and if the tab is closed first, the page that opened it can
freeze. See [Testing techniques](#testing-techniques).

## Project layout

```
extension/
  manifest.json   MV3 manifest: two content scripts (MAIN + isolated world), module service worker
  background.js   Background enforcer: frame history, closing page-made tabs, context-menu exemption, badge
  guard.js        In-page guard, runs in the page's own (MAIN) world in every frame
  arm.js          Isolated-world partner of guard.js: decides listed/unlisted, arms or removes the guard,
                  reports context menus to the background
  match.js        Site rules (domain, =exact, *, !exception): the one matcher, loaded before arm.js
                  and imported by lib.js
  lib.js          Shared helpers: rule normalisation, saving the list, siteOf(), the popup's toggle
  menu-match.js   Pure context-menu matchers used by background.js (search, "Go to", image srcs)
  popup.html/js   Toolbar popup: add, remove or except the current site
  options.html/js Rule list editor
  icons/          Toolbar and store icons (16, 32, 48, 128 px)
test/
  run.mjs         End-to-end suite (Playwright for the full extension, raw CDP elsewhere)
  parallel.mjs    Runs run.mjs's steps in parallel shards
  cdp.mjs         Minimal raw Chrome DevTools Protocol driver
  harness.mjs     Fake chrome API and virtual clock for background.js unit tests
  unit.mjs        Context-menu matcher vectors (menu-match.js)
  unit-match.mjs  Site rules, normalisation, popup toggle, sync quota
  unit-prune.mjs, unit-fallbacks.mjs, unit-state.mjs, unit-background.mjs
                  background.js through the harness: pruning, fallbacks, state, decisions
  mutants.mjs     Mutation runner: each mutant must make a named unit test fail
  bench.mjs       Micro-benchmark of the guard's cost on hot DOM paths (not part of the suite)
  package.json    One dev dependency (playwright-core) and the npm test scripts
  site/           Test pages served by run.mjs
    index.html      Main page: most cases, the ad-script tricks, tab-under buttons
    v14.html        Edge cases: whitespace targets, sandboxed frames, targets changed late,
                    declarative shadow roots, document.write frames, blob: pages
                    (the name is historical)
    tricks.html     Frames tampered with before any input (fake marker, native open)
    fakesignals.html Page that fakes the guard's control events
    earlytouch.html, child.html  A frame touched before its document loads
    base.html       <base target=_blank>
    frame.html, nest.html  Cross-origin frame and a frame nested one level deeper
    sib.html        Sibling frame that targets a named iframe
    opaque.html     A _blank link, loaded into opaque sandboxed frames
    sandboxparse.html  A parser-inserted opaque frame that asks for allow-popups
    target.html     Landing page for every case
    data.json, px.png  Used by the fetch() and context-menu image checks
```

[ARCHITECTURE.md](ARCHITECTURE.md) is the post-review design note:
verdicts on the two layers, injection scope and background state, the
measured cost of the guard, what the later improvement pass fixed and
measured, and the follow-up issues.

## How it works: every trick

Each trick below follows the same pattern: the problem or attack, what the
code does about it, and why the obvious approach fails.

### Terms used below

- **Listed**: on a host a rule in your list covers (a listed domain or one
  of its subdomains, an exact host, or every host for `*`), and not on an
  exception.
- **Tab-under**: an ad opens a new tab, then at once moves the original tab
  elsewhere (or closes it). By the time anyone looks, the opener no longer
  shows the listed page.
- **MAIN / isolated world**: a content script in the MAIN world shares the
  page's JavaScript objects. One in the isolated world sees the same DOM but
  has its own globals and the `chrome.*` APIs.
- **Realm**: one JavaScript global environment. Every same-origin iframe
  has its own, with its own `Function`, `window.open` and prototypes.
- **Armed**: `guard.js` is enforcing. Before that it only passes calls
  through.
- **Adopt / sweep**: the parent's guard installs itself into a same-origin
  child frame (adopt), or walks all child frames and adopts each one
  (sweep).
- **Commit**: the moment a frame starts showing a new document
  (`webNavigation.onCommitted`).
- **jsf frame**: `<iframe src="javascript:false">`. It never commits a
  document, so the browser injects no content script into it.
- **Cold worker**: the extension's service worker after Chrome has stopped
  it for being idle.
- **User activation**: the browser's record of a recent real click or key
  press. Popups need it.
- **Opaque origin**: origin `"null"`, as in sandboxed or `data:` frames.
- **Secure context**: https, or localhost. Some APIs, such as
  `crypto.randomUUID`, exist only there.

### Architecture overview

#### Three pieces, two layers

| Piece | Runs in | Job |
| --- | --- | --- |
| [background.js](extension/background.js) | The extension's service worker | The hard guarantee. Closes any tab a listed page or frame opens. |
| [guard.js](extension/guard.js) | The page's own JavaScript world (MAIN), every frame | Stops the tab from being created at all, so nothing flashes. |
| [arm.js](extension/arm.js) | The extension's isolated world, every frame | Decides whether this frame is listed, and arms or removes `guard.js`. |

The background layer works on its own. The test suite runs every case
against a copy of the extension with the content scripts deleted
([run.mjs › backgroundOnlyCopy](test/run.mjs)). The in-page layer exists so you
don't see a tab open and close.

#### Two scripts in two worlds, both at `document_start` in every frame

**Problem.** The guard must patch the page's own built-ins such as
`window.open`. Only a script in the page's MAIN world can do that. But
MAIN-world scripts get no `chrome.storage` or `chrome.runtime`, so they
cannot read the domain list. And anything in the page's world can be
watched or tampered with by page scripts.

**What it does.** The manifest declares `guard.js` with `world: "MAIN"` and
`match.js` + `arm.js` in the default isolated world
([manifest.json › content_scripts](extension/manifest.json)). Both use
`run_at: document_start`, `all_frames: true`,
`match_origin_as_fallback: true` and `<all_urls>`. `guard.js` is listed
first, so its listeners exist before `arm.js` sends anything. `guard.js` does
all the patching and stays inert until armed. `arm.js` reads the list,
decides, and sends the answer to `guard.js` through DOM events. The second
content script has no `world` key, so `match.js` and `arm.js` run in the
isolated world, in that order. They have their own copies of the JS
built-ins, and page code cannot change what they read or call.

**Why not the obvious way.** A single MAIN-world script cannot read the
extension's storage. A single isolated-world script cannot change the
page's `window.open`. The split is needed, and so is a trusted channel
between the halves (see [the handshake](#secret-handshake-only-armjs-can-arm-or-remove-the-guard)).
Without `match_origin_as_fallback`, nothing is injected into `about:blank`,
`data:` or `blob:` frames, which are where hidden-iframe popup tricks run.
Without `document_start`, page scripts could save the real `window.open`
first.

#### Permissions

`tabs` (to read `url` and `pendingUrl`), `webNavigation` (`onCommitted`,
`onCreatedNavigationTarget`, `getAllFrames`), `storage` (`sync` for the
list, `session` for state) and `dom` (closed shadow roots, for the
[context-menu record](#armjs-reports-menus-from-trusted-events-only)), with `<all_urls>` host permissions
([manifest.json › permissions](extension/manifest.json)). The worker is a
module (`"type": "module"`) so it can import [lib.js](extension/lib.js)
(which imports `match.js`) and [menu-match.js](extension/menu-match.js).

### Background enforcer

The worker closes any tab whose opener (tab and frame) showed a listed site
at the moment the tab was created. The rest of this part explains how it
finds the opener, how it knows what the opener showed then, and how it
avoids closing tabs the user opened.

#### Telling the user's tabs from the page's

##### A page-made tab has no URL at `tabs.onCreated`

**Problem.** The worker must close tabs a listed page opens
(`window.open`, `target=_blank`, forms), but never tabs the user opens from
that page: Ctrl+T, the address bar, bookmarks, session restore, duplicate,
or `chrome.tabs.create` from another extension.

**What it does.** `pageCreated(tab)` is true only when `tab.openerTabId` is
set and the tab has neither `pendingUrl` nor `url`
([background.js › pageCreated](extension/background.js)). A tab created
by page script arrives at `tabs.onCreated` with no address at all. Tabs the
browser creates for the user always carry one. Only page-made tabs go down
the `onCreated` decision path
([background.js › tabs.onCreated listener](extension/background.js)).

**Why not the obvious way.** `openerTabId` looks like the natural signal,
but Chrome sets it for Ctrl+T from a tab too. Keying on it would close the
user's own new tabs. The tests reproduce those shapes (`createTarget`
newtab and about:blank, duplicate, `tabs.create` with an opener,
`windows.create`) and require them all to survive
([run.mjs › userTabsSurvive](test/run.mjs)).

##### Browser-made tabs from the page's links are judged too

**Problem.** Ctrl-click, shift-click, middle-click, "Open link in new tab"
and dragging a link all create tabs that do have a `pendingUrl`, so
`pageCreated()` lets them pass `tabs.onCreated`.

**What it does.** `webNavigation.onCreatedNavigationTarget` fires for these
tabs as well, and always starts a decision when no waiter exists
([background.js › onCreatedNavigationTarget listener](extension/background.js)). They are
judged by their source frame and closed if it was listed, unless the
[context-menu exemption](#context-menu-exemption) applies.

**Why not the obvious way.** A `pendingUrl` marks a tab as browser-made, not
as something the user chose on purpose. The site's own links opening in new
tabs are still "the site opening a tab", so they stay blocked. Only the
image, video and search tabs the menu offers are exempt.

#### Finding the frame that opened a tab

##### Prefer `onCreatedNavigationTarget`, fall back to the opener after 50 ms

**Problem.** `onCreatedNavigationTarget` names the exact source tab and
frame, but it can arrive after `tabs.onCreated`, before it, or never. It
never fires when the opener frame never committed a document, for example
an ad script's hidden `<iframe src="javascript:false">`.

**What it does.** For a page-made tab, `waitForNavSource(tabId)` is
registered synchronously, before any `await`
([background.js › tabs.onCreated listener](extension/background.js)). It resolves with the
navigation details if they arrive within `NAV_WAIT_MS = 50`, or with
`null` on timeout ([background.js › waitForNavSource](extension/background.js)).
If the navigation event came first, it was stored in `navEarly` (kept 5 s)
and the wait resolves at once. With details, `decideFromNav` judges the
exact source frame. With `null`, the opener tab's top frame is judged,
because the browser does not say which frame opened it
([background.js › tabs.onCreated listener](extension/background.js)).

**Why not the obvious way.** Relying on `onCreatedNavigationTarget` alone
misses the hidden `javascript:false` iframe trick that real ad networks
use. Relying on `openerTabId` alone loses the frame. Registering the waiter
before any `await` means an event that lands in between is not missed.

##### Reconciling the order of the two events

**Problem.** The two events can arrive in either order. The navigation
event can also arrive after `onCreated` has timed out and decided from the
opener alone, possibly wrongly.

**What it does.** If `onCreatedNavigationTarget` finds a waiter, it hands
over its details and returns. Otherwise it stores them in `navEarly` and
starts its own decision. If `onCreated` already has a pending decision for
that tab, the new one is chained:
`pending.then(listed => listed || decideFromNav(details, atSeq))`, so a
"not listed" verdict from the coarse fallback gets a second look with the
exact frame ([background.js › onCreatedNavigationTarget listener](extension/background.js)).
`tabs.onCreated` returns early if a decision already exists, which means the
navigation event came first ([background.js › tabs.onCreated listener](extension/background.js)).

**Why not the obvious way.** Without the chain, a navigation event arriving
just after the 50 ms window would be dropped. Without the check in
`onCreated`, the same tab would be judged twice.

##### The `born` map: the address and moment of creation

**Problem.** Later steps need the address a browser-made tab came with (for
the context-menu exemption), and the exact point in event order at which the
tab was created, even if `onCreatedNavigationTarget` arrives later.

**What it does.** In `tabs.onCreated`, any tab with an opener gets
`born.set(tab.id, { url: tab.pendingUrl || tab.url, atSeq })`, where
`atSeq = seq + 1`. Entries expire after 10 s
([background.js › tabs.onCreated listener](extension/background.js)). The late
navigation handler reuses that `atSeq`
([background.js › onCreatedNavigationTarget listener](extension/background.js)).

**Why not the obvious way.** `atSeq` is taken synchronously at creation,
before any `await`. A navigation the opener commits afterwards cannot change
how the tab is judged. The 10 s expiry keeps the map small.

##### `decisions` and `track()`: verdicts still in flight

**Problem.** Several decisions can be in flight for related tabs, for
example a popup that opens another popup before its own verdict is known.

**What it does.** `track(tabId, decision)` stores the promise and removes it
once it settles, but only if it is still the stored one, so a newer chained
decision is not wiped. `decision.catch(() => false)` keeps a rejection from
becoming unhandled ([background.js › track](extension/background.js)).
`wasListed()` waits for a source tab's pending verdict and treats `true` as
listed ([background.js › wasListed](extension/background.js)).

**Why not the obvious way.** A popup's child can be created before the popup
itself is closed. Waiting for the parent's verdict is what makes popup
chains close in full.

##### The `spawned` set: whatever a closed tab opens is closed too

**Problem.** A popup that slips out, even briefly, can open more windows
from its own load-time script.

**What it does.** `block()` adds the tab to `spawned` and schedules a save,
then calls `chrome.tabs.remove(...)`
([background.js › block](extension/background.js)). The save is
debounced, so the storage write lands after the remove call
([background.js › persist](extension/background.js)). `wasListed()`
returns true at once for a source in `spawned`
([background.js › wasListed](extension/background.js)). The `inListedTab`
reply also reports a spawned tab as listed
([background.js › runtime.onMessage listener](extension/background.js)), so `arm.js` arms the
guard inside a popup that is about to be closed. The saved list keeps the
last 500 ids ([background.js › save](extension/background.js)).

**Why not the obvious way.** By the time the child is judged, the closed
popup no longer shows a listed site. It may be `about:blank` or an
unlisted ad domain. Its origin has to be remembered separately. Test:
"both windows closed".

#### Frame history and timing

##### Per-tab, per-frame site history

**Problem.** In a tab-under, an ad opens a tab and then immediately sends
the listed tab (or the listed iframe that opened it) to an ad, back in
history, through redirects, or closes it. By the time the worker looks, the
opener no longer shows the listed site.

**What it does.** `webNavigation.onCommitted` records, per tab, a list of
`{ f: frameId, p: parentFrameId (-1 for top), h: host, t: d.timeStamp, seq }`
in event order ([background.js › onCommitted listener](extension/background.js)).
`seq` is a worker-wide counter that goes up on every commit. Only the host
is kept, never the URL. An entry is added only when the frame's site
actually changes ([background.js › onCommitted listener](extension/background.js)).

This history covers every tab and frame, on every site, whether or not it is
listed and even while the list is empty: `onCommitted` never looks at the
list ([background.js › onCommitted listener](extension/background.js)). It holds
host names only and lives in memory and `chrome.storage.session` (which
content scripts cannot read by default), so it is gone when the browser
closes. It is never sent anywhere. The design needs it this way: a
tab-under can start from any page, and a later change to the list must be
able to judge what a tab showed before.

**Why not the obvious way.** Calling `chrome.tabs.get(opener)` at decision
time is exactly what a tab-under defeats. Keeping hosts, and skipping
same-site commits, keeps the history small enough to save.

##### Judging the opener at two moments: `atSeq` and `atTime`

**Problem.** The opener must be judged by what it showed when the popup was
created. The worker's event order and the browser's clock can disagree, and
entries restored after a worker restart have no meaningful `seq`.

**What it does.** `entryAt(entries, frameId, { atSeq, atTime })` returns the
frame's last entry with `seq < atSeq`, or with `t <= atTime`
([background.js › entryAt](extension/background.js)).
`decideFromNav` checks both `{ atSeq }` (worker event order at
`tabs.onCreated`) and `{ atTime: details.timeStamp }` (the browser's own
timestamp on the navigation-target event). The tab counts as opened by a
listed page if either moment says so
([background.js › decideFromNav](extension/background.js)). The opener-only
fallback has no browser timestamp and uses `{ atSeq }` only
([background.js › tabs.onCreated listener](extension/background.js)).

**Why not the obvious way.** The worker's event order and the browser's
timestamps can disagree. A tab-under may reach the worker as the opener's
navigation away followed by `tabs.onCreated`, even though the browser
created the popup first. Restored entries also have no real place in this
worker's order. So the opener is judged both ways, and the tab counts as
opened by a listed page if either view says so: a fast navigate-away cannot
hide the listed state from both. Restored entries get `seq 0`, which always
counts as "before" ([background.js › unpack](extension/background.js)).
Test: "hidden-frame open, then 6 redirects", served by a `/chain?n=N` route
that redirects with `location.replace`
([run.mjs › server](test/run.mjs), the `/chain` route).

##### Walking up the frame tree as it was (`frameWasListed`)

**Problem.** A popup may come from an unlisted or script-made frame inside a
listed page, or from a listed iframe inside an unlisted page. The frame may
also have navigated away or been removed since.

**What it does.** Starting from the source frame, each step takes that
frame's entry at the moment, checks whether its host is listed, then moves
to its recorded parent. It stops at frame 0 and is capped at 32 hops
([background.js › frameWasListed](extension/background.js)). If a subframe
has no entry (it never committed a document, such as an `about:blank` made
by script), `webNavigation.getAllFrames` is fetched once and the walk
continues from where that frame sits now. If the frame is not live either,
the walk jumps to frame 0, since it was at least part of this tab's page. If
the top frame has no entry, a trimmed tab counts as listed, and otherwise
the tab's current URL is checked.

**Why not the obvious way.** `null` and `""` hosts are falsy, so
`about:blank` and `data:` subframes defer to their parent on their own. The
recorded parents and hosts are used, not the live tree, so a listed iframe
that leaves or is removed right after opening is still caught. Tests:
"listed iframe: open, then the frame leaves / is removed", warm and cold
worker.

##### `siteOf()`: `null` means "inherits", `""` means "own, unlisted"

**Problem.** `blob:`, `filesystem:`, `about:`, `data:` and `javascript:`
URLs have no host of their own, or one that hides the creator.

**What it does.** `siteOf(url)` returns the hostname for http(s). For
`blob:` and `filesystem:` it parses the inner URL: an http(s) inner URL gives
its host, anything else (`blob:null/…` from an opaque origin) gives `null`.
`about:`, `data:` and `javascript:` give `null`: their origin comes from
whoever made them. Any other scheme (`chrome:`, `file:`) and unparseable
input give `""` ([lib.js › siteOf](extension/lib.js)).

**Why not the obvious way.** `new URL("blob:https://listed/…").hostname` is
`""`, which would make a listed page's blob copy look unlisted. Only
top-frame commits treat the two differently: a `null` host inherits the
previous top-frame site (unless the user typed the address), while `""`
stays unlisted ([background.js › USER_TRANSITIONS](extension/background.js)).
`arm.js`'s `inListedTab` question uses the top-frame result too. In the
frame walk both are falsy, so a subframe with either one defers to its
parent: any frame under a listed frame counts as listed whatever its own
host ([background.js › frameWasListed](extension/background.js)).

##### Top-frame pages with no site inherit the previous one unless the user typed them

**Problem.** A listed page can shed its site by navigating its own top
frame to `about:blank`, a `data:` URL or a `blob:null` it made, and then
open popups from a page that has no host.

**What it does.** When `siteOf()` gives `null` for a top-frame commit, the
host is set to `""` if the transition type is one the user makes (`typed`,
`auto_bookmark`, `generated`, `keyword`, `keyword_generated`, `start_page`,
`auto_toplevel`). Otherwise it is the previous top-frame host
([background.js › USER_TRANSITIONS](extension/background.js)). So when a
link, redirect, script or reload takes the top frame to an `about:blank`,
`data:` or `blob:null` page, that page keeps the site that was there. A
navigation to an ordinary http(s) address records the new host.

**Why not the obvious way.** Treating `about:blank` as unlisted lets the
page launder itself. Treating it as always listed would block the user's
own typed `about:blank` in a tab that used to show a listed site. Subframe
`null` hosts are left `null` on purpose, because the parent walk handles
them.

##### Marking and pruning frames that left

**Problem.** When the top frame navigates, the old page's subframes leave
with it. A popup from one of those frames moments earlier must still be
judged by them, but the history must not grow forever.

**What it does.** On a top-frame commit, every subframe entry without a
`left` time gets `left = d.timeStamp`. An entry whose `left` is more than
60 s before this commit is removed. A marked entry also fails the "same
site as before" check, so a later commit in the same frame id is recorded
again. The tab's rows are saved whenever a stamp or a removal happened,
even when the commit itself records nothing new (a same-site top
navigation): otherwise the stored rows would still show those frames as
never left, and a restore after a worker stop would bring them back
([background.js › onCommitted listener](extension/background.js), the
`stamped` flag).

A page that never commits a new top frame (a single-page app, infinite
scroll) never marks its dead subframes. `pruneDead` runs at most once a
minute, before a save, on tabs with at least 200 rows: it drops subframe
rows not marked as left whose frame is no longer in the tab and that are
older than 60 s
([background.js › pruneDead](extension/background.js)). When the tab's
frames cannot be read (`liveFrames` returns `null` for a closed or invalid
tab), the rows are kept.

**Why not the obvious way.** Deleting the old page's frames on navigation
would lose the evidence when an iframe opens a popup and the page leaves at
once. Pruning by when a row was recorded, not when its frame left, would
drop a listed iframe that loaded long ago and opened a popup a moment
before its page left. Reading an unreadable frame list as "no frames" would
prune every old subframe row of the tab.

##### A 1000-entry cap that fails closed

**Problem.** A page that keeps navigating or churning iframes could grow its
history without limit. Silently dropping the oldest top-frame entry could
make a listed origin forgotten.

**What it does.** Above `MAX_ENTRIES` (1000), the oldest subframe entry is
dropped first. Only if there are none is the oldest top-frame entry dropped,
and the tab is then added to `trimmed`
([background.js › capHistory](extension/background.js)). In
`frameWasListed`, a trimmed tab with no top entry at the moment counts as
listed ([background.js › frameWasListed](extension/background.js)).

**Why not the obvious way.** Once the earliest top entries are gone, what
the tab showed back then is unknown. Treating it as listed is the safe
default.

##### Prerender commits are skipped

**Problem.** Chrome prerenders pages (speculation rules, the address bar)
and fires `onCommitted` for them in the same tab id, though the user never
saw them.

**What it does.** `onCommitted` returns at once for
`documentLifecycle === "prerender"`
([background.js › onCommitted listener](extension/background.js)).

**Why not the obvious way.** A prerendered page would otherwise rewrite the
tab's top-frame history and could flip later verdicts.

##### Pages restored from the back/forward cache

**Problem.** A page restored from the back/forward cache commits its top
frame again, but its subframes do not re-commit, so the history misses
them. A popup from such a page often has no navigation source.

**What it does.** A top-frame commit with the `forward_back` qualifier
puts the tab in `restoredTabs` and records the live subframes from
`getAllFrames` with the commit's timestamp. While that page is current, a
no-source popup counts as listed if any recorded frame of the page was
listed (the walks share one `getAllFrames` snapshot), or if a fresh look
finds a listed live subframe, in case that record is still being written
([background.js › openerWasListed](extension/background.js)).
Any other top-frame commit takes the tab out of `restoredTabs`.

**Why not the obvious way.** Without the live record, a listed iframe on
a restored unlisted page would open popups the history knows nothing
about. Judging only the top frame would miss it the same way.

#### Surviving service-worker restarts

##### State in `chrome.storage.session`

**Problem.** Chrome stops an MV3 service worker after about 30 s of quiet.
A popup opened from a page you have been reading for a while usually wakes a
cold worker with no history in memory.

**What it does.** Each tab's history rows (packed into arrays
`[f, p, h, t, left]`) are written under their own key `h.<tabId>`, and the
small sets `spawned`, `trimmed`, `restoredTabs`, `menus` and `gone` under
one key each, to `chrome.storage.session`
([background.js › save](extension/background.js)). On startup a single
`restored` promise reads them. Saved history rows are placed before
anything this worker has already recorded and get `seq 0`. Saved menus and
closed-tab records never overwrite newer in-memory ones. Every decision
path and the `inListedTab` reply wait for `restored` first
([background.js › decideFromNav](extension/background.js), the
`tabs.onCreated` listener, the `runtime.onMessage` listener). Only the
per-tab format is read. The single `history` key of earlier versions is no
longer migrated: Chrome clears session storage whenever the extension is
reloaded or updated, so no version finds another version's state.

Tab ids are object keys in storage, so they come back as strings and are
converted with `+id` before use
([background.js › restored](extension/background.js)). Otherwise no
restored record would match a numeric `tabId`. A failed read is caught
before the seeding step, so the worker still seeds every open tab from
what it shows now and `restored` always resolves.

**Why not the obvious way.** Events can arrive before the restore finishes,
so the restore merges with memory instead of replacing it. Session storage
survives a worker restart but not a browser restart, which matches the
lifetime of tab ids.

##### Seeding tabs that were open before the worker had a record

**Problem.** Tabs open when the extension is installed, enabled or first
started have no recorded commits.

**What it does.** After restore, every tab without a restored top-frame
entry gets `{ f: 0, p: -1, h: siteOf(url) ?? "", t: 0, seq: 0 }` at the
front ([background.js › restored](extension/background.js)). A tab
showing `about:blank` at startup has nothing to inherit from, so it is
seeded as unlisted. A tab with no saved rows at all (an extension reload
clears session storage) also goes into `unknownTabs`: until its first
top-frame commit is seen, what it showed is unknown, so a popup from it
counts as listed. Separately, `frameWasListed` falls back to the tab's
current URL when the top frame has no entry at all
([background.js › frameWasListed](extension/background.js)).

**Why not the obvious way.** `t: 0` and `seq: 0` make the seed come before
every real event, so it never hides a later commit. The test is "has a
`seq 0` top entry", not "has any entries", because the worker may already
have recorded new commits before the restore finished.

##### Debounced writes that never leave a stale record

**Problem.** `onCommitted` fires often, and ad-heavy pages commit frames
many times a second. A failed write (for example, the session quota) could
leave an older history in storage, to be restored later and give wrong
verdicts.

**What it does.** `persist()` merges calls into one write at most every
`PERSIST_DEBOUNCE_MS` (150 ms); a block or a menu record writes at once,
since the worker can be stopped at any moment. `save()` runs one pass at a
time, waits for `restored`, and writes only the tabs marked dirty (plus the
small sets when they changed). Each write takes a number. If it fails, and
no newer write has started, it removes every `h.<tabId>` key, `trimmed` and
`restoredTabs`, and marks every tab and the small sets dirty again, so
the next save (whatever event schedules it) writes all of them back
rather than only what changed since
([background.js › persist](extension/background.js),
[background.js › save](extension/background.js)).

**Why not the obvious way.** Rewriting the whole history on every commit
costs more the longer a tab lives. A stale snapshot is worse than none. A
missing record falls back to current URLs, while an old one gives
confident wrong answers. The counter stops a late failure of an old write
from deleting what a newer write saved.

##### Closed tabs are remembered for 30 s

**Problem.** An ad can open a popup and then close the opener with
`window.close()`. `chrome.tabs.get` on a closed tab fails, so its history is
the only evidence.

**What it does.** `tabs.onRemoved` records the time in `gone` and persists.
It also schedules `setTimeout(persist, 31_000)`, because a save runs
`forgetGone()`, which deletes everything about tabs closed at least 30 s
ago, from every per-tab set listed in `PER_TAB`
([background.js › forgetGone](extension/background.js)). `forgetGone()`
also runs after restore, so a worker that slept through the window still
cleans up: the forgotten tabs are marked dirty there, so the next save
removes their saved `h.<tabId>` rows too instead of leaking them.

**Why not the obvious way.** Cleaning up in `onRemoved` breaks the
`window.close()` tab-under. Test: "hidden-frame open, then window.close()".

#### Context-menu exemption

##### `arm.js` reports menus from trusted events only

**Problem.** On a listed page, "Search for …" and "Open image in new tab"
open tabs that come from that page but that the user chose. A page must not
be able to use this as a loophole.

**What it does.** A capture `contextmenu` listener in `arm.js` runs only
when the frame is armed and `e.isTrusted`
([arm.js › onContextMenu](extension/arm.js)). It sends
`{ type: "contextMenu", selection, srcs }`. `srcs` are the `currentSrc` and
`src` of images and media along `e.composedPath()` (which crosses open
shadow roots), plus `<source src>` children of media. Closed shadow trees
hide their nodes from `composedPath()`, so the elements under the pointer
are walked separately with `elementFromPoint()`, stepping into each open
or closed root with `chrome.dom.openOrClosedShadowRoot` (needs the `"dom"`
permission, [manifest.json › permissions](extension/manifest.json)). That walk
also collects SVG `<image>` (`href` resolved against the document) and
`<input type=image>` (`.src`), which the browser treats as images for the
menu but which are not `HTMLImageElement`. If `getSelection()` is empty,
the selection is read from the focused input or textarea, because the
Selection API does not see text selected inside form fields. The background
keys the record by `sender.tab.id`, which comes from the browser, keeps at
most 20 distinct string `srcs` (no `data:` addresses, each cut at 2 KB)
and 500 characters of selection, stamps the time, and saves at once
([background.js › runtime.onMessage listener](extension/background.js)).

The listeners are named functions (`onPointerDown`, `onContextMenu`,
`onUntrustedActivation`, `onKeyDown`, `onMenuGone`), and `listenMenus()`
re-adds them from an observer after `document.open()` drops them. The
browser ignores a second add of the same function, so re-running on an
intact document adds nothing
([arm.js › listenMenus](extension/arm.js)).

**Why not the obvious way.** A page can dispatch a synthetic `contextmenu`,
so `isTrusted` is required. Running in the isolated world means page changes
to prototypes or `getSelection` cannot change what is read. `e.target`
alone would miss shadow-DOM images and the source the browser chose from
`srcset`, and "Open image in new tab" uses `currentSrc`. Fresh anonymous
listeners on every re-run would pile up, and two `contextmenu` listeners
are a hole, not just waste: the first uses up the selection taken at the
button press and reports `""`, the second then sees no press and reports
the selection the page planted on `mousedown`, replacing the first
record.

##### The record ends on the next press, key, blur or synthetic click

**Problem.** The worker must forget the menu as soon as it is gone, so a
page-opened tab right after cannot match its leftovers.

**What it does.** A trusted `pointerdown` (other than the right button
that opens the menu) or `keydown` in the capture phase, and a `blur` or
`visibilitychange` while the menu is open, send `contextMenuClosed`
([arm.js › onPointerDown](extension/arm.js),
[arm.js › onKeyDown](extension/arm.js),
[arm.js › onMenuGone](extension/arm.js)). While a native context menu is
open the page receives none of them, so the first one means the menu has
closed. The background deletes the record
([background.js › runtime.onMessage listener](extension/background.js)).
Every untrusted `click` or `auxclick` the page dispatches is reported as
`untrustedActivation`, which voids the record: a genuine menu pick
involves no page activation. These are never coalesced, because the
record belongs to the whole tab and another frame can write a fresh one
in the middle of a task ([arm.js › onUntrustedActivation](extension/arm.js)).

**Why not the obvious way.** `pointermove` looks like the quickest "user is
back" signal, but moving the pointer does not close a menu. Moves around the
`contextmenu` event, which fires before the menu appears, would end the
record before the user could pick anything. Test: "a click in the page ends
the menu".

##### A single-use, 30-second, address-matched exemption

**Problem.** Only the tab the menu actually offered should be kept. The
site's own links opened in new tabs must stay blocked, even right after a
context menu.

**What it does.** `fromUserMenu` runs only after the source is found to be
listed ([background.js › decideFromNav](extension/background.js)). It needs
an address the browser gave the tab (`born.get(tabId).url`), which exists
only for browser-made tabs. It needs a menu record for the source tab less
than `MENU_WINDOW_MS` (30 s) old and not voided by a synthetic click; it
waits 50 ms and checks the record again, in case such a click is still in
flight. `offeredByMenu` then
accepts the URL — what the tab was born with, or what the navigation event
names (a ctrl-clicked tab carries no address at creation) — if it equals one of the reported `srcs`, if it is the
selected address itself (Brave's "Go to <address>": the selection parsed
as a URL, with `http://` added to bare hosts, compared against the tab's
host and path exactly — not as a substring — and case-insensitively), or
if the selection, whitespace-collapsed, lowercased and cut to 50
characters (and not empty), appears in a decoded query-parameter value of
the URL. On a match the record is deleted: one tab per menu
([background.js › fromUserMenu](extension/background.js),
[menu-match.js › offeredByMenu](extension/menu-match.js)).

**Why not the obvious way.** A page-made tab has no address at creation, so
a page can never use the exemption by calling `window.open`. An empty
selection would be a substring of everything, so it is rejected. Matching
query values covers search engines' `q=` forms, and the 50-character cut
allows for engines that shorten the query. Single use and the time limit
stop one menu from approving a run of tabs. Test: "... the same, right
after a context menu" (a Ctrl+click on a link the in-page guard can't see is
still closed after a right-click). See [Known gaps](#known-gaps) for the
limits of this.

##### Searching from the PDF viewer

**Problem.** `arm.js` cannot run in Chrome's built-in PDF viewer, so "Search
for …" on text in a PDF on a listed site has no menu record.

**What it does.** A tab with no menu match is still kept when all of these
hold: the source frame is not the top frame; the URL matches `SEARCH`; the
URL is not itself listed; the tab's recorded history has no entry for that
frame id; and `getAllFrames` does not list it (the browser's own internal
frame) ([background.js › fromUserMenu](extension/background.js)).
`SEARCH` ([menu-match.js › SEARCH](extension/menu-match.js)) is anchored at `^https://`, allows an optional `www.`, a fixed
list of engines (Google and Yandex on any 2–3 letter top-level domain, and
Google also with a 2-letter second part such as `.co.uk`) and their search
paths, and requires `?` straight after the path.

**Why not the obvious way.** The anchoring, https-only scheme and the `?`
right after the path rule out look-alikes such as `google.com@evil`,
`/searchX` and unrelated hosts. The pattern is looser than a list of real
engine domains: `google.xyz` or `google.top` match, and so does a doubled
`www.www.` for ecosia, startpage, baidu and qwant (a nested `(www\.)?`).
Even if a page could trigger this branch, the most it could open is a URL
on one of those host patterns. In Brave this rule does not fire; see
[Known gaps](#known-gaps).

#### Other background details

##### `inListedTab` replies for `arm.js`

**Problem.** Sometimes `arm.js` cannot decide from inside the page: an
ancestor origin hidden as `"null"`, a top-level popup with `window.opener`,
or an opaque top page (`blob:null`).

**What it does.** The background waits for the list and the restore, then
answers "listed" if the tab's URL is listed, if its latest top-frame history
host is listed (which covers `blob:` and `about:blank` pages that inherited
the site), or if the tab is a popup of a listed site (in `spawned`, or its
pending verdict is true). The handler returns `true` to keep the reply
channel open ([background.js › runtime.onMessage listener](extension/background.js)).

**Why not the obvious way.** `sender.tab.url` alone fails for a page that
turned itself into `blob:null`. Reporting popups in flight as listed arms
the guard inside them before the background closes them, which stops
chains.

##### Cached domain list

`getDomains()` caches the `loadDomains()` promise with `??=`, so callers
during the first load share one read. A change to `storage.sync` replaces the
cache with the new value and refreshes every badge
([background.js › getDomains](extension/background.js)). Every decision path
returns early when the list is empty. A read that fails stays cached until
the list changes or the worker restarts (a known follow-up).

##### Site rules: one matcher for every part

**Problem.** The in-page decision (`arm.js`), the background, the popup
and the options page must agree on which hosts are listed, or a page would
be guarded by one layer and not the other. Matching must also be
label-anchored, and cheap in every frame of every page whatever the size
of the list.

**What it does.** [match.js](extension/match.js) is the one definition. It
has no `import` or `export`, so it loads two ways: as a classic content
script just before `arm.js` in the isolated world (never in the page's
world, where a page could read or poison it), and through
`import "./match.js"` in `lib.js` for the worker, popup, options page and
unit tests. It sets `globalThis.NoNewTabsMatch`.

`parseRule` reads `example.com`, `=host`, `*`, `!host` and `!=host`.
`covering(host, rules)` returns the rule that lists a host, or `undefined`:
an exception (`!`) that covers the host wins over everything; otherwise
the most specific exact or domain rule, then `*`. Host and rules are
lowercased and every trailing dot is dropped. Each rule array is compiled
once (cached in a WeakMap keyed by the array storage hands out) into maps
of exact hosts and domain suffixes, so a lookup walks the host's labels
(`a.b.example.com`, `b.example.com`, `example.com`, `com`) instead of the
list ([match.js › covering](extension/match.js)). `lib.js` exposes
`hostIsBlocked`, `coveringRule` and `exceptionFor` on top of it.

`normalizeRule` stores each entry in canonical form: `normalizeDomain`
(lowercase, trim, `http://` added so the URL parser can extract the host,
which also turns IDN input into punycode, leading `www.` and trailing dot
stripped, strict label pattern or bracketed IPv6) for domains, and the
same without the `www.` strip for exact rules and exceptions, where
dropping it would widen what the rule names (unsafe for an exception)
([lib.js › normalizeRule](extension/lib.js)). `saveDomains` stores the
list as one sorted, de-duplicated `chrome.storage.sync` item, and refuses
a list larger than the sync per-item quota with a message the popup and
options page show ([lib.js › saveDomains](extension/lib.js)).

**Why not the obvious way.** A bare `endsWith(d)` would match
`evilexample.com`, and a trailing-dot name (`example.com.`) would get past
the list. A separate copy of the matcher in `arm.js` could drift from the
background's. A loop over every rule per check costs more with
every listed site; the label walk costs the same for one rule or
thousands. Exceptions must beat `*` and parent domains, or the allowlist
recipe would not work.

##### Per-tab badge

`setBadge` shows `ON` on tabs whose URL (or pending URL, so it lights before
the commit) is listed. It refreshes on `tabs.onUpdated`, `tabs.onActivated`
and on list changes ([background.js › setBadge](extension/background.js), [background.js › refreshAllBadges](extension/background.js)).

The badge looks only at the tab's address
([background.js › setBadge](extension/background.js)). Blocking also
applies where it shows nothing: in a listed iframe on an unlisted page, and
on a listed page that has turned itself into `about:blank` or a `blob:null`
page.

##### Small defensive details

Every browser call that can fail on a decision path has a `.catch` with a
default: `tabs.get` gives `null` (judged not listed), `getAllFrames` gives
`null` from `liveFrames` (a decision reads that as "no frames", so the walk
jumps to the top frame, while pruning keeps the tab's rows), `tabs.remove`
and `setBadgeText` failures are ignored, and the startup `tabs.query` gives
an empty list ([background.js › liveFrames](extension/background.js),
[background.js › frameWasListed](extension/background.js),
[background.js › block](extension/background.js),
[background.js › setBadge](extension/background.js)). A decision therefore
settles, and `track()` cleans it up
([background.js › track](extension/background.js)), instead of
leaving a rejected promise that later popups would wait on. Message
handlers check `msg?.type` and `sender.tab?.id`, and the menu `srcs` are
checked to be strings
([background.js › runtime.onMessage listener](extension/background.js)).

### In-page guard

`guard.js` runs in the page's own world in every frame and stops new tabs
before they exist; `arm.js` decides where it is switched on. The rest of
this part explains how it is armed, how it defends itself against the page
it runs in, and each way of opening a tab it covers.

#### Arming and the handshake

##### How `arm.js` decides

**Problem.** A frame should be guarded when it, or any frame above it, is
on a listed site. That has to be decided from inside each frame, quickly,
and without trusting the page.

**What it does** ([arm.js › check](extension/arm.js)):

1. Check `self.origin` and `location.hostname`. Either one being listed
   arms the guard. A `blob:` or `about:blank` document inherits its
   creator's origin, and a sandboxed frame has origin `"null"` but its URL
   still names the host, so both are needed.
2. A top-level page with no `window.opener` and a normal origin is
   unlisted. No round trip.
3. A top-level popup (`window.opener` set) or an opaque top page
   (`self.origin === "null"`) asks the background (`inListedTab`), which
   knows where the tab came from.
4. A frame checks `location.ancestorOrigins`. Any listed ancestor arms it.
   If every ancestor is known and none is `"null"`, it is unlisted.
   Otherwise it asks the background.

`ask()` treats a failed message as unlisted (`.catch(() => null)`). The
background layer still closes anything the page opens, so the in-page layer
being skipped is not a hole. If the extension can't read the list in a
frame (the storage read fails), `arm.js` sends neither signal
([arm.js › check](extension/arm.js)). The guard then stays installed but
unarmed on that page: everything passes through, but its wrappers are not
removed.

Limits: a top-level page asks only if it still has `window.opener` when the
list arrives ([arm.js › check](extension/arm.js)). A cross-site popup opened
with `noopener`, or one that clears its own `opener` first, is treated as
unlisted in the page. The background still closes it and anything it opens
(`spawned`). The background's reply describes the tab (its URL, its
top-frame history, whether it is a popup in flight), not the asking frame's
own ancestors ([background.js › runtime.onMessage listener](extension/background.js)).
So frames under a listed iframe that is itself sandboxed (shown as `"null"`)
inside an unlisted page are not guarded in the page. The background's frame
walk still catches their popups.

**Why not the obvious way.** `"null"` in `ancestorOrigins` means "hidden or
opaque", not "unlisted". Asking the background for every page would slow
every load and keep waking the worker. `arm.js` gets the host matcher from
`match.js`, loaded as a classic content script just before it
([match.js](extension/match.js)): a manifest content script cannot use a
static `import`, and a dynamic one would need `lib.js` exposed as a
web-accessible resource ([manifest.json](extension/manifest.json) declares
none) and an extra async step.

##### Secret handshake: only `arm.js` can arm or remove the guard

**Problem.** `guard.js` listens for DOM events from `arm.js`, and the page
can dispatch the same events. A fake "unlisted" event would make the guard
remove itself on a listed site. `isTrusted` does not help, because events
dispatched by content scripts are untrusted too.

**What it does.** `arm.js` builds a secret from
`crypto.getRandomValues(new Uint32Array(4))` in base 36, and dispatches
`__no_new_tabs_hello__` with that secret as `detail`, synchronously at
`document_start` ([arm.js › secret](extension/arm.js)). `guard.js`
registered a `{ once: true }` listener and stores it with
``secret ??= `${e.detail}` ``, so only the first hello counts. Later
`__no_new_tabs_arm__` and `__no_new_tabs_unlisted__` events count only if
their `detail`, read with the saved `CustomEvent.prototype.detail` getter,
equals the secret ([guard.js › fromArmJs](extension/guard.js)).

**Why not the obvious way.** Both scripts run before any page script, so no
page listener exists to see the hello, and the secret never reaches page
code at that point. `crypto.randomUUID` is the natural choice but it only
exists in secure contexts. It is missing on plain-http sites, so the guard
would never arm there. `localhost` counts as a secure context even over
http, so a suite that only uses `localhost` would not notice; the tests map
`*.test` to the local server to cover this
([run.mjs › insecureSite](test/run.mjs)). The secret is a string
because Chrome hands a `CustomEvent.detail` from the isolated world to the
page's world only as a primitive: an object made in `arm.js` would show up
as `null` in `guard.js`. The guard compares it by value, read through the
saved `CustomEvent.prototype.detail` getter
([guard.js › detailGet](extension/guard.js)). Tests: "page fakes the
'unlisted' signal", "page faked 'unlisted' during load", "page fakes 'arm',
then opens".

See [Known gaps](#known-gaps): a page capture listener could stop the arm
signal.

##### Arming is one-way

**Problem.** After the first hello, every arm or unlisted event carries the
secret, so a page listener could read it and replay it. A late
"unlisted" (after the list changes) must not disarm a guarded page either.

**What it does.** `onArm` only arms. `onUnlisted` acts only while not armed
([guard.js › onArm](extension/guard.js), [guard.js › onUnlisted](extension/guard.js)). On the `arm.js` side,
`arm()` sends at most once and `unlisted()` never sends after arming
([arm.js › arm](extension/arm.js), [arm.js › unlisted](extension/arm.js)). Removing a site from an open
page needs a reload, which is why the popup reloads the tab
([popup.js › render](extension/popup.js)).

**Why not the obvious way.** A two-way switch would let a page that sniffed
the secret disarm itself. With an arm-only switch, the worst a replay can do
is arm the guard.

##### Inert until armed, so copies saved during load still work

**Problem.** Ad scripts save `window.open`, a frame's `open`, a bound
`open` or a prototype method during page load, long before `arm.js` has its
answer.

**What it does.** The guard installs everything at `document_start`, so any
copy the page saves is already a guard wrapper. Each wrapper checks
`state.armed` when it is called, not when it was made. Before arming it
forwards everything to the native function unchanged
([guard.js › guarded](extension/guard.js)). After arming, the same saved
copies block.

**Why not the obvious way.** Installing only after arming would be too
late: the page would already hold real natives. Installing armed from the
start would break unlisted pages. Installing early in a pass-through state
solves both.

##### Frames and popups of an armed page are armed from birth

**Problem.** A frame or popup of an armed page should be guarded from its
first line of script. Waiting for `arm.js`'s storage read (and maybe a
round trip) leaves a gap.

**What it does.** At startup the guard reads `window.parent` and
`window.opener`. If either is another window whose marker function returns
exactly `true`, the guard starts armed
([guard.js › MARK](extension/guard.js)). Cross-origin access
throws and is caught; `arm.js` decides those cases.

**Why not the obvious way.** This runs before any page script in the new
window. The marker it reads lives on the parent or opener, where page
scripts have already run, and it stays configurable until that window is
armed ([guard.js › mark](extension/guard.js),
[guard.js › rec.lock](extension/guard.js)), so that page could redefine it.
At worst that arms the guard early, or leaves the decision to `arm.js`.

##### Live arming without a reload

**Problem.** When a site is added while its page is open, the page should
become guarded at once, including hidden frames that already exist, even
before any user input.

**What it does.** `arm.js` listens to `chrome.storage.sync.onChanged` (only
the sync area, so the background's frequent session-storage writes do not
wake every frame of every page) and checks again ([arm.js](extension/arm.js)).
`guard.js`'s `arm()` sets `armed`, clears `removed`, reinstalls into the
window if it had removed itself, locks `window.open` in every realm, sweeps
every same-origin child frame, and tames the sandboxed iframes of every
document it is installed in, adopted `javascript:` frames included, since
those have no `arm.js` of their own ([guard.js › arm](extension/guard.js)).

**Why not the obvious way.** Clearing `removed` is required because
`install()` refuses to run while it is set. The sweep covers frames the page
already holds a reference to and that no later insertion or input would
reach. Test: "hidden frame's open, no input", run with the popup blocker
off.

Limits (from reading the code): if the page was first found unlisted, the
guard had removed itself, and the page then ran with the browser's real
functions. Copies of `window.open`, a frame's `open` or a prototype method
that it saved in that time are not guarded after live arming. The reinstall
also reads `window.Function`, `window.open`, `window.Document`,
`window.MutationObserver` and the like from a page that may have replaced
them ([guard.js › install](extension/guard.js),
[guard.js › nativeOpen](extension/guard.js)). For full in-page protection,
reload the tab after adding a site. The background layer covers the rest.

#### Hardening against a hostile page

##### Content-type gate

The guard's first statement returns unless `document.contentType` is HTML,
XHTML, SVG or XML, the types that run script
([guard.js › document.contentType](extension/guard.js)). It runs before any page
script, so `document.contentType` and `RegExp.prototype.test` are still the
browser's own.

##### Capture every built-in before any page script runs

**Problem.** Ad scripts replace prototype methods such as
`Function.prototype.apply`, `Set.prototype.has`, `WeakMap.prototype.get`,
`Event.prototype.composedPath`, `Element.prototype.getAttribute` and
`Array.prototype.push`. A guard that calls these when it needs them can be
steered or broken.

**What it does.** At startup the guard saves everything it will use later:
`Reflect.apply`, `Object.defineProperty`, `Object.keys`, the string
methods, the WeakMap/WeakSet/WeakRef methods, `add/removeEventListener`,
the Node, Element, Document and Event methods and accessors, and the
window accessors (`name`, `length`, `origin`, `frameElement`, `top`)
([guard.js › uncurry](extension/guard.js), and the constants after it). Array appends go through
`defineProperty` instead of `Array.prototype.push`, and option and
descriptor objects handed to the browser are copied to a null prototype,
so poisoned `Object.prototype` or `Array.prototype` members are never
consulted. After that it calls these saved copies for the checks that
decide whether an open, click or submit opens a new context. A few steps
still read live, page-visible properties: `win.Function` at install and in
`relisten` (with a fallback that matches the record by window when the
page replaced `Function`), `win.MutationObserver` and its
`observe`/`disconnect`, `win.DOMException` when refusing
picture-in-picture, and each realm's own `Range.prototype.startContainer` getter (never the
`Node.prototype` property a page can shadow) when finding a `Range`'s
window ([guard.js › viewOfTarget](extension/guard.js)). Frame windows are
read through the saved native `contentWindow` getter of `<iframe>`,
`<frame>` or `<object>`, chosen by tag, never through `el.contentWindow`,
which a page can shadow with an own property on the element
([guard.js › childWindow](extension/guard.js)). See
[Known gaps](#known-gaps).

**Why not the obvious way.** The capture only counts because it happens
before any page script runs. The same code run later would capture the
page's replacements.

##### Call through `Reflect.apply`, never `.call` or `.apply`

**Problem.** `fn.call(obj, …)` looks up `Function.prototype.call` at call
time, and a page can replace it.

**What it does.** `uncurry(f)` returns `(self, ...args) => apply(f, self, args)`,
where `apply` is the saved `Reflect.apply`
([guard.js › uncurry](extension/guard.js)). Every saved method becomes a
plain function that takes the receiver first. Wrappers forward to natives
the same way: `apply(native, this, args)`.

**Why not the obvious way.** `saved.call(x)` can still be poisoned even if
`saved` was captured early, because `.call` is looked up when the call
happens. A rest parameter builds its array without the iterator protocol,
so it is safe; spreading at the call site would not be.

##### Native getters instead of property reads

**Problem.** Reads like `node.nodeType`, `event.type` or `w.name` can be
faked with an own property on the object or a replaced accessor on the
prototype.

**What it does.** `getter(proto, key)` takes the native `get` function from
the prototype at startup and uncurries it
([guard.js › getter](extension/guard.js),
[guard.js › nodeType](extension/guard.js)). The guard calls
`nodeType(n)`, `localName(el)`, `evType(e)`, `winName(w)` and so on, which
run the browser's own getter whatever the page has defined on the object.

**Why not the obvious way.** The test page redefines its own `window.name`
as a getter that returns `'ghost'` and then calls `open(url, 'ghost')`
([v14.html › j-ghost](test/site/v14.html)). A plain `w.name` read would find
the page itself as a matching "frame" and let a new window open. Test:
"fake window.name, then open into it".

##### Native getters that can throw get safe defaults

A captured native getter throws "Illegal invocation" on the wrong kind of
object, for example a plain `Event('click')` with no MouseEvent fields.
`mouseKey()` wraps each MouseEvent getter in `try/catch` and returns
`false`, or `0` for `button` ([guard.js › mouseKey](extension/guard.js)).
`submitterOf`, `fromArmJs`, `viewOf`, `isElement` and `formOf` also catch.
Otherwise a page could make the guard's listeners throw on purpose and skip
the check that follows.

##### No iterators after startup

**Problem.** `for…of`, spread and array destructuring go through
`Symbol.iterator` and `%ArrayIteratorPrototype%.next`, and Array methods
such as `map` or `forEach` can be replaced outright; a page can change
either.

**What it does.** After startup the guard uses index loops only: `each()`
and `find()` are plain `for (i < length)` loops. `frameNamed` keeps a
manual stack and `readArgs` fills a fresh array, but both write through
`ownIndex()`, which defines own data properties instead of assigning, so
a swallowing setter on `Array.prototype` cannot eat an index
([guard.js › frameNamed](extension/guard.js),
[guard.js › readArgs](extension/guard.js)). Appends to the guard's
own lists go through the same `defineProperty` path.

**Why not the obvious way.** The rule is about when code runs, not about
syntax. The startup block uses `.map`, destructuring and `for…of` because no
page script has run yet ([guard.js › winName](extension/guard.js),
[guard.js › MARK](extension/guard.js)). The same syntax in a wrapper body
would be unsafe.

##### Bound helpers and captured constructors

`setTimeout`, `console.info` and `Promise.reject` are bound at startup, and
the `WeakMap` and `WeakRef` constructors are saved
([guard.js › setTimer](extension/guard.js)). `install()` runs again much
later for adopted frames and on live arming, and a bare `new WeakMap()` then
would use whatever the page has put in `window.WeakMap`. A page that
replaces `console.info` also cannot see or silence the guard's log.

##### Capture as a boolean, not an options object

`listen()` and the shadow-root listeners pass `true` as the third argument
([guard.js › listen](extension/guard.js),
[guard.js › install](extension/guard.js), the `attachShadow` wrapper). An options object such
as `{ capture: true }` is read through `Object.prototype`, so a page could
add `signal` (an aborted `AbortSignal`) or flip `capture` on every listener
the guard adds later. The only options object left is the `{ once: true }`
in `later()` ([guard.js › later](extension/guard.js)), which is the
`Object.prototype.signal`/`capture` gap listed under
[Known gaps](#known-gaps). The hello listener's `{ once: true }`
([guard.js › secret](extension/guard.js)) is safe because it is created
before any page script runs.

##### Strict mode and `this ?? win`

**Problem.** Pages save an `open` and call it bare (`const o = w.open; o(url)`)
or on another window (`savedFrameOpen.call(window, url)`). The guard must
judge the target from the window the browser will open from.

**What it does.** The guard is `"use strict"`, so a bare call leaves `this`
undefined instead of the guard's own global. The wrapper uses
`const self = this ?? win`, where `win` is the window it was installed into
([guard.js › "use strict"](extension/guard.js),
[guard.js › guarded](extension/guard.js)).

**Why not the obvious way.** In sloppy mode a bare call would get the guard
script's own global, which is the outer page when the guard adopted a
frame, so a frame's saved `open` would act from the outer page. Tests:
"early-touched iframe: open() opener is itself" and "open(_self) stays in
it".

##### Wrappers that look like built-ins

**Problem.** Ad scripts detect wrappers through `fn.name`, `fn.length`, a
`prototype` property or `Function.prototype.toString`, and then look for an
unpatched `window.open` elsewhere.

**What it does.** Every replacement is written as a method shorthand
(`{ open(...args) {} }.open`, `{ [key]() {} }[key]`) or an object-literal
accessor. These get the right name, have no `prototype` and cannot be
constructed, like native methods. `wrap()` also copies `name` and `length`
from the native ([guard.js › wrap](extension/guard.js)). In each
realm, `Function.prototype.toString` is replaced with one that follows the
`nativeOf` map (wrapper to native, to the end of the chain) and calls the
realm's original `toString` on the native. It registers itself too, so
`toString.toString()` looks native
([guard.js › nativeToString](extension/guard.js)).

**Why not the obvious way.** A plain `function open(...args)` has a
`prototype` and the wrong `length`. The spoof must be per realm, because
each frame has its own `Function.prototype`. Limits seen in the code: the
`window.open` accessor's setter is not registered in `nativeOf`, the getter
reports `function open()` rather than a getter's native source, and stack
traces show `chrome-extension:` frames while the guard is installed. In
adopted frames the wrappers are functions from the parent page's realm,
because the parent's guard creates them, so
`Object.getPrototypeOf(frame.open) === frame.Function.prototype` and
`frame.open instanceof frame.Function` are false, unlike the native. A
blocked `requestWindow()` in a frame likewise returns the parent realm's
`Promise` ([guard.js › rejectWith](extension/guard.js),
[guard.js › install](extension/guard.js), the `requestWindow` wrapper). Test:
"Function.prototype.toString looks native".

##### Rate-limited logging

The guard logs the first 20 blocks, then one "further blocks on this page
not logged" line, then nothing ([guard.js › log](extension/guard.js)).
Some ad scripts retry many times a second. Link and form URLs are logged
resolved against the document's base URL, the way the browser resolves
them — not the raw attribute. Test: "console shows resolved URL".

#### window.open

##### Blocked opens return `null`

A blocked `window.open` or three-argument `document.open` logs and returns
`null`, which is what the browser's popup blocker returns
([guard.js › guarded](extension/guard.js)). Throwing, or returning a
fake window, would break site code or tell ad scripts to try another route.
Same-tab opens (`_self`, `_top`, `_parent`, a reachable named frame) go
through unchanged.

##### Read url and name once, as strings

**Problem.** `window.open` converts its arguments with ToString. An object
can answer `"_self"` when the guard checks it and `"_blank"` when the
browser converts it again.

**What it does.** Once armed, `readArgs()` turns the first two arguments
into strings once with a template literal, leaves `null` and `undefined`
alone, and keeps the other arguments and the count unchanged. Those strings
are both checked and passed on ([guard.js › readArgs](extension/guard.js),
[guard.js › guarded](extension/guard.js)).

**Why not the obvious way.** Checking the original arguments and then
forwarding them is a time-of-check/time-of-use gap. Converting everything,
or padding to two arguments, would change what `open()` with no arguments
does.

##### `about:` and `javascript:` are blocked even in the same tab

**Problem.** PopAds blanks the page with `open('about:blank', '_self')`.
Obfuscated forms like `" \tjAvA\nScRiPt:"` get past a simple prefix check.

**What it does.** `inertUrl` rebuilds the scheme the way the URL parser
does: it skips leading control characters and spaces, drops tab, LF and CR
anywhere, stops at 11 characters, and lowercases. It then checks for
`about:` or `javascript:`. `window.open` and three-argument
`document.open` block those URLs aimed in-tab (`_self`, `_top`,
`_parent`), where they would run in place of the page
([guard.js › blanksPage](extension/guard.js)). Aimed at a named frame
that resolves, they go through: the frame resets instead of opening a
tab, and a missing name still opens a new context (blocked as usual).

**Why not the obvious way.** The browser ignores those characters, so
`startsWith` on the raw string would pass `java\nscript:`. Test:
"open('about:blank', '_self') blocked".

##### `window.open` stays a plain data property until armed

**Problem.** Many pages save and restore `window.open`'s descriptor or
assign to it. An accessor, or a non-configurable property, would break that
code and show that a guard is present on every site.

**What it does.** Before arming, `window.open` is a data property with the
native's attributes (writable, enumerable, configurable) holding the
guarded wrapper. The native is read from the window's own descriptor, not
through `win.open` ([guard.js › nativeOpen](extension/guard.js)). Tests: "window.open was plain
during load too", "window.open is a plain property again".

##### One stable wrapper per function

`guarded(fn)` keeps one wrapper per underlying function in a WeakMap, so
`window.open === window.open` holds and saved references compare equal
([guard.js › guarded](extension/guard.js)). The WeakMap does not
keep page functions alive.

##### Once armed: a non-configurable accessor with a setter

**Problem.** After arming, the page can still assign a fresh native to
`window.open` (another frame's `open`), or try to redefine or delete it.

**What it does.** `rec.lock()` replaces `window.open` with a
non-configurable accessor. It takes the current value (from the data
property, or by calling the page's own getter), unwraps it if it is one of
the guard's wrappers, and stores it. The getter returns `guarded(value)`,
and the setter just stores the new value
([guard.js › rec.lock](extension/guard.js)). Being
non-configurable, the property can no longer be redefined or deleted.

**Why not the obvious way.** A writable data property lets any assignment
replace the guard. A getter without a setter makes
`"use strict"; window.open = f` throw, which breaks sites that wrap
`window.open`. Unwrapping first avoids a wrapper around a wrapper. If the
page made `window.open` non-configurable before arming, `lock` leaves it
alone (it cannot change it). Tests: "window.open = iframe's open", "site can
wrap window.open".

##### Page-written hooks are returned as they are

**Problem.** Analytics code sets `window.open = myHook` and expects
`window.open === myHook`. Ad code sets it to a real native from another
frame.

**What it does.** The getter calls `pageWritten(value)`, which returns
every function except the native `open`s the guard itself saw at install
time, in any realm ([guard.js › nativeOpens](extension/guard.js),
[guard.js › pageWritten](extension/guard.js)). A page-written hook — bound, a
proxy, or one whose source happens to mention `[native code]` — is returned
unchanged, so `window.open === myHook` holds even after the tag manager
reassigns it fifty times. Whatever native it calls is a guarded wrapper
anyway, so blocked opens still go through the hook first.

**Why not the obvious way.** Source text cannot tell a hook from a native:
a bound function prints `[native code]`, and so does a proxy of the
guarded wrapper (whose `toString` reports native source). Only functions
the guard itself saw as `window.open` count as native. Test: "page
window.open hook keeps identity".

##### `document.open` with three arguments

`document.open(url, name, features)` is an old alias for `window.open`. The
wrapper blocks three-argument calls that open a new context or an inert URL,
judged from the document's own window. Calls with fewer arguments replace
the document and go through ([guard.js › install](extension/guard.js), the `Document.prototype.open` wrapper).
Only the argument count tells the two apart. Test: "document.open(3 args)".

##### Picture-in-picture windows are refused

`documentPictureInPicture.requestWindow()` opens an always-on-top window.
When armed, the wrapper rejects with a `DOMException` `NotAllowedError` made
from that realm's own `DOMException`
([guard.js › install](extension/guard.js), the `requestWindow` wrapper). That looks like the
browser's own refusal, so page code takes its usual error path. Tests:
"listed: refused", "unlisted: not refused by us".

#### Frames

Same-origin child frames share the parent's origin but have their own
copies of every built-in. Some of them never get a content script from the
browser. The guard therefore installs itself into them from the parent. This
is called adopting a frame.

##### `javascript:false` frames get no content script

**Problem.** An `<iframe src="javascript:false">` never commits a document,
so the browser injects no content scripts into it and its `window.open`
stays native. PopAds, Adcash and similar scripts use exactly this.

**What it does.** These frames are same-origin with the parent, so the
parent's guard installs into them through every adoption path below. Each
adopted frame gets its own insertion wrappers, so a `javascript:false` frame
inside another one is covered ([guard.js › adopt](extension/guard.js)).

**Why not the obvious way.** `match_origin_as_fallback` and `all_frames` do
not help, because there is no committed document to inject into. Only the
parent can guard the frame.

##### Every realm is patched with its own prototypes

**Problem.** Each same-origin frame has its own
`HTMLFormElement.prototype.submit`, `Document.prototype.open`,
`Function.prototype.toString` and so on. Ads call a frame's copy on the
outer page's elements: `frameForm.submit.call(outerForm)`.

**What it does.** `install(win)` reads everything from the target window
(`win.Function.prototype`, `win.Document.prototype`,
`win.HTMLFormElement.prototype`, `win.MutationObserver`, …) and patches it
([guard.js › install](extension/guard.js)). `state`, `nativeOf` and
the decision helpers are shared by all realms.

**Why not the obvious way.** Patching only the top window leaves every
frame as a source of unpatched natives. Test: "form.submit from iframe
realm".

##### Bookkeeping keyed by the realm's `Function`

**Problem.** The guard must know whether a window is already patched. A
frame's `WindowProxy` stays the same across navigations, so keying by window
would treat a fresh, unpatched document as done, while a new document gets a
new realm and a new `Function`.

**What it does.** `records` is a WeakMap from `win.Function` (the realm's own
constructor) to `{ undo, lock, relisten }`
([guard.js › records](extension/guard.js)). A new document in a new
realm has a new `Function`, so it is installed again. `win.Function` also
throws for cross-origin windows, so `adopt()`'s `try/catch` skips those;
they get their own `guard.js`. A list of WeakRefs (`realms`) makes the
WeakMap iterable without keeping removed frames alive. Dead entries are
skipped but not removed while the page is armed
([guard.js › forEachRecord](extension/guard.js)), so `realms` grows by
one small WeakRef per adopted realm for the life of the page. Only
`uninstallAll` clears it ([guard.js › uninstallAll](extension/guard.js)).

The key is read as `win.Function`
([guard.js › install](extension/guard.js)), an ordinary writable global,
just like the marker. (The code comment at
[guard.js › records](extension/guard.js) says it can't be faked;
that holds only because of when it is read.) What protects it is timing:
it is read at `document_start` for the guard's own window, and during
adoption for a child, before the page can reach it. A page that got hold of
a frame first could point its `Function` at a realm already recorded, and
`install()` would skip it, just as it would for a planted marker.

**Why not the obvious way.** Patching follows realms, not windows. A
WeakMap holds its values only while the key is alive, so the closures in a
record do not keep dead frames around.

##### The marker: a live "installed and armed?" flag

**Problem.** Frames and popups need to know whether the window that made
them is armed. Two guard copies (the frame's own and the parent's adopting
one) must not both install into one window.

**What it does.** `install()` defines `window.__noNewTabsGuard` as a
function `() => state.armed`: non-enumerable, non-writable, configurable
([guard.js › mark](extension/guard.js)). Readers get the live
state. `install()` skips a window that already has its own marker
([guard.js › install](extension/guard.js)). When armed, `rec.lock()` makes
the marker non-configurable ([guard.js › rec.lock](extension/guard.js)).
Readers check `other[MARK]?.() === true`, so only a real `true` counts.

**Why not the obvious way.** A page can fake the marker. A fake that returns
`true` only arms more, which is the safe direction. A fake planted before
adoption would make `install()` skip the frame, so adoption has to happen
before the page can reach a frame. Test: "frame pre-marked as guarded"
([tricks.html](test/site/tricks.html)).

##### The initial `about:blank` realm is reused by the frame's first document

**Problem.** A page creates an iframe with `src=/child.html` and, before it
loads, takes its `open` from the initial `about:blank` window. Chrome reuses
that global for `child.html`, so the saved `open` keeps working after the
real page loads.

**What it does.** Inserting the frame (or reading `contentWindow`) adopts the
`about:blank` realm at once. When `child.html` loads into the same realm,
its own `guard.js` finds the marker and backs off, leaving the parent's
patches ([guard.js › install](extension/guard.js)). The saved
wrapper resolves bare calls to the frame's own window (`this ?? win`).

**Why not the obvious way.** Without the back-off, two guard copies would
wrap one realm. Without adopting on insert, a native `open` saved from a
realm that lives on as the real page would escape. Test: "open saved before
the frame loaded".

##### Adopt inside every DOM insertion call, before it returns

**Problem.** Ad scripts insert a frame and read `frame.contentWindow.open`
on the very next line.

**What it does.** `framesAfter` wraps every insertion method. It finds the
window the node belongs to, reads that window's frame count with the native
`length` getter, runs the native call, and in `finally` hands the count
before and after to `adoptAdded` ([guard.js › framesAfter](extension/guard.js),
[guard.js › adoptAdded](extension/guard.js)). For every element argument,
it adopts the element if it is a frame (`iframe`, `frame`, `object`,
`embed`) and every frame nested inside it: a cheap `querySelector`
existence test first, which says no for most inserted subtrees, then
`querySelectorAll`. When armed, each inserted iframe also gets its sandbox
tamed. It sweeps the whole window only when the count grew and there was
no element argument (string HTML such as `innerHTML`, which can land
anywhere, or a text node) or the count grew by more than the frames it
found (a frame the call made some other way). The `finally` means a call
that throws is still handled.

**Why not the obvious way.** A MutationObserver runs as a microtask, after
the inserting script has already read `contentWindow.open`. Only a
synchronous wrapper closes that gap. Adopting just the argument would miss
a frame nested in an inserted `<div>`, which the page can still reach
through `frames[n]` without touching the element. Sweeping on every
insertion would walk every frame of the page on every `appendChild`.
Tests: "frame nested in an inserted div", "two frames at two depths in one
insert".

##### Every insertion API, on each interface that owns it

`before`, `after` and `replaceWith` are defined separately on `Element`,
`CharacterData` and `DocumentType`, not inherited from `Node`. The guard
wraps an explicit table: `Node` (`appendChild`, `insertBefore`,
`replaceChild`); `Element` (`append`, `prepend`, `before`, `after`,
`replaceWith`, `replaceChildren`, `insertAdjacentElement`,
`insertAdjacentHTML`, `setHTMLUnsafe`); `CharacterData` and `DocumentType`
(`before`, `after`, `replaceWith`); `Document` (`append`, `prepend`,
`replaceChildren`); `ShadowRoot` (`setHTMLUnsafe`); `Range` (`insertNode`,
`surroundContents`) ([guard.js › insertions](extension/guard.js)).
`method()` skips a key that is not an own function, so a missing API is
skipped without error ([guard.js › method](extension/guard.js)).
The `innerHTML` and `outerHTML` setters on `Element` and `ShadowRoot` are
wrapped too;
`ShadowRoot.innerHTML` is its own accessor, not inherited from `Element`.
A sweep only finds frames through `window.length` and `win[i]`, which do
not reach frames inside a shadow tree, so those are adopted by the
`contentWindow` getter when the page reads it, not by an insertion
wrapper.

##### Finding the window that gains the frame

`viewOfTarget` maps a `Range` to its start container (asked only by the
`Range` wrappers, through that realm's own getter), a `Document` to its
own `defaultView`, and any other node to its owner document's window
([guard.js › viewOfTarget](extension/guard.js)). A Document's
`ownerDocument` is `null`, so a naive lookup would miss
`document.append(...)`. Inserting into a child frame's document must sweep
that frame's window, not the top one.

##### A frame swapped for another one

`replaceWith`, `replaceChild` or moving an iframe can leave the count the
same while a new, unguarded window exists. The frames among and inside the
element arguments are adopted whatever the count says
([guard.js › adoptAdded](extension/guard.js)). Re-adopting is safe because
`install()` runs once per realm.

##### `contentWindow` and `contentDocument` adopt before handing over

For `HTMLIFrameElement`, `HTMLFrameElement` and `HTMLObjectElement`, the
`contentWindow` and `contentDocument` getters call the native getter, adopt
the resulting window, and return the value unchanged
([guard.js › install](extension/guard.js), the `contentWindow` and
`contentDocument` loop). This is the one moment
the page is certain to get a reference, so guarding here cannot come too
late. Test: "jsf iframe contentWindow.open".

##### Parser-inserted frames: a MutationObserver

**Problem.** The HTML parser inserts frames without calling any DOM method.
An inline script right after an `<iframe>` tag can save `frames.name.open`.

**What it does.** One MutationObserver per installed window, made from that
realm's own constructor, watches the document. It ignores the records and
only compares the frame count with the last count; on a change it sweeps
and, when armed, tames the document's sandboxed iframes
([guard.js › install](extension/guard.js), `observer`).

**Why not the obvious way.** Parsing calls nothing that can be patched. The
only hook is the microtask checkpoint the parser runs before each script.
This timing is also what beats a page that plants a fake marker on a
parser-inserted frame. Test: "open saved from a frame, while parsing".

##### A capture `load` listener on the document

A frame's window can change when its first document loads. A capture `load`
listener on the document adopts the window of any frame element that
finishes loading, through `childWindow`'s native getters, and tames an
iframe's sandbox first ([guard.js › install](extension/guard.js)). It has
to be on the document in the capture phase: element `load` events do not
bubble and never reach `Window` listeners.

##### Sweep before any input reaches page handlers

**Problem.** A page can reach frames through `window[n]` or `frames[n]`
without touching the element, so no getter or insertion hook runs.

**What it does.** Capture listeners on the window for `pointerdown`,
`mousedown`, `pointerup`, `keydown`, `touchstart`, `touchend` and `click`
sweep all frames when armed ([guard.js › onInput](extension/guard.js)).
They run before any page handler for that input.

**Why not the obvious way.** A popup needs user activation, and a new frame
has none. Only frames that existed before the input matter, so sweeping at
the start of each activating input covers them. `pointermove` is left out
because it grants no activation.

##### `adopt()` and `sweep()`

`adopt(win)` runs `install(win)` then `sweep(win)` inside one `try/catch`,
so a cross-origin child is skipped. `sweep()` reads the count with the
native getter and indexes `win[i]` inside `try`, recursing into
grandchildren ([guard.js › sweep](extension/guard.js)).

##### Listeners re-added after `document.open` and `write`

**Problem.** Replacing a document with `document.open()` (or a `write` after
load) makes the browser drop every listener on the window and document.
That removes the guard's click, submit and load listeners and the control
listeners `arm.js` signals through.

**What it does.** `document.open`, `write` and `writeln` are wrapped. In a
`finally` block the wrapper calls `relisten(this)` and `sweepFrom(this)`
([guard.js › install](extension/guard.js), the `write` wrapper). `relisten` finds the
realm's record and re-adds every listener recorded by `listen()`, plus the
control listeners for the guard's own window
([guard.js › relisten](extension/guard.js)). `sweepFrom` adopts
frames the written HTML created. Two rewrites the wrappers cannot cover
are handled by observers, which survive `document.open()`: `arm.js`
re-adds its named menu listeners (`listenMenus`), and the guard puts its control
listeners back even while uninstalled, so a rewritten unlisted page still
hears a later arm signal. Tests: "menu reported after document.open()",
"menu reported in rewritten iframe", "rewritten unlisted page arms when
listed".

**Why not the obvious way.** `addEventListener` ignores a listener already
registered with the same type, callback and capture, so calling `relisten`
after every write does not register anything twice; the same holds for
`arm.js` only because its listeners are the same function objects every
time. Tests: "one menu report per menu after mutations", "_blank after
document.open() of page", "_blank in frame written during/after load".
`relisten` finds the record through `win.Function`, read at the time of
the write, so a page that replaces `window.Function` first defeats it; see
[Known gaps](#known-gaps).

##### `data:` frames and sandboxed frames

A `data:` frame has an opaque origin. The parent cannot install into it, so
the browser injects the frame's own `guard.js` (`match_origin_as_fallback`).
Its origin is `"null"`, so `isSandboxed()` is true and named-target searches
stay inside the frame. `arm.js` finds the listed parent in
`ancestorOrigins`. Test: "_blank link in a data: frame".

A frame with `allow-same-origin` but without `allow-scripts` runs no script,
so its own `guard.js` never runs. The parent page can still call its
`window.open` or `form.submit`, and links inside it still work. The parent
adopts it like any same-origin child ([guard.js › adopt](extension/guard.js)).
Tests: "no-script sandbox frame's window.open / form.submit", "_blank link
in a no-script sandbox frame".

##### Opaque sandboxed frames lose `allow-popups`

**Problem.** A frame with neither `allow-scripts` nor `allow-same-origin`
has an opaque origin: the parent can never adopt it and no script runs in
it, so a `target=_blank` link inside it would flash a tab. A page can put
`allow-popups` there in many ways: in markup, through the parser, before
the page is armed, or after insertion through any of a dozen
attribute-write routes.

**What it does.** On listed pages `tameSandbox` takes `allow-popups` out of
an iframe's `sandbox` attribute. When it actually strips something, it
also navigates the frame again to what its attributes say (the same
`srcdoc`, else the same `src`) ([guard.js › tameSandbox](extension/guard.js),
[guard.js › renavigate](extension/guard.js)). It runs at script
insertion (`adoptAdded`), when the observer sees the frame count change,
on each frame's `load`, and at arming for every document the guard is
installed in. After insertion, every write route re-tames the iframe
once the write is done, from the value the browser stored:
`setAttribute` (which also strips a plain string value up front),
`setAttributeNS`, `setAttributeNode(NS)`, `toggleAttribute`,
`attributes.setNamedItem(NS)`, the `sandbox` IDL setter, the `sandbox`
DOMTokenList (`add`, `remove`, `toggle`, `replace`, `value`; removing
`allow-scripts` can leave `allow-popups` on an opaque frame; the guard remembers which
iframe each list came from), and the `Attr` node's `value`, `nodeValue` and
`textContent` ([guard.js › tameAfter](extension/guard.js),
[guard.js › tameList](extension/guard.js),
[guard.js › tameAttr](extension/guard.js)).

**Why not the obvious way.** Chromium takes a frame's sandbox flags when a
navigation starts (for the first document, at insertion), so stripping the
attribute of a frame already in the document only affects its next
navigation: without the second load, the document already there keeps
`allow-popups`. Checking the arguments of each write is not enough either:
a name object whose `toString` answers one thing to the guard and
`"sandbox"` to the browser, a namespace or an `Attr` node would split the
two views, so the guard reads back what the browser stored. The extra
load happens only when something was stripped. The routes on `Node`
(`nodeValue`, `textContent`) and `DOMTokenList` cost every other call one
`nodeType` read or one WeakMap lookup, within measurement noise
([ARCHITECTURE.md](ARCHITECTURE.md)). Tests: "opaque sandbox _blank
click", "markup-inserted opaque sandbox _blank click", "parser-inserted
opaque sandbox _blank click", "opaque sandbox present before arming",
"two-faced setAttribute escalation _blank click", and an "escalation via
… stripped" check per write route.

#### Links, forms and clicks

##### Link clicks: capture on the window

**Problem.** `target=_blank`, Ctrl/Cmd-click (new tab), Shift-click (new
window) and middle-click all open new contexts. Downloads must still work.

**What it does.** `onActivate` is a capture listener on the window for
`click` and `auxclick`, so it runs before page handlers
([guard.js › onActivate](extension/guard.js)). It returns early if the
event is already `defaultPrevented` (handled further out, which avoids
double handling between window and shadow-root listeners). It takes the
first link in the saved `composedPath`, so the innermost link wins. A link
with `download` is left alone unless it is a middle or modifier click. A
middle `auxclick`, a click with Ctrl, Meta or Shift, or a `click` with
button 1 (a script dispatching one is treated as a middle click) is
cancelled at once: no target switch can save it, since a modifier or
middle click opens a new context whatever the target says. A plain click
is never cancelled here; its fate is decided in the late check below, so a
page handler that switches the target back to `_self` gets a working link
instead of a dead click.

**Why not the obvious way.** `composedPath` sees through open shadow roots,
where `e.target` is retargeted to the host. A `_blank` download starts a
download, not a tab. Right-click `auxclick` (button 2) does not open
anything.

##### `later()`: look again after the page's own handlers

**Problem.** A page handler that runs after the guard can set
`link.target = "_blank"`, insert `<base target=_blank>` or change
`form.target` — or switch a `_blank` target back to `_self`, in which case
cancelling up front would leave a dead click.

**What it does.** `later()` adds a one-time non-capture listener for the
same event type and decides there: if the target still opens a new context
after the page's handlers ran, it cancels
([guard.js › later](extension/guard.js)). `ev === e` ignores a
different event of the same type. A `setTimeout(0)` removes the listener if
the page stopped propagation. The listener is added where the event can
reach: the window for document events, the shadow root itself for events
inside one (submit events and non-composed clicks never leave it).

**Why not the obvious way.** Capture-only checks are too early, and a
capture cancel would also kill clicks the page legitimately switches back
to `_self`. Bubble-only checks are beaten by `stopPropagation`: a handler
that changes the target and then stops propagation beats both checks, so
the late check never runs. In those cases the background layer closes the
tab (a brief flash). Tests: `target set by a page click handler`, `<base
target> set by a click handler`, `form target set by a submit handler`,
`late _self switch on link`, `late _self switch on form`.

##### Forms and `onSubmit`

A capture `submit` listener on the window computes the target from the
submitter's `formtarget`, then the form's `target`, then `<base target>`
([guard.js › formTarget](extension/guard.js),
[guard.js › onSubmit](extension/guard.js)). It never cancels at
capture: like links, submits are decided in the late check, so a handler
that switches the target back to `_self` still works. The submitter comes from
the saved `SubmitEvent.prototype.submitter` getter, in `try/catch` so a
plain `new Event('submit')` cannot make it throw. `isSubmit` matches
`input[type=submit]`, `input[type=image]` and
`button:not([type=button]):not([type=reset]):not([type=menu])`, so buttons
with a missing or invalid `type`, which default to submit, are included. The
form comes from the native `form` getter of `HTMLButtonElement` or
`HTMLInputElement`, which honours the `form=` attribute
([guard.js › buttonForm](extension/guard.js),
[guard.js › formOf](extension/guard.js)).

##### Submit-button clicks

Ctrl, Shift or middle clicks on a submit button open the result in a new
tab. If no link is in the path, `onActivate` looks for a submit button and
cancels those at once: a modifier or middle click opens a new context
whatever the target later says. A plain click is never cancelled: the click
itself opens nothing, and `onSubmit` decides late whether the submit still
opens a new context, so validation and the page's handlers still run.

##### Shadow DOM: listen inside every `attachShadow` root

**Problem.** A window listener cannot see a link inside a closed shadow
root, because `composedPath` hides closed-tree nodes. Non-composed clicks and
all `submit` events never leave a shadow root.

**What it does.** `Element.prototype.attachShadow` is wrapped. After the
native call it adds capture `click`, `auxclick` and `submit` listeners to
the returned root, closed roots included, and records the root in
`listenedRoots` ([guard.js › install](extension/guard.js), the `attachShadow` wrapper).
`unheard(node)` is true when the node's root is neither its document nor a
listened root, for example a detached node or a declarative shadow root
built by the parser ([guard.js › unheard](extension/guard.js)).

**Why not the obvious way.** Declarative roots (`<template shadowrootmode>`)
never call `attachShadow`, so they stay unheard. The `click()`,
`dispatchEvent` and `requestSubmit` paths cover them, and a submit-button
click or `requestSubmit` ensures a submit listener inside the root on the
spot. A real non-composed click on a link inside a closed declarative root
stays invisible in the page and falls to the background layer.

##### `.click()` and `dispatchEvent` on links no listener can see

**Problem.** A detached link (`createElement('a')`, `target=_blank`,
`.click()`) or one in a closed declarative shadow root fires a click that
never reaches the guard's listeners, but the browser still follows it.

**What it does.** `HTMLElement.prototype.click` and
`EventTarget.prototype.dispatchEvent` are wrapped. They act only when the
element is not connected or its root is unheard. Then they find the closest
link, let downloads through (unless a modifier is set), and block if the
target opens a new context ([guard.js › hiddenLinkOpensNew](extension/guard.js)).
For dispatched `click` or `auxclick` events, Ctrl, Meta, Shift or
`button === 1` also count, and a block returns `false`, as for a cancelled
event. Connected elements in heard trees go to the native call, so the
listeners stay the single source of truth.

##### `form.submit()` and `requestSubmit()`

`form.submit()` fires no submit event, so its wrapper checks the form's
target directly, in every realm ([guard.js › install](extension/guard.js), the `submit` wrapper).
`requestSubmit()` runs validation and a real submit event that the page's
handlers rely on, so its wrapper never blocks: it first makes sure the submit is heard
(adding a listener inside a shadow root the browser built, which the parser
never sent through `attachShadow`), then runs the native call, and
`onSubmit` cancels the navigation late if it still opens a new context
([guard.js › ensureSubmitHeard](extension/guard.js)). A submit-button click
takes the same road: it only ensures the submit is heard and leaves the
click alone.
Test: "requestSubmit runs the site's submit handler" (exactly once, and no
tab).

##### Link targets, SVG links and `<area>`

`linkTarget` is `target`, else the first `<base target>` in the document
([guard.js › linkTarget](extension/guard.js)). It uses `??`, so a
present but empty `target=""` stays `_self` and does not fall through to
`<base>`. `isLink` matches `a[href], area[href]`, or an `<a>` with
`xlink:href` ([guard.js › isLink](extension/guard.js));
`xlink:href` is namespaced and `[href]` does not match it.

#### Target-name rules

##### Names matched the way the browser matches them

**Problem.** Naive checks such as `trim().toLowerCase() === "_self"`
disagree with the browser. `" _self"` is a new window named `" _self"`, and
`"   "` is a new window too.

**What it does.** `opensNew` does not trim. `""` means no new context (for
links, empty is `_self`). Case-insensitive `_self`, `_parent` and `_top` do
not open anything. Any other name starting with `_` (`_blank`, `_new`, …)
does. Any other name opens a new window unless `frameNamed` finds a frame
the caller can navigate ([guard.js › opensNew](extension/guard.js)).
For `window.open`, a missing or empty name means `_blank`
([guard.js › openTarget](extension/guard.js)). `toLower` is the saved
`String.prototype.toLowerCase`.

**Why not the obvious way.** Trimming makes `" _self"` look like a same-tab
open when the browser opens a new window. Tests: "open(url, ' _self')",
"open(url, '   ')", "window.open('')".

##### `frameNamed`: only frames the caller may navigate

**Problem.** `open(url, "name")` stays in the tab only if a frame with that
name exists and the caller may navigate it. Otherwise the browser opens a
new window with that name.

**What it does.** A depth-first walk starts at the top window, or at the
caller itself if it is sandboxed (a sandboxed frame can only navigate itself
and its descendants). It reads names with the native getter. Cross-origin
frames are walked through, because `length` and indexing work across
origins, but their names throw and do not count. The walk stops after 500
windows. When no readable window matches, it matches `name` attributes on
`<iframe>` and `<frame>` elements in the same documents it could read: a
frame showing another site has no readable `window.name`, but Chrome still
navigates it instead of opening a tab
([guard.js › frameNamed](extension/guard.js)). `isSandboxed`
treats origin `"null"` or a `sandbox` attribute on the frame element as
sandboxed.

**Why not the obvious way.** Matching any frame anywhere would let a
sandboxed frame "open into" a sibling. The browser refuses that and opens a
new tab. Counting cross-origin frames is unsafe too. Tests: "sandboxed frame
opens into a sibling", "window.open into named iframe works", "sibling
frame's window.open into it", "named iframe showing another site".

##### Fail closed on doubt

When the guard cannot tell where a named target leads, it treats it as a
new window. If the caller's window can't be read, a name counts as new
([guard.js › opensNew](extension/guard.js),
[guard.js › guarded](extension/guard.js)). If its top window can't
be read, no frame matches ([guard.js › frameNamed](extension/guard.js)). A frame
whose name throws (another origin) never matches
([guard.js › frameNamed](extension/guard.js)). The worst case is a same-tab
open being refused, never a new tab getting through.

##### Dangling-markup targets

A link or form target that contains a tab, CR or LF together with `<` is
treated by browsers as `_blank` (a dangling-markup defence). `cleanTarget`
does the same ([guard.js › cleanTarget](extension/guard.js)).

#### Removal on unlisted sites

##### `uninstallAll` undoes everything in reverse

**Problem.** The guard is injected into every site. On unlisted sites it
should disappear: no wrappers, no listeners, no marker, nothing
`chrome-extension:` in stack traces.

**What it does.** Each install keeps an undo list. `patch()` adds a restore
step for each property it replaces, `listen()` adds a
`removeEventListener`, and the observer adds `disconnect()`.
`uninstallAll()` runs each realm's list from last to first, each step in its
own `try/catch`, then forgets the realm
([guard.js › uninstallAll](extension/guard.js),
[guard.js › patch](extension/guard.js)).

Exception: shadow roots the page attached before the guard was removed keep
the guard's capture `click`, `auxclick` and `submit` listeners. The
`attachShadow` wrapper adds them directly, not through `listen()`
([guard.js › install](extension/guard.js), the `attachShadow` wrapper), so they are not on the
undo list. They do nothing while the guard is not armed (`onActivate` and
`onSubmit` return at once, [guard.js › onActivate](extension/guard.js),
[guard.js › onSubmit](extension/guard.js)) and work again if the site is added
later.

**Why not the obvious way.** A guard that is merely disabled and left in
place still changes identity, descriptors and stack traces, which sites and
anti-bot scripts notice. The test checks the page and its same-origin
frames, including one created during load: a sample of the patched methods
and accessors (`appendChild`, `append`, `insertAdjacentHTML`, `write`,
`open`, `click`, `dispatchEvent`, `attachShadow`, `submit`,
`requestSubmit`, the `innerHTML` setter and the `contentWindow` getter) is
native again, `window.open` is a data property and the marker is gone
([run.mjs › unlistedIsUntouched](test/run.mjs)).

##### Undo restores only if the slot is still the guard's

`patch()` saves the previous descriptor. Its undo step restores it only if
the current `value`, `get` and `set` are all the ones the guard installed,
and deletes the property if there was none before
([guard.js › patch](extension/guard.js)). A page that assigned its
own `window.open` during load keeps it after removal. That follows from the
check at [guard.js › patch](extension/guard.js) but is not tested: the test
"assigned window.open is the same object" assigns only after removal.

##### `state.removed` stops saved wrappers from reinstalling the guard

After removal, the page may still hold wrappers it saved during load, such
as `Node.prototype.appendChild`. Calling one sweeps frames, which would call
`install()` again. `uninstallAll()` sets `state.removed` first, and
`install()` returns at once while it is set. Only `arm()` clears it
([guard.js › state](extension/guard.js),
[guard.js › uninstallAll](extension/guard.js),
[guard.js › install](extension/guard.js)). Test: "a saved wrapper doesn't
bring it back".

The control listeners are never put on the undo list, so a page that was
found unlisted can still be armed later when its site is added.

### Popup and options page

- **One button that flips the current site.** `siteToggle` works out what
  lists the host: the rule naming this site (offer to remove it), a broader
  rule such as a parent domain or `*` (offer the exception `!site`, and
  show "via …"), or exceptions that keep it unlisted (offer to remove
  them); otherwise it offers to add the site
  ([lib.js › siteToggle](extension/lib.js)). Removing `example.com` from
  `app.example.com` would unlist every sibling too, so a broader rule is
  never removed from a subdomain's popup.
- **Reload after a change,** because arming is one-way and a removal needs
  a fresh document ([popup.js › render](extension/popup.js)). A save that
  fails (the quota) shows "Not saved: …" and leaves the tab alone.
- **Non-web pages get no button.** `new URL("chrome://newtab").hostname` is
  `newtab`, which would add junk; only `httpUrl` addresses get one.
- **Text only.** The status line and the error list are built with
  `textContent` and `replaceChildren`, never `innerHTML`: rules and lines
  are user input.
- **Lenient input, strict storage.** The options page splits on newlines
  and commas, normalises each line, drops junk, de-duplicates and sorts,
  then shows back what was actually saved and lists the lines it dropped
  ([lib.js › rejectedLines](extension/lib.js),
  [options.js › save](extension/options.js)). When the save is refused
  (the quota), the textarea keeps what you typed.
- **"Current domain" is the most recently used other web tab,** because the
  options page is itself the active tab. The button decides with the
  popup's `siteToggle` from the textarea's lines at the moment of the
  click, so unsaved edits are kept, and it is hidden when the list already
  blocks that site ([options.js › offerCurrent](extension/options.js)).

### Testing techniques

#### A raw CDP driver wherever the extension closes tabs

Playwright attaches to every new target and pauses it until attached. When
the background closes that tab first, the opener page, which shares the
renderer process, can freeze mid-click. [cdp.mjs](test/cdp.mjs) talks to the
DevTools WebSocket directly, auto-attaches only to iframes, and records page
targets with created and destroyed times
([cdp.mjs › launchRaw](test/cdp.mjs), [cdp.mjs › pagesSince](test/cdp.mjs)).
Playwright drives the full extension, where no tab is ever created. The raw
driver covers the background-only layer, tab-under, cold worker, context
menu and popup chain runs.

#### Chrome on port 0

Chrome launches with `--remote-debugging-port=0` and a fresh profile. The
driver reads the chosen port from `<profile>/DevToolsActivePort`
([cdp.mjs › launchRaw](test/cdp.mjs)). Port 0 cannot collide with another
browser or a parallel run.

#### Timeouts everywhere

Every CDP call races a 10 s timer, and each case runs under 15 s. In
Playwright mode a stuck case closes all pages and continues
([cdp.mjs › within](test/cdp.mjs),
[run.mjs › openCase](test/run.mjs), [run.mjs › rawCase](test/run.mjs)). Tests of tab-killing code are
the ones most likely to hang.

#### Real, trusted input

`clickAt` sends `Input.dispatchMouseEvent` move, press and release with a
modifier bitmask and button masks. `click()` scrolls the element to the
centre and waits before measuring it
([cdp.mjs › clickAt](test/cdp.mjs)). Synthetic DOM events are
untrusted and grant no user activation, so they would not exercise the
popup blocker or `arm.js`'s `isTrusted` checks on context-menu, `pointerdown`
and `keydown` events ([arm.js › onContextMenu](extension/arm.js),
[arm.js › onPointerDown](extension/arm.js), [arm.js › onKeyDown](extension/arm.js)). `clickIn` adds the frame's
border (`clientLeft`, `clientTop`) when clicking inside an iframe
([cdp.mjs › clickIn](test/cdp.mjs)).

#### Running code in cross-origin frames with a user gesture

The driver tracks execution contexts per out-of-process iframe session and
evaluates in the right frame with `userGesture: true`
([cdp.mjs › frameEval](test/cdp.mjs)). Without the gesture, the popup
blocker would stop `window.open` and the test would pass even without the
extension.

#### Finding the right service worker, and stopping it

Chrome's built-in extensions can also have a `background.js` worker.
`swTarget` asks each one for its manifest name and keeps "No New Tabs"
([cdp.mjs › swTarget](test/cdp.mjs)). `stopSW` closes the worker target
to simulate Chrome's 30 s idle stop, and `wakeSW` opens and closes a
background tab to restart it ([cdp.mjs › stopSW](test/cdp.mjs), [cdp.mjs › wakeSW](test/cdp.mjs)).
Waiting 30 s per case is impractical, and a worker that is always warm hides
bugs in saving and restoring state.

#### `*.test` hosts for plain-http sites

`localhost` is a secure context even over http, so APIs missing on real
plain-http sites are present there. The Playwright browser launches with
`--host-resolver-rules=MAP *.test 127.0.0.1`
([run.mjs › HOSTS](test/run.mjs),
[run.mjs › launch](test/run.mjs)); the raw-CDP browser does not need it.
`insecureSite()` checks `listed.test` and `plain.test` with
`!isSecureContext` ([run.mjs › insecureSite](test/run.mjs)). No DNS or hosts-file changes
are needed.

#### One server, two origins

The same server is reached as `http://localhost:PORT` (listed) and
`http://127.0.0.1:PORT` (unlisted). Pages frame "the other host", so the
control run also tests a listed frame inside an unlisted page: cases named
"cross-origin …" must be blocked in both runs
([run.mjs › LISTED](test/run.mjs), [run.mjs › UNLISTED](test/run.mjs),
[run.mjs › openCase](test/run.mjs)).

#### The "no flash" standard

In full-extension mode a case passes only if no tab was created at all,
not just closed, and the page is still on its starting URL (unless the case
leaves on purpose) ([run.mjs › openCase](test/run.mjs)). Checking
only survivors would pass even if every case relied on the background.

#### Background-only mode

`backgroundOnlyCopy()` copies the extension and deletes `content_scripts`
from the manifest, then the whole case table runs through the raw driver,
plus user tabs, tab-under, cold worker, listed frame in an unlisted page and
the popup chain ([run.mjs › backgroundOnlyCopy](test/run.mjs),
[run.mjs › STEPS](test/run.mjs)).

#### Popup blocker off where it would hide the result

`liveArmNoInput` and `popupChain` run with `--disable-popup-blocking`
([run.mjs › ensureSetup](test/run.mjs)). Otherwise a pass would only
reflect Chrome's own blocker.

#### Stable coordinates

The loaders wait for both cross-origin frames, for `document.fonts.ready`
(text reflows when fonts arrive), and 150 ms for `arm.js` to read the list
([run.mjs › loadStart](test/run.mjs),
[run.mjs › rawLoad](test/run.mjs)). A click that lands on nothing
makes a blocking test pass for the wrong reason.

### Ad-script tricks seen in the wild and how each is defeated

Most of these come from ad scripts (PopAds, Adcash and others) seen on a
real streaming site. The rest are edge cases found while hardening the
guard. Each has a test case with the name shown, unless the Test column
says otherwise.

| Trick | How it is defeated | Test |
| --- | --- | --- |
| Plain `window.open(url)`, `window.open('')`, popup features | Guarded `open` returns `null`; empty name means `_blank` ([guard.js › guarded](extension/guard.js), [guard.js › openTarget](extension/guard.js)) | "window.open()", "window.open('')", "popup window" |
| Save `window.open` at load, call later | Guard is installed before any page script, so the saved copy is the wrapper ([guard.js › nativeOpen](extension/guard.js)) | "window.open saved at load" |
| `document.open(url, name, features)` | Three-argument calls are checked like `window.open` ([guard.js › install](extension/guard.js), the `Document.prototype.open` wrapper) | "document.open(3 args)" |
| Hidden `<iframe src="javascript:false">`, then `frame.contentWindow.open` | `contentWindow` getter and insertion wrappers adopt the frame first ([guard.js › framesAfter](extension/guard.js), [guard.js › install](extension/guard.js), the `contentWindow` getter) | "jsf iframe contentWindow.open" |
| PopAds minipop: `frames[n].open('about:blank', realUrlAsName, 'popup=1,width=5,height=5')`, then a script in the popup redirects to `name` | Input-time sweep adopts frames reached by index; the MutationObserver adopts parser-made frames; escaped popups are closed and marked `spawned` ([guard.js › observer](extension/guard.js), [guard.js › onInput](extension/guard.js)) | "PopAds minipop (popup, about:blank)" |
| PopAds: keep the iframe's `contentWindow` from load time | `insertBefore`/`append` adopt before the reference can be saved ([guard.js › framesAfter](extension/guard.js)) | "PopAds saved contentWindow" |
| Adcash: `frame.open.bind(frame)` | The function bound is already the guarded wrapper | "Adcash bound iframe open" |
| Call the frame's `open` on the main window: `savedOpen.call(window, url)` | Wrapper judges from `this ?? win` and checks `state.armed` at call time ([guard.js › guarded](extension/guard.js)) | "iframe open saved, .call(window)" |
| `window.open = iframe.contentWindow.open` | Locked accessor returns `guarded(value)` for any native ([guard.js › rec.lock](extension/guard.js)) | "window.open = iframe's open" |
| Before input, make a hidden frame's native `open` the page's `window.open` | Parser-inserted frames are adopted before the next script; accessor guards natives | "window.open = frame's native, at load" |
| Plant a fake `__noNewTabsGuard` marker on a frame so the guard skips it | Adoption runs first: the MutationObserver adopts parser-inserted frames before the next script ([guard.js › observer](extension/guard.js)), so the guard's own marker is already in place and a marker planted later changes nothing ([guard.js › install](extension/guard.js)) | "frame pre-marked as guarded" |
| `frames[name].open` on a frame made with `document.write` | `write` wrappers sweep afterwards; observer catches parser insertion ([guard.js › install](extension/guard.js), the `write` wrapper) | "frames[name].open, document.write" |
| `javascript:false` frame inside a closed shadow root (out of reach of `frames[n]`) | The `contentWindow` getter adopts the frame when the page reads it ([guard.js › install](extension/guard.js), the `contentWindow` getter) | "shadow-root jsf iframe" |
| `javascript:false` frame inside another one | `sweep()` recurses; each adopted realm wraps its own insertion methods | "nested jsf iframe" |
| Save a frame's `open` while the page is still parsing | MutationObserver runs before the next parser-inserted script | "open saved from a frame, while parsing" |
| Save a `src` frame's `open` from its initial `about:blank`, which Chrome reuses for the real document | Frame adopted on insert; its own guard backs off on the marker | "open saved before the frame loaded" |
| Detached `<a target=_blank>` plus `.click()` or `dispatchEvent` | `click`/`dispatchEvent` wrappers check unseen links ([guard.js › hiddenLinkOpensNew](extension/guard.js)) | "detached link .click()", "detached link dispatchEvent" |
| `frames.x.HTMLFormElement.prototype.submit.call(mainForm)` | Every adopted realm's `submit` is wrapped ([guard.js › install](extension/guard.js), the `submit` wrapper) | "form.submit from iframe realm" |
| `open('about:blank', '_self')` to blank the page | `inertUrl` blocks `about:` and `javascript:` in any target ([guard.js › inertUrl](extension/guard.js)) | "open('about:blank', '_self') blocked" |
| Tab-under: open, then move the listed tab away (`location`, `history.back()`, six redirects) or `window.close()` it | Background judges the opener at the moment of creation from recorded history; closed tabs remembered 30 s | "hidden-frame open, then leave", "… 6 redirects", "… history.back()", "… window.close()" |
| Listed iframe opens, then navigates away or is removed | Recorded parents and `left` times; walk the tree as it was ([background.js › frameWasListed](extension/background.js)) | "listed iframe: open, then the frame leaves / is removed" |
| Popup that opens another popup from its load script | `spawned` set and pending verdicts ([background.js › wasListed](extension/background.js)); with the full extension, `arm.js` in the popup is also told "listed" (untested) | "both windows closed" |
| Ask whether `window.open` is wrapped (`toString`, `name`, `length`) | Per-realm `toString` spoof; shorthand wrappers with copied `name`/`length` ([guard.js › nativeToString](extension/guard.js)) | "Function.prototype.toString looks native" |
| Replace `Set.prototype.has`, `Function.prototype.apply`, `composedPath`, iterators | Built-ins saved at startup, called through `Reflect.apply`, index loops only | (relied on throughout) |
| Retry `window.open` many times a second | Logging stops after 20 lines | (none) |
| `open(url, ' _self')`, `open(url, '   ')` | Untrimmed, browser-style name matching | "open(url, ' _self')", "open(url, '   ')" |
| Redefine `window.name` with a getter, then open "into" it | Native `name` getter ([guard.js › frameNamed](extension/guard.js)) | "fake window.name, then open into it" |
| Sandboxed frame targets a sibling by name | Sandboxed callers search only their own subtree | "sandboxed frame opens into a sibling" |
| Page handler sets `target=_blank` or `<base target=_blank>` after the guard looked | `later()` looks again after the page's handlers | `target set by a page click handler`, `<base target> set by a click handler`, `form target set by a submit handler` |
| Links and forms in closed or declarative shadow roots, non-composed clicks | Listeners inside each `attachShadow` root; `unheard()` paths for declarative roots | "closed shadow root _blank link", "_blank form, declarative shadow root", ".click() in closed declarative shadow" |
| `document.open()` the whole page, then a `_blank` link | Listeners re-added after `open`/`write` | "_blank after document.open() of page" |
| Turn the page into a `blob:` copy, or a `blob:null` page via a sandboxed frame | `arm.js` checks `self.origin` (blob: copy) or asks the background for an opaque page (blob:null); the background inherits the previous site ([arm.js › check](extension/arm.js), [background.js › USER_TRANSITIONS](extension/background.js)) | "page turns itself into a blob: copy", "page becomes a blob:null page" |
| `_blank` links in a `data:` frame | Injected via `match_origin_as_fallback`; `ancestorOrigins` | "_blank link in a data: frame" |
| Use a no-script sandboxed frame's `open` or `form.submit` | Parent adopts it when readable; opaque frames get `allow-popups` stripped instead | "no-script sandbox frame's window.open", "… form.submit" |
| Fake the guard's `unlisted` or `arm` signals | Secret handshake; arm-only | "page fakes the 'unlisted' signal", "page faked 'unlisted' during load", "page fakes 'arm', then opens" |
| Document picture-in-picture window | `requestWindow` rejected with `NotAllowedError` | "listed: refused" |
| Argument whose `toString` changes between reads | `readArgs` converts once | (none) |

## Known gaps

These are known and either left alone on purpose, handled only by the
background layer (which means a tab may open and close quickly), or not
handled. Items marked "from reading the code" are not covered by tests.

### By design

- **Right-click, Open link in new tab / new window** on a listed site is
  closed, like any other way the site's links open a tab. That includes a
  link inside a closed shadow root. A tab chosen from the menu more than 30
  seconds after the right-click is closed too.
- **Right-click, Open image in new tab** on an image with a `data:`
  address is closed: the menu record skips `data:` addresses (a photo
  inlined as base64 would blow the session-storage quota on its own), so
  the tab is judged by its opener instead of matched to the menu.
- **On a listed site, `window.open` can't be redefined with
  `Object.defineProperty` once the page is guarded** (plain assignment
  works). A script that tries gets an error.
- **Opening into an existing named window** (not a frame), or into a named
  frame of another site, is blocked on a listed site. The guard can't see
  other windows, and the browser may open a new window instead of
  navigating another site's frame.
- **Frames sandboxed without `allow-scripts`** log a "Blocked script
  execution" console error on every site. That error comes from Chrome
  refusing to inject the extension's script there, and it is harmless. (The
  guard still protects such frames from the page around them.)
- **On unlisted pages, a copy of a guard function** that a page script saved
  in the first few milliseconds (before the extension knew the page is
  unlisted) stays in that copy. It passes everything straight through.
- **Ads drawn inside the page** (fake notifications, overlays) stay visible.
  The extension only stops them from opening tabs or windows; it isn't an
  ad blocker.

### Handled only by the background layer (a tab may flash)

In these cases the in-page guard misses the open, and the background closes
the new tab a moment later.

- **Opaque script-less frames before their second load.** Stripping
  `allow-popups` takes effect only for the document the guard's
  re-navigation loads, so a click in the frame's first document before
  that load can still open a tab. A parser-inserted frame always commits
  its first document before any script can strip it, so its end-to-end
  check ("parser-inserted opaque sandbox _blank click") asserts what is
  guaranteed, the stripped attribute and no surviving tab, and reports
  how many tabs flashed. The background closes the tab.
- **Shadow-root markup.** An opaque `allow-popups` iframe written with
  `shadowRoot.innerHTML` is not stripped: the markup pass queries the
  document, which does not reach into shadow roots (a gap that predates
  the sandbox fixes). The background closes the tab.
- **Brief flashes** are still possible when the page:
  - exhausts the stack just before the guard's saved calls. The guard's
    listeners fail closed when they run at all, but under exhaustion the
    browser may not run them in the first place, so the tab can still
    open. The suite covers this with a test that asserts the background
    closes the tab;
  - uses the short gap before a same-origin frame is adopted at load;
  - or has a listed iframe on an unlisted page after a back/forward round
    trip.
- **Page code that runs inside a DOM insertion** (a custom element's
  `connectedCallback`, an inserted `<script>`) can still reach a new frame's
  `window.open` before the guard does, for example a `<script>` inserted
  in the same call as a `javascript:false` iframe (from reading the code).
- **Another extension's in-page UI frames.** Password managers and grammar
  checkers inject `chrome-extension://` iframes where the guard can't run.
  On a listed page, a tab opened from such a frame with a real click is
  closed about 60 ms later: the tab arrives with no address and no
  navigation source, so it is judged by the listing top page. Recording
  those frames would not help without knowing which one was clicked, which
  the background cannot see.
- **Closed shadow roots written straight into HTML**
  (`<template shadowrootmode="closed">`): a click on a `_blank` link inside
  one gets past the in-page guard.
- **A target changed late plus stopped propagation** (from reading the
  code). Plain clicks and submits are decided in the late check, which also
  listens inside shadow roots, so a handler that only changes the target is
  covered. A handler that changes the target and also stops propagation
  beats both checks: the late check never runs. Modifier and middle clicks
  are still cancelled up front, so they are not affected.
- **A page capture listener could stop the arm signal** (from reading the
  code). The guard's control listeners are not capture listeners
  ([guard.js › listenControl](extension/guard.js)), so a page listener on
  `window` for `__no_new_tabs_arm__` that calls `stopImmediatePropagation()`
  could keep the guard from arming.
- **Live arming of a page that was first found unlisted** (from reading the
  code). Natives the page saved while the guard was removed stay unguarded,
  and the reinstall reads globals the page may have replaced
  ([guard.js › install](extension/guard.js)). Reloading the tab
  after adding a site avoids this.
- **Sandboxed frames the guard can't recognise as sandboxed** (from reading
  the code). `isSandboxed` checks only the frame's own origin and its own
  `sandbox` attribute ([guard.js › isSandboxed](extension/guard.js)). A
  frame sandboxed with `allow-same-origin` inside a cross-origin parent
  (where `frameElement` is null), or a frame nested inside such a sandbox,
  can name a sibling frame in `open()` and get past the in-page guard. The
  browser then opens a new window, which the background closes.

### Caught only by the in-page guard

No cases are currently known that only the guard catches. Tabs that already
have an address (`javascript:false` frames, back/forward-cache restores)
and popups with no navigation source from restored pages are now judged by
the background layer too, closing with a brief flash when the guard misses
them.

### Not handled

- **In Brave, Open link in container and dragging a link onto the tab
  strip** get through on a listed site.
- **Open link in private window** gets through on a listed site: the
  extension is off in private windows unless it is allowed there, so the
  new tab is never seen. Turn on **Allow in Private** (Brave) or **Allow
  in Incognito** (Chrome) on the extension's Details page for coverage
  there too.
- **Context-menu items that are still closed on a listed site,** even
  though you chose them:
  - (Brave only) "Search for …" on text selected inside a PDF. Brave records
    the PDF viewer's frames like normal frames, so the PDF rule
    ([background.js › fromUserMenu](extension/background.js)) never
    fires.
- **Rules from a newer version on an older one.** An older copy of this
  extension on another synced device never matches `*`, `=` or `!` rules,
  and if it saves the list, it drops them from sync for every device.
- **Test coverage.** Menu-chosen tabs are kept and the fakes are refused
  ("menu search/image tab is kept", "second tab from one menu is closed",
  "synthetic contextmenu is not recorded"). The history pruning (the 60 s
  `left` expiry, dead-frame pruning, the 1000-entry cap) is covered by
  unit tests through the fake `chrome` API, not by the browser suite.
