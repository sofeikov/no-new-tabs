// Enforcement layer. Runs in the browser process, so page code cannot get
// around it: any tab or window a listed site opens is closed at once.
// (guard.js + arm.js stop most attempts before a tab exists; this catches
// whatever gets past them.)

import { hostIsBlocked, isBlockedUrl, loadDomains, siteOf } from "./lib.js";

// Kept in memory so closing a tab doesn't wait on a storage read.
let domainsCache = null;
const getDomains = () => (domainsCache ??= loadDomains());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.domains) {
    domainsCache = Promise.resolve(changes.domains.newValue ?? []);
    refreshAllBadges();
  }
});

// --- What each frame of each tab was showing, and when -------------------

// Ad scripts open a tab and then send the listed tab (or the listed iframe
// that opened it) to an ad, back, or away, so a popup is judged by what its
// opener showed when the popup was created, not by what it shows by the
// time we look.
//
// For every frame, each change of site is recorded in event order (seq)
// and with the browser's own timestamp (t). Only hosts are kept, not URLs,
// so the record stays small. It survives the worker being stopped, which
// Chrome does after 30 s of quiet.
let seq = 0;
const history = new Map(); // tabId -> [{ f: frameId, p: parentFrameId, h: host, t, seq }], oldest first
const MAX_ENTRIES = 1000;
// Tabs whose history lost top-frame entries to MAX_ENTRIES: what they
// showed before the oldest entry left is unknown, so it is taken to be listed.
const trimmed = new Set();

// Tabs we closed because a listed site opened them. Anything they open in
// turn (a popup that opens another popup) is closed too.
const spawned = new Set();

// A context menu the user opened on a listed page (see arm.js).
const menus = new Map(); // tabId -> { link, t }

// Closed tabs are forgotten 30 s later; their opener may need judging until then.
const gone = new Map(); // tabId -> when it was closed

// Tabs whose current top page was restored from the back/forward cache.
// A restored page's subframes never re-commit, so history alone misses
// them; a popup with no navigation source counts as listed while the
// restored page is current if any recorded frame of that page was listed.
const restoredTabs = new Set(); // tabId

// left: when the frame's page was left (a later top-frame commit).
const pack = (entries) => entries.map(({ f, p, h, t, left }) => [f, p, h, t, left ?? 0]);
const unpack = (rows) => rows.map(([f, p, h, t, left]) => ({ f, p, h, t, seq: 0, ...(left ? { left } : {}) }));

const restored = chrome.storage.session.get(["spawned", "history", "trimmed", "menus", "gone", "restoredTabs"])
  .then((saved) => {
    (saved.spawned ?? []).forEach((id) => spawned.add(id));
    (saved.trimmed ?? []).forEach((id) => trimmed.add(id));
    (saved.restoredTabs ?? []).forEach((id) => restoredTabs.add(id));
    for (const [id, m] of Object.entries(saved.menus ?? {})) if (!menus.has(+id)) menus.set(+id, m);
    for (const [id, at] of Object.entries(saved.gone ?? {})) if (!gone.has(+id)) gone.set(+id, at);
    // Saved entries predate everything this worker has seen (seq 0).
    for (const [id, rows] of Object.entries(saved.history ?? {})) {
      history.set(+id, [...unpack(rows), ...(history.get(+id) ?? [])]);
    }
  })
  .catch(() => {})
  .then(async () => {
    // Tabs open before the extension started have no saved history: start
    // it with what they show now.
    for (const tab of await chrome.tabs.query({}).catch(() => [])) {
      const entries = history.get(tab.id) ?? [];
      if (!entries.some((e) => e.f === 0 && e.seq === 0)) {
        entries.unshift({ f: 0, p: -1, h: siteOf(tab.url || tab.pendingUrl || "") ?? "", t: 0, seq: 0 });
        history.set(tab.id, entries);
      }
    }
    forgetGone();
  });

let persistTimer = null;
let writes = 0;
function persist() {
  persistTimer ??= setTimeout(() => restored.then(() => {
    const write = ++writes;
    persistTimer = null;
    forgetGone();
    const saved = {};
    for (const [id, entries] of history) saved[id] = pack(entries);
    chrome.storage.session.set({
      spawned: [...spawned].slice(-500),
      history: saved,
      trimmed: [...trimmed],
      restoredTabs: [...restoredTabs].slice(-500),
      menus: Object.fromEntries(menus),
      gone: Object.fromEntries(gone),
    }).catch((e) => {
      // Never leave an old record behind to be restored later.
      console.warn("[no-new-tabs] could not save history:", e?.message);
      if (write === writes) chrome.storage.session.remove(["history", "trimmed", "restoredTabs"]).catch(() => {});
    });
  }), 0);
}

function forgetGone() {
  const now = Date.now();
  for (const [id, at] of gone) {
    if (now - at < 30_000) continue;
    for (const m of [history, menus, gone]) m.delete(id);
    spawned.delete(id);
    trimmed.delete(id);
    if (restoredTabs.delete(id)) persist();
  }
}

// Typed and bookmarked pages are the user's; anything else in the top
// frame (a link, a redirect, script, a reload) comes from the page that was
// there.
const USER_TRANSITIONS = new Set(["typed", "auto_bookmark", "generated", "keyword", "keyword_generated", "start_page", "auto_toplevel"]);

// A new tab's first top commit tells user tabs apart from page tabs.
// Duplicate and reopen use "reload" (history API): for a new tab that is
// the user's own doing, unlike a reload inside an existing tab.
const NEW_TAB_USER_TRANSITIONS = new Set([...USER_TRANSITIONS, "reload"]);

// The first top-frame commit seen for a new tab, by tab id.
const firstCommit = new Map(); // tabId -> { transitionType }
const commitWaiters = new Map(); // tabId -> resolve
const COMMIT_WAIT_MS = 3000;
function waitForFirstCommit(tabId) {
  if (firstCommit.has(tabId)) return Promise.resolve(firstCommit.get(tabId));
  if (commitWaiters.has(tabId)) return commitWaiters.get(tabId).promise;
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  const timer = setTimeout(() => {
    commitWaiters.delete(tabId);
    resolve(null);
  }, COMMIT_WAIT_MS);
  commitWaiters.set(tabId, {
    promise,
    resolve: (v) => { clearTimeout(timer); commitWaiters.delete(tabId); resolve(v); },
  });
  return promise;
}

const isHttpUrl = (url) => {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
};

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.documentLifecycle === "prerender") return;
  if (d.frameId === 0) {
    if (!firstCommit.has(d.tabId)) {
      firstCommit.set(d.tabId, { transitionType: d.transitionType });
      setTimeout(() => firstCommit.delete(d.tabId), 10_000);
    }
    const waiter = commitWaiters.get(d.tabId);
    if (waiter) waiter.resolve({ transitionType: d.transitionType });
    const restoredNow = (d.transitionQualifiers ?? []).includes("forward_back");
    if (restoredNow) {
      if (!restoredTabs.has(d.tabId)) {
        restoredTabs.add(d.tabId);
        persist();
      }
    } else if (restoredTabs.delete(d.tabId)) {
      persist();
    }
  }
  const entries = history.get(d.tabId) ?? [];
  const parent = d.frameId === 0 ? -1 : d.parentFrameId;
  let h = siteOf(d.url);
  if (h === null && d.frameId === 0) {
    // about:blank, data: or javascript: in the top frame: made by the page
    // that was there (e.g. a listed page navigating itself to a blob: or
    // about:blank to shed its site), unless the user typed it.
    h = USER_TRANSITIONS.has(d.transitionType) ? "" : (lastOf(entries, 0)?.h ?? "");
  }
  history.set(d.tabId, entries);
  const now = ++seq;
  if (d.frameId === 0) {
    // A new page: the frames of the one before have left with it. Frames of
    // pages left over a minute ago can't open anything now.
    const old = d.timeStamp - 60_000;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.f === 0) continue;
      if (e.left == null) e.left = d.timeStamp;
      else if (e.left < old) entries.splice(i, 1);
    }
  }
  const last = lastOf(entries, d.frameId);
  if (last && last.h === h && last.p === parent && last.left == null) {
    if (d.frameId !== 0 || !(d.transitionQualifiers ?? []).includes("forward_back")) return;
    // A cache restore with no visible change still needs its live subframes.
  } else {
    entries.push({ f: d.frameId, p: parent, h, t: d.timeStamp, seq: now });
    if (entries.length > MAX_ENTRIES) {
      // Drop the oldest frame entry. Top-frame entries go last, and only
      // after 1000 changes of site.
      const sub = entries.findIndex((e) => e.f !== 0);
      entries.splice(Math.max(sub, 0), 1);
      if (sub < 0) trimmed.add(d.tabId);
    }
  }
  persist();
  if (d.frameId === 0 && (d.transitionQualifiers ?? []).includes("forward_back")) {
    // Subframes restored from the back/forward cache never re-commit, so
    // record what is live now for the no-source fallback below.
    const tabId = d.tabId;
    const stamp = d.timeStamp;
    liveFrames(tabId).then((live) => {
      if (!live?.size) return;
      const list = history.get(tabId) ?? [];
      let changed = false;
      for (const [frameId, f] of live) {
        if (frameId === 0) continue;
        const host = siteOf(f.url);
        if (host === "") continue;
        const cur = lastOf(list, frameId);
        if (cur && cur.h === host && cur.left == null) continue;
        list.push({ f: frameId, p: f.parentFrameId ?? 0, h: host, t: stamp, seq: ++seq });
        changed = true;
      }
      if (changed) {
        while (list.length > MAX_ENTRIES) {
          const sub = list.findIndex((e) => e.f !== 0);
          list.splice(Math.max(sub, 0), 1);
          if (sub < 0) trimmed.add(tabId);
        }
        persist();
      }
    }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  gone.set(tabId, Date.now());
  persist();
  setTimeout(persist, 31_000); // forgets it, if the worker is still running
});

function lastOf(entries, frameId) {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].f === frameId) return entries[i];
  return undefined;
}

// A frame's entry at a moment, by event order or by the clock.
function entryAt(entries, frameId, { atSeq, atTime }) {
  let found;
  for (const e of entries) {
    if (e.f === frameId && (atSeq != null ? e.seq < atSeq : e.t <= atTime)) found = e;
  }
  return found;
}

// tabId -> Promise<boolean>, for tabs whose fate is still being decided.
const decisions = new Map();

function track(tabId, decision) {
  decisions.set(tabId, decision);
  decision.catch(() => false).finally(() => {
    if (decisions.get(tabId) === decision) decisions.delete(tabId);
  });
}

const liveFrames = async (tabId) => new Map(((await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? [])
  .map((x) => [x.frameId, x]));

// Was this frame (or any frame above it) on a listed site at the given
// moment? Frames that left or were removed since are judged by what they
// were then.
async function frameWasListed(tabId, frameId, moment, domains) {
  const entries = history.get(tabId) ?? [];
  let live = null;
  for (let f = frameId ?? 0, hops = 0; hops < 32; hops++) {
    const e = entryAt(entries, f, moment);
    let host, parent;
    if (e) {
      ({ h: host, p: parent } = e);
    } else if (f === 0) {
      if (trimmed.has(tabId)) return true;
      // Nothing recorded (e.g. no navigation since a restart): use what it shows now.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      return !!tab && isBlockedUrl(tab.url || tab.pendingUrl, domains);
    } else {
      // A frame that never committed a document of its own (an about:blank
      // made by script, say): walk up from where it sits now.
      live ??= await liveFrames(tabId);
      const now = live.get(f);
      if (!now) { f = 0; continue; } // gone without a trace: it was in this tab's page at least
      host = siteOf(now.url);
      parent = now.parentFrameId;
    }
    if (host && hostIsBlocked(host, domains)) return true;
    if (f === 0 || parent == null || parent < 0) return false;
    f = parent;
  }
  return false;
}

// Was this tab's page (or a frame in it) listed at the moment, or is the
// tab itself a popup of a listed site?
async function wasListed(tabId, frameId, moments, domains) {
  if (tabId == null) return false;
  if (spawned.has(tabId)) return true;
  if (decisions.has(tabId) && (await decisions.get(tabId))) return true;
  for (const moment of moments) {
    if (await frameWasListed(tabId, frameId, moment, domains)) return true;
  }
  return false;
}

// No navigation source names a frame (the opener frame never committed, or
// the opener page was restored from the back/forward cache). Judge the
// opener's top page; while a restored page is current, any listed frame in
// it counts, since the opener frame itself is unknown.
async function openerWasListed(openerTabId, moment, domains) {
  if (await wasListed(openerTabId, 0, [moment], domains)) return true;
  if (!restoredTabs.has(openerTabId)) return false;
  const entries = history.get(openerTabId) ?? [];
  const frames = new Set(entries.map((e) => e.f));
  for (const f of frames) {
    if (await frameWasListed(openerTabId, f, moment, domains)) return true;
  }
  // The refresh after a cache restore may still be in flight: look live.
  try {
    for (const [, f] of await liveFrames(openerTabId)) {
      if (f.frameId !== 0 && hostIsBlocked(siteOf(f.url), domains)) return true;
    }
  } catch {}
  return false;
}

function block(tabId, why) {
  spawned.add(tabId);
  persist();
  chrome.tabs.remove(tabId).catch(() => {});
  console.info("[no-new-tabs] closed tab", tabId, why);
}

// --- Close anything a listed site opens ----------------------------------

// A tab created by page script (window.open, target=_blank, forms) usually
// arrives with no URL at all. Tabs that already carry a pendingUrl or url
// are the browser's own (middle- and ctrl-click, "Open link in new tab"):
// the page's or the user's. Telling those apart needs the new tab's first
// commit (see NEW_TAB_USER_TRANSITIONS); openerTabId alone is not enough.
const pageCreated = (tab) => tab.openerTabId != null && !tab.pendingUrl && !tab.url;

// What tabs.onCreated saw: the address the tab came with (only tabs the
// browser makes have one), and the moment it was created.
const born = new Map(); // tabId -> { url, atSeq }

// webNavigation.onCreatedNavigationTarget names the exact source tab and
// frame, so it is preferred. It arrives just after tabs.onCreated, except
// when the opener frame never committed a document (e.g. an ad script's
// hidden <iframe src="javascript:false">): then it never arrives, and the
// tab's opener is used instead.
const NAV_WAIT_MS = 50;
const navWaiters = new Map();
const navEarly = new Map();

function waitForNavSource(tabId) {
  if (navEarly.has(tabId)) return Promise.resolve(navEarly.get(tabId));
  return new Promise((resolve) => {
    const timer = setTimeout(() => { navWaiters.delete(tabId); resolve(null); }, NAV_WAIT_MS);
    navWaiters.set(tabId, (details) => { clearTimeout(timer); navWaiters.delete(tabId); resolve(details); });
  });
}

// The user picked something from a context menu on a listed page: a
// search for the selected text, or open an image or video. That one tab is
// theirs, so it is kept, if the browser made it (a page can't create a tab
// that comes with an address) and its address is one the menu offered.
// Opening the site's links in new tabs stays blocked.
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
function offeredByMenu(menu, url) {
  if (menu.srcs.includes(url)) return true;
  const words = squash(menu.selection).slice(0, 50);
  if (!words) return false;
  try {
    for (const value of new URL(url).searchParams.values()) if (squash(value).includes(words)) return true;
  } catch {}
  return false;
}

async function fromUserMenu(tabId, sourceTabId, sourceFrameId, domains) {
  const url = born.get(tabId)?.url;
  if (!url) return false;
  const menu = menus.get(sourceTabId);
  if (menu && Date.now() - menu.t < 300_000 && offeredByMenu(menu, url)) {
    menus.delete(sourceTabId); // one tab per menu
    persist();
    return true;
  }
  // The browser's own frames, where arm.js can't run (the PDF viewer): a
  // search for text in the PDF is the user's. Only search results pages
  // count, so the most a page could get from this is a search.
  if (sourceFrameId && SEARCH.test(url) && !isBlockedUrl(url, domains) &&
    !(history.get(sourceTabId) ?? []).some((e) => e.f === sourceFrameId) &&
    !(await liveFrames(sourceTabId)).has(sourceFrameId)) return true;
  return false;
}
const SEARCH = /^https:\/\/(www\.)?(google\.[a-z]{2,3}(\.[a-z]{2})?\/search|bing\.com\/search|duckduckgo\.com\/|search\.brave\.com\/search|search\.yahoo\.com\/search|(www\.)?ecosia\.org\/search|(www\.)?startpage\.com\/|yandex\.[a-z]{2,3}\/search|(www\.)?baidu\.com\/s|(www\.)?qwant\.com\/|kagi\.com\/search)\?/;

function decideFromNav(details, atSeq) {
  return (async () => {
    const domains = await getDomains();
    if (!domains.length) return false;
    await restored;
    const { sourceTabId, sourceFrameId, timeStamp } = details;
    const listed = await wasListed(sourceTabId, sourceFrameId, [{ atSeq }, { atTime: timeStamp }], domains);
    if (!listed) return false;
    if (await fromUserMenu(details.tabId, sourceTabId, sourceFrameId, domains)) {
      console.info("[no-new-tabs] kept tab", details.tabId, "chosen from a context menu:", details.url);
      return false;
    }
    block(details.tabId, `opened by tab ${sourceTabId}: ${details.url}`);
    return true;
  })();
}

chrome.tabs.onCreated.addListener((tab) => {
  const atSeq = seq + 1; // after every commit seen so far, before any later one
  if (tab.openerTabId != null) {
    born.set(tab.id, { url: tab.pendingUrl || tab.url, atSeq });
    setTimeout(() => born.delete(tab.id), 10_000);
  }
  if (decisions.has(tab.id)) return; // navigation event came first
  const bornUrl = tab.pendingUrl || tab.url;
  const urlBorn = tab.openerTabId != null && !!bornUrl;
  if (!pageCreated(tab) && !(urlBorn && isHttpUrl(bornUrl))) return;
  const nav = waitForNavSource(tab.id); // register synchronously, before any await
  track(tab.id, (async () => {
    const source = await nav;
    if (source) return decideFromNav(source, atSeq);
    const domains = await getDomains();
    if (!domains.length) return false;
    await restored;
    if (!pageCreated(tab)) {
      // A tab that already has an address: the user's own (typed,
      // bookmark, duplicate, reopen) or the page's link. The first commit
      // tells them apart; without a commit, keep the tab.
      const commit = await waitForFirstCommit(tab.id);
      if (!commit) return false;
      if (commit.transitionType && NEW_TAB_USER_TRANSITIONS.has(commit.transitionType)) return false;
      if (await fromUserMenu(tab.id, tab.openerTabId, undefined, domains)) return false;
    }
    // The browser doesn't say which frame: judge the opener's page.
    const listed = await openerWasListed(tab.openerTabId, { atSeq }, domains);
    if (listed) block(tab.id, `opened by tab ${tab.openerTabId} (no navigation source)`);
    return listed;
  })());
});

// Also fires for browser-made tabs that come from the page: middle- and
// ctrl-click, "Open link in new tab", and links dropped from the page.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  const waiter = navWaiters.get(details.tabId);
  if (waiter) return waiter(details);
  navEarly.set(details.tabId, details);
  setTimeout(() => navEarly.delete(details.tabId), 5000);
  // Judge it at the moment the tab was created, even if this event is late.
  const atSeq = born.get(details.tabId)?.atSeq ?? seq + 1;
  const pending = decisions.get(details.tabId);
  // Arrived too late for tabs.onCreated's wait: decide again with it.
  track(details.tabId, pending
    ? pending.then((listed) => listed || decideFromNav(details, atSeq))
    : decideFromNav(details, atSeq));
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const id = sender.tab?.id;
  // arm.js reports context menus on guarded pages.
  if (msg?.type === "contextMenu" && id != null) {
    const srcs = Array.isArray(msg.srcs) ? msg.srcs.filter((s) => typeof s === "string").slice(0, 20) : [];
    menus.set(id, { selection: String(msg.selection ?? "").slice(0, 500), srcs, t: Date.now() });
    persist();
    return;
  }
  if (msg?.type === "contextMenuClosed" && id != null) {
    if (menus.delete(id)) persist();
    return;
  }
  // arm.js asks this when it can't tell from inside the page: a frame whose
  // ancestors are hidden, or a popup.
  if (msg?.type !== "inListedTab") return;
  getDomains().then(async (domains) => {
    await restored;
    const popupOfListed = id != null && (spawned.has(id) || (decisions.has(id) && (await decisions.get(id))));
    const shows = isBlockedUrl(sender.tab?.url, domains) ||
      (id != null && hostIsBlocked(lastOf(history.get(id) ?? [], 0)?.h, domains));
    reply({ listed: shows || popupOfListed });
  });
  return true;
});

// --- Badge: show "ON" on tabs where blocking is active -------------------

async function setBadge(tab, domains) {
  if (!tab?.id) return;
  const on = isBlockedUrl(tab.url || tab.pendingUrl, domains);
  await chrome.action.setBadgeText({ tabId: tab.id, text: on ? "ON" : "" }).catch(() => {});
}

async function refreshAllBadges() {
  const domains = await getDomains();
  for (const tab of await chrome.tabs.query({})) setBadge(tab, domains);
}

chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
chrome.tabs.onUpdated.addListener(async (_id, change, tab) => {
  if (change.url || change.status === "loading") setBadge(tab, await getDomains());
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  setBadge(tab, await getDomains());
});
