/**
 * Phase 1 regression tests: full-site crawl, desktop + mobile, dedupe and
 * site-level reporting, against the generated /multi/ fixture site.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.QA_REPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qa-agent-site-"));

const { startFixtureServer } = require("../fixtures/server");
const { runPipeline } = require("../../agent/ai-qa-pipeine");

let fixture;
let site;
let html;

function quiet(fn) {
  const original = console.log;
  console.log = () => {};
  return fn().finally(() => { console.log = original; });
}

const paths = run => run.pages.map(page => page.path);
const byName = name => {
  const found = site.executionResults.find(result => result.test.name === name);
  assert.ok(found, `missing "${name}". Have: ${site.executionResults.map(r => r.test.name).join(" | ")}`);
  return found;
};

test.before(async () => {
  fixture = await startFixtureServer();
  site = await quiet(() => runPipeline(`${fixture.baseUrl}/multi/index.html`, { maxPages: 25, mobile: true }));
  html = fs.readFileSync(path.join(process.env.QA_REPORTS_DIR, "ai-qa-report.html"), "utf8");
});

test.after(async () => {
  if (fixture) await fixture.close();
});

test("crawls internal pages breadth-first within the depth limit", () => {
  const scanned = paths(site);
  for (const expected of ["/multi/index.html", "/multi/about.html", "/multi/products.html", "/multi/blog.html", "/multi/contact.html", "/multi/privacy.html", "/multi/terms.html", "/multi/product-3.html", "/multi/post-2.html", "/multi/blog.html?page=2"]) {
    assert.ok(scanned.includes(expected), `${expected} should be scanned; got ${scanned.join(", ")}`);
  }
  assert.ok(!scanned.includes("/multi/post-3.html"), "depth 4 is beyond the default limit of 3");
  assert.ok(site.pages.length <= 25);
  assert.equal(site.crawl.mode, "site");
  assert.deepEqual(site.crawl.viewports, ["desktop", "mobile"]);
});

test("never visits a page twice (fragments and tracking parameters are the same page)", () => {
  const scanned = paths(site);
  assert.equal(new Set(scanned).size, scanned.length);
  assert.equal(scanned.filter(p => p.startsWith("/multi/about.html")).length, 1);
});

test("skips external sites, files, logout, robots.txt-blocked pages and crawler traps, with reasons", () => {
  const reasonFor = fragment => site.crawl.skippedUrls.find(item => item.url.includes(fragment))?.reason;
  assert.match(reasonFor("brochure.pdf"), /File download/);
  assert.match(reasonFor("/multi/logout"), /Login|state-changing/);
  assert.match(reasonFor("/multi/private/secret.html"), /robots\.txt/);
  assert.match(reasonFor("localhost:"), /External site/);
  assert.match(reasonFor("post-3.html"), /depth/);
  assert.ok(site.crawl.skippedUrls.some(item => /crawler trap/.test(item.reason)), "calendar trap is capped");
  assert.ok(paths(site).filter(p => p.startsWith("/multi/calendar")).length <= 3);
  assert.equal(site.crawl.robots.found, true);
});

test("safety: robots-blocked and logout URLs are never requested; nothing is submitted", () => {
  assert.deepEqual(fixture.sensitiveGets, []);
  assert.deepEqual(fixture.mutatingRequests, []);
  assert.ok(site.skippedElements.some(item => /robots\.txt/.test(item.reason) && /Internal notes/.test(item.label)));
});

test("shared header/footer checks run once and list every page they appear on", () => {
  const about = byName("Link works - About");
  assert.equal(about.outcome, "PASS");
  assert.ok(about.occurrences.length >= 10, `About appears on ${about.occurrences.length} pages`);
  assert.equal(site.executionResults.filter(result => result.test.name === "Link works - About").length, 1);

  const newsletter = byName("Form validation - Subscribe");
  assert.equal(newsletter.outcome, "PASS", newsletter.details);
  assert.ok(newsletter.occurrences.length >= 10, "the footer form is validated once for the whole site");
});

test("mobile: the hamburger menu is tested and links already checked on desktop are not re-checked", () => {
  const menu = byName("[Mobile] Mobile menu opens - Open menu");
  assert.equal(menu.outcome, "PASS", menu.details);
  assert.ok(menu.menuCheck.visibleLinksAfter > menu.menuCheck.visibleLinksBefore);
  assert.equal(menu.viewport, "mobile");
  assert.ok(!site.executionResults.some(result => result.test.name === "[Mobile] Link works - Privacy"), "same destination as on desktop");
  assert.ok(site.executionResults.some(result => result.test.name === "[Mobile] Form validation - Subscribe"));
  assert.ok(site.executionResults.some(result => result.test.name.startsWith("[Mobile] Page loads")));
});

test("a broken internal link is reported once per check and grouped into one defect", () => {
  const spec = byName("Link works - Spec sheet");
  assert.equal(spec.outcome, "FAIL");
  assert.deepEqual(spec.occurrences.map(url => new URL(url).pathname), ["/multi/product-3.html"]);
  const missingPage = site.pages.find(page => page.path === "/multi/missing-spec.html");
  assert.equal(missingPage.httpStatus, 404);
  assert.equal(missingPage.status, "FAIL");
  const pageLoadChecks = site.executionResults.filter(result => result.test.type === "page_load" && result.test.page.endsWith("/multi/missing-spec.html"));
  assert.equal(pageLoadChecks.length, 1, "an error page gets one desktop page-load check");
  assert.ok(!site.executionResults.some(result => result.test.name === "[Mobile] Link works - Spec sheet"));

  // Report: the link failure and the 404 page are one defect card.
  const defectCards = (html.match(/<article class="defect-card sev-/g) || []).length;
  assert.equal(defectCards, 1, "one grouped defect");
  assert.match(html, /Also detected by/);
});

test("site summary, per-page summaries and the report agree", () => {
  const s = site.summary;
  assert.equal(s.passed + s.failed + s.notVerified + s.automationErrors, s.total);
  assert.equal(s.total, site.executionResults.length);
  assert.equal(site.status, "FAIL");
  for (const page of site.pages) {
    const p = page.summary;
    assert.equal(p.passed + p.failed + p.notVerified + p.automationErrors, p.total, page.path);
  }
  assert.equal(site.pages.find(page => page.path === "/multi/about.html").status, "PASS");
  assert.equal(site.pages.find(page => page.path === "/multi/product-3.html").status, "FAIL");
  assert.match(html, /Site Coverage/);
  assert.match(html, /discovered URL\(s\) not scanned/);
  const total = /<div class="kpi-label">Total Tests<\/div><div class="kpi-value[^"]*">(\d+)</.exec(html)[1];
  assert.equal(Number(total), s.total);
});

test("the page limit is respected and the remaining pages are listed", async () => {
  const limited = await quiet(() => runPipeline(`${fixture.baseUrl}/multi/index.html`, { maxPages: 4, concurrency: 2 }));
  assert.equal(limited.pages.length, 4);
  assert.deepEqual(limited.crawl.viewports, ["desktop"]);
  assert.ok(limited.crawl.skippedUrls.some(item => /Page limit reached/.test(item.reason)));
  // Breadth-first with navigation links first: the start page plus header links.
  assert.deepEqual(paths(limited).slice(0, 1), ["/multi/index.html"]);
  for (const p of paths(limited).slice(1)) assert.match(p, /about|products|blog|contact/);
});

test("repeated product-grid elements are checked once: one form per shape, one link check per destination", () => {
  const basketForms = site.executionResults.filter(result => result.test.type === "form_submit" && /Add to basket/.test(result.test.name) && result.viewport === "desktop");
  assert.equal(basketForms.length, 1, basketForms.map(r => r.test.name).join(", "));
  assert.equal(basketForms[0].outcome, "PASS");
  assert.equal(basketForms[0].classification, "READY_NOT_SUBMITTED");
  assert.ok(site.skippedElements.some(item => item.kind === "form" && /2 more identical form/.test(item.reason)));

  const productOneChecks = site.executionResults.filter(result => result.test.type === "link" && result.viewport === "desktop" && /\/multi\/product-1\.html$/.test(result.test.href || ""));
  assert.equal(productOneChecks.length, 1, "image link and title link to the same product are one check");
  assert.ok(!fixture.mutatingRequests.some(request => request.path === "/api/basket"));
});

test("a bot-style 400 from another website on a direct re-request is NOT_VERIFIED, not FAIL", () => {
  const share = byName("Link works - Share this page");
  assert.equal(share.outcome, "NOT_VERIFIED", share.details);
  assert.equal(share.destinationCheck.status, 400);
});

test("hidden action links (checkout, log out) are listed as not tested, not as warnings", () => {
  assert.ok(!site.executionResults.some(result => /Checkout/.test(result.test.name)));
  assert.ok(site.skippedElements.some(item => item.label === "Checkout" && /Hidden action link/.test(item.reason)));
});

test("rate limiting (HTTP 429 + Retry-After) makes the agent pause, retry and still verify pages", async () => {
  const limited = await quiet(() => runPipeline(`${fixture.baseUrl}/limited/index.html`, { maxPages: 3 }));
  assert.ok(fixture.rateLimitedResponses.length >= 3, "the fixture did answer 429");
  assert.equal(limited.crawl.rateLimit.limited, true);
  assert.ok(limited.crawl.rateLimit.retries >= 1);
  assert.deepEqual(limited.pages.map(page => page.path).sort(), ["/limited/a.html", "/limited/b.html", "/limited/index.html"], "links were found after the start page was retried");
  for (const page of limited.pages) assert.equal(page.httpStatus, 200, `${page.path} was loaded after retrying`);
  assert.equal(limited.summary.failed, 0, "throttling never becomes a FAIL");
  assert.equal(limited.status, "PASS", JSON.stringify(limited.executionResults.filter(r => r.outcome !== "PASS").map(r => [r.test.name, r.details])));
  const html = fs.readFileSync(path.join(process.env.QA_REPORTS_DIR, "ai-qa-report.html"), "utf8");
  assert.match(html, /rate-limited this scan/);
});
