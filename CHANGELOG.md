# Changelog

## 0.5.0 — New dashboard and report design

The dashboard and the HTML report have been redesigned. All features, data, routes, element
ids and filters are unchanged.

### Dashboard (`public/index.html`)

- Professional top bar: shield logo with tagline, centred navigation (How it works ·
  Capabilities · Safety), "Last report" and a "Start a scan" button. It gains a border and
  shadow on scroll.
- Headline: "Ship websites with confidence.", with a live-style report preview beside it, a
  trust strip (real Chromium, desktop + mobile, no data submitted, runs locally), "How it works"
  in three steps, and capability cards with SVG icons.
- The status card only appears while a scan runs.
- Hero section with a large URL bar, **Find Pages First** (primary) and **Quick Scan** buttons,
  and toggle switches for mobile view and single-page mode.
- Status card with a live timer, step indicator (Find pages → Test → Report), progress bar and
  progress text.
- Find Pages panel with stat tiles, section bars, "pages share one layout" tags, choice cards and
  a live time estimate.
- Result card with a pass-rate ring, KPI tiles and report buttons.
- Feature cards explaining what the agent checks.
- Dark mode (follows the system setting) and a phone layout.

### Report (`agent/report-generator.js`)

- Sticky top bar with section navigation and counts (Defects, Verification…).
- Hero with a pass-rate score ring, status badge and run chips.
- Colour-accented KPI tiles and a stacked **outcome distribution** bar.
- Defect cards with a colour stripe by severity, plus a defect/failed-check count.
- Cleaner tables with sticky headers, dark mode, a phone layout and print styles.
- Terminal colour codes from browser logs (e.g. `[2m`) are stripped from the report text.

## 0.4.2 — Polite handling of rate limiting (HTTP 429)

After many scans in one day, academybugs.com answered "429 Too Many Requests" and stopped
responding in time. The agent reported this honestly (NOT_VERIFIED, not broken), but the run had
94 NOT_VERIFIED and 32 AUTOMATION_ERROR results, and 5 slow pages were wrongly reported as FAIL
("page could not be loaded").

- **New `agent/throttle.js`.** When any response is 429:
  - every worker pauses for the time the site asks (`Retry-After`, seconds or date, capped at
    60 s; default 30 s);
  - the scan continues **one page at a time**;
  - each throttled check is retried once.
  - This covers the start page, page discovery, each check's page load, a link's destination
    and direct destination checks. The page finder uses the same throttle.
- **Timeouts while rate-limited** are no longer FAILs. A page that still does not load after
  pausing and retrying is NOT_VERIFIED (classification `RATE_LIMITED`).
- **The report explains it**: how many 429 responses, the total pause time, and that throttled
  checks are NOT_VERIFIED rather than FAIL.
- **Mobile menu detection**: without menu wording, only an icon-style button counts as the
  hamburger, so sub-menu expanders such as "Accessories [+]" are no longer chosen.
- **Tests**: 4 throttle unit tests; 1 integration test with a fixture that answers 429 +
  `Retry-After: 1` on the first visit to every page. The scan must pause, retry and end as PASS
  with all pages loaded.

## 0.4.1 — Fixes from a 63-page academybugs scan

- **The report was 32 MB** because each screenshot was embedded once per place it appeared (up
  to 5 times). Screenshots are now stored once and referenced by id; the same report
  regenerates at 8.8 MB, and typical reports are under 1 MB.
- **The same broken image on several pages** (e.g. one in a shared sidebar) is now one grouped
  defect listing all pages, instead of one defect card per page.
- **Video-player controls with random ids** (`plyr-seek-5270`) could not be found again,
  giving 8 AUTOMATION_ERRORs. Inputs whose id or name looks generated (3+ digits or a long hex
  string) are now identified by their label (`aria-label`, `<label>`), e.g. "Input exists - Seek".
- **Cookie banners covering buttons.** Before clicking, the agent checks whether a fixed or
  sticky overlay covers the element. If so, it hides the overlay, without accepting or
  rejecting anything, and the result says which overlay was hidden. "SIGN IN" on academybugs
  now passes.
- **Disabled buttons** (e.g. quiz answers that are enabled only after earlier steps) were
  clicked until timeout. They are now listed under "Not tested by design", with a NOT_VERIFIED
  safety net if one becomes disabled later.
- **Cookie-consent controls** ("Accept cookies", "Functional only", the banner's links) record
  a consent choice. They are now listed as not tested.

Re-check of the 4 affected real pages: automation errors 9 → 1, with real defects still reported.

## 0.4.0 — Find Pages first

You can now see how big a site is, and choose what to test, before a scan starts.

### Added

- **Page finder** (`agent/site-map.js`, `POST /api/map`). It reads `sitemap.xml` (including
  sitemaps listed in `robots.txt` and sitemap indexes) and quickly crawls from the start URL.
  - No tests are run; images, fonts and media are not downloaded.
  - Limits: 200 pages, 2 minutes, depth 3.
  - The usual skip rules apply (external sites, files, login/admin, state-changing links,
    `robots.txt`, crawler traps).
- **Sections and templates.** Pages are grouped by top-level folder. A folder shared by every
  page, such as `/en/`, is ignored when naming sections. A folder counts as a template only
  when all of these hold:
  - it has at least 4 pages;
  - those pages are not a few navigation pages (a navigation "catalogue" of 8+ pages is allowed);
  - at least 75% of the visited pages have a main-content layout ≥ 80% similar.
  - The layout fingerprint uses CSS classes outside header/nav/footer/cookie popups, with
    digits normalised.
- **Smart sample:** all unique pages plus 2 per template.
- **Time estimates** from measured real scans: 13–30 s per page desktop-only, 30–75 s with mobile.
- **Dashboard:** "Find Pages First" panel with sections, choices (smart sample / first N / all /
  ticked sections), a live estimate and "Start Test". "Run Full QA Scan" still works as before.
- **Selected-pages scans:** `POST /api/run` accepts `pages` (same-site URLs, max 200),
  `notSelected`, `pagesFound` and `maxMinutes` (1–120). Only those pages are tested; the report
  shows "chosen by you from N found" and lists the pages not selected.

### Measured on real sites

- **letspingup.com:** 28 pages found in 1 min 46 s. The 6 "What's New" posts were detected as
  one template, so the smart sample is 24 pages.
- **academybugs.com:** 104 pages found (the 2-minute limit was reached). The 43 product pages
  were detected as one template, so the smart sample is 63 pages, estimated at 32–79 min with
  mobile, compared with 53–131 min for all pages.
- Two issues found and fixed during this check:
  - the layout fingerprint ignored a page completely when the consent plugin put its class on
    `<body>`;
  - a product catalogue linked from the navigation was not treated as a template.

### Tests

- `test/unit/site-map.test.js`: 7 tests (sitemap parsing, sections, templates, smart sample,
  estimates).
- `test/integration/find-pages.test.js`: 5 tests (page finder on a shop fixture with a
  sitemap-only page, template detection, selected-pages scan, API validation).
- `test/fixtures/shop-site.js`: 6 same-template product pages, 4 different info pages, and a
  sitemap-only landing page.

## 0.3.1 — Fixes from scanning academybugs.com

A 25-page scan of a deliberately buggy demo shop found all its real broken links and images,
but also produced false alarms. Fixed:

- **Hidden images with an empty `src=""` were reported as broken.** The browser resolves an empty
  `src` to the page's own URL, so the agent downloaded the HTML page and called it "not an image"
  (20 false FAILs per page). An empty `src` now means "no source yet"; `data-src`/`data-srcset`
  lazy sources are checked instead, and a *visible* image without a source still FAILs.
- **Hidden links to other websites** (e.g. a cookie-consent widget's links to cookiedatabase.org
  and Facebook) produced 42 NOT_VERIFIED results. They are now listed under "Not tested by
  design". Hidden links within the scanned site are still checked.
- **Hidden action links** (checkout, log out) were reported as NOT_VERIFIED; they are now listed
  as not tested.
- **A direct re-request to another website that answered 400/405/406** (typical for automated
  requests, e.g. a Facebook share link) was a FAIL. It is now NOT_VERIFIED. 404, 410 and 5xx
  still FAIL.
- **The HTML report reached 33 MB** with full-page screenshots of long pages. Embedded
  screenshots are now capped at about 8 MB in total; the rest are referenced by file path.

Re-scan of the same site (10 pages): 152 checks, 5 NOT_VERIFIED and a 2.4 MB report (the earlier
25-page scan had 47 NOT_VERIFIED and a 33 MB report). All real defects are still reported.

## 0.3.0 — Phase 1: full-site scanning

The agent can now QA a whole website instead of one page. The default for the CLI and API stays
a single desktop page, so existing usage is unchanged. The dashboard runs a site scan
(25 pages, desktop + mobile) by default.

### Added

- **Site crawler.** Follows same-site links breadth-first, navigation and footer links first, up
  to a page limit (25 by default) and a link depth (3).
  - URLs are normalised (fragments and tracking parameters removed) so no page is scanned twice.
  - Skipped, each with a reason: external sites, files, login/admin/account/cart areas,
    state-changing links, `robots.txt`-disallowed pages, crawler traps (endless `?query`
    variants), redirects to already-scanned pages, and non-HTML responses.
- **Mobile testing.** Each page is also tested on a 390×844 touch phone. A new **Mobile menu**
  check opens the hamburger menu and verifies that it reveals links.
- **Site-wide deduplication.**
  - Checks shared by several pages (header and footer links, a repeated newsletter form) run once
    and list every page they appear on.
  - Links visible on desktop are not re-checked on mobile.
  - An error page (404/500) gets a single page-load check.
- **Parallel pages and a time limit.** 3 pages run in parallel (`QA_CONCURRENCY`), within a
  30-minute overall limit (`QA_MAX_DURATION_MS`).
- **Report.**
  - Site Coverage section: per-page status and counts, plus every not-scanned URL with its reason.
  - Defects grouped by broken URL ("Also detected by"), with "Found on N pages".
  - A viewport filter.
  - At most 25 embedded screenshots; further screenshots are referenced by file path.
- **Dashboard.** Max pages, Include mobile view and Single page only controls. Live progress
  ("Pages scanned 7/25 · Checks completed 42") via `GET /api/status`.
- **CLI.** `npm run scan:site -- <url>`, plus `--pages=N`, `--depth=N`, `--mobile` and
  `--concurrency=N`.

### Fixed (found by scanning a real site)

- **Large images were reported as broken.** A valid 9.8 MB JPEG took longer than the browser's
  8-second decode check, and the timeout was treated as "not an image". The agent now downloads
  the file and checks its real image signature (JPEG, PNG, GIF, WebP, AVIF, SVG, ICO, BMP).
  - Valid but slow images are listed as **very slow to load** instead of broken.
  - Only HTTP errors, non-image responses and genuinely corrupt files FAIL.
- **An FAQ accordion button was taken for the mobile menu toggle.** Detection now requires
  menu-like wording, or a disclosure control in the header/navigation with a short label.
- **A new tab that answered HTTP 200 without a page title** (e.g. a PDF) is now PASS (destination
  reachable) instead of NOT_VERIFIED.
- **Product grids exploded the check count.** On books.toscrape.com, 18 pages produced 1,044
  checks, because every product had its own "Add to basket" form and two links (image and title)
  to the same page.
  - Identical forms on a page are now tested once; field-less forms with the same button label
    are tested once site-wide.
  - Visible links are deduplicated by destination.

### Files

| File | Change |
| --- | --- |
| `agent/crawl-rules.js` | **New**: URL normalisation, same-site checks, skip rules, `robots.txt` parser |
| `agent/viewports.js` | **New**: desktop and mobile presets |
| `agent/ai-qa-pipeine.js` | Site engine: crawl queue, parallel pages, site-wide dedupe, page summaries, `pages` and `crawl` in the JSON; `runPipeline(url, options)` |
| `agent/runner.js` | `discoverPage()` (reusable, any viewport); discovery now includes all crawlable links, the mobile menu toggle and form field names. `runQA()` output unchanged |
| `agent/ai-test-planner.js` | Mobile planning (menu check; hidden links left to desktop); form field signature; stricter state-changing URL rule |
| `agent/test-executor.js` | Viewport option; mobile menu check |
| `agent/browser.js` | Contexts take a viewport preset |
| `agent/report-generator.js` | Site Coverage, defect grouping, page lists, viewport filter, screenshot cap |
| `server.js` | `maxPages`, `maxDepth`, `mobile` and `singlePage` options (validated); progress in `/api/status` |
| `public/index.html` | Scan options and live progress |
| `test/unit/crawl.test.js` | **New**: 7 unit tests (plus 1 planner test for repeated forms) |
| `test/integration/site.test.js` | **New**: 10 browser tests against a generated multi-page site (plus slow-image and FAQ-toggle tests in `pipeline.test.js`) |
| `test/integration/server.test.js` | Option validation and live progress tests |
| `test/fixtures/multi-site.js` | **New**: multi-page fixture site (shared header/footer, mobile menu, robots.txt, PDF, logout, external link, broken link, deep pages, calendar trap) |

### JSON additions

- Top level: `pages[]` (per-page status and summary) and `crawl` (mode, limits, viewports,
  `skippedUrls`, robots, time limit).
- Each result: `occurrences` (pages), `page` and `viewport`.

## 0.2.0 — Stability and accuracy release

All existing routes (`/`, `POST /api/run`, `/api/status`, `/api/report`, `/api/report.json`),
CLI commands, report file names, the live timer and report duration are preserved.

### Fixed

1. **Valid form values reported as rejected.** The old generator typed fixed values (for
   example `+923001234567` or `2026-10-09`) that broke fields' own `pattern`, `min`/`max`/`step`
   and length rules. It could not tick custom-styled (hidden) checkboxes, and it counted required
   file uploads, which the agent never fills, against "valid input accepted". Values are now
   generated from each field's declared constraints and re-checked in the browser, field by field.
2. **Form submission checks stuck at NOT_VERIFIED.** Forms were only tested when their submit
   button matched a keyword list (`send message|submit|…`); other submit buttons, such as
   *Subscribe*, became button tests that were always skipped. Every visible form now gets a
   non-submitting validation test, which resolves to PASS on client-side evidence.
3. **Hidden links reported inaccurately.** The link locator picked the first element with a
   matching label. It could choose a hidden mobile-menu copy, or the wrong one of two
   "Learn more" links, so the second link was never tested. Links are now matched by destination,
   and visible copies win. Hidden links are labelled "Hidden link - …" with the reason
   (`display:none`, `visibility:hidden`, off-screen…), and a hidden link to a 404 is a FAIL.
4. **Inaccurate statuses and counts.** Results carried two disagreeing fields
   (`status: NOT_EXECUTED` with `outcome: NOT_VERIFIED`). `VALIDATION_PASS` was counted outside
   "Passed", so the dashboard and report showed different pass rates. A page that failed to load
   produced **0 tests and an overall PASS**. HTTP 999 during a real navigation was a FAIL. The
   report badge showed "✓ FAIL", and missing outcomes defaulted to PASS. There are now exactly
   four outcomes, `status === outcome`, and one shared summary function.
5. **Misleading or duplicate checks.** Any change on the page, including an autoplaying
   carousel, counted as proof that a click worked, so mailto, tel, `#` and do-nothing buttons
   "passed". Playwright's own scroll-into-view counted as an effect. Hidden CSRF and honeypot
   inputs produced AUTOMATION_ERRORs, and form fields were tested twice. Lazy-loaded images were
   reported broken (the old "20 of 39 images" failure).
6. **Safety.** Non-submit buttons were clicked regardless of label. The original clicked
   *Buy now* and sent a POST. Now:
   - Side-effect buttons are never clicked; the wider word list includes save, post, accept, cancel, join and share.
   - State-changing GET links (log out, unsubscribe, delete, add to cart) are neither followed nor fetched.
   - All non-GET requests are blocked during checks.
   - `form.submit()` and `requestSubmit()` calls by page scripts are cancelled and counted, and
     page navigation is blocked during form checks.
7. **Robustness.** One failing test or browser context can no longer abort the whole run. A stale
   `failure.png` from an earlier run is never attached. Malformed `mailto:`/`tel:` escapes are a FAIL,
   not a crash. A new tab that the browser received as 999/403 is NOT_VERIFIED, consistent with
   same-tab links. Image request timeouts are NOT_VERIFIED rather than "broken".

### JSON compatibility notes

- `summary.passed` now **includes** form-validation passes; `summary.validationPasses` is a subset of it.
- `summary.notExecuted` is kept and is always 0.
- Each result's `status` now equals its `outcome`.
- New fields: `skippedElements`, `safety`, `discovery.formDetails`, `discovery.hiddenLinkCount`, plus per-result `element`, `validation.fields`, `destinationCheck` and `navigationStatus`.

### Files

| File | Change | Reason |
| --- | --- | --- |
| `agent/outcomes.js` | **New** | The four outcomes, HTTP status classification (999/401/403/429 = restricted), summary and overall status in one place |
| `agent/form-values.js` | **New** | Constraint-aware synthetic values (pattern, length, min/max/step, dates), plus a generator that builds a matching example for simple regex patterns |
| `agent/form-validator.js` | **New** | Field-by-field, non-submitting form validation: empty, invalid format, valid value and submit-control readiness; recognises `aria-invalid` JavaScript validation |
| `agent/browser.js` | **New** | One Chromium launcher (honours `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` everywhere) and the request guard |
| `agent/dom-helpers.js` | **New** | Shared in-page helpers: visibility with reason, accessible names, label text, CSS paths |
| `agent/paths.js` | **New** | Reports folder, overridable with `QA_REPORTS_DIR` (keeps tests away from real reports) |
| `agent/runner.js` | Modified | Richer discovery: visibility and reason, selectors, button type and form membership, `formDetails`, HTTP status. Existing fields kept (`forms` is still a count) |
| `agent/ai-test-planner.js` | Modified | Destination-based link dedupe with visible-first ordering; a form test per form; side-effect buttons planned as "not clicked"; fields inside forms not duplicated; `planTestsWithNotes()` returns skipped elements with reasons. `planTests()` is unchanged for callers |
| `agent/test-executor.js` | Modified | Destination-based locator, mailto/tel/anchor/placeholder handling, background-change filtering before and after clicks with a repeat-click check, new tab judged by the browser's own HTTP status, lazy-image-aware image check, page-load HTTP status, shared browser support. `executeTest(url, test)` still works |
| `agent/ai-qa-pipeine.js` | Modified | Shared browser (faster), page-unreachable result instead of 0 tests, shared summary, `skippedElements` and `safety` in the JSON |
| `agent/report-generator.js` | Modified | Counts always recomputed from results. KPIs for Not Verified and Automation Errors, correct badge icon, per-field form table, element visibility, direct-HTTP evidence, "Not Tested by Design" section |
| `server.js` | Modified | Exports `app` (listens only when run directly) and returns a JSON 404 when no report exists yet |
| `public/index.html` | Modified | Not Verified and Automation Errors cards, pass rate from the shared summary, correct message for each status |
| `package.json` | Modified | `scan`, `test`, `test:integration`, `test:all` and `fixture` scripts; Node ≥ 22 |
| `.gitignore` | Modified | `reports/*` with `!reports/.gitkeep`, so the folder exists after cloning |
| `README.md` | Modified | Windows setup, outcomes, safety, tests and limitations |
| `test/unit/*.test.js` | **New** | 33 unit tests (outcomes, value generation, planner, report) |
| `test/integration/*.test.js` | **New** | 25 Chromium tests: full pipeline against the fixture site, plus the HTTP API |
| `test/fixtures/` | **New** | Local website reproducing each bug generically, recording any non-GET request it receives |

`agent/test-planner.js` (demo script) is unchanged. Generated files from earlier runs in
`reports/` are not included in the package.
