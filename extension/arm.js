// Isolated-world partner of guard.js. Decides whether this frame should be
// guarded and, if so, arms guard.js (which runs in the page's own world).
// If not, it tells guard.js to remove itself, so unlisted pages run
// untouched.
//
// A frame is guarded when it, or any frame above it, is on a listed site.
// location.ancestorOrigins answers that without a round trip; when the
// browser hides an ancestor ("null"), the background worker is asked
// instead, since it knows the tab's URL.

(() => {
  let armed = false;

  // Runs before any page script, so only guard.js hears the secret, and a
  // page can't send a fake "arm" or "unlisted". (crypto.randomUUID is
  // missing on plain-http pages, getRandomValues is not.)
  const secret = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(36)).join("-");
  const tell = (type) => window.dispatchEvent(new CustomEvent(type, { detail: secret }));
  tell("__no_new_tabs_hello__");

  function arm() {
    if (armed) return;
    armed = true;
    tell("__no_new_tabs_arm__");
  }

  function unlisted() {
    if (!armed) tell("__no_new_tabs_unlisted__");
  }

  // match.js runs just before this file, in this same isolated world.
  const blocked = globalThis.NoNewTabsMatch.isListed;
  const hostOf = (origin) => {
    try { return new URL(origin).hostname; } catch { return ""; }
  };

  async function check(domains) {
    if (armed) return;
    if (!domains.length) return unlisted();
    // The origin, not the address: a blob: page or an about:blank belongs
    // to the site that made it.
    if (blocked(hostOf(self.origin), domains) || blocked(location.hostname, domains)) return arm();
    // A top-level page is only worth asking about if a page opened it
    // (a popup that escaped), or if it has no site of its own (a blob: page
    // made in a sandboxed frame): the background knows where it came from.
    const opaque = self.origin === "null";
    if (window === window.top && !window.opener && !opaque) return unlisted();
    if (window === window.top) return ask();

    const ancestors = [...(location.ancestorOrigins ?? [])];
    if (ancestors.some((o) => blocked(hostOf(o), domains))) return arm();
    if (ancestors.length && !ancestors.includes("null")) return unlisted();
    return ask();
  }

  async function ask() {
    const reply = await chrome.runtime.sendMessage({ type: "inListedTab" }).catch(() => null);
    if (reply?.listed) arm();
    else unlisted();
  }

  chrome.storage.sync.get("domains").then(({ domains = [] }) => check(domains));
  // Sites added while a page is open get guarded without a reload.
  // Only the sync area: the background's frequent session-storage writes
  // must not wake every frame of every page.
  chrome.storage.sync.onChanged.addListener((changes) => {
    if (changes.domains) check(changes.domains.newValue ?? []);
  });

  // A context menu the user opens on a guarded page: what they pick from it
  // (search for the selected text, open an image or video) opens a tab of
  // their own, so the background lets that tab through: if its address is
  // one of those the menu offers. Opening the site's links in new tabs
  // stays blocked. This runs in the extension's own world, so the page
  // can't change what it reads — but the selection and the images under
  // the pointer can be arranged by the page, so the record carries only
  // what the checks below allow.
  let menuOpen = false;
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
  const readSelection = () => {
    let selection = String(getSelection() ?? "");
    const field = document.activeElement;
    if (!selection && typeof field?.selectionStart === "number") {
      try { selection = field.value.slice(field.selectionStart, field.selectionEnd); } catch {}
    }
    return selection;
  };
  // The selection as it was when the right button went down, before any
  // mousedown handler of the page could replace it for the menu to offer.
  let pressSelection = null;
  const sameLink = (el, src) => {
    try {
      const a = el.closest("a");
      if (!a || !a.href) return false;
      return !!src && new URL(a.href, location.href).href === new URL(src, location.href).href;
    } catch {
      return false;
    }
  };
  // Image addresses the menu may offer for one element. The browser
  // offers "open image" for plain images, SVG <image> and image buttons
  // alike. Only loaded, unlinked images count: a lightbox thumbnail opens
  // the site's link, which stays blocked.
  const imgSrcs = (n) => {
    if (n instanceof HTMLMediaElement) {
      const out = [n.currentSrc, n.src];
      try { for (const s of n.querySelectorAll("source[src]")) out.push(s.src); } catch {}
      return out;
    }
    if (n instanceof HTMLImageElement) {
      let ok = false;
      try {
        ok = n.complete && n.naturalWidth > 0;
      } catch {
        ok = false;
      }
      const src = n.currentSrc || n.src;
      return ok && src && !sameLink(n, src) ? [n.currentSrc, n.src] : [];
    }
    if (typeof SVGImageElement !== "undefined" && n instanceof SVGImageElement) {
      let href = "";
      try { href = new URL(n.href?.baseVal ?? n.getAttribute("href") ?? "", document.baseURI).href; } catch {}
      return href && !sameLink(n, href) ? [href] : [];
    }
    if (n instanceof HTMLInputElement && n.type === "image") {
      const src = n.src || "";
      return src && !sameLink(n, src) ? [src] : [];
    }
    return [];
  };
  // The elements under a trusted pointer, walking out through open and
  // closed shadow trees. composedPath() hides closed-tree internals even
  // from the isolated world, and elementFromPoint() retargets to the
  // host — so step in with openOrClosedShadowRoot (needs the "dom"
  // permission) and hit-test each root again. A keyboard-opened menu has
  // no pointer position (0, 0); that path keeps composedPath() only, so
  // a stray top-left image never joins the record.
  const underPointer = (x, y) => {
    const chain = [];
    if (!x && !y) return chain;
    let el = null;
    try { el = document.elementFromPoint(x, y); } catch { return chain; }
    const seen = new Set();
    while (el && !seen.has(el)) {
      seen.add(el);
      chain.push(el);
      let root = null;
      try { root = el.shadowRoot ?? chrome.dom?.openOrClosedShadowRoot?.(el) ?? null; } catch { root = null; }
      if (!root) break;
      try { el = root.elementFromPoint(x, y); } catch { break; }
    }
    return chain;
  };
  // Trusted input anywhere in the tab ends the menu: the user's next tab
  // is their own only when picked straight from the menu. Every frame
  // reports its own input; the record belongs to the whole tab. The right
  // button itself never closes (it opens the menu instead).
  function onPointerDown(e) {
    if (!armed || !e.isTrusted) return;
    if (e.button === 2) {
      pressSelection = readSelection();
      return;
    }
    menuOpen = false;
    send({ type: "contextMenuClosed" });
  }
  function onContextMenu(e) {
    if (!armed || !e.isTrusted) return;
    menuOpen = true;
    const srcs = [];
    const seen = new Set();
    const take = (n) => {
      if (!n || seen.has(n)) return;
      seen.add(n);
      for (const u of imgSrcs(n)) srcs.push(u);
    };
    for (const n of e.composedPath()) take(n);
    // Nodes inside a closed shadow tree never appear above; walk out
    // from the element under the pointer instead.
    for (const n of underPointer(e.clientX, e.clientY)) take(n);
    // The selection the user had when the button went down. A page that
    // selects its own text on mousedown (for the menu to offer) finds an
    // empty record instead. A keyboard-opened menu has no pointer press;
    // that path is inherently genuine, so it keeps the live selection.
    const now = readSelection();
    const selection = pressSelection === null || now === pressSelection ? now : "";
    pressSelection = null;
    send({ type: "contextMenu", selection, srcs: srcs.filter(Boolean) });
  }
  // A synthetic click the page dispatches itself (to open a tab matching
  // the record above) voids the record: the background refuses the
  // exemption for it. Genuine menu picks involve no page activation — the
  // page gets no events while its menu is open. Every one is reported,
  // never coalesced: the record belongs to the whole tab, and another
  // frame (another process) can write a fresh one in the middle of this
  // frame's task, so a later synthetic click in the same task must void
  // that one too.
  function onUntrustedActivation(e) {
    if (!armed || e.isTrusted) return;
    send({ type: "untrustedActivation" });
  }
  // A key press, a tab switch or a hidden tab in the menu's own frame
  // means the menu is gone (while it is open, the page gets neither).
  function onKeyDown(e) {
    if (!menuOpen || !e.isTrusted) return;
    menuOpen = false;
    send({ type: "contextMenuClosed" });
  }
  function onMenuGone() {
    if (!menuOpen) return;
    menuOpen = false;
    send({ type: "contextMenuClosed" });
  }
  // document.open() drops every listener on the window and document,
  // including these: re-run the setup from an observer (observers
  // survive document.open()). The browser drops a second add of the same
  // (type, function, capture), so re-running on an intact document adds
  // nothing — but only because these are the same function objects every
  // time. Fresh closures here would pile up, and two contextmenu listeners
  // would be a hole, not just waste: the first uses up pressSelection and
  // reports "", the second then sees no press and reports the selection
  // the page planted on mousedown (issue 6 part A again).
  function listenMenus() {
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("click", onUntrustedActivation, true);
    window.addEventListener("auxclick", onUntrustedActivation, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onMenuGone, true);
    window.addEventListener("visibilitychange", onMenuGone, true);
  }
  listenMenus();
  new MutationObserver(() => listenMenus()).observe(document, { childList: true });
})();