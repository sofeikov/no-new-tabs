// Shared helpers for the background worker, popup and options page.

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

export function hostIsBlocked(host, domains) {
  const h = String(host ?? "").toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
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
  if (u.protocol === "blob:" || u.protocol === "filesystem:") {
    try {
      const inner = new URL(u.pathname);
      return inner.protocol === "http:" || inner.protocol === "https:" ? inner.hostname : null;
    } catch { return null; }
  }
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

export async function saveDomains(list) {
  const domains = [...new Set(list.map(normalizeDomain).filter(Boolean))].sort();
  await chrome.storage.sync.set({ domains });
  return domains;
}
