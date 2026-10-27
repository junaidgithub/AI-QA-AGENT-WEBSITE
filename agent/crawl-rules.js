/**
 * Pure rules deciding which discovered URLs the site crawler visits.
 * Kept free of browser code so they can be unit tested.
 */

const { hasSideEffectLink } = require("./ai-test-planner");

// Query parameters that only track marketing campaigns; pages that differ only by them are the same page.
const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|ref|ref_src|igshid|yclid)$/i;

const FILE_EXTENSIONS = /\.(pdf|zip|rar|7z|gz|tar|exe|msi|dmg|apk|ipa|docx?|xlsx?|pptx?|csv|txt|xml|json|rss|atom|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|avif|mp3|wav|ogg|mp4|m4v|mov|avi|webm|woff2?|ttf|eot|css|js|map)$/i;

// Areas an anonymous scan should not enter: login, admin, account and purchase flows.
const RESTRICTED_PATH = /(^|\/)(login|log-in|signin|sign-in|logout|log-out|signout|sign-out|wp-login\.php|wp-admin|admin|administrator|account|my-account|cart|basket|checkout)(\/|$|\.|\?)/i;

function siteHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "");
}

/** Same site = same scheme-agnostic host, treating "www." and the bare domain as one. */
function isSameSite(url, baseUrl) {
  try {
    return siteHost(new URL(url).hostname) === siteHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Canonical form used to avoid visiting the same page twice: no fragment, no
 * tracking parameters, sorted query, no trailing slash (except the root).
 */
function normalizeCrawlUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.hostname = url.hostname.toLowerCase();
  let pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (pathname.length > 1) pathname = pathname.replace(/\/$/, "");
  url.pathname = pathname;
  return url.href;
}

/** Path without query, used to cap how many query variants of one page are visited. */
function pathKey(normalizedUrl) {
  try {
    const url = new URL(normalizedUrl);
    return `${siteHost(url.hostname)}${url.pathname}`;
  } catch {
    return normalizedUrl;
  }
}

/**
 * Returns null when the URL may be crawled, otherwise the reason it is skipped.
 */
function crawlSkipReason(url, baseUrl, label = "") {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "Not a valid URL";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return `Not a web page (${parsed.protocol} link)`;
  if (!isSameSite(url, baseUrl)) return "External site (only the starting site is crawled; the link itself is still checked)";
  if (FILE_EXTENSIONS.test(parsed.pathname)) return "File download, not a web page";
  if (RESTRICTED_PATH.test(parsed.pathname)) return "Login, admin, account or purchase area (public pages only)";
  if (hasSideEffectLink(label, url)) return "Looks like a state-changing link (log out, unsubscribe, delete, cart)";
  return null;
}

/* ------------------------------------------------------------------ */
/* robots.txt                                                          */
/* ------------------------------------------------------------------ */

/**
 * Minimal robots.txt parser: the group for our user agent, else "*".
 * Supports Allow/Disallow with "*" wildcards and "$" anchors; the longest
 * matching rule wins, Allow winning ties (as Google does).
 */
function parseRobots(text, userAgent = "ai-qa-agent") {
  const groups = [];
  let current = null;
  let lastWasAgent = false;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const index = line.indexOf(":");
    if (index < 0) continue;
    const field = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();

    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      if (field === "disallow" && value === "") continue; // empty Disallow = allow all
      current.rules.push({ allow: field === "allow", path: value });
    }
  }

  const agent = userAgent.toLowerCase();
  const specific = groups.filter(group => group.agents.some(name => name !== "*" && agent.includes(name)));
  const chosen = specific.length ? specific : groups.filter(group => group.agents.includes("*"));
  return { rules: chosen.flatMap(group => group.rules) };
}

function ruleMatches(rulePath, path) {
  const anchored = rulePath.endsWith("$");
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = body.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path);
}

function isAllowedByRobots(robots, url) {
  if (!robots || !robots.rules || !robots.rules.length) return true;
  let path;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    return true;
  }
  let best = null;
  for (const rule of robots.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

module.exports = {
  isSameSite,
  normalizeCrawlUrl,
  pathKey,
  crawlSkipReason,
  parseRobots,
  isAllowedByRobots
};
