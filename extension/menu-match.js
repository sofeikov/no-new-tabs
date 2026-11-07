// What a context menu on a listed page offers, as pure functions of the
// menu record and the new tab's address. background.js uses them to keep
// the one tab the user picked from the menu (see fromUserMenu there); the
// unit tests import them directly. No chrome.* use and no module state.

import { httpUrl } from "./lib.js";

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// Brave's "Go to <address>" opens the selection itself, which has no query
// string for the search rule to match. Accept the tab when its host and
// path equal the selection parsed as a URL, with http:// added to bare
// hosts. The comparison is exact (not contains) and case-insensitive, so a
// selection of "example.com/a" never matches "example.com.evil/b".
export function urlFromSelection(sel) {
  const t = String(sel ?? "").trim();
  if (!t || t.length < 3 || t.length > 500) return null;
  if (/\s/.test(t)) return null; // "Go to" offers a single address token
  let cand = t;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(cand)) {
    const bare = cand.match(/^([\w-]+(?:\.[\w-]+)*)(:\d+)?(\/\S*)?$/u);
    // A bare word with no dot, port or path is a search term, not an
    // address ("hello"); with one of those it is ("localhost:8799/x").
    if (!bare || (!bare[1].includes(".") && !bare[2] && !(bare[3] && bare[3].length > 1))) return null;
    cand = `http://${cand}`;
  }
  return httpUrl(cand);
}

export function goToMatch(selection, url) {
  const selUrl = urlFromSelection(selection);
  if (!selUrl) return false;
  const tabUrl = httpUrl(url);
  if (!tabUrl) return false;
  const normHost = (h) => h.toLowerCase().replace(/\.$/, "");
  if (normHost(selUrl.hostname) !== normHost(tabUrl.hostname)) return false;
  const normPort = (u) => (!u.port || u.port === "80" || u.port === "443" ? "" : u.port);
  if (normPort(selUrl) !== normPort(tabUrl)) return false;
  const normPath = (u) => {
    let p = u.pathname || "/";
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return (p + u.search + u.hash).toLowerCase();
  };
  return normPath(selUrl) === normPath(tabUrl);
}

// The tab's address is one the menu offered: a reported image or video
// src, the selection as an address ("Go to"), or a search whose query
// holds the selected words.
export function offeredByMenu(menu, url) {
  if (menu.srcs.includes(url)) return true;
  if (goToMatch(menu.selection, url)) return true;
  const words = squash(menu.selection).slice(0, 50);
  if (words.length < 3) return false;
  try {
    for (const value of new URL(url).searchParams.values()) if (squash(value).includes(words)) return true;
  } catch {}
  return false;
}

// Search results pages a "Search for …" in the browser's PDF viewer may
// open (fromUserMenu's PDF-viewer branch): https only, a fixed list of
// engines and their search paths, and "?" straight after the path.
export const SEARCH = /^https:\/\/(www\.)?(google\.[a-z]{2,3}(\.[a-z]{2})?\/search|bing\.com\/search|duckduckgo\.com\/|search\.brave\.com\/search|search\.yahoo\.com\/search|(www\.)?ecosia\.org\/search|(www\.)?startpage\.com\/|yandex\.[a-z]{2,3}\/search|(www\.)?baidu\.com\/s|(www\.)?qwant\.com\/|kagi\.com\/search)\?/;
