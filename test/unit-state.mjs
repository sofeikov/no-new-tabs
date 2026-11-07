// Background state paths no other test reaches: closed tabs forgotten
// 30 s later, popup chains, the 1000-row cap and `trimmed`, a failed save,
// the context-menu record, the inListedTab reply, a domain-list change and
// a failed restore.
//
// Same harness as the pruning tests: the shipped background.js with a fake
// chrome API and a virtual clock, so the 30 s, 31 s and 60 s waits cost no
// wall time. The tests check what a user or arm.js can observe — which tabs
// are closed and why, what is saved, what the background replies — not
// internal maps, so they hold across refactors of background.js.
//
//   node --test test/unit-state.mjs
//   BG_PATH=/tmp/mut/background.js node --test test/unit-state.mjs
//   (copy extension/lib.js and extension/match.js next to the mutant)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness.mjs";

const TAB = 1;
const LISTED = "http://localhost:8888/index.html";
const LISTED_TARGET = "http://localhost:8888/target.html?case=state";
const UNLISTED = "http://127.0.0.1:8888/index.html";
const OTHER = "http://example.com/other.html";
const SEARCH_URL = "https://www.google.com/search?q=attack+words+here";

const top = (bg, tabId, url, extra = {}) =>
  bg.fireCommitted({ tabId, frameId: 0, url, transitionType: "link", ...extra });
const rows = (bg, tabId) => bg.sessionData()[`h.${tabId}`]?.rows;

// A popup with no address of its own (window.open from script).
async function popupNoSource(bg, id, openerTabId = TAB) {
  bg.fireCreated({ id, openerTabId });
  await bg.settle();
  return bg.verdict(id);
}

// A popup whose navigation source names the opener frame.
async function popupFrom(bg, id, sourceTabId, { frameId = 0, url = LISTED_TARGET, timeStamp } = {}) {
  bg.fireCreated({ id, openerTabId: sourceTabId });
  bg.fireNavTarget({ tabId: id, sourceTabId, sourceFrameId: frameId, url, ...(timeStamp != null ? { timeStamp } : {}) });
  await bg.settle();
  return bg.verdict(id);
}

describe("closed tabs are forgotten 30 s later", () => {
  it("cold worker: a tab closed over 30 s ago is dropped at restore, a recent one kept", async () => {
    const now = Date.now();
    const bg = await loadBackground({
      tabs: [{ id: TAB, url: UNLISTED }],
      session: {
        "h.1": { rows: [[0, -1, "127.0.0.1", now - 50_000, 0]] },
        "h.8": { rows: [[0, -1, "localhost", now - 40_000, 0]] },
        "h.9": { rows: [[0, -1, "localhost", now - 40_000, 0]] },
        spawned: [8, 9],
        gone: { 8: now - 20_000, 9: now - 31_000 },
      },
    });
    const data = bg.sessionData();
    assert.equal("9" in (data.gone ?? {}), false, "the tab closed 31 s ago is forgotten");
    assert.equal((data.spawned ?? []).includes(9), false);
    assert.ok(data["h.8"], "rows of the tab closed 20 s ago are kept");
    assert.ok("8" in data.gone);
    assert.ok(data["h.1"], "rows of an open tab are kept");
    // Still remembered: a popup from tab 8 (spawned) is closed. Tab 9 is
    // forgotten, so its popup is judged like any unknown tab's.
    assert.equal(await popupNoSource(bg, 20, 8), "closed");
    assert.match(bg.why(20), /opened by tab 8 \(no navigation source\)/);
    assert.equal(await popupNoSource(bg, 21, 9), "kept");
  });

  // The restore's forgetGone() drops the tab from memory; its saved
  // h.<id> key must go too, or it is restored on every later cold start.
  it("cold worker: the saved rows of a tab closed over 30 s ago are removed", async () => {
    const now = Date.now();
    const bg = await loadBackground({
      session: { "h.9": { rows: [[0, -1, "localhost", now - 40_000, 0]] }, gone: { 9: now - 31_000 } },
    });
    await bg.settle();
    assert.equal(bg.sessionData()["h.9"], undefined);
  });

  it("warm worker: a closed listed tab still judges popups for 30 s, then is forgotten", async () => {
    const bg = await loadBackground({ tabs: [{ id: TAB, url: LISTED }] });
    top(bg, TAB, LISTED);
    await bg.settle();
    assert.ok(rows(bg, TAB), "history saved");
    // window.close() tab-under: the opener is gone before its popup is judged.
    const closedAt = Date.now();
    bg.closeTab(TAB);
    await bg.settle(29_000);
    assert.ok(String(TAB) in bg.sessionData().gone, "closed tab recorded");
    assert.equal(await popupFrom(bg, 9, TAB, { timeStamp: closedAt - 10 }), "closed", "popup of the closed listed tab is closed");
    assert.match(bg.why(9), /^opened by tab 1: http/);
    // 31 s after the close the background re-saves (debounced) and
    // forgets the tab.
    await bg.settle(closedAt + 31_000 - Date.now() - 1);
    assert.ok(rows(bg, TAB), "rows still saved just before the 31 s re-save");
    await bg.settle(1 + 150);
    const data = bg.sessionData();
    assert.equal(rows(bg, TAB), undefined, "rows removed 31 s after the close");
    assert.equal(String(TAB) in data.gone, false);
    // The blocked popup was closed too (at ~29.5 s); 31 s after that its
    // spawned record goes the same way.
    assert.ok(data.spawned.includes(9));
    await bg.settle(30_000);
    assert.equal(bg.sessionData().spawned.includes(9), false, "spawned record forgotten");
    assert.deepEqual(bg.sessionData().gone, {});
  });
});

describe("whatever a closed popup opens is closed too", () => {
  it("warm: a blocked popup's own popups are closed, though it shows an unlisted page", async () => {
    const bg = await loadBackground({ tabs: [{ id: TAB, url: LISTED }] });
    top(bg, TAB, LISTED);
    assert.equal(await popupNoSource(bg, 9), "closed");
    assert.ok(bg.sessionData().spawned.includes(9), "spawned saved");
    // The popup got as far as an unlisted ad page before it went.
    top(bg, 9, OTHER);
    assert.equal(await popupFrom(bg, 10, 9, { url: OTHER }), "closed");
    assert.match(bg.why(10), /^opened by tab 9: http/);
    assert.equal(await popupNoSource(bg, 11, 9), "closed");
    assert.match(bg.why(11), /opened by tab 9 \(no navigation source\)/);
  });

  it("cold: the spawned list is restored", async () => {
    const session = { "h.9": { rows: [[0, -1, "example.com", Date.now() - 1000, 0]] } };
    const tabs = [{ id: 9, url: OTHER }];
    const bg = await loadBackground({ tabs, session: { ...session, spawned: [9] } });
    assert.equal(await popupNoSource(bg, 10, 9), "closed");
    // Control: the same unlisted tab without the record opens freely.
    const ctl = await loadBackground({ tabs, session });
    assert.equal(await popupNoSource(ctl, 10, 9), "kept");
  });
});

describe("the 1000-row cap fails closed", () => {
  it("drops sub-frame rows first, then the oldest top row, and marks the tab trimmed", async () => {
    const t0 = Date.now() - 1000;
    const bg = await loadBackground({
      tabs: [{ id: TAB, url: UNLISTED }],
      session: { "h.1": { rows: [[0, -1, "127.0.0.1", t0, 0]] } },
    });
    bg.fireCommitted({ tabId: TAB, frameId: 5, parentFrameId: 0, url: LISTED, transitionType: "auto_subframe" });
    // 999 changes of site in the top frame: 1 + 1 + 999 = 1001 rows.
    let k = 0;
    const next = () => top(bg, TAB, k++ % 2 ? UNLISTED : OTHER);
    while (k < 999) next();
    await bg.settle();
    let saved = rows(bg, TAB);
    assert.equal(saved.length, 1000);
    assert.equal(saved.some((r) => r[0] === 5), false, "the sub-frame row went first");
    assert.deepEqual(saved[0].slice(0, 4), [0, -1, "127.0.0.1", t0], "the oldest top row is still there");
    assert.equal((bg.sessionData().trimmed ?? []).includes(TAB), false, "not trimmed yet");
    next();
    await bg.settle();
    saved = rows(bg, TAB);
    assert.equal(saved.length, 1000);
    assert.notDeepEqual(saved[0].slice(0, 4), [0, -1, "127.0.0.1", t0], "the oldest top row went next");
    assert.ok(bg.sessionData().trimmed.includes(TAB), "tab marked trimmed");
  });

  it("a trimmed tab counts as listed before its oldest surviving row", async () => {
    const T = Date.now();
    const session = { "h.1": { rows: [[0, -1, "127.0.0.1", T, 0]] } };
    const tabs = [{ id: TAB, url: UNLISTED }];
    // The navigation event says the popup was opened 10 s before the oldest
    // row we still have: what the tab showed then is unknown.
    const bg = await loadBackground({ tabs, session: { ...session, trimmed: [TAB] } });
    assert.equal(await popupFrom(bg, 9, TAB, { timeStamp: T - 10_000 }), "closed");
    assert.match(bg.why(9), /^opened by tab 1: http/);
    // Control: untrimmed, the tab's current unlisted page decides.
    const ctl = await loadBackground({ tabs, session });
    assert.equal(await popupFrom(ctl, 9, TAB, { timeStamp: T - 10_000 }), "kept");
  });
});

describe("a failed save never leaves an old record behind", () => {
  it("removes the saved history when a write fails, and writes it again later", async () => {
    const bg = await loadBackground({ tabs: [{ id: TAB, url: LISTED }] });
    top(bg, TAB, LISTED);
    bg.fireCommitted({ tabId: TAB, frameId: 0, url: "about:blank", transitionType: "link", transitionQualifiers: ["forward_back"] });
    await bg.settle();
    assert.ok(rows(bg, TAB));
    assert.ok("restoredTabs" in bg.sessionData());
    bg.failNext("session.set");
    top(bg, TAB, OTHER);
    await bg.settle();
    const data = bg.sessionData();
    for (const key of ["h.1", "trimmed", "restoredTabs"]) assert.equal(key in data, false, `${key} removed`);
    assert.ok(bg.warnings().some((w) => /could not save history/.test(w)), "the failure is logged");
    // Memory still has every row: the next save writes them all again.
    top(bg, TAB, UNLISTED);
    await bg.settle();
    assert.deepEqual(rows(bg, TAB).map((r) => r[2]), ["localhost", "example.com", "127.0.0.1"]);
  });

  it("writes every tab's rows and the trimmed flag again, not only the tab that changed", async () => {
    const t = Date.now() - 5_000;
    const bg = await loadBackground({
      tabs: [{ id: TAB, url: LISTED }, { id: 2, url: UNLISTED }],
      session: { "h.2": { rows: [[0, -1, "127.0.0.1", t, 0]] }, trimmed: [2] },
    });
    top(bg, TAB, LISTED);
    await bg.settle();
    bg.failNext("session.set");
    top(bg, TAB, OTHER);
    await bg.settle();
    assert.equal("h.2" in bg.sessionData(), false, "removed by the failure cleanup");
    // Only tab 1 changes after the failure; tab 2's rows and its
    // fail-closed flag must come back with the next save anyway.
    top(bg, TAB, UNLISTED);
    await bg.settle();
    const data = bg.sessionData();
    assert.ok(data["h.2"]?.rows?.length, "tab 2's rows written again");
    assert.ok((data.trimmed ?? []).includes(2), "trimmed written again");
  });
});

describe("the context-menu record", () => {
  // The user picks "Search for ..." on the listed tab: a browser-made tab
  // with an address, and a navigation event naming the listed top frame.
  const menu = (bg, msg = {}) => bg.sendMessage({ type: "contextMenu", selection: "attack words here", srcs: [], ...msg }, { tab: { id: TAB, url: LISTED } });
  const menuTab = (bg, id, url = SEARCH_URL) => {
    bg.fireCreated({ id, openerTabId: TAB, pendingUrl: url });
    bg.fireNavTarget({ tabId: id, sourceTabId: TAB, sourceFrameId: 0, url });
  };
  const listedTab = async () => {
    const bg = await loadBackground({ tabs: [{ id: TAB, url: LISTED }] });
    top(bg, TAB, LISTED);
    await bg.settle();
    return bg;
  };

  it("keeps one tab the menu offered, saved at once, then closes the next", async () => {
    const bg = await listedTab();
    await menu(bg);
    await bg.advance(0); // no debounce: the record is written at once
    assert.ok(bg.sessionData().menus?.[TAB], "menu record saved");
    menuTab(bg, 9);
    await bg.settle();
    assert.equal(bg.verdict(9), "kept");
    assert.match(bg.why(9), /chosen from a context menu/);
    assert.equal(TAB in (bg.sessionData().menus ?? {}), false, "record used up");
    menuTab(bg, 10);
    await bg.settle();
    assert.equal(bg.verdict(10), "closed", "one tab per menu");
  });

  it("closes a tab the menu did not offer", async () => {
    const bg = await listedTab();
    await menu(bg);
    menuTab(bg, 9, LISTED_TARGET);
    await bg.settle();
    assert.equal(bg.verdict(9), "closed");
  });

  it("lasts 30 s", async () => {
    const bg = await listedTab();
    await menu(bg);
    await bg.settle(29_000);
    menuTab(bg, 9);
    await bg.settle();
    assert.equal(bg.verdict(9), "kept", "29 s after the menu");
    await menu(bg);
    await bg.settle(30_000);
    menuTab(bg, 10);
    await bg.settle();
    assert.equal(bg.verdict(10), "closed", "30 s after the menu");
  });

  it("is void after a synthetic activation, even one during the 50 ms re-check", async () => {
    const bg = await listedTab();
    await menu(bg);
    await bg.sendMessage({ type: "untrustedActivation" }, TAB);
    menuTab(bg, 9);
    await bg.settle();
    assert.equal(bg.verdict(9), "closed", "voided before the tab");
    await menu(bg);
    menuTab(bg, 10);
    await bg.settle(20); // matched; the re-check is 50 ms away
    await bg.sendMessage({ type: "untrustedActivation" }, TAB);
    await bg.settle();
    assert.equal(bg.verdict(10), "closed", "voided during the re-check");
  });

  it("ends when the menu closes", async () => {
    const bg = await listedTab();
    await menu(bg);
    await bg.sendMessage({ type: "contextMenuClosed" }, TAB);
    menuTab(bg, 9);
    await bg.settle();
    assert.equal(bg.verdict(9), "closed");
    assert.equal(TAB in (bg.sessionData().menus ?? {}), false, "record removed from storage");
  });

  it("stores capped srcs: no data: URLs, 2048 characters each, 20 at most", async () => {
    const bg = await listedTab();
    const long = "https://img.example/" + "a".repeat(3000);
    const many = Array.from({ length: 30 }, (_, i) => `https://img.example/${i}.png`);
    await menu(bg, { selection: "x".repeat(600), srcs: ["data:image/png;base64,AAAA", long, long, 7, ...many] });
    await bg.advance(0);
    const rec = bg.sessionData().menus[TAB];
    assert.equal(rec.selection.length, 500);
    assert.equal(rec.srcs.length, 20);
    assert.equal(rec.srcs.some((s) => s.startsWith("data:")), false);
    assert.equal(rec.srcs[0], long.slice(0, 2048));
    // An image the menu offered is kept.
    menuTab(bg, 9, "https://img.example/3.png");
    await bg.settle();
    assert.equal(bg.verdict(9), "kept");
  });
});

describe("inListedTab replies", () => {
  const ask = (bg, tab) => bg.sendMessage({ type: "inListedTab" }, { tab });

  it("answers from the address, the top-frame history and popups of listed tabs", async () => {
    const bg = await loadBackground({ tabs: [{ id: TAB, url: LISTED }, { id: 5, url: UNLISTED }] });
    top(bg, TAB, LISTED);
    top(bg, 5, UNLISTED);
    await bg.settle();
    assert.deepEqual(await ask(bg, { id: TAB, url: LISTED }), { listed: true });
    assert.deepEqual(await ask(bg, { id: 5, url: UNLISTED }), { listed: false });
    // A listed page that turned itself into blob:null keeps its site.
    assert.deepEqual(await ask(bg, { id: TAB, url: "blob:null/1234" }), { listed: true });
    // A popup of the listed tab, while its verdict is in flight and after.
    bg.fireCreated({ id: 9, openerTabId: TAB });
    const inFlight = ask(bg, { id: 9, url: "about:blank" });
    await bg.settle();
    assert.deepEqual(await inFlight, { listed: true });
    assert.deepEqual(await ask(bg, { id: 9, url: "about:blank" }), { listed: true });
    // A popup of the unlisted tab is not.
    bg.fireCreated({ id: 10, openerTabId: 5 });
    await bg.settle();
    assert.deepEqual(await ask(bg, { id: 10, url: "about:blank" }), { listed: false });
  });
});

describe("other commit and list paths", () => {
  it("a change to the domain list applies at once", async () => {
    const bg = await loadBackground({ tabs: [{ id: TAB, url: LISTED }] });
    top(bg, TAB, LISTED);
    await bg.setDomains([]);
    assert.equal(await popupNoSource(bg, 9), "kept", "empty list keeps everything");
    await bg.setDomains(["localhost"]);
    assert.equal(await popupNoSource(bg, 10), "closed");
    assert.deepEqual(bg.badges().filter((b) => b.tabId === TAB).map((b) => b.text), ["", "ON"], "badges refreshed on each change");
  });

  it("an empty list from the start keeps everything", async () => {
    const bg = await loadBackground({ sync: { domains: [] }, tabs: [{ id: TAB, url: LISTED }] });
    top(bg, TAB, LISTED);
    assert.equal(await popupNoSource(bg, 9), "kept");
    assert.equal(await popupFrom(bg, 10, TAB), "kept");
  });

  it("prerender commits are ignored", async () => {
    const bg = await loadBackground({ tabs: [{ id: TAB, url: UNLISTED }] });
    top(bg, TAB, UNLISTED);
    top(bg, TAB, LISTED, { documentLifecycle: "prerender" });
    await bg.settle();
    assert.equal(rows(bg, TAB).some((r) => r[2] === "localhost"), false);
    assert.equal(await popupNoSource(bg, 9), "kept");
  });

  it("a top-frame about:blank inherits the listed site unless the user typed it", async () => {
    const bg = await loadBackground({ tabs: [{ id: TAB, url: LISTED }] });
    top(bg, TAB, LISTED);
    top(bg, TAB, "about:blank", { transitionType: "link" });
    assert.equal(await popupNoSource(bg, 9), "closed", "page-made about:blank");
    top(bg, TAB, "about:blank", { transitionType: "typed" });
    assert.equal(await popupNoSource(bg, 10), "kept", "typed about:blank");
  });

  it("a tab born with an address is the user's when its first commit is typed or a reload", async () => {
    const bg = await loadBackground({ tabs: [{ id: TAB, url: LISTED }] });
    top(bg, TAB, LISTED);
    let id = 9;
    for (const transitionType of ["typed", "reload", "link"]) {
      bg.fireCreated({ id, openerTabId: TAB, pendingUrl: OTHER });
      bg.fireCommitted({ tabId: id, frameId: 0, url: OTHER, transitionType });
      await bg.settle();
      assert.equal(bg.verdict(id), transitionType === "link" ? "closed" : "kept", transitionType);
      id++;
    }
    assert.match(bg.why(11), /no navigation source/);
  });

  it("a failed restore still seeds open tabs and judges them as unknown until a commit", async () => {
    const bg = await loadBackground({
      fail: ["session.get"],
      tabs: [{ id: TAB, url: UNLISTED }],
      session: { "h.1": { rows: [[0, -1, "127.0.0.1", Date.now(), 0]] } },
    });
    assert.equal(await popupNoSource(bg, 9), "closed", "unknown window: taken as listed");
    top(bg, TAB, UNLISTED);
    assert.equal(await popupNoSource(bg, 10), "kept");
  });
});
