// Micro-benchmark of the in-page guard's cost on hot DOM paths, on a
// listed (localhost) and an unlisted (127.0.0.1) page, against a browser
// with no extension at all. Timings are taken inside the page with
// performance.now(); each figure is the median of RUNS fresh page loads.
//
//   node bench.mjs                         (no extension vs ../extension)
//   node bench.mjs /path/to/ext-a /path/to/ext-b   (compare builds)
//   RUNS=7 PORT=8810 CHROME=/path/to/chrome node bench.mjs
//
// Not part of the test suite: numbers vary with the machine and load, so
// compare builds within one run, not across runs.

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8810);
const RUNS = Number(process.env.RUNS ?? 5);
const builds = process.argv.length > 2
  ? process.argv.slice(2).map((p) => resolve(p))
  : [join(here, "..", "extension")];

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), ".cache", "ms-playwright");
  const dir = existsSync(base) && readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  const exe = dir && join(base, dir, "chrome-linux64", "chrome");
  if (!exe || !existsSync(exe)) throw new Error("No Chromium found; set CHROME=/path/to/chrome");
  return exe;
}

const server = createServer((req, res) =>
  res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>bench</title><body></body>"));
await new Promise((ok) => server.listen(PORT, ok));

// Runs in the page. Each operation starts from a clean container.
function measure() {
  const out = {};
  const time = (name, fn) => {
    const box = document.createElement("div");
    document.body.append(box);
    const t0 = performance.now();
    fn(box);
    out[name] = performance.now() - t0;
    box.remove();
  };
  time("200 iframe inserts", (box) => { for (let i = 0; i < 200; i++) box.appendChild(document.createElement("iframe")); });
  time("10k div appendChild", (box) => { for (let i = 0; i < 10000; i++) box.appendChild(document.createElement("div")); });
  time("10k subtree appendChild", (box) => {
    for (let i = 0; i < 10000; i++) {
      const d = document.createElement("div");
      d.appendChild(document.createElement("span"));
      box.appendChild(d);
    }
  });
  time("10k setAttribute", (box) => {
    const d = box.appendChild(document.createElement("div"));
    for (let i = 0; i < 10000; i++) d.setAttribute("data-x", "v" + i);
  });
  time("10k classList.add", (box) => {
    const d = box.appendChild(document.createElement("div"));
    for (let i = 0; i < 10000; i++) d.classList.add("c" + (i & 63));
  });
  time("10k textContent sets", (box) => {
    const d = box.appendChild(document.createElement("div"));
    for (let i = 0; i < 10000; i++) d.textContent = "t" + i;
  });
  time("100k contentWindow reads", (box) => {
    const f = box.appendChild(document.createElement("iframe"));
    let w;
    for (let i = 0; i < 100000; i++) w = f.contentWindow;
    return w;
  });
  return out;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function run(extDir) {
  const profile = mkdtempSync(join(tmpdir(), "nnt-bench-"));
  const args = ["--disable-dev-shm-usage"];
  if (extDir) args.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
  const context = await chromium.launchPersistentContext(profile, { executablePath: findChrome(), headless: true, args });
  try {
    if (extDir) {
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
      await sw.evaluate(() => chrome.storage.sync.set({ domains: ["localhost"] }));
    }
    const page = context.pages()[0] ?? (await context.newPage());
    const results = {};
    for (const [label, origin] of [["listed", `http://localhost:${PORT}`], ["unlisted", `http://127.0.0.1:${PORT}`]]) {
      const samples = [];
      for (let i = 0; i < RUNS; i++) {
        await page.goto(`${origin}/?run=${i}`, { waitUntil: "load" });
        // Wait for arm.js's verdict: armed on listed pages, guard gone on unlisted ones.
        if (extDir) {
          const want = label === "listed";
          for (const end = Date.now() + 3000; Date.now() < end; await page.waitForTimeout(20)) {
            const armed = await page.evaluate(() => window.__noNewTabsGuard?.() === true);
            const gone = await page.evaluate(() => window.__noNewTabsGuard === undefined);
            if (want ? armed : gone) break;
          }
        }
        samples.push(await page.evaluate(measure));
      }
      results[label] = Object.fromEntries(Object.keys(samples[0]).map((k) => [k, median(samples.map((s) => s[k]))]));
    }
    return results;
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

try {
  const columns = [["no extension", null], ...builds.map((b) => [b, b])];
  const all = [];
  for (const [name, dir] of columns) all.push([name, await run(dir)]);
  const ops = Object.keys(all[0][1].listed);
  for (const label of ["listed", "unlisted"]) {
    console.log(`\n${label} page (median of ${RUNS}, ms)`);
    console.log(["operation".padEnd(26), ...all.map(([n], i) => (i === 0 ? n : `build ${i}`).padStart(14))].join(""));
    for (const op of ops) {
      console.log([op.padEnd(26), ...all.map(([, r]) => r[label][op].toFixed(2).padStart(14))].join(""));
    }
  }
  builds.forEach((b, i) => console.log(`build ${i + 1}: ${b}`));
} finally {
  server.close();
}
