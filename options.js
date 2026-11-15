import { ENGINES, SITES, getSettings } from "./engines.js";

const $ = (id) => document.getElementById(id);
const lines = (t) => t.split("\n").map((l) => l.trim()).filter(Boolean);
const TOGGLES = ["enabled", "cleanDownloads", "clearSiteData", "protectBookmarks", "deepClean", "waitForTabClose"];
const LISTS = { customPatterns: "custom", keywords: "keywords", blockDomains: "block", allowDomains: "allow", keepUrls: "keep" };

/* ---------- toast ---------- */
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1800);
}

/* ---------- read / write settings ---------- */
const checks = (box) => Object.fromEntries([...document.querySelectorAll(`#${box} input`)].map((cb) => [cb.dataset.id, cb.checked]));

function collect() {
  const out = {
    engines: checks("enginesChips"),
    sites: checks("sitesChips"),
    scope: document.querySelector('input[name="scope"]:checked').value,
    olderDays: Math.max(0, Math.min(3650, parseInt($("days").value, 10) || 0)),
    sweepEvery: parseInt($("sweepEvery").value, 10) || 0,
    delayMinutes: parseInt($("delayMinutes").value, 10) || 0,
    confirmOver: Math.max(0, Math.min(100000, parseInt($("confirmOver").value, 10) || 0))
  };
  for (const k of TOGGLES) out[k] = $(k).checked;
  for (const [key, id] of Object.entries(LISTS)) out[key] = lines($(id).value);
  return out;
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.sync.set(collect());
    toast("Saved");
  }, 450);
}

function scopeHint() {
  const { scope, olderDays } = collect();
  $("daysWrap").hidden = scope !== "older";
  $("scopeHint").textContent = {
    all: "Searches are removed the moment you make them, and older ones are cleaned on startup.",
    today: "Only searches made since midnight are cleaned.",
    older: `New searches are kept for ${olderDays} day${olderDays === 1 ? "" : "s"}, then removed by the next sweep (startup, scheduled or Clean now). Live deletion is off in this mode.`
  }[scope];
}

function fillChips(box, items, state, label, on = () => true, tip = () => "") {
  const el = $(box);
  el.innerHTML = "";
  for (const it of items) {
    const wrap = document.createElement("label");
    wrap.className = "chip";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.id = it.id;
    const v = state[it.id];
    cb.checked = v === undefined ? on(it) : v !== false;
    wrap.title = tip(it);
    const span = document.createElement("span");
    span.textContent = label(it);
    wrap.append(cb, span);
    el.append(wrap);
  }
}

function render(s) {
  for (const k of TOGGLES) $(k).checked = !!s[k];
  fillChips("enginesChips", ENGINES, s.engines, (e) => e.name);
  fillChips("sitesChips", SITES, s.sites, (x) => x.name, (x) => !x.off, (x) => x.domains.join(", "));
  for (const [key, id] of Object.entries(LISTS)) $(id).value = s[key].join("\n");
  document.querySelector(`input[name="scope"][value="${s.scope}"]`).checked = true;
  $("days").value = s.olderDays;
  $("sweepEvery").value = String(s.sweepEvery);
  $("delayMinutes").value = String(s.delayMinutes);
  $("confirmOver").value = s.confirmOver;
  $("wBookmarks").checked = !!s.protectBookmarks;
  $("wClear").checked = !!s.clearSiteData;
  scopeHint();
}

/* ---------- preview ---------- */
const hostOf = (url) => { try { return new URL(url).hostname; } catch (e) { return url; } };
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

async function scan() {
  clearTimeout(saveTimer);
  await chrome.storage.sync.set(collect()); // preview uses what's on screen
  $("scanBtn").disabled = true;
  $("previewSummary").textContent = "Scanning your history…";
  $("previewList").textContent = "";
  $("deleteBtn").hidden = true;

  const res = await chrome.runtime.sendMessage({ type: "preview" });
  $("scanBtn").disabled = false;
  if (!res || res.error) {
    $("previewSummary").textContent = "The scan didn't finish. Try again in a moment.";
    return;
  }
  if (!res.count) {
    $("previewSummary").textContent = "Nothing to remove. Your history is already clean.";
    return;
  }

  const note = res.items.length < res.count ? `, showing the ${res.items.length} most recent` : "";
  $("previewSummary").textContent = `${plural(res.count, "entry", "entries")} would be removed${note}.`;
  for (const it of res.items) {
    const row = document.createElement("div");
    row.className = "item";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = it.title || hostOf(it.url);
    const u = document.createElement("div");
    u.className = "u";
    u.textContent = it.url;
    u.title = it.url;
    row.append(t, u);
    $("previewList").append(row);
  }
  $("deleteBtn").textContent = `Delete ${plural(res.count, "entry", "entries")}`;
  $("deleteBtn").hidden = false;
}

$("scanBtn").addEventListener("click", scan);

$("deleteBtn").addEventListener("click", async () => {
  if (!confirm("Permanently remove these entries from your browser history? This can't be undone.")) return;
  $("deleteBtn").disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "cleanNow" });
  $("deleteBtn").disabled = false;
  $("deleteBtn").hidden = true;
  $("previewList").textContent = "";
  $("previewSummary").textContent = res && !res.error
    ? `Done. Removed ${plural(res.deleted, "entry", "entries")}.`
    : "That didn't work. Try again in a moment.";
});

/* ---------- activity log ---------- */
const KIND = { startup: "Startup cleanup", manual: "Clean now", shortcut: "Keyboard shortcut", scheduled: "Scheduled sweep", live: "While browsing", deferred: "After wait or tab close" };

function summarize(e) {
  const parts = [];
  if (e.history) parts.push(plural(e.history, "history entry", "history entries"));
  if (e.downloads) parts.push(plural(e.downloads, "download", "downloads"));
  if (e.siteData) parts.push(`site data for ${plural(e.siteData, "site", "sites")}`);
  if (!parts.length) return "Nothing needed removing.";
  const last = parts.pop();
  return "Removed " + (parts.length ? parts.join(", ") + " and " : "") + last + ".";
}

async function renderLog() {
  const { log = [] } = await chrome.storage.local.get("log");
  const box = $("log");
  box.innerHTML = "";
  $("clearLog").hidden = !log.length;
  if (!log.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "Nothing yet. Once a cleanup runs, it shows up here.";
    box.append(d);
    return;
  }
  for (const e of log) {
    const row = document.createElement("div");
    row.className = "entry";
    const head = document.createElement("div");
    head.className = "head";
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = KIND[e.kind] || "Cleanup";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = new Date(e.t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    head.append(what, when);
    const p = document.createElement("p");
    p.textContent = summarize(e);
    row.append(head, p);
    const hosts = Object.entries(e.domains || {});
    if (hosts.length) {
      const doms = document.createElement("div");
      doms.className = "doms";
      for (const [h, n] of hosts) {
        const s = document.createElement("span");
        s.textContent = h;
        const c = document.createElement("i");
        c.textContent = n;
        s.append(c);
        doms.append(s);
      }
      row.append(doms);
    }
    box.append(row);
  }
}

$("clearLog").addEventListener("click", async () => {
  await chrome.storage.local.remove("log");
  toast("Activity cleared");
});

/* ---------- shortcut ---------- */
async function renderShortcut() {
  try {
    const c = (await chrome.commands.getAll()).find((x) => x.name === "clean-now");
    $("shortcut").textContent = (c && c.shortcut) || "Not set";
  } catch (e) {}
}
$("shortcutBtn").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

/* ---------- export / import ---------- */
function sanitize(o) {
  const out = {};
  for (const k of TOGGLES) if (typeof o[k] === "boolean") out[k] = o[k];
  for (const [box, list] of [["engines", ENGINES], ["sites", SITES]]) {
    if (o[box] && typeof o[box] === "object") {
      out[box] = {};
      for (const x of list) if (typeof o[box][x.id] === "boolean") out[box][x.id] = o[box][x.id];
    }
  }
  for (const k of Object.keys(LISTS)) {
    if (Array.isArray(o[k])) out[k] = o[k].filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 1000);
  }
  if (["all", "today", "older"].includes(o.scope)) out.scope = o.scope;
  if (Number.isFinite(o.olderDays)) out.olderDays = Math.max(0, Math.min(3650, Math.floor(o.olderDays)));
  if ([0, 60, 360, 1440].includes(o.sweepEvery)) out.sweepEvery = o.sweepEvery;
  if ([0, 15, 60, 360, 1440].includes(o.delayMinutes)) out.delayMinutes = o.delayMinutes;
  if (Number.isFinite(o.confirmOver)) out.confirmOver = Math.max(0, Math.min(100000, Math.floor(o.confirmOver)));
  return out;
}

$("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ app: "tidy-trail", version: 3, settings: collect() }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tidy-trail-settings.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const clean = sanitize(data.settings || data);
    if (!Object.keys(clean).length) throw new Error("empty");
    await chrome.storage.sync.set(clean);
    render(await getSettings());
    toast("Settings imported");
  } catch (err) {
    toast("That file isn't a valid settings export");
  }
});

/* ---------- wiring ---------- */
$("selectAll").addEventListener("click", () => {
  document.querySelectorAll("#enginesChips input").forEach((cb) => (cb.checked = true));
  scheduleSave();
});
$("selectNone").addEventListener("click", () => {
  document.querySelectorAll("#enginesChips input").forEach((cb) => (cb.checked = false));
  scheduleSave();
});

const onEdit = () => {
  $("wBookmarks").checked = $("protectBookmarks").checked;
  $("wClear").checked = $("clearSiteData").checked;
  scopeHint();
  scheduleSave();
};
[...TOGGLES, "sweepEvery", "delayMinutes", "confirmOver", "days", ...Object.values(LISTS)].forEach((id) => {
  $(id).addEventListener("input", onEdit);
  $(id).addEventListener("change", onEdit);
});
document.querySelectorAll('input[name="scope"]').forEach((r) => r.addEventListener("change", onEdit));
$("wBookmarks").addEventListener("change", (e) => { $("protectBookmarks").checked = e.target.checked; onEdit(); });
$("wClear").addEventListener("change", (e) => { $("clearSiteData").checked = e.target.checked; onEdit(); });
$("gotIt").addEventListener("click", async () => {
  await chrome.storage.local.remove("firstRun");
  $("welcome").hidden = true;
});
$("enginesChips").addEventListener("change", scheduleSave);
$("sitesChips").addEventListener("change", scheduleSave);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.enabled) $("enabled").checked = changes.enabled.newValue;
  if (area === "local" && changes.log) renderLog();
});

/* ---------- side navigation highlights the section in view ---------- */
const links = [...document.querySelectorAll("#nav a")];
const spy = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (en.isIntersecting) links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + en.target.id));
  }
}, { rootMargin: "-20% 0px -70% 0px" });
document.querySelectorAll("section.block").forEach((sec) => spy.observe(sec));

chrome.storage.local.get("firstRun").then(({ firstRun }) => { $("welcome").hidden = !firstRun; });

getSettings().then((s) => {
  render(s);
  renderLog();
  renderShortcut();
  if (location.hash === "#preview") {
    $("preview").scrollIntoView();
    scan();
  } else if (location.hash) {
    const t = document.querySelector(location.hash);
    if (t) t.scrollIntoView();
  }
});
