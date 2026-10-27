# AI QA Agent — MVP

A deterministic, evidence-based web QA agent built with Express and Playwright.
Enter a URL; the agent crawls the website, plans checks for every page, runs them in
Chromium on desktop and mobile, and produces HTML and JSON reports with screenshots.
It works on any public website; nothing is specific to one site.

## Find Pages first (recommended)

Click **Find Pages First** before scanning. In about 1–2 minutes, and without running any
tests, the agent:

1. Reads the site's `sitemap.xml` (if any) and quickly follows links from the start URL. It
   stops at 200 pages or 2 minutes, whichever comes first.
2. Shows how many pages exist, grouped into **sections** (e.g. `store` 43 pages, `blog` 18).
3. Detects **repeated templates**: many pages in one folder whose main content uses the same
   layout, such as product pages. Navigation, footer and cookie popups are ignored when
   comparing layouts.
4. Lets you choose what to test, with a live **time estimate** for each choice:
   - **Smart sample (recommended):** every unique page, plus 2 examples of each template
   - **The first N** most important pages (start page, then navigation, then deeper pages)
   - **All** pages (up to 200)
   - **Only the sections you tick**
5. **Start Test** scans exactly those pages. The report shows "N pages chosen by you from M
   found", and lists every page that was not selected.

The time limit for a chosen scan follows its estimate (up to 120 minutes), so a scan you
deliberately chose is not cut short.

## Site scanning

From the starting URL, the agent finds the site's own pages and tests each one:

- **Scope:** up to 25 pages by default (1–100), following links up to 3 clicks deep. Navigation
  and footer links are visited first.
- **Same site only:** `www.` and the bare domain count as one site. External sites are not
  crawled, but links to them are still checked.
- **Skipped, with the reason in the report:** files (PDF, ZIP, images…), login/admin/account/cart
  areas, log-out and other state-changing links, pages disallowed by the site's `robots.txt`, and
  endless query-string variants (crawler traps).
- **Desktop and mobile:** each page is tested at 1280×720 and on a 390×844 phone. On mobile the
  hamburger menu is opened and must reveal its links. Links already checked on desktop are not
  re-checked on mobile.
- **No repetition:** a check shared by several pages (header and footer links, a newsletter form)
  runs once, and the report lists every page it appears on. A broken link and the 404 page it
  leads to are shown as one defect.
- **Time:** 3 pages are tested in parallel, with an overall limit of 30 minutes. A 25-page site
  usually takes 5–20 minutes.

The report adds a **Site Coverage** section: every scanned page with its status and counts, and
every discovered URL that was not scanned, with the reason.

## What it checks

| Check | How it decides |
| --- | --- |
| Page load | HTTP status of the page plus a non-empty `<title>` |
| Links | Clicks visible links and checks the navigation status; hidden links are checked with a direct HTTP request and reported as hidden, with the reason; `mailto:`/`tel:` links are format-checked |
| Buttons | Clicks safe buttons and looks for a change that the page does not also make on its own (autoplay, animations) |
| Side-effect buttons | Buttons such as *Buy now*, *Subscribe*, *Delete* are **never clicked**; the agent only verifies that they are visible and enabled |
| Form validation | Field by field, **without submitting**: required fields reject empty input, email/url/pattern fields reject invalid input, every field accepts a realistic value that satisfies its own constraints, and the submit control is enabled once the form is valid |
| Inputs | Inputs outside tested forms are present and visible (fields inside forms are covered by the form check) |
| Images | Scrolls through the page so lazy images load, then separates genuinely broken files (404, not an image) from images that are only lazy or hidden |
| Mobile menu | On a phone-sized screen, opens the hamburger menu and checks that more links become visible |

Every check ends in exactly one outcome:

- **PASS**: the evidence supports the check's claim
- **FAIL**: evidence of a real defect
- **NOT_VERIFIED**: the evidence was not sufficient either way (for example, HTTP 999 bot protection)
- **AUTOMATION_ERROR**: the agent itself could not perform the check

The run status is `FAIL` if anything failed, otherwise `PASS_WITH_WARNINGS` if anything is
not verified or errored, otherwise `PASS`. The dashboard, HTML report and JSON report all use
the same counting code, so their numbers always agree.

Elements that were discovered but deliberately not turned into tests (hidden duplicates,
honeypot fields, submit buttons covered by a form check…) are listed in the report under
**Not Tested by Design**, with the reason.

## Rate limiting

If a site answers **429 Too Many Requests**, the agent pauses for as long as the site asks
(`Retry-After`, up to 60 s), continues one page at a time, and retries throttled checks once.
Checks that are still throttled are reported as NOT VERIFIED (`RATE_LIMITED`), never as FAIL,
and the report says the site rate-limited the scan. Scanning the same site many times in a
short period can trigger this.

## Cookie banners and disabled controls

- If a cookie banner or other fixed overlay covers an element, the agent hides it (it does not
  accept or reject cookies) and notes this in the result.
- Buttons and links inside cookie/consent banners, and buttons that are disabled when the
  page loads, are listed under **Not tested by design** instead of being clicked.

## Safety

- Forms are never submitted, submit buttons are never clicked, and Enter is never pressed.
- Buttons whose label suggests a real-world side effect are never clicked, and links such as
  *Log out*, *Unsubscribe*, *Delete* or add-to-cart URLs are neither followed nor fetched.
- Script calls to `form.submit()` are cancelled, and page navigation is blocked during form checks.
- While a check runs, every state-changing request (POST/PUT/PATCH/DELETE) is blocked in the
  browser. The number of blocked requests is shown in the report. Set
  `QA_ALLOW_MUTATING_REQUESTS=true` only for sites you own.

## Requirements

- Windows 10/11 (macOS/Linux also work)
- Node.js 22 LTS or newer: <https://nodejs.org>

## Installation (Windows)

Open **PowerShell** or **Command Prompt** in the project folder (the folder that contains
`package.json`), then run:

```bash
npm install
```

```bash
npx playwright install chromium
```

## Run the dashboard

```bash
npm start
```

Then open <http://localhost:3000>, enter a URL and click **Find Pages First** (recommended) or **Quick Scan**.

- **Find Pages First** shows the site's size and lets you choose pages (see above).
- **Quick Scan** starts immediately instead, using **Max pages** (default 25),
  **Include mobile view** (default on) and **Single page only**.
- While it runs, the live timer and a progress line ("Pages scanned 7/25 · Checks completed 42")
  are shown.
- When it finishes, use **Open Professional Report** or **Open JSON Report**.

To use another port in PowerShell: `$env:PORT=4000; npm start`

## Command-line mode

Whole site (25 pages, desktop + mobile):

```bash
npm run scan:site -- https://example.com
```

Single page, desktop only (the original behaviour):

```bash
npm run scan -- https://example.com
```

Options can be combined: `--pages=10`, `--depth=2`, `--mobile`, `--concurrency=3`.

Discovery only (the original MVP behaviour):

```bash
npm run qa -- https://example.com
```

Reports are written to:

- `reports/ai-qa-report.html` and `reports/ai-qa-report.json` (full scan)
- `reports/report.html` and `reports/report.json` (discovery)
- `reports/homepage.png` and per-test screenshots

Set `QA_REPORTS_DIR` to write reports somewhere else.

## Running on GitHub

Two manual workflows live in `.github/workflows/`. Nothing runs automatically on push;
open the repository's **Actions** tab, pick a workflow and click **Run workflow**.

| Workflow | What it does | Time |
| --- | --- | --- |
| **Run QA Scan** (`qa-scan.yml`) | Scans a website. Form: URL, max pages (1 = single page), mobile on/off, and whether defects should mark the run as failed. | ~5–30 min |
| **Run Tests** (`tests.yml`) | Runs the agent's own unit and browser integration tests. | ~6–8 min |

After **Run QA Scan** finishes:

- The run page shows a **summary**: status, counts and the failed checks.
- The full report is attached as the **`qa-report`** artifact (kept for 14 days). Download it,
  unzip it and open `ai-qa-report.html`.
- With "Mark the run as failed" ticked (the default), the run shows a red ✕ when defects are
  found, and GitHub emails you as usual.

The dashboard (`npm start`) is a local web app; GitHub stores the code and runs the
workflows but does not host the dashboard.

## Tests

Unit tests (fast, no browser):

```bash
npm test
```

Browser integration tests. These start a local fixture website (`test/fixtures`) and run
the real pipeline in Chromium. They take about 3 minutes and need no internet access:

```bash
npm run test:integration
```

You can also open the fixture site yourself with `npm run fixture` (<http://127.0.0.1:4321>).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Dashboard port (default 3000) |
| `QA_REPORTS_DIR` | Report output folder (default `reports/`) |
| `QA_ALLOW_MUTATING_REQUESTS` | `true` disables the request guard (own sites only) |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Use an existing Chrome/Chromium instead of the Playwright download |
| `QA_CONCURRENCY` | Pages tested in parallel (default 3) |
| `QA_MAX_DURATION_MS` | Overall time limit per scan (default 1800000 = 30 minutes; scans started from Find Pages use their own estimate, up to 120 minutes) |

## Limitations

- Form checks cover client-side validation only. Server-side validation and what happens after
  submission are not tested, because the agent never submits.
- Change detection watches the page for about 6 seconds around each click. Background
  animations that repeat less often than that can occasionally be mistaken for a click's effect.
- Only public pages are scanned; login-protected areas are skipped.
- Links that appear in both layouts are checked once, on desktop; mobile-only tap problems on
  such links are not tested.
- Pages that only appear after interaction (infinite scroll, search results) are not discovered.
- Accessibility, SEO, performance and console-error checks (Phase 2) and the Claude-based AI
  analysis (Phase 3) are planned next.
