// Unit vectors for the context-menu matchers in extension/menu-match.js.
//
// Issue 2: Brave's "Go to <address>" menu item opens the selection itself,
// which has no query string for the search rule to match, so offeredByMenu
// also accepts the tab when its host and path equal the selected address.
//
// A headless browser cannot open the native context menu, and any page
// input after a right-click ends the menu record, so the full suite
// cannot drive a kept menu tab end to end (see README: no test checks
// that a chosen menu tab is kept). These vectors run the shipped matching
// code itself, imported from the module background.js uses.
//
//   node --test test/unit.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { goToMatch, offeredByMenu, SEARCH } from "../extension/menu-match.js";

// [selection, tab URL, expected]
const vectors = [
  // The issue's cases: a bare host, a full URL, and any selection Brave
  // reads as an address (including a TLD-looking file name).
  ["127.0.0.1:8799/target.html?case=goto-bare", "http://127.0.0.1:8799/target.html?case=goto-bare", true],
  ["http://127.0.0.1:8799/target.html?case=goto-full", "http://127.0.0.1:8799/target.html?case=goto-full", true],
  ["example.com/page", "http://example.com/page", true],
  ["https://example.org/x", "https://example.org/x", true],
  ["README.md", "http://readme.md/", true],
  // Host and path compare case-insensitively.
  ["127.0.0.1:8799/TARGET.HTML?CASE=GOTO-UPPER", "http://127.0.0.1:8799/target.html?case=goto-upper", true],
  ["Example.COM/Page", "http://example.com/page", true],
  // Single-label hosts count when a port or path makes them an address.
  ["localhost:8799/target.html?case=local", "http://localhost:8799/target.html?case=local", true],
  ["localhost:8799", "http://localhost:8799/", true],
  // ... but the comparison is exact, not contains: a different path, a
  // different host, a lookalike host, a path prefix, or a different port
  // must not match.
  ["127.0.0.1:8799/target.html?case=goto-bare", "http://127.0.0.1:8799/target.html?case=goto-other", false],
  ["127.0.0.1:8799/target.html?case=goto-bare", "http://localhost:8799/target.html?case=goto-bare", false],
  ["example.com/a", "http://example.com.evil/b", false],
  // Same path, so only the host comparison can reject these.
  ["example.com/a", "http://example.com.evil/a", false],
  ["example.com/a", "http://example.community/a", false],
  ["example.com/a", "http://example.com/ab", false],
  ["example.com/a", "http://example.com:9999/a", false],
  ["example.com/a?x=1", "http://example.com/a", false],
  // Not addresses at all: a bare word, a sentence, a short token, a
  // non-http scheme.
  ["hello", "http://hello/", false],
  ["hello world", "http://hello/world", false],
  ["ab", "http://ab/", false],
  ["ftp://example.com/a", "ftp://example.com/a", false],
];

describe("goToMatch (issue 2)", () => {
  for (const [selection, url, want] of vectors) {
    it(`${want ? "keeps" : "closes"} ${JSON.stringify(selection)} -> ${url}`, () => {
      assert.equal(goToMatch(selection, url), want);
    });
  }
});

describe("offeredByMenu still accepts search and image tabs", () => {
  it("keeps a search tab whose query holds the selection", () => {
    assert.equal(offeredByMenu(
      { selection: "attack words here", srcs: [] },
      "https://www.google.com/search?q=attack+words+here",
    ), true);
  });
  it("keeps a reported image src", () => {
    assert.equal(offeredByMenu(
      { selection: "", srcs: ["https://img.example/pic.png"] },
      "https://img.example/pic.png",
    ), true);
  });
  it("closes an unrelated tab", () => {
    assert.equal(offeredByMenu(
      { selection: "attack words here", srcs: [] },
      "http://127.0.0.1:8799/target.html?case=other",
    ), false);
  });
});

// SEARCH is the page-reachable allowlist for the PDF-viewer exemption in
// fromUserMenu. These pin its current behaviour; tightening it is a
// separate change.
describe("SEARCH (PDF-viewer search exemption)", () => {
  const accept = [
    "https://www.google.com/search?q=x",
    "https://www.google.co.uk/search?q=x",
    "https://duckduckgo.com/?q=x",
    "https://search.brave.com/search?q=x",
    "https://www.bing.com/search?q=x",
    "https://kagi.com/search?q=x",
    // Looser than the real engine domains, by design (README "Searching
    // from the PDF viewer"): any 2-letter second part after google's TLD.
    "https://google.com.xx/search?q=x",
  ];
  const reject = [
    "http://www.google.com/search?q=x", // not https
    "https://www.google.com/search", // no "?"
    "https://www.google.com/searchx?q=x",
    "https://google.com.evil.example/search?q=x",
    "https://evil.example/?u=https://www.google.com/search?q=x",
    "https://notgoogle.com/search?q=x",
    "https://www.google.com@evil.example/search?q=x",
  ];
  for (const url of accept) it(`accepts ${url}`, () => assert.equal(SEARCH.test(url), true));
  for (const url of reject) it(`rejects ${url}`, () => assert.equal(SEARCH.test(url), false));
});

describe("offeredByMenu: a short or empty selection offers no search", () => {
  it("an empty selection (an image right-click) matches no query string", () => {
    assert.equal(offeredByMenu({ selection: "", srcs: [] }, "https://ads.example/?x=1"), false);
  });
  it("a selection under three characters matches no query string", () => {
    assert.equal(offeredByMenu({ selection: "ab", srcs: [] }, "https://ads.example/?x=ab"), false);
  });
});
