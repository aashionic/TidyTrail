import {
  getSettings, compileSettings, matchesItem, blockedHost, blockedName, siteOrigins, hostOf,
  isActive, isDeferring, isSiteOnly, isDue, isHidden, hideSite, unhideSite, normalizeHost
} from "./engines.js";

const PAGE_SIZE = 5000;
const PREVIEW_CAP = 300;
const DAY_MS = 864e5;
const LOG_MAX = 25;
const RETRY_ALARM = "retry-delete";
const SWEEP_ALARM = "periodic-sweep";
const DEFER_ALARM = "deferred-sweep"; // checks whether held-back pages are due
const PAUSE_ALARM = "pause-end";
const DEFER_EVERY = 5; // minutes
const MENU_HIDE = "hide-site";
const MENU_SHOW = "unhide-site";

/* ---------- counter (persisted, serialized to avoid lost updates) ---------- */
let counterChain = Promise.resolve();
function addCount(n) {
  if (!n) return counterChain;
  counterChain = counterChain
    .then(async () => {
      const { count = 0 } = await chrome.storage.local.get("count");
      await chrome.storage.local.set({ count: count + n });
    })
    .catch(() => {});
  return counterChain;
}
const markCleaned = () => chrome.storage.local.set({ lastClean: Date.now() });

/* ---------- activity log: counts and host names only, never full URLs or titles ---------- */
const tally = (map, host) => { if (host) map[host] = (map[host] || 0) + 1; };
const topHosts = (map, n = 12) =>
  Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n));

let logChain = Promise.resolve();
function logEvent(kind, d) {
  const history = d.history || 0, downloads = d.downloads || 0, siteData = d.siteData || 0;
  const quiet = kind === "live" || kind === "deferred"; // frequent, merged into one entry per hour
  if (quiet && !history && !downloads) return logChain; // skip empties
  logChain = logChain
    .then(async () => {
      const { log = [] } = await chrome.storage.local.get("log");
      const last = log[0];
      if (quiet && last && last.kind === kind && Date.now() - last.t < 36e5) {
        last.t = Date.now();
        last.history += history;
        last.downloads += downloads;
        last.siteData = (last.siteData || 0) + siteData;
        for (const [h, n] of Object.entries(d.domains || {})) last.domains[h] = (last.domains[h] || 0) + n;
        last.domains = topHosts(last.domains);
      } else {
        log.unshift({ t: Date.now(), kind, history, downloads, siteData, domains: topHosts(d.domains || {}) });
      }
      log.length = Math.min(log.length, LOG_MAX);
      await chrome.storage.local.set({ log });
    })
    .catch(() => {});
  return logChain;
}

/* ---------- badge ---------- */
function updateBadge(s) {
  const paused = s.enabled && s.pausedUntil > Date.now();
  chrome.action.setBadgeText({ text: !s.enabled ? "OFF" : paused ? "II" : "ON" });
  chrome.action.setBadgeBackgroundColor({ color: !s.enabled ? "#757575" : paused ? "#b26a00" : "#1e64c8" });
}
function flashBadge(text) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
  setTimeout(async () => updateBadge(await getSettings()), 3000);
}

/* ---------- alarms (may not survive a browser restart, so re-sync on startup) ---------- */
async function syncSchedule(s) {
  const minutes = Number(s.sweepEvery) || 0;
  const existing = await chrome.alarms.get(SWEEP_ALARM);
  if (!minutes) {
    if (existing) await chrome.alarms.clear(SWEEP_ALARM);
  } else if (!existing || existing.periodInMinutes !== minutes) {
    chrome.alarms.create(SWEEP_ALARM, { delayInMinutes: minutes, periodInMinutes: minutes });
  }

  // Held-back pages need a periodic look so they go once their wait is over.
  const wantDefer = s.enabled && isDeferring(s);
  const defer = await chrome.alarms.get(DEFER_ALARM);
  if (wantDefer && !defer) chrome.alarms.create(DEFER_ALARM, { delayInMinutes: DEFER_EVERY, periodInMinutes: DEFER_EVERY });
  else if (!wantDefer && defer) await chrome.alarms.clear(DEFER_ALARM);
}

async function syncPause(s) {
  const alarm = await chrome.alarms.get(PAUSE_ALARM);
  if (s.pausedUntil > Date.now()) {
    if (!alarm || alarm.scheduledTime !== s.pausedUntil) chrome.alarms.create(PAUSE_ALARM, { when: s.pausedUntil });
  } else if (alarm) {
    await chrome.alarms.clear(PAUSE_ALARM);
  }
}

function syncAll(s) {
  updateBadge(s);
  syncSchedule(s);
  syncPause(s);
}

/* ---------- durable retry (storage.session survives worker restarts, never hits disk) ---------- */
let retryChain = Promise.resolve();
function queueRetry(url) {
  retryChain = retryChain
    .then(async () => {
      const { pending = [] } = await chrome.storage.session.get("pending");
      if (pending.length < 500 && !pending.includes(url)) pending.push(url);
      await chrome.storage.session.set({ pending });
      if (!(await chrome.alarms.get(RETRY_ALARM))) {
        chrome.alarms.create(RETRY_ALARM, { delayInMinutes: 0.5 }); // 30s is Chrome's minimum
      }
    })
    .catch(() => {});
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RETRY_ALARM) {
    const { pending = [] } = await chrome.storage.session.get("pending");
    await chrome.storage.session.set({ pending: [] });
    await Promise.all(pending.map((url) => chrome.history.deleteUrl({ url }).catch(() => {})));
  } else if (alarm.name === SWEEP_ALARM) {
    autoSweep("scheduled");
  } else if (alarm.name === DEFER_ALARM) {
    sweepDeferred().catch(() => {});
  } else if (alarm.name === PAUSE_ALARM) {
    syncAll(await getSettings());
  }
});

/* ---------- deletion ---------- */
async function removeUrl(url, { retry = false } = {}) {
  try {
    await chrome.history.deleteUrl({ url });
    if (retry) {
      setTimeout(() => chrome.history.deleteUrl({ url }).catch(() => {}), 1500);
      queueRetry(url);
    }
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- deep clean (experimental) ----------
   history.deleteUrl removes the entry, but some browsers keep a cached copy of recent
   search suggestions that is only cleared by the browser's own "clear history" path.
   browsingData.removeHistory goes through that path. It can only take a start time, so
   this removes ALL history from just before the search visit onward. It runs right
   after the visit, so in practice that is only the search page itself. */
async function deepClean(visitTime) {
  try {
    if (!chrome.browsingData || !chrome.browsingData.removeHistory) return;
    await chrome.browsingData.removeHistory({ since: Math.max(0, (visitTime || Date.now()) - 1000) });
  } catch (e) {}
}

/* ---------- bookmarks ---------- */
async function bookmarkSet(s) {
  const set = new Set();
  if (!s.protectBookmarks || !chrome.bookmarks) return set;
  try {
    const walk = (n) => {
      if (n.url) { set.add(n.url); set.add(n.url.replace(/\/$/, "")); }
      (n.children || []).forEach(walk);
    };
    (await chrome.bookmarks.getTree()).forEach(walk);
  } catch (e) {}
  return set;
}
async function isBookmarked(url) {
  try { return (await chrome.bookmarks.search({ url })).length > 0; } catch (e) { return false; }
}

/* ---------- holding hidden sites back (wait / tab close) ----------
   A "gate" says which hidden-site pages may go now. Searches and keyword matches are never
   held. Manual cleanups (Clean now, shortcut, Preview) pass no gate and remove everything. */
async function makeGate(s, c) {
  if (!isDeferring(s)) return null;
  const open = new Set(); // hidden sites that currently have a tab open
  try {
    for (const t of await chrome.tabs.query({})) {
      const name = t.url && blockedName(t.url, c);
      if (name) open.add(name);
    }
  } catch (e) {}
  return {
    delayMs: Math.max(0, Number(s.delayMinutes) || 0) * 6e4,
    waitForTabClose: !!s.waitForTabClose,
    open
  };
}

/* ---------- time range ---------- */
function rangeFor(s) {
  const now = Date.now();
  if (s.scope === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { startTime: d.getTime(), endTime: now + 60000 };
  }
  if (s.scope === "older") {
    return { startTime: 0, endTime: now - Math.max(0, s.olderDays) * DAY_MS };
  }
  return { startTime: 0, endTime: now + 60000 };
}

/* ---------- scan: pages through history; deletes matches, or just lists them for a preview ---------- */
async function scan(s, { dryRun = false, c, gate = null, text = "", seen = new Set() } = {}) {
  c = c || compileSettings(s, await bookmarkSet(s)); // compiled once for the whole scan
  const { startTime, endTime } = rangeFor(s);
  const items = [];
  const domains = {};
  const hosts = new Set(); // hidden-site hosts seen, used for site-data wiping
  let end = endTime;
  let count = 0;

  while (true) {
    const page = await chrome.history.search({ text, maxResults: PAGE_SIZE, startTime, endTime: end });
    const fresh = page.filter((i) => !seen.has(i.id));
    if (!fresh.length) break;
    fresh.forEach((i) => seen.add(i.id));

    const hits = fresh.filter((i) => matchesItem(i, c) && isDue(i, c, gate));
    for (const h of hits) {
      const bh = blockedHost(h.url, c);
      if (bh) hosts.add(bh);
    }
    if (dryRun) {
      count += hits.length;
      for (const h of hits) {
        if (items.length < PREVIEW_CAP) items.push({ url: h.url, title: h.title || "", time: h.lastVisitTime });
      }
    } else {
      const results = await Promise.all(hits.map(async (h) => [h, await removeUrl(h.url)]));
      for (const [h, ok] of results) if (ok) { count++; tally(domains, hostOf(h.url)); }
    }

    if (page.length < PAGE_SIZE) break;
    end = Math.min(...page.map((i) => i.lastVisitTime));
  }
  items.sort((a, b) => b.time - a.time);
  return { count, items, domains, hosts };
}

/* ---------- downloads list (files stay on disk; only the entry goes) ---------- */
const downloadIsHidden = (d, c) => [d.finalUrl, d.url, d.referrer].some((u) => u && blockedHost(u, c));

function downloadIsDue(d, c, gate) {
  if (!gate) return true;
  const name = [d.finalUrl, d.url, d.referrer].map((u) => u && blockedName(u, c)).find(Boolean);
  if (gate.delayMs && Date.now() - Date.parse(d.endTime || d.startTime || "") < gate.delayMs) return false;
  if (gate.waitForTabClose && name && gate.open.has(name)) return false;
  return true;
}

async function eraseDownloads(s, c, gate = null) {
  if (!s.cleanDownloads || !chrome.downloads) return 0;
  let n = 0;
  try {
    for (const d of await chrome.downloads.search({})) {
      if (d.state === "in_progress" || !downloadIsHidden(d, c) || !downloadIsDue(d, c, gate)) continue;
      try { await chrome.downloads.erase({ id: d.id }); n++; } catch (e) {}
    }
  } catch (e) {}
  return n;
}

if (chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta.state || delta.state.current !== "complete") return;
    const s = await getSettings();
    if (!isActive(s) || !s.cleanDownloads || isDeferring(s)) return; // held ones go with the next deferred sweep
    const [d] = await chrome.downloads.search({ id: delta.id });
    if (d && downloadIsHidden(d, compileSettings(s, await bookmarkSet(s)))) {
      try {
        await chrome.downloads.erase({ id: d.id });
        logEvent("live", { downloads: 1, domains: { [hostOf(d.referrer || d.finalUrl || d.url)]: 1 } });
      } catch (e) {}
    }
  });
}

/* ---------- site data: cookies, storage and cache of hidden sites (signs you out) ---------- */
async function wipeSiteData(s, c, hosts, gate = null) {
  if (!s.clearSiteData || !chrome.browsingData || !chrome.browsingData.remove) return 0;
  let cc = c;
  let extra = [...hosts];
  if (gate) {
    // Never sign the person out of a site they have open right now.
    cc = { ...c, blockNames: c.blockNames.filter((n) => !gate.open.has(n)) };
    extra = extra.filter((h) => !gate.open.has(blockedName("https://" + h, c)));
  }
  const origins = siteOrigins(cc, extra);
  if (!origins.length) return 0;
  try {
    await chrome.browsingData.remove(
      { origins },
      { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true }
    );
    return cc.blockNames.length;
  } catch (e) {
    return 0;
  }
}

/* ---------- one full cleanup, used by startup, schedule, popup and the shortcut ----------
   force: true ignores the wait / tab-close settings (Clean now, shortcut). */
async function runSweep(kind, { force = false } = {}) {
  const s = await getSettings();
  const c = compileSettings(s, await bookmarkSet(s));
  const gate = force ? null : await makeGate(s, c);
  const r = await scan(s, { c, gate });
  const downloads = await eraseDownloads(s, c, gate);
  const siteData = await wipeSiteData(s, c, r.hosts, gate);
  await addCount(r.count);
  await markCleaned();
  await logEvent(kind, { history: r.count, downloads, siteData, domains: r.domains });
  return { deleted: r.count, downloads, siteData };
}

async function autoSweep(kind = "startup") {
  const s = await getSettings();
  syncAll(s);
  if (!isActive(s)) return;
  await runSweep(kind);
}

/* ---------- targeted sweep of held-back pages: runs on a timer and when tabs close or navigate ----------
   Searches history once per hidden site (the history text query matches words in the URL) instead of
   walking the whole history. The full sweeps at startup and on schedule remain the safety net. */
let deferBusy = false;
let deferAgain = false;
let deferTimer;

function queueDeferred(ms = 2000) {
  clearTimeout(deferTimer);
  deferTimer = setTimeout(() => sweepDeferred().catch(() => {}), ms);
}

async function sweepDeferred() {
  if (deferBusy) { deferAgain = true; return; }
  deferBusy = true;
  try {
    do {
      deferAgain = false;
      const s = await getSettings();
      if (!isActive(s) || !isDeferring(s)) return;
      const c = compileSettings(s, await bookmarkSet(s));
      if (!c.blockNames.length) return;
      const gate = await makeGate(s, c);
      const seen = new Set();
      const domains = {};
      const hosts = new Set();
      let count = 0;
      for (const name of c.blockNames) {
        const r = await scan(s, { c, gate, text: name, seen });
        count += r.count;
        r.hosts.forEach((h) => hosts.add(h));
        for (const [h, n] of Object.entries(r.domains)) domains[h] = (domains[h] || 0) + n;
      }
      const downloads = await eraseDownloads(s, c, gate);
      const siteData = count || downloads ? await wipeSiteData(s, c, hosts, gate) : 0;
      if (count || downloads) {
        await addCount(count);
        await markCleaned();
        await logEvent("deferred", { history: count, downloads, siteData, domains });
      }
    } while (deferAgain);
  } finally {
    deferBusy = false;
  }
}

// How many entries a manual cleanup would remove, if that is above the person's limit (else 0).
async function overLimit(s, force) {
  const limit = Number(s.confirmOver) || 0;
  if (!limit) return 0;
  const c = compileSettings(s, await bookmarkSet(s));
  const gate = force ? null : await makeGate(s, c);
  const { count } = await scan(s, { dryRun: true, c, gate });
  return count > limit ? count : 0;
}

/* ---------- right-click menu ---------- */
const webHost = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? normalizeHost(u.hostname) : null;
  } catch (e) { return null; }
};

async function updateMenus() {
  try {
    const s = await getSettings();
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const host = tab && tab.url ? webHost(tab.url) : null;
    const hidden = host ? isHidden(s, host) : false;
    await chrome.contextMenus.update(MENU_HIDE, { visible: !!host && !hidden });
    await chrome.contextMenus.update(MENU_SHOW, { visible: !!host && hidden });
  } catch (e) {}
}

function ensureMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_HIDE, title: "Hide this site", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: MENU_SHOW, title: "Stop hiding this site", contexts: ["page", "action"], visible: false });
    updateMenus();
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const host = webHost((tab && tab.url) || info.pageUrl || "");
  if (!host) return;
  const s = await getSettings();
  if (info.menuItemId === MENU_HIDE) {
    if (!isHidden(s, host)) await chrome.storage.sync.set(hideSite(s, host));
    let n = 0;
    if (isActive(await getSettings())) {
      try { n = (await runSweep("manual")).deleted; } catch (e) {} // respects the wait / tab-close settings
    }
    flashBadge(n ? String(n) : "✓");
  } else if (info.menuItemId === MENU_SHOW) {
    if (isHidden(s, host)) await chrome.storage.sync.set(unhideSite(s, host));
    flashBadge("✓");
  }
  updateMenus();
});

chrome.tabs.onActivated.addListener(updateMenus);
chrome.windows.onFocusChanged.addListener(updateMenus);
chrome.tabs.onUpdated.addListener(async (_id, change, tab) => {
  if (tab.active && (change.url || change.status === "complete")) updateMenus();
  if (change.url) {
    const s = await getSettings();
    if (isActive(s) && s.waitForTabClose) queueDeferred(3000); // the tab may have just left a hidden site
  }
});
chrome.tabs.onRemoved.addListener(async () => {
  const s = await getSettings();
  if (isActive(s) && s.waitForTabClose) queueDeferred();
});

/* ---------- events ---------- */
chrome.runtime.onInstalled.addListener(async (details) => {
  ensureMenus();
  if (details.reason === "install") {
    // Fresh install: don't touch existing history until the person has seen the welcome card.
    await chrome.storage.local.set({ firstRun: true });
    syncAll(await getSettings());
    chrome.runtime.openOptionsPage();
  } else {
    autoSweep("startup");
  }
});
chrome.runtime.onStartup.addListener(() => {
  ensureMenus();
  autoSweep("startup");
});

chrome.history.onVisited.addListener(async (item) => {
  const s = await getSettings();
  if (!isActive(s)) return;
  // In "older than X days" mode, fresh visits are kept until they age out.
  if (s.scope === "older") return;
  const c = compileSettings(s);
  if (!matchesItem(item, c)) return;
  // Hidden-site pages being held back stay until the deferred sweep removes them.
  if (isDeferring(s) && isSiteOnly(item, c)) return;
  if (s.protectBookmarks && (await isBookmarked(item.url))) return;
  if (await removeUrl(item.url, { retry: true })) {
    addCount(1);
    logEvent("live", { history: 1, domains: { [hostOf(item.url)]: 1 } });
    if (s.deepClean) deepClean(item.lastVisitTime);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "clean-now") return;
  try {
    const s = await getSettings();
    if (await overLimit(s, true)) {
      // Too many to delete without a look: open Preview, where deleting needs a confirmation.
      flashBadge("?");
      chrome.tabs.create({ url: chrome.runtime.getURL("options.html#preview") });
      return;
    }
    const r = await runSweep("shortcut", { force: true });
    flashBadge(r.deleted ? String(r.deleted) : "✓");
  } catch (e) {
    flashBadge("!");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" || (area === "local" && changes.pausedUntil)) {
    getSettings().then((s) => {
      syncAll(s);
      updateMenus();
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "cleanNow") {
    (async () => {
      const s = await getSettings();
      const force = msg.force !== false; // the popup's "Hide this site" asks for a gentle sweep
      if (msg.checkLimit) {
        const count = await overLimit(s, force);
        if (count) return { needsConfirm: true, count, limit: Number(s.confirmOver) };
      }
      return runSweep("manual", { force });
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ deleted: 0, error: true }));
    return true;
  }
  if (msg.type === "preview") {
    (async () => {
      const s = await getSettings();
      const { count, items } = await scan(s, { dryRun: true });
      sendResponse({ count, items });
    })().catch(() => sendResponse({ count: 0, items: [], error: true }));
    return true;
  }
});

getSettings().then(syncAll);
