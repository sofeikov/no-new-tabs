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
  // stays blocked. Pages can't fake these events, and this runs in the
  // extension's own world, so the page can't change what it reads.
  let menuOpen = false;
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
  window.addEventListener("contextmenu", (e) => {
    if (!armed || !e.isTrusted) return;
    menuOpen = true;
    const srcs = [];
    for (const n of e.composedPath()) {
      if (n instanceof HTMLImageElement || n instanceof HTMLMediaElement) srcs.push(n.currentSrc, n.src);
      if (n instanceof HTMLMediaElement) for (const s of n.querySelectorAll("source[src]")) srcs.push(s.src);
    }
    let selection = String(getSelection() ?? "");
    const field = document.activeElement;
    if (!selection && typeof field?.selectionStart === "number") {
      try { selection = field.value.slice(field.selectionStart, field.selectionEnd); } catch {}
    }
    send({ type: "contextMenu", selection, srcs: srcs.filter(Boolean) });
  }, true);
  // Any click or key press in the page means the menu is gone (while it is
  // open, the page gets neither).
  for (const type of ["mousedown", "keydown"]) {
    window.addEventListener(type, (e) => {
      if (!menuOpen || !e.isTrusted) return;
      menuOpen = false;
      send({ type: "contextMenuClosed" });
    }, true);
  }
})();
