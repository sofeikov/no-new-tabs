import { loadDomains, normalizeDomain, saveDomains } from "./lib.js";

const list = document.getElementById("list");
const saved = document.getElementById("saved");
const addCurrent = document.getElementById("add-current");

list.value = (await loadDomains()).join("\n");

async function save(lines) {
  const domains = await saveDomains(lines);
  list.value = domains.join("\n");
  saved.textContent = `Saved ${domains.length} domain${domains.length === 1 ? "" : "s"}`;
  setTimeout(() => (saved.textContent = ""), 2500);
  return domains;
}

document.getElementById("save").onclick = () => save(list.value.split(/[\n,]+/));

// "Current domain" = the web page you were on before opening this page:
// the most recently used http(s) tab in this window.
const tabs = await chrome.tabs.query({ currentWindow: true });
const lastWeb = tabs
  .filter((t) => /^https?:/.test(t.url ?? "") && !t.active)
  .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
const current = lastWeb && normalizeDomain(new URL(lastWeb.url).hostname);

if (current) {
  addCurrent.hidden = false;
  addCurrent.textContent = `+ Add current domain (${current})`;
  addCurrent.onclick = async () => {
    const domains = await save([...list.value.split(/[\n,]+/), current]);
    addCurrent.textContent = `${current} added — reload its tab`;
    addCurrent.disabled = domains.includes(current);
  };
}
