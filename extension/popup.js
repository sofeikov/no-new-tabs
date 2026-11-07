import { httpUrl, loadDomains, saveDomains, siteToggle } from "./lib.js";

const $ = (id) => document.getElementById(id);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const url = httpUrl(tab?.url ?? "");
const toggle = url && siteToggle(url.hostname, await loadDomains());

if (!toggle) {
  $("host").textContent = url ? url.hostname : "(not a web page)";
} else {
  $("host").textContent = url.hostname;
  render(toggle);
}

// Text only (textContent): rules are user input.
function render(t) {
  const status = $("status");
  if (t.listed) {
    const on = document.createElement("span");
    on.className = "on";
    on.textContent = "Blocking new tabs and windows";
    status.replaceChildren(on, t.via ? ` (via ${t.rule})` : "");
  } else {
    status.replaceChildren(t.exceptions
      ? `New tabs and windows allowed (exception ${t.exceptions.join(", ")})`
      : "New tabs and windows allowed");
  }
  const btn = $("toggle");
  btn.hidden = false;
  btn.textContent = t.label;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await saveDomains(t.next);
    } catch (e) {
      // Nothing was saved: say so, and leave the tab as it is.
      const err = document.createElement("div");
      err.className = "error";
      err.textContent = `Not saved: ${e?.message ?? e}`;
      status.replaceChildren(err);
      btn.disabled = false;
      return;
    }
    // Reload so the in-page guard is added or removed for this tab.
    chrome.tabs.reload(tab.id);
    window.close();
  };
}
