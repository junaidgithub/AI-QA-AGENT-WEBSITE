/**
 * "Find Pages" regression tests: page finder on the /shop/ fixture, scanning
 * only the pages the user selected, and the HTTP API for both.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.QA_REPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qa-agent-find-"));

const { startFixtureServer } = require("../fixtures/server");
const { mapSite } = require("../../agent/site-map");
const { runPipeline } = require("../../agent/ai-qa-pipeine");
const { app } = require("../../server");

let fixture;
let map;
let server;
let base;

function quiet(fn) {
  const original = console.log;
  console.log = () => {};
  return fn().finally(() => { console.log = original; });
}

const pathsOf = urls => urls.map(url => new URL(url).pathname);

test.before(async () => {
  fixture = await startFixtureServer();
  map = await mapSite(`${fixture.baseUrl}/shop/index.html`);
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await fixture.close();
});

test("finds linked pages and sitemap-only pages, applying the usual skip rules", () => {
  const found = pathsOf(map.pages.map(page => page.url));
  assert.equal(map.totalFound, 15);
  assert.ok(found.includes("/shop/landing.html"), "a page only listed in sitemap.xml is found");
  assert.equal(map.pages.find(page => page.path === "/shop/landing.html").source, "sitemap");
  assert.ok(!found.some(p => p.startsWith("/multi/private/")), "robots.txt-blocked sitemap entries are ignored");
  assert.equal(map.capped, false);
  assert.equal(found[0], "/shop/index.html", "the start page comes first");
  assert.ok(map.durationMs < 60000, "finding pages is quick");
});

test("groups sections and detects the shared product template", () => {
  const sections = Object.fromEntries(map.sections.map(section => [section.name, section]));
  assert.equal(sections.products.count, 6);
  assert.deepEqual(sections.products.templates, [{ pattern: "/shop/products/*", count: 6 }]);
  assert.equal(sections.info.count, 4);
  assert.deepEqual(sections.info.templates, [], "info pages share a folder but not a layout");
});

test("smart sample = unique pages + 2 product examples; estimates are provided", () => {
  const sample = pathsOf(map.smartSample);
  assert.equal(sample.length, 11);
  assert.equal(sample.filter(p => p.startsWith("/shop/products/")).length, 2);
  assert.equal(sample.filter(p => p.startsWith("/shop/info/")).length, 4);
  assert.ok(map.estimates.smartSample.desktopAndMobile.high >= map.estimates.smartSample.desktop.high);
  assert.ok(map.estimates.all.desktop.high >= map.estimates.smartSample.desktop.high);
});

test("a scan of selected pages tests exactly those pages and lists the rest as not selected", async () => {
  const selected = [`${fixture.baseUrl}/shop/index.html`, `${fixture.baseUrl}/shop/products/item-1.html`, `${fixture.baseUrl}/shop/info/faq.html`];
  const notSelected = map.pages.map(page => page.url).filter(url => !selected.includes(url));
  const run = await quiet(() => runPipeline(`${fixture.baseUrl}/shop/index.html`, { pages: selected, notSelected, pagesFound: map.totalFound }));
  assert.equal(run.crawl.mode, "selected");
  assert.equal(run.crawl.pagesFound, 15);
  assert.deepEqual(run.pages.map(page => page.path).sort(), ["/shop/index.html", "/shop/info/faq.html", "/shop/products/item-1.html"]);
  assert.equal(run.crawl.skippedUrls.filter(item => /not selected/.test(item.reason)).length, notSelected.length);
  assert.ok(!run.pages.some(page => page.path === "/shop/about.html"), "no crawling beyond the selection");
  const s = run.summary;
  assert.equal(s.passed + s.failed + s.notVerified + s.automationErrors, s.total);
  const html = fs.readFileSync(path.join(process.env.QA_REPORTS_DIR, "ai-qa-report.html"), "utf8");
  assert.match(html, /chosen by you from 15 found by Find Pages/);
});

test("API: /api/map returns the page map; /api/run validates the selected pages", async () => {
  const post = (route, body) => fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await post("/api/map", {})).status, 400);
  const mapped = await quiet(async () => (await post("/api/map", { url: `${fixture.baseUrl}/shop/index.html` })).json());
  assert.equal(mapped.totalFound, 15);

  const shop = `${fixture.baseUrl}/shop/index.html`;
  assert.equal((await post("/api/run", { url: shop, pages: [] })).status, 400);
  assert.equal((await post("/api/run", { url: shop, pages: ["https://elsewhere.example/x"] })).status, 400, "pages must be on the same site");
  assert.equal((await post("/api/run", { url: shop, pages: ["not a url"] })).status, 400);
  assert.equal((await post("/api/run", { url: shop, pages: [shop], maxMinutes: 500 })).status, 400);
});
