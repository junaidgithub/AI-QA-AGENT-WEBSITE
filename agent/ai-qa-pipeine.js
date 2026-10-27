const fs = require("fs");
const path = require("path");
const { reportsDir: getReportsDir } = require("./paths");

const { runQA, discoverPage } = require("./runner");
const { planTestsWithNotes } = require("./ai-test-planner");
const { executeTest } = require("./test-executor");
const { generateHtmlReport } = require("./report-generator");
const { launchBrowser } = require("./browser");
const { DESKTOP, MOBILE } = require("./viewports");
const { normalizeCrawlUrl, pathKey, crawlSkipReason, isSameSite, parseRobots, isAllowedByRobots } = require("./crawl-rules");
const { OUTCOMES, setOutcome, summarize, overallStatus, classifyHttpStatus } = require("./outcomes");
const { SiteThrottle, isPageLoadTimeout } = require("./throttle");

const DEFAULTS = Object.freeze({
  maxPages: 1,
  maxDepth: 3,
  mobile: false,
  concurrency: Number(process.env.QA_CONCURRENCY) || 3,
  maxDurationMs: Number(process.env.QA_MAX_DURATION_MS) || 30 * 60 * 1000,
  maxQueryVariants: 3
});

const MAX_SKIPPED_URLS = 300;

/**
 * Defaults keep the original behaviour (one page, desktop). The dashboard
 * asks for a site scan: { maxPages: 25, mobile: true }.
 */
function resolveOptions(options = {}) {
  const settings = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
  if (settings.singlePage) settings.maxPages = 1;
  // Pages chosen in "Find Pages": test exactly these, without crawling further.
  if (Array.isArray(settings.pages) && settings.pages.length) {
    settings.selectedPages = [...new Set(settings.pages.map(page => normalizeCrawlUrl(page)).filter(Boolean))];
    settings.maxPages = settings.selectedPages.length;
  }
  settings.maxDurationMs = Math.max(60 * 1000, Math.min(120 * 60 * 1000, Number(settings.maxDurationMs) || DEFAULTS.maxDurationMs));
  settings.maxPages = Math.max(1, Math.min(200, Math.floor(Number(settings.maxPages) || 1)));
  settings.maxDepth = Math.max(0, Math.min(10, Math.floor(Number(settings.maxDepth) || 0)));
  settings.concurrency = Math.max(1, Math.min(8, Math.floor(Number(settings.concurrency) || 1)));
  settings.mobile = Boolean(settings.mobile);
  return settings;
}

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}

/**
 * When discovery itself fails (DNS error, timeout, HTTP error page), the run
 * must not end as "PASS with 0 tests". Record the page-load failure instead.
 */
function discoveryFailureResult(url, discoveryResult, screenshotPath, rateLimited = false) {
  const result = {
    test: { name: `Page loads - ${url}`, type: "page_load" },
    error: discoveryResult.error,
    screenshot: screenshotPath && fs.existsSync(screenshotPath) ? screenshotPath : null,
    beforeUrl: url,
    afterUrl: null,
    httpStatus: discoveryResult.httpStatus ?? null,
    viewport: "desktop"
  };

  const verdict = classifyHttpStatus(result.httpStatus);
  if (verdict === "restricted") {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
      `The page responded with HTTP ${result.httpStatus} (access restriction or bot protection) and could not be scanned.`);
  }
  if (rateLimited) {
    // While the site is answering "429 Too Many Requests", a slow page is not evidence of a defect.
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "RATE_LIMITED",
      `The page did not load in time while the website was rate-limiting the scan (HTTP 429), even after pausing and retrying: ${discoveryResult.error}`);
  }
  return setOutcome(result, OUTCOMES.FAIL, "PAGE_UNREACHABLE",
    `The page could not be loaded, so no other checks were run: ${discoveryResult.error}. ` +
    "If the site works in a normal browser, check this machine's network/proxy settings.");
}

async function loadRobots(baseUrl) {
  const robotsUrl = new URL("/robots.txt", baseUrl).href;
  try {
    const response = await fetch(robotsUrl, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "AI-QA-Agent" } });
    if (!response.ok) return { url: robotsUrl, found: false, status: response.status, robots: null };
    const robots = parseRobots(await response.text(), "ai-qa-agent");
    return { url: robotsUrl, found: true, status: response.status, rules: robots.rules.length, robots };
  } catch (error) {
    return { url: robotsUrl, found: false, status: null, error: error.message, robots: null };
  }
}

/**
 * One key per distinct check, so a link in the shared header is tested once
 * for the whole site and its result lists every page it appears on.
 */
function siteKey(test, viewport, pageUrl) {
  const lower = value => String(value || "").toLowerCase();
  switch (test.type) {
    case "link":
      // Visible links are keyed by destination: a product's image link and title link are one check.
      // For links to the current page the fragment is kept, so "#features", "#" and "/" stay separate checks.
      return test.expectedHidden
        ? `link|${viewport}|hidden|${linkDestination(test, pageUrl)}|${lower(test.text)}`
        : `link|${viewport}|visible|${linkDestination(test, pageUrl)}`;
    case "button":
      return test.text ? `button|${viewport}|${lower(test.text)}` : `button|${viewport}|${pageUrl}|${test.selector}`;
    case "form_submit":
      if (test.fieldSignature || test.formId) return `form|${viewport}|${lower(test.formId)}|${test.fieldSignature || ""}|${lower(test.text)}`;
      // A form without fields (e.g. "Add to basket") is the same check wherever its button label repeats.
      return test.text ? `form|${viewport}|nofields|${lower(test.text)}` : `form|${viewport}|${pageUrl}|${test.formIndex}`;
    case "input":
      return `input|${viewport}|${lower(test.identifier)}`;
    case "mobile_menu":
      return `menu|${viewport}|${lower(test.text)}|${test.selector}`;
    default:
      return `${test.type}|${viewport}|${pageUrl}|${lower(test.text)}`;
  }
}

function linkDestination(test, pageUrl) {
  const destination = normalizeCrawlUrl(test.href) || test.href;
  const raw = String(test.rawHref || "").trim();
  if (raw.startsWith("#")) return `${destination}${raw}|in-page`;
  if (destination !== normalizeCrawlUrl(pageUrl)) return destination;
  let hash = "";
  try { hash = new URL(test.href).hash; } catch {}
  return hash ? `${destination}${hash}|in-page` : destination;
}

function decorateTest(test, { pageUrl, viewport, siteMode }) {
  const decorated = { ...test, page: pageUrl, viewport: viewport.name };
  if (siteMode && ["page_load", "broken_image", "form"].includes(test.type)) decorated.name = `${decorated.name} (${pathOf(pageUrl)})`;
  if (viewport.name === "mobile") decorated.name = `[Mobile] ${decorated.name}`;
  return decorated;
}

async function runPipeline(url, options = {}) {
  const settings = resolveOptions(options);
  const siteMode = settings.maxPages > 1;
  const viewports = settings.mobile ? [DESKTOP, MOBILE] : [DESKTOP];
  const pipelineStartedMs = Date.now();
  const deadline = pipelineStartedMs + settings.maxDurationMs;
  const timeUp = () => Date.now() > deadline;
  const progress = update => {
    if (typeof settings.onProgress === "function") {
      try { settings.onProgress(update); } catch {}
    }
  };

  console.log(`Starting QA for: ${url}${siteMode ? ` (site scan: up to ${settings.maxPages} pages, depth ${settings.maxDepth})` : ""}${settings.mobile ? " with desktop + mobile" : ""}`);
  progress({ phase: "discovery", pagesScanned: 0, maxPages: settings.maxPages, currentUrl: url, testsRun: 0 });

  const reportsDir = getReportsDir();
  const throttle = new SiteThrottle(settings.throttle || {});
  let discoveryResult = await runQA(url);
  // A "429 Too Many Requests" start page has no real content: pause as asked and load it again once.
  if (discoveryResult.raw && throttle.noteResponse(discoveryResult.raw.httpStatus, discoveryResult.raw.retryAfter)) {
    throttle.retries += 1;
    await throttle.wait();
    discoveryResult = await runQA(url);
    throttle.noteResponse(discoveryResult.raw?.httpStatus, discoveryResult.raw?.retryAfter);
  }
  console.log(`Discovery status: ${discoveryResult.status}`);

  const registry = new Map();
  const pageRecords = [];
  const skippedElementMap = new Map();
  const skippedUrls = new Map();
  let testsRun = 0;
  let testsNotRunForTime = 0;
  let robotsInfo = null;

  /** Run one check politely: wait out any rate-limit pause, and retry once if the page was throttled. */
  async function executePolitely(pageUrl, test, viewport, browser) {
    await throttle.wait();
    let result = await executeTest(pageUrl, test, { browser, viewport });
    // A 429 can also come from the page a link leads to, or from a direct destination check.
    const destinationThrottled = result.navigationStatus === 429 || result.destinationCheck?.status === 429;
    const throttled = throttle.noteResponse(result.httpStatus, result.retryAfter) ||
      (destinationThrottled && throttle.noteResponse(429, null)) ||
      (isPageLoadTimeout(result) && throttle.noteTimeout());
    if (!throttled) return result;
    throttle.retries += 1;
    await throttle.wait();
    result = await executeTest(pageUrl, test, { browser, viewport });
    result.retriedAfterRateLimit = true;
    const stillThrottled = throttle.noteResponse(result.httpStatus, result.retryAfter) ||
      result.navigationStatus === 429 || result.destinationCheck?.status === 429 ||
      (isPageLoadTimeout(result) && throttle.limited);
    if (stillThrottled && result.outcome === OUTCOMES.AUTOMATION_ERROR) {
      setOutcome(result, OUTCOMES.NOT_VERIFIED, "RATE_LIMITED",
        `The website was rate-limiting the scan (HTTP 429); this check could not run even after pausing and retrying. ${result.details || ""}`.trim());
    }
    return result;
  }

  /** Discover a page, pausing and retrying once when the site rate-limits us. */
  async function discoverPolitely(browser, pageUrl, viewport) {
    await throttle.wait();
    let found = await discoverPage(browser, pageUrl, { viewport });
    const throttled = throttle.noteResponse(found.httpStatus, found.retryAfter) || (found.status === "FAIL" && isPageLoadTimeout(found) && throttle.noteTimeout());
    if (!throttled) return found;
    throttle.retries += 1;
    await throttle.wait();
    found = await discoverPage(browser, pageUrl, { viewport });
    throttle.noteResponse(found.httpStatus, found.retryAfter);
    return found;
  }

  const addSkippedUrl = (skippedUrl, reason, foundOn) => {
    if (skippedUrls.has(skippedUrl)) return;
    if (skippedUrls.size >= MAX_SKIPPED_URLS) return;
    skippedUrls.set(skippedUrl, { url: skippedUrl, reason, foundOn: foundOn || null });
  };

  const recordSkippedElements = (items, pageUrl, viewport) => {
    for (const item of items) {
      const key = `${item.kind}|${viewport.name}|${String(item.label).toLowerCase()}|${item.reason}`;
      if (!skippedElementMap.has(key)) skippedElementMap.set(key, { ...item, viewport: viewport.name, pages: [] });
      const entry = skippedElementMap.get(key);
      if (!entry.pages.includes(pageUrl)) entry.pages.push(pageUrl);
    }
  };

  async function runTest(test, record, viewport, browser) {
    const decorated = decorateTest(test, { pageUrl: record.url, viewport, siteMode });
    const key = siteKey(decorated, viewport.name, record.url);
    if (registry.has(key)) {
      record.keys.add(key);
      registry.get(key).occurrences.add(record.url);
      return;
    }
    if (timeUp()) {
      testsNotRunForTime += 1;
      return;
    }
    record.keys.add(key);
    const entry = { occurrences: new Set([record.url]), result: null };
    registry.set(key, entry);

    console.log(`Running: ${decorated.name}${siteMode ? ` @ ${pathOf(record.url)}` : ""}`);
    let result;
    try {
      result = await executePolitely(record.url, decorated, viewport, browser);
    } catch (error) {
      // Never lose earlier results because one test (or the browser) broke.
      result = setOutcome({ test: decorated, error: error.message, beforeUrl: record.url, afterUrl: null, screenshot: null, viewport: viewport.name },
        OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR", `Automation could not run this test: ${error.message}`);
    }
    entry.result = result;
    testsRun += 1;
    console.log(`Result: ${result.outcome}${result.details ? ` — ${result.details}` : ""}`);
    progress({ phase: "testing", pagesScanned: pageRecords.length, maxPages: settings.maxPages, currentUrl: record.url, testsRun });
  }

  if (discoveryResult.status === "FAIL") {
    const failed = discoveryFailureResult(url, discoveryResult, path.join(reportsDir, "failure.png"));
    registry.set("start", { occurrences: new Set([url]), result: failed });
    pageRecords.push({ url, depth: 0, from: null, httpStatus: discoveryResult.httpStatus ?? null, title: null, error: discoveryResult.error, keys: new Set(["start"]), consoleErrors: discoveryResult.consoleErrors || [], networkErrors: discoveryResult.networkErrors || [], viewports: [] });
    console.log(`Discovery failed: ${discoveryResult.error}`);
  } else {
    const startUrl = discoveryResult.discovery.url || url;
    const baseUrl = startUrl;
    const visited = new Set();
    const queued = new Set();
    const queryVariants = new Map();
    const queue = [];
    let sequence = 0;
    let pagesStarted = 0;

    if (siteMode) {
      robotsInfo = await loadRobots(baseUrl);
      if (robotsInfo.robots && !isAllowedByRobots(robotsInfo.robots, startUrl)) {
        robotsInfo.note = "The starting URL is disallowed by robots.txt; it was scanned because you requested it explicitly.";
      }
    }

    const enqueueLinks = (links, fromUrl, depth) => {
      for (const link of links || []) {
        const normalized = normalizeCrawlUrl(link.href);
        if (!normalized || visited.has(normalized) || queued.has(normalized)) continue;
        let reason = crawlSkipReason(normalized, baseUrl, link.text);
        if (!reason && robotsInfo?.robots && !isAllowedByRobots(robotsInfo.robots, normalized)) reason = "Disallowed by the site's robots.txt";
        if (!reason && depth + 1 > settings.maxDepth) reason = `Deeper than the maximum link depth (${settings.maxDepth})`;
        if (!reason && new URL(normalized).search) {
          const variants = queryVariants.get(pathKey(normalized)) || 0;
          if (variants >= settings.maxQueryVariants) reason = "Too many query-string variants of the same page (possible crawler trap)";
        }
        if (reason) {
          addSkippedUrl(normalized, reason, fromUrl);
          continue;
        }
        queued.add(normalized);
        queryVariants.set(pathKey(normalized), (queryVariants.get(pathKey(normalized)) || 0) + 1);
        queue.push({ url: normalized, depth: depth + 1, priority: link.region === "nav" ? 0 : link.region === "footer" ? 1 : 2, from: fromUrl, sequence: (sequence += 1) });
      }
    };

    const takeNext = () => {
      queue.sort((a, b) => a.depth - b.depth || a.priority - b.priority || a.sequence - b.sequence);
      return queue.shift();
    };

    async function processPage(item, browser) {
      const record = { url: item.url, depth: item.depth, from: item.from, httpStatus: null, title: null, error: null, keys: new Set(), consoleErrors: [], networkErrors: [], viewports: [] };
      const desktop = item.preDiscovery || await discoverPolitely(browser, item.url, DESKTOP);

      // Redirects: off-site, or onto a page that is already being scanned.
      const finalNormalized = normalizeCrawlUrl(desktop.finalUrl || item.url) || item.url;
      if ((item.depth > 0 || settings.selectedPages) && finalNormalized !== normalizeCrawlUrl(item.url)) {
        if (!isSameSite(finalNormalized, baseUrl)) {
          addSkippedUrl(item.url, `Redirects to an external site (${finalNormalized})`, item.from);
          return false;
        }
        if (visited.has(finalNormalized)) {
          addSkippedUrl(item.url, `Redirects to a page that is already scanned (${pathOf(finalNormalized)})`, item.from);
          return false;
        }
        visited.add(finalNormalized);
      }
      if (desktop.status !== "FAIL" && desktop.contentType && !/html/i.test(desktop.contentType)) {
        addSkippedUrl(item.url, `Not an HTML page (${desktop.contentType.split(";")[0]})`, item.from);
        return false;
      }

      pageRecords.push(record);
      record.httpStatus = desktop.httpStatus;
      record.title = desktop.discovery?.title || null;
      record.consoleErrors = desktop.consoleErrors || [];
      record.networkErrors = desktop.networkErrors || [];
      progress({ phase: "testing", pagesScanned: pageRecords.length, maxPages: settings.maxPages, currentUrl: item.url, testsRun });

      if (desktop.status === "FAIL") {
        record.error = desktop.error;
        const key = `page_load|desktop|${item.url}`;
        registry.set(key, { occurrences: new Set([item.url]), result: discoveryFailureResult(item.url, desktop, null, throttle.limited && isPageLoadTimeout(desktop)) });
        record.keys.add(key);
        return true;
      }

      if (siteMode && !settings.selectedPages) enqueueLinks(desktop.discovery.crawlLinks, item.url, item.depth);

      // An error page (404/500) only gets one desktop page-load check; testing its content would be noise.
      const errorPage = classifyHttpStatus(desktop.httpStatus) === "failure";
      const desktopLinks = new Set();

      for (const viewport of errorPage ? [DESKTOP] : viewports) {
        if (timeUp()) break;
        const discovered = viewport === DESKTOP ? desktop : await discoverPolitely(browser, item.url, viewport);
        if (discovered.status === "FAIL") {
          record.viewports.push({ name: viewport.name, error: discovered.error });
          continue;
        }
        record.viewports.push({ name: viewport.name, error: null });
        const { tests, skipped } = planTestsWithNotes(discovered.discovery, { viewport: viewport.name });
        const toRun = [];
        for (const test of errorPage ? tests.filter(candidate => candidate.type === "page_load") : tests) {
          const href = test.type === "link" ? normalizeCrawlUrl(test.href) || test.href : null;
          if (href && viewport === DESKTOP && !test.expectedHidden) desktopLinks.add(href);
          // A link that is also visible on desktop has the same destination; it is checked once, on desktop.
          if (href && viewport !== DESKTOP && desktopLinks.has(href)) {
            skipped.push({ kind: "link", label: test.text || href, href: test.href, reason: "Same link as in the desktop layout; its destination is checked once, in the desktop run." });
            continue;
          }
          // Respect robots.txt for link checks too: a disallowed URL is never requested.
          if (href && robotsInfo?.robots && isSameSite(href, baseUrl) && !isAllowedByRobots(robotsInfo.robots, href)) {
            skipped.push({ kind: "link", label: test.text || href, href: test.href, reason: "Disallowed by the site's robots.txt; the link was neither followed nor requested." });
            continue;
          }
          toRun.push(test);
        }
        recordSkippedElements(skipped, item.url, viewport);
        for (const test of toRun) await runTest(test, record, viewport, browser);
      }
      return true;
    }

    const startNormalized = normalizeCrawlUrl(startUrl) || startUrl;
    if (settings.selectedPages) {
      // Selected pages: only these, in the chosen order, all same-site.
      for (const selectedUrl of settings.selectedPages) {
        if (!isSameSite(selectedUrl, baseUrl) || queued.has(selectedUrl)) continue;
        queued.add(selectedUrl);
        const isStart = selectedUrl === startNormalized;
        queue.push({ url: isStart ? startUrl : selectedUrl, depth: 0, priority: 0, from: null, sequence: (sequence += 1), preDiscovery: isStart ? discoveryResult.raw : undefined });
      }
    } else {
      visited.add(startNormalized);
      queued.add(startNormalized);
      queue.push({ url: startUrl, depth: 0, priority: 0, from: null, sequence: 0, preDiscovery: discoveryResult.raw });
    }

    const browser = await launchBrowser();
    try {
      await new Promise(resolve => {
        let active = 0;
        const pump = () => {
          // After a rate-limit response the scan continues one page at a time.
          while (active < throttle.concurrency(settings.concurrency) && queue.length && pagesStarted < settings.maxPages && !timeUp()) {
            const item = takeNext();
            visited.add(item.url);
            pagesStarted += 1;
            active += 1;
            processPage(item, browser)
              .then(counted => {
                // Redirect duplicates and non-HTML responses do not use up the page budget.
                if (counted === false) pagesStarted -= 1;
              })
              .catch(error => {
                pageRecords.push({ url: item.url, depth: item.depth, from: item.from, httpStatus: null, title: null, error: error.message, keys: new Set(), consoleErrors: [], networkErrors: [], viewports: [] });
              })
              .finally(() => {
                active -= 1;
                pump();
              });
          }
          if (active === 0) resolve();
        };
        pump();
      });
    } finally {
      await browser.close().catch(() => {});
    }

    for (const notSelected of settings.notSelected || []) {
      const normalized = normalizeCrawlUrl(notSelected);
      if (normalized) addSkippedUrl(normalized, "Found by Find Pages but not selected for testing", null);
    }
    for (const item of queue) {
      addSkippedUrl(item.url, timeUp() ? "Time limit reached before this page was scanned" : `Page limit reached (${settings.maxPages} pages)`, item.from);
    }
    for (const visitedUrl of visited) skippedUrls.delete(visitedUrl);
  }

  // Assemble results: one entry per distinct check, listing every page it applies to.
  const executionResults = [];
  for (const entry of registry.values()) {
    if (!entry.result) continue;
    entry.result.occurrences = [...entry.occurrences];
    entry.result.page = entry.result.page || entry.result.occurrences[0];
    executionResults.push(entry.result);
  }

  const resultByKey = new Map([...registry.entries()].map(([key, entry]) => [key, entry.result]));
  const pages = pageRecords.map(record => {
    const results = [...record.keys].map(key => resultByKey.get(key)).filter(Boolean);
    const pageSummary = summarize(results);
    return {
      url: record.url,
      path: pathOf(record.url),
      depth: record.depth,
      foundOn: record.from || null,
      httpStatus: record.httpStatus,
      title: record.title,
      error: record.error,
      viewports: record.viewports.length ? record.viewports : [{ name: "desktop", error: record.error }],
      consoleErrorCount: record.consoleErrors.length,
      networkErrorCount: record.networkErrors.length,
      summary: pageSummary,
      status: overallStatus(pageSummary)
    };
  });

  const summary = summarize(executionResults);
  const finalStatus = overallStatus(summary);
  const sumOf = (key, source = result => result.safety) => executionResults.reduce((total, result) => total + ((source(result) || {})[key] || 0), 0);
  const deadlinePassed = timeUp();

  const finalResult = {
    target: url,
    status: finalStatus,
    discovery: discoveryResult.discovery,
    discoveryError: discoveryResult.error || null,
    consoleErrors: discoveryResult.consoleErrors || [],
    networkErrors: discoveryResult.networkErrors || [],
    generatedTests: executionResults.map(result => result.test),
    skippedElements: [...skippedElementMap.values()],
    executionResults,
    summary,
    pages,
    crawl: {
      mode: settings.selectedPages ? "selected" : siteMode ? "site" : "single-page",
      pagesFound: Number.isInteger(settings.pagesFound) ? settings.pagesFound : null,
      maxPages: settings.maxPages,
      maxDepth: settings.maxDepth,
      viewports: viewports.map(viewport => viewport.name),
      concurrency: settings.concurrency,
      pagesScanned: pages.length,
      skippedUrls: [...skippedUrls.values()],
      testsNotRunForTime,
      timeLimitReached: deadlinePassed,
      maxDurationMs: settings.maxDurationMs,
      robots: robotsInfo ? { url: robotsInfo.url, found: robotsInfo.found, rules: robotsInfo.rules || 0, note: robotsInfo.note || null } : null,
      rateLimit: throttle.summary()
    },
    safety: {
      // The agent never clicks submit controls; submit attempts made by page scripts are cancelled and counted.
      formsSubmitted: 0,
      submitAttemptsBlocked: sumOf("submitAttemptsBlocked", result => result.validation),
      navigationsBlockedDuringFormTests: sumOf("navigationsBlocked", result => result.validation),
      mutatingRequestsBlocked: sumOf("mutatingRequestsBlocked"),
      note: "Forms are never submitted and side-effect buttons/links are never clicked. State-changing (non-GET) requests are blocked during tests, and page navigation is blocked during form tests."
    },
    metadata: {
      startedAt: discoveryResult.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - pipelineStartedMs,
      discoveryDurationMs: discoveryResult.durationMs || null,
      browser: discoveryResult.discovery?.browser || { name: "Chromium", version: "Unknown" },
      viewport: discoveryResult.discovery?.viewport || { width: 1280, height: 720 },
      viewports: viewports.map(viewport => ({ name: viewport.name, ...viewport.contextOptions.viewport }))
    }
  };

  fs.mkdirSync(reportsDir, { recursive: true });
  const jsonPath = path.join(reportsDir, "ai-qa-report.json");
  const htmlPath = path.join(reportsDir, "ai-qa-report.html");
  fs.writeFileSync(jsonPath, JSON.stringify(finalResult, null, 2));
  fs.writeFileSync(htmlPath, generateHtmlReport(finalResult));
  progress({ phase: "done", pagesScanned: pages.length, maxPages: settings.maxPages, currentUrl: null, testsRun });

  console.log("\n==============================");
  console.log("FINAL QA RESULT");
  console.log("==============================");
  console.log(`Status: ${finalStatus}`);
  if (siteMode) console.log(`Pages scanned: ${pages.length} (skipped URLs: ${finalResult.crawl.skippedUrls.length})`);
  console.log(`Total Tests: ${summary.total}`);
  console.log(`Passed: ${summary.passed} (of which form validation: ${summary.validationPasses})`);
  console.log(`Confirmed Failures: ${summary.failed}`);
  console.log(`Not Verified: ${summary.notVerified}`);
  console.log(`Automation Errors: ${summary.automationErrors}`);
  console.log(`Pass Rate: ${summary.passRate}%`);
  console.log("==============================");
  console.log(`\nJSON Report: ${jsonPath}`);
  console.log(`HTML Report: ${htmlPath}`);

  return finalResult;
}

function parseCliArgs(argv) {
  const options = {};
  let url = null;
  for (const arg of argv) {
    if (arg === "--site") { options.maxPages = options.maxPages || 25; options.mobile = true; }
    else if (arg === "--mobile") options.mobile = true;
    else if (arg.startsWith("--pages=")) options.maxPages = Number(arg.slice(8));
    else if (arg.startsWith("--depth=")) options.maxDepth = Number(arg.slice(8));
    else if (arg.startsWith("--concurrency=")) options.concurrency = Number(arg.slice(14));
    else if (!arg.startsWith("--")) url = arg;
  }
  return { url, options };
}

if (require.main === module) {
  const { url, options } = parseCliArgs(process.argv.slice(2));

  if (!url) {
    console.error("Usage: node agent/ai-qa-pipeine.js https://example.com [--site] [--pages=25] [--depth=3] [--mobile] [--concurrency=3]");
    process.exit(1);
  }

  runPipeline(url, options)
    .then(result => {
      console.log("\nPipeline completed.");
      console.log(JSON.stringify(result.summary, null, 2));
    })
    .catch(error => {
      console.error("Pipeline failed:", error);
      process.exit(1);
    });
}

module.exports = {
  runPipeline,
  resolveOptions,
  parseCliArgs,
  siteKey
};
