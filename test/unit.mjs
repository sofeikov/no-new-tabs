// Unit vectors for issue 2: Brave's "Go to <address>" menu item.
// "Go to" opens the selection itself, which has no query string for the
// search rule to match, so offeredByMenu also accepts the tab when its
// host and path equal the selected address (see background.js).
//
// A headless browser cannot open the native context menu, and any page
// input after a right-click ends the menu record, so the full suite
// cannot drive a kept menu tab end to end (see README: no test checks
// that a chosen menu tab is kept). These vectors run the shipped matching
// code itself instead: they fail on the pre-fix background.js, which has
// no goToMatch arm.
//
//   node --test test/unit.mjs
//   BG_PATH=/tmp/base-bg.js node --test test/unit.mjs   (e.g. base version)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bgPath = process.env.BG_PATH ?? join(here, "..", "extension", "background.js");
const src = readFileSync(bgPath, "utf8");

// The pure matching section: squash, urlFromSelection, goToMatch and
// offeredByMenu use only String/URL, no chrome.* APIs.
const start = src.indexOf("const squash = ");
const fStart = src.indexOf("function offeredByMenu(menu, url) {");
assert.notEqual(start, -1, "squash block found");
assert.notEqual(fStart, -1, "offeredByMenu found");
const fEnd = src.indexOf("\n}", fStart);
assert.notEqual(fEnd, -1, "offeredByMenu end found");
let code = src.slice(start, fEnd + 2);
assert.ok(code.includes("function offeredByMenu"), "offeredByMenu extracted");
// Before the fix there is no goToMatch arm: model that as a matcher that
// never matches, so the keep-vectors below fail one by one instead of the
// whole file erroring on a missing function.
if (!code.includes("function goToMatch")) {
  code += "\nfunction urlFromSelection() { return null; }\nfunction goToMatch() { return false; }\n";
}
const { goToMatch, offeredByMenu } = new Function(`${code}\nreturn { goToMatch, offeredByMenu };`)();

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
