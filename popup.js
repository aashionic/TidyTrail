import { getSettings, isHidden, hideSite, unhideSite, normalizeHost } from "./engines.js";

const $ = (id) => document.getElementById(id);
const PAUSE_MIN = 30;
let shown = 0;
let site = null; // hostname of the active tab, or null when it isn't a web page

/* ---------- small helpers ---------- */
function animateTo(target) {
  const from = shown, start = performance.now(), dur = 450;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    shown = Math.round(from + (target - from) * (1 - Math.pow(1 - t, 3)));
    $("count").textContent = shown.toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function ago(ts) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Date(ts).toLocaleDateString();
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

function scopeText(s) {
  if (s.scope === "today") return "Covers today only.";
  if (s.scope === "older") return `Covers history older than ${s.olderDays} day${s.olderDays === 1 ? "" : "s"}.`;
  return "Covers all history.";
}

const say = (msg) => { $("feedback").textContent = msg; };
const spinner = (msg) => { $("feedback").innerHTML = `<span class="spin"></span>${msg}`; };
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const isPaused = (s) => s.enabled && s.pausedUntil > Date.now();

/* ---------- status ---------- */
function renderEnabled(s) {
  const paused = isPaused(s);
  $("enabled").checked = s.enabled;
  $("hello").classList.toggle("paused", !s.enabled || paused);
  $("state").textContent = !s.enabled
    ? "Protection is off. Nothing is removed until you turn it back on."
    : paused
      ? `Paused until ${clock(s.pausedUntil)}. Nothing is removed until then.`
      : "Protection is on. New searches and hidden sites are removed as you browse.";
  $("pause").textContent = paused ? "Resume now" : `Pause for ${PAUSE_MIN} minutes`;
  $("pause").disabled = !s.enabled;
}

async function refreshStats(s) {
  const { count = 0, lastClean } = await chrome.storage.local.get(["count", "lastClean"]);
  animateTo(count);
  $("countLabel").textContent = count === 1 ? "entry removed so far." : "entries removed so far.";
  $("lastline").textContent = `Last cleaned ${ago(lastClean)}. ${scopeText(s || (await getSettings()))}`;
}

/* ---------- the site you're on ---------- */
async function activeSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return null;
    const u = new URL(tab.url);
    return u.protocol === "http:" || u.protocol === "https:" ? normalizeHost(u.hostname) : null;
  } catch (e) {
    return null;
  }
}

function renderSite(s) {
  const btn = $("siteBtn");
  if (!site) {
    $("tile").textContent = "?";
    $("host").textContent = "No website open";
    $("siteState").textContent = "Open a site to hide it from history.";
    btn.disabled = true;
    btn.textContent = "Hide";
    btn.className = "btn small primary";
    return;
  }
  const hidden = isHidden(s, site);
  $("tile").textContent = site[0];
  $("host").textContent = site;
  $("siteState").textContent = hidden ? "Hidden from history" : "Visible in history";
  $("siteState").classList.toggle("on", hidden);
  btn.disabled = false;
  btn.textContent = hidden ? "Stop hiding" : "Hide this site";
  btn.className = hidden ? "btn small" : "btn small primary";
}

$("siteBtn").addEventListener("click", async () => {
  if (!site) return;
  const btn = $("siteBtn");
  btn.disabled = true;
  const s = await getSettings();
  if (isHidden(s, site)) {
    await chrome.storage.sync.set(unhideSite(s, site));
    say(`${site} will show up in your history again.`);
  } else {
    await chrome.storage.sync.set(hideSite(s, site));
    if (!s.enabled || isPaused(s)) {
      say(`Saved. Protection is ${s.enabled ? "paused" : "off"}, so ${site} stays visible until it's back on.`);
    } else {
      spinner("Removing what is already there…");
      // force: false keeps recent pages when a wait or tab-close setting is on
      const r = await chrome.runtime.sendMessage({ type: "cleanNow", force: false }).catch(() => null);
      say(r && !r.error
        ? `${site} is hidden. Removed ${plural(r.deleted, "entry", "entries")} from your history.`
        : `${site} is hidden from now on.`);
    }
  }
  renderSite(await getSettings());
});

/* ---------- init ---------- */
(async () => {
  $("greet").textContent = greeting();
  const s = await getSettings();
  renderEnabled(s);
  refreshStats(s);
  site = await activeSite();
  renderSite(s);
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === "clean-now");
    $("shortcut").textContent = (c && c.shortcut) || "Not set";
  } catch (e) {}
})();

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ enabled: e.target.checked });
  renderEnabled(await getSettings());
});

/* ---------- quick pause ---------- */
$("pause").addEventListener("click", async () => {
  const s = await getSettings();
  if (isPaused(s)) {
    await chrome.storage.local.remove("pausedUntil");
    say("Protection is back on.");
  } else {
    await chrome.storage.local.set({ pausedUntil: Date.now() + PAUSE_MIN * 60000 });
    say(`Paused for ${PAUSE_MIN} minutes. Pages you visit stay until the next cleanup.`);
  }
  renderEnabled(await getSettings());
});
setInterval(async () => renderEnabled(await getSettings()), 30000); // flips back by itself when the pause ends

/* ---------- clean now (asks first when it would remove a lot) ---------- */
function askConfirm(count) {
  return new Promise((resolve) => {
    const box = $("feedback");
    box.textContent = "";
    const msg = document.createElement("div");
    msg.textContent = `This will remove ${plural(count, "entry", "entries")}, more than usual. Continue?`;
    const row = document.createElement("div");
    row.className = "confirm";
    const no = document.createElement("button");
    no.className = "btn small";
    no.textContent = "Cancel";
    const yes = document.createElement("button");
    yes.className = "btn small danger";
    yes.textContent = "Remove them";
    no.addEventListener("click", () => resolve(false));
    yes.addEventListener("click", () => resolve(true));
    row.append(no, yes);
    box.append(msg, row);
  });
}

$("clean").addEventListener("click", async () => {
  const btn = $("clean");
  btn.disabled = true;
  spinner("Cleaning your history…");
  try {
    let r = await chrome.runtime.sendMessage({ type: "cleanNow", checkLimit: true });
    if (r && r.needsConfirm) {
      if (!(await askConfirm(r.count))) {
        say("Cancelled. Nothing was removed.");
        btn.disabled = false;
        return;
      }
      spinner("Cleaning your history…");
      r = await chrome.runtime.sendMessage({ type: "cleanNow" });
    }
    if (!r || r.error) throw new Error("failed");
    const parts = [plural(r.deleted, "history entry", "history entries")];
    if (r.downloads) parts.push(plural(r.downloads, "download", "downloads"));
    say(r.deleted || r.downloads || r.siteData
      ? `Done. Removed ${parts.join(" and ")}${r.siteData ? ` and cleared site data for ${plural(r.siteData, "site", "sites")}` : ""}.`
      : "All clean. There was nothing to remove.");
  } catch (e) {
    say("That didn't work. Try again in a moment.");
  }
  btn.disabled = false;
});

$("preview").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html#preview") }));
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("activity").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html#activity") }));

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local" && (changes.count || changes.lastClean)) refreshStats();
  if (area === "sync" || (area === "local" && changes.pausedUntil)) {
    const s = await getSettings();
    renderEnabled(s);
    renderSite(s);
  }
});
