// A small raw-CDP browser driver for the tests where the extension closes
// tabs. Playwright pauses every new tab until it has attached to it, and
// when the extension closes the tab first, the opener page (same renderer
// process) can freeze mid-click. Here nothing auto-attaches to new tabs,
// so that can't happen. Clicks are real input events.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout: ${what}`); })]);

const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const BUTTONS = { left: 1, right: 2, middle: 4 };

export async function launchRaw(chrome, extDir, extraArgs = []) {
  const profile = mkdtempSync(join(tmpdir(), "nnt-raw-"));
  const proc = spawn(chrome, [
    "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run",
    "--no-default-browser-check", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    ...extraArgs, "about:blank",
  ], { stdio: "ignore" });

  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { await sleep(100); }
  }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });

  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      return d.error ? p.fail(new Error(`${p.method}: ${d.error.message}`)) : p.ok(d.result);
    }
    for (const fn of handlers.get(d.method) ?? []) fn(d.params, d.sessionId);
  };
  const send = (method, params = {}, sessionId, ms = 10000) => within(new Promise((ok, fail) => {
    const i = ++id;
    pending.set(i, { ok, fail, method });
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  }), ms, method);
  const on = (method, fn) => handlers.set(method, [...(handlers.get(method) ?? []), fn]);

  // Every page target ever created, with created/destroyed times.
  const targets = new Map();
  on("Target.targetCreated", ({ targetInfo: t }) => targets.set(t.targetId, { ...t, created: Date.now() }));
  on("Target.targetInfoChanged", ({ targetInfo: t }) => Object.assign(targets.get(t.targetId) ?? {}, t));
  on("Target.targetDestroyed", ({ targetId }) => { const t = targets.get(targetId); if (t) t.destroyed = Date.now(); });
  await send("Target.setDiscoverTargets", { discover: true });

  // Execution contexts of out-of-process iframes, by session.
  const contexts = [];
  on("Runtime.executionContextCreated", ({ context }, sessionId) => contexts.push({ ...context, sessionId }));
  on("Runtime.executionContextDestroyed", ({ executionContextId }, sessionId) => {
    const i = contexts.findIndex((c) => c.id === executionContextId && c.sessionId === sessionId);
    if (i >= 0) contexts.splice(i, 1);
  });
  on("Runtime.executionContextsCleared", (_p, sessionId) => {
    for (let i = contexts.length - 1; i >= 0; i--) if (contexts[i].sessionId === sessionId) contexts.splice(i, 1);
  });
  const frameSessions = new Map(); // sessionId -> parent sessionId
  on("Target.attachedToTarget", async ({ sessionId, targetInfo }, parent) => {
    if (targetInfo.type !== "iframe") return;
    frameSessions.set(sessionId, parent);
    await send("Runtime.enable", {}, sessionId).catch(() => {});
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
  });
  on("Target.detachedFromTarget", ({ sessionId }) => frameSessions.delete(sessionId));

  const b = { send, on, targets, profile };

  // --- the extension's service worker ---
  b.swTarget = async (ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
      const { targetInfos } = await send("Target.getTargets");
      for (const t of targetInfos.filter((x) => x.type === "service_worker" && x.url.endsWith("/background.js"))) {
        if (b.extId) { if (new URL(t.url).host === b.extId) return t; continue; }
        // Find ours among any built-in extensions' workers.
        const { sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        const r = await send("Runtime.evaluate", { expression: "chrome.runtime?.getManifest?.().name", returnByValue: true }, sessionId).catch(() => null);
        await send("Target.detachFromTarget", { sessionId }).catch(() => {});
        if (r?.result?.value === "No New Tabs") { b.extId = new URL(t.url).host; return t; }
      }
    }
    return null;
  };
  b.swRunning = async () => !!(await send("Target.getTargets")).targetInfos
    .find((x) => x.type === "service_worker" && new URL(x.url).host === b.extId);
  b.swEval = async (expr) => {
    let t = await b.swTarget(300);
    if (!t) { await b.wakeSW(); t = await b.swTarget(); }
    const { sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    try {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    } finally {
      await send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  };
  // Stop the worker, as Chrome does after 30 s of quiet.
  b.stopSW = async () => {
    const t = await b.swTarget(1000);
    if (!t) return true;
    await send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    for (let i = 0; i < 80; i++) { if (!(await b.swRunning())) return true; await sleep(25); }
    return false;
  };
  b.wakeSW = async () => {
    const { targetId } = await send("Target.createTarget", { url: "about:blank", background: true });
    await sleep(100);
    await send("Target.closeTarget", { targetId }).catch(() => {});
  };
  b.setDomains = (d) => b.swEval(`chrome.storage.sync.set({ domains: ${JSON.stringify(d)} }).then(() => true)`);

  // --- pages ---
  b.attach = async (targetId) => {
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    return makePage(targetId, sessionId);
  };
  b.open = async (url) => {
    const { targetId } = await send("Target.createTarget", { url });
    const page = await b.attach(targetId);
    await page.waitLoad();
    return page;
  };
  b.firstPage = async () => b.attach([...targets.values()].find((t) => t.type === "page" && !t.destroyed).targetId);

  function makePage(targetId, sessionId) {
    const page = { targetId, sessionId };
    page.eval = async (expr, { gesture = false, contextId, session = sessionId } = {}) => {
      const r = await send("Runtime.evaluate",
        { expression: expr, userGesture: gesture, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, session);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    page.url = () => page.eval("location.href").catch(() => "");
    page.waitLoad = async (ms = 8000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
        if ((await page.eval("document.readyState").catch(() => null)) === "complete") return true;
      }
      return false;
    };
    page.goto = async (url) => {
      await send("Page.navigate", { url }, sessionId);
      await sleep(100);
      return page.waitLoad();
    };
    // A real mouse click at a point in the page.
    page.clickAt = async (x, y, { modifiers = [], button = "left" } = {}) => {
      const mods = modifiers.reduce((m, k) => m | MODIFIERS[k], 0);
      const base = { x, y, modifiers: mods, button, clickCount: 1 };
      await send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none" }, sessionId);
      await send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: BUTTONS[button] }, sessionId);
      await send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 }, sessionId);
    };
    // ... on the centre of an element.
    page.click = async (selector, opts) => {
      await page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
      await sleep(100); // let the page settle after scrolling
      const [x, y] = await page.eval(`(() => {
        const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      })()`);
      await page.clickAt(x, y, opts);
    };
    // ... on an element inside an iframe of the page. For a frame the page
    // can't look into (another origin), the element is taken to sit at the
    // frame's top left.
    page.clickIn = async (frameSelector, selector, opts) => {
      await page.eval(`document.querySelector(${JSON.stringify(frameSelector)}).scrollIntoView({ block: "center" })`);
      await sleep(100);
      const [x, y] = await page.eval(`(() => {
        const f = document.querySelector(${JSON.stringify(frameSelector)});
        const fr = f.getBoundingClientRect();
        let el = null;
        try { el = f.contentDocument?.querySelector(${JSON.stringify(selector)}); } catch {}
        if (!el) return [fr.x + 30, fr.y + 12];
        const r = el.getBoundingClientRect();
        return [fr.x + f.clientLeft + r.x + r.width / 2, fr.y + f.clientTop + r.y + r.height / 2];
      })()`);
      await page.clickAt(x, y, opts);
    };
    // Run code in a cross-origin iframe as if from a click: "xframe" is
    // frame.html framed directly, "nested" is frame.html inside nest.html.
    page.frameEval = async (which, expr, gesture = true) => {
      for (const end = Date.now() + 8000; Date.now() < end; await sleep(100)) {
        for (const [s] of frameSessions) {
          const tree = await send("Page.getFrameTree", {}, s).catch(() => null);
          const root = tree?.frameTree;
          if (!root) continue;
          const frame = which === "xframe"
            ? (root.frame.url.endsWith("/frame.html") ? root.frame : null)
            : (root.frame.url.endsWith("/nest.html") ? root.childFrames?.find((c) => c.frame.url.endsWith("/frame.html"))?.frame : null);
          const ctx = frame && contexts.find((c) => c.sessionId === s && c.auxData?.frameId === frame.id && c.auxData?.isDefault);
          if (ctx) return page.eval(expr, { gesture, contextId: ctx.id, session: s });
        }
      }
      throw new Error(`frame ${which} not found`);
    };
    page.close = () => send("Target.closeTarget", { targetId }).catch(() => {});
    return page;
  }

  // Page targets created since a moment.
  b.pagesSince = (since) => [...targets.values()].filter((t) => t.type === "page" && t.created >= since);

  b.close = async () => {
    try { await send("Browser.close"); } catch {}
    ws.close();
    proc.kill("SIGKILL");
    await sleep(200);
    rmSync(profile, { recursive: true, force: true });
  };
  return b;
}
