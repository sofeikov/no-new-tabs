// Background worker state and decisions: what is saved after a same-site
// top navigation, rows of tabs whose frames cannot be read, one frame
// snapshot per no-source decision, the history cap, and site rules with
// "*" and exceptions.
//
// Same harness as unit-prune.mjs: the SHIPPED background.js with a fake
// chrome API and controlled webNavigation timestamps, no browser.
//
//   node --test test/unit-background.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness.mjs";

const TAB = 1;
const IFRAME = 7;
const UNLISTED = "http://127.0.0.1:8888/index.html";
const UNLISTED_OTHER = "http://127.0.0.1:8888/other.html"; // same site as UNLISTED
const LISTED = "http://localhost:8888/index.html";
const LISTED_IFRAME = "http://localhost:8888/if.html";
const LISTED_TARGET = "http://localhost:8888/target.html?case=bg";
const frame0 = (url) => ({ frameId: 0, parentFrameId: -1, url });

const rowsOf = (bg, tab = TAB) => bg.sessionData()[`h.${tab}`]?.rows ?? [];

// A popup whose navigation source names the frame. Returns the popup id
// when kept, undefined when closed.
async function popupFrom(bg, id, frameId, timeStamp = Date.now()) {
  bg.fireCreated({ id, openerTabId: TAB });
  bg.fireNavTarget({ tabId: id, sourceTabId: TAB, sourceFrameId: frameId, url: LISTED_TARGET, timeStamp });
  await bg.settle();
  return bg.removedTabs().includes(id) ? undefined : id;
}

// A popup with no navigation source (window.open from a frame that never
// committed): the opener's page is judged.
async function popupNoSource(bg, id) {
  bg.fireCreated({ id, openerTabId: TAB });
  await bg.settle();
  return bg.removedTabs().includes(id) ? undefined : id;
}

describe("background state", () => {
  it("a same-site top navigation saves the 'left' stamps it writes", async () => {
    const bg = await loadBackground({ tabs: [{ id: TAB, url: UNLISTED }], frames: { [TAB]: [frame0(UNLISTED)] } });
    const old = Date.now() - 65_000;
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: old, transitionType: "link" });
    bg.fireCommitted({ tabId: TAB, frameId: IFRAME, parentFrameId: 0, url: LISTED_IFRAME, timeStamp: old, transitionType: "auto_subframe" });
    await bg.settle(700); // the iframe row is saved, not yet left
    const before = rowsOf(bg).find((r) => r[0] === IFRAME);
    assert.equal(before?.[4], 0, `iframe row saved before leaving, got ${JSON.stringify(before)}`);
    // Same host: the commit records nothing new, but its page's frames left.
    const left = Date.now();
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED_OTHER, timeStamp: left, transitionType: "link" });
    await bg.settle(700);
    const after = rowsOf(bg).find((r) => r[0] === IFRAME);
    assert.equal(after?.[4], left, `the stamp is saved, got ${JSON.stringify(after)}`);
    // The frame left within the minute: a popup from it is still closed.
    assert.equal(await popupFrom(bg, 9, IFRAME, left), undefined, "popup from the left listed iframe is closed");
  });

  it("rows of a tab whose frames cannot be read are not pruned", async () => {
    const old = Date.now() - 65_000;
    const recent = Date.now() - 30_000;
    // getAllFrames rejects for this tab (Chrome: an invalid or closed tab).
    const frames = {};
    Object.defineProperty(frames, TAB, { enumerable: true, get() { throw new Error(`No tab with id: ${TAB}`); } });
    // Seeded so the restore schedules no save of its own: the first save
    // (and its pruneDead run) sees the 200+ rows below.
    const bg = await loadBackground({
      tabs: [{ id: TAB, url: UNLISTED }],
      frames,
      session: { [`h.${TAB}`]: { rows: [[0, -1, "127.0.0.1", old, 0]] } },
    });
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: recent, transitionType: "link" });
    for (let f = 10; f < 214; f++) {
      bg.fireCommitted({ tabId: TAB, frameId: f, parentFrameId: 0, url: `http://example.com:8888/f${f}.html`, timeStamp: old, transitionType: "auto_subframe" });
    }
    bg.fireCommitted({ tabId: TAB, frameId: 999, parentFrameId: 0, url: LISTED_IFRAME, timeStamp: old, transitionType: "auto_subframe" });
    await bg.settle(800);
    const rows = rowsOf(bg);
    assert.equal(rows.some((r) => r[0] === 999), true, "the old listed iframe row is kept");
    assert.equal(rows.some((r) => r[0] === 10), true, "old rows are kept while frames are unknown");
    assert.equal(await popupFrom(bg, 9, 999), undefined, "popup from the listed iframe is closed");
  });

  it("a no-source decision on a restored page reads frames at most twice", async () => {
    const live = [frame0(UNLISTED), ...[5, 6, 7, 8].map((frameId) => ({ frameId, parentFrameId: 0, url: `http://example.com:8888/f${frameId}.html` }))];
    let reads = 0;
    const frames = new Proxy({ [TAB]: live }, {
      get(target, key) {
        if (key === String(TAB)) reads++;
        return target[key];
      },
    });
    const bg = await loadBackground({ tabs: [{ id: TAB, url: UNLISTED }], frames });
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: Date.now(), transitionType: "link" });
    await bg.settle(300);
    reads = 0;
    // Restored from the back/forward cache, and a popup at once: the
    // subframe rows the restore records come after the popup's moment, so
    // the decision walks each frame from where it sits now.
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: Date.now(), transitionType: "link", transitionQualifiers: ["forward_back"] });
    assert.equal(await popupNoSource(bg, 9), 9, "popup from the unlisted restored page is kept");
    // One read for the restore's refresh, one shared by the frame walk, one
    // final live look. Before the shared snapshot: one per frame.
    assert.ok(reads <= 3, `getAllFrames calls: ${reads}`);
  });

  it("1000 changes of site trim the top-frame history and fail closed", async () => {
    const bg = await loadBackground({ tabs: [{ id: TAB, url: UNLISTED }], frames: { [TAB]: [frame0(UNLISTED)] } });
    const t = Date.now();
    for (let i = 0; i <= 1001; i++) {
      bg.fireCommitted({ tabId: TAB, frameId: 0, url: i % 2 ? UNLISTED : `http://example.com:8888/${i}`, timeStamp: t + i, transitionType: "link" });
    }
    await bg.settle(700);
    const data = bg.sessionData();
    assert.equal(data[`h.${TAB}`].rows.length, 1000, "rows capped at 1000");
    assert.deepEqual(data.trimmed, [TAB], "the tab is marked trimmed");
  });
});

describe("site rules in the background: '*' and exceptions", () => {
  const sync = { domains: ["*", "!127.0.0.1"] };

  it("a page on an excepted host keeps its popups", async () => {
    const bg = await loadBackground({ sync, tabs: [{ id: TAB, url: UNLISTED }], frames: { [TAB]: [frame0(UNLISTED)] } });
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: Date.now(), transitionType: "link" });
    assert.equal(await popupFrom(bg, 9, 0), 9, "popup from the excepted page is kept");
    assert.equal(await popupNoSource(bg, 10), 10, "no-source popup from the excepted page is kept");
  });

  it("'*' lists every other host", async () => {
    const other = "http://example.com:8888/index.html";
    const bg = await loadBackground({ sync, tabs: [{ id: TAB, url: other }], frames: { [TAB]: [frame0(other)] } });
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: other, timeStamp: Date.now(), transitionType: "link" });
    assert.equal(await popupFrom(bg, 9, 0), undefined, "popup from a page '*' covers is closed");
    assert.equal(await popupNoSource(bg, 10), undefined, "no-source popup from it is closed");
  });

  it("an excepted iframe in a listed page is still guarded by its parent", async () => {
    const bg = await loadBackground({ sync, tabs: [{ id: TAB, url: LISTED }], frames: { [TAB]: [frame0(LISTED)] } });
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: LISTED, timeStamp: Date.now(), transitionType: "link" });
    bg.fireCommitted({ tabId: TAB, frameId: IFRAME, parentFrameId: 0, url: UNLISTED, timeStamp: Date.now(), transitionType: "auto_subframe" });
    assert.equal(await popupFrom(bg, 9, IFRAME), undefined, "popup from the excepted iframe is closed");
  });

  it("a listed iframe in an excepted page is guarded", async () => {
    const bg = await loadBackground({ sync, tabs: [{ id: TAB, url: UNLISTED }], frames: { [TAB]: [frame0(UNLISTED)] } });
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: Date.now(), transitionType: "link" });
    bg.fireCommitted({ tabId: TAB, frameId: IFRAME, parentFrameId: 0, url: LISTED_IFRAME, timeStamp: Date.now(), transitionType: "auto_subframe" });
    assert.equal(await popupFrom(bg, 9, IFRAME), undefined, "popup from the listed iframe is closed");
    assert.equal(await popupFrom(bg, 10, 0), 10, "popup from the excepted top page is kept");
  });

  it("an exception-only list lists nothing", async () => {
    const bg = await loadBackground({ sync: { domains: ["!127.0.0.1"] }, tabs: [{ id: TAB, url: LISTED }], frames: { [TAB]: [frame0(LISTED)] } });
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: LISTED, timeStamp: Date.now(), transitionType: "link" });
    assert.equal(await popupFrom(bg, 9, 0), 9, "popup is kept");
  });
});

// Pinned by the mutation runner (test/mutants.mjs): each of these fails on
// a mutant the older tests let through.
describe("mutation-found gaps", () => {
  it("the minute prune keeps a row that left recently even if it loaded over 60 s ago (200+ rows)", async () => {
  const old = Date.now() - 65_000;
  // A saved top row: the restore schedules no save, so the first save's
  // pruneDead run comes after the rows below.
  const bg = await loadBackground({ tabs: [{ id: TAB, url: UNLISTED }], frames: { [TAB]: [{ frameId: 0, parentFrameId: -1, url: UNLISTED_OTHER }] },
    session: { [`h.${TAB}`]: { rows: [[0, -1, "127.0.0.1", old, 0]] } } });
  bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: old, transitionType: "link" });
  for (let f = 10; f < 214; f++) bg.fireCommitted({ tabId: TAB, frameId: f, parentFrameId: 0, url: `http://127.0.0.1:8888/f${f}.html`, timeStamp: old, transitionType: "auto_subframe" });
  bg.fireCommitted({ tabId: TAB, frameId: IFRAME, parentFrameId: 0, url: LISTED_IFRAME, timeStamp: old, transitionType: "auto_subframe" });
  bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED_OTHER, timeStamp: Date.now(), transitionType: "link" });
  await bg.settle(700);
  assert.equal((bg.sessionData()[`h.${TAB}`]?.rows ?? []).filter((r) => r[0] === IFRAME).length, 1, "iframe row kept");
  bg.fireCreated({ id: 9, openerTabId: TAB });
  bg.fireNavTarget({ tabId: 9, sourceTabId: TAB, sourceFrameId: IFRAME, url: LISTED_TARGET, timeStamp: Date.now() });
  await bg.settle();
  assert.equal(bg.verdict(9), "closed");
});

  it("a late navigation event is judged at the creation moment, after the frame navigated away", async () => {
  const bg = await loadBackground({ tabs: [{ id: TAB, url: UNLISTED }], frames: { [TAB]: [{ frameId: 0, parentFrameId: -1, url: UNLISTED }] } });
  const t0 = Date.now() - 1000;
  bg.fireCommitted({ tabId: TAB, frameId: 0, url: UNLISTED, timeStamp: t0, transitionType: "link" });
  bg.fireCommitted({ tabId: TAB, frameId: IFRAME, parentFrameId: 0, url: LISTED_IFRAME, timeStamp: t0, transitionType: "auto_subframe" });
  bg.fireCreated({ id: 9, openerTabId: TAB, url: LISTED_TARGET });
  await bg.settle(300);
  // The listed iframe sends itself to an unlisted page, then the late event arrives.
  bg.fireCommitted({ tabId: TAB, frameId: IFRAME, parentFrameId: 0, url: UNLISTED_OTHER, timeStamp: Date.now(), transitionType: "auto_subframe" });
  await bg.settle(10);
  bg.fireNavTarget({ tabId: 9, sourceTabId: TAB, sourceFrameId: IFRAME, url: LISTED_TARGET, timeStamp: Date.now() });
  await bg.settle(4500);
  assert.deepEqual(bg.removedTabs(), [9]);
});
});
