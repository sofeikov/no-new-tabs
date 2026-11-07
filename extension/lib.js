// Shared helpers for the background worker, popup and options page.

import "./match.js"; // defines globalThis.NoNewTabsMatch (rule matching)

const match = globalThis.NoNewTabsMatch;

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

// "https://www.Example.com/path" -> "example.com". Returns "" for junk.
export function normalizeDomain(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return "";
  let host;
  try {
    host = new URL(s.includes("://") ? s : `http://${s}`).hostname;
  } catch {
    return "";
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return HOSTNAME.test(host) || host.startsWith("[") ? host : "";
}

// One list entry in its stored form: a domain ("example.com"), or a rule
// ("=host", "*", "!host", "!=host"; see match.js). "" for junk. Exact
// rules and exceptions keep a leading "www.": an exact rule names one
// host, and dropping "www." from "!www.bank.com" would widen the exception
// to every bank.com subdomain (the unsafe direction). A plain blocking
// rule drops it, which only widens what is blocked.
export function normalizeRule(input) {
  let s = String(input ?? "").trim().toLowerCase();
  if (s === "*") return "*";
  let prefix = "";
  if (s.startsWith("!")) { prefix += "!"; s = s.slice(1).trim(); }
  const exact = s.startsWith("=");
  if (exact) { prefix += "="; s = s.slice(1).trim(); }
  const host = exact || prefix.startsWith("!") ? normalizeHost(s) : normalizeDomain(s);
  return host ? prefix + host : "";
}

// Like normalizeDomain, without dropping "www.".
function normalizeHost(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return "";
  let host;
  try {
    host = new URL(s.includes("://") ? s : `http://${s}`).hostname.replace(/\.$/, "");
  } catch {
    return "";
  }
  return HOSTNAME.test(host) || host.startsWith("[") ? host : "";
}

// Is this host listed by these rules? (match.js holds the one definition.)
export const hostIsBlocked = (host, domains) => match.isListed(host, domains);
// The rule that lists this host, or undefined.
export const coveringRule = (host, domains) => match.covering(host, domains);
// The exception rule that keeps this host unlisted, or undefined.
export const exceptionFor = (host, domains) => match.exceptedBy(host, domains);

// The URL when it is an http(s) address, else null (junk included).
export function httpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// The host whose rules apply to a page at this URL. A blob: or filesystem:
// URL belongs to the site that made it. about:blank, about:srcdoc, data: and
// javascript: pages, and blob: URLs made in an opaque origin (blob:null/...),
// take their origin from whoever opened them, so they have no host of their
// own: null. "" for anything else.
export function siteOf(url) {
  let u;
  try { u = new URL(url); } catch { return ""; }
  if (u.protocol === "http:" || u.protocol === "https:") return u.hostname;
  if (u.protocol === "blob:" || u.protocol === "filesystem:") return httpUrl(u.pathname)?.hostname ?? null;
  if (["about:", "data:", "javascript:"].includes(u.protocol)) return null;
  return "";
}

export function isBlockedUrl(url, domains) {
  return !!url && hostIsBlocked(siteOf(url), domains);
}

export async function loadDomains() {
  const { domains = [] } = await chrome.storage.sync.get("domains");
  return domains;
}

// The entries of `lines` that are not a domain or rule (blank lines
// aside), as typed: saveDomains drops them, so the options page names them.
export const rejectedLines = (lines) =>
  lines.map((l) => String(l ?? "").trim()).filter((l) => l && !normalizeRule(l));

// The list is one chrome.storage.sync item, so it is bound by the sync
// per-item quota (8 KB). A larger list is refused here with a message the
// options page and popup show, instead of a bare storage error.
export async function saveDomains(list) {
  const domains = [...new Set(list.map(normalizeRule).filter(Boolean))].sort();
  const quota = chrome.storage.sync.QUOTA_BYTES_PER_ITEM ?? 8192;
  const bytes = new TextEncoder().encode("domains" + JSON.stringify(domains)).length;
  if (bytes > quota) {
    throw new Error(`The list is too large to save: ${bytes} bytes, and browser sync stores at most ` +
      `${quota} bytes (${domains.length} entries). Remove some entries, or cover several sites with ` +
      "one parent domain, and save again.");
  }
  await chrome.storage.sync.set({ domains });
  return domains;
}

// What the popup offers for a page on `host` (its hostname as the browser
// has it) under these rules:
//   listed by a rule naming this site    -> remove that rule
//   listed by a broader rule (a parent
//   domain, or "*")                      -> add the exception "!site"
//   kept unlisted by exceptions          -> remove those exceptions
//   unlisted                             -> add the site
// `site` is the host as "+ Add" stores it ("www." dropped). Returns
// { listed, rule, via, exceptions, action, label, next } where `next` is
// the new list to save, or null when the host is not a web host.
export function siteToggle(host, domains) {
  const h = String(host ?? "").toLowerCase().replace(/\.+$/, "");
  const site = normalizeDomain(h);
  if (!site) return null;
  const rule = coveringRule(h, domains);
  if (rule !== undefined) {
    if (rule === site || rule === `=${h}`) {
      const next = domains.filter((d) => d !== rule);
      // Another rule ("*", a parent domain) may still list the site.
      if (!hostIsBlocked(h, next)) {
        return { listed: true, rule, via: false, action: "remove", label: `Remove ${rule}`, next };
      }
    }
    // The exception names this exact host (with its subdomains), never a
    // wider domain than the user is on.
    return { listed: true, rule, via: rule !== site && rule !== `=${h}`, action: "allow",
      label: `Allow this site (add !${h})`, next: [...domains, `!${h}`] };
  }
  const exceptions = domains.filter((d) => d.startsWith("!") && exceptionFor(h, [d]) !== undefined);
  if (exceptions.length) {
    const next = domains.filter((d) => !exceptions.includes(d));
    // With the exceptions gone, a site no rule covers is still unlisted:
    // add it too, so the button does what it says.
    const add = !hostIsBlocked(h, next);
    return { listed: false, exceptions, action: "unexcept",
      label: `Remove exception${exceptions.length > 1 ? "s" : ""} ${exceptions.join(", ")}${add ? ` and add ${site}` : ""}`,
      next: add ? [...next, site] : next };
  }
  return { listed: false, action: "add", label: `+ Add ${site}`, next: [...domains, site] };
}
