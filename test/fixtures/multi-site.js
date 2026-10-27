/**
 * Generated multi-page fixture site under /multi/ for crawler tests.
 * Every page shares a header (with a mobile hamburger menu) and a footer
 * (with the same newsletter form), like most real sites.
 */

const STYLE = `
  body { font-family: Arial, sans-serif; margin: 0; }
  header { display: flex; justify-content: space-between; padding: 12px; background: #eef; }
  .nav-links { display: flex; gap: 12px; }
  .menu-toggle { display: none; }
  main { padding: 16px; }
  footer { padding: 16px; background: #f4f4f4; }
  @media (max-width: 767px) {
    .menu-toggle { display: inline-block; }
    .nav-links { display: none; flex-direction: column; }
    .nav-links.open { display: flex; }
  }
`;

const SCRIPT = `
  const toggle = document.querySelector(".menu-toggle");
  toggle.addEventListener("click", () => {
    const links = document.getElementById("primary-nav");
    links.classList.toggle("open");
    toggle.setAttribute("aria-expanded", links.classList.contains("open") ? "true" : "false");
  });
`;

function layout(title, body, externalOrigin) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head>
<body>
<header>
  <a href="/multi/index.html" aria-label="Multi home">Logo</a>
  <button class="menu-toggle" aria-expanded="false" aria-controls="primary-nav" aria-label="Open menu">☰</button>
  <nav class="nav-links" id="primary-nav">
    <a href="/multi/index.html">Home</a>
    <a href="/multi/about.html">About</a>
    <a href="/multi/products.html">Products</a>
    <a href="/multi/blog.html">Blog</a>
    <a href="/multi/contact.html">Contact</a>
  </nav>
</header>
<main>
<h1>${title}</h1>
${body}
</main>
<footer>
  <a href="/multi/privacy.html">Privacy</a>
  <a href="/multi/terms.html">Terms</a>
  <a href="${externalOrigin}/about.html">Partner site</a>
  <form class="newsletter" action="/api/newsletter" method="post">
    <label>Newsletter email <input type="email" name="newsletter_email" required></label>
    <button type="submit">Subscribe</button>
  </form>
</footer>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const PAGES = {
  "index.html": ["Multi Home", `
    <p><a href="/multi/products.html">Browse products</a></p>
    <p><a href="/multi/about.html?utm_source=newsletter">About (tracked link)</a> · <a href="/multi/about.html#team">Our team</a></p>
    <p><a href="/multi/brochure.pdf">Brochure (PDF)</a></p>
    <p><a href="/multi/logout">Log out</a></p>
    <p><a href="/multi/private/secret.html">Internal notes</a></p>
    <p><a href="/multi/calendar?month=1">Events calendar</a></p>
    <p><a href="\${EXTERNAL}/social-profile" onclick="return false">Share this page</a></p>
    <p><a href="/multi/checkout" style="display:none">Checkout</a></p>`],
  "about.html": ["About Multi", `<p id="team">We are a fixture.</p>`],
  "products.html": ["Products", [1, 2, 3].map(n => `
    <article class="product">
      <a href="/multi/product-${n}.html"><img src="/img/ok-product-${n}.png" alt="Product ${["one", "two", "three"][n - 1]} photo" width="20" height="20"></a>
      <a href="/multi/product-${n}.html">Product ${["one", "two", "three"][n - 1]}</a>
      <form action="/api/basket" method="post"><input type="hidden" name="sku" value="${n}"><button type="submit">Add to basket</button></form>
    </article>`).join("")],
  "product-1.html": ["Product one", "<p>Details.</p>"],
  "product-2.html": ["Product two", "<p>Details.</p>"],
  "product-3.html": ["Product three", `<p><a href="/multi/missing-spec.html">Spec sheet</a></p>`],
  "blog.html": ["Blog", `<p><a href="/multi/post-1.html">First post</a> · <a href="/multi/blog.html?page=2">Older posts</a></p>`],
  "post-1.html": ["Post one", `<p><a href="/multi/post-2.html">Next post</a></p>`],
  "post-2.html": ["Post two", `<p><a href="/multi/post-3.html">Next post</a></p>`],
  "post-3.html": ["Post three", "<p>Deep page.</p>"],
  "contact.html": ["Contact", `
    <form id="contact" action="/api/contact" method="post">
      <label>Your name <input name="name" required></label>
      <label>Your email <input type="email" name="email" required></label>
      <button type="submit">Send</button>
    </form>`],
  "privacy.html": ["Privacy", "<p>Privacy policy.</p>"],
  "terms.html": ["Terms", "<p>Terms of use.</p>"],
  "private/secret.html": ["Secret", "<p>Should never be crawled.</p>"]
};

/** Returns { status, type, body } for /multi/* paths, or null when not handled. */
function renderMultiPage(pathname, searchParams, externalOrigin) {
  if (!pathname.startsWith("/multi/")) return null;
  const name = pathname.slice("/multi/".length);

  if (name === "calendar") {
    // Crawler trap: every month links to the next ones, forever.
    const month = Number(searchParams.get("month")) || 1;
    const body = `<p>Month ${month}</p><p><a href="/multi/calendar?month=${month + 1}">Next month</a> · <a href="/multi/calendar?month=${month + 2}">In two months</a></p>`;
    return { status: 200, type: "text/html; charset=utf-8", body: layout(`Calendar ${month}`, body, externalOrigin) };
  }
  if (name === "brochure.pdf") return { status: 200, type: "application/pdf", body: "%PDF-1.4 fixture" };

  const pageName = name === "" ? "index.html" : name;
  const page = PAGES[pageName] || (searchParams && PAGES[pageName.split("?")[0]]);
  if (!page) return null;
  return { status: 200, type: "text/html; charset=utf-8", body: layout(page[0], page[1].split("${EXTERNAL}").join(externalOrigin), externalOrigin) };
}

const ROBOTS_TXT = "User-agent: *\nDisallow: /multi/private/\n";

module.exports = { renderMultiPage, ROBOTS_TXT };
