// Site rules: which hosts are listed. The one definition shared by every
// part of the extension, so the in-page decision (arm.js) and the
// background's can never drift apart.
//
// Loaded two ways, so it has no import or export:
// - as a classic content script just before arm.js, in the extension's
//   isolated world only. Never in the page's (MAIN) world, where a page
//   could read or poison it;
// - by lib.js with `import "./match.js"`, for its side effect, in the
//   service worker, the popup, the options page and the unit tests.
//
// Rule grammar, one rule per entry (lowercase, as saveDomains stores them):
//   example.com     the host and every subdomain of it
//   =example.com    that exact host only
//   *               every site
//   !example.com    exception: the host and its subdomains are never listed
//   !=example.com   exception for that exact host only
// Exceptions beat every other rule, so "*" plus "!mail.example.com" means
// "block new tabs everywhere except on mail.example.com" (an allowlist).
//
// Matching is label-anchored: "example.com" covers "a.example.com" but
// never "evilexample.com". A compiled list answers in O(labels in the
// host), not O(rules), so a list of thousands of domains costs the same
// per check as a list of one.

"use strict";

(() => {
  // Every trailing dot goes: "example.com.." must not slip past "example.com".
  const norm = (h) => String(h ?? "").toLowerCase().replace(/\.+$/, "");

  // "!=a.b" -> { except: true, exact: true, host: "a.b" }; null for junk.
  // The host part is taken as already normalised (see lib.js normalizeRule).
  function parseRule(rule) {
    let s = String(rule ?? "").trim().toLowerCase();
    const except = s.startsWith("!");
    if (except) s = s.slice(1);
    const exact = s.startsWith("=");
    if (exact) s = s.slice(1);
    if (!s || /[\s!=]/.test(s) || (s.includes("*") && s !== "*")) return null;
    if (s === "*" && (except || exact)) return null;
    return { except, exact, host: s };
  }

  // Compiled form of a rule list, cached per array: storage hands each
  // reader one array that is then reused for every check.
  const compiled = new WeakMap();
  function compile(rules) {
    let c = compiled.get(rules);
    if (c) return c;
    c = { any: null, exact: new Map(), sub: new Map(), notExact: new Map(), notSub: new Map() };
    for (const rule of rules) {
      const r = parseRule(rule);
      if (!r) continue;
      if (r.host === "*") { c.any ??= rule; continue; }
      const map = r.except ? (r.exact ? c.notExact : c.notSub) : (r.exact ? c.exact : c.sub);
      if (!map.has(r.host)) map.set(r.host, rule);
    }
    compiled.set(rules, c);
    return c;
  }

  // The most specific rule in `exact`/`sub` maps covering host h.
  function lookup(h, exact, sub) {
    const hit = exact.get(h);
    if (hit !== undefined) return hit;
    for (let i = -1; ; ) {
      const suffix = i < 0 ? h : h.slice(i + 1);
      const s = sub.get(suffix);
      if (s !== undefined) return s;
      i = h.indexOf(".", i + 1);
      if (i < 0) return undefined;
    }
  }

  // The exception rule that keeps this host unlisted, if any.
  function exceptedBy(host, rules) {
    const h = norm(host);
    if (!h || !Array.isArray(rules)) return undefined;
    const c = compile(rules);
    return lookup(h, c.notExact, c.notSub);
  }

  // The rule that lists this host ("example.com" for "app.example.com"),
  // or undefined when the host is not listed (no rule, or an exception).
  function covering(host, rules) {
    const h = norm(host);
    if (!h || !Array.isArray(rules)) return undefined;
    const c = compile(rules);
    if (lookup(h, c.notExact, c.notSub) !== undefined) return undefined;
    return lookup(h, c.exact, c.sub) ?? c.any ?? undefined;
  }

  const isListed = (host, rules) => covering(host, rules) !== undefined;

  globalThis.NoNewTabsMatch = Object.freeze({ parseRule, covering, exceptedBy, isListed });
})();
