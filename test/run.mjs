// End-to-end test: loads the extension into Chromium, blocks "localhost",
// and tries every way of opening a tab from a page on localhost:<PORT>.
// "127.0.0.1:<PORT>" serves the same page but is not listed, as a control.
//
//   node run.mjs                       (uses Playwright's cached Chromium)
//   CHROME=/path/to/chrome node run.mjs
//
// Playwright drives the full extension, where no tab is ever created.
// Wherever the extension closes tabs (background layer only, and the
// tab-under cases) the raw CDP driver in cdp.mjs is used instead, since
// Playwright can freeze a page whose new tab is closed under it.

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchRaw } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, "..", "extension");
const SITE = join(here, "site");
const PORT = Number(process.env.PORT ?? 8799);
const LISTED = `http://localhost:${PORT}`;
const UNLISTED = `http://127.0.0.1:${PORT}`;
// *.test names reach the test server too: plain-http sites that, unlike
// localhost, are not secure contexts.
const HOSTS = "--host-resolver-rules=MAP *.test 127.0.0.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error(`no response in ${ms} ms`); })]);

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), ".cache", "ms-playwright");
  const dir = existsSync(base) && readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  const exe = dir && join(base, dir, "chrome-linux64", "chrome");
  if (!exe || !existsSync(exe)) throw new Error("No Chromium found; set CHROME=/path/to/chrome");
  return exe;
}

const temps = [];
const tempDir = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };

// A copy of the extension without its content scripts, to test the
// background layer on its own.
function backgroundOnlyCopy() {
  const dir = tempDir("nnt-bg-");
  cpSync(EXT, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  delete manifest.content_scripts;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

// --- static server -------------------------------------------------------
const types = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  // /chain?n=3 redirects (client-side, like ad tab-unders) n times, then lands.
  if (path === "/chain") {
    const n = Number(url.searchParams.get("n") ?? 0);
    const next = n > 0 ? `/chain?n=${n - 1}` : "/target.html?case=chain-end";
    return res.writeHead(200, { "content-type": "text/html" }).end(`<script>location.replace(${JSON.stringify(next)})</script>`);
  }
  let body;
  try {
    body = await readFile(join(SITE, path === "/" ? "index.html" : path));
  } catch {
    return res.writeHead(404).end("not found");
  }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "text/plain" }).end(body);
});
await new Promise((ok) => server.listen(PORT, ok));

let failures = 0;
const check = (ok) => (ok ? "PASS" : (failures++, "FAIL"));
const W = 44;
const report = (name, ok, extra = "") => console.log(name.padEnd(W), check(ok), extra);

// --- cases ---------------------------------------------------------------
// Each action gets a driver d: d.click(selector, {modifiers, button}) is a
// real click in the page, d.frameClick(which, selector) clicks inside the
// cross-origin iframe "xframe" or the one "nested" a level deeper.
// `path` is the page the case starts on (index.html by default); with
// { leaves: true } the case moves the tab to another page on purpose.
const cases = [
  ["window.open()",                 (d) => d.click("#btn-open")],
  ["window.open('')",               (d) => d.click("#btn-open-blank")],
  ["window.open saved at load",     (d) => d.click("#btn-saved-open")],
  ["popup window",                  (d) => d.click("#btn-popup")],
  ["document.open(3 args)",         (d) => d.click("#btn-docopen")],
  ["<a target=_blank>",             (d) => d.click("#link-blank")],
  ["<a target=_blank rel=noopener>", (d) => d.click("#link-noopener")],
  ["<a target=someWindow>",         (d) => d.click("#link-named")],
  ["ctrl+click link",               (d) => d.click("#link-plain", { modifiers: ["Control"] })],
  ["shift+click link (new window)", (d) => d.click("#link-plain", { modifiers: ["Shift"] })],
  ["middle-click link",             (d) => d.click("#link-plain", { button: "middle" })],
  ["script-made _blank .click()",   (d) => d.click("#btn-js-click")],
  ["form target=_blank",            (d) => d.click("#btn-form")],
  ["ctrl+click plain form submit",  (d) => d.click("#btn-form-plain", { modifiers: ["Control"] })],
  ["form.submit() on _blank form",  (d) => d.click("#btn-form-js")],
  ["fresh iframe window.open",      (d) => d.click("#btn-iframe-trick")],
  ["cross-origin iframe open()",    (d) => d.frameClick("xframe", "#frame-open")],
  ["cross-origin iframe saved open", (d) => d.frameClick("xframe", "#frame-saved-open")],
  ["cross-origin iframe _blank",    (d) => d.frameClick("xframe", "#frame-blank")],
  ["cross-origin nested iframe open()", (d) => d.frameClick("nested", "#frame-open")],
  ["cross-origin nested iframe _blank", (d) => d.frameClick("nested", "#frame-blank")],
  ["cross-origin iframe jsf open",  (d) => d.frameClick("xframe", "#frame-jsf")],
  // Tricks taken from the ad scripts on 720pstream.cx.
  ["jsf iframe contentWindow.open", (d) => d.click("#j-static")],
  ["PopAds minipop (popup, about:blank)", (d) => d.click("#j-minipop")],
  ["frames[name].open, document.write", (d) => d.click("#j-frames")],
  ["PopAds saved contentWindow",    (d) => d.click("#j-saved")],
  ["iframe open saved, .call(window)", (d) => d.click("#j-saved-fn")],
  ["window.open = iframe's open",   (d) => d.click("#j-restore")],
  ["Adcash bound iframe open",      (d) => d.click("#j-bound")],
  ["shadow-root jsf iframe",        (d) => d.click("#j-shadow")],
  ["nested jsf iframe",             (d) => d.click("#j-nested")],
  ["detached link .click()",        (d) => d.click("#j-detached")],
  ["detached link dispatchEvent",   (d) => d.click("#j-dispatch")],
  ["form.submit from iframe realm", (d) => d.click("#j-form-realm")],
  // Gaps found by the v1.2 review.
  ["<base target=_blank> link",     (d) => d.click("#base-link"), "/base.html"],
  ["formtarget=_blank button",      (d) => d.click("#btn-formtarget")],
  ["closed shadow root _blank link", (d) => d.click("#shadow-link-host")],
  ["ctrl+click in closed shadow root", (d) => d.click("#shadow-plain-host", { modifiers: ["Control"] })],
  ["middle-click in closed shadow root", (d) => d.click("#shadow-plain-host", { button: "middle" })],
  ["_blank form in shadow root",    (d) => d.click("#shadow-form-host")],  // the host holds just the button
  ["non-composed click, shadow link", (d) => d.click("#j-noncomposed")],
  ["closed shadow link .click()",   (d) => d.click("#j-closed-click")],
  ["SVG <a xlink:href target=_blank>", (d) => d.click("#svg-link")],
  ["page fakes the 'unlisted' signal", (d) => d.click("#j-fake-unlisted")],
  ["frame pre-marked as guarded",   (d) => d.click("#j-predefined"), "/tricks.html"],
  ["window.open = frame's native, at load", (d) => d.click("#j-accessor"), "/tricks.html"],
  // Gaps found by the v1.3 review.
  ["open saved from a frame, while parsing", (d) => d.click("#j-parsed-saved"), "/v14.html"],
  ["open saved before the frame loaded",  (d) => d.click("#j-reused-saved"), "/v14.html"],
  ["open(url, ' _self')",                 (d) => d.click("#j-ws-self"), "/v14.html"],
  ["open(url, '   ')",                    (d) => d.click("#j-ws-only"), "/v14.html"],
  ["fake window.name, then open into it", (d) => d.click("#j-ghost"), "/v14.html"],
  ["sandboxed frame opens into a sibling", (d) => d.clickIn("#sbx-sib", "#b"), "/v14.html"],
  ["target set by a page click handler",  (d) => d.click("#late-link"), "/v14.html"],
  ["<base target> set by a click handler", (d) => d.click("#late-base"), "/v14.html"],
  ["form target set by a submit handler", (d) => d.click("#late-form-btn"), "/v14.html"],
  ["_blank form, declarative shadow root", (d) => d.click("#dsf-host"), "/v14.html"],
  ["requestSubmit() in a shadow root",    (d) => d.click("#j-request-submit"), "/v14.html"],
  [".click() in closed declarative shadow", (d) => d.click("#j-decl-closed-click"), "/v14.html"],
  ["_blank in frame written during load", (d) => d.clickIn("#written-early", "#a"), "/v14.html"],
  ["_blank in frame written after load",  (d) => d.clickIn("#written-late", "#a"), "/v14.html"],
  ["_blank link in a data: frame",        (d) => d.clickIn("#data-frame", "#a"), "/v14.html"],
  ["_blank after document.open() of page", async (d) => { await d.click("#j-top-write"); await d.click("#w"); }, "/v14.html"],
  ["page turns itself into a blob: copy", async (d) => { await d.click("#to-blob"); await d.waitUrl(/^blob:/); await d.click("#bb"); },
    "/v14.html", { leaves: true }],
  ["page becomes a blob:null page",       async (d) => { await d.click("#to-blob-null"); await d.waitUrl(/^blob:null/); await d.click("#bb"); },
    "/v14.html", { leaves: true }],
  ["_blank link in a no-script sandbox frame", (d) => d.clickIn("#noscript", "#a"), "/v14.html"],
  ["no-script sandbox frame's window.open", (d) => d.click("#j-noscript-open"), "/v14.html"],
  ["no-script sandbox frame's form.submit", (d) => d.click("#j-noscript-submit"), "/v14.html"],
  ["page faked 'unlisted' during load",   (d) => d.click("#j-fake-early"), "/fakesignals.html"],
  ["page fakes 'arm', then opens",        (d) => d.click("#j-fake-arm"), "/fakesignals.html"],
];

// --- Playwright: full extension ------------------------------------------
let context, sw, page;
const pageErrors = [];

async function launch(extDir, extraArgs = []) {
  await context?.close();
  context = await chromium.launchPersistentContext(tempDir("nnt-"), {
    executablePath: findChrome(),
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, HOSTS, ...extraArgs],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await setDomains(["localhost"]);
  page = context.pages()[0] ?? (await context.newPage());
  watch(page);
}

function watch(p) {
  p.on("pageerror", (e) => pageErrors.push(e.message));
}

const setDomains = (domains) => sw.evaluate((d) => chrome.storage.sync.set({ domains: d }), domains);
const getDomains = () => sw.evaluate(async () => (await chrome.storage.sync.get("domains")).domains);

const pwDriver = () => ({
  click: async (sel, { modifiers, button } = {}) => {
    await page.locator(sel).scrollIntoViewIfNeeded();
    await page.waitForTimeout(100); // let the page settle after scrolling
    await page.click(sel, { modifiers, button });
  },
  frameClick: (which, sel) => (which === "xframe"
    ? page.frameLocator("#xframe")
    : page.frameLocator("#xframe-nested").frameLocator("#inner-frame")).locator(sel).click(),
  clickIn: (frameSel, sel, opts) => page.frameLocator(frameSel).locator(sel).click(opts),
  waitUrl: (re) => page.waitForURL(re, { timeout: 5000, waitUntil: "load" }),
});

async function loadStart(url) {
  await page.goto(url, { waitUntil: "load" });
  if (url.endsWith("/index.html")) {
    await page.frameLocator("#xframe").locator("#frame-open").waitFor();
    await page.frameLocator("#xframe-nested").frameLocator("#inner-frame").locator("#frame-open").waitFor();
  }
  await page.evaluate(() => document.fonts.ready.then(() => 1)); // text reflows when fonts arrive
  await page.waitForTimeout(150); // let arm.js read the domain list
}

async function openCase(start, action, { reload = true } = {}) {
  if (reload) await loadStart(start);
  const created = [];
  const onPage = (p) => created.push(p);
  context.on("page", onPage);
  try {
    await within(action(pwDriver()), 15000);
  } catch (e) {
    // Never let one stuck case take the rest of the run with it.
    context.off("page", onPage);
    for (const p of context.pages()) await p.close().catch(() => {});
    page = await context.newPage();
    watch(page);
    return { error: e.message.split("\n")[0] };
  }
  await page.waitForTimeout(1200);
  context.off("page", onPage);
  const survivors = created.filter((p) => !p.isClosed());
  const ret = await page.evaluate(() => window.__ret).catch(() => undefined);
  for (const p of survivors) await p.close();
  return { created: created.length, survived: survivors.length, stayed: page.url() === start, ret };
}

function printCase(name, r, ok) {
  if (r.error) return report(name, false, `ERROR ${r.error}`);
  const ret = r.ret === undefined ? "" : r.ret === null ? "null" : "Window";
  console.log(name.padEnd(W), check(ok).padEnd(7), String(r.created).padEnd(13), String(r.survived).padEnd(10), ret);
}

// noFlash: the in-page guard must stop every case before a tab exists.
async function mode(title, host, expectBlocked, noFlash) {
  console.log(`\n=== ${title} ===`);
  console.log("case".padEnd(W), "result  tabs-created  tabs-left  window.open-returned");
  for (const [name, action, path = "/index.html", { leaves } = {}] of cases) {
    const start = host + path;
    const r = await openCase(start, action);
    // On the control host the cross-origin iframes are localhost, which is
    // listed, so those cases must be blocked there too.
    const mustBlock = expectBlocked || name.startsWith("cross-origin");
    const ok = mustBlock ? r.survived === 0 && (r.stayed || leaves) && (!noFlash || r.created === 0) : r.survived >= 1;
    printCase(name, r, ok);
  }
}

async function sanity(host, listed) {
  const start = `${host}/index.html`;
  await loadStart(start);
  const results = [];
  const errorsBefore = pageErrors.length;
  const pagesBefore = context.pages().length;
  const inner = () => page.frames().find((f) => f.name() === "inner");

  // Before the page swaps in its own window.open below.
  results.push(["Function.prototype.toString looks native", await page.evaluate(() =>
    [window.open, document.open, HTMLFormElement.prototype.submit, HTMLElement.prototype.click, Function.prototype.toString,
      document.getElementById("jsf-static").contentWindow.open]
      .every((f) => Function.prototype.toString.call(f).includes("[native code]")))]);

  await page.click("#btn-count"); await page.click("#btn-count");
  results.push(["click handlers run", (await page.textContent("#btn-count")) === "clicked 2"]);

  await page.click("#btn-fetch");
  await page.waitForTimeout(300);
  results.push(["fetch() works", (await page.textContent("#fetched")) === "fetched-ok"]);

  await page.click("#btn-wrap-open");
  results.push(["site can wrap window.open", (await page.evaluate(() => window.__wrapOk)) === true]);
  results.push(["window.open === the site's own hook", await page.evaluate(() => {
    const before = window.open;
    const hook = function open() { return "hooked"; };
    window.open = hook;
    const same = window.open === hook && window.open() === "hooked";
    window.open = before;
    return same;
  })]);

  await page.click("#btn-request-submit");
  await page.waitForTimeout(300);
  results.push(["requestSubmit runs the site's submit handler",
    (await page.evaluate(() => window.__ajax)) === 1 && context.pages().length === pagesBefore]);

  await page.click("#link-to-iframe");
  await page.waitForTimeout(500);
  results.push(["target=<named iframe> loads in iframe", inner()?.url().includes("case=in-iframe") && context.pages().length === pagesBefore]);

  await page.click("#btn-open-named-iframe");
  await page.waitForTimeout(500);
  results.push(["window.open into named iframe works", inner()?.url().includes("case=open-in-iframe") && context.pages().length === pagesBefore]);

  const sib = page.frameLocator("#sib");
  await sib.locator("#sib-link").click();
  await page.waitForTimeout(500);
  results.push(["sibling frame's link into named iframe", inner()?.url().includes("case=sib-link") && context.pages().length === pagesBefore]);
  await sib.locator("#sib-open").click();
  await page.waitForTimeout(500);
  results.push(["sibling frame's window.open into it", inner()?.url().includes("case=sib-open") && context.pages().length === pagesBefore]);

  for (const [name, sel] of [["download link (target=_blank) downloads", "#link-download"],
    ["detached download link downloads", "#btn-download-detached"]]) {
    const download = page.waitForEvent("download", { timeout: 3000 }).catch(() => null);
    await page.click(sel);
    const d = await download;
    await page.waitForTimeout(300);
    results.push([name, !!d && context.pages().length === pagesBefore]);
  }

  results.push(["same-origin iframe still usable", await page.evaluate(async () => {
    const f = document.createElement("iframe");
    document.body.append(f);
    f.contentDocument.body.innerHTML = "<p id=x>hi</p>";
    const text = f.contentWindow.document.getElementById("x").textContent;
    const r = await f.contentWindow.fetch("/data.json").then((r) => r.json());
    f.remove();
    return text === "hi" && r.ok === "fetched-ok";
  })]);

  results.push(["no JS errors on page", pageErrors.length === errorsBefore]);

  if (listed) {
    await page.click("#btn-open-blank-self");
    await page.waitForTimeout(400);
    results.push(["open('about:blank', '_self') blocked", page.url() === start]);
  }

  // A page that touches an iframe before it loads: code in the iframe must
  // still act on the iframe, not on the page around it.
  await page.goto(`${host}/earlytouch.html`, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const child = () => page.frames().find((f) => f.url().includes("/child.html") || f.url().includes("case=et-self"));
  if (!listed) {
    results.push(["early-touched iframe: open() opener is itself", await child()?.evaluate(() => window.__popupOpener()).catch(() => false)]);
  }
  await child()?.evaluate(() => window.__selfOpen()).catch(() => {});
  await page.waitForTimeout(600);
  results.push(["early-touched iframe: open(_self) stays in it",
    page.url().endsWith("/earlytouch.html") && !!page.frames().find((f) => f.url().includes("case=et-self"))]);

  await page.goto(start, { waitUntil: "load" });
  await page.click("#btn-open-self");
  await page.waitForURL(/case=open-self/, { timeout: 3000 }).catch(() => {});
  results.push(["window.open(url, '_self') navigates", page.url().includes("case=open-self")]);

  await page.goto(start, { waitUntil: "load" });
  await page.click("#link-same");
  await page.waitForURL(/case=same-tab/, { timeout: 3000 }).catch(() => {});
  results.push(["same-tab link navigates", page.url().includes("case=same-tab")]);
  for (const p of context.pages()) if (p !== page) await p.close();
  return results;
}

// The guard runs on every page, so on unlisted sites it must be invisible:
// once arm.js has found the page unlisted, the guard removes itself.
async function unlistedIsUntouched() {
  console.log("\n=== Unlisted site is untouched ===");
  await page.goto(`${UNLISTED}/index.html`, { waitUntil: "load" });
  await page.waitForTimeout(300);
  report("window.open is a plain property again", await page.evaluate(() =>
    "value" in Object.getOwnPropertyDescriptor(window, "open")));
  report("no extension code in DOM call stacks", await page.evaluate(() => {
    try { HTMLElement.prototype.click.call(1); } catch (e) { return !/chrome-extension:/.test(e.stack); }
    return false;
  }));
  report("window.open was plain during load too", await page.evaluate(() => window.__openWasData === true));
  // Every patch, in the page and in its same-origin frames, is gone again.
  report("no guard left in page or frames", await page.evaluate(() => [window, __byName("jsfstatic"), __byName("jsfouter")[0], __earlyBlank].every((w) => {
    const ts = w.Function.prototype.toString;
    let tsClean = false;
    try { ts.call(1); } catch (e) { tsClean = !/chrome-extension:/.test(e.stack); }
    const native = (f) => typeof f === "function" && ts.call(f).includes("[native code]") && !Object.hasOwn(f, "prototype");
    const P = (name) => w[name].prototype;
    const methods = [[P("Node"), "appendChild"], [P("Element"), "append"], [P("Element"), "insertAdjacentHTML"],
      [P("Document"), "write"], [P("Document"), "open"], [P("HTMLElement"), "click"], [P("EventTarget"), "dispatchEvent"],
      [P("Element"), "attachShadow"], [P("HTMLFormElement"), "submit"], [P("HTMLFormElement"), "requestSubmit"]];
    const accessors = [[P("Element"), "innerHTML", "set"], [P("HTMLIFrameElement"), "contentWindow", "get"]];
    return tsClean && "value" in Object.getOwnPropertyDescriptor(w, "open") && native(w.open) && !("__noNewTabsGuard" in w) &&
      methods.every(([o, k]) => native(o[k])) && accessors.every(([o, k, a]) => native(Object.getOwnPropertyDescriptor(o, k)[a]));
  })));
  report("a saved wrapper doesn't bring it back", await page.evaluate(async () => {
    const f = document.createElement("iframe");
    f.src = "javascript:false"; // no guard of its own: only the page's could adopt it
    __savedAppend.call(document.body, f);
    await new Promise((r) => setTimeout(r, 500));
    const w = f.contentWindow;
    const ok = !("__noNewTabsGuard" in w) && "value" in Object.getOwnPropertyDescriptor(w, "open");
    f.remove();
    return ok;
  }));
  report("assigned window.open is the same object", await page.evaluate(() => {
    const stub = function () { return "mine"; };
    window.open = stub;
    return window.open === stub && window.open("/x") === "mine";
  }));
  for (const [name, ok] of await sanity(UNLISTED, false)) report(name, ok);

  // Adding a site arms already-open pages without a reload.
  await page.goto(`${UNLISTED}/index.html`, { waitUntil: "load" });
  await page.waitForTimeout(300);
  await setDomains(["localhost", "127.0.0.1"]);
  await page.waitForTimeout(300);
  const r = await openCase(`${UNLISTED}/index.html`, (d) => d.click("#btn-open"), { reload: false });
  report("adding a site applies without reload", r.created === 0 && r.survived === 0);
  const r2 = await openCase(`${UNLISTED}/index.html`, (d) => d.click("#j-static"), { reload: false });
  report("... including its hidden frames", r2.created === 0 && r2.survived === 0);
  await setDomains(["localhost"]);
}

// Plain-http sites are not secure contexts, so some APIs are missing there.
async function insecureSite() {
  console.log("\n=== Plain-http sites (not secure contexts) ===");
  await setDomains(["localhost", "listed.test"]);
  const listed = `http://listed.test:${PORT}/index.html`, unlisted = `http://plain.test:${PORT}/index.html`;
  await loadStart(listed);
  report("listed: guard armed", await page.evaluate(() => !isSecureContext && window.__noNewTabsGuard?.() === true));
  for (const [name, sel] of [["listed: window.open", "#btn-open"], ["listed: target=_blank", "#link-blank"], ["listed: hidden frame", "#j-static"]]) {
    const r = await openCase(listed, (d) => d.click(sel));
    report(name, r.created === 0 && r.survived === 0, `(created ${r.created})`);
  }
  await page.goto(unlisted, { waitUntil: "load" });
  await page.waitForTimeout(300);
  report("unlisted: guard removed", await page.evaluate(() =>
    !isSecureContext && "value" in Object.getOwnPropertyDescriptor(window, "open") && !("__noNewTabsGuard" in window)));
  const r = await openCase(unlisted, (d) => d.click("#btn-open"));
  report("unlisted: window.open works", r.survived === 1);
  await setDomains(["localhost"]);
}

// A document picture-in-picture window is a window too.
async function pictureInPicture() {
  console.log("\n=== Picture-in-picture window ===");
  const results = {};
  for (const host of [LISTED, UNLISTED]) {
    await loadStart(`${host}/v14.html`);
    await page.click("#j-pip");
    await page.waitForFunction(() => window.__pip !== "pending", null, { timeout: 3000 }).catch(() => {});
    results[host] = await page.evaluate(() => window.__pip);
    for (const p of context.pages()) if (p !== page) await p.close();
  }
  console.log("requestWindow:", JSON.stringify(results));
  report("listed: refused", results[LISTED] === "NotAllowedError");
  report("unlisted: not refused by us", results[UNLISTED] !== "NotAllowedError");
}

// Tabs the user (or another extension) opens must never be closed, even
// though Ctrl+T, Alt+Enter and duplicate all set openerTabId to the listed
// tab. These calls produce the same tabs.onCreated fields as those actions.
const userActions = [
  ["Ctrl+T-like (createTarget newtab)", (b) => b.createTarget("chrome://newtab/")],
  ["createTarget about:blank",          (b) => b.createTarget("about:blank")],
  ["duplicate tab",                     (b, id) => b.sw(`chrome.tabs.duplicate(${id}).then(() => 1)`)],
  ["tabs.create with opener",           (b, id) => b.sw(`chrome.tabs.create({ url: "about:blank", openerTabId: ${id} }).then(() => 1)`)],
  ["windows.create popup",              (b) => b.sw(`chrome.windows.create({ type: "popup", url: "about:blank" }).then(() => 1)`)],
];

async function userTabsSurvive() {
  console.log("\n=== User-opened tabs on a listed site survive ===");
  await page.goto(`${LISTED}/index.html`, { waitUntil: "load" });
  await page.bringToFront();
  const listedTabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${LISTED}/index.html`);
  const cdp = await context.newCDPSession(page);
  const b = {
    createTarget: (url) => cdp.send("Target.createTarget", { url }),
    sw: (expr) => sw.evaluate(expr),
  };
  for (const [name, act] of userActions) {
    const created = [];
    const onPage = (p) => created.push(p);
    context.on("page", onPage);
    await act(b, listedTabId);
    await page.waitForTimeout(800);
    context.off("page", onPage);
    const alive = created.filter((p) => !p.isClosed());
    report(name, created.length >= 1 && alive.length === created.length);
    for (const p of alive) await p.close();
  }
}

async function optionsPage() {
  console.log("\n=== Options page ===");
  const extId = new URL(sw.url()).host;
  // The tab you were on before opening Options is the "current domain".
  await page.goto(`${UNLISTED}/target.html`);
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.waitForFunction(() => document.getElementById("list").value === "localhost");
  await opts.fill("#list", "https://www.Example.com/some/path\nlocalhost\nnot a domain!!\nexample.com");
  await opts.click("#save");
  await opts.waitForTimeout(300);
  const saved = await getDomains();
  console.log("saved:", JSON.stringify(saved));
  report("normalises and de-duplicates", JSON.stringify(saved) === JSON.stringify(["example.com", "localhost"]));

  const label = await opts.textContent("#add-current");
  await opts.click("#add-current");
  await opts.waitForTimeout(300);
  const afterAdd = await getDomains();
  console.log("button:", JSON.stringify(label), " saved:", JSON.stringify(afterAdd));
  report("'Add current domain' button", label.includes("127.0.0.1") && afterAdd.includes("127.0.0.1") && afterAdd.includes("example.com"));
  await opts.close();

  // Restore the list the tab tests expect (127.0.0.1 is the unlisted control).
  await setDomains(["localhost"]);
}

// --- Raw CDP: wherever the extension closes tabs ---------------------------
let raw, rp;

async function launchRawBrowser(extDir, extraArgs = []) {
  await raw?.close();
  raw = await launchRaw(findChrome(), extDir, extraArgs);
  await raw.setDomains(["localhost"]);
  rp = await raw.firstPage();
}

const rawDriver = () => ({
  click: (sel, opts) => rp.click(sel, opts),
  frameClick: (which, sel) => rp.frameEval(which, `document.querySelector(${JSON.stringify(sel)}).click()`),
  clickIn: (frameSel, sel, opts) => rp.clickIn(frameSel, sel, opts),
  waitUrl: async (re) => {
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(50)) if (re.test(await rp.url())) break;
    await rp.waitLoad();
  },
});

async function rawLoad(url) {
  await rp.goto(url);
  if (url.endsWith("/index.html")) {
    await rp.frameEval("xframe", "1", false);
    await rp.frameEval("nested", "1", false);
  }
  await rp.eval("document.fonts.ready.then(() => 1)");
  await sleep(150);
}

// Run an action on a page; report the page tabs it created and how many
// are still open 1.2 s later. Survivors are closed afterwards.
async function rawCase(action, p = rp) {
  const since = Date.now();
  try {
    await within(action(), 15000);
  } catch (e) {
    return { error: e.message.split("\n")[0] };
  }
  await sleep(1200);
  const created = raw.pagesSince(since).filter((t) => t.targetId !== p.targetId);
  const survivors = created.filter((t) => !t.destroyed);
  for (const t of survivors) await raw.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
  const ret = await p.eval("window.__ret === undefined ? undefined : window.__ret === null ? null : 'Window'").catch(() => undefined);
  return { created: created.length, survived: survivors.length, ret };
}

async function rawMode(title, host) {
  console.log(`\n=== ${title} ===`);
  console.log("case".padEnd(W), "result  tabs-created  tabs-left  window.open-returned");
  for (const [name, action, path = "/index.html", { leaves } = {}] of cases) {
    const start = host + path;
    await rawLoad(start);
    const r = await rawCase(() => action(rawDriver()));
    r.stayed = (await rp.url()) === start;
    printCase(name, r, r.survived === 0 && (r.stayed || leaves));
  }
}

async function rawUserTabsSurvive() {
  console.log("\n=== User-opened tabs on a listed site survive ===");
  await rawLoad(`${LISTED}/index.html`);
  const listedTabId = await raw.swEval(`chrome.tabs.query({ url: "${LISTED}/index.html" }).then((t) => t[0]?.id)`);
  const b = {
    createTarget: (url) => raw.send("Target.createTarget", { url }),
    sw: (expr) => raw.swEval(expr),
  };
  for (const [name, act] of userActions) {
    const r = await rawCase(() => act(b, listedTabId));
    report(name, r.created >= 1 && r.survived === r.created);
  }
  // Typing a new address in a listed tab starts afresh: no carry-over.
  await rawLoad(`${UNLISTED}/index.html`);
  const r = await rawCase(() => rp.click("#btn-open"));
  report("typed away from listed: opens work", r.survived === 1);
}

// Ad scripts open a tab and at once move the listed tab away (or close
// it), so by the time the background looks, the opener no longer shows the
// listed site. And the reverse: once the user has followed a link off a
// listed site, the next site's own popups must work.
async function tabUnder() {
  console.log("\n=== Tab-under: the listed tab moves away right after opening ===");
  for (const [name, sel] of [["hidden-frame open, then leave", "#t-under-jsf"], ["window.open, then leave", "#t-under-main"],
    ["hidden-frame open, then 6 redirects", "#t-under-chain"]]) {
    await rawLoad(`${LISTED}/index.html`);
    const r = await rawCase(() => rp.click(sel));
    report(name, !r.error && r.survived === 0, `(created ${r.created})`);
  }

  await rawLoad(`${UNLISTED}/index.html`);
  await rp.click("#link-cross");
  await sleep(300);
  await rp.waitLoad();
  await sleep(150);
  const back = await rawCase(() => rp.click("#t-back"));
  report("hidden-frame open, then history.back()", !back.error && back.survived === 0, `(created ${back.created})`);

  // window.close() works in a tab with a single history entry.
  const solo = await raw.open(`${LISTED}/index.html`);
  await sleep(300);
  const close = await rawCase(() => solo.click("#t-close"), solo);
  report("hidden-frame open, then window.close()", !close.error && close.survived === 0, `(created ${close.created})`);

  for (const [name, sel] of [["after a link off a listed site: window.open", "#btn-open"],
    ["after a link off a listed site: hidden frame", "#j-static"]]) {
    await rawLoad(`${LISTED}/index.html`);
    await rp.click("#link-cross");
    await sleep(300);
    await rp.waitLoad();
    await sleep(300);
    const r = await rawCase(() => rp.click(sel));
    report(name, (await rp.url()).startsWith(UNLISTED) && r.survived === 1, `(created ${r.created})`);
  }
}

// The worker is stopped after 30 s of quiet, so on a page watched for a
// while it is normally cold when the popup comes.
async function workerRestart() {
  console.log("\n=== Service worker stopped before the popup ===");
  for (const [name, sel] of [["window.open", "#btn-open"], ["hidden-frame open, then leave", "#t-under-jsf"],
    ["hidden-frame open", "#j-static"], ["hidden-frame open, then 6 redirects", "#t-under-chain"]]) {
    await rawLoad(`${LISTED}/index.html`);
    const stopped = await raw.stopSW();
    const r = await rawCase(() => rp.click(sel));
    report(`cold worker: ${name}`, stopped && !r.error && r.survived === 0, `(created ${r.created})`);
  }
}

async function listedFrameInUnlistedPage() {
  console.log("\n=== Listed site framed in an unlisted page ===");
  for (const [name, which, sel] of [["listed iframe: window.open", "xframe", "#frame-open"],
    ["listed iframe: target=_blank", "xframe", "#frame-blank"], ["nested listed iframe: window.open", "nested", "#frame-open"]]) {
    await rawLoad(`${UNLISTED}/index.html`);
    const r = await rawCase(() => rawDriver().frameClick(which, sel));
    report(name, !r.error && r.survived === 0, `(created ${r.created})`);
  }
  // The frame leaves, or is removed, right after opening: judged by what it was.
  for (const cold of [false, true]) {
    for (const [name, sel] of [["open, then the frame leaves", "#frame-open-leave"], ["open, then the frame is removed", "#frame-open-remove"]]) {
      await rawLoad(`${UNLISTED}/index.html`);
      const stopped = !cold || await raw.stopSW();
      const r = await rawCase(() => rawDriver().frameClick("xframe", sel));
      report(`listed iframe: ${name}${cold ? " (cold worker)" : ""}`, stopped && !r.error && r.survived === 0, `(created ${r.created})`);
    }
  }
}

// Issue 7: tabs that already have a URL and no navigation source
// (javascript:false frames, back/forward-cache restores) must still be
// judged by their opener. Runs background-only, where no guard hides them.
async function noSourceTabs() {
  console.log("\n=== Tabs with a URL and no navigation source (issue 7) ===");
  await rawLoad(`${LISTED}/index.html`);
  const jsf = await rawCase(() => rp.click("#j-jsf-blank"));
  report("synthetic middle-click in jsf frame is closed", !jsf.error && jsf.survived === 0, `(created ${jsf.created})`);

  // Listed iframe on an unlisted page, after a back/forward round trip: a
  // plain window.open from the listed iframe has no source and must still
  // be closed. If the page was not restored from cache, the exact source
  // path already closes it, so this passes either way.
  await rawLoad(`${UNLISTED}/index.html`);
  await rp.click("#link-cross");
  await sleep(300);
  await rp.waitLoad();
  await sleep(150);
  await rp.eval(`history.back()`);
  await sleep(500);
  await rp.waitLoad();
  await sleep(200);
  const restored = await rp.eval(`performance.getEntriesByType("navigation").map((n) => n.type).join(",")`).catch(() => "");
  const r = await rawCase(() => rawDriver().frameClick("xframe", "#frame-open"));
  report(`listed iframe open after back/forward is closed (nav: ${restored})`, !r.error && r.survived === 0, `(created ${r.created})`);
}

// What the user picks from a context menu opens a tab of their own, but a
// context menu must not open the door for the page: a link click that gets
// past the in-page guard right after one is still closed.
async function contextMenu() {
  console.log("\n=== Context menu on a listed page ===");
  const menus = () => raw.swEval(`chrome.storage.session.get("menus").then((s) => Object.keys(s.menus ?? {}).length)`);
  await rawLoad(`${LISTED}/v14.html`);
  const plain = await rawCase(() => rp.click("#dcl-host", { modifiers: ["Control"] }));
  report("ctrl+click, closed declarative shadow link", !plain.error && plain.survived === 0, `(created ${plain.created})`);
  await rawLoad(`${LISTED}/v14.html`);
  await rp.click("#ctx-text", { button: "right" });
  await sleep(400);
  report("context menu is reported", (await menus()) === 1);
  const r = await rawCase(() => rp.click("#dcl-host", { modifiers: ["Control"] }));
  report("... the same, right after a context menu", !r.error && r.survived === 0, `(created ${r.created})`);
  report("a click in the page ends the menu", (await menus()) === 0);
}

// Issue 6: a page must not earn the menu exemption for a tab it opened
// itself — neither with a selection it set during the gesture nor with a
// synthetic click after a genuine-looking record.
async function fakeMenuRecord() {
  console.log("\n=== Faked context-menu record (issue 6) ===");
  const record = () => raw.swEval(`chrome.storage.session.get("menus").then((s) => Object.values(s.menus ?? {})[0] ?? null)`);
  // A. Selection set by the page during the right-button gesture is dropped.
  await rawLoad(`${LISTED}/index.html`);
  await rp.eval(`window.addEventListener("mousedown", () => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("menu-attack"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, true)`);
  await rp.click("#menu-attack", { button: "right" });
  await sleep(400);
  report("gesture-time selection is dropped from the record", (await record())?.selection === "");
  const atk = await rawCase(() => rp.eval(`(() => {
    const doc = document.getElementById("jsf-static").contentDocument;
    const a = doc.createElement("a");
    a.href = "/target.html?case=menu-attack&q=zqxj attack selection words";
    doc.body.append(a);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }));
  })()`, { gesture: true }));
  report("faked-selection tab is closed", !atk.error && atk.survived === 0, `(created ${atk.created})`);
  // B. A matching record is voided by the page's own synthetic click.
  await rawLoad(`${LISTED}/index.html`);
  await rp.eval(`(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("menu-attack"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  })()`);
  await rp.click("#menu-attack", { button: "right" });
  await sleep(400);
  const selB = (await record())?.selection ?? "";
  report("pre-existing selection is kept in the record", selB.includes("zqxj"));
  const voided = await rawCase(() => rp.eval(`(() => {
    const a = document.createElement("a");
    a.href = "/target.html?case=menu-void&q=zqxj attack selection words";
    document.body.append(a);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }));
  })()`, { gesture: true }));
  report("synthetic click after a matching record is closed", !voided.error && voided.survived === 0, `(created ${voided.created})`);
  // C. Only loaded, unlinked images are reported.
  await rawLoad(`${LISTED}/index.html`);
  await rp.click("#menu-realimg", { button: "right" });
  await sleep(400);
  const srcsReal = (await record())?.srcs ?? null;
  report("loaded image is reported", Array.isArray(srcsReal) && srcsReal.some((u) => u.startsWith("data:")));
  await rp.click("#menu-sameimg", { button: "right" });
  await sleep(400);
  const srcsSame = (await record())?.srcs ?? null;
  report("same-link image is not reported", Array.isArray(srcsSame) && !srcsSame.some((u) => u.includes("samelink")));
  await rp.click("#menu-broken", { button: "right" });
  await sleep(400);
  const srcsBroken = (await record())?.srcs ?? null;
  report("broken image is not reported", Array.isArray(srcsBroken) && srcsBroken.length === 0);
  // D. Images composedPath() hides (issue 3): closed shadow root, SVG
  // <image> and <input type=image>. elementFromPoint() still finds the
  // host; the fix steps into the root and collects the new element types.
  await rp.click("#menu-closed-host", { button: "right" });
  await sleep(400);
  const srcsClosed = (await record())?.srcs ?? null;
  report("closed-shadow image is reported", Array.isArray(srcsClosed) && srcsClosed.some((u) => u.includes("px.png?closed-shadow")));
  await rp.click("#menu-svg", { button: "right" });
  await sleep(400);
  const srcsSvg = (await record())?.srcs ?? null;
  report("SVG image is reported", Array.isArray(srcsSvg) && srcsSvg.some((u) => u.includes("px.png?svg")));
  await rp.click("#menu-inputimg", { button: "right" });
  await sleep(400);
  const srcsInput = (await record())?.srcs ?? null;
  report("input image is reported", Array.isArray(srcsInput) && srcsInput.some((u) => u.includes("px.png?input")));
}

// Issue 4: document.open() drops every listener on the window and document,
// including the extension's. A menu right after a rewrite must still be
// reported (only then can the background keep the chosen tab), and a
// rewritten unlisted page must still arm when its site is listed. A kept
// tab itself cannot be driven headless (no native menu), so these assert
// the record and the arming, which is exactly what the rewrite destroys.
async function docOpenMenus() {
  console.log("\n=== Context menu after document.open() (issue 4) ===");
  const record = () => raw.swEval(`chrome.storage.session.get("menus").then((s) => Object.values(s.menus ?? {})[0] ?? null)`);
  // A. The listed page rewrites itself.
  await rawLoad(`${LISTED}/index.html`);
  await rp.click("#menu-attack", { button: "right" });
  await sleep(400);
  report("menu reported before rewrite", !!(await record()));
  await rp.eval(`document.open(); document.write('<p id="rewritten">zqxj rewritten selection words</p>'); document.close();`);
  await sleep(400);
  await rp.eval(`(() => {
    const el = document.getElementById("rewritten");
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  })()`);
  await rp.click("#rewritten", { button: "right" });
  await sleep(400);
  report("menu reported after document.open()", ((await record())?.selection ?? "").includes("rewritten"));
  // B. An editor-style same-origin iframe written with document.open().
  await rawLoad(`${LISTED}/index.html`);
  await rp.eval(`(() => {
    const doc = document.getElementById("sib").contentDocument;
    doc.open(); doc.write('<p id="ed">zqxj editor selection words</p>'); doc.close();
  })()`);
  await sleep(400);
  await rp.eval(`(() => {
    const win = document.getElementById("sib").contentWindow;
    const el = win.document.getElementById("ed");
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    win.getSelection().removeAllRanges();
    win.getSelection().addRange(range);
  })()`);
  await rp.clickIn("#sib", "#ed", { button: "right" });
  await sleep(400);
  report("menu reported in rewritten iframe", ((await record())?.selection ?? "").includes("editor"));
  // C. A page rewritten while unlisted arms once its site is listed.
  await rawLoad(`${UNLISTED}/index.html`);
  await rp.eval(`document.open(); document.write('<p id="q">rewritten while unlisted</p>'); document.close();`);
  await sleep(400);
  await raw.setDomains(["localhost", "127.0.0.1"]);
  await sleep(400);
  report("rewritten unlisted page arms when listed", await rp.eval("window.__noNewTabsGuard?.() === true"));
  await raw.setDomains(["localhost"]);
}

// Issue 5: a script dispatching click with button 1 (or a modifier) on a
// same-tab link opens a background tab. The guard must cancel it, so no
// tab even flashes: assert created === 0, not just survived === 0.
async function syntheticClicks() {
  console.log("\n=== Synthetic clicks on same-tab links (issue 5) ===");
  await rawLoad(`${LISTED}/index.html`);
  for (const [name, sel] of [["synthetic button=1 click", "#j-syn-mid"], ["synthetic ctrl+click", "#j-syn-ctrl"],
      ["synthetic shift+click", "#j-syn-shift"], ["synthetic meta+click", "#j-syn-meta"]]) {
    const r = await rawCase(() => rp.click(sel));
    report(name, !r.error && r.created === 0, `(created ${r.created}, left ${r.survived ?? "?"})`);
  }
}

// Issue 8: a hostile listed page poisoning prototypes or exhausting the
// stack must not keep a tab open. The prototype attacks assert created === 0
// (a flash-then-close still counts as a failure); stack exhaustion has no
// complete in-page fix, so that one asserts the background closes the tab.
// Needs the popup blocker off: the attacks use untrusted opens.
async function hardening() {
  console.log("\n=== Guard hardening (issue 8) ===");
  // 1. An accessor on Array.prototype[1]: the guard must read the real
  // target name, and pass that same copy to the native call.
  await rawLoad(`${LISTED}/index.html`);
  let r = await rawCase(() => rp.eval(`(() => {
    Object.defineProperty(Array.prototype, "1",
      { configurable: true, get() { return "_self"; }, set(v) {} });
    window.open("/target.html?case=h-array", "adwin");
  })()`));
  report("poisoned Array.prototype[1] window.open", !r.error && r.created === 0, `(created ${r.created})`);
  // 2. An aborted signal on Object.prototype: the late re-check after page
  // handlers must still be added.
  await rawLoad(`${LISTED}/index.html`);
  r = await rawCase(async () => {
    await rp.eval(`(() => {
      const c = new AbortController(); c.abort();
      Object.defineProperty(Object.prototype, "signal", { configurable: true, value: c.signal });
      const a = document.createElement("a");
      a.id = "h-late"; a.href = "/target.html?case=h-signal"; a.textContent = "x";
      document.body.append(a);
      a.addEventListener("click", function () { this.target = "_blank"; });
    })()`);
    await rp.click("#h-late");
  });
  report("poisoned Object.prototype.signal late check", !r.error && r.created === 0, `(created ${r.created})`);
  // 3. Stack exhaustion: the page recurses until RangeError, then dispatches
  // a click from each level while unwinding. The first dispatch the browser
  // can run still has no stack for the guard's listener to run in (a probe
  // listener registered after the guard's never fires either), so no
  // in-page fix can cancel every such event: the tab may flash. The guard
  // fails closed whenever its listener runs at all; the guarantee is the
  // background, which closes the tab: assert survived === 0, not no-flash.
  await rawLoad(`${LISTED}/index.html`);
  r = await rawCase(() => rp.eval(`(() => {
    const a = document.createElement("a");
    a.href = "/target.html?case=h-stack"; a.target = "_blank"; a.textContent = "x";
    document.body.append(a);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    (function deep() {
      try { deep(); }
      catch (e) { a.dispatchEvent(ev); }
    })();
  })()`));
  report("stack exhaustion dispatch", !r.error && r.survived === 0, `(created ${r.created}, left ${r.survived})`);
  // 4. A getter on Node.prototype.startContainer: inserting a frame the
  // browser never injects scripts into (javascript: URL) must still be
  // judged in the right window, so the frame is adopted at once.
  await rawLoad(`${LISTED}/index.html`);
  r = await rawCase(() => rp.eval(`(() => {
    const d = document.implementation.createHTMLDocument();
    Object.defineProperty(Node.prototype, "startContainer",
      { configurable: true, get() { return d; } });
    document.body.insertAdjacentHTML("beforeend", '<iframe src="javascript:false"></iframe>');
    window.__ret = window[window.length - 1].open("/target.html?case=h-start", "scframe");
  })()`));
  report("poisoned Node.prototype.startContainer frame insert", !r.error && r.created === 0,
    `(created ${r.created}, returned ${r.ret})`);
  // 5. A replaced window.Function: after document.open() drops the
  // listeners, they must still be put back.
  await rawLoad(`${LISTED}/index.html`);
  r = await rawCase(async () => {
    await rp.eval(`(() => {
      window.Function = function Fake() {};
      document.open();
      document.write('<a id="h-fn" href="/target.html?case=h-fn" target="_blank">x</a>');
      document.close();
    })()`);
    await rp.click("#h-fn");
  });
  report("replaced window.Function document.open()", !r.error && r.created === 0, `(created ${r.created})`);
}

// Issue 9: frames the guard can't reach. Dense same-process sampling
// showed a navigating frame's fresh Window stays parent-unreadable until
// load on this build, where the existing load listener adopts it in the
// same dispatch — so item 1's poll-during-load race has no observable
// window here and gets no test. Item 2 is observable and tested below:
// an opaque frame holding a target=_blank link. Needs the popup blocker
// off: the attacks use untrusted opens.
async function unreachedFrames() {
  console.log("\n=== Frames the guard can't reach (issue 9) ===");
  // An opaque (sandboxed, no allow-same-origin) frame holding a
  // target=_blank link: the parent can never adopt it, so its sandbox must
  // not allow popups in the first place.
  await rawLoad(`${LISTED}/index.html`);
  let r = await rawCase(async () => {
    await rp.eval(`(() => {
      const f = document.createElement("iframe");
      f.id = "h-opaque";
      f.setAttribute("sandbox", "allow-popups allow-forms");
      f.src = "/opaque.html";
      document.body.append(f);
    })()`);
    await sleep(800);
    await rp.clickIn("#h-opaque", "a");
  });
  report("opaque sandbox _blank click", !r.error && r.created === 0, `(created ${r.created})`);
}

// Adding a site arms an open page, hidden frames included, even before any
// input (needs the popup blocker off for the frame to open anything).
async function liveArmNoInput() {
  console.log("\n=== Adding a site guards hidden frames before any input (popup blocker off) ===");
  await rawLoad(`${UNLISTED}/index.html`);
  await raw.setDomains(["localhost", "127.0.0.1"]);
  await sleep(400);
  const r = await rawCase(() => rp.eval(`void __byName("jsfstatic").open("/target.html?case=live-arm-jsf")`));
  report("hidden frame's open, no input", !r.error && r.created === 0, `(created ${r.created})`);
  await raw.setDomains(["localhost"]);
}

// A popup that slips out must not be able to open more. Needs the popup
// blocker off, so the popup's own load-time script can open a window.
async function popupChain() {
  console.log("\n=== Popup chain (popup blocker off) ===");
  await rawLoad(`${LISTED}/index.html`);
  const r = await rawCase(() => rp.eval(`(() => {
    const w = __byName("jsfstatic").open("about:blank", "chain1", "popup=1,width=300,height=200");
    if (w) w.document.write('<script>window.open("/target.html?case=chain2", "chain2", "popup=1,width=300,height=200")<\\/script>');
  })()`));
  report("both windows closed", !r.error && r.survived === 0, `(created ${r.created})`);
}

try {
  await launch(EXT);
  await optionsPage();
  await mode("Blocked site (localhost): full extension (no tab may even flash)", LISTED, true, true);
  console.log("\n=== Blocked site: page keeps working ===");
  for (const [name, ok] of await sanity(LISTED, true)) report(name, ok);
  await mode("Control site (127.0.0.1, not listed)", UNLISTED, false, false);
  await unlistedIsUntouched();
  await insecureSite();
  await pictureInPicture();
  await userTabsSurvive();
  await context.close();
  context = null;

  console.log("\n##### Full extension, raw CDP #####");
  await launchRawBrowser(EXT);
  await tabUnder();
  await workerRestart();
  await contextMenu();
  await fakeMenuRecord();
  await docOpenMenus();
  await syntheticClicks();
  await launchRawBrowser(EXT, ["--disable-popup-blocking"]);
  await liveArmNoInput();
  await hardening();
  await unreachedFrames();

  console.log("\n##### Background layer only (no content scripts) #####");
  const bgOnly = backgroundOnlyCopy();
  await launchRawBrowser(bgOnly);
  await rawMode("Blocked site (localhost): background layer only", LISTED);
  await rawUserTabsSurvive();
  await tabUnder();
  await workerRestart();
  await listedFrameInUnlistedPage();
  await noSourceTabs();

  await launchRawBrowser(bgOnly, ["--disable-popup-blocking"]);
  await popupChain();
} catch (err) {
  failures++;
  console.log("\nERROR:", err);
} finally {
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  if (pageErrors.length) console.log("page errors:", pageErrors);
  await context?.close();
  await raw?.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  server.close();
  process.exit(failures ? 1 : 0);
}
