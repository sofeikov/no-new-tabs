// In-page guard. Injected into every frame of every page before any page
// script runs, but inert: everything passes straight through until arm.js
// arms it, which happens only in frames that belong to a listed site or sit
// inside a tab showing one (e.g. a video player iframe from another domain).
// On pages arm.js finds unlisted, the guard removes itself again.
//
// Once armed it cancels every way the page can open a new tab or window and
// changes nothing else: the site's own JavaScript keeps running, and opens
// that stay in the page (_self, _top, a named iframe) still work.
// background.js is the hard guarantee; this layer stops the tab from ever
// being created, so there is no flash of a tab opening and closing.
//
// Ad scripts work hard to reach an unpatched window.open, so the guard:
// - is installed before any page script, so saved copies are guarded too;
// - keeps window.open guarded even when a page assigns a new value to it;
// - installs itself into same-origin child frames the browser never injects
//   content scripts into (e.g. a hidden <iframe src="javascript:false">)
//   the moment they are inserted, before the page can reach into them;
// - makes its wrappers report native source, so "is window.open wrapped?"
//   checks don't send ad scripts looking for another way out;
// - only uses built-ins it saved before any page script ran, so a page
//   can't steer it by replacing Set.prototype.has, Function.prototype.apply,
//   Event.prototype.composedPath and the like;
// - hands the browser only null-prototype options and descriptors, writes
//   array copies as own properties, and fails closed if a listener throws,
//   so prototype poisoning and stack exhaustion don't open tabs either.

(() => {
  "use strict";

  // Only documents that run script need it (not PDFs, images or text).
  if (!/^(text\/html|application\/xhtml\+xml|image\/svg\+xml|(application|text)\/xml)$/.test(document.contentType)) return;

  // --- Built-ins, saved before any page script runs ---------------------------

  const { apply } = Reflect;
  const { defineProperty, getOwnPropertyDescriptor: ownDesc } = Object;
  // f(self, ...args) without going through anything the page can replace.
  const uncurry = (f) => (self, ...args) => apply(f, self, args);
  const getter = (proto, key) => uncurry(ownDesc(proto, key).get);
  const fnToString = uncurry(Function.prototype.toString);
  const toLower = uncurry(String.prototype.toLowerCase);
  const charAt = uncurry(String.prototype.charCodeAt);
  const strSlice = uncurry(String.prototype.slice);
  const strIndex = uncurry(String.prototype.indexOf);
  const { keys: objKeys } = Object; // takes its argument, not `this`: must not go through uncurry
  // A hostile page can poison Object.prototype (signal, capture, ...) or
  // Array.prototype (a swallowing setter), so objects the guard hands to
  // the browser and array copies it inspects must not consult any
  // prototype: options and descriptors get a null prototype, and index
  // writes become own data properties.
  const nullProto = (o) => { const n = { __proto__: null }; each(objKeys(o), (k) => { n[k] = o[k]; }); return n; };
  const ownIndex = (arr, i, value) => defineProperty(arr, i, { value, writable: true, enumerable: true, configurable: true });
  const [wmGet, wmSet, wmHas, wmDelete] = ["get", "set", "has", "delete"].map((k) => uncurry(WeakMap.prototype[k]));
  const [wsAdd, wsHas] = ["add", "has"].map((k) => uncurry(WeakSet.prototype[k]));
  const deref = uncurry(WeakRef.prototype.deref);
  // Appends without consulting Array.prototype: a swallowing setter the
  // page defined there must not eat the guard's own bookkeeping.
  const push = (list, value) => {
    defineProperty(list, list.length, { value, writable: true, enumerable: true, configurable: true });
    return list.length;
  };
  const addListener = uncurry(EventTarget.prototype.addEventListener);
  const removeListener = uncurry(EventTarget.prototype.removeEventListener);
  const nodeType = getter(Node.prototype, "nodeType");
  const ownerDocument = getter(Node.prototype, "ownerDocument");
  const parentElement = getter(Node.prototype, "parentElement");
  const isConnected = getter(Node.prototype, "isConnected");
  const getRootNode = uncurry(Node.prototype.getRootNode);
  const localName = getter(Element.prototype, "localName");
  const getAttr = uncurry(Element.prototype.getAttribute);
  const hasAttr = uncurry(Element.prototype.hasAttribute);
  const hasAttrNS = uncurry(Element.prototype.hasAttributeNS);
  const matches = uncurry(Element.prototype.matches);
  const elQuery = uncurry(Element.prototype.querySelector);
  const docQuery = uncurry(Document.prototype.querySelector);
  const docQueryAll = uncurry(Document.prototype.querySelectorAll);
  const setAttr = uncurry(Element.prototype.setAttribute);
  // Own indexed element of a NodeList: poisoned Array/NodeList prototype
  // members must not affect the walk.
  const eachNode = (nl, fn) => {
    if (!nl) return;
    for (let i = 0; ; i++) {
      let n;
      try { n = ownDesc(nl, i)?.value; } catch { return; }
      if (n === undefined) return;
      fn(n);
    }
  };
  const defaultView = getter(Document.prototype, "defaultView");
  const evType = getter(Event.prototype, "type");
  const evTarget = getter(Event.prototype, "target");
  const defaultPrevented = getter(Event.prototype, "defaultPrevented");
  const composedPath = uncurry(Event.prototype.composedPath);
  const preventDefault = uncurry(Event.prototype.preventDefault);
  const mouseKey = (k) => { const get = getter(MouseEvent.prototype, k); return (e) => { try { return get(e); } catch { return k === "button" ? 0 : false; } }; };
  const [ctrlKey, metaKey, shiftKey, button] = ["ctrlKey", "metaKey", "shiftKey", "button"].map(mouseKey);
  const submitterGet = getter(SubmitEvent.prototype, "submitter");
  const submitterOf = (e) => { try { return submitterGet(e); } catch { return null; } };
  const buttonForm = getter(HTMLButtonElement.prototype, "form");
  const inputForm = getter(HTMLInputElement.prototype, "form");
  const baseURI = getter(Node.prototype, "baseURI");
  const URLC = URL;
  const iframeWindow = getter(HTMLIFrameElement.prototype, "contentWindow");
  const [winName, winLength, winOrigin, winFrameElement, winTop] =
    ["name", "length", "origin", "frameElement", "top"].map((k) => getter(window, k));
  const setTimer = setTimeout.bind(window);
  const [WeakMapC, WeakRefC] = [WeakMap, WeakRef];
  // Every window.open the guard itself saw at install time, in any realm.
  // The page can never obtain another copy of the native one: the guard is
  // installed before page script runs and its wrappers report native source.
  const nativeOpens = new WeakSet();
  // Index loops only from here on: for...of and spreading use iterators a
  // page can replace.
  const each = (list, fn) => { for (let i = 0; i < list.length; i++) fn(list[i]); };
  const info = console.info.bind(console);
  const rejectWith = Promise.reject.bind(Promise);

  // removed: arm.js found the page unlisted and the guard took itself out.
  const state = { armed: false, removed: false };
  const nativeOf = new WeakMap(); // wrapper -> the function it stands in for
  const listenedRoots = new WeakSet(); // shadow roots with our listeners

  let logged = 0;
  function log(what, detail) {
    // Some ad scripts retry many times a second; don't flood the console.
    if (++logged <= 20) info("[no-new-tabs] blocked", what, detail ?? "");
    else if (logged === 21) info("[no-new-tabs] further blocks on this page not logged");
  }

  function wrap(native, replacement) {
    wmSet(nativeOf, replacement, native);
    each(["name", "length"], (key) => {
      try { defineProperty(replacement, key, nullProto({ value: native[key], configurable: true })); } catch {}
    });
    return replacement;
  }

  // Marks a window the guard is installed in, and says whether it is armed.
  // A frame or popup of an armed page is armed from birth.
  const MARK = "__noNewTabsGuard";
  for (const rel of ["parent", "opener"]) {
    try {
      const other = window[rel];
      if (other && other !== window && other[MARK]?.() === true) state.armed = true;
    } catch {} // cross-origin: arm.js decides
  }

  // Only arm.js can arm or remove the guard: it hands over a secret before
  // any page script runs.
  let secret = null;
  addListener(window, "__no_new_tabs_hello__", (e) => { secret ??= `${e.detail}`; }, nullProto({ once: true }));
  const detailGet = getter(CustomEvent.prototype, "detail");
  const fromArmJs = (e) => { try { return secret !== null && detailGet(e) === secret; } catch { return false; } };
  // Arm-only: nothing can switch it back off without a reload.
  const onArm = (e) => { if (fromArmJs(e)) arm(); };
  // arm.js says this page is not listed: remove the guard.
  const onUnlisted = (e) => { if (!state.armed && fromArmJs(e)) uninstallAll(); };
  const listenControl = () => {
    addListener(window, "__no_new_tabs_arm__", onArm);
    addListener(window, "__no_new_tabs_unlisted__", onUnlisted);
  };
  listenControl();
  // document.open() drops every listener on the window and document, and
  // relisten() only runs while installed: after the guard removed itself on
  // an unlisted page, a rewrite would drop these control listeners for
  // good, so a later arm signal (the site was added to the list) would
  // never be heard. Observers survive document.open(), so keep one that
  // puts the control listeners back even while uninstalled. Re-adding is
  // a no-op on an intact document. Not part of undo: uninstalling must
  // not remove it.
  const MutationObserverC = MutationObserver;
  new MutationObserverC(() => listenControl()).observe(document, nullProto({ childList: true }));

  function arm() {
    state.armed = true;
    state.removed = false;
    install(window); // in case it was removed as unlisted
    forEachRecord((rec) => rec.lock());
    sweep(window);
    tameDocument(document);
  }

  // --- Where does a target name lead? ---------------------------------------

  const startsWith = (s, prefix) => strSlice(s, 0, prefix.length) === prefix;

  // Is there a frame with this name the caller may navigate? Navigating it
  // doesn't open anything new. Only frames on the caller's own origin
  // count: the browser may refuse to let a page navigate another origin's
  // frame, and open a new window instead. A sandboxed frame may only
  // navigate itself and the frames inside it. Names are read with the
  // browser's own getter, so a page that redefines window.name can't fool it.
  function frameNamed(name, from) {
    let root;
    try { root = isSandboxed(from) ? from : winTop(from); } catch { return false; }
    const stack = [root];
    const seen = [];
    for (let n = 0; stack.length && n < 500; n++) {
      const w = stack[stack.length - 1];
      stack.length--;
      try { if (winName(w) === name) return true; } catch {} // other origin: not counted
      push(seen, w);
      let count = 0;
      try { count = winLength(w); } catch {}
      for (let i = 0; i < count; i++) {
        let child;
        try { child = w[i]; } catch { continue; }
        if (child) ownIndex(stack, stack.length, child);
      }
    }
    // A named frame showing another site has no readable window.name, but
    // Chrome still navigates it instead of opening a tab. Match the name
    // attributes in the same documents the window walk could read.
    for (let i = 0; i < seen.length; i++) {
      let doc = null;
      try { doc = seen[i].document; } catch { continue; }
      let nl = null;
      try { nl = docQueryAll(doc, "iframe[name],frame[name]"); } catch { continue; }
      let found = false;
      eachNode(nl, (el) => {
        let a = null;
        try { a = getAttr(el, "name"); } catch {}
        if (a === name) found = true;
      });
      if (found) return true;
    }
    return false;
  }

  function isSandboxed(win) {
    try {
      if (winOrigin(win) === "null") return true;
      const el = winFrameElement(win);
      return !!el && hasAttr(el, "sandbox");
    } catch { return false; }
  }

  // Does this target name open a new browsing context, seen from `win`?
  // Matched as the browser does: untrimmed, ASCII case-insensitive.
  function opensNew(target, win) {
    const t = `${target ?? ""}`;
    if (t === "") return false;
    const k = toLower(t);
    if (k === "_self" || k === "_parent" || k === "_top") return false;
    if (t[0] === "_") return true; // _blank, _new, ...
    return !win || !frameNamed(t, win);
  }

  // PopAds blanks a page with open("about:blank", "_self"): block about:
  // and javascript: URLs aimed in-tab, where they'd run in place of the
  // page. Aimed at a named frame they reset it instead of opening anything.
  function blanksPage(url, target) {
    if (!inertUrl(url)) return false;
    const t = toLower(`${target ?? ""}`);
    return t === "_self" || t === "_top" || t === "_parent";
  }
  // As the URL parser does, ignore leading spaces and control characters,
  // and tabs and newlines anywhere.
  function inertUrl(url) {
    const s = `${url ?? ""}`;
    let scheme = "";
    for (let i = 0; i < s.length && scheme.length < 11; i++) {
      const c = charAt(s, i);
      if (c === 9 || c === 10 || c === 13 || (c <= 32 && scheme === "")) continue;
      scheme += s[i];
    }
    scheme = toLower(scheme);
    return startsWith(scheme, "about:") || startsWith(scheme, "javascript:");
  }
  // For window.open a missing or empty name means _blank (for links, _self).
  const openTarget = (name) => (name == null || name === "" ? "_blank" : name);
  // Read url and name once, as strings: an object could say "_self" to us
  // and "_blank" to the browser.
  function readArgs(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) ownIndex(out, i, i < 2 && args[i] != null ? `${args[i]}` : args[i]);
    return out;
  }

  const viewOf = (node) => { try { return defaultView(ownerDocument(node)); } catch { return null; } };
  const isElement = (n) => { try { return nodeType(n) === 1; } catch { return false; } };
  const baseTarget = (doc) => {
    const base = doc && docQuery(doc, "base[target]");
    return (base && getAttr(base, "target")) ?? "";
  };
  // A target with a tab or newline and a "<" is treated as _blank.
  function cleanTarget(t) {
    let space = false;
    for (let i = 0; i < t.length; i++) { const c = charAt(t, i); if (c === 9 || c === 10 || c === 13) space = true; }
    return space && strIndex(t, "<") >= 0 ? "_blank" : t;
  }
  const linkTarget = (a) => cleanTarget(getAttr(a, "target") ?? baseTarget(ownerDocument(a)));
  const formTarget = (form, submitter) => {
    const own = submitter && isElement(submitter) ? getAttr(submitter, "formtarget") : null;
    return cleanTarget(own ?? getAttr(form, "target") ?? baseTarget(ownerDocument(form)));
  };
  const XLINK = "http://www.w3.org/1999/xlink";
  const isLink = (n) => isElement(n) &&
    (matches(n, "a[href], area[href]") || (localName(n) === "a" && hasAttrNS(n, XLINK, "href")));
  const isSubmit = (n) => isElement(n) &&
    matches(n, "button:not([type=button]):not([type=reset]):not([type=menu]), input[type=submit], input[type=image]");
  const formOf = (el) => { try { return localName(el) === "button" ? buttonForm(el) : inputForm(el); } catch { return null; } };
  const closestLink = (el) => {
    for (let n = el; n; n = parentElement(n)) if (isLink(n)) return n;
    return null;
  };
  const find = (list, test) => {
    for (let i = 0; i < list.length; i++) if (test(list[i])) return list[i];
    return undefined;
  };
  // The console shows where the tab would have gone, resolved the way the
  // browser resolves it — not the raw attribute.
  const resolveUrl = (node, value) => {
    try {
      const v = value ?? "";
      if (v === "") return "";
      return new URLC(v, baseURI(ownerDocument(node)) ?? undefined).href;
    } catch { return value ?? ""; }
  };
  const linkUrl = (a) => resolveUrl(a, getAttr(a, "href") ?? getAttr(a, "xlink:href"));
  const formUrl = (form) => resolveUrl(form, getAttr(form, "action"));

  // --- Child frames ---------------------------------------------------------

  // Guard a same-origin child window (and its children). Cross-origin ones
  // throw on access and get their own copy of guard.js from the browser.
  // Frames sandboxed without allow-scripts are guarded too: they run no
  // script of their own, but with allow-same-origin the page can call
  // their window.open.
  function adopt(win) {
    // Removed (page is unlisted): install() already refuses, and the walk
    // below would still cost a subtree scan on every adopted read.
    if (!win || state.removed) return;
    try {
      install(win);
      sweep(win);
    } catch {}
  }

  function sweep(win) {
    let n = 0;
    try { n = winLength(win); } catch { return; }
    for (let i = 0; i < n; i++) {
      let child;
      try { child = win[i]; } catch { continue; }
      adopt(child);
    }
  }

  // A frame the parent can never adopt (opaque origin: no allow-scripts and
  // no allow-same-origin) with allow-popups opens a tab the guard can't
  // stop. On listed pages, take allow-popups away before it navigates: the
  // click then does nothing instead of flashing. Left alone when the frame
  // can run scripts (its own guard copy covers it) or is same-origin (the
  // parent's adoption covers it).
  const hasSandboxToken = (value, token) => {
    const s = `${value ?? ""}`;
    let cur = "";
    for (let i = 0; i <= s.length; i++) {
      const c = i < s.length ? charAt(s, i) : 32;
      if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13) {
        if (toLower(cur) === token) return true;
        cur = "";
      } else cur += s[i];
    }
    return false;
  };
  const stripPopups = (value) => {
    const s = `${value ?? ""}`;
    if (!hasSandboxToken(s, "allow-popups")) return s;
    if (hasSandboxToken(s, "allow-scripts") || hasSandboxToken(s, "allow-same-origin")) return s;
    let out = "", cur = "";
    const flush = () => {
      if (cur !== "" && toLower(cur) !== "allow-popups") out += (out === "" ? "" : " ") + cur;
      cur = "";
    };
    for (let i = 0; i <= s.length; i++) {
      const c = i < s.length ? charAt(s, i) : 32;
      if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13) flush();
      else cur += s[i];
    }
    flush();
    return out;
  };
  const tameSandbox = (el) => {
    try {
      const v = getAttr(el, "sandbox");
      if (v == null) return;
      const stripped = stripPopups(v);
      if (stripped !== v) apply(setAttr, el, ["sandbox", stripped]);
    } catch {}
  };
  const tameDocument = (doc) => {
    if (!state.armed || !doc) return;
    try {
      let nl = null;
      try { nl = docQueryAll(doc, "iframe[sandbox]"); } catch { return; }
      eachNode(nl, tameSandbox);
    } catch {}
  };

  // --- Install into one window (this one, or an adopted child) --------------

  // Keyed by the realm's own Function, which a page can't fake or carry over
  // to a new document (unlike a property on the window).
  const records = new WeakMap(); // realm Function -> { undo, lock, relisten }
  const realms = []; // WeakRefs to the realm Functions in `records`

  function forEachRecord(fn) {
    for (let i = 0; i < realms.length; i++) {
      const realm = deref(realms[i]);
      const rec = realm && wmGet(records, realm);
      if (rec) fn(rec, realm);
    }
  }

  function uninstallAll() {
    state.removed = true; // copies of our wrappers the page kept must not put it back
    forEachRecord((rec, realm) => {
      for (let i = rec.undo.length - 1; i >= 0; i--) try { rec.undo[i](); } catch {}
      wmDelete(records, realm);
    });
    realms.length = 0;
  }

  // After document.open() or a write that replaces the document, the
  // browser drops every listener on the window and document: add ours back.
  // The record is keyed by the realm's Function, which a page can replace,
  // so fall back to matching the window itself.
  function relisten(doc) {
    try {
      const win = defaultView(doc);
      if (!win) return;
      const hit = wmGet(records, win.Function);
      if (hit) hit.relisten();
      else forEachRecord((rec) => { if (rec.win === win) rec.relisten(); });
      if (win === window) listenControl();
    } catch {}
  }

  function install(win) {
    if (state.removed) return;
    const realm = win.Function; // throws for cross-origin
    if (wmHas(records, realm)) return;
    // Another copy of the guard (the frame's own, or the parent's adopting
    // it) is already installed here.
    if (ownDesc(win, MARK)) return;
    const undo = [];
    const listeners = [];
    const rec = {
      win,
      undo,
      lock: () => {},
      relisten: () => each(listeners, (l) => addListener(l[0], l[1], l[2], true)),
    };
    wmSet(records, realm, rec);
    push(realms, new WeakRefC(realm));

    // Replace obj[key] (described by desc) with value; undo puts the
    // original back if it is still ours.
    const patch = (obj, key, value, desc = { value, writable: true, configurable: true }) => {
      desc = nullProto(desc);
      const before = ownDesc(obj, key);
      defineProperty(obj, key, desc);
      push(undo, () => {
        const now = ownDesc(obj, key);
        if (now && now.value === desc.value && now.get === desc.get && now.set === desc.set) {
          if (before) defineProperty(obj, key, nullProto(before));
          else delete obj[key];
        }
      });
    };
    // Wrap a method of obj: make(native) returns the replacement.
    const method = (obj, key, make) => {
      const native = obj && ownDesc(obj, key)?.value;
      if (typeof native === "function") patch(obj, key, wrap(native, make(native, key)));
    };
    // Wrap an accessor's setter.
    const setter = (obj, key, make) => {
      const desc = obj && ownDesc(obj, key);
      if (desc?.set) patch(obj, key, null, { ...desc, set: wrap(desc.set, make(desc.set, key)) });
    };
    const listen = (target, type, fn) => {
      addListener(target, type, fn, true);
      push(listeners, [target, type, fn]);
      push(undo, () => removeListener(target, type, fn, true));
    };

    const mark = () => state.armed;
    patch(win, MARK, mark, { value: mark, writable: false, enumerable: false, configurable: true });

    // Function.prototype.toString reports native source for our wrappers.
    const fnProto = win.Function.prototype;
    const nativeToString = ownDesc(fnProto, "toString").value;
    const toString = {
      toString() {
        let fn = this;
        while (wmHas(nativeOf, fn)) fn = wmGet(nativeOf, fn);
        return apply(nativeToString, fn, []);
      },
    }.toString;
    wmSet(nativeOf, toString, nativeToString);
    patch(fnProto, "toString", toString);

    // 1. window.open -> returns null, as if a popup blocker stopped it.
    //    Opens that stay in this tab (_self, _top, a named iframe) go
    //    through. Until the page is armed it stays a plain property, so
    //    code that saves and restores its descriptor works as usual; once
    //    armed it becomes a fixed accessor, so whatever the page assigns
    //    stays guarded too.
    const nativeOpen = ownDesc(win, "open")?.value;
    if (typeof nativeOpen === "function") wsAdd(nativeOpens, nativeOpen);
    const guardedOpen = new WeakMapC();
    const guarded = (fn) => {
      if (typeof fn !== "function") return fn;
      if (!wmHas(guardedOpen, fn)) {
        wmSet(guardedOpen, fn, wrap(fn, {
          open(...args) {
            const self = this ?? win; // a bare open() call means this window
            if (!state.armed) return apply(fn, self, args);
            args = readArgs(args);
            const target = openTarget(args[1]);
            if (blanksPage(args[0], target)) {
              log("window.open", args[0]);
              return null;
            }
            let view = null;
            try { view = self.window; } catch {}
            if (!opensNew(target, view)) return apply(fn, self, args);
            log("window.open", args[0]);
            return null;
          },
        }.open));
      }
      return wmGet(guardedOpen, fn);
    };
    // A function the page wrote itself (an analytics hook, say) is handed
    // back as is, so `window.open === myHook` holds; whatever it calls is
    // guarded. Only functions seen as window.open in an installed realm
    // count as built-in: bound functions, proxies and hooks whose source
    // mentions "[native code]" are returned as they are.
    const pageWritten = (fn) => typeof fn === "function" && !wsHas(nativeOpens, fn);
    const isOurs = (fn) => typeof fn === "function" && wmGet(guardedOpen, wmGet(nativeOf, fn)) === fn;
    patch(win, "open", guarded(nativeOpen), { value: guarded(nativeOpen), writable: true, enumerable: true, configurable: true });
    rec.lock = () => {
      const d = ownDesc(win, "open");
      if (!d || d.configurable) {
        let current = d ? ("value" in d ? d.value : d.get && apply(d.get, win, [])) : undefined;
        if (isOurs(current)) current = wmGet(nativeOf, current);
        const { get, set } = ownDesc({
          get open() { return pageWritten(current) ? current : guarded(current); },
          set open(value) { current = value; },
        }, "open");
        wmSet(nativeOf, get, nativeOpen);
        try { defineProperty(win, "open", nullProto({ get, set, enumerable: true, configurable: false })); } catch {}
      }
      try { defineProperty(win, MARK, nullProto({ configurable: false })); } catch {}
    };
    if (state.armed) rec.lock();

    // document.open with three arguments is an alias for window.open. With
    // fewer, it (like a write after load) replaces the document, and the
    // browser drops our listeners.
    method(win.Document.prototype, "open", (native) => ({
      open(...args) {
        if (state.armed && args.length >= 3) {
          args = readArgs(args);
          const target = openTarget(args[1]);
          if (blanksPage(args[0], target) || opensNew(target, defaultView(this))) {
            log("document.open", args[0]);
            return null;
          }
        }
        // relisten() stays even when removed: a rewrite drops the control
        // listeners, and a later arm signal must still be heard.
        try { return apply(native, this, args); } finally { relisten(this); if (!state.removed) sweepFrom(this); }
      },
    }.open));
    each(["write", "writeln"], (key) => method(win.Document.prototype, key, (native) => ({
      [key]() {
        try { return apply(native, this, arguments); } finally { relisten(this); if (!state.removed) sweepFrom(this); }
      },
    }[key])));

    // form.submit() skips the submit event, so check it directly. So does
    // requestSubmit() for a form whose submit event can't reach us (in a
    // shadow root the browser built from HTML); elsewhere it runs as usual
    // (validation, the page's submit handlers) and onSubmit cancels it.
    const unheard = (node) => {
      const root = getRootNode(node);
      return root !== ownerDocument(node) && !wsHas(listenedRoots, root);
    };
    method(win.HTMLFormElement.prototype, "submit", (native) => ({
      submit() {
        if (state.armed && opensNew(formTarget(this), viewOf(this))) {
          log("form.submit()", formUrl(this));
          return;
        }
        return apply(native, this, []);
      },
    }.submit));
    method(win.HTMLFormElement.prototype, "requestSubmit", (native) => ({
      requestSubmit() {
        // Run as usual — validation, the page's handlers — and let onSubmit
        // cancel it late if it still opens a new context. Make sure the
        // submit is heard even inside a shadow root the browser built.
        if (state.armed) ensureSubmitHeard(this);
        return apply(native, this, arguments);
      },
    }.requestSubmit));

    // 2. A link outside the document (detached, or in a shadow root the
    //    browser built from HTML, which has no listener of ours) never shows
    //    up in the click listeners below, so catch .click() and
    //    dispatchEvent() on those directly.
    const hiddenLinkOpensNew = (el, event) => {
      if (!state.armed || !isElement(el)) return false;
      if (isConnected(el) && !unheard(el)) return false;
      const link = closestLink(el);
      if (!link) return false;
      const modifier = !!event && (ctrlKey(event) || metaKey(event) || shiftKey(event) || button(event) === 1);
      if (hasAttr(link, "download") && !modifier) return false; // a download, not a tab
      return modifier || opensNew(linkTarget(link), viewOf(link));
    };
    method(win.HTMLElement.prototype, "click", (native) => ({
      click() {
        if (hiddenLinkOpensNew(this)) {
          log("link .click()", linkUrl(closestLink(this)));
          return;
        }
        return apply(native, this, []);
      },
    }.click));
    method(win.EventTarget.prototype, "dispatchEvent", (native) => ({
      dispatchEvent(event) {
        let type = "";
        try { type = evType(event); } catch {}
        if ((type === "click" || type === "auxclick") && hiddenLinkOpensNew(this, event)) {
          log("link dispatchEvent", linkUrl(closestLink(this)));
          return false;
        }
        return apply(native, this, arguments);
      },
    }.dispatchEvent));

    // A document picture-in-picture window is a new window too.
    method(win.DocumentPictureInPicture?.prototype, "requestWindow", (native) => ({
      requestWindow() {
        if (state.armed) {
          log("picture-in-picture window");
          return rejectWith(new win.DOMException("Blocked by No New Tabs", "NotAllowedError"));
        }
        return apply(native, this, arguments);
      },
    }.requestWindow));

    // 3. Same-origin frames are adopted the moment they appear, before the
    //    page can save their window.open: when a frame is inserted, when its
    //    first document loads, and when the page reaches into it.
    each(["HTMLIFrameElement", "HTMLFrameElement", "HTMLObjectElement"], (name) => {
      const proto = win[name]?.prototype;
      if (!proto) return;
      each(["contentWindow", "contentDocument"], (prop) => {
        const desc = ownDesc(proto, prop);
        if (!desc?.get) return;
        const nativeGet = desc.get;
        const get = ownDesc({
          get [prop]() {
            const value = apply(nativeGet, this, []);
            try { adopt(prop === "contentWindow" ? value : value && defaultView(value)); } catch {}
            return value;
          },
        }, prop).get;
        patch(proto, prop, null, { ...desc, get: wrap(nativeGet, get) });
      });
    });

    // Post-insertion sandbox escalation: strip allow-popups the same way
    // no matter how it is set, and tame the IDL setter too (it reflects to
    // the attribute without going through setAttribute).
    method(win.Element.prototype, "setAttribute", (native) => ({
      setAttribute() {
        if (state.armed && arguments.length >= 2 && isElement(this)) {
          let k = "";
          try { k = toLower(`${arguments[0]}`); } catch {}
          if (k === "sandbox" && localName(this) === "iframe") {
            try { arguments[1] = stripPopups(`${arguments[1] ?? ""}`); } catch {}
          }
        }
        return apply(native, this, arguments);
      },
    }.setAttribute));
    setter(win.HTMLIFrameElement?.prototype, "sandbox", (native) => function (v) {
      let value = v;
      try { if (state.armed) value = stripPopups(value); } catch {}
      return apply(native, this, [value]);
    });

    // Any insertion that adds a frame to a window: adopt the new frames
    // before the call returns.
    const FRAME_SELECTOR = "iframe, frame, object, embed";
    const childWindow = (el) => {
      try { return iframeWindow(el); } catch { try { return el.contentWindow; } catch { return null; } }
    };
    // Adopt only what this call could have added: the inserted nodes
    // themselves, wherever they landed. String HTML (innerHTML and
    // friends) can land anywhere, so only a sweep is sure to find those
    // frames.
    const adoptAdded = (view, before, after, args) => {
      if (!view) return;
      let nodes = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!isElement(a)) continue;
        nodes = true;
        try { if (matches(a, FRAME_SELECTOR)) adopt(childWindow(a)); } catch {}
        let nl = null;
        try { nl = elQuery(a, FRAME_SELECTOR); } catch {}
        if (nl) eachNode(nl, (el) => { try { adopt(childWindow(el)); } catch {} });
      }
      if (!nodes && after > before) sweep(view);
    };
    // A page can shadow startContainer on Node.prototype, so only trust
    // each realm's own Range getter, and only on a real Range of that realm.
    let rangeStart = null;
    try { rangeStart = getter(win.Range.prototype, "startContainer"); } catch {}
    const viewOfTarget = (self) => {
      try {
        let node = self;
        if (rangeStart) { try { node = rangeStart(self) ?? self; } catch { node = self; } }
        return nodeType(node) === 9 ? defaultView(node) : viewOf(node);
      } catch { return null; }
    };
    const framesAfter = (native, key) => ({
      [key]() {
        // Unlisted and removed: a plain call-through, so wrappers a page
        // script saved earlier cost nothing and run no extension code. (A
        // page that is merely not yet armed keeps adoption below: it could
        // otherwise save a frame's native window.open before arming.)
        if (state.removed) return apply(native, this, arguments);
        const view = viewOfTarget(this);
        let before = -1;
        try { before = view ? winLength(view) : -1; } catch {}
        try {
          return apply(native, this, arguments);
        } finally {
          let after = before;
          try { after = view ? winLength(view) : -1; } catch {}
          adoptAdded(view, before, after, arguments);
          // Tame script-inserted iframes at once; parser-inserted ones are
          // caught by the observer below, which sees the same count change.
          if (state.armed) for (let i = 0; i < arguments.length; i++) {
            const a = arguments[i];
            if (isElement(a) && matches(a, "iframe")) tameSandbox(a);
          }
        }
      },
    })[key];
    const insertions = [
      [win.Node?.prototype, ["appendChild", "insertBefore", "replaceChild"]],
      [win.Element?.prototype, ["append", "prepend", "before", "after", "replaceWith", "replaceChildren",
        "insertAdjacentElement", "insertAdjacentHTML", "setHTMLUnsafe"]],
      [win.CharacterData?.prototype, ["before", "after", "replaceWith"]],
      [win.DocumentType?.prototype, ["before", "after", "replaceWith"]],
      [win.Document?.prototype, ["append", "prepend", "replaceChildren"]],
      [win.ShadowRoot?.prototype, ["setHTMLUnsafe"]],
      [win.Range?.prototype, ["insertNode", "surroundContents"]],
    ];
    each(insertions, (pair) => each(pair[1], (key) => method(pair[0], key, framesAfter)));
    each([win.Element?.prototype, win.ShadowRoot?.prototype], (proto) =>
      each(["innerHTML", "outerHTML"], (key) => setter(proto, key, framesAfter)));
    const sweepFrom = (doc) => { try { sweep(defaultView(doc)); } catch {} };
    // The parser inserts frames without any of the calls above; it lets
    // observers run before the next script.
    let known = 0;
    const observer = new win.MutationObserver(() => {
      let n = known;
      try { n = winLength(win); } catch {}
      if (n !== known) {
        known = n;
        sweep(win);
        tameDocument(win.document);
      }
    });
    observer.observe(win.document, nullProto({ childList: true, subtree: true }));
    push(undo, () => observer.disconnect());
    listen(win.document, "load", (e) => {
      try {
        const el = evTarget(e);
        if (!isElement(el) || !matches(el, FRAME_SELECTOR)) return;
        if (matches(el, "iframe")) tameSandbox(el);
        let child = null;
        try { child = iframeWindow(el); } catch { child = el.contentWindow; } // <frame>, <object>
        adopt(child);
      } catch {}
    });

    // 4. Links: target=_blank, ctrl/cmd/shift-click and middle-click.
    //    The page's own handlers run after this and may switch the target
    //    back to _self, so the decision happens in the late check: if the
    //    target still opens a new context then, cancel. (A page that stops
    //    propagation beats the late check; see Known gaps.)
    const later = (e, opensNow, what, url, scope) => {
      const late = (ev) => {
        try {
          if (ev === e && state.armed && !defaultPrevented(e) && opensNow()) {
            preventDefault(e);
            log(what, url());
          }
        } catch {
          // Out of stack (or worse): cancel rather than let the tab through.
          try { preventDefault(e); } catch {}
        }
      };
      const type = evType(e);
      addListener(scope, type, late, nullProto({ once: true }));
      // Not left behind if the page stops the event before it gets back here.
      setTimer(() => removeListener(scope, type, late), 0);
    };
    // The late re-check must listen where the event can reach: the window
    // for document nodes, the shadow root itself for nodes inside one
    // (submit events and non-composed clicks don't leave a shadow root).
    const lateScopeOf = (node) => {
      try {
        const root = getRootNode(node);
        if (root && root !== ownerDocument(node)) return root;
      } catch {}
      return win;
    };
    // A submit event fires where no listener of ours is (yet): a form in a
    // shadow root the browser built, or a detached form. Make sure one is.
    const ensureSubmitHeard = (form) => {
      if (!state.armed) return;
      try {
        const root = getRootNode(form);
        if (root && root !== ownerDocument(form) && !wsHas(listenedRoots, root)) {
          addListener(root, "submit", onSubmit, true);
          wsAdd(listenedRoots, root);
        }
      } catch {}
    };
    // Fail closed: if the guard itself throws while examining an event
    // (stack exhaustion is the known way), cancel it rather than let the
    // tab through. preventDefault cannot come first: that would cancel
    // every benign click too.
    function onActivate(e) {
      if (!state.armed || defaultPrevented(e)) return; // handled further out
      try {
        const path = composedPath(e);
        const type = evType(e);
        const modifier = ctrlKey(e) || metaKey(e) || shiftKey(e);
        // A script can dispatch a "click" with button 1, which the browser
        // treats as a middle click. later() reuses opens() below, so this
        // covers the re-check too.
        const middle = button(e) === 1 && (type === "auxclick" || type === "click");

        const link = find(path, isLink);
        if (link) {
          if (hasAttr(link, "download") && !middle && !modifier) return;
          if (middle || modifier) {
            // A modifier or middle click opens a new context no matter what
            // the target says, so even a late switch to _self can't save it.
            preventDefault(e);
            log("link", linkUrl(link));
          } else {
            const opens = () => type === "click" && opensNew(linkTarget(link), viewOf(link));
            later(e, opens, "link", () => linkUrl(link), lateScopeOf(link));
          }
          return;
        }

        // A submit button: the click itself opens nothing; its submit
        // decides. A middle or modifier click always opens a new context,
        // so cancel those; otherwise make sure the submit is heard even
        // inside a shadow root the browser built, then leave the click
        // alone: onSubmit cancels it late if it still opens a new context.
        const submit = find(path, isSubmit);
        const form = submit && formOf(submit);
        if (form) {
          if (middle || modifier) {
            preventDefault(e);
            log("form submit", formUrl(form));
          } else if (type === "click") {
            ensureSubmitHeard(form);
          }
        }
      } catch {
        try { preventDefault(e); } catch {}
      }
    }

    // 5. Forms: target=_blank on the form, the submit button or <base>.
    function onSubmit(e) {
      const form = evTarget(e);
      if (!state.armed || !isElement(form) || localName(form) !== "form") return;
      try {
        const opens = () => opensNew(formTarget(form, submitterOf(e)), viewOf(form));
        later(e, opens, "form submit", () => formUrl(form), lateScopeOf(form));
      } catch {
        try { preventDefault(e); } catch {}
      }
    }

    listen(win, "click", onActivate);
    listen(win, "auxclick", onActivate);
    listen(win, "submit", onSubmit);

    // Clicks inside a closed shadow root hide the link from the listener
    // above, and submit events don't leave a shadow root at all, so listen
    // inside every shadow root as well.
    method(win.Element.prototype, "attachShadow", (native) => ({
      attachShadow() {
        const root = apply(native, this, arguments);
        addListener(root, "click", onActivate, true);
        addListener(root, "auxclick", onActivate, true);
        addListener(root, "submit", onSubmit, true);
        wsAdd(listenedRoots, root);
        return root;
      },
    }.attachShadow));

    // 6. Before any page handler sees user input, adopt frames the page
    //    reaches through window[n] or frames[n] without touching the
    //    element. Only frames that existed before the input can open a
    //    popup, since a new frame has no user activation.
    const onInput = () => { if (state.armed) sweep(win); };
    each(["pointerdown", "mousedown", "pointerup", "keydown", "touchstart", "touchend", "click"], (type) => listen(win, type, onInput));
  }

  install(window);
})();
