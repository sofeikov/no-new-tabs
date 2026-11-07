import { httpUrl, loadDomains, normalizeDomain, normalizeRule, rejectedLines, saveDomains, siteToggle } from "./lib.js";

const list = document.getElementById("list");
const saved = document.getElementById("saved");
const error = document.getElementById("error");
const addCurrent = document.getElementById("add-current");

list.value = (await loadDomains()).join("\n");

const lines = (text) => text.split(/[\n,]+/);

// Text only (textContent): the lines are the user's input.
function showError(message, items = []) {
  error.replaceChildren(message);
  if (items.length) {
    const ul = document.createElement("ul");
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item;
      ul.append(li);
    }
    error.append(ul);
  }
}

// Saves the lines; returns the saved list, or null when nothing was saved
// (the textarea then keeps what the user typed).
async function save(entries) {
  saved.textContent = "";
  let domains;
  try {
    domains = await saveDomains(entries);
  } catch (e) {
    showError(`Not saved. ${e?.message ?? e}`);
    return null;
  }
  const rejected = rejectedLines(entries);
  list.value = domains.join("\n");
  saved.textContent = `Saved ${domains.length} rule${domains.length === 1 ? "" : "s"}`;
  setTimeout(() => (saved.textContent = ""), 2500);
  if (rejected.length) {
    showError(`${rejected.length === 1 ? "This line is" : "These lines are"} not a domain or rule, so ` +
      `${rejected.length === 1 ? "it was" : "they were"} left out:`, rejected);
  } else {
    error.replaceChildren();
  }
  return domains;
}

document.getElementById("save").onclick = () => save(lines(list.value));

// "Current domain" = the web page you were on before opening this page:
// the most recently used http(s) tab in this window.
const tabs = await chrome.tabs.query({ currentWindow: true });
const lastWeb = tabs
  .filter((t) => httpUrl(t.url ?? "") && !t.active)
  .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
const currentHost = lastWeb && httpUrl(lastWeb.url).hostname;

// Offer what blocks the current site, the popup's way (siteToggle): add
// it, or remove the exceptions that keep it unlisted. Nothing when the
// list already blocks it.
function offerCurrent(entries) {
  const t = currentHost ? siteToggle(currentHost, entries.map(normalizeRule).filter(Boolean)) : null;
  addCurrent.hidden = !t || t.listed;
  if (addCurrent.hidden) return;
  addCurrent.disabled = false;
  addCurrent.textContent = t.action === "add" ? `+ Add current domain (${normalizeDomain(currentHost)})` : t.label;
  addCurrent.onclick = async () => {
    // Decide again from the list as it is now: it may have been edited
    // or saved since the page opened.
    const now = siteToggle(currentHost, lines(list.value).map(normalizeRule).filter(Boolean));
    if (!now || now.listed) return offerCurrent(lines(list.value));
    const domains = await save(now.next);
    if (!domains) return; // the error says why; nothing was changed
    addCurrent.textContent = `Done — reload ${currentHost}`;
    addCurrent.disabled = true;
  };
}
offerCurrent(lines(list.value));
