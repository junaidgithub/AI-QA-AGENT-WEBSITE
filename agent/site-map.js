/**
 * Page finder: discovers a site's pages quickly, without running any tests,
 * so the user can see how big the site is and choose what to test.
 *
 * Sources:
 *   1. sitemap.xml (and sitemaps listed in robots.txt): fast and often complete
 *   2. a quick browser crawl from the start URL (finds pages the sitemap misses)
 * The same skip rules as the full scan apply (external sites, files, login/admin,
 * state-changing links, robots.txt, crawler traps).
 */

const { launchBrowser } = require("./browser");
const { discoverPage } = require("./runner");
const { normalizeCrawlUrl, pathKey, crawlSkipReason, isSameSite, parseRobots, isAllowedByRobots } = require("./crawl-rules");
const { SiteThrottle } = require("./throttle");

const MAP_DEFAULTS = Object.freeze({
  maxPages: 200,
  maxDepth: 3,
  maxDurationMs: 2 * 60 * 1000,
  concurrency: 4,
  maxQueryVariants: 3,
  maxSitemaps: 10,
  maxSitemapUrls: 2000
});

/*
 * Seconds per page measured on real scans (desktop-only and desktop+mobile).
 * Light pages with shared headers are at the low end; product-heavy pages at the high end.
 */
const SECONDS_PER_PAGE = Object.freeze({
  desktop: [13, 30],
  desktopAndMobile: [30, 75]
});
const FIXED_OVERHEAD_SECONDS = 30;
const SAMPLES_PER_TEMPLATE = 2;
const MIN_TEMPLATE_SIZE = 4;
// Share of visited pages in a folder that must look like the first one for the folder to count as a template.
const TEMPLATE_AGREEMENT = 0.75;
const LAYOUT_SIMILARITY = 0.8;
const NAV_CATALOGUE_SIZE = 8;

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}

function segmentsOf(url) {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    // "/books/x/index.html" is the same page as "/books/x/".
    if (segments.length && /^index\.(html?|php|aspx?)$/i.test(segments[segments.length - 1])) segments.pop();
    return segments;
  } catch {
    return [];
  }
}

function similarity(a, b) {
  // Too few classes is not enough evidence of a shared template.
  if (!a || !b || a.length < 3 || b.length < 3) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const value of setA) if (setB.has(value)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

function parentPattern(url) {
  const segments = segmentsOf(url);
  return segments.length >= 2 ? `/${segments.slice(0, -1).join("/")}/*` : null;
}

/**
 * Top-level folder of a page, e.g. /store/blue-shoes -> "store"; single-level pages -> "Main pages".
 * prefixLength skips a folder shared by every page (e.g. a whole site under /en/).
 */
function sectionOf(url, prefixLength = 0) {
  const segments = segmentsOf(url).slice(prefixLength);
  return segments.length >= 2 ? segments[0] : "Main pages";
}

function commonPrefixLength(pages) {
  const lists = pages.map(page => segmentsOf(page.url));
  if (!lists.length) return 0;
  let length = 0;
  while (lists.every(list => list.length > length && list[length] === lists[0][length])) length += 1;
  return length;
}

/** Extract <loc> URLs from a sitemap or sitemap index. */
function parseSitemapXml(xml) {
  const text = String(xml || "");
  const locs = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(match => match[1].replace(/&amp;/g, "&"));
  return { isIndex: /<sitemapindex[\s>]/i.test(text), urls: locs };
}

async function fetchText(url, timeoutMs = 8000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "AI-QA-Agent" } });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function readSitemaps(baseUrl, robotsText, settings) {
  const candidates = new Set([new URL("/sitemap.xml", baseUrl).href, new URL("/sitemap_index.xml", baseUrl).href]);
  for (const match of String(robotsText || "").matchAll(/^\s*sitemap:\s*(\S+)/gim)) candidates.add(match[1]);

  const queue = [...candidates];
  const seen = new Set();
  const pageUrls = [];
  const found = [];
  while (queue.length && seen.size < settings.maxSitemaps && pageUrls.length < settings.maxSitemapUrls) {
    const sitemapUrl = queue.shift();
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);
    const xml = await fetchText(sitemapUrl);
    if (!xml || !/<(urlset|sitemapindex)[\s>]/i.test(xml)) continue;
    found.push(sitemapUrl);
    const { isIndex, urls } = parseSitemapXml(xml);
    if (isIndex) queue.push(...urls.filter(url => /\.xml(\.gz)?(\?|$)/i.test(url) && !/\.gz(\?|$)/i.test(url)));
    else pageUrls.push(...urls.slice(0, settings.maxSitemapUrls - pageUrls.length));
  }
  return { sitemaps: found, urls: pageUrls };
}

/**
 * Group pages into sections, and detect repeated templates (e.g. /store/<product>).
 * A folder counts as a template only when it has enough pages that are not
 * navigation/footer pages, AND the visited ones really share a layout
 * (similar CSS classes). This keeps unique pages such as /en/about and
 * /en/careers from being mistaken for copies of each other.
 */
function groupPages(pages) {
  const sections = new Map();
  const prefixLength = commonPrefixLength(pages);
  for (const page of pages) {
    page.section = sectionOf(page.url, prefixLength);
    page.template = null;
    if (!sections.has(page.section)) sections.set(page.section, []);
    sections.get(page.section).push(page);
  }

  const folders = new Map();
  for (const page of pages) {
    const pattern = parentPattern(page.url);
    if (!pattern || page.depth === 0) continue;
    if (!folders.has(pattern)) folders.set(pattern, []);
    folders.get(pattern).push(page);
  }

  const templateCounts = new Map();
  for (const [pattern, allMembers] of folders) {
    // A few menu links into a folder are unique key pages (About, Careers); a big menu
    // of them (a product catalogue in the navigation) can still be a template.
    const navCount = allMembers.filter(page => page.navLinked).length;
    const members = navCount >= NAV_CATALOGUE_SIZE ? allMembers : allMembers.filter(page => !page.navLinked);
    if (members.length < MIN_TEMPLATE_SIZE) continue;
    const visited = members.filter(page => page.layout && page.layout.length);
    let looksAlike = false;
    if (visited.length >= 2) {
      const reference = visited[0].layout;
      const alike = visited.filter(page => similarity(reference, page.layout) >= LAYOUT_SIMILARITY).length;
      looksAlike = alike / visited.length >= TEMPLATE_AGREEMENT;
    }
    if (!looksAlike) continue;
    for (const page of members) page.template = pattern;
    templateCounts.set(pattern, members.length);
  }

  return [...sections.entries()]
    .map(([name, sectionPages]) => ({
      name,
      count: sectionPages.length,
      templates: [...new Set(sectionPages.map(page => page.template).filter(Boolean))].map(template => ({ pattern: template, count: templateCounts.get(template) || 0 })),
      examples: sectionPages.slice(0, 3).map(page => page.path)
    }))
    .sort((a, b) => (a.name === "Main pages" ? -1 : b.name === "Main pages" ? 1 : b.count - a.count));
}

/**
 * Smart sample: every page that is not part of a repeated template, plus
 * SAMPLES_PER_TEMPLATE pages from each template. Order follows importance.
 */
function smartSample(pages) {
  const perTemplate = new Map();
  const selected = [];
  for (const page of pages) {
    if (!page.template) {
      selected.push(page.url);
      continue;
    }
    const used = perTemplate.get(page.template) || 0;
    if (used < SAMPLES_PER_TEMPLATE) {
      selected.push(page.url);
      perTemplate.set(page.template, used + 1);
    }
  }
  return selected;
}

/** Estimated scan duration in minutes for a number of pages: { low, high }. */
function estimateMinutes(pageCount, mobile) {
  const [low, high] = mobile ? SECONDS_PER_PAGE.desktopAndMobile : SECONDS_PER_PAGE.desktop;
  const toMinutes = seconds => Math.max(1, Math.round(seconds / 60));
  return { low: toMinutes(FIXED_OVERHEAD_SECONDS + pageCount * low), high: toMinutes(FIXED_OVERHEAD_SECONDS + pageCount * high) };
}

async function mapSite(url, options = {}) {
  const settings = { ...MAP_DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
  const startedMs = Date.now();
  const deadline = startedMs + settings.maxDurationMs;
  const timeUp = () => Date.now() > deadline;
  const progress = update => {
    if (typeof settings.onProgress === "function") {
      try { settings.onProgress(update); } catch {}
    }
  };

  const browser = await launchBrowser();
  const throttle = new SiteThrottle(settings.throttle || {});
  // Quick page load that pauses and retries once if the site answers 429 Too Many Requests.
  const quickDiscover = async pageUrl => {
    await throttle.wait();
    const first = await discoverPage(browser, pageUrl, { quick: true });
    if (!throttle.noteResponse(first.httpStatus, first.retryAfter)) return first;
    await throttle.wait();
    return discoverPage(browser, pageUrl, { quick: true });
  };
  const pages = new Map();
  const skippedReasons = {};
  const skip = reason => { skippedReasons[reason] = (skippedReasons[reason] || 0) + 1; };
  let robots = null;
  let robotsText = null;
  let sitemapInfo = { sitemaps: [], urls: [] };
  let error = null;
  let baseUrl = url;
  let capped = false;

  try {
    const start = await quickDiscover(url);
    if (start.status === "FAIL") {
      return { url, error: start.error, totalFound: 0, pages: [], sections: [], smartSample: [], durationMs: Date.now() - startedMs };
    }
    baseUrl = start.finalUrl || url;

    robotsText = await fetchText(new URL("/robots.txt", baseUrl).href);
    robots = robotsText ? parseRobots(robotsText, "ai-qa-agent") : null;

    const addPage = (pageUrl, fields) => {
      const normalized = normalizeCrawlUrl(pageUrl);
      if (!normalized || pages.has(normalized)) return false;
      if (pages.size >= settings.maxPages) {
        capped = true;
        return false;
      }
      pages.set(normalized, { url: normalized, path: pathOf(normalized), ...fields });
      return true;
    };

    const startNormalized = normalizeCrawlUrl(baseUrl);
    addPage(baseUrl, { depth: 0, source: "crawl", title: start.discovery?.title || null, httpStatus: start.httpStatus, priority: 0, order: 0, layout: start.discovery?.layoutClasses || null });

    // Breadth-first quick crawl.
    const queryVariants = new Map();
    const queue = [];
    let order = 0;
    const navLinked = new Set();
    const enqueue = (links, depth) => {
      for (const link of links || []) {
        const normalized = normalizeCrawlUrl(link.href);
        if (normalized && (link.region === "nav" || link.region === "footer")) navLinked.add(normalized);
        if (!normalized || pages.has(normalized) || queue.some(item => item.url === normalized)) continue;
        let reason = crawlSkipReason(normalized, baseUrl, link.text);
        if (!reason && robots && !isAllowedByRobots(robots, normalized)) reason = "Disallowed by the site's robots.txt";
        if (!reason && depth + 1 > settings.maxDepth) reason = `Deeper than the maximum link depth (${settings.maxDepth})`;
        if (!reason && new URL(normalized).search) {
          const variants = queryVariants.get(pathKey(normalized)) || 0;
          if (variants >= settings.maxQueryVariants) reason = "Too many query-string variants of the same page (possible crawler trap)";
          else queryVariants.set(pathKey(normalized), variants + 1);
        }
        if (reason) {
          skip(reason.replace(/\s*\(.*$/, ""));
          continue;
        }
        queue.push({ url: normalized, depth: depth + 1, priority: link.region === "nav" ? 0 : link.region === "footer" ? 1 : 2, order: (order += 1) });
      }
    };
    enqueue(start.discovery.crawlLinks, 0);

    await new Promise(resolve => {
      let active = 0;
      const pump = () => {
        while (active < throttle.concurrency(settings.concurrency) && queue.length && pages.size < settings.maxPages && !timeUp()) {
          queue.sort((a, b) => a.depth - b.depth || a.priority - b.priority || a.order - b.order);
          const item = queue.shift();
          active += 1;
          quickDiscover(item.url)
            .then(result => {
              const finalNormalized = normalizeCrawlUrl(result.finalUrl || item.url) || item.url;
              if (!isSameSite(finalNormalized, baseUrl)) return skip("Redirects to an external site");
              if (finalNormalized !== item.url && pages.has(finalNormalized)) return skip("Redirects to a page already found");
              if (result.status !== "FAIL" && result.contentType && !/html/i.test(result.contentType)) return skip("Not an HTML page");
              addPage(finalNormalized, { depth: item.depth, source: "crawl", title: result.discovery?.title || null, httpStatus: result.httpStatus, priority: item.priority, order: item.order, layout: result.discovery?.layoutClasses || null });
              progress({ phase: "finding", pagesFound: pages.size, maxPages: settings.maxPages, currentUrl: item.url });
              if (result.status !== "FAIL") enqueue(result.discovery.crawlLinks, item.depth);
            })
            .catch(() => {})
            .finally(() => {
              active -= 1;
              pump();
            });
        }
        if (active === 0) resolve();
      };
      pump();
    });
    if (queue.length) capped = true;

    // Sitemap pages the crawl did not reach.
    sitemapInfo = await readSitemaps(baseUrl, robotsText, settings);
    let sitemapOrder = 100000;
    for (const sitemapUrl of sitemapInfo.urls) {
      const normalized = normalizeCrawlUrl(sitemapUrl);
      if (!normalized || pages.has(normalized)) {
        if (normalized && pages.has(normalized)) pages.get(normalized).inSitemap = true;
        continue;
      }
      const reason = crawlSkipReason(normalized, baseUrl) || (robots && !isAllowedByRobots(robots, normalized) ? "Disallowed by the site's robots.txt" : null);
      if (reason) {
        skip(reason.replace(/\s*\(.*$/, ""));
        continue;
      }
      addPage(normalized, { depth: null, source: "sitemap", inSitemap: true, title: null, httpStatus: null, priority: 3, order: (sitemapOrder += 1) });
    }
    if (pages.has(startNormalized)) pages.get(startNormalized).order = -1;
    for (const page of pages.values()) page.navLinked = navLinked.has(page.url);
  } catch (caught) {
    error = caught.message;
  } finally {
    await browser.close().catch(() => {});
  }

  // Order by importance: start page, then breadth-first crawl order (navigation first), then sitemap-only pages.
  const ordered = [...pages.values()].sort((a, b) =>
    (a.depth ?? 99) - (b.depth ?? 99) || a.priority - b.priority || a.order - b.order);
  const sections = groupPages(ordered);
  const sample = smartSample(ordered);

  return {
    url,
    baseUrl,
    error,
    totalFound: ordered.length,
    capped: capped || timeUp(),
    limits: { maxPages: settings.maxPages, maxDepth: settings.maxDepth, maxDurationMs: settings.maxDurationMs },
    pages: ordered.map(({ url: pageUrl, path, depth, source, title, httpStatus, section, template, inSitemap, navLinked, layout }) => ({ url: pageUrl, path, depth, source, title, httpStatus, section, template, inSitemap: Boolean(inSitemap), navLinked: Boolean(navLinked), visited: Boolean(layout && layout.length) })),
    sections,
    smartSample: sample,
    sitemaps: sitemapInfo.sitemaps,
    robotsFound: Boolean(robotsText),
    rateLimit: throttle.summary(),
    skipped: skippedReasons,
    secondsPerPage: SECONDS_PER_PAGE,
    overheadSeconds: FIXED_OVERHEAD_SECONDS,
    estimates: {
      smartSample: { pages: sample.length, desktop: estimateMinutes(sample.length, false), desktopAndMobile: estimateMinutes(sample.length, true) },
      all: { pages: ordered.length, desktop: estimateMinutes(ordered.length, false), desktopAndMobile: estimateMinutes(ordered.length, true) }
    },
    durationMs: Date.now() - startedMs
  };
}

module.exports = { mapSite, parseSitemapXml, groupPages, smartSample, estimateMinutes, sectionOf, similarity, SECONDS_PER_PAGE };
