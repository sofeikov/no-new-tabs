// Background fallbacks the headless suite only covers by simulation
// (issue 15): a vanished frame falling back to the top frame, the baseline
// for tabs open before the worker started, the moment a late navigation
// event is judged at, and a re-commit after a back/forward restore.
//
// Same harness as the pruning tests: the shipped background.js with a
// fake chrome API, controlled webNavigation timestamps, no browser.
//
//   node --test test/unit-fallbacks.mjs
//   BG_PRUNE_PATH=/tmp/mutant-bg2.js node --test test/unit-fallbacks.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness.mjs";

const TAB = 1;
const LISTED = "http://localhost:8888/index.html";
const LISTED_TARGET = "http://localhost:8888/target.html?case=fallback";
const UNLISTED = "http://127.0.0.1:8888/index.html";
const frame0 = (url) => ({ frameId: 0, parentFrameId: -1, url });

// A popup with no address of its own (window.open from script). With no
// navigation source the background judges the opener's top page.
async function popupNoSource(bg, id) {
  bg.fireCreated({ id, openerTabId: TAB });
  await bg.settle();
  return bg.removedTabs().includes(id) ? undefined : id;
}

describe("background fallbacks (issue 15)", () => {
  it("a vanished frame falls back to the top frame", async () => {
    const bg = await loadBackground({
      tabs: [{ id: TAB, url: LISTED }],
      frames: { [TAB]: [frame0(LISTED)] }, // frame 99 below is gone without a trace
    });
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: LISTED, timeStamp: Date.now(), transitionType: "link" });
    bg.fireCreated({ id: 9, openerTabId: TAB });
    // The opener frame never committed anything, so no navigation source
    // names it — yet its page was listed, so the popup is closed.
    bg.fireNavTarget({ tabId: 9, sourceTabId: TAB, sourceFrameId: 99, url: LISTED_TARGET, timeStamp: Date.now() });
    await bg.settle();
    assert.deepEqual(bg.removedTabs(), [9], "popup from a vanished listed frame is closed");
  });

  it("tabs open before the worker started are judged from the first commit on", async () => {
    const bg = await loadBackground({
      tabs: [{ id: TAB, url: UNLISTED }],
      frames: { [TAB]: [frame0(UNLISTED)] },
      session: {}, // cleared, as an extension reload does: no saved rows
    });
    // Moments before the first top commit are unknown: taken as listed,
    // even though the tab shows an unlisted page.
    assert.equal(await popupNoSource(bg, 9), undefined, "popup before the first commit is closed");
    // The first commit ends the unknown window: judged normally after.
    const now = Date.now();
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: now, transitionType: "link" });
    assert.equal(await popupNoSource(bg, 10), 10, "popup on the unlisted page is kept");
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: LISTED, timeStamp: now, transitionType: "link" });
    assert.equal(await popupNoSource(bg, 11), undefined, "popup after navigating to the listed site is closed");
  });

  it("a late navigation event is judged at the creation moment", async () => {
    const bg = await loadBackground({
      tabs: [{ id: TAB, url: UNLISTED }],
      frames: { [TAB]: [frame0(UNLISTED)] },
    });
    const old = Date.now() - 65_000;
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: old, transitionType: "link" });
    bg.fireCommitted({ tabId: TAB, frameId: 7, parentFrameId: 0, url: LISTED, timeStamp: old, transitionType: "auto_subframe" });
    // A tab that already has an address waits for its first commit, so the
    // first decision takes seconds — while it is in flight, the late event
    // names the listed frame the tab came from.
    bg.fireCreated({ id: 9, openerTabId: TAB, url: LISTED_TARGET });
    await bg.settle(300);
    assert.deepEqual(bg.removedTabs(), [], "popup is undecided while its first commit is awaited");
    bg.fireNavTarget({ tabId: 9, sourceTabId: TAB, sourceFrameId: 7, url: LISTED_TARGET, timeStamp: Date.now() });
    // The re-decision judges the tab at its creation moment: closed, even
    // though the first decision (no commit ever comes) would keep it.
    await bg.settle(4500);
    assert.deepEqual(bg.removedTabs(), [9], "late navigation event still closes the popup");
  });

  it("a back/forward re-commit records live subframes for the no-source fallback", async () => {
    const live = [frame0(UNLISTED), { frameId: 5, parentFrameId: 0, url: LISTED }];
    const frames = { [TAB]: live };
    const bg = await loadBackground({ tabs: [{ id: TAB, url: UNLISTED }], frames });
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: Date.now(), transitionType: "link" });
    // Restored from the back/forward cache: subframes never re-commit, so
    // the background records what is live now.
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: Date.now(), transitionType: "link", transitionQualifiers: ["forward_back"] });
    await bg.settle(700);
    // The frame is gone again by the time the popup opens, but its rows
    // say it was listed.
    frames[TAB] = [frame0(UNLISTED)];
    assert.equal(await popupNoSource(bg, 9), undefined, "popup is judged by the restored listed frame");
  });
});
