# No New Tabs

A Brave/Chrome extension (Manifest V3). Sites on your list cannot open new
tabs or windows, by any method. Everything else on those sites, including
their JavaScript, keeps working.

A blocked link or `window.open` simply does nothing: the page stays where it
is, and the target is not opened in the current tab instead. `window.open`
returns `null`, as it does when the browser's popup blocker stops it.

This README has two halves. The first half says what the extension does and
how to install, use and test it. The second half,
[How it works: every trick](#how-it-works-every-trick), explains each
technique the code uses, what attack or problem it answers, and why the
obvious approach does not work. Links such as
[background.js:237-241](extension/background.js#L237-L241) point at the
lines that do the work in the code as it is now. If you change the code,
update the line numbers (or use GitHub permalinks).

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
     quiet. Only host names are kept, not addresses.
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
     frames sandboxed without scripts.
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
   ([guard.js:383-389](extension/guard.js#L383-L389),
   [guard.js:424-429](extension/guard.js#L424-L429)).

   Until a page is known to be listed, `window.open` stays a plain
   property, so test tools and scripts that save and restore it work as
   usual. A function the site itself assigns to `window.open` (an analytics
   hook) is handed back unchanged; what it calls is still guarded.
   `requestSubmit()` on a `_blank` form still runs the site's validation and
   submit handlers; only the navigation is cancelled.

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
([manifest.json:18-42](extension/manifest.json#L18-L42)). The manifest sets
no `minimum_chrome_version`, so an older browser may load it without the
in-page guard working. Optional APIs (`documentPictureInPicture`,
`setHTMLUnsafe`) are wrapped only if the browser has them
([guard.js:336-339](extension/guard.js#L336-L339)).

## Use it

- **Quickest:** go to the site, click the extension icon, then click
  **+ Add current domain**. The tab reloads and the icon shows a red
  **ON** badge on that site. On a listed site the same button reads
  **Remove … from list**.
- **List editor:** right-click the icon and choose **Options**. Use the
  **+ Add current domain** button to add the tab you were just on, or enter
  one domain per line and click **Save**. `example.com` also covers
  `www.example.com` and `app.example.com`. Adding a site takes effect at
  once, even in tabs that are already open. Removing one takes effect after
  the tab reloads.
- Entering `www.example.com` lists `example.com`, so it covers every
  subdomain too ([lib.js:15](extension/lib.js#L15)). IP addresses work
  (`127.0.0.1`, `[::1]`).
- The list is stored as one `chrome.storage.sync` item
  ([lib.js:53-57](extension/lib.js#L53-L57)), so with browser sync on it
  follows you to other browsers signed in to the same profile. It is limited
  by Chrome's sync quota per item (8 KB, a few hundred domains); a larger
  list fails to save, and the options page then shows no "Saved" message.

To check it's working, open DevTools on the site (F12, then Console). Each
blocked attempt is logged as `[no-new-tabs] blocked …`. The background
worker logs `[no-new-tabs] closed tab …` in its own console (open it from
the extension's card).

## Tests

```bash
cd test
npm install
npx playwright-core install chromium   # one-time browser download
node run.mjs
```

This starts a local test site and loads the extension into Chromium. It
uses Playwright's cached Chromium build, or the browser you name with
`CHROME=/path/to/chrome`. Auto-detection of Playwright's Chromium only
works on Linux: it looks for `chrome-linux64/chrome`
([run.mjs:34-41](test/run.mjs#L34-L41)). On macOS or Windows, set `CHROME=`
to a Chromium binary. Recent branded Chrome builds ignore
`--load-extension`, so use Chromium. The test site listens on port 8799;
set `PORT=` if that is taken.

```bash
# from test/
CHROME=/usr/bin/chromium PORT=9000 node run.mjs
```

Matching logic that a headless browser cannot drive (Brave's native
"Go to <address>" item) is covered by unit vectors through the shipped
code instead ([unit.mjs](test/unit.mjs)):

```bash
# from test/
node --test unit.mjs
```

The suite lists `localhost`, uses `127.0.0.1` as the unlisted control, and
runs 308 checks (the run prints PASS or FAIL for each and ends with ALL
PASSED):

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
  ([run.mjs:635-644](test/run.mjs#L635-L644),
  [run.mjs:655-662](test/run.mjs#L655-L662)).
- **Plain-http sites** (not secure contexts), picture-in-picture windows,
  and context menus: a right-click must not open the door for a link click
  that gets past the guard.
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
  lib.js          Shared helpers: domain normalisation, host matching, siteOf()
  popup.html/js   Toolbar popup: add or remove the current site
  options.html/js Domain list editor
  icons/          Toolbar and store icons (16, 32, 48, 128 px)
test/
  run.mjs         End-to-end suite (Playwright for the full extension, raw CDP elsewhere)
  cdp.mjs         Minimal raw Chrome DevTools Protocol driver
  package.json    One dev dependency: playwright-core
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
    target.html     Landing page for every case
    data.json       Used by the fetch() check
```

## How it works: every trick

Each trick below follows the same pattern: the problem or attack, what the
code does about it, and why the obvious approach fails.

### Terms used below

- **Listed**: on a domain in your list, or a subdomain of one.
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
([run.mjs:46-55](test/run.mjs#L46-L55)). The in-page layer exists so you
don't see a tab open and close.

#### Two scripts in two worlds, both at `document_start` in every frame

**Problem.** The guard must patch the page's own built-ins such as
`window.open`. Only a script in the page's MAIN world can do that. But
MAIN-world scripts get no `chrome.storage` or `chrome.runtime`, so they
cannot read the domain list. And anything in the page's world can be
watched or tampered with by page scripts.

**What it does.** The manifest declares `guard.js` with `world: "MAIN"` and
`arm.js` in the default isolated world
([manifest.json:18-42](extension/manifest.json#L18-L42)). Both use
`run_at: document_start`, `all_frames: true`,
`match_origin_as_fallback: true` and `<all_urls>`. `guard.js` is listed
first, so its listeners exist before `arm.js` sends anything. `guard.js` does
all the patching and stays inert until armed. `arm.js` reads the list,
decides, and sends the answer to `guard.js` through DOM events. The second
content script has no `world` key, so `arm.js` runs in the isolated world
([manifest.json:31-41](extension/manifest.json#L31-L41)). It has its own
copies of the JS built-ins, and page code cannot change what it reads or
calls.

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
`onCreatedNavigationTarget`, `getAllFrames`) and `storage` (`sync` for the
list, `session` for state), with `<all_urls>` host permissions
([manifest.json:6-17](extension/manifest.json#L6-L17)). The worker is a
module (`"type": "module"`) so it can import [lib.js](extension/lib.js).

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
([background.js:237-241](extension/background.js#L237-L241)). A tab created
by page script arrives at `tabs.onCreated` with no address at all. Tabs the
browser creates for the user always carry one. Only page-made tabs go down
the `onCreated` decision path
([background.js:316-322](extension/background.js#L316-L322)).

**Why not the obvious way.** `openerTabId` looks like the natural signal,
but Chrome sets it for Ctrl+T from a tab too. Keying on it would close the
user's own new tabs. The tests reproduce those shapes (`createTarget`
newtab and about:blank, duplicate, `tabs.create` with an opener,
`windows.create`) and require them all to survive
([run.mjs:456-488](test/run.mjs#L456-L488)).

##### Browser-made tabs from the page's links are judged too

**Problem.** Ctrl-click, shift-click, middle-click, "Open link in new tab"
and dragging a link all create tabs that do have a `pendingUrl`, so
`pageCreated()` lets them pass `tabs.onCreated`.

**What it does.** `webNavigation.onCreatedNavigationTarget` fires for these
tabs as well, and always starts a decision when no waiter exists
([background.js:337-351](extension/background.js#L337-L351)). They are
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
([background.js:323](extension/background.js#L323)). It resolves with the
navigation details if they arrive within `NAV_WAIT_MS = 50`, or with
`null` on timeout ([background.js:252-262](extension/background.js#L252-L262)).
If the navigation event came first, it was stored in `navEarly` (kept 5 s)
and the wait resolves at once. With details, `decideFromNav` judges the
exact source frame. With `null`, the opener tab's top frame is judged,
because the browser does not say which frame opened it
([background.js:324-334](extension/background.js#L324-L334)).

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
exact frame ([background.js:339-351](extension/background.js#L339-L351)).
`tabs.onCreated` returns early if a decision already exists, which means the
navigation event came first ([background.js:322](extension/background.js#L322)).

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
([background.js:316-321](extension/background.js#L316-L321)). The late
navigation handler reuses that `atSeq`
([background.js:345](extension/background.js#L345)).

**Why not the obvious way.** `atSeq` is taken synchronously at creation,
before any `await`. A navigation the opener commits afterwards cannot change
how the tab is judged. The 10 s expiry keeps the map small.

##### `decisions` and `track()`: verdicts still in flight

**Problem.** Several decisions can be in flight for related tabs, for
example a popup that opens another popup before its own verdict is known.

**What it does.** `track(tabId, decision)` stores the promise and removes it
once it settles, but only if it is still the stored one, so a newer chained
decision is not wiped. `decision.catch(() => false)` keeps a rejection from
becoming unhandled ([background.js:171-179](extension/background.js#L171-L179)).
`wasListed()` waits for a source tab's pending verdict and treats `true` as
listed ([background.js:218-226](extension/background.js#L218-L226)).

**Why not the obvious way.** A popup's child can be created before the popup
itself is closed. Waiting for the parent's verdict is what makes popup
chains close in full.

##### The `spawned` set: whatever a closed tab opens is closed too

**Problem.** A popup that slips out, even briefly, can open more windows
from its own load-time script.

**What it does.** `block()` adds the tab to `spawned` and schedules a save,
then calls `chrome.tabs.remove(...)`
([background.js:228-233](extension/background.js#L228-L233)). The save is
debounced, so the storage write lands after the remove call
([background.js:78-97](extension/background.js#L78-L97)). `wasListed()`
returns true at once for a source in `spawned`
([background.js:220](extension/background.js#L220)). The `inListedTab`
reply also reports a spawned tab as listed
([background.js:371](extension/background.js#L371)), so `arm.js` arms the
guard inside a popup that is about to be closed. The saved list keeps the
last 500 ids ([background.js:86](extension/background.js#L86)).

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
in event order ([background.js:114-149](extension/background.js#L114-L149)).
`seq` is a worker-wide counter that goes up on every commit. Only the host
is kept, never the URL. An entry is added only when the frame's site
actually changes ([background.js:138-140](extension/background.js#L138-L140)).

This history covers every tab and frame, on every site, whether or not it is
listed and even while the list is empty: `onCommitted` never looks at the
list ([background.js:114-149](extension/background.js#L114-L149)). It holds
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
([background.js:162-169](extension/background.js#L162-L169)).
`decideFromNav` checks both `{ atSeq }` (worker event order at
`tabs.onCreated`) and `{ atTime: details.timeStamp }` (the browser's own
timestamp on the navigation-target event). The tab counts as opened by a
listed page if either moment says so
([background.js:299-306](extension/background.js#L299-L306)). The opener-only
fallback has no browser timestamp and uses `{ atSeq }` only
([background.js:331](extension/background.js#L331)).

**Why not the obvious way.** The worker's event order and the browser's
timestamps can disagree. A tab-under may reach the worker as the opener's
navigation away followed by `tabs.onCreated`, even though the browser
created the popup first. Restored entries also have no real place in this
worker's order. So the opener is judged both ways, and the tab counts as
opened by a listed page if either view says so: a fast navigate-away cannot
hide the listed state from both. Restored entries get `seq 0`, which always
counts as "before" ([background.js:49](extension/background.js#L49)).
Test: "hidden-frame open, then 6 redirects", served by a `/chain?n=N` route
that redirects with `location.replace`
([run.mjs:62-67](test/run.mjs#L62-L67)).

##### Walking up the frame tree as it was (`frameWasListed`)

**Problem.** A popup may come from an unlisted or script-made frame inside a
listed page, or from a listed iframe inside an unlisted page. The frame may
also have navigated away or been removed since.

**What it does.** Starting from the source frame, each step takes that
frame's entry at the moment, checks whether its host is listed, then moves
to its recorded parent. It stops at frame 0 and is capped at 32 hops
([background.js:184-214](extension/background.js#L184-L214)). If a subframe
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
input give `""` ([lib.js:25-42](extension/lib.js#L25-L42)).

**Why not the obvious way.** `new URL("blob:https://listed/…").hostname` is
`""`, which would make a listed page's blob copy look unlisted. Only
top-frame commits treat the two differently: a `null` host inherits the
previous top-frame site (unless the user typed the address), while `""`
stays unlisted ([background.js:118-124](extension/background.js#L118-L124)).
`arm.js`'s `inListedTab` question uses the top-frame result too. In the
frame walk both are falsy, so a subframe with either one defers to its
parent: any frame under a listed frame counts as listed whatever its own
host ([background.js:209-211](extension/background.js#L209-L211)).

##### Top-frame pages with no site inherit the previous one unless the user typed them

**Problem.** A listed page can shed its site by navigating its own top
frame to `about:blank`, a `data:` URL or a `blob:null` it made, and then
open popups from a page that has no host.

**What it does.** When `siteOf()` gives `null` for a top-frame commit, the
host is set to `""` if the transition type is one the user makes (`typed`,
`auto_bookmark`, `generated`, `keyword`, `keyword_generated`, `start_page`,
`auto_toplevel`). Otherwise it is the previous top-frame host
([background.js:109-124](extension/background.js#L109-L124)). So when a
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
60 s before this commit is removed
([background.js:127-137](extension/background.js#L127-L137)). A marked entry
also fails the "same site as before" check, so a later commit in the same
frame id is recorded again ([background.js:139](extension/background.js#L139)).

**Why not the obvious way.** Deleting the old page's frames on navigation
would lose the evidence when an iframe opens a popup and the page leaves at
once.

##### A 1000-entry cap that fails closed

**Problem.** A page that keeps navigating or churning iframes could grow its
history without limit. Silently dropping the oldest top-frame entry could
make a listed origin forgotten.

**What it does.** Above `MAX_ENTRIES` (1000), the oldest subframe entry is
dropped first. Only if there are none is the oldest top-frame entry dropped,
and the tab is then added to `trimmed`
([background.js:141-147](extension/background.js#L141-L147)). In
`frameWasListed`, a trimmed tab with no top entry at the moment counts as
listed ([background.js:195-196](extension/background.js#L195-L196)).

**Why not the obvious way.** Once the earliest top entries are gone, what
the tab showed back then is unknown. Treating it as listed is the safe
default.

##### Prerender commits are skipped

**Problem.** Chrome prerenders pages (speculation rules, the address bar)
and fires `onCommitted` for them in the same tab id, though the user never
saw them.

**What it does.** `onCommitted` returns at once for
`documentLifecycle === "prerender"`
([background.js:115](extension/background.js#L115)).

**Why not the obvious way.** A prerendered page would otherwise rewrite the
tab's top-frame history and could flip later verdicts.

#### Surviving service-worker restarts

##### State in `chrome.storage.session`

**Problem.** Chrome stops an MV3 service worker after about 30 s of quiet.
A popup opened from a page you have been reading for a while usually wakes a
cold worker with no history in memory.

**What it does.** `spawned`, `history` (packed into arrays
`[f, p, h, t, left]`), `trimmed`, `menus` and `gone` are written to
`chrome.storage.session` ([background.js:47-97](extension/background.js#L47-L97)).
On startup a single `restored` promise reads them. Saved history rows are
placed before anything this worker has already recorded and get `seq 0`.
Saved menus and closed-tab records never overwrite newer in-memory ones.
Every decision path and the `inListedTab` reply wait for `restored` first
([background.js:303](extension/background.js#L303),
[background.js:329](extension/background.js#L329),
[background.js:370](extension/background.js#L370)).

Tab ids are object keys in storage, so they come back as strings and are
converted with `+id` before use
([background.js:55-59](extension/background.js#L55-L59)). Otherwise no
restored record would match a numeric `tabId`. A failed read is caught
before the seeding step
([background.js:62-63](extension/background.js#L62-L63)), so the worker
still seeds every open tab from what it shows now and `restored` always
resolves.

**Why not the obvious way.** Events can arrive before the restore finishes,
so the restore merges with memory instead of replacing it. Session storage
survives a worker restart but not a browser restart, which matches the
lifetime of tab ids.

##### Seeding tabs that were open before the worker had a record

**Problem.** Tabs open when the extension is installed, enabled or first
started have no recorded commits.

**What it does.** After restore, every tab without a restored top-frame
entry gets `{ f: 0, p: -1, h: siteOf(url) ?? "", t: 0, seq: 0 }` at the
front ([background.js:63-73](extension/background.js#L63-L73)). A tab
showing `about:blank` at startup has nothing to inherit from, so it is
seeded as unlisted. Separately,
`frameWasListed` falls back to the tab's current URL when the top frame has
no entry at all ([background.js:197-199](extension/background.js#L197-L199)).

**Why not the obvious way.** `t: 0` and `seq: 0` make the seed come before
every real event, so it never hides a later commit. The test is "has a
`seq 0` top entry", not "has any entries", because the worker may already
have recorded new commits before the restore finished.

##### Debounced writes that never leave a stale record

**Problem.** `onCommitted` fires often. A failed write (for example, the
session quota) could leave an older history in storage, to be restored
later and give wrong verdicts.

**What it does.** `persistTimer ??= setTimeout(…, 0)` merges all calls in
one tick into one write, and the write waits for `restored`. Each write
takes a number. If it fails, and no newer write has started, it removes the
`history` and `trimmed` keys ([background.js:76-97](extension/background.js#L76-L97)).

**Why not the obvious way.** A stale snapshot is worse than none. A missing
record falls back to current URLs, while an old one gives confident wrong
answers. The counter stops a late failure of an old write from deleting
what a newer write saved.

##### Closed tabs are remembered for 30 s

**Problem.** An ad can open a popup and then close the opener with
`window.close()`. `chrome.tabs.get` on a closed tab fails, so its history is
the only evidence.

**What it does.** `tabs.onRemoved` records the time in `gone` and persists.
It also schedules `setTimeout(persist, 31_000)`, because `persist()` runs
`forgetGone()`, which deletes everything about tabs closed at least 30 s
ago ([background.js:99-107](extension/background.js#L99-L107),
[background.js:151-155](extension/background.js#L151-L155)). `forgetGone()`
also runs after restore, so a worker that slept through the window still
cleans up.

**Why not the obvious way.** Cleaning up in `onRemoved` breaks the
`window.close()` tab-under. Test: "hidden-frame open, then window.close()".

#### Context-menu exemption

##### `arm.js` reports menus from trusted events only

**Problem.** On a listed page, "Search for …" and "Open image in new tab"
open tabs that come from that page but that the user chose. A page must not
be able to use this as a loophole.

**What it does.** A capture `contextmenu` listener in `arm.js` runs only
when the frame is armed and `e.isTrusted`
([arm.js:119-150](extension/arm.js#L119-L150)). It sends
`{ type: "contextMenu", selection, srcs }`. `srcs` are the `currentSrc` and
`src` of images and media along `e.composedPath()` (which crosses open
shadow roots), plus `<source src>` children of media. Closed shadow trees
hide their nodes from `composedPath()`, so the elements under the pointer
are walked separately with `elementFromPoint()`, stepping into each open
or closed root with `chrome.dom.openOrClosedShadowRoot` (needs the `"dom"`
permission, [manifest.json:6-11](extension/manifest.json#L6-L11)). That walk
also collects SVG `<image>` (`href` resolved against the document) and
`<input type=image>` (`.src`), which the browser treats as images for the
menu but which are not `HTMLImageElement`. If `getSelection()` is empty,
the selection is read from the focused input or textarea, because the
Selection API does not see text selected inside form fields. The background
keys the record by `sender.tab.id`, which comes from the browser, keeps at
most 20 string `srcs` and 500 characters of selection, and stamps the time
([background.js:353-361](extension/background.js#L353-L361)).

**Why not the obvious way.** A page can dispatch a synthetic `contextmenu`,
so `isTrusted` is required. Running in the isolated world means page changes
to prototypes or `getSelection` cannot change what is read. `e.target`
alone would miss shadow-DOM images and the source the browser chose from
`srcset`, and "Open image in new tab" uses `currentSrc`.

##### The record ends on the next `mousedown` or `keydown`

**Problem.** The worker must forget the menu as soon as it is gone, so a
page-opened tab right after cannot match its leftovers.

**What it does.** Trusted `mousedown` and `keydown` in the capture phase
send `contextMenuClosed` ([arm.js:110-118](extension/arm.js#L110-L118)). While
a native context menu is open the page receives neither, so the first one
means the menu has closed. The background deletes the record
([background.js:362-365](extension/background.js#L362-L365)).

**Why not the obvious way.** `pointermove` looks like the quickest "user is
back" signal, but moving the pointer does not close a menu. Moves around the
`contextmenu` event, which fires before the menu appears, would end the
record before the user could pick anything. Test: "a click in the page ends
the menu".

##### A single-use, five-minute, address-matched exemption

**Problem.** Only the tab the menu actually offered should be kept. The
site's own links opened in new tabs must stay blocked, even right after a
context menu.

**What it does.** `fromUserMenu` runs only after the source is found to be
listed ([background.js:307-310](extension/background.js#L307-L310)). It needs
`born.get(tabId).url`, which exists only for browser-made tabs. It needs a
menu record for the source tab less than 300 s old. `offeredByMenu` then
accepts the URL if it equals one of the reported `srcs`, if it is the
selected address itself (Brave's "Go to <address>": the selection parsed
as a URL, with `http://` added to bare hosts, compared against the tab's
host and path exactly — not as a substring — and case-insensitively), or
if the selection, whitespace-collapsed, lowercased and cut to 50
characters (and not empty), appears in a decoded query-parameter value of
the URL. On a match the record is deleted: one tab per menu
([background.js:391-441](extension/background.js#L391-L441)).

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
frame) ([background.js:289-297](extension/background.js#L289-L297)).
`SEARCH` is anchored at `^https://`, allows an optional `www.`, a fixed
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
channel open ([background.js:366-377](extension/background.js#L366-L377)).

**Why not the obvious way.** `sender.tab.url` alone fails for a page that
turned itself into `blob:null`. Reporting popups in flight as listed arms
the guard inside them before the background closes them, which stops
chains.

##### Cached domain list

`getDomains()` caches the `loadDomains()` promise with `??=`, so callers
during the first load share one read. A change to `storage.sync` replaces the
cache with the new value and refreshes every badge
([background.js:8-17](extension/background.js#L8-L17)). Every decision path
returns early when the list is empty.

##### Domain matching

`normalizeDomain` lowercases and trims, adds `http://` when there is no
scheme so the URL parser can extract the host (which also turns IDN input
into punycode), strips a leading `www.` and a trailing dot, and accepts only
names that match a strict label pattern or a bracketed IPv6 address
([lib.js:3-17](extension/lib.js#L3-L17)). `hostIsBlocked` lowercases, strips
a trailing dot and matches `h === d || h.endsWith("." + d)`
([lib.js:19-23](extension/lib.js#L19-L23)). A bare `endsWith(d)` would match
`evilexample.com`, and a trailing-dot name (`example.com.`) would otherwise
get past the list. Because of the `www.` strip
([lib.js:15](extension/lib.js#L15)), entering `www.example.com` lists all of
`example.com`. `saveDomains` stores the whole list as one sorted,
de-duplicated `chrome.storage.sync` item
([lib.js:53-57](extension/lib.js#L53-L57)), so it is bound by the sync
per-item quota.

##### Per-tab badge

`setBadge` shows `ON` on tabs whose URL (or pending URL, so it lights before
the commit) is listed. It refreshes on `tabs.onUpdated`, `tabs.onActivated`
and on list changes ([background.js:379-399](extension/background.js#L379-L399)).

The badge looks only at the tab's address
([background.js:381-385](extension/background.js#L381-L385)). Blocking also
applies where it shows nothing: in a listed iframe on an unlisted page, and
on a listed page that has turned itself into `about:blank` or a `blob:null`
page.

##### Small defensive details

Every browser call that can fail on a decision path has a `.catch` with a
default: `tabs.get` gives `null` (judged not listed), `getAllFrames` an
empty map (the walk jumps to the top frame), `tabs.remove` and
`setBadgeText` failures are ignored, and the startup `tabs.query` gives an
empty list ([background.js:181-182](extension/background.js#L181-L182),
[background.js:198-199](extension/background.js#L198-L199),
[background.js:231](extension/background.js#L231),
[background.js:384](extension/background.js#L384)). A decision therefore
settles, and `track()` cleans it up
([background.js:171-179](extension/background.js#L171-L179)), instead of
leaving a rejected promise that later popups would wait on. Message
handlers check `msg?.type` and `sender.tab?.id`, and the menu `srcs` are
checked to be strings ([background.js:353-358](extension/background.js#L353-L358)).

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

**What it does** ([arm.js:39-62](extension/arm.js#L39-L62)):

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
([arm.js:64](extension/arm.js#L64)). The guard then stays installed but
unarmed on that page: everything passes through, but its wrappers are not
removed.

Limits: a top-level page asks only if it still has `window.opener` when the
list arrives ([arm.js:49](extension/arm.js#L49)). A cross-site popup opened
with `noopener`, or one that clears its own `opener` first, is treated as
unlisted in the page. The background still closes it and anything it opens
(`spawned`). The background's reply describes the tab (its URL, its
top-frame history, whether it is a popup in flight), not the asking frame's
own ancestors ([background.js:366-377](extension/background.js#L366-L377)).
So frames under a listed iframe that is itself sandboxed (shown as `"null"`)
inside an unlisted page are not guarded in the page. The background's frame
walk still catches their popups.

**Why not the obvious way.** `"null"` in `ancestorOrigins` means "hidden or
opaque", not "unlisted". Asking the background for every page would slow
every load and keep waking the worker. `arm.js` has its own copy of the host
match ([arm.js:31-37](extension/arm.js#L31-L37)) because a manifest content
script is a classic script: it cannot use a static `import`, and a dynamic
one would need `lib.js` exposed as a web-accessible resource
([manifest.json](extension/manifest.json) declares none) and an extra async
step.

##### Secret handshake: only `arm.js` can arm or remove the guard

**Problem.** `guard.js` listens for DOM events from `arm.js`, and the page
can dispatch the same events. A fake "unlisted" event would make the guard
remove itself on a listed site. `isTrusted` does not help, because events
dispatched by content scripts are untrusted too.

**What it does.** `arm.js` builds a secret from
`crypto.getRandomValues(new Uint32Array(4))` in base 36, and dispatches
`__no_new_tabs_hello__` with that secret as `detail`, synchronously at
`document_start` ([arm.js:14-19](extension/arm.js#L14-L19)). `guard.js`
registered a `{ once: true }` listener and stores it with
``secret ??= `${e.detail}` ``, so only the first hello counts. Later
`__no_new_tabs_arm__` and `__no_new_tabs_unlisted__` events count only if
their `detail`, read with the saved `CustomEvent.prototype.detail` getter,
equals the secret ([guard.js:114-128](extension/guard.js#L114-L128)).

**Why not the obvious way.** Both scripts run before any page script, so no
page listener exists to see the hello, and the secret never reaches page
code at that point. `crypto.randomUUID` is the natural choice but it only
exists in secure contexts. It is missing on plain-http sites, so the guard
would never arm there. `localhost` counts as a secure context even over
http, so a suite that only uses `localhost` would not notice; the tests map
`*.test` to the local server to cover this
([run.mjs:420-438](test/run.mjs#L420-L438)). The secret is a string
because Chrome hands a `CustomEvent.detail` from the isolated world to the
page's world only as a primitive: an object made in `arm.js` would show up
as `null` in `guard.js`. The guard compares it by value, read through the
saved `CustomEvent.prototype.detail` getter
([guard.js:118-119](extension/guard.js#L118-L119)). Tests: "page fakes the
'unlisted' signal", "page faked 'unlisted' during load", "page fakes 'arm',
then opens".

See [Known gaps](#known-gaps): a page capture listener could stop the arm
signal.

##### Arming is one-way

**Problem.** After the first hello, every arm or unlisted event carries the
secret, so a page listener could read it and replay it. A late
"unlisted" (after the list changes) must not disarm a guarded page either.

**What it does.** `onArm` only arms. `onUnlisted` acts only while not armed
([guard.js:120-123](extension/guard.js#L120-L123)). On the `arm.js` side,
`arm()` sends at most once and `unlisted()` never sends after arming
([arm.js:21-29](extension/arm.js#L21-L29)). Removing a site from an open
page needs a reload, which is why the popup reloads the tab
([popup.js:29-34](extension/popup.js#L29-L34)).

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
([guard.js:381](extension/guard.js#L381)). After arming, the same saved
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
([guard.js:104-112](extension/guard.js#L104-L112)). Cross-origin access
throws and is caught; `arm.js` decides those cases.

**Why not the obvious way.** This runs before any page script in the new
window. The marker it reads lives on the parent or opener, where page
scripts have already run, and it stays configurable until that window is
armed ([guard.js:352](extension/guard.js#L352),
[guard.js:415](extension/guard.js#L415)), so that page could redefine it.
At worst that arms the guard early, or leaves the decision to `arm.js`.

##### Live arming without a reload

**Problem.** When a site is added while its page is open, the page should
become guarded at once, including hidden frames that already exist, even
before any user input.

**What it does.** `arm.js` listens to `chrome.storage.onChanged` and checks
again ([arm.js:64-68](extension/arm.js#L64-L68)). `guard.js`'s `arm()` sets
`armed`, clears `removed`, reinstalls into the window if it had removed
itself, locks `window.open` in every realm, and sweeps every same-origin
child frame ([guard.js:130-136](extension/guard.js#L130-L136)).

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
them ([guard.js:305-307](extension/guard.js#L305-L307),
[guard.js:355](extension/guard.js#L355),
[guard.js:373](extension/guard.js#L373)). For full in-page protection,
reload the tab after adding a site. The background layer covers the rest.

#### Hardening against a hostile page

##### Content-type gate

The guard's first statement returns unless `document.contentType` is HTML,
XHTML, SVG or XML, the types that run script
([guard.js:28-29](extension/guard.js#L28-L29)). It runs before any page
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
([guard.js:36-99](extension/guard.js#L36-L99)). Array appends go through
`defineProperty` instead of `Array.prototype.push`, and option and
descriptor objects handed to the browser are copied to a null prototype,
so poisoned `Object.prototype` or `Array.prototype` members are never
consulted. After that it calls these saved copies for the checks that
decide whether an open, click or submit opens a new context. A few steps
still read live, page-visible properties: `win.Function` at install and in
`relisten` (with a fallback that matches the record by window when the
page replaced `Function`), `win.MutationObserver` and its
`observe`/`disconnect`, `win.DOMException` when refusing
picture-in-picture, `el.contentWindow` for `<frame>` and `<object>`, and
each realm's own `Range.prototype.startContainer` getter (never the
`Node.prototype` property a page can shadow) when finding a `Range`'s
window ([guard.js:571-581](extension/guard.js#L571-L581)). See
[Known gaps](#known-gaps).

**Why not the obvious way.** The capture only counts because it happens
before any page script runs. The same code run later would capture the
page's replacements.

##### Call through `Reflect.apply`, never `.call` or `.apply`

**Problem.** `fn.call(obj, …)` looks up `Function.prototype.call` at call
time, and a page can replace it.

**What it does.** `uncurry(f)` returns `(self, ...args) => apply(f, self, args)`,
where `apply` is the saved `Reflect.apply`
([guard.js:33-36](extension/guard.js#L33-L36)). Every saved method becomes a
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
([guard.js:37](extension/guard.js#L37),
[guard.js:49-75](extension/guard.js#L49-L75)). The guard calls
`nodeType(n)`, `localName(el)`, `evType(e)`, `winName(w)` and so on, which
run the browser's own getter whatever the page has defined on the object.

**Why not the obvious way.** The test page redefines its own `window.name`
as a getter that returns `'ghost'` and then calls `open(url, 'ghost')`
([v14.html:39](test/site/v14.html#L39)). A plain `w.name` read would find
the page itself as a matching "frame" and let a new window open. Test:
"fake window.name, then open into it".

##### Native getters that can throw get safe defaults

A captured native getter throws "Illegal invocation" on the wrong kind of
object, for example a plain `Event('click')` with no MouseEvent fields.
`mouseKey()` wraps each MouseEvent getter in `try/catch` and returns
`false`, or `0` for `button` ([guard.js:67-68](extension/guard.js#L67-L68)).
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
([guard.js:174-191](extension/guard.js#L174-L191),
[guard.js:231-235](extension/guard.js#L231-L235)). Appends to the guard's
own lists go through the same `defineProperty` path.

**Why not the obvious way.** The rule is about when code runs, not about
syntax. The startup block uses `.map`, destructuring and `for…of` because no
page script has run yet ([guard.js:43-44](extension/guard.js#L43-L44),
[guard.js:107](extension/guard.js#L107)). The same syntax in a wrapper body
would be unsafe.

##### Bound helpers and captured constructors

`setTimeout`, `console.info` and `Promise.reject` are bound at startup, and
the `WeakMap` and `WeakRef` constructors are saved
([guard.js:76-82](extension/guard.js#L76-L82)). `install()` runs again much
later for adopted frames and on live arming, and a bare `new WeakMap()` then
would use whatever the page has put in `window.WeakMap`. A page that
replaces `console.info` also cannot see or silence the guard's log.

##### Capture as a boolean, not an options object

`listen()` and the shadow-root listeners pass `true` as the third argument
([guard.js:346](extension/guard.js#L346),
[guard.js:669-671](extension/guard.js#L669-L671)). An options object such
as `{ capture: true }` is read through `Object.prototype`, so a page could
add `signal` (an aborted `AbortSignal`) or flip `capture` on every listener
the guard adds later. The only options object left is the `{ once: true }`
in `later()` ([guard.js:609](extension/guard.js#L609)), which is the
`Object.prototype.signal`/`capture` gap listed under
[Known gaps](#known-gaps). The hello listener's `{ once: true }`
([guard.js:117](extension/guard.js#L117)) is safe because it is created
before any page script runs.

##### Strict mode and `this ?? win`

**Problem.** Pages save an `open` and call it bare (`const o = w.open; o(url)`)
or on another window (`savedFrameOpen.call(window, url)`). The guard must
judge the target from the window the browser will open from.

**What it does.** The guard is `"use strict"`, so a bare call leaves `this`
undefined instead of the guard's own global. The wrapper uses
`const self = this ?? win`, where `win` is the window it was installed into
([guard.js:26](extension/guard.js#L26),
[guard.js:379-386](extension/guard.js#L379-L386)).

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
from the native ([guard.js:96-102](extension/guard.js#L96-L102)). In each
realm, `Function.prototype.toString` is replaced with one that follows the
`nativeOf` map (wrapper to native, to the end of the chain) and calls the
realm's original `toString` on the native. It registers itself too, so
`toString.toString()` looks native
([guard.js:354-365](extension/guard.js#L354-L365)).

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
`Promise` ([guard.js:82](extension/guard.js#L82),
[guard.js:506](extension/guard.js#L506)). Test:
"Function.prototype.toString looks native".

##### Rate-limited logging

The guard logs the first 20 blocks, then one "further blocks on this page
not logged" line, then nothing ([guard.js:89-94](extension/guard.js#L89-L94)).
Some ad scripts retry many times a second.

#### window.open

##### Blocked opens return `null`

A blocked `window.open` or three-argument `document.open` logs and returns
`null`, which is what the browser's popup blocker returns
([guard.js:386-389](extension/guard.js#L386-L389)). Throwing, or returning a
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
are both checked and passed on ([guard.js:203-209](extension/guard.js#L203-L209),
[guard.js:382](extension/guard.js#L382)).

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
`about:` or `javascript:` ([guard.js:186-200](extension/guard.js#L186-L200)).
`window.open` and `document.open` block those URLs whatever the target.

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
through `win.open` ([guard.js:373](extension/guard.js#L373),
[guard.js:402](extension/guard.js#L402)). Tests: "window.open was plain
during load too", "window.open is a plain property again".

##### One stable wrapper per function

`guarded(fn)` keeps one wrapper per underlying function in a WeakMap, so
`window.open === window.open` holds and saved references compare equal
([guard.js:374-394](extension/guard.js#L374-L394)). The WeakMap does not
keep page functions alive.

##### Once armed: a non-configurable accessor with a setter

**Problem.** After arming, the page can still assign a fresh native to
`window.open` (another frame's `open`), or try to redefine or delete it.

**What it does.** `rec.lock()` replaces `window.open` with a
non-configurable accessor. It takes the current value (from the data
property, or by calling the page's own getter), unwraps it if it is one of
the guard's wrappers, and stores it. The getter returns `guarded(value)`,
and the setter just stores the new value
([guard.js:403-417](extension/guard.js#L403-L417)). Being
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

**What it does.** The getter calls `pageWritten(value)`, which runs the
original `Function.prototype.toString`, saved before the spoof. If the
source lacks `[native code]`, the function is the page's own and is
returned unchanged. Whatever native it calls is a guarded wrapper anyway.
Natives (from any frame) and bound functions come back guarded; a
page-written function from another frame is returned unchanged, like any
other page-written one
([guard.js:395-401](extension/guard.js#L395-L401),
[guard.js:409](extension/guard.js#L409)). If `toString` throws, the
function is treated as native and guarded.

**Why not the obvious way.** It must use the original `toString`. The spoof
would report the guard's own wrappers as native. Bound functions print
`[native code]`, so a bound native `open` is guarded. Test: "window.open ===
the site's own hook".

##### `document.open` with three arguments

`document.open(url, name, features)` is an old alias for `window.open`. The
wrapper blocks three-argument calls that open a new context or an inert URL,
judged from the document's own window. Calls with fewer arguments replace
the document and go through ([guard.js:419-433](extension/guard.js#L419-L433)).
Only the argument count tells the two apart. Test: "document.open(3 args)".

##### Picture-in-picture windows are refused

`documentPictureInPicture.requestWindow()` opens an always-on-top window.
When armed, the wrapper rejects with a `DOMException` `NotAllowedError` made
from that realm's own `DOMException`
([guard.js:501-510](extension/guard.js#L501-L510)). That looks like the
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
inside another one is covered ([guard.js:245-268](extension/guard.js#L245-L268)).

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
([guard.js:335-739](extension/guard.js#L335-L739)). `state`, `nativeOf` and
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
([guard.js:272-283](extension/guard.js#L272-L283)). A new document in a new
realm has a new `Function`, so it is installed again. `win.Function` also
throws for cross-origin windows, so `adopt()`'s `try/catch` skips those;
they get their own `guard.js`. A list of WeakRefs (`realms`) makes the
WeakMap iterable without keeping removed frames alive. Dead entries are
skipped but not removed while the page is armed
([guard.js:277-283](extension/guard.js#L277-L283)), so `realms` grows by
one small WeakRef per adopted realm for the life of the page. Only
`uninstallAll` clears it ([guard.js:291](extension/guard.js#L291)).

The key is read as `win.Function`
([guard.js:307](extension/guard.js#L307)), an ordinary writable global,
just like the marker. (The code comment at
[guard.js:272-273](extension/guard.js#L272-L273) says it can't be faked;
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
([guard.js:351-352](extension/guard.js#L351-L352)). Readers get the live
state. `install()` skips a window that already has its own marker
([guard.js:311](extension/guard.js#L311)). When armed, `rec.lock()` makes
the marker non-configurable ([guard.js:415](extension/guard.js#L415)).
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
patches ([guard.js:335-341](extension/guard.js#L335-L341)). The saved
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
`length` getter, runs the native call, and in `finally` reads the count
again. If it changed, it sweeps that window
([guard.js:543-560](extension/guard.js#L543-L560)). The `finally` means a
call that throws still gets its frames swept.

**Why not the obvious way.** A MutationObserver runs as a microtask, after
the inserting script has already read `contentWindow.open`. Only a
synchronous wrapper closes that gap. Comparing `window.length` is cheap and
needs no walk over the inserted subtree.

##### Every insertion API, on each interface that owns it

`before`, `after` and `replaceWith` are defined separately on `Element`,
`CharacterData` and `DocumentType`, not inherited from `Node`. The guard
wraps an explicit table: `Node` (`appendChild`, `insertBefore`,
`replaceChild`); `Element` (`append`, `prepend`, `before`, `after`,
`replaceWith`, `replaceChildren`, `insertAdjacentElement`,
`insertAdjacentHTML`, `setHTMLUnsafe`); `CharacterData` and `DocumentType`
(`before`, `after`, `replaceWith`); `Document` (`append`, `prepend`,
`replaceChildren`); `ShadowRoot` (`setHTMLUnsafe`); `Range` (`insertNode`,
`surroundContents`) ([guard.js:561-571](extension/guard.js#L561-L571)).
`method()` skips a key that is not an own function, so a missing API is
skipped without error ([guard.js:336-339](extension/guard.js#L336-L339)).
The `innerHTML` and `outerHTML` setters on `Element` and `ShadowRoot` are
wrapped too ([guard.js:572-573](extension/guard.js#L572-L573));
`ShadowRoot.innerHTML` is its own accessor, not inherited from `Element`.
A sweep only finds frames through `window.length` and `win[i]`, which do
not reach frames inside a shadow tree, so those are adopted by the
`contentWindow` getter when the page reads it
([guard.js:512-531](extension/guard.js#L512-L531)), not by an insertion
wrapper.

##### Finding the window that gains the frame

`viewOfTarget` maps a `Range` to its start container, a `Document` to its
own `defaultView`, and any other node to its owner document's window
([guard.js:537-542](extension/guard.js#L537-L542)). A Document's
`ownerDocument` is `null`, so a naive lookup would miss
`document.append(...)`. Inserting into a child frame's document must sweep
that frame's window, not the top one.

##### A frame swapped for another one

`replaceWith`, `replaceChild` or moving an iframe can leave the count the
same while a new, unguarded window exists. If the count did not change and
is above 0, `framesAfter` checks whether any argument is or contains a
frame element, and sweeps anyway ([guard.js:553-557](extension/guard.js#L553-L557)).
Re-adopting is safe because `install()` runs once per realm.

##### `contentWindow` and `contentDocument` adopt before handing over

For `HTMLIFrameElement`, `HTMLFrameElement` and `HTMLObjectElement`, the
`contentWindow` and `contentDocument` getters call the native getter, adopt
the resulting window, and return the value unchanged
([guard.js:512-531](extension/guard.js#L512-L531)). This is the one moment
the page is certain to get a reference, so guarding here cannot come too
late. Test: "jsf iframe contentWindow.open".

##### Parser-inserted frames: a MutationObserver

**Problem.** The HTML parser inserts frames without calling any DOM method.
An inline script right after an `<iframe>` tag can save `frames.name.open`.

**What it does.** One MutationObserver per installed window, made from that
realm's own constructor, watches the document. It ignores the records and
only compares the frame count with the last count, sweeping on a change
([guard.js:575-587](extension/guard.js#L575-L587)).

**Why not the obvious way.** Parsing calls nothing that can be patched. The
only hook is the microtask checkpoint the parser runs before each script.
This timing is also what beats a page that plants a fake marker on a
parser-inserted frame. Test: "open saved from a frame, while parsing".

##### A capture `load` listener on the document

A frame's window can change when its first document loads. A capture `load`
listener on the document adopts the window of any frame element that
finishes loading ([guard.js:588-596](extension/guard.js#L588-L596)). It has
to be on the document in the capture phase: element `load` events do not
bubble and never reach `Window` listeners. The saved `contentWindow` getter
is for iframes only, so `<frame>` and `<object>` fall back to
`el.contentWindow`, which is itself the adopting wrapper.

##### Sweep before any input reaches page handlers

**Problem.** A page can reach frames through `window[n]` or `frames[n]`
without touching the element, so no getter or insertion hook runs.

**What it does.** Capture listeners on the window for `pointerdown`,
`mousedown`, `pointerup`, `keydown`, `touchstart`, `touchend` and `click`
sweep all frames when armed ([guard.js:677-682](extension/guard.js#L677-L682)).
They run before any page handler for that input.

**Why not the obvious way.** A popup needs user activation, and a new frame
has none. Only frames that existed before the input matter, so sweeping at
the start of each activating input covers them. `pointermove` is left out
because it grants no activation.

##### `adopt()` and `sweep()`

`adopt(win)` runs `install(win)` then `sweep(win)` inside one `try/catch`,
so a cross-origin child is skipped. `sweep()` reads the count with the
native getter and indexes `win[i]` inside `try`, recursing into
grandchildren ([guard.js:252-268](extension/guard.js#L252-L268)).

##### Listeners re-added after `document.open` and `write`

**Problem.** Replacing a document with `document.open()` (or a `write` after
load) makes the browser drop every listener on the window and document.
That removes the guard's click, submit and load listeners and the control
listeners `arm.js` signals through.

**What it does.** `document.open`, `write` and `writeln` are wrapped. In a
`finally` block the wrapper calls `relisten(this)` and `sweepFrom(this)`
([guard.js:441-446](extension/guard.js#L441-L446)). `relisten` finds the
realm's record and re-adds every listener recorded by `listen()`, plus the
control listeners for the guard's own window
([guard.js:306-313](extension/guard.js#L306-L313)). `sweepFrom` adopts
frames the written HTML created. Two rewrites the wrappers cannot cover
are handled by observers, which survive `document.open()`: `arm.js`
re-runs its menu reporting setup, and the guard puts its control
listeners back even while uninstalled, so a rewritten unlisted page still
hears a later arm signal. Tests: "menu reported after document.open()",
"menu reported in rewritten iframe", "rewritten unlisted page arms when
listed".

**Why not the obvious way.** `addEventListener` ignores a listener already
registered with the same type, callback and capture, so calling `relisten`
after every write does not register anything twice. Tests: "_blank after
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
adopts it like any same-origin child ([guard.js:247-251](extension/guard.js#L247-L251)).
Tests: "no-script sandbox frame's window.open / form.submit", "_blank link
in a no-script sandbox frame".

A frame with neither `allow-scripts` nor `allow-same-origin` has an opaque
origin: the parent can never adopt it and no script runs in it, so a
`target=_blank` link inside it would flash a tab. On listed pages the guard
takes `allow-popups` out of such a frame's `sandbox` attribute — at
insertion, on load, when the page is armed, and when the attribute is set
afterwards — so the click does nothing instead of flashing. Test: "opaque
sandbox _blank click".

#### Links, forms and clicks

##### Link clicks: capture on the window

**Problem.** `target=_blank`, Ctrl/Cmd-click (new tab), Shift-click (new
window) and middle-click all open new contexts. Downloads must still work.

**What it does.** `onActivate` is a capture listener on the window for
`click` and `auxclick`, so it runs before page handlers
([guard.js:659-697](extension/guard.js#L659-L697)). It returns early if the
event is already `defaultPrevented` (handled further out, which avoids
double handling between window and shadow-root listeners). It takes the
first link in the saved `composedPath`, so the innermost link wins. A link
with `download` is left alone unless it is a middle or modifier click. It
blocks a middle `auxclick`, a click with Ctrl, Meta or Shift, a `click`
with button 1 (a script dispatching one is treated as a middle click), or
a click whose target opens a new context.

**Why not the obvious way.** `composedPath` sees through open shadow roots,
where `e.target` is retargeted to the host. A `_blank` download starts a
download, not a tab. Right-click `auxclick` (button 2) does not open
anything.

##### `later()`: look again after the page's own handlers

**Problem.** A page handler that runs after the guard can set
`link.target = "_blank"`, insert `<base target=_blank>` or change
`form.target`.

**What it does.** When a click or submit does not open a new context yet,
`later()` adds a one-time non-capture listener on the window for the same
event type. It runs after the target and bubble-phase handlers and re-runs
the same check ([guard.js:638-656](extension/guard.js#L638-L656)). `ev === e`
ignores a different event of the same type. A `setTimeout(0)` removes the
listener if the page stopped propagation.

**Why not the obvious way.** Capture-only checks are too early. Bubble-only
checks are beaten by `stopPropagation`. Checking at both ends covers a page
that changes the target, or one that stops the event, but not a handler
that does both: it changes the target and then stops propagation, so the
late check never runs. The late listener is also always on the window
([guard.js:609](extension/guard.js#L609)). It never fires for events that
stay inside a shadow root (all `submit` events and non-composed clicks), so
a target changed by a handler inside a shadow root is not caught in the
page. In those cases the background layer closes the tab (a brief flash).
Tests: `target set by a page click handler`, `<base target> set by a click
handler`, `form target set by a submit handler`.

##### Forms and `onSubmit`

A capture `submit` listener on the window computes the target from the
submitter's `formtarget`, then the form's `target`, then `<base target>`
([guard.js:224-227](extension/guard.js#L224-L227),
[guard.js:647-657](extension/guard.js#L647-L657)). The submitter comes from
the saved `SubmitEvent.prototype.submitter` getter, in `try/catch` so a
plain `new Event('submit')` cannot make it throw. `isSubmit` matches
`input[type=submit]`, `input[type=image]` and
`button:not([type=button]):not([type=reset]):not([type=menu])`, so buttons
with a missing or invalid `type`, which default to submit, are included. The
form comes from the native `form` getter of `HTMLButtonElement` or
`HTMLInputElement`, which honours the `form=` attribute
([guard.js:71-72](extension/guard.js#L71-L72),
[guard.js:231-233](extension/guard.js#L231-L233)).

##### Submit-button clicks

Ctrl, Shift or middle clicks on a submit button open the result in a new
tab. If no link is in the path, `onActivate` looks for a submit button and
blocks those ([guard.js:634-643](extension/guard.js#L634-L643)). It also
blocks a plain click on a `_blank` form whose submit event the guard cannot
hear (see the next item). For forms it can hear, the plain `_blank` case is
left to `onSubmit`, so validation and the page's handlers still run.

##### Shadow DOM: listen inside every `attachShadow` root

**Problem.** A window listener cannot see a link inside a closed shadow
root, because `composedPath` hides closed-tree nodes. Non-composed clicks and
all `submit` events never leave a shadow root.

**What it does.** `Element.prototype.attachShadow` is wrapped. After the
native call it adds capture `click`, `auxclick` and `submit` listeners to
the returned root, closed roots included, and records the root in
`listenedRoots` ([guard.js:666-675](extension/guard.js#L666-L675)).
`unheard(node)` is true when the node's root is neither its document nor a
listened root, for example a detached node or a declarative shadow root
built by the parser ([guard.js:444-447](extension/guard.js#L444-L447)).

**Why not the obvious way.** Declarative roots (`<template shadowrootmode>`)
never call `attachShadow`, so they stay unheard. The `click()`,
`dispatchEvent`, `requestSubmit` and submit-button paths cover them. Real
clicks inside a closed declarative root are invisible in the page and fall
to the background layer.

##### `.click()` and `dispatchEvent` on links no listener can see

**Problem.** A detached link (`createElement('a')`, `target=_blank`,
`.click()`) or one in a closed declarative shadow root fires a click that
never reaches the guard's listeners, but the browser still follows it.

**What it does.** `HTMLElement.prototype.click` and
`EventTarget.prototype.dispatchEvent` are wrapped. They act only when the
element is not connected or its root is unheard. Then they find the closest
link, let downloads through (unless a modifier is set), and block if the
target opens a new context ([guard.js:471-499](extension/guard.js#L471-L499)).
For dispatched `click` or `auxclick` events, Ctrl, Meta, Shift or
`button === 1` also count, and a block returns `false`, as for a cancelled
event. Connected elements in heard trees go to the native call, so the
listeners stay the single source of truth.

##### `form.submit()` and `requestSubmit()`

`form.submit()` fires no submit event, so its wrapper checks the form's
target directly, in every realm ([guard.js:448-456](extension/guard.js#L448-L456)).
`requestSubmit()` runs validation and a real submit event that the page's
handlers rely on, so its wrapper blocks only forms whose submit event the
guard cannot hear. Elsewhere the native call runs and `onSubmit` cancels the
navigation after the page's handlers ([guard.js:457-465](extension/guard.js#L457-L465)).
Test: "requestSubmit runs the site's submit handler" (exactly once, and no
tab).

##### Link targets, SVG links and `<area>`

`linkTarget` is `target`, else the first `<base target>` in the document
([guard.js:213-223](extension/guard.js#L213-L223)). It uses `??`, so a
present but empty `target=""` stays `_self` and does not fall through to
`<base>`. `isLink` matches `a[href], area[href]`, or an `<a>` with
`xlink:href` ([guard.js:228-230](extension/guard.js#L228-L230));
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
the caller can navigate ([guard.js:175-184](extension/guard.js#L175-L184)).
For `window.open`, a missing or empty name means `_blank`
([guard.js:201-202](extension/guard.js#L201-L202)). `toLower` is the saved
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
windows ([guard.js:148-173](extension/guard.js#L148-L173)). `isSandboxed`
treats origin `"null"` or a `sandbox` attribute on the frame element as
sandboxed.

**Why not the obvious way.** Matching any frame anywhere would let a
sandboxed frame "open into" a sibling. The browser refuses that and opens a
new tab. Counting cross-origin frames is unsafe too. Tests: "sandboxed frame
opens into a sibling", "window.open into named iframe works", "sibling
frame's window.open into it".

##### Fail closed on doubt

When the guard cannot tell where a named target leads, it treats it as a
new window. If the caller's window can't be read, a name counts as new
([guard.js:183](extension/guard.js#L183),
[guard.js:384-386](extension/guard.js#L384-L386)). If its top window can't
be read, no frame matches ([guard.js:150](extension/guard.js#L150)). A frame
whose name throws (another origin) never matches
([guard.js:155](extension/guard.js#L155)). The worst case is a same-tab
open being refused, never a new tab getting through.

##### Dangling-markup targets

A link or form target that contains a tab, CR or LF together with `<` is
treated by browsers as `_blank` (a dangling-markup defence). `cleanTarget`
does the same ([guard.js:217-222](extension/guard.js#L217-L222)).

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
([guard.js:285-292](extension/guard.js#L285-L292),
[guard.js:322-349](extension/guard.js#L322-L349)).

Exception: shadow roots the page attached before the guard was removed keep
the guard's capture `click`, `auxclick` and `submit` listeners. The
`attachShadow` wrapper adds them directly, not through `listen()`
([guard.js:666-675](extension/guard.js#L666-L675)), so they are not on the
undo list. They do nothing while the guard is not armed (`onActivate` and
`onSubmit` return at once, [guard.js:614](extension/guard.js#L614),
[guard.js:649](extension/guard.js#L649)) and work again if the site is added
later.

**Why not the obvious way.** A guard that is merely disabled and left in
place still changes identity, descriptors and stack traces, which sites and
anti-bot scripts notice. The test checks the page and its same-origin
frames, including one created during load: a sample of the patched methods
and accessors (`appendChild`, `append`, `insertAdjacentHTML`, `write`,
`open`, `click`, `dispatchEvent`, `attachShadow`, `submit`,
`requestSubmit`, the `innerHTML` setter and the `contentWindow` getter) is
native again, `window.open` is a data property and the marker is gone
([run.mjs:364-405](test/run.mjs#L364-L405)).

##### Undo restores only if the slot is still the guard's

`patch()` saves the previous descriptor. Its undo step restores it only if
the current `value`, `get` and `set` are all the ones the guard installed,
and deletes the property if there was none before
([guard.js:324-334](extension/guard.js#L324-L334)). A page that assigned its
own `window.open` during load keeps it after removal. That follows from the
check at [guard.js:329](extension/guard.js#L329) but is not tested: the test
"assigned window.open is the same object" assigns only after removal.

##### `state.removed` stops saved wrappers from reinstalling the guard

After removal, the page may still hold wrappers it saved during load, such
as `Node.prototype.appendChild`. Calling one sweeps frames, which would call
`install()` again. `uninstallAll()` sets `state.removed` first, and
`install()` returns at once while it is set. Only `arm()` clears it
([guard.js:84-85](extension/guard.js#L84-L85),
[guard.js:286](extension/guard.js#L286),
[guard.js:306](extension/guard.js#L306)). Test: "a saved wrapper doesn't
bring it back".

The control listeners are never put on the undo list, so a page that was
found unlisted can still be armed later when its site is added.

### Popup and options page

- **Toggle removes the covering entry.** On `app.example.com` covered by
  `example.com`, the popup says "(via example.com)" and the button removes
  `example.com` ([popup.js:17-28](extension/popup.js#L17-L28)).
- **Reload after a toggle,** because arming is one-way and a removal needs a
  fresh document ([popup.js:29-34](extension/popup.js#L29-L34)).
- **Non-web pages get no button.** `new URL("chrome://newtab").hostname` is
  `newtab`, which would add junk ([popup.js:5-15](extension/popup.js#L5-L15)).
- **`innerHTML` only gets normalised host names,** which match a strict
  pattern, so the status line is not an injection sink
  ([popup.js:23-25](extension/popup.js#L23-L25)).
- **Lenient input, strict storage.** The options page splits on newlines
  and commas, normalises, drops junk, de-duplicates and sorts, then shows
  back what was actually saved, so silent drops are visible
  ([options.js:9-17](extension/options.js#L9-L17),
  [lib.js:53-57](extension/lib.js#L53-L57)).
- **"Current domain" is the most recently used other web tab,** because the
  options page is itself the active tab
  ([options.js:19-25](extension/options.js#L19-L25)). "Add current" saves
  the textarea's current lines plus the domain, so unsaved edits are kept
  ([options.js:27-34](extension/options.js#L27-L34)).

### Testing techniques

#### A raw CDP driver wherever the extension closes tabs

Playwright attaches to every new target and pauses it until attached. When
the background closes that tab first, the opener page, which shares the
renderer process, can freeze mid-click. [cdp.mjs](test/cdp.mjs) talks to the
DevTools WebSocket directly, auto-attaches only to iframes, and records page
targets with created and destroyed times
([cdp.mjs:1-5](test/cdp.mjs#L1-L5), [cdp.mjs:53-58](test/cdp.mjs#L53-L58)).
Playwright drives the full extension, where no tab is ever created. The raw
driver covers the background-only layer, tab-under, cold worker, context
menu and popup chain runs.

#### Chrome on port 0

Chrome launches with `--remote-debugging-port=0` and a fresh profile. The
driver reads the chosen port from `<profile>/DevToolsActivePort`
([cdp.mjs:18-32](test/cdp.mjs#L18-L32)). Port 0 cannot collide with another
browser or a parallel run.

#### Timeouts everywhere

Every CDP call races a 10 s timer, and each case runs under 15 s. In
Playwright mode a stuck case closes all pages and continues
([cdp.mjs:46-50](test/cdp.mjs#L46-L50),
[run.mjs:214-228](test/run.mjs#L214-L228)). Tests of tab-killing code are
the ones most likely to hang.

#### Real, trusted input

`clickAt` sends `Input.dispatchMouseEvent` move, press and release with a
modifier bitmask and button masks. `click()` scrolls the element to the
centre and waits before measuring it
([cdp.mjs:161-178](test/cdp.mjs#L161-L178)). Synthetic DOM events are
untrusted and grant no user activation, so they would not exercise the
popup blocker or `arm.js`'s `isTrusted` checks on context-menu, `mousedown`
and `keydown` events ([arm.js:79](extension/arm.js#L79),
[arm.js:97](extension/arm.js#L97)). `clickIn` adds the frame's
border (`clientLeft`, `clientTop`) when clicking inside an iframe
([cdp.mjs:182-195](test/cdp.mjs#L182-L195)).

#### Running code in cross-origin frames with a user gesture

The driver tracks execution contexts per out-of-process iframe session and
evaluates in the right frame with `userGesture: true`
([cdp.mjs:198-212](test/cdp.mjs#L198-L212)). Without the gesture, the popup
blocker would stop `window.open` and the test would pass even without the
extension.

#### Finding the right service worker, and stopping it

Chrome's built-in extensions can also have a `background.js` worker.
`swTarget` asks each one for its manifest name and keeps "No New Tabs"
([cdp.mjs:82-95](test/cdp.mjs#L82-L95)). `stopSW` closes the worker target
to simulate Chrome's 30 s idle stop, and `wakeSW` opens and closes a
background tab to restart it ([cdp.mjs:110-122](test/cdp.mjs#L110-L122)).
Waiting 30 s per case is impractical, and a worker that is always warm hides
bugs in saving and restoring state.

#### `*.test` hosts for plain-http sites

`localhost` is a secure context even over http, so APIs missing on real
plain-http sites are present there. The Playwright browser launches with
`--host-resolver-rules=MAP *.test 127.0.0.1`
([run.mjs:28-30](test/run.mjs#L28-L30),
[run.mjs:176](test/run.mjs#L176)); the raw-CDP browser does not need it.
`insecureSite()` checks `listed.test` and `plain.test` with
`!isSecureContext` ([run.mjs:420-438](test/run.mjs#L420-L438)). No DNS or hosts-file changes
are needed.

#### One server, two origins

The same server is reached as `http://localhost:PORT` (listed) and
`http://127.0.0.1:PORT` (unlisted). Pages frame "the other host", so the
control run also tests a listed frame inside an unlisted page: cases named
"cross-origin …" must be blocked in both runs
([run.mjs:25-27](test/run.mjs#L25-L27),
[run.mjs:243-256](test/run.mjs#L243-L256)).

#### The "no flash" standard

In full-extension mode a case passes only if no tab was created at all,
not just closed, and the page is still on its starting URL (unless the case
leaves on purpose) ([run.mjs:243-256](test/run.mjs#L243-L256)). Checking
only survivors would pass even if every case relied on the background.

#### Background-only mode

`backgroundOnlyCopy()` copies the extension and deletes `content_scripts`
from the manifest, then the whole case table runs through the raw driver,
plus user tabs, tab-under, cold worker, listed frame in an unlisted page and
the popup chain ([run.mjs:46-55](test/run.mjs#L46-L55),
[run.mjs:729-739](test/run.mjs#L729-L739)).

#### Popup blocker off where it would hide the result

`liveArmNoInput` and `popupChain` run with `--disable-popup-blocking`
([run.mjs:726-739](test/run.mjs#L726-L739)). Otherwise a pass would only
reflect Chrome's own blocker.

#### Stable coordinates

The loaders wait for both cross-origin frames, for `document.fonts.ready`
(text reflows when fonts arrive), and 150 ms for `arm.js` to read the list
([run.mjs:204-212](test/run.mjs#L204-L212),
[run.mjs:537-545](test/run.mjs#L537-L545)). A click that lands on nothing
makes a blocking test pass for the wrong reason.

### Ad-script tricks seen in the wild and how each is defeated

Most of these come from ad scripts (PopAds, Adcash and others) seen on a
real streaming site. The rest are edge cases found while hardening the
guard. Each has a test case with the name shown, unless the Test column
says otherwise.

| Trick | How it is defeated | Test |
| --- | --- | --- |
| Plain `window.open(url)`, `window.open('')`, popup features | Guarded `open` returns `null`; empty name means `_blank` ([guard.js:375-394](extension/guard.js#L375-L394), [guard.js:201-202](extension/guard.js#L201-L202)) | "window.open()", "window.open('')", "popup window" |
| Save `window.open` at load, call later | Guard is installed before any page script, so the saved copy is the wrapper ([guard.js:402](extension/guard.js#L402)) | "window.open saved at load" |
| `document.open(url, name, features)` | Three-argument calls are checked like `window.open` ([guard.js:422-433](extension/guard.js#L422-L433)) | "document.open(3 args)" |
| Hidden `<iframe src="javascript:false">`, then `frame.contentWindow.open` | `contentWindow` getter and insertion wrappers adopt the frame first ([guard.js:512-571](extension/guard.js#L512-L571)) | "jsf iframe contentWindow.open" |
| PopAds minipop: `frames[n].open('about:blank', realUrlAsName, 'popup=1,width=5,height=5')`, then a script in the popup redirects to `name` | Input-time sweep adopts frames reached by index; the MutationObserver adopts parser-made frames; escaped popups are closed and marked `spawned` ([guard.js:575-587](extension/guard.js#L575-L587), [guard.js:677-682](extension/guard.js#L677-L682)) | "PopAds minipop (popup, about:blank)" |
| PopAds: keep the iframe's `contentWindow` from load time | `insertBefore`/`append` adopt before the reference can be saved ([guard.js:561-571](extension/guard.js#L561-L571)) | "PopAds saved contentWindow" |
| Adcash: `frame.open.bind(frame)` | The function bound is already the guarded wrapper | "Adcash bound iframe open" |
| Call the frame's `open` on the main window: `savedOpen.call(window, url)` | Wrapper judges from `this ?? win` and checks `state.armed` at call time ([guard.js:379-386](extension/guard.js#L379-L386)) | "iframe open saved, .call(window)" |
| `window.open = iframe.contentWindow.open` | Locked accessor returns `guarded(value)` for any native ([guard.js:403-417](extension/guard.js#L403-L417)) | "window.open = iframe's open" |
| Before input, make a hidden frame's native `open` the page's `window.open` | Parser-inserted frames are adopted before the next script; accessor guards natives | "window.open = frame's native, at load" |
| Plant a fake `__noNewTabsGuard` marker on a frame so the guard skips it | Adoption runs first: the MutationObserver adopts parser-inserted frames before the next script ([guard.js:575-587](extension/guard.js#L575-L587)), so the guard's own marker is already in place and a marker planted later changes nothing ([guard.js:335-341](extension/guard.js#L335-L341)) | "frame pre-marked as guarded" |
| `frames[name].open` on a frame made with `document.write` | `write` wrappers sweep afterwards; observer catches parser insertion ([guard.js:434-438](extension/guard.js#L434-L438)) | "frames[name].open, document.write" |
| `javascript:false` frame inside a closed shadow root (out of reach of `frames[n]`) | The `contentWindow` getter adopts the frame when the page reads it ([guard.js:512-531](extension/guard.js#L512-L531)) | "shadow-root jsf iframe" |
| `javascript:false` frame inside another one | `sweep()` recurses; each adopted realm wraps its own insertion methods | "nested jsf iframe" |
| Save a frame's `open` while the page is still parsing | MutationObserver runs before the next parser-inserted script | "open saved from a frame, while parsing" |
| Save a `src` frame's `open` from its initial `about:blank`, which Chrome reuses for the real document | Frame adopted on insert; its own guard backs off on the marker | "open saved before the frame loaded" |
| Detached `<a target=_blank>` plus `.click()` or `dispatchEvent` | `click`/`dispatchEvent` wrappers check unseen links ([guard.js:471-499](extension/guard.js#L471-L499)) | "detached link .click()", "detached link dispatchEvent" |
| `frames.x.HTMLFormElement.prototype.submit.call(mainForm)` | Every adopted realm's `submit` is wrapped ([guard.js:448-456](extension/guard.js#L448-L456)) | "form.submit from iframe realm" |
| `open('about:blank', '_self')` to blank the page | `inertUrl` blocks `about:` and `javascript:` in any target ([guard.js:186-200](extension/guard.js#L186-L200)) | "open('about:blank', '_self') blocked" |
| Tab-under: open, then move the listed tab away (`location`, `history.back()`, six redirects) or `window.close()` it | Background judges the opener at the moment of creation from recorded history; closed tabs remembered 30 s | "hidden-frame open, then leave", "… 6 redirects", "… history.back()", "… window.close()" |
| Listed iframe opens, then navigates away or is removed | Recorded parents and `left` times; walk the tree as it was ([background.js:184-214](extension/background.js#L184-L214)) | "listed iframe: open, then the frame leaves / is removed" |
| Popup that opens another popup from its load script | `spawned` set and pending verdicts ([background.js:218-226](extension/background.js#L218-L226)); with the full extension, `arm.js` in the popup is also told "listed" (untested) | "both windows closed" |
| Ask whether `window.open` is wrapped (`toString`, `name`, `length`) | Per-realm `toString` spoof; shorthand wrappers with copied `name`/`length` ([guard.js:354-365](extension/guard.js#L354-L365)) | "Function.prototype.toString looks native" |
| Replace `Set.prototype.has`, `Function.prototype.apply`, `composedPath`, iterators | Built-ins saved at startup, called through `Reflect.apply`, index loops only | (relied on throughout) |
| Retry `window.open` many times a second | Logging stops after 20 lines | (none) |
| `open(url, ' _self')`, `open(url, '   ')` | Untrimmed, browser-style name matching | "open(url, ' _self')", "open(url, '   ')" |
| Redefine `window.name` with a getter, then open "into" it | Native `name` getter ([guard.js:155](extension/guard.js#L155)) | "fake window.name, then open into it" |
| Sandboxed frame targets a sibling by name | Sandboxed callers search only their own subtree | "sandboxed frame opens into a sibling" |
| Page handler sets `target=_blank` or `<base target=_blank>` after the guard looked | `later()` looks again after the page's handlers | `target set by a page click handler`, `<base target> set by a click handler`, `form target set by a submit handler` |
| Links and forms in closed or declarative shadow roots, non-composed clicks | Listeners inside each `attachShadow` root; `unheard()` paths for declarative roots | "closed shadow root _blank link", "_blank form, declarative shadow root", ".click() in closed declarative shadow" |
| `document.open()` the whole page, then a `_blank` link | Listeners re-added after `open`/`write` | "_blank after document.open() of page" |
| Turn the page into a `blob:` copy, or a `blob:null` page via a sandboxed frame | `arm.js` checks `self.origin` (blob: copy) or asks the background for an opaque page (blob:null); the background inherits the previous site ([arm.js:44-50](extension/arm.js#L44-L50), [background.js:118-124](extension/background.js#L118-L124)) | "page turns itself into a blob: copy", "page becomes a blob:null page" |
| `_blank` links in a `data:` frame | Injected via `match_origin_as_fallback`; `ancestorOrigins` | "_blank link in a data: frame" |
| Use a no-script sandboxed frame's `open` or `form.submit` | Parent adopts it | "no-script sandbox frame's window.open", "… form.submit" |
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
  link inside a closed shadow root. A tab chosen from the menu more than 5
  minutes after the right-click is closed too.
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
  `window.open` before the guard does.
- **Closed shadow roots written straight into HTML**
  (`<template shadowrootmode="closed">`): a click on a `_blank` link inside
  one gets past the in-page guard.
- **A target changed late, in some ways** (from reading the code). A page
  handler that changes a link's or form's target and also stops
  propagation beats both of the guard's checks. So does a handler inside a
  shadow root that changes the target, because the late check listens on
  the window, which `submit` events and non-composed clicks never reach
  ([guard.js:638-656](extension/guard.js#L638-L656)).
- **A page capture listener could stop the arm signal** (from reading the
  code). The guard's control listeners are not capture listeners
  ([guard.js:124-127](extension/guard.js#L124-L127)), so a page listener on
  `window` for `__no_new_tabs_arm__` that calls `stopImmediatePropagation()`
  could keep the guard from arming.
- **Live arming of a page that was first found unlisted** (from reading the
  code). Natives the page saved while the guard was removed stay unguarded,
  and the reinstall reads globals the page may have replaced
  ([guard.js:130-136](extension/guard.js#L130-L136)). Reloading the tab
  after adding a site avoids this.
- **Sandboxed frames the guard can't recognise as sandboxed** (from reading
  the code). `isSandboxed` checks only the frame's own origin and its own
  `sandbox` attribute ([guard.js:167-173](extension/guard.js#L167-L173)). A
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
- **Context-menu items that are still closed on a listed site,** even
  though you chose them:
  - (Brave only) "Search for …" on text selected inside a PDF. Brave records
    the PDF viewer's frames like normal frames, so the PDF rule
    ([background.js:289-297](extension/background.js#L289-L297)) never
    fires.
- **Test coverage.** No test checks that a context-menu tab the user chose
  is kept: the suite only checks that a menu is reported, that it ends on
  the next click, and that it does not let a page-opened tab through. The
  history-pruning code (the 60 s `left` expiry and the 1000-entry cap,
  [background.js:127-147](extension/background.js#L127-L147)) has no direct
  test either.
