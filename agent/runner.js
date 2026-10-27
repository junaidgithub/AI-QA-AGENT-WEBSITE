const fs = require("fs");
const path = require("path");
const { reportsDir: getReportsDir } = require("./paths");
const { launchBrowser, newQaContext } = require("./browser");
const { DESKTOP } = require("./viewports");
const { ensureDomHelpers } = require("./dom-helpers");

const NON_FILLABLE_INPUT_TYPES = ["hidden", "submit", "button", "reset", "image"];

/**
 * Collect page structure. Runs inside the browser; relies on window.__qa
 * from dom-helpers.js. Field names used by earlier versions are preserved
 * (title, url, links, buttons, inputs, images, imageCount, brokenImages,
 * forms as a count, headings, viewport); new fields are additive.
 */
function collectDiscovery(nonFillableTypes) {
  const qa = window.__qa;
  const forms = [...document.forms];

  const isSubmitControl = el => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || (tag === "button" ? "submit" : "")).toLowerCase();
    return (tag === "button" && type === "submit") || (tag === "input" && (type === "submit" || type === "image"));
  };

  const buttonTypeOf = el => {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return (el.getAttribute("type") || "").toLowerCase();
    if (tag === "button") return (el.getAttribute("type") || "submit").toLowerCase();
    return "button";
  };

  // Controls inside cookie/consent banners record a consent choice; they are not site features to test.
  const consentContainers = "[class*=cookie], [id*=cookie], [class*=consent], [id*=consent], [class*=gdpr], [id*=gdpr], [class*=cmplz], [id*=cmplz], .cc-window, [aria-label*=cookie i]";
  const inConsentBanner = el => {
    const container = el.closest(consentContainers);
    return Boolean(container) && container !== document.body && container !== document.documentElement;
  };

  const links = [...document.querySelectorAll("a[href]")]
    .map((a, domIndex) => {
      const hiddenReason = qa.hiddenReason(a);
      return {
        text: qa.elementName(a).slice(0, 120),
        href: a.href,
        rawHref: a.getAttribute("href"),
        target: a.getAttribute("target") || null,
        rel: a.getAttribute("rel") || null,
        id: a.id || null,
        ariaLabel: a.getAttribute("aria-label") || null,
        title: a.getAttribute("title") || null,
        visible: !hiddenReason,
        hiddenReason,
        domIndex,
        inConsentBanner: inConsentBanner(a),
        selector: qa.cssPath(a)
      };
    })
    .filter(link => link.href)
    .slice(0, 100);

  const buttons = [...document.querySelectorAll("button, input[type=button], input[type=submit], input[type=reset], input[type=image]")]
    .map(b => {
      const hiddenReason = qa.hiddenReason(b);
      const formIndex = qa.formIndexOf(b);
      return {
        text: qa.elementName(b).slice(0, 120),
        // `type` historically held the tag name; kept for compatibility.
        type: b.tagName.toLowerCase(),
        buttonType: buttonTypeOf(b),
        isSubmit: formIndex >= 0 && isSubmitControl(b),
        inForm: formIndex >= 0,
        formIndex,
        id: b.id || null,
        ariaLabel: b.getAttribute("aria-label") || null,
        title: b.getAttribute("title") || null,
        disabled: Boolean(b.disabled) || b.getAttribute("aria-disabled") === "true",
        visible: !hiddenReason,
        hiddenReason,
        inConsentBanner: inConsentBanner(b),
        selector: qa.cssPath(b)
      };
    })
    .slice(0, 100);

  const inputs = [...document.querySelectorAll("input, textarea, select")]
    .map(x => {
      const hiddenReason = qa.hiddenReason(x);
      const type = (x.type || "").toLowerCase();
      return {
        tag: x.tagName.toLowerCase(),
        type: x.type || null,
        name: x.name || null,
        placeholder: x.placeholder || null,
        id: x.id || null,
        ariaLabel: x.getAttribute("aria-label") || null,
        label: qa.labelText(x) || null,
        required: Boolean(x.required) || x.getAttribute("aria-required") === "true",
        disabled: Boolean(x.disabled),
        fillable: !nonFillableTypes.includes(type),
        inForm: qa.formIndexOf(x) >= 0,
        formIndex: qa.formIndexOf(x),
        visible: !hiddenReason,
        hiddenReason,
        selector: qa.cssPath(x)
      };
    })
    .slice(0, 100);

  const formDetails = forms.map((form, index) => {
    const hiddenReason = qa.hiddenReason(form);
    const controls = [...form.querySelectorAll("input, textarea, select")];
    const fillable = controls.filter(c => !c.disabled && !nonFillableTypes.includes((c.type || "").toLowerCase()));
    const submitControls = [...form.querySelectorAll("button, input[type=submit], input[type=image]")]
      .filter(isSubmitControl)
      .map(control => ({
        text: qa.elementName(control).slice(0, 120),
        selector: qa.cssPath(control),
        visible: !qa.hiddenReason(control)
      }));
    return {
      index,
      id: form.id || null,
      name: form.getAttribute("name") || null,
      action: form.getAttribute("action") || null,
      method: (form.getAttribute("method") || "get").toLowerCase(),
      role: form.getAttribute("role") || null,
      ariaLabel: form.getAttribute("aria-label") || null,
      visible: !hiddenReason,
      hiddenReason,
      controlCount: controls.length,
      fillableControlCount: fillable.length,
      visibleFillableControlCount: fillable.filter(c => !qa.hiddenReason(c)).length,
      submitControls,
      fieldNames: fillable.map(c => (c.name || c.id || c.type || "").toLowerCase()).sort(),
      selector: qa.cssPath(form)
    };
  });

  const images = [...document.images]
    .map((img, index) => ({
      index: index + 1,
      src: img.currentSrc || img.src || img.getAttribute("src") || "",
      alt: img.getAttribute("alt") || "",
      width: img.naturalWidth,
      height: img.naturalHeight,
      loading: img.getAttribute("loading") || null,
      visible: !qa.hiddenReason(img),
      loaded: img.complete && img.naturalWidth > 0 && img.naturalHeight > 0
    }))
    .slice(0, 200);

  // Every link on the page (not capped at 100) for the site crawler.
  const regionOf = anchor => anchor.closest("nav, header, [role=navigation]") ? "nav" : anchor.closest("footer, [role=contentinfo]") ? "footer" : "content";
  const crawlLinks = [...document.querySelectorAll("a[href]")]
    .filter(anchor => /^https?:/i.test(anchor.href))
    .slice(0, 1000)
    .map(anchor => ({
      href: anchor.href,
      text: qa.elementName(anchor).slice(0, 80),
      region: regionOf(anchor),
      nofollow: /\bnofollow\b/i.test(anchor.getAttribute("rel") || "")
    }));

  // Mobile menu: a visible toggle that controls hidden navigation links.
  const navLinks = [...document.querySelectorAll("nav a[href], header a[href], [role=navigation] a[href]")];
  const hiddenNavLinkCount = navLinks.filter(anchor => qa.hiddenReason(anchor)).length;
  const toggleCandidates = [...document.querySelectorAll("button, [role=button], a[href='#'], a:not([href]), [aria-controls], [aria-expanded]")]
    .filter(el => !qa.hiddenReason(el))
    .map(el => {
      const text = [el.getAttribute("aria-label"), el.getAttribute("title"), el.id, typeof el.className === "string" ? el.className : "", el.innerText].join(" ").toLowerCase();
      const menuWording = /menu|hamburger|burger|navbar-toggle|nav-toggle|navigation/.test(text);
      const inHeader = Boolean(el.closest("nav, header, [role=navigation], [role=banner]"));
      const disclosure = el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls");
      // Long visible text means a content control (FAQ question, accordion), not a menu icon.
      const shortLabel = (el.innerText || "").trim().length <= 30;
      let score = 0;
      if (menuWording) score += 3;
      if (inHeader) score += 2;
      if (el.hasAttribute("aria-expanded")) score += 1;
      if (el.hasAttribute("aria-controls")) score += 1;
      // Without menu wording, only an icon-style button (no real text) in the header counts:
      // "Accessories [+]" is a sub-menu expander, not the main menu toggle.
      const iconOnly = (el.innerText || "").replace(/[^\p{L}\p{N}]/gu, "").length <= 1;
      const eligible = shortLabel && (menuWording || (inHeader && disclosure && iconOnly));
      return { el, score: eligible ? score : 0 };
    })
    .filter(candidate => candidate.score >= 3)
    .sort((a, b) => b.score - a.score);
  const toggle = toggleCandidates[0]?.el;
  const menuToggle = toggle ? {
    text: qa.elementName(toggle).slice(0, 80) || "Menu",
    selector: qa.cssPath(toggle),
    ariaExpanded: toggle.getAttribute("aria-expanded")
  } : null;

  // Layout fingerprint: the CSS classes used on the page. Pages built from the same template
  // (e.g. product pages) share almost all of them; different kinds of pages do not.
  // Header, navigation and footer are shared by every page, and cookie/consent popups and dialogs
  // come and go with timing, so only the main content counts. Digits are normalised
  // ("ec_title_5_1" -> "ec_title_#_#") because item-specific numbers do not change the layout.
  const notContent = "header, nav, footer, [role=banner], [role=navigation], [role=contentinfo], [role=dialog], [aria-modal=true], " +
    "[class*=cookie], [id*=cookie], [class*=consent], [id*=consent], [class*=gdpr], [id*=gdpr], [class*=cmplz], [id*=cmplz], .cc-window";
  const layoutClasses = [...new Set([...document.body.querySelectorAll("[class]")]
    .filter(el => {
      // Plugins often put classes such as "cmplz-..." on <body> itself; only containers below it count.
      const container = el.closest(notContent);
      return !container || container === document.body || container === document.documentElement;
    })
    .flatMap(el => (typeof el.className === "string" ? el.className.split(/\s+/) : []))
    .filter(name => name && name.length < 60)
    .map(name => name.replace(/\d+/g, "#")))].slice(0, 800);

  return {
    title: document.title,
    url: location.href,
    links,
    crawlLinks,
    layoutClasses,
    hiddenNavLinkCount,
    menuToggle,
    hiddenLinkCount: links.filter(link => !link.visible).length,
    buttons,
    inputs,
    images,
    imageCount: document.images.length,
    // Images not yet rendered at discovery time (may simply be lazy-loaded);
    // the broken-image test makes the actual determination.
    brokenImages: [...document.images].filter(img => !img.complete || img.naturalWidth === 0).length,
    forms: forms.length,
    formDetails,
    headings: [...document.querySelectorAll("h1,h2,h3")]
      .map(x => x.innerText.trim())
      .filter(Boolean)
      .slice(0, 30),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    }
  };
}

/**
 * Load one page in a fresh context and collect its discovery data.
 * options.viewport: DESKTOP (default) or MOBILE; options.screenshotPath /
 * options.failureScreenshotPath: optional full-page screenshots.
 */
async function discoverPage(browser, url, options = {}) {
  const viewport = options.viewport || DESKTOP;
  const context = await newQaContext(browser, viewport);
  const page = await context.newPage();
  if (options.quick) {
    // The page finder only needs links: skip images, media and fonts to load pages faster.
    await page.route("**/*", route => (["image", "media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  }
  const consoleErrors = [];
  const networkErrors = [];
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", request => {
    networkErrors.push({ url: request.url(), failure: request.failure()?.errorText || "Unknown network failure" });
  });

  const startedMs = Date.now();
  const outcome = { status: "PASS", error: null, httpStatus: null, finalUrl: url, contentType: null, discovery: {}, consoleErrors, networkErrors };

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    outcome.httpStatus = response ? response.status() : null;
    outcome.retryAfter = response ? response.headers()["retry-after"] || null : null;
    outcome.contentType = response ? (response.headers()["content-type"] || null) : null;
    outcome.finalUrl = page.url();

    // options.quick (page finder): shorter waits; links rendered by scripts usually appear within ~1.5 s.
    await page.waitForLoadState("networkidle", { timeout: options.quick ? 1500 : 3000 }).catch(() => {});
    if (!options.quick) await page.waitForTimeout(500);

    await ensureDomHelpers(page);
    outcome.discovery = await page.evaluate(collectDiscovery, NON_FILLABLE_INPUT_TYPES);
    outcome.discovery.httpStatus = outcome.httpStatus;
    outcome.discovery.browser = { name: "Chromium", version: browser.version() };
    outcome.discovery.viewportName = viewport.name;

    if (options.screenshotPath) await page.screenshot({ path: options.screenshotPath, fullPage: true }).catch(() => {});
  } catch (error) {
    outcome.status = "FAIL";
    outcome.error = error.message;
    if (options.failureScreenshotPath) await page.screenshot({ path: options.failureScreenshotPath, fullPage: true }).catch(() => {});
  } finally {
    outcome.durationMs = Date.now() - startedMs;
    await context.close().catch(() => {});
  }
  return outcome;
}

async function runQA(url) {
  const reportsDir = getReportsDir();
  fs.mkdirSync(reportsDir, { recursive: true });

  // A failure screenshot from an earlier run must never be attached to this one.
  fs.rmSync(path.join(reportsDir, "failure.png"), { force: true });

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const browser = await launchBrowser();
  let outcome;
  try {
    outcome = await discoverPage(browser, url, {
      screenshotPath: path.join(reportsDir, "homepage.png"),
      failureScreenshotPath: path.join(reportsDir, "failure.png")
    });
  } finally {
    await browser.close();
  }
  const { status, error, httpStatus, discovery, consoleErrors, networkErrors } = outcome;

  const result = {
    startedAt,

    finishedAt:
      new Date().toISOString(),

    durationMs:
      Date.now() - startedMs,

    target: url,

    status,

    error,

    httpStatus,

    discovery,

    consoleErrors,

    networkErrors,

    evidence: {
      screenshot:
        "reports/homepage.png or reports/failure.png"
    },

    note:
      "This is the deterministic MVP. AI reasoning/test generation is intentionally the next layer."
  };

  fs.writeFileSync(
    path.join(
      reportsDir,
      "report.json"
    ),
    JSON.stringify(
      result,
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(
      reportsDir,
      "report.html"
    ),
    createHtmlReport(result)
  );

  // `raw` lets the site pipeline reuse this page load instead of loading the start page twice.
  return { ...result, raw: outcome };
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function createHtmlReport(r) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>AI QA Agent Report</title>

<style>
body{
  font-family:Arial,sans-serif;
  max-width:1100px;
  margin:40px auto;
  padding:0 20px;
  line-height:1.5
}

.card{
  border:1px solid #ddd;
  border-radius:10px;
  padding:18px;
  margin:16px 0
}

.pass{
  color:green
}

.fail{
  color:#b00020
}

code,pre{
  background:#f5f5f5;
  padding:3px
}

pre{
  padding:12px;
  overflow:auto
}
</style>

</head>

<body>

<h1>AI QA Agent Report</h1>

<div class="card">

<b>Status:</b>

<span class="${
    r.status === "PASS"
      ? "pass"
      : "fail"
  }">

${esc(r.status)}

</span>

<br>

<b>Target:</b>
${esc(r.target)}

<br>

<b>Started:</b>
${esc(r.startedAt)}

<br>

<b>Finished:</b>
${esc(r.finishedAt)}

</div>

<div class="card">

<h2>Discovery</h2>

<pre>${esc(
    JSON.stringify(
      r.discovery,
      null,
      2
    )
  )}</pre>

</div>

<div class="card">

<h2>Console Errors</h2>

<pre>${esc(
    JSON.stringify(
      r.consoleErrors,
      null,
      2
    )
  )}</pre>

</div>

<div class="card">

<h2>Network Errors</h2>

<pre>${esc(
    JSON.stringify(
      r.networkErrors,
      null,
      2
    )
  )}</pre>

</div>

<div class="card">

<h2>Error</h2>

<pre>${esc(
    r.error || "None"
  )}</pre>

</div>

</body>
</html>`;
}

if (require.main === module) {
  const url = process.argv[2];

  if (!url) {
    console.error(
      "Usage: npm run qa -- https://example.com"
    );

    process.exit(1);
  }

  runQA(url)
    .then(r =>
      console.log(
        JSON.stringify(
          r,
          null,
          2
        )
      )
    )
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { runQA, discoverPage };