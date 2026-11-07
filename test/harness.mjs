// Fake-chrome harness for background.js unit tests (issue 15).
//
// Loads the SHIPPED extension/background.js with a fake `chrome` API, so
// time-driven behavior the headless suite cannot reach — pruning 60 s
// after a frame leaves, cold-worker restore, fallback attribution — runs
// in milliseconds with controlled webNavigation timestamps and no browser.
//
//   import { loadBackground } from "./harness.mjs";
//   const bg = await loadBackground(); // fresh module instance, localhost listed
//   bg.fireCommitted({ tabId: 1, frameId: 0, url: "http://localhost/i.html", timeStamp: Date.now() });
//   bg.fireCreated({ id: 9, openerTabId: 1 });
//   await bg.settle();
//   assert.equal(bg.verdict(9), "closed");
//   assert.match(bg.why(9), /no navigation source/);
//
// Fresh state per load: background.js is imported with a unique query
// string, so module-level maps (history, decisions, lastPrune) start over.
//
// Virtual time. Importing this module replaces globalThis.setTimeout,
// clearTimeout, setInterval, clearInterval and Date.now with a clock the
// harness owns. Nothing fires on its own: `settle(ms)` advances the clock
// by exactly ms, running every due timer in (due time, creation order)
// and letting promise chains finish after each one. So the background's
// waits keep their real lengths — 50 ms nav-source wait, 150 ms persist
// debounce, 3 s first-commit wait, 60 s prune interval, 30 s closed-tab
// memory and its 31 s re-persist — but cost no wall time, and runs are
// deterministic. Points to keep in mind:
// - Date.now() in the tests reads the same clock, so `Date.now() - 65_000`
//   for an old row is consistent with the background's own reads.
// - The clock starts at 1.7e12, never 0: pruneDead's `now - lastPrune(0)
//   < 60_000` would skip the first prune at a clock near 0 (node:test's
//   mock.timers defaults to now: 0, which silently disables the
//   dead-frame test).
// - There is deliberately no "run all timers" helper: it would fire the
//   5 s, 10 s and 31 s expiries early and change what is being tested.
// - Draining between timers is a real setImmediate, which only finishes
//   the background's work because every fake chrome method below is
//   promise-only (or delivers its events through the virtual timers). A
//   fake that waits on real I/O or real timers would break that.
// - Each loadBackground() drops the previous instance's pending timers
//   (the background looks `chrome` up when a timer fires, so an old
//   instance's 31 s re-persist would otherwise write into the next
//   test's storage). Tests in one file must run sequentially (the
//   node:test default): the clock and timer queue are shared.
// - performance.now() and new Date() are not virtual; background.js uses
//   neither.
//
// Logs: "[no-new-tabs] ..." console lines are captured per instance
// instead of printed (bg.logs(), bg.warnings(), bg.why(tabId)). Set
// NNT_TEST_LOG=1 to print them as well.
//
// Mutants: BG_PATH=/path/to/background.js loads another copy (BG_PRUNE_PATH
// is the old name, still read). The copy imports ./lib.js, which imports
// ./match.js, so put copies of both next to it.

import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SHIPPED_BG = join(here, "..", "extension", "background.js");

let instance = 0;

// --- Virtual clock ---------------------------------------------------------

const realSetImmediate = globalThis.setImmediate;
let clock = 1_700_000_000_000;
let nextTimerId = 1;
let timers = [];

function addTimer(fn, ms, args, every) {
  const delay = Math.max(0, +ms || 0);
  const t = { id: nextTimerId++, at: clock + delay, fn, args, every: every ? Math.max(1, delay) : null };
  timers.push(t);
  return t;
}
const dropTimer = (t) => { if (t != null) timers = timers.filter((x) => x !== t); };
globalThis.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
globalThis.clearTimeout = dropTimer;
globalThis.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
globalThis.clearInterval = dropTimer;
Date.now = () => clock;

// Lets every promise chain started so far finish (the fake chrome API is
// promise-only, so the microtask queue empties before a real immediate).
const drain = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => realSetImmediate(r));
};

// Advance the clock by exactly ms, firing due timers in (at, id) order.
export async function advance(ms = 0) {
  const end = clock + Math.max(0, +ms || 0);
  await drain();
  for (;;) {
    let next = null;
    for (const t of timers) {
      if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
    }
    if (!next) break;
    clock = Math.max(clock, next.at);
    if (next.every) next.at = clock + next.every;
    else dropTimer(next);
    next.fn(...next.args);
    await drain();
  }
  clock = end;
  await drain();
}

export const now = () => clock;

// --- Captured logs -----------------------------------------------------------

let currentLogs = [];
for (const level of ["info", "warn", "log", "error"]) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === "string" && args[0].startsWith("[no-new-tabs]")) {
      currentLogs.push({ level, args });
      if (!process.env.NNT_TEST_LOG) return;
    }
    real(...args);
  };
}
const line = (e) => e.args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" ");

// --- Fake chrome -------------------------------------------------------------

const copy = (v) => (v === undefined ? undefined : structuredClone(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A storage area. Values are copied in and out (Chrome serializes them), so
// a later in-memory mutation never shows up in storage without a write.
// onChanged gets only keys whose value changed, with oldValue/newValue, and
// does not fire at all when nothing changed — as in Chrome.
function areaStore(name, initial, emit, gate) {
  const data = copy(initial ?? {});
  return {
    _data: data,
    async get(keys) {
      await gate(`${name}.get`);
      let out;
      if (keys == null) out = { ...data };
      else if (typeof keys === "string") out = keys in data ? { [keys]: data[keys] } : {};
      else if (Array.isArray(keys)) out = Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
      else out = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in data ? data[k] : v]));
      return copy(out);
    },
    async set(patch) {
      await gate(`${name}.set`);
      const changes = {};
      for (const [k, v] of Object.entries(patch ?? {})) {
        if (v === undefined) continue;
        const value = copy(v);
        if (k in data && same(data[k], value)) continue;
        changes[k] = { ...(k in data ? { oldValue: data[k] } : {}), newValue: value };
        data[k] = value;
      }
      emit(changes, name);
    },
    async remove(keys) {
      await gate(`${name}.remove`);
      const changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (!(k in data)) continue;
        changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      emit(changes, name);
    },
  };
}

export async function loadBackground({
  bgPath = process.env.BG_PATH ?? process.env.BG_PRUNE_PATH ?? SHIPPED_BG,
  sync = { domains: ["localhost"] },
  session = {},
  tabs = [],
  // tabId -> [{ frameId, parentFrameId, url }]. Read live (a test may
  // replace an entry later). A live tab with no entry has just its top
  // frame; a closed or unknown tab gives null, as Chrome does.
  frames = {},
  // Calls that reject once from the start, e.g. ["session.get"] for a
  // failed restore. See failNext() for later ones.
  fail = [],
} = {}) {
  const liveTabs = tabs.map((t) => ({ ...t }));
  const closedTabs = new Set();
  const removed = [];
  const listeners = { created: new Set(), removed: new Set(), updated: new Set(), activated: new Set() };
  const navListeners = { committed: new Set(), navTarget: new Set() };
  const msgListeners = new Set();
  const storageChanged = new Set();
  const badges = [];
  const failing = new Map();
  const failNext = (method, times = 1) => void failing.set(method, (failing.get(method) ?? 0) + times);
  for (const m of fail) failNext(m);

  // Rejects when a failure is armed for this call (one per failNext).
  const gate = async (method) => {
    const n = failing.get(method) ?? 0;
    if (!n) return;
    if (n === 1) failing.delete(method);
    else failing.set(method, n - 1);
    throw new Error(`fake ${method} failure`);
  };
  const emit = (changes, area) => {
    if (!Object.keys(changes).length) return;
    for (const fn of storageChanged) fn(copy(changes), area);
  };
  // Chrome delivers events as their own tasks, after the call that caused
  // them has returned: queue them on the virtual clock.
  const later = (fn) => void setTimeout(fn, 0);
  const deliverRemoved = (id) => later(() => {
    for (const fn of listeners.removed) fn(id, { windowId: 1, isWindowClosing: false });
  });
  const dropTab = (id) => {
    const i = liveTabs.findIndex((t) => t.id === id);
    if (i < 0) return false;
    liveTabs.splice(i, 1);
    closedTabs.add(id);
    return true;
  };
  const tabMatches = (t, filter) => Object.entries(filter ?? {}).every(([k, v]) =>
    (k === "url" && Array.isArray(v) ? v.includes(t.url) : t[k] === v));

  const chrome = {
    storage: {
      onChanged: { addListener: (fn) => void storageChanged.add(fn) },
      session: areaStore("session", session, emit, gate),
      sync: areaStore("sync", sync, emit, gate),
    },
    tabs: {
      onCreated: { addListener: (fn) => void listeners.created.add(fn) },
      onRemoved: { addListener: (fn) => void listeners.removed.add(fn) },
      onUpdated: { addListener: (fn) => void listeners.updated.add(fn) },
      onActivated: { addListener: (fn) => void listeners.activated.add(fn) },
      query: async (filter = {}) => {
        await gate("tabs.query");
        return liveTabs.filter((t) => tabMatches(t, filter)).map((t) => ({ ...t }));
      },
      get: async (id) => {
        await gate("tabs.get");
        const t = liveTabs.find((t) => t.id === id);
        if (!t) throw new Error("No tab with id: " + id + ".");
        return { ...t };
      },
      // Records the request (removedTabs) even when it then fails, so a
      // test sees every close the background asked for.
      remove: async (ids) => {
        const list = Array.isArray(ids) ? ids : [ids];
        for (const id of list) removed.push(id);
        await gate("tabs.remove");
        const missing = list.filter((id) => !dropTab(id));
        for (const id of list) if (!missing.includes(id)) deliverRemoved(id);
        if (missing.length) throw new Error("No tab with id: " + missing[0] + ".");
      },
    },
    webNavigation: {
      onCommitted: { addListener: (fn) => void navListeners.committed.add(fn) },
      onCreatedNavigationTarget: { addListener: (fn) => void navListeners.navTarget.add(fn) },
      getAllFrames: async ({ tabId }) => {
        await gate("webNavigation.getAllFrames");
        if (closedTabs.has(tabId)) return null;
        if (tabId in frames) return frames[tabId].map((f) => ({ ...f }));
        const tab = liveTabs.find((t) => t.id === tabId);
        if (!tab) return null;
        return [{ frameId: 0, parentFrameId: -1, url: tab.url || tab.pendingUrl || "about:blank" }];
      },
    },
    runtime: { onMessage: { addListener: (fn) => void msgListeners.add(fn) } },
    action: {
      setBadgeBackgroundColor: () => {},
      setBadgeText: async (d) => {
        await gate("action.setBadgeText");
        badges.push({ ...d });
      },
    },
  };

  globalThis.chrome = chrome;
  timers = []; // the previous instance's pending timers must not fire here
  const logs = (currentLogs = []);
  await import(pathToFileURL(bgPath).href + `?bgtest=${++instance}`);
  // Let the top-level restore (storage read, tab seeding) and its
  // debounced save land.
  await advance(300);

  const fireCommitted = (d) => {
    for (const fn of navListeners.committed) {
      fn({ documentLifecycle: "active", transitionQualifiers: [], timeStamp: clock, ...d });
    }
  };
  const fireNavTarget = (d) => {
    for (const fn of navListeners.navTarget) fn({ timeStamp: clock, ...d });
  };
  const fireCreated = (tab) => {
    const full = { pendingUrl: "", url: "", ...tab };
    liveTabs.push({ ...full });
    for (const fn of listeners.created) fn({ ...full });
    return full;
  };
  // The user closes a tab (or a script's window.close()).
  const closeTab = (id) => {
    if (dropTab(id)) deliverRemoved(id);
  };
  // A message from a content script. `sender` is a tab id or a full
  // MessageSender ({ tab: { id, url }, frameId }). Resolves with the reply,
  // or undefined when no listener keeps the channel open.
  const sendMessage = (msg, sender = {}) => new Promise((resolve) => {
    const s = typeof sender === "number" ? { tab: { id: sender } } : sender;
    let open = false;
    for (const fn of msgListeners) if (fn(msg, s, resolve) === true) open = true;
    if (!open) resolve(undefined);
  });
  const setDomains = (list) => chrome.storage.sync.set({ domains: list });

  // The last closed/kept log line for a tab.
  const decisionLog = (id) => [...logs].reverse().find((e) =>
    typeof e.args[0] === "string" && /^\[no-new-tabs\] (closed|kept) tab$/.test(e.args[0]) && e.args[1] === id);

  return {
    fireCommitted,
    fireNavTarget,
    fireCreated,
    closeTab,
    fireRemoved: closeTab,
    sendMessage,
    setDomains,
    failNext,
    removedTabs: () => [...removed],
    liveTabIds: () => liveTabs.map((t) => t.id),
    sessionData: () => JSON.parse(JSON.stringify(chrome.storage.session._data)),
    syncData: () => JSON.parse(JSON.stringify(chrome.storage.sync._data)),
    badges: () => badges.map((b) => ({ ...b })),
    // "closed" when the background asked to remove the tab, else "kept"
    // (which includes "not decided yet": settle first).
    verdict: (id) => (removed.includes(id) ? "closed" : "kept"),
    // The reason logged with the tab's last closed/kept decision, e.g.
    // "opened by tab 1: http://..." (navigation source) or "opened by tab 1
    // (no navigation source)". undefined when nothing was logged.
    why: (id) => {
      const e = decisionLog(id);
      return e ? e.args.slice(2).map(String).join(" ") : undefined;
    },
    logs: () => logs.map(line),
    warnings: () => logs.filter((e) => e.level === "warn").map(line),
    now: () => clock,
    // Advances the virtual clock by exactly ms (default 500): the persist
    // debounce (150 ms) and nav-source wait (50 ms) fit in the default; the
    // first-commit wait (3 s) and the 30/31 s and 60 s expiries need
    // explicit lengths.
    settle: (ms = 500) => advance(ms),
    advance,
  };
}
