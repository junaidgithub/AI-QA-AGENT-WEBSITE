const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCrawlUrl, isSameSite, crawlSkipReason, parseRobots, isAllowedByRobots, pathKey } = require("../../agent/crawl-rules");
const { resolveOptions, parseCliArgs, siteKey } = require("../../agent/ai-qa-pipeine");
const { planTestsWithNotes } = require("../../agent/ai-test-planner");

const BASE = "https://www.site.test/";

test("URL normalisation removes fragments, tracking parameters and trailing slashes", () => {
  assert.equal(normalizeCrawlUrl("https://Site.test/about/#team"), "https://site.test/about");
  assert.equal(normalizeCrawlUrl("https://site.test/about?utm_source=x&gclid=1"), "https://site.test/about");
  assert.equal(normalizeCrawlUrl("https://site.test/list?b=2&a=1"), "https://site.test/list?a=1&b=2");
  assert.equal(normalizeCrawlUrl("https://site.test/"), "https://site.test/");
  assert.equal(normalizeCrawlUrl("not a url"), null);
  assert.equal(pathKey("https://www.site.test/cal?m=1"), "site.test/cal");
});

test("www and the bare domain are the same site; other hosts are external", () => {
  assert.ok(isSameSite("https://site.test/a", BASE));
  assert.ok(isSameSite("http://www.site.test/b", BASE));
  assert.ok(!isSameSite("https://blog.other.test/", BASE));
  assert.ok(!isSameSite("https://site.test.evil.test/", BASE));
});

test("crawler skips external sites, files, login/admin/cart areas and state-changing links", () => {
  assert.equal(crawlSkipReason("https://site.test/products", BASE), null);
  assert.match(crawlSkipReason("https://facebook.com/x", BASE), /External site/);
  assert.match(crawlSkipReason("https://site.test/brochure.pdf", BASE), /File download/);
  assert.match(crawlSkipReason("https://site.test/wp-admin/", BASE), /Login, admin/);
  assert.match(crawlSkipReason("https://site.test/account/orders", BASE), /Login, admin/);
  assert.match(crawlSkipReason("https://site.test/cart", BASE), /Login, admin/);
  assert.match(crawlSkipReason("https://site.test/newsletter/unsubscribe?id=1", BASE), /state-changing/);
  assert.equal(crawlSkipReason("https://site.test/delete-my-account-info", BASE, "Data deletion policy"), null, "only whole path segments count as restricted");
  assert.match(crawlSkipReason("mailto:a@b.test", BASE), /Not a web page/);
});

test("robots.txt: our group or *, longest match wins, Allow wins ties, wildcards and $", () => {
  const robots = parseRobots(`
User-agent: googlebot
Disallow: /

User-agent: *
Disallow: /private/
Allow: /private/public-page
Disallow: /*.json$
Disallow:
`);
  assert.ok(isAllowedByRobots(robots, "https://site.test/products"));
  assert.ok(!isAllowedByRobots(robots, "https://site.test/private/notes"));
  assert.ok(isAllowedByRobots(robots, "https://site.test/private/public-page"));
  assert.ok(!isAllowedByRobots(robots, "https://site.test/data/feed.json"));
  assert.ok(isAllowedByRobots(robots, "https://site.test/data/feed.json?x=1"));

  const specific = parseRobots("User-agent: ai-qa-agent\nDisallow: /beta\n\nUser-agent: *\nDisallow: /\n", "ai-qa-agent");
  assert.ok(isAllowedByRobots(specific, "https://site.test/"), "our own group replaces the * group");
  assert.ok(!isAllowedByRobots(specific, "https://site.test/beta/x"));
  assert.ok(isAllowedByRobots(parseRobots(""), "https://site.test/anything"));
});

test("scan options: the default stays a single desktop page; limits are clamped", () => {
  const defaults = resolveOptions({});
  assert.equal(defaults.maxPages, 1);
  assert.equal(defaults.mobile, false);
  assert.equal(resolveOptions({ maxPages: 25, singlePage: true }).maxPages, 1);
  assert.equal(resolveOptions({ maxPages: 5000 }).maxPages, 200);
  assert.equal(resolveOptions({ concurrency: 0 }).concurrency, 1);
  assert.deepEqual(parseCliArgs(["https://x.test", "--site"]), { url: "https://x.test", options: { maxPages: 25, mobile: true } });
  assert.deepEqual(parseCliArgs(["--pages=10", "--depth=2", "https://x.test"]).options, { maxPages: 10, maxDepth: 2 });
});

test("site keys make shared header/footer checks run once, but keep page-specific checks per page", () => {
  const link = { type: "link", href: "https://site.test/about#team", text: "About", expectedHidden: false };
  assert.equal(siteKey(link, "desktop", "https://site.test/a"), siteKey({ ...link, href: "https://site.test/about" }, "desktop", "https://site.test/b"));
  assert.notEqual(siteKey(link, "desktop", "x"), siteKey(link, "mobile", "x"), "desktop and mobile are separate checks");
  const pageLoad = { type: "page_load", name: "Page loads" };
  assert.notEqual(siteKey(pageLoad, "desktop", "https://site.test/a"), siteKey(pageLoad, "desktop", "https://site.test/b"));
  const form = { type: "form_submit", text: "Subscribe", fieldSignature: "newsletter_email", formIndex: 0 };
  assert.equal(siteKey(form, "desktop", "https://site.test/a"), siteKey({ ...form, formIndex: 2 }, "desktop", "https://site.test/b"));
});

test("mobile planning: hidden links are left to the desktop run and the hamburger menu is tested", () => {
  const discovery = {
    title: "Home",
    url: "https://site.test/",
    links: [
      { text: "About", href: "https://site.test/about", visible: false, hiddenReason: "inside a container with display:none", selector: "nav > a" },
      { text: "Logo", href: "https://site.test/", visible: true, selector: "header > a" }
    ],
    buttons: [{ text: "Open menu", buttonType: "button", isSubmit: false, inForm: false, visible: true, selector: "header > button" }],
    menuToggle: { text: "Open menu", selector: "header > button" },
    hiddenNavLinkCount: 1,
    inputs: [],
    forms: 0,
    formDetails: [],
    imageCount: 0
  };
  const mobile = planTestsWithNotes(discovery, { viewport: "mobile" });
  assert.ok(mobile.tests.some(t => t.type === "mobile_menu" && t.selector === "header > button"));
  assert.ok(!mobile.tests.some(t => t.type === "link" && t.text === "About"));
  assert.ok(!mobile.tests.some(t => t.type === "button"), "the menu toggle is not also a generic button test");
  assert.ok(mobile.skipped.some(s => /mobile layout/.test(s.reason)));

  const desktop = planTestsWithNotes(discovery, { viewport: "desktop" });
  assert.ok(!desktop.tests.some(t => t.type === "mobile_menu"));
  assert.ok(desktop.tests.some(t => t.type === "link" && t.text === "About" && t.expectedHidden));
});

test("in-page links keep their fragment, so #section, # and / are separate checks", () => {
  const key = (href, rawHref) => siteKey({ type: "link", href, rawHref, text: "x" }, "desktop", "https://site.test/");
  assert.notEqual(key("https://site.test/#features", "#features"), key("https://site.test/", "/"));
  assert.notEqual(key("https://site.test/", "#"), key("https://site.test/", "/"));
  assert.equal(key("https://site.test/p/1", "/p/1"), key("https://site.test/p/1/", "/p/1/"));
});
