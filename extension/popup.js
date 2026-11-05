import { hostIsBlocked, loadDomains, normalizeDomain, saveDomains } from "./lib.js";

const $ = (id) => document.getElementById(id);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const url = tab?.url ? new URL(tab.url) : null;
const isWeb = url && (url.protocol === "http:" || url.protocol === "https:");

if (!isWeb) {
  $("host").textContent = "(not a web page)";
} else {
  const host = normalizeDomain(url.hostname);
  $("host").textContent = host;
  await render(host);
}

async function render(host) {
  const domains = await loadDomains();
  const blocked = hostIsBlocked(host, domains);
  // The entry that covers this host, e.g. "example.com" for "app.example.com".
  const entry = domains.find((d) => host === d || host.endsWith(`.${d}`));

  $("status").innerHTML = blocked
    ? `<span class="on">Blocking new tabs and windows</span>${entry !== host ? ` (via ${entry})` : ""}`
    : "New tabs and windows allowed";
  const btn = $("toggle");
  btn.hidden = false;
  btn.textContent = blocked ? `Remove ${entry} from list` : `+ Add current domain (${host})`;
  btn.onclick = async () => {
    await saveDomains(blocked ? domains.filter((d) => d !== entry) : [...domains, host]);
    // Reload so the in-page guard is added or removed for this tab.
    chrome.tabs.reload(tab.id);
    window.close();
  };
}
