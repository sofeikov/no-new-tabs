// Mutation check for the unit tests: does each security-relevant rule in
// the background worker and the site matcher have a test that fails when
// the rule is broken?
//
//   cd test && npm run test:mutants        (or: node mutants.mjs)
//   node mutants.mjs --only no-re-decision,label-anchor-dropped
//   node mutants.mjs --list                names, files and mustFail only
//   node mutants.mjs -v                    also print each mutant's failing tests
//   node mutants.mjs -j 4                  worker pool size (default: cores, at most 12)
//   node mutants.mjs --isolate             one process per test file, as `npm run test:unit`
//                                          (slower; default runs all files in one process)
//
// For each mutant below, extension/ and the unit test files are copied into
// a fresh temp dir laid out like the repo (<tmp>/extension, <tmp>/test), the
// mutant's find/replace edits are applied to the copy, and
// `node --test unit*.mjs` runs there. Copying the tests too means every
// relative import resolves to the mutant: harness.mjs loads
// ../extension/background.js (BG_PATH is also set to it), unit-match.mjs
// imports ../extension/lib.js and reads ../extension/match.js, unit.mjs
// imports ../extension/menu-match.js. No env hook in the test files is needed.
//
// A mutant is KILLED when at least one test fails (a hang past the timeout
// also counts), and every `mustFail` regex matches the name of a failing test.
// It SURVIVES otherwise: that is a test gap, so fix the tests, never the
// mutant. Each `find` must occur exactly once in the current file; if it
// doesn't, the mutant is STALE (the source moved on): refresh its strings.
// The unmutated copy (baseline) must pass first. Exit status is 0 only when
// the baseline passes and every mutant is killed.
//
// Adding a mutant: break one decision the extension relies on, the smallest
// edit that does it, and name the tests that guard it in mustFail.

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, "..", "extension");
const TIMEOUT_MS = 60_000;

// file: path under extension/. edits: [[find, replace], ...], applied in
// order, each find matching exactly once. mustFail: regexes over failing
// test names (all must match some failing test).
const MUTANTS = [
  // --- Pruning by leave age (issue 15) ------------------------------------
  {
    name: "prune-by-commit-age",
    why: "a top commit drops subframe rows by when they loaded, not when they left",
    file: "background.js",
    edits: [[
      "if (e.left == null) { e.left = d.timeStamp; stamped = true; }\n      else if (e.left < old) { entries.splice(i, 1); stamped = true; }",
      "if (e.t < old) { entries.splice(i, 1); stamped = true; }\n      else if (e.left == null) { e.left = d.timeStamp; stamped = true; }",
    ]],
    mustFail: [/65 s ago survives a later top commit/],
  },
  {
    name: "prune-never-drops-left",
    why: "rows of frames that left are never dropped by a later commit",
    file: "background.js",
    edits: [["else if (e.left < old) { entries.splice(i, 1); stamped = true; }", "else if (false) { entries.splice(i, 1); stamped = true; }"]],
    mustFail: [/61 s later they are gone/],
  },
  {
    name: "pruneDead-drops-left-rows",
    why: "the minute prune drops rows that left (by load age) instead of leaving them to the leave-age rule",
    file: "background.js",
    edits: [["if (e.f === 0 || e.left != null || live.has(e.f)", "if (e.f === 0 || live.has(e.f)"]],
    mustFail: [/keeps a row that left recently/],
  },
  {
    name: "pruneDead-drops-live-frames",
    why: "the minute prune drops rows of frames still in the tab",
    file: "background.js",
    edits: [["e.left != null || live.has(e.f) || now", "e.left != null || now"]],
    mustFail: [/pruneDead drops only old rows/],
  },
  {
    name: "pruneDead-drops-young-rows",
    why: "the minute prune drops gone frames' rows younger than 60 s",
    file: "background.js",
    edits: [[" || now - e.t < DEAD_FRAME_MS) continue;", ") continue;"]],
    mustFail: [/pruneDead drops only old rows/],
  },
  {
    name: "liveFrames-null-prunes",
    why: "a tab whose frames cannot be read (getAllFrames null) has its rows pruned",
    file: "background.js",
    edits: [["    const live = await liveFrames(id);\n", "    const live = (await liveFrames(id)) ?? new Map();\n"]],
    mustFail: [/frames cannot be read are not pruned/],
  },

  // --- 'left' stamps must reach storage ------------------------------------
  {
    name: "left-stamp-not-dirty",
    why: "a commit that only stamps 'left' does not mark the tab for saving",
    file: "background.js",
    edits: [["    if (stamped) touchTab(d.tabId);\n", ""]],
    mustFail: [/saves the 'left' stamps/],
  },
  {
    name: "left-stamp-not-saved",
    why: "a same-site top commit that only stamps 'left' never schedules a save",
    file: "background.js",
    edits: [["      if (stamped) persist();\n      return;", "      return;"]],
    mustFail: [/saves the 'left' stamps/],
  },
  {
    name: "left-not-packed",
    why: "saved rows lose their 'left' stamp, so a restore brings left frames back as live",
    file: "background.js",
    edits: [["[f, p, h, t, left ?? 0]", "[f, p, h, t, 0]"]],
  },

  // --- Late navigation events ------------------------------------------------
  {
    name: "no-re-decision",
    why: "a navigation event after tabs.onCreated's 50 ms wait is not re-judged",
    file: "background.js",
    edits: [["? pending.then((listed) => listed || decideFromNav(details, atSeq))", "? pending"]],
    mustFail: [/late navigation event/],
  },
  {
    name: "late-nav-judged-now",
    why: "a late navigation event is judged at its arrival, not at the tab's creation",
    file: "background.js",
    edits: [["const atSeq = born.get(details.tabId)?.atSeq ?? seq + 1;", "const atSeq = seq + 1;"]],
    mustFail: [/late navigation event/],
  },
  {
    name: "nav-source-ignored",
    why: "the navigation source naming the opener frame is never used",
    file: "background.js",
    edits: [["if (source) return decideFromNav(source, atSeq);", "if (false && source) return decideFromNav(source, atSeq);"]],
  },

  // --- Unknown window (tabs open before the worker, no saved rows) ----------
  {
    name: "no-unknown-window",
    why: "a seeded tab with no saved rows is judged by what it shows now",
    file: "background.js",
    edits: [["    if (f === 0 && unknownTabs.has(tabId)) return true;\n", ""]],
    mustFail: [/tabs open before the worker started/],
  },
  {
    name: "no-unknown-seed",
    why: "tabs with no saved rows are never put in the unknown window",
    file: "background.js",
    edits: [["        if (!entries.length) unknownTabs.add(tab.id);\n", ""]],
    mustFail: [/tabs open before the worker started/],
  },
  {
    name: "unknown-window-never-ends",
    why: "the unknown window outlives the first top-frame commit (over-blocks)",
    file: "background.js",
    edits: [["    unknownTabs.delete(d.tabId);\n", ""]],
  },

  // --- Vanished frame, back/forward cache ----------------------------------
  {
    name: "vanished-frame-unlisted",
    why: "a frame with no record and no live entry counts as unlisted instead of falling back to the top frame",
    file: "background.js",
    edits: [["if (!now) { f = 0; continue; }", "if (!now) return false;"]],
    mustFail: [/vanished frame falls back/],
  },
  {
    name: "no-bfcache-live-recording",
    why: "a back/forward restore does not record its live subframes",
    file: "background.js",
    edits: [["liveFrames(tabId).then((live) => {", "liveFrames(tabId).then((live) => { return;"]],
    mustFail: [/back\/forward re-commit/],
  },
  {
    name: "no-restored-scan",
    why: "a no-source popup from a restored page ignores the page's listed subframes",
    file: "background.js",
    edits: [["  if (!restoredTabs.has(openerTabId)) return false;\n", "  return false;\n"]],
  },

  // --- 1000-row cap fails closed --------------------------------------------
  {
    name: "cap-no-trimmed",
    why: "losing top-frame rows to the cap does not mark the tab trimmed",
    file: "background.js",
    edits: [["if (sub < 0) { trimmed.add(tabId); capped = true; }", "if (sub < 0) { capped = true; }"]],
    mustFail: [/trim|trimmed/],
  },
  {
    name: "cap-top-first",
    why: "the cap drops the oldest row of any frame, top rows included, before subframe rows",
    file: "background.js",
    edits: [["const sub = list.findIndex((e) => e.f !== 0);", "const sub = -1;"]],
    mustFail: [/drops sub-frame rows first/],
  },
  {
    name: "trimmed-ignored",
    why: "a trimmed tab with no row for the moment is judged by what it shows now",
    file: "background.js",
    edits: [["      if (trimmed.has(tabId)) return true;\n", ""]],
    mustFail: [/trimmed tab counts as listed/],
  },

  // --- Spawned chain ---------------------------------------------------------
  {
    name: "no-spawned-check",
    why: "a blocked popup's own popups are judged by what it shows",
    file: "background.js",
    edits: [["  if (spawned.has(tabId)) return true;\n", ""]],
    mustFail: [/blocked popup's own popups are closed/],
  },
  {
    name: "block-not-spawned",
    why: "a blocked tab is not remembered as a popup of a listed site",
    file: "background.js",
    edits: [["function block(tabId, why) {\n  spawned.add(tabId);\n", "function block(tabId, why) {\n"]],
    mustFail: [/blocked popup's own popups are closed/],
  },
  {
    name: "spawned-not-restored",
    why: "a cold worker forgets which tabs were blocked popups",
    file: "background.js",
    edits: [["    (saved.spawned ?? []).forEach((id) => spawned.add(id));\n", ""]],
    mustFail: [/cold: the spawned list is restored/],
  },

  // --- Closed tabs forgotten after 30 s --------------------------------------
  {
    name: "forget-immediately",
    why: "a closed tab is forgotten at once, so its popups can't be judged by it",
    file: "background.js",
    edits: [["if (now - at < 30_000) continue;", "if (now - at < 0) continue;"]],
    mustFail: [/closed listed tab still judges popups for 30 s/],
  },
  {
    name: "forget-after-300s",
    why: "closed tabs linger ten times longer",
    file: "background.js",
    edits: [["if (now - at < 30_000) continue;", "if (now - at < 300_000) continue;"]],
  },
  {
    name: "gone-not-recorded",
    why: "a closed tab is never forgotten",
    file: "background.js",
    edits: [["  gone.set(tabId, Date.now());\n", ""]],
  },
  {
    name: "no-31s-repersist",
    why: "a warm worker does not forget a closed tab 31 s later",
    file: "background.js",
    edits: [["  setTimeout(persist, 31_000); // forgets it, if the worker is still running\n", ""]],
  },
  {
    name: "restore-forget-keeps-rows",
    why: "a cold worker forgets an old closed tab but leaves its saved rows",
    file: "background.js",
    edits: [["    forgotten.forEach(touchTab);\n", ""]],
    mustFail: [/saved rows of a tab closed over 30 s ago are removed/],
  },

  // --- Context-menu record: single use, expiry, voiding -------------------
  {
    name: "menu-not-single-use",
    why: "one menu keeps any number of tabs",
    file: "background.js",
    edits: [["    menus.delete(sourceTabId); // one tab per menu\n", ""]],
    mustFail: [/keeps one tab the menu offered/],
  },
  {
    name: "menu-window-300s",
    why: "a menu record lasts 300 s instead of 30 s",
    file: "background.js",
    edits: [["const MENU_WINDOW_MS = 30_000;", "const MENU_WINDOW_MS = 300_000;"]],
    mustFail: [/lasts 30 s/],
  },
  {
    name: "menu-void-ignored",
    why: "a synthetic activation after the menu does not void it",
    file: "background.js",
    edits: [["      m.voided = true;\n", ""]],
    mustFail: [/is void after a synthetic activation/],
  },
  {
    name: "menu-no-recheck-void",
    why: "the 50 ms re-check ignores a void that arrived during it",
    file: "background.js",
    edits: [["if (!fresh || fresh.voided || ", "if (!fresh || "]],
    mustFail: [/is void after a synthetic activation/],
  },
  {
    name: "menu-no-recheck-sleep",
    why: "the record is trusted without waiting for an in-flight synthetic activation",
    file: "background.js",
    edits: [["    await sleep(50);\n", ""]],
    mustFail: [/is void after a synthetic activation/],
  },
  {
    name: "menu-closed-ignored",
    why: "closing the menu does not end the record",
    file: "background.js",
    edits: [["    if (menus.delete(id)) { touchGlobals(); persist(true); }\n", ""]],
    mustFail: [/ends when the menu closes/],
  },
  {
    name: "menu-record-debounced",
    why: "a menu record waits for the debounced save, so a worker stop can lose it",
    file: "background.js",
    edits: [["srcs, t: Date.now() });\n    touchGlobals();\n    persist(true);", "srcs, t: Date.now() });\n    touchGlobals();\n    persist();"]],
    mustFail: [/keeps one tab the menu offered, saved at once/],
  },
  {
    name: "menu-data-src-kept",
    why: "data: image srcs are stored in the record",
    file: "background.js",
    edits: [[" && !s.startsWith(\"data:\")", ""]],
    mustFail: [/stores capped srcs/],
  },

  // --- Other background decisions ----------------------------------------
  {
    name: "blank-never-inherits",
    why: "a top-frame about:blank made by a listed page sheds the listed site",
    file: "background.js",
    edits: [["h = USER_TRANSITIONS.has(d.transitionType) ? \"\" : (lastOf(entries, 0)?.h ?? \"\");", "h = \"\";"]],
    mustFail: [/about:blank inherits the listed site/],
  },
  {
    name: "prerender-recorded",
    why: "prerender commits are recorded as what the tab shows",
    file: "background.js",
    edits: [["  if (d.documentLifecycle === \"prerender\") return;\n", ""]],
    mustFail: [/prerender commits are ignored/],
  },
  {
    name: "no-failed-save-cleanup",
    why: "a failed save leaves the old record to be restored later",
    file: "background.js",
    edits: [["        chrome.storage.session.remove([...history.keys()].map(hkey).concat([\"trimmed\", \"restoredTabs\"])).catch(() => {});\n", ""]],
    mustFail: [/removes the saved history when a write fails/],
  },
  {
    name: "no-domain-swap",
    why: "a change to the domain list is not applied until the worker restarts",
    file: "background.js",
    edits: [["    domainsCache = Promise.resolve(changes.domains.newValue ?? []);\n", ""]],
    mustFail: [/change to the domain list applies at once/],
  },
  {
    name: "inlisted-no-history",
    why: "inListedTab answers from the address only, not the top-frame history",
    file: "background.js",
    edits: [[
      "    const shows = isBlockedUrl(sender.tab?.url, domains) ||\n      (id != null && hostIsBlocked(lastOf(history.get(id) ?? [], 0)?.h, domains));",
      "    const shows = isBlockedUrl(sender.tab?.url, domains);",
    ]],
    mustFail: [/answers from the address, the top-frame history/],
  },
  {
    name: "inlisted-no-spawned",
    why: "inListedTab says a blocked popup is unlisted",
    file: "background.js",
    edits: [["const popupOfListed = id != null && (spawned.has(id) || ", "const popupOfListed = id != null && ("]],
    mustFail: [/answers from the address, the top-frame history/],
  },
  {
    name: "restore-read-uncaught",
    why: "a failed session read skips seeding the open tabs",
    file: "background.js",
    edits: [["  .catch(() => {})\n  .then(async () => {", "  .then(async () => {"]],
    mustFail: [/failed restore still seeds open tabs/],
  },

  // --- Site rules (match.js) ------------------------------------------------
  {
    name: "label-anchor-dropped",
    why: "rules match any host suffix (endsWith(d), not endsWith('.' + d)): example.com lists evilexample.com",
    file: "match.js",
    edits: [["      i = h.indexOf(\".\", i + 1);\n", "      i = i + 1 < h.length ? i + 1 : -1;\n"]],
    mustFail: [/does not list "evilexample\.com"/],
  },
  {
    name: "exceptions-ignored",
    why: "!host exceptions never unlist a host",
    file: "match.js",
    edits: [["    if (lookup(h, c.notExact, c.notSub) !== undefined) return undefined;\n", ""]],
    mustFail: [/excepted host keeps its popups/],
  },
  {
    name: "wildcard-ignored",
    why: "the '*' rule lists nothing",
    file: "match.js",
    edits: [["return lookup(h, c.exact, c.sub) ?? c.any ?? undefined;", "return lookup(h, c.exact, c.sub) ?? undefined;"]],
    mustFail: [/'\*' lists every other host/],
  },
  {
    name: "exact-covers-subdomains",
    why: "an =host rule also lists its subdomains",
    file: "match.js",
    edits: [["r.except ? (r.exact ? c.notExact : c.notSub) : (r.exact ? c.exact : c.sub)", "r.except ? (r.exact ? c.notExact : c.notSub) : c.sub"]],
  },
  {
    name: "one-trailing-dot",
    why: "only one trailing dot is stripped, so example.com.. slips past",
    file: "match.js",
    edits: [["const norm = (h) => String(h ?? \"\").toLowerCase().replace(/\\.+$/, \"\");", "const norm = (h) => String(h ?? \"\").toLowerCase().replace(/\\.$/, \"\");"]],
  },
  {
    name: "case-sensitive-host",
    why: "hosts are not lowercased, so EXAMPLE.com slips past",
    file: "match.js",
    edits: [["const norm = (h) => String(h ?? \"\").toLowerCase().replace(", "const norm = (h) => String(h ?? \"\").replace("]],
  },

  // --- Menu matching (menu-match.js) ---------------------------------------
  {
    name: "goto-host-prefix",
    why: "\"Go to example.com/a\" matches example.com.evil/a",
    file: "menu-match.js",
    edits: [["if (normHost(selUrl.hostname) !== normHost(tabUrl.hostname)) return false;", "if (!normHost(tabUrl.hostname).startsWith(normHost(selUrl.hostname))) return false;"]],
  },
  {
    name: "goto-path-prefix",
    why: "\"Go to\" accepts any path under the selected one",
    file: "menu-match.js",
    edits: [["return normPath(selUrl) === normPath(tabUrl);", "return normPath(tabUrl).startsWith(normPath(selUrl));"]],
  },
  {
    name: "search-short-selection",
    why: "a selection under 3 characters (even empty) matches any query string",
    file: "menu-match.js",
    edits: [["if (words.length < 3) return false;", "if (words.length < 0) return false;"]],
  },
  {
    name: "pdf-search-http",
    why: "the PDF-viewer search exemption accepts plain http",
    file: "menu-match.js",
    edits: [["export const SEARCH = /^https:\\/\\/", "export const SEARCH = /^https?:\\/\\/"]],
  },
];

// --- Runner ----------------------------------------------------------------

function parseArgs(argv) {
  const o = { only: null, list: false, verbose: false, isolate: false, jobs: Math.min(12, availableParallelism()) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") o.only = new Set(argv[++i].split(","));
    else if (a.startsWith("--only=")) o.only = new Set(a.slice(7).split(","));
    else if (a === "-j" || a === "--jobs") o.jobs = Math.max(1, Number(argv[++i]));
    else if (a === "--list") o.list = true;
    else if (a === "--isolate") o.isolate = true;
    else if (a === "-v" || a === "--verbose") o.verbose = true;
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  return o;
}

// The mutated sources, or a STALE reason.
function mutate(m) {
  let src = readFileSync(join(EXT, m.file), "utf8");
  for (const [find, rep] of m.edits) {
    const n = src.split(find).length - 1;
    if (n !== 1) return { stale: `${n} matches for ${JSON.stringify(find.length > 60 ? find.slice(0, 60) + "..." : find)}` };
    src = src.replace(find, () => rep);
  }
  return { src };
}

const TEST_FILES = readdirSync(here).filter((f) => /^unit.*\.mjs$/.test(f)).sort();

// Copies extension/ and the unit tests to <tmp>/{extension,test}, writes
// the mutant, runs the tests there. Resolves { pass, total, fails, ms, timedOut }.
function runTests(m, src, isolate) {
  const root = mkdtempSync(join(tmpdir(), "nnt-mut-"));
  cpSync(EXT, join(root, "extension"), { recursive: true });
  for (const f of [...TEST_FILES, "harness.mjs"]) cpSync(join(here, f), join(root, "test", f));
  if (m) writeFileSync(join(root, "extension", m.file), src);
  const env = { ...process.env, BG_PATH: join(root, "extension", "background.js") };
  delete env.BG_PRUNE_PATH;
  delete env.NNT_TEST_LOG;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const iso = isolate ? [] : ["--experimental-test-isolation=none"];
    execFile(process.execPath, ["--test", ...iso, "--test-reporter=tap", ...TEST_FILES],
      { cwd: join(root, "test"), env, timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1 << 26 },
      (err, out = "") => {
        rmSync(root, { recursive: true, force: true });
        // Leaf tests are indented under their describe; suites fail too
        // when a test in them does, and their names are kept as well.
        const fails = [...out.matchAll(/^\s*not ok \d+ - (.*?)(?: # .*)?$/gm)].map((x) => x[1]);
        resolve({
          total: Number(/^# tests (\d+)/m.exec(out)?.[1] ?? 0),
          pass: Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0),
          fails,
          ms: Date.now() - t0,
          timedOut: !!err?.killed,
          exitOk: !err,
        });
      });
  });
}

async function pool(items, jobs, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let mutants = MUTANTS;
  const names = new Set();
  for (const m of mutants) {
    if (names.has(m.name)) throw new Error(`duplicate mutant name ${m.name}`);
    names.add(m.name);
  }
  if (opts.only) {
    for (const n of opts.only) if (!names.has(n)) { console.error(`no mutant named ${n}`); process.exit(2); }
    mutants = mutants.filter((m) => opts.only.has(m.name));
  }
  if (opts.list) {
    for (const m of mutants) console.log(`${pad(m.name, 28)} ${pad(m.file, 14)} ${(m.mustFail ?? []).map(String).join(" ")}\n  ${m.why}`);
    return 0;
  }

  const t0 = Date.now();
  const base = await runTests(null, null, opts.isolate);
  if (!base.exitOk || base.fails.length || !base.total) {
    console.error(`baseline FAILED: ${base.pass}/${base.total} pass${base.timedOut ? " (timed out)" : ""}`);
    for (const f of base.fails) console.error(`  not ok - ${f}`);
    return 1;
  }
  console.log(`baseline: ${base.pass}/${base.total} pass in ${base.ms} ms (${TEST_FILES.length} files); ${mutants.length} mutants, ${opts.jobs} at a time${opts.isolate ? ", one process per file" : ""}`);

  const results = await pool(mutants, opts.jobs, async (m) => {
    const { src, stale } = mutate(m);
    if (stale) return { m, status: "STALE", detail: stale };
    const r = await runTests(m, src, opts.isolate);
    const missing = (m.mustFail ?? []).filter((re) => !r.fails.some((f) => re.test(f)));
    let status, detail;
    if (r.timedOut) { status = "KILLED"; detail = `timed out after ${TIMEOUT_MS} ms`; }
    else if (!r.fails.length && r.exitOk) { status = "SURVIVED"; detail = "no test failed"; }
    else if (missing.length) { status = "SURVIVED"; detail = `mustFail not failing: ${missing.map(String).join(", ")}`; }
    else { status = "KILLED"; detail = r.fails.length ? `${r.total - r.pass} failing, e.g. ${r.fails[0]}` : "test run failed"; }
    return { m, status, detail, r };
  });

  const w = Math.max(...results.map((x) => x.m.name.length), 6);
  console.log(`\n${pad("mutant", w)}  ${pad("file", 13)}  ${pad("result", 8)}  ${pad("fail", 7)}  ${pad("ms", 5)}  detail`);
  console.log(`${"-".repeat(w)}  ${"-".repeat(13)}  ${"-".repeat(8)}  ${"-".repeat(7)}  ${"-".repeat(5)}  ------`);
  for (const { m, status, detail, r } of results) {
    const fail = r ? `${r.total - r.pass}/${r.total}` : "-";
    console.log(`${pad(m.name, w)}  ${pad(m.file, 13)}  ${pad(status, 8)}  ${pad(fail, 7)}  ${pad(r?.ms ?? "-", 5)}  ${detail}`);
    if (opts.verbose && r) for (const f of r.fails) console.log(`${" ".repeat(w + 2)}not ok - ${f}`);
  }
  const count = (s) => results.filter((x) => x.status === s).length;
  const bad = results.filter((x) => x.status !== "KILLED");
  console.log(`\n${count("KILLED")} killed, ${count("SURVIVED")} survived, ${count("STALE")} stale, of ${results.length}, in ${Date.now() - t0} ms`);
  for (const { m, status, detail } of bad) console.log(`${status}: ${m.name} (${m.file}): ${m.why}. ${detail}`);
  return bad.length ? 1 : 0;
}

process.exitCode = await main();
