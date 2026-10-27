const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSitemapXml, groupPages, smartSample, estimateMinutes, sectionOf, similarity } = require("../../agent/site-map");

const productLayout = ["product-page", "product-gallery", "gallery-main", "gallery-thumbs", "product-summary", "product-title", "product-price", "product-specs", "spec-row", "product-reviews", "review-stars", "add-to-cart"];
const page = (path, extra = {}) => ({ url: `https://shop.test${path}`, path, depth: 1, ...extra });

test("sitemap parsing reads <loc> entries and recognises sitemap indexes", () => {
  const urlset = parseSitemapXml(`<urlset><url><loc> https://a.test/x?y=1&amp;z=2 </loc></url><url><loc>https://a.test/b</loc></url></urlset>`);
  assert.equal(urlset.isIndex, false);
  assert.deepEqual(urlset.urls, ["https://a.test/x?y=1&z=2", "https://a.test/b"]);
  const index = parseSitemapXml(`<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>`);
  assert.equal(index.isIndex, true);
  assert.deepEqual(index.urls, ["https://a.test/s1.xml"]);
});

test("sections use the top-level folder; a folder shared by every page is skipped", () => {
  assert.equal(sectionOf("https://a.test/store/blue-shoes"), "store");
  assert.equal(sectionOf("https://a.test/about"), "Main pages");
  assert.equal(sectionOf("https://a.test/books/x/index.html"), "books", "/books/x/index.html is the page /books/x/");
  assert.equal(sectionOf("https://a.test/books/index.html"), "Main pages");
  const pages = [page("/en/"), page("/en/about"), page("/en/store/a"), page("/en/store/b")];
  groupPages(pages);
  assert.deepEqual(pages.map(p => p.section), ["Main pages", "Main pages", "store", "store"]);
});

test("same folder + same layout = template; same folder + different layouts = unique pages", () => {
  const products = [1, 2, 3, 4, 5].map(n => page(`/store/item-${n}`, { layout: [...productLayout, `variant-${n}`] }));
  const info = ["a", "b", "c", "d"].map((name, i) => page(`/info/${name}`, { layout: [`${name}-1`, `${name}-2`, `${name}-3`, `shared-${i % 2}`] }));
  const pages = [page("/", { depth: 0 }), ...products, ...info];
  const sections = groupPages(pages);
  assert.ok(products.every(p => p.template === "/store/*"));
  assert.ok(info.every(p => p.template === null), "different layouts must not be grouped");
  assert.deepEqual(sections.find(s => s.name === "store").templates, [{ pattern: "/store/*", count: 5 }]);
});

test("navigation pages and small folders are never treated as templates", () => {
  const navPages = [1, 2, 3, 4].map(n => page(`/team/member-${n}`, { layout: productLayout, navLinked: true }));
  const small = [1, 2, 3].map(n => page(`/blog/post-${n}`, { layout: productLayout }));
  groupPages([...navPages, ...small]);
  assert.ok([...navPages, ...small].every(p => p.template === null));
  assert.equal(similarity(["a", "b"], ["a", "b"]), 0, "too few classes is not evidence");
});

test("smart sample keeps every unique page and two examples per template, in order", () => {
  const pages = [
    page("/", { template: null }),
    ...[1, 2, 3, 4, 5].map(n => page(`/store/item-${n}`, { template: "/store/*" })),
    page("/about", { template: null })
  ];
  assert.deepEqual(smartSample(pages).map(url => new URL(url).pathname), ["/", "/store/item-1", "/store/item-2", "/about"]);
});

test("time estimates grow with pages and with mobile", () => {
  const desktop = estimateMinutes(25, false);
  const both = estimateMinutes(25, true);
  assert.ok(desktop.low <= desktop.high && both.low <= both.high);
  assert.ok(both.high > desktop.high);
  assert.ok(estimateMinutes(100, true).high > both.high);
  assert.ok(estimateMinutes(1, false).low >= 1);
});

test("a large catalogue linked from the navigation can still be a template", () => {
  const catalogue = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => page(`/store/item-${n}`, { layout: [...productLayout, `variant-${n}`], navLinked: true }));
  groupPages(catalogue);
  assert.ok(catalogue.every(p => p.template === "/store/*"));
});
