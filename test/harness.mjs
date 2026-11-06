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
//   const popup = bg.fireCreated({ id: 9, openerTabId: 1 });
//   await bg.settle();
//   assert.deepEqual(bg.removedTabs(), [9]);
//
// Fresh state per load: background.js is imported with a unique query
// string, so module-level maps (history, decisions, lastPrune) start over.
// Timers are real; timestamps are the caller's (webNavigation timeStamp,
// storage row `t`), compared against the real clock — use real Date.now()
// arithmetic (e.g. Date.now() - 65_000) for old rows.

import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SHIPPED_BG = join(here, "..", "extension", "background.js");

let instance = 0;
// Harness waits stay ref'd: they are what keeps the loop alive while the
// background's unref'd timers below do their work.
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

function areaStore(initial = {}) {
  const data = { ...initial };
  const api = {
    _data: data,
    _listeners: new Set(),
    async get(keys) {
      if (keys == null) return { ...data };
      if (typeof keys === "string") return keys in data ? { [keys]: data[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
      return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in data ? data[k] : v]));
    },
    async set(patch) {
      const changes = {};
      for (const [k, v] of Object.entries(patch)) {
        changes[k] = { oldValue: data[k], newValue: v };
        data[k] = v;
      }
      for (const fn of api._listeners) await fn(changes, api._area);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const k of list) {
        changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      for (const fn of api._listeners) await fn(changes, api._area);
    },
  };
  return api;
}

// Background timers (persist debounce, entry expiry) must not hold the
// test process open: unref every timeout created from here on. Unref'd
// timers still fire while the loop is alive, so the debounced save and
// the 50 ms nav-source wait behave exactly as in the worker.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const h = realSetTimeout(fn, ms, ...args);
  h?.unref?.();
  return h;
};
globalThis.clearTimeout = (h) => realClearTimeout(h);

export async function loadBackground({
  bgPath = process.env.BG_PRUNE_PATH ?? SHIPPED_BG,
  sync = { domains: ["localhost"] },
  session = {},
  tabs = [],
  frames = {},
} = {}) {
  const liveTabs = tabs.map((t) => ({ ...t }));
  const removed = [];
  const listeners = { created: new Set(), removed: new Set(), updated: new Set(), activated: new Set() };
  const navListeners = { committed: new Set(), navTarget: new Set() };
  const msgListeners = new Set();
  const badges = [];

  const chrome = {
    storage: {
      onChanged: { addListener: (fn) => void storageChanged.add(fn) },
      session: areaStore(session),
      sync: areaStore(sync),
    },
    tabs: {
      onCreated: { addListener: (fn) => void listeners.created.add(fn) },
      onRemoved: { addListener: (fn) => void listeners.removed.add(fn) },
      onUpdated: { addListener: (fn) => void listeners.updated.add(fn) },
      onActivated: { addListener: (fn) => void listeners.activated.add(fn) },
      query: async (filter = {}) => liveTabs.filter((t) =>
        Object.entries(filter).every(([k, v]) => (k === "url" && Array.isArray(v) ? v.includes(t.url) : t[k] === v))),
      get: async (id) => {
        const t = liveTabs.find((t) => t.id === id);
        if (!t) throw new Error("No tab with id: " + id);
        return { ...t };
      },
      remove: async (ids) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          removed.push(id);
          const i = liveTabs.findIndex((t) => t.id === id);
          if (i >= 0) liveTabs.splice(i, 1);
          for (const fn of listeners.removed) await fn(id, {});
        }
      },
    },
    webNavigation: {
      onCommitted: { addListener: (fn) => void navListeners.committed.add(fn) },
      onCreatedNavigationTarget: { addListener: (fn) => void navListeners.navTarget.add(fn) },
      getAllFrames: async ({ tabId }) => (frames[tabId] ?? []).map((f) => ({ ...f })),
    },
    runtime: { onMessage: { addListener: (fn) => void msgListeners.add(fn) } },
    action: {
      setBadgeBackgroundColor: () => {},
      setBadgeText: async (d) => void badges.push(d),
    },
  };
  const storageChanged = new Set();
  chrome.storage.onChanged.addListener = (fn) => void storageChanged.add(fn);
  const origSessionSet = chrome.storage.session.set.bind(chrome.storage.session);
  chrome.storage.session.set = async (patch) => {
    await origSessionSet(patch);
    const changes = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { newValue: v }]));
    for (const fn of storageChanged) await fn(changes, "session");
  };

  globalThis.chrome = chrome;
  await import(pathToFileURL(bgPath).href + `?bgtest=${++instance}`);
  // Let the top-level restore (storage read, tab seeding) and its
  // debounced save land.
  await sleep(300);

  const fireCommitted = (d) => {
    for (const fn of navListeners.committed) fn({ documentLifecycle: "auto", transitionQualifiers: [], ...d });
  };
  const fireNavTarget = (d) => {
    for (const fn of navListeners.navTarget) fn({ ...d });
  };
  const fireCreated = (tab) => {
    const full = { pendingUrl: "", url: "", ...tab };
    liveTabs.push({ ...full });
    for (const fn of listeners.created) fn({ ...full });
    return full;
  };
  return {
    fireCommitted,
    fireNavTarget,
    fireCreated,
    removedTabs: () => [...removed],
    sessionData: () => JSON.parse(JSON.stringify(chrome.storage.session._data)),
    // Real-timer waits: persist debounce (150 ms), nav-source wait (50 ms),
    // commit wait (3 s when a decision genuinely needs a commit — avoid).
    settle: (ms = 500) => sleep(ms),
  };
}
