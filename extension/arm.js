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

  const blocked = (host, domains) => {
    const h = (host ?? "").toLowerCase().replace(/\.$/, "");
    return !!h && domains.some((d) => h === d || h.endsWith(`.${d}`));
  };
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
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.domains) check(changes.domains.newValue ?? []);
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
  const sameLink = (img) => {
    try {
      const a = img.closest("a");
      if (!a || !a.href) return false;
      const src = img.currentSrc || img.src;
      return !!src && new URL(a.href, location.href).href === new URL(src, location.href).href;
    } catch {
      return false;
    }
  };
  // Trusted input anywhere in the tab ends the menu: the user's next tab
  // is their own only when picked straight from the menu. Every frame
  // reports its own input; the record belongs to the whole tab. The right
  // button itself never closes (it opens the menu instead).
  // document.open() drops every listener on the window and document,
  // including these: re-run the setup from an observer (observers
  // survive document.open()). Adding the same listener twice is a
  // no-op, so re-running is safe on an intact document.
  function listenMenus() {
    window.addEventListener("pointerdown", (e) => {
      if (!armed || !e.isTrusted) return;
      if (e.button === 2) {
        pressSelection = readSelection();
        return;
      }
      menuOpen = false;
      send({ type: "contextMenuClosed" });
    }, true);
    window.addEventListener("contextmenu", (e) => {
      if (!armed || !e.isTrusted) return;
      menuOpen = true;
      const srcs = [];
      const seenImgs = new Set();
      for (const n of e.composedPath()) {
        if (n instanceof HTMLMediaElement) {
          srcs.push(n.currentSrc, n.src);
          for (const s of n.querySelectorAll("source[src]")) srcs.push(s.src);
        } else if (n instanceof HTMLImageElement && !seenImgs.has(n)) {
          seenImgs.add(n);
          // Only a loaded image counts, and not one wrapped in a link to the
          // same address (a lightbox thumbnail: opening it is opening the
          // site's link, which stays blocked).
          let ok = false;
          try {
            ok = n.complete && n.naturalWidth > 0 && !sameLink(n);
          } catch {
            ok = false;
          }
          if (ok) srcs.push(n.currentSrc, n.src);
        }
      }
      // The selection the user had when the button went down. A page that
      // selects its own text on mousedown (for the menu to offer) finds an
      // empty record instead. A keyboard-opened menu has no pointer press;
      // that path is inherently genuine, so it keeps the live selection.
      const now = readSelection();
      const selection = pressSelection === null || now === pressSelection ? now : "";
      pressSelection = null;
      send({ type: "contextMenu", selection, srcs: srcs.filter(Boolean) });
    }, true);
    // A synthetic click the page dispatches itself (to open a tab matching
    // the record above) voids the record: the background refuses the
    // exemption for it. Genuine menu picks involve no page activation — the
    // page gets no events while its menu is open.
    for (const type of ["click", "auxclick"]) {
      window.addEventListener(type, (e) => {
        if (!armed || e.isTrusted) return;
        send({ type: "untrustedActivation" });
      }, true);
    }
    // A key press, a tab switch or a hidden tab in the menu's own frame
    // means the menu is gone (while it is open, the page gets neither).
    window.addEventListener("keydown", (e) => {
      if (!menuOpen || !e.isTrusted) return;
      menuOpen = false;
      send({ type: "contextMenuClosed" });
    }, true);
    for (const type of ["blur", "visibilitychange"]) {
      window.addEventListener(type, () => {
        if (!menuOpen) return;
        menuOpen = false;
        send({ type: "contextMenuClosed" });
      }, true);
    }
  }
  listenMenus();
  new MutationObserver(() => listenMenus()).observe(document, { childList: true });
})();