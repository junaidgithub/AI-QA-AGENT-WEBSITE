/**
 * Local fixture website used by the integration tests.
 *
 * It reproduces, generically, the situations that previously produced wrong
 * results: constrained form fields, hidden/duplicate links, an autoplaying
 * carousel, HTTP 999 responses, lazy/SVG/broken images and side-effecting
 * buttons. Every non-GET request is recorded so tests can prove that the
 * agent never submitted a form or triggered an action.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const { renderMultiPage, ROBOTS_TXT } = require("./multi-site");
const { renderShopPage, shopSitemap } = require("./shop-site");

const SITE_DIR = path.join(__dirname, "site");

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function startFixtureServer(port = 0) {
  const mutatingRequests = [];
  // GET endpoints that change state; the agent must never request them.
  const sensitiveGets = [];
  const multiPageHits = [];
  const limitedHits = new Map();
  const rateLimitedResponses = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (!["GET", "HEAD"].includes(req.method)) {
      mutatingRequests.push({ method: req.method, path: url.pathname });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"ok":true}');
    }

    // Rate-limited area: the first request to each page gets "429 Too Many Requests"
    // with Retry-After: 1; later requests succeed. The agent must pause, retry and pass.
    if (url.pathname.startsWith("/limited/")) {
      const hits = (limitedHits.get(url.pathname) || 0) + 1;
      limitedHits.set(url.pathname, hits);
      if (hits === 1) {
        rateLimitedResponses.push(url.pathname);
        res.writeHead(429, { "content-type": "text/html", "retry-after": "1" });
        return res.end("<html><head><title>429 Too Many Requests</title></head><body>Slow down</body></html>");
      }
      const pages = { "/limited/index.html": ["Limited home", '<a href="/limited/a.html">Page A</a> <a href="/limited/b.html">Page B</a>'], "/limited/a.html": ["Page A", '<a href="/limited/index.html">Home</a>'], "/limited/b.html": ["Page B", '<a href="/limited/index.html">Home</a>'] };
      const page = pages[url.pathname];
      res.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      return res.end(page ? `<!doctype html><html><head><title>${page[0]}</title></head><body><h1>${page[0]}</h1>${page[1]}</body></html>` : "Not found");
    }

    if (url.pathname === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(shopSitemap(`http://127.0.0.1:${server.address().port}`));
    }

    const shop = renderShopPage(url.pathname);
    if (shop) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(shop);
    }

    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(ROBOTS_TXT);
    }

    if (url.pathname === "/multi/logout" || url.pathname.startsWith("/multi/private/")) {
      sensitiveGets.push(url.pathname + url.search);
    }
    const multi = renderMultiPage(url.pathname, url.searchParams, `http://localhost:${server.address().port}`);
    if (multi) {
      multiPageHits.push(url.pathname + url.search);
      res.writeHead(multi.status, { "content-type": multi.type });
      return res.end(multi.body);
    }

    if (url.pathname === "/account/logout" || url.pathname === "/results") {
      sensitiveGets.push(url.pathname + url.search);
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html><head><title>Done</title></head><body>State changed</body></html>");
    }

    if (url.pathname === "/__mutating-requests") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(mutatingRequests));
    }

    if (url.pathname === "/bot-999") {
      res.writeHead(999, { "content-type": "text/html" });
      return res.end("<html><head><title>Request denied</title></head><body>Denied</body></html>");
    }

    // Mimics social networks that reject non-browser requests: only a real
    // top-level browser navigation (Sec-Fetch-Mode: navigate) gets the page.
    if (url.pathname === "/social-profile") {
      const isBrowserNavigation = req.headers["sec-fetch-mode"] === "navigate";
      res.writeHead(isBrowserNavigation ? 200 : 400, { "content-type": "text/html" });
      return res.end(isBrowserNavigation ? "<html><head><title>Social profile</title></head><body>Profile</body></html>" : "Bad request");
    }

    if (url.pathname === "/server-error") {
      res.writeHead(500, { "content-type": "text/html" });
      return res.end("<html><head><title>Error</title></head><body>Internal error</body></html>");
    }

    if (url.pathname.startsWith("/img/ok") && url.pathname.endsWith(".png")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }

    if (url.pathname === "/img/slow-ok.png") {
      // Valid PNG delivered slower than the agent's 8 s decode timeout.
      return setTimeout(() => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG);
      }, 9500);
    }

    if (url.pathname === "/img/not-an-image.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end("this is not image data");
    }

    const file = path.normalize(path.join(SITE_DIR, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(SITE_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<html><head><title>Not Found</title></head><body>404</body></html>");
    }

    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise(resolve => {
    server.listen(port, "127.0.0.1", () => {
      const { port: actualPort } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${actualPort}`,
        mutatingRequests,
        sensitiveGets,
        multiPageHits,
        rateLimitedResponses,
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

if (require.main === module) {
  startFixtureServer(Number(process.env.PORT) || 4321).then(({ baseUrl }) => {
    console.log(`Fixture site running at ${baseUrl}`);
  });
}

module.exports = { startFixtureServer };
