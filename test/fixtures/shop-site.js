/**
 * Generated shop fixture under /shop/ for the page finder ("Find Pages").
 * - 6 product pages that share one template (should be sampled)
 * - 4 info pages in one folder with different layouts (must NOT be grouped)
 * - a landing page that is only listed in sitemap.xml
 */

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<header class="site-header"><nav class="main-nav">
  <a href="/shop/index.html">Home</a>
  <a href="/shop/about.html">About</a>
  <a href="/shop/contact.html">Contact</a>
</nav></header>
<main>${body}</main>
<footer class="site-footer"><a href="/shop/privacy.html">Privacy</a></footer>
</body>
</html>`;
}

const PRODUCT_NAMES = ["Blue shoes", "Red bag", "Green hat", "Black coat", "White shirt", "Grey jeans"];

function productPage(index) {
  return layout(PRODUCT_NAMES[index - 1], `
    <div class="product-page">
      <div class="product-gallery"><span class="gallery-main">photo</span><span class="gallery-thumbs">thumbs</span></div>
      <div class="product-summary">
        <h1 class="product-title">${PRODUCT_NAMES[index - 1]}</h1>
        <p class="product-price">$${index * 10}</p>
        <ul class="product-specs"><li class="spec-row">Size M</li></ul>
        <div class="product-reviews"><span class="review-stars">★★★★</span></div>
      </div>
    </div>`);
}

const INFO_PAGES = {
  "shipping.html": ["Shipping", `<table class="shipping-table"><tr class="rate-row"><td class="rate-zone">Local</td><td class="rate-price">$5</td></tr></table><p class="shipping-note">Ships in 2 days.</p>`],
  "returns.html": ["Returns", `<ol class="returns-steps"><li class="returns-step">Pack it</li></ol><div class="returns-policy"><p class="policy-text">30 days.</p></div>`],
  "faq.html": ["FAQ", `<dl class="faq-list"><dt class="faq-question">Do you ship abroad?</dt><dd class="faq-answer">Yes.</dd></dl>`],
  "careers.html": ["Careers", `<section class="job-list"><article class="job-card"><h2 class="job-title">QA Engineer</h2><p class="job-location">Remote</p></article></section>`]
};

function renderShopPage(pathname) {
  if (!pathname.startsWith("/shop/")) return null;
  const name = pathname.slice("/shop/".length) || "index.html";

  if (name === "index.html") {
    return layout("Fixture Shop", `
      <h1>Fixture Shop</h1>
      <ul>${PRODUCT_NAMES.map((product, i) => `<li><a href="/shop/products/item-${i + 1}.html">${product}</a></li>`).join("")}</ul>
      <ul>${Object.entries(INFO_PAGES).map(([file, [title]]) => `<li><a href="/shop/info/${file}">${title}</a></li>`).join("")}</ul>`);
  }
  const product = /^products\/item-([1-6])\.html$/.exec(name);
  if (product) return productPage(Number(product[1]));
  const info = /^info\/(.+)$/.exec(name);
  if (info && INFO_PAGES[info[1]]) return layout(INFO_PAGES[info[1]][0], INFO_PAGES[info[1]][1]);
  if (["about.html", "contact.html", "privacy.html"].includes(name)) return layout(name.replace(".html", ""), `<p>${name}</p>`);
  if (name === "landing.html") return layout("Spring campaign", "<p>Only reachable from the sitemap.</p>");
  return null;
}

function shopSitemap(origin) {
  const urls = [
    "/shop/index.html",
    "/shop/landing.html",
    "/shop/products/item-1.html",
    "/multi/private/secret.html", // blocked by robots.txt: must be ignored
    "https://elsewhere.example/page" // another site: must be ignored
  ].map(url => (url.startsWith("http") ? url : `${origin}${url}`));
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url><loc>${url}</loc></url>`).join("\n")}
</urlset>`;
}

module.exports = { renderShopPage, shopSitemap, PRODUCT_NAMES, INFO_PAGES };
