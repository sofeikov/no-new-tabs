// Pruning 60 s after a frame leaves (issue 15).
//
// A mutant that prunes history by commit age instead of by leave age
// passes the headless suite, but in a real browser it lets popups
// survive: an unlisted top page, a listed iframe loaded 65 s ago, a cold
// worker, and the top page sent away. These tests drive the SHIPPED
// background.js through a fake chrome API with controlled webNavigation
// timestamps and a virtual clock — no browser, no real waits.
//
//   node --test test/unit-prune.mjs
//   BG_PATH=/tmp/mut/background.js node --test test/unit-prune.mjs
//   (copy extension/lib.js and extension/match.js next to the mutant)
//
// The mutant these discriminate (applied to a /tmp copy, never committed):
// in the top-commit loop, `if (e.left == null) e.left = ...; else if
// (e.left < old) splice` becomes `if (e.t < old) splice`, and pruneDead
// drops its live-frame check.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness.mjs";

const TAB = 1;
const IFRAME = 7;
const UNLISTED = "http://127.0.0.1:8888/index.html";
const UNLISTED_OTHER = "http://127.0.0.1:8888/other.html";
const LISTED_IFRAME = "http://localhost:8888/if.html";
const LISTED_TARGET = "http://localhost:8888/target.html?case=prune";

const tab = { id: TAB, url: UNLISTED };
const topFrames = [{ frameId: 0, parentFrameId: -1, url: UNLISTED_OTHER }];

// Rows for a tab whose top page and listed iframe committed `old` ago.
const rowsWithOldIframe = (old) => ({
  [`h.${TAB}`]: { rows: [[0, -1, "127.0.0.1", old, 0], [IFRAME, 0, "localhost", old, 0]] },
});

const iframeRows = (sessionData) => (sessionData[`h.${TAB}`]?.rows ?? []).filter((r) => r[0] === IFRAME);

// A popup from the iframe, with the navigation source naming the frame
// (window.open from a listed frame on an unlisted page). Returns the
// background's verdict, "closed" or "kept"; a close must come from the
// navigation-source path (the top page is unlisted, so the no-source
// fallback would keep it).
async function popupFromIframe(bg, timeStamp) {
  bg.fireCreated({ id: 9, openerTabId: TAB });
  bg.fireNavTarget({ tabId: 9, sourceTabId: TAB, sourceFrameId: IFRAME, url: LISTED_TARGET, timeStamp });
  await bg.settle();
  const verdict = bg.verdict(9);
  if (verdict === "closed") assert.match(bg.why(9), /^opened by tab 1: http/, "closed through the navigation source");
  return verdict;
}

describe("pruning 60 s after a frame leaves (issue 15)", () => {
  it("a listed iframe loaded 65 s ago survives a later top commit and still blocks", async () => {
    const bg = await loadBackground({ tabs: [{ ...tab }], frames: { [TAB]: topFrames } });
    const old = Date.now() - 65_000;
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: old, transitionType: "link" });
    bg.fireCommitted({ tabId: TAB, frameId: IFRAME, parentFrameId: 0, url: LISTED_IFRAME, timeStamp: old, transitionType: "auto_subframe" });
    // A later top commit triggers the prune loop: the iframe left with the
    // old page, so its rows are stamped, not dropped.
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED_OTHER, timeStamp: Date.now(), transitionType: "link" });
    await bg.settle(700);
    const rows = iframeRows(bg.sessionData());
    assert.equal(rows.length, 1, `iframe rows kept, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0][2], "localhost");
    assert.equal(await popupFromIframe(bg, Date.now()), "closed", "popup from the listed iframe is closed");
  });

  it("leaving stamps rows, and 61 s later they are gone", async () => {
    const bg = await loadBackground({ tabs: [{ ...tab }], frames: { [TAB]: topFrames } });
    const old = Date.now() - 65_000;
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: old, transitionType: "link" });
    bg.fireCommitted({ tabId: TAB, frameId: IFRAME, parentFrameId: 0, url: LISTED_IFRAME, timeStamp: old, transitionType: "auto_subframe" });
    const left = Date.now();
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED_OTHER, timeStamp: left, transitionType: "link" });
    // Between leaving and the 60 s mark the popup is still judged by what
    // the frame was.
    assert.equal(await popupFromIframe(bg, left), "closed", "popup right after the frame leaves is closed");
    // 61 s after leaving, a new top commit splices the rows. It goes to a
    // different host so the commit itself is recorded (a same-host commit
    // changes nothing and schedules no save of its own).
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: "http://example.com/later.html", timeStamp: left + 61_000, transitionType: "link" });
    await bg.settle(700);
    assert.deepEqual(iframeRows(bg.sessionData()), [], "iframe rows pruned 61 s after leaving");
  });

  it("cold worker: restored rows still block", async () => {
    const old = Date.now() - 65_000;
    const bg = await loadBackground({
      tabs: [{ ...tab }],
      frames: { [TAB]: topFrames },
      session: rowsWithOldIframe(old),
    });
    await bg.settle(700);
    assert.equal(iframeRows(bg.sessionData()).length, 1, "restored iframe rows kept");
    assert.equal(await popupFromIframe(bg, Date.now()), "closed", "popup from the restored listed iframe is closed");
  });

  it("pruneDead drops only old rows of gone frames", async () => {
    const old = Date.now() - 65_000;
    const recent = Date.now() - 30_000;
    // Seed the session so the restore path finds a top row and schedules no
    // save of its own: the first debounced save (and its pruneDead run)
    // must see the 200+ rows below. pruneDead only looks at tabs with at
    // least PRUNE_MIN_ENTRIES rows.
    const bg = await loadBackground({
      tabs: [{ ...tab }],
      frames: { [TAB]: [...topFrames, { frameId: 999, parentFrameId: 0, url: LISTED_IFRAME }] },
      session: { [`h.${TAB}`]: { rows: [[0, -1, "127.0.0.1", old, 0]] } },
    });
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: recent, transitionType: "link" });
    for (let f = 10; f < 214; f++) {
      bg.fireCommitted({ tabId: TAB, frameId: f, parentFrameId: 0, url: `http://localhost:8888/f${f}.html`, timeStamp: old, transitionType: "auto_subframe" });
    }
    bg.fireCommitted({ tabId: TAB, frameId: 999, parentFrameId: 0, url: LISTED_IFRAME, timeStamp: old, transitionType: "auto_subframe" });
    bg.fireCommitted({ tabId: TAB, frameId: 1000, parentFrameId: 0, url: LISTED_IFRAME, timeStamp: recent, transitionType: "auto_subframe" });
    await bg.settle(800);
    const rows = bg.sessionData()[`h.${TAB}`]?.rows ?? [];
    const has = (f) => rows.some((r) => r[0] === f);
    assert.equal(has(10), false, "old rows of a gone frame are pruned");
    assert.equal(has(213), false, "old rows of a gone frame are pruned");
    assert.equal(has(999), true, "old rows of a live frame are kept");
    assert.equal(has(1000), true, "recent rows of a gone frame are kept");
    assert.equal(has(0), true, "top-frame rows are kept");
  });
});
