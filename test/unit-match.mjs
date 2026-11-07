// Site rules (extension/match.js) and the list helpers in lib.js that the
// popup and options page use: matching vectors, normalizeRule, the rules
// the popup offers, saving at the sync quota.
//
// match.js is loaded two ways in the extension: as a module side effect
// (lib.js imports it, here too) and as a classic content script before
// arm.js. The second way is checked by running the file with node:vm in a
// fresh context, as a plain script, and comparing every answer.
//
//   node --test test/unit-match.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import { normalizeRule, rejectedLines, saveDomains, siteToggle } from "../extension/lib.js";

const here = dirname(fileURLToPath(import.meta.url));
const MATCH_PATH = join(here, "..", "extension", "match.js");
const M = globalThis.NoNewTabsMatch; // set by lib.js's import of match.js

// Classic-script load, as Chrome injects it before arm.js: no module
// syntax allowed (vm.Script throws on import/export), its own global.
const sandbox = {};
vm.runInNewContext(readFileSync(MATCH_PATH, "utf8"), sandbox, { filename: "match.js" });
const C = sandbox.NoNewTabsMatch;

// [rules, host, listed]
const vectors = [
  // A domain covers itself and its subdomains, anchored on whole labels.
  [["example.com"], "example.com", true],
  [["example.com"], "www.example.com", true],
  [["example.com"], "a.b.example.com", true],
  [["example.com"], "evilexample.com", false],
  [["example.com"], "example.com.evil", false],
  [["example.com"], "example.co", false],
  [["example.com"], "xample.com", false],
  [["example.com"], "com", false],
  // Case and trailing dots never get past a rule.
  [["example.com"], "EXAMPLE.Com", true],
  [["example.com"], "example.com.", true],
  [["example.com"], "example.com..", true],
  [["example.com"], "A.EXAMPLE.COM.", true],
  // Exact host.
  [["=www.example.com"], "www.example.com", true],
  [["=www.example.com"], "WWW.example.com.", true],
  [["=www.example.com"], "example.com", false],
  [["=www.example.com"], "a.www.example.com", false],
  // Every site.
  [["*"], "example.com", true],
  [["*"], "127.0.0.1", true],
  [["*"], "[::1]", true],
  [["*"], "localhost", true],
  // ... but nothing without a host.
  [["*"], "", false],
  [["*"], null, false],
  [["*"], undefined, false],
  // Exceptions beat "*" (an allowlist), whole labels again.
  [["*", "!a.test"], "b.test", true],
  [["*", "!a.test"], "a.test", false],
  [["*", "!a.test"], "x.a.test", false],
  [["*", "!a.test"], "A.TEST.", false],
  [["*", "!a.test"], "aa.test", true],
  [["*", "!a.test"], "a.test.evil", true],
  // Exceptions beat parent rules and more specific rules alike.
  [["example.com", "!docs.example.com"], "docs.example.com", false],
  [["example.com", "!docs.example.com"], "a.docs.example.com", false],
  [["example.com", "!docs.example.com"], "app.example.com", true],
  [["example.com", "!docs.example.com"], "example.com", true],
  [["example.com", "!=docs.example.com"], "docs.example.com", false],
  [["example.com", "!=docs.example.com"], "a.docs.example.com", true],
  [["=a.example.com", "!example.com"], "a.example.com", false],
  [["a.example.com", "!example.com"], "b.a.example.com", false],
  // An exception alone lists nothing.
  [["!example.com"], "example.com", false],
  [["!example.com"], "other.com", false],
  // IP addresses.
  [["127.0.0.1"], "127.0.0.1", true],
  [["127.0.0.1"], "27.0.0.1", false],
  [["[::1]"], "[::1]", true],
  // Junk rules are ignored, never read as wildcards.
  [["*.example.com", "ex ample.com", "!*", "=*", "!", "=", "", "!=", "=!example.com", "exa*mple.com"], "a.example.com", false],
  [["*.example.com"], "example.com", false],
  [[null, undefined, 5, {}, "example.com"], "a.example.com", true],
  // An empty list, and lists that are not arrays.
  [[], "example.com", false],
];

describe("match.js rule vectors", () => {
  for (const [rules, host, want] of vectors) {
    it(`${JSON.stringify(rules)} ${want ? "lists" : "does not list"} ${JSON.stringify(host)}`, () => {
      assert.equal(M.isListed(host, rules), want);
      assert.equal(M.covering(host, rules) !== undefined, want);
    });
  }

  it("non-array rule lists list nothing", () => {
    for (const rules of [null, undefined, "example.com", { 0: "example.com", length: 1 }]) {
      assert.equal(M.isListed("example.com", rules), false);
    }
  });

  it("covering names the most specific rule", () => {
    const rules = ["*", "example.com", "a.example.com", "=b.example.com"];
    assert.equal(M.covering("x.a.example.com", rules), "a.example.com");
    assert.equal(M.covering("a.example.com", rules), "a.example.com");
    assert.equal(M.covering("b.example.com", rules), "=b.example.com");
    assert.equal(M.covering("c.example.com", rules), "example.com");
    assert.equal(M.covering("other.org", rules), "*");
  });

  it("exceptedBy names the exception", () => {
    const rules = ["*", "!example.com", "!=a.example.com"];
    assert.equal(M.exceptedBy("a.example.com", rules), "!=a.example.com");
    assert.equal(M.exceptedBy("b.example.com", rules), "!example.com");
    assert.equal(M.exceptedBy("other.org", rules), undefined);
    assert.equal(M.covering("b.example.com", rules), undefined);
  });

  it("parseRule rejects wildcards other than a lone *", () => {
    for (const r of ["*.example.com", "example.*", "a*b.com", "!*", "=*", "!=*", "", "!", "=", "a b", "!!a.com", "=!a.com"]) {
      assert.equal(M.parseRule(r), null, r);
    }
    assert.deepEqual(M.parseRule("!=a.com"), { except: true, exact: true, host: "a.com" });
    assert.deepEqual(M.parseRule("*"), { except: false, exact: false, host: "*" });
  });

  it("the API is frozen", () => {
    assert.ok(Object.isFrozen(M));
    assert.throws(() => { "use strict"; M.isListed = () => true; });
  });
});

describe("match.js as a classic script (as Chrome loads it before arm.js)", () => {
  it("runs without module syntax and defines the same API", () => {
    assert.ok(C, "NoNewTabsMatch defined on the script's global");
    assert.deepEqual(Object.keys(C).sort(), Object.keys(M).sort());
    assert.equal(sandbox.NoNewTabsMatch, C);
  });

  it("gives identical answers", () => {
    for (const [rules, host] of vectors) {
      const label = `${JSON.stringify(rules)} ${JSON.stringify(host)}`;
      assert.equal(C.isListed(host, rules), M.isListed(host, rules), label);
      assert.equal(C.covering(host, rules), M.covering(host, rules), label);
      assert.equal(C.exceptedBy(host, rules), M.exceptedBy(host, rules), label);
    }
  });
});

describe("match.js with a large list", () => {
  it("5000 domains: compiles once, each check stays fast", () => {
    const rules = Array.from({ length: 5000 }, (_, i) => `site${i}.example${i % 7}.com`);
    rules.push("!=keep.site42.example0.com");
    let t = performance.now();
    assert.equal(M.isListed("a.site4999.example1.com", rules), true); // compiles
    const compileMs = performance.now() - t;
    const hosts = Array.from({ length: 20_000 }, (_, i) => `w${i}.site${i % 6000}.example${i % 7}.com`);
    t = performance.now();
    let listed = 0;
    for (const h of hosts) if (M.isListed(h, rules)) listed++;
    const checkMs = performance.now() - t;
    assert.ok(listed > 0 && listed < hosts.length);
    assert.equal(M.isListed("keep.site42.example0.com", rules), false);
    assert.equal(M.isListed("evilsite42.example0.com", rules), false);
    // Generous bounds for slow CI; a linear scan would take seconds.
    assert.ok(compileMs < 500, `compile took ${compileMs.toFixed(1)} ms`);
    assert.ok(checkMs < 500, `20000 checks took ${checkMs.toFixed(1)} ms`);
  });
});

describe("normalizeRule", () => {
  const cases = [
    ["example.com", "example.com"],
    ["Example.COM", "example.com"],
    ["  example.com  ", "example.com"],
    ["https://www.Example.com/some/path?q=1", "example.com"],
    ["www.example.com", "example.com"],
    ["example.com.", "example.com"],
    ["=www.example.com", "=www.example.com"],
    ["= https://WWW.Example.com/x", "=www.example.com"],
    ["*", "*"],
    [" * ", "*"],
    ["!example.com", "!example.com"],
    ["! www.example.com", "!www.example.com"], // an exception keeps www: dropping it would widen it,
    ["!=www.example.com", "!=www.example.com"],
    ["!=WWW.example.com.", "!=www.example.com"],
    ["127.0.0.1", "127.0.0.1"],
    ["[::1]", "[::1]"],
    ["http://[::1]:8080/", "[::1]"],
    ["bücher.de", "xn--bcher-kva.de"],
    // Junk.
    ["", ""],
    ["   ", ""],
    ["not a domain!!", ""],
    ["*.example.com", ""],
    ["example.*", ""],
    ["!*", ""],
    ["=*", ""],
    ["!", ""],
    ["=", ""],
    ["!=", ""],
    ["=!example.com", ""],
    ["!!example.com", ""],
    ["ex_ample.com", ""],
    [null, ""],
    [undefined, ""],
  ];
  for (const [input, want] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => assert.equal(normalizeRule(input), want));
  }

  it("everything it stores, match.js can parse", () => {
    for (const [input] of cases) {
      const r = normalizeRule(input);
      if (r) assert.notEqual(M.parseRule(r), null, r);
    }
  });

  it("rejectedLines names the lines saveDomains drops, as typed", () => {
    assert.deepEqual(rejectedLines(["example.com", "", "  ", " bad line!! ", "*.x.com", "!a.test", "*"]), ["bad line!!", "*.x.com"]);
  });
});

describe("siteToggle (the popup's button)", () => {
  // Apply the offered list the way saving it would, then match.
  const after = (t) => [...new Set(t.next.map(normalizeRule).filter(Boolean))];

  it("unlisted: adds the site, www dropped", () => {
    const t = siteToggle("www.example.com", ["other.com"]);
    assert.equal(t.action, "add");
    assert.equal(t.label, "+ Add example.com");
    assert.equal(M.isListed("www.example.com", after(t)), true);
  });

  it("listed by a rule naming the site: removes it", () => {
    for (const [host, rule] of [["example.com", "example.com"], ["www.example.com", "example.com"], ["www.example.com", "=www.example.com"]]) {
      const t = siteToggle(host, ["other.com", rule]);
      assert.equal(t.action, "remove", host);
      assert.equal(t.rule, rule);
      assert.equal(t.via, false);
      assert.equal(t.label, `Remove ${rule}`);
      assert.deepEqual(t.next, ["other.com"]);
      assert.equal(M.isListed(host, after(t)), false);
    }
  });

  it("listed by a parent domain: offers an exception, via the parent", () => {
    const t = siteToggle("app.example.com", ["example.com"]);
    assert.equal(t.action, "allow");
    assert.equal(t.via, true);
    assert.equal(t.rule, "example.com");
    assert.deepEqual(t.next, ["example.com", "!app.example.com"]);
    assert.equal(M.isListed("app.example.com", after(t)), false);
    assert.equal(M.isListed("example.com", after(t)), true, "the parent stays listed");
  });

  it("listed by '*': offers an exception", () => {
    const t = siteToggle("www.b.test", ["*"]);
    assert.equal(t.action, "allow");
    assert.equal(t.rule, "*");
    assert.deepEqual(t.next, ["*", "!www.b.test"], "the exception names the host, never a wider domain");
    assert.equal(M.isListed("www.b.test", after(t)), false);
    assert.equal(M.isListed("c.test", after(t)), true);
  });

  it("excepted: removes every exception that covers it", () => {
    const t = siteToggle("x.a.test", ["*", "!a.test", "!=x.a.test", "!c.test"]);
    assert.equal(t.action, "unexcept");
    assert.deepEqual(t.exceptions, ["!a.test", "!=x.a.test"]);
    assert.equal(t.label, "Remove exceptions !a.test, !=x.a.test");
    assert.deepEqual(t.next, ["*", "!c.test"]);
    assert.equal(M.isListed("x.a.test", after(t)), true);
  });

  it("every action changes whether the site is listed", () => {
    for (const [host, rules] of [
      ["example.com", ["other.com", "!example.com"]], // excepted, but no rule covers it
      ["example.com", ["!example.com"]],
      ["example.com", ["*", "example.com"]], // "*" still lists it after removing its own rule
      ["app.example.com", ["example.com", "app.example.com"]],
      ["www.bank.com", ["*"]],
    ]) {
      const t = siteToggle(host, rules);
      assert.notEqual(M.isListed(host, after(t)), M.isListed(host, rules), `${host} ${JSON.stringify(rules)} -> ${t.action}`);
    }
  });

  it("not a web host: nothing to offer", () => {
    assert.equal(siteToggle("", ["*"]), null);
    assert.equal(siteToggle(null, ["*"]), null);
  });
});

describe("saveDomains at the sync quota", () => {
  function fakeSync(quota = 8192) {
    const writes = [];
    globalThis.chrome = { storage: { sync: { QUOTA_BYTES_PER_ITEM: quota, set: async (o) => void writes.push(o) } } };
    return writes;
  }

  it("saves a normalised, sorted, de-duplicated list", async () => {
    const writes = fakeSync();
    const saved = await saveDomains(["b.com", "https://www.A.com/x", "junk!!", "a.com", "!c.com", "*"]);
    assert.deepEqual(saved, ["!c.com", "*", "a.com", "b.com"]);
    assert.deepEqual(writes, [{ domains: saved }]);
  });

  it("refuses a list over the per-item quota with a clear error, and writes nothing", async () => {
    const writes = fakeSync();
    const big = Array.from({ length: 600 }, (_, i) => `a-rather-long-domain-name-${i}.example.com`);
    await assert.rejects(saveDomains(big), (e) => /too large/.test(e.message) && /8192/.test(e.message));
    assert.deepEqual(writes, []);
  });

  it("measures the item as the key plus its JSON", async () => {
    const domains = ["a.com"]; // "domains" + '["a.com"]' = 16 bytes
    let writes = fakeSync(16);
    await saveDomains(domains);
    assert.equal(writes.length, 1);
    writes = fakeSync(15);
    await assert.rejects(saveDomains(domains));
    assert.equal(writes.length, 0);
  });

  it("passes other storage errors through", async () => {
    globalThis.chrome = { storage: { sync: { QUOTA_BYTES_PER_ITEM: 8192, set: async () => { throw new Error("MAX_WRITE_OPERATIONS_PER_MINUTE"); } } } };
    await assert.rejects(saveDomains(["a.com"]), /MAX_WRITE/);
  });
});
