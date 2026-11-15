// Shared by the background worker, popup and options page.

// Matches a host equal to `d` or any subdomain of it (never "notd.com").
const dom = (d) => new RegExp("(^|\\.)" + d.replace(/\./g, "\\.") + "$");
// Matches google.com, google.co.uk, google.com.au, www.google.de, ...
const tldFamily = (name) =>
  new RegExp("^(.+\\.)?" + name + "\\.(com?\\.)?[a-z]{2,3}$");

// paths: null = any path. params: at least one must be present and non-empty
// (checked in both the query string and the #hash, which Google sometimes uses).
export const ENGINES = [
  { id: "google", name: "Google", host: tldFamily("google"), paths: ["/search", "/webhp", "/imghp"], params: ["q"] },
  { id: "bing", name: "Bing", host: dom("bing.com"), paths: ["/search", "/images/search", "/videos/search", "/news/search"], params: ["q"] },
  { id: "baidu", name: "Baidu", host: dom("baidu.com"), paths: ["/s"], params: ["wd", "word"] },
  { id: "youtube", name: "YouTube", host: dom("youtube.com"), paths: ["/results"], params: ["search_query"] },
  { id: "duckduckgo", name: "DuckDuckGo", host: dom("duckduckgo.com"), paths: ["/"], params: ["q"] },
  { id: "yahoo", name: "Yahoo", host: dom("search.yahoo.com"), paths: ["/search"], params: ["p"] },
  { id: "brave", name: "Brave Search", host: dom("search.brave.com"), paths: ["/search"], params: ["q"] },
  { id: "ecosia", name: "Ecosia", host: dom("ecosia.org"), paths: ["/search"], params: ["q"] },
  { id: "startpage", name: "Startpage", host: dom("startpage.com"), paths: ["/sp/search", "/do/search"], params: ["query", "q"] },
  { id: "yandex", name: "Yandex", host: tldFamily("yandex"), paths: ["/search"], params: ["text"] },
  { id: "naver", name: "Naver", host: dom("search.naver.com"), paths: ["/search.naver"], params: ["query"] },
  { id: "kagi", name: "Kagi", host: dom("kagi.com"), paths: ["/search"], params: ["q"] },
  { id: "amazon", name: "Amazon (site search)", host: tldFamily("amazon"), paths: ["/s"], params: ["k"] },
  { id: "reddit", name: "Reddit (site search)", host: dom("reddit.com"), paths: ["/search"], params: ["q"] },
  { id: "github", name: "GitHub (site search)", host: dom("github.com"), paths: ["/search"], params: ["q"] }
];

// Sites whose every page is removed from history (one-click presets).
// off: true  -> starts switched off (so updating never hides a site the person didn't pick).
// group: true -> a bundle of unrelated sites; the popup/right-click hides one site at a time
//               instead of switching the whole bundle on.
export const SITES = [
  { id: "facebook", name: "Facebook", domains: ["facebook.com"] },
  { id: "instagram", name: "Instagram", domains: ["instagram.com"] },
  { id: "tiktok", name: "TikTok", domains: ["tiktok.com"] },
  { id: "twitter", name: "X / Twitter", domains: ["x.com", "twitter.com"], off: true },
  { id: "reddit", name: "Reddit", domains: ["reddit.com", "redd.it"], off: true },
  { id: "linkedin", name: "LinkedIn", domains: ["linkedin.com"], off: true },
  { id: "snapchat", name: "Snapchat", domains: ["snapchat.com"], off: true },
  { id: "youtube", name: "YouTube", domains: ["youtube.com", "youtu.be"], off: true },
  {
    id: "shopping", name: "Shopping sites", off: true, group: true,
    domains: ["amazon.com", "amazon.co.uk", "amazon.de", "amazon.in", "ebay.com", "aliexpress.com", "walmart.com", "etsy.com", "temu.com", "shein.com", "flipkart.com", "daraz.com.np"]
  }
];

export const siteOn = (s, x) => {
  const v = s.sites[x.id];
  return v === undefined ? !x.off : !!v;
};

export const DEFAULTS = {
  enabled: true,
  engines: {}, // id -> boolean; missing means enabled
  sites: {}, // preset site id -> boolean; missing means the preset's own default
  customPatterns: [], // "host[/path][?param]"
  allowDomains: [], // never delete
  blockDomains: [], // custom sites: always delete (any page on these domains)
  keepUrls: [], // never delete these pages: "host[/path]"
  protectBookmarks: false, // never delete pages that are bookmarked
  cleanDownloads: true, // drop downloads from hidden sites out of the downloads list
  clearSiteData: false, // also wipe cookies/storage/cache of hidden sites (signs you out)
  scope: "all", // "all" | "today" | "older"
  olderDays: 7,
  keywords: [], // delete any entry whose URL or title contains one of these
  sweepEvery: 0, // minutes between automatic re-sweeps; 0 = off
  deepClean: false, // also run the browser's own history-clear path after each live deletion
  delayMinutes: 0, // hidden sites: keep pages this long before removing; 0 = remove right away
  waitForTabClose: false, // hidden sites: keep pages while any tab of that site is open
  confirmOver: 200, // Clean now asks first above this many entries; 0 = never ask
  pausedUntil: 0 // timestamp; kept in storage.local (per browser), merged in by getSettings
};

export async function getSettings() {
  const [stored, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get("pausedUntil")
  ]);
  return {
    ...DEFAULTS,
    ...stored,
    pausedUntil: Number(local.pausedUntil) || 0,
    engines: { ...(stored.engines || {}) },
    sites: { ...(stored.sites || {}) }
  };
}

// Protection runs when it is switched on and not paused.
export const isActive = (s) => !!s.enabled && !(s.pausedUntil > Date.now());
// True when hidden sites are held back (a wait, tab-close mode, or both).
export const isDeferring = (s) => Number(s.delayMinutes) > 0 || !!s.waitForTabClose;

export function cleanDomain(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
}

function pathMatches(pathname, prefix) {
  if (prefix === "/") return true;
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
}

function hasParam(params, keys) {
  return keys.some((k) => (params.get(k) || "") !== "");
}

function parseCustom(line) {
  const raw = line.trim().toLowerCase().replace(/^[a-z]+:\/\//, "");
  if (!raw) return null;
  const [left, param] = raw.split("?");
  const slash = left.indexOf("/");
  const host = (slash === -1 ? left : left.slice(0, slash)).replace(/^www\./, "");
  const path = slash === -1 ? null : left.slice(slash);
  if (!host) return null;
  return { host: dom(host), paths: path ? [path] : null, params: param ? [param.split("=")[0]] : [] };
}

// "facebook.com/groups/my-group" -> keep that page and everything under it.
function parseKeep(line) {
  const raw = line.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[?#]/)[0];
  if (!raw) return null;
  const slash = raw.indexOf("/");
  const host = slash === -1 ? raw : raw.slice(0, slash);
  const path = slash === -1 ? "" : raw.slice(slash).replace(/\/+$/, "");
  if (!host) return null;
  return { host: dom(host), path: path || null };
}

function matchesRule(rule, hostname, pathname, params) {
  if (!rule.host.test(hostname)) return false;
  if (rule.paths && !rule.paths.some((p) => pathMatches(pathname, p))) return false;
  if (rule.params.length && !hasParam(params, rule.params)) return false;
  return true;
}

// Build regexes/rules once per sweep instead of once per URL.
// `bookmarks` is an optional Set of bookmarked URLs to protect.
export function compileSettings(s, bookmarks = new Set()) {
  const blockNames = [
    ...new Set([
      ...SITES.filter((x) => siteOn(s, x)).flatMap((x) => x.domains),
      ...s.blockDomains.map(cleanDomain).filter(Boolean)
    ])
  ];
  return {
    allow: s.allowDomains.map(cleanDomain).filter(Boolean).map(dom),
    blockNames,
    block: blockNames.map(dom),
    keep: s.keepUrls.map(parseKeep).filter(Boolean),
    bookmarks,
    keywords: s.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean),
    rules: [
      ...ENGINES.filter((e) => s.engines[e.id] !== false),
      ...s.customPatterns.map(parseCustom).filter(Boolean)
    ]
  };
}

function parseWeb(url) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  return u.protocol === "http:" || u.protocol === "https:" ? u : null;
}

// Pages the person asked to keep: never-delete domains, kept pages, bookmarks.
function isShielded(u, c, rawUrl) {
  const host = u.hostname.toLowerCase();
  if (c.allow.some((r) => r.test(host))) return true;
  if (c.keep.some((r) => r.host.test(host) && (!r.path || pathMatches(u.pathname, r.path)))) return true;
  if (c.bookmarks.size) {
    for (const v of [rawUrl, u.href, u.href.replace(/\/$/, "")]) if (c.bookmarks.has(v)) return true;
  }
  return false;
}

// `c` is the result of compileSettings(settings).
export function isSearchUrl(url, c) {
  const u = parseWeb(url);
  if (!u) return false;
  if (isShielded(u, c, url)) return false; // protection always wins

  const hostname = u.hostname.toLowerCase();
  if (c.block.some((r) => r.test(hostname))) return true;

  const params = new URLSearchParams(u.search);
  if (u.hash.length > 1) {
    for (const [k, v] of new URLSearchParams(u.hash.slice(1))) if (!params.has(k)) params.set(k, v);
  }
  for (const rule of c.rules) {
    if (matchesRule(rule, hostname, u.pathname, params)) return true;
  }
  return false;
}

// Hostname if this URL is on a hidden site (and not protected), otherwise null.
export function blockedHost(url, c) {
  const u = parseWeb(url);
  if (!u || isShielded(u, c, url)) return null;
  const host = u.hostname.toLowerCase();
  return c.block.some((r) => r.test(host)) ? host : null;
}

// The hidden-site domain (e.g. "facebook.com") a URL belongs to, or null.
export function blockedName(url, c) {
  const u = parseWeb(url);
  if (!u || isShielded(u, c, url)) return null;
  const host = u.hostname.toLowerCase();
  const i = c.block.findIndex((r) => r.test(host));
  return i === -1 ? null : c.blockNames[i];
}

// Full check for a history item: search URL rules first, then keywords in URL/title.
export function matchesItem(item, c) {
  if (isSearchUrl(item.url, c)) return true;
  if (!c.keywords.length) return false;

  const u = parseWeb(item.url);
  if (!u || isShielded(u, c, item.url)) return false;

  let hay = item.url + " " + (item.title || "");
  try {
    hay += " " + decodeURIComponent(item.url).replace(/\+/g, " ");
  } catch (e) {}
  hay = hay.toLowerCase();
  return c.keywords.some((k) => hay.includes(k));
}

// True when an item matches ONLY because its site is hidden (not a search, not a keyword).
// Only these can be held back by "wait" / "tab close"; searches and keywords go straight away.
const withoutSites = (c) => ({ ...c, block: [], blockNames: [] });
export function isSiteOnly(item, c) {
  return !!blockedName(item.url, c) && !matchesItem(item, withoutSites(c));
}

// gate: null (no holding back) or { delayMs, waitForTabClose, open: Set of hidden-site names with an open tab }.
export function isDue(item, c, gate) {
  if (!gate || !isSiteOnly(item, c)) return true;
  if (gate.delayMs && Date.now() - (item.lastVisitTime || 0) < gate.delayMs) return false;
  if (gate.waitForTabClose && gate.open.has(blockedName(item.url, c))) return false;
  return true;
}

// Origins to wipe site data for: every hidden domain (with and without www) plus
// any other hidden host seen in history. browsingData needs exact origins.
export function siteOrigins(c, extraHosts = []) {
  const out = new Set();
  const add = (raw) => {
    try { if (new URL(raw).origin === raw) out.add(raw); } catch (e) {}
  };
  for (const d of c.blockNames) for (const p of ["https://", "http://"]) { add(p + d); add(p + "www." + d); }
  for (const h of extraHosts) for (const p of ["https://", "http://"]) add(p + h);
  return [...out];
}

/* ---------- "hide this site" helpers used by the popup and the right-click menu ---------- */
export const normalizeHost = (h) => String(h).toLowerCase().replace(/^www\./, "");

const blockMatches = (s, host) => compileSettings(s).block.some((r) => r.test(normalizeHost(host)));

// Hidden means "on the block list and not on the never-delete list".
export function isHidden(s, host) {
  const h = normalizeHost(host);
  const c = compileSettings(s);
  return c.block.some((r) => r.test(h)) && !c.allow.some((r) => r.test(h));
}

// A single-site preset (Facebook, X / Twitter...). Bundles like "Shopping" are never switched as a whole from here.
const presetFor = (host) =>
  SITES.find((x) => !x.group && x.domains.some((d) => host === d || host.endsWith("." + d)));

// Returns the settings patch to start hiding `host`.
export function hideSite(s, host) {
  const h = normalizeHost(host);
  const patch = {};
  const preset = presetFor(h);
  if (preset) patch.sites = { ...s.sites, [preset.id]: true };
  else patch.blockDomains = [...new Set([...s.blockDomains, h])];
  const allow = s.allowDomains.filter((d) => !dom(cleanDomain(d)).test(h));
  if (allow.length !== s.allowDomains.length) patch.allowDomains = allow; // otherwise hiding would silently do nothing
  return patch;
}

// Returns the settings patch to stop hiding `host`.
export function unhideSite(s, host) {
  const h = normalizeHost(host);
  const patch = {};
  const preset = presetFor(h);
  if (preset) patch.sites = { ...s.sites, [preset.id]: false };
  patch.blockDomains = s.blockDomains.filter((d) => {
    const n = cleanDomain(d);
    return !n || !dom(n).test(h);
  });
  // Still covered by a bundle such as "Shopping sites"? Exempt just this site.
  if (blockMatches({ ...s, ...patch }, h)) patch.allowDomains = [...new Set([...s.allowDomains, h])];
  return patch;
}
