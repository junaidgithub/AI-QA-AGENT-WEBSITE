const fs = require("fs");
const { normalizeOutcome, summarize, overallStatus } = require("./outcomes");

function escapeHtml(value) {
  return String(value ?? "")
    // Terminal colour codes from browser logs ("\u001b[2m") are noise in a report.
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function outcomeFor(result) {
  return normalizeOutcome(result.outcome ?? result.status);
}

function severityFor(result) {
  if (outcomeFor(result) !== "FAIL") return "";
  // A broken link that users cannot see (e.g. in a hidden menu) matters, but less.
  if (result.test.type === "link" && result.element && result.element.visible === false) return "Medium";
  if (["page_load", "link"].includes(result.test.type)) return "High";
  if (["form_submit", "button", "carousel"].includes(result.test.type)) return "Medium";
  return "Low";
}

function typeLabel(type) {
  return ({
    page_load: "Page Load",
    link: "Link",
    carousel: "Carousel",
    form_submit: "Form Validation",
    button: "Button",
    input: "Input",
    form: "Form",
    broken_image: "Broken Image",
    mobile_menu: "Mobile Menu"
  })[type] || type;
}

function outcomeLabel(outcome) {
  return ({
    PASS: "PASS",
    FAIL: "FAIL",
    NOT_VERIFIED: "NOT VERIFIED",
    AUTOMATION_ERROR: "AUTOMATION ERROR"
  })[outcome] || outcome;
}

function outcomeClass(outcome) {
  return String(outcome || "").toLowerCase().replace(/_/g, "-");
}

function categoryStats(results) {
  const map = {};
  for (const item of results) {
    const type = typeLabel(item.test.type);
    map[type] ||= { total: 0, passed: 0, failed: 0, notVerified: 0, automation: 0 };
    map[type].total += 1;
    const outcome = outcomeFor(item);
    if (outcome === "PASS") map[type].passed += 1;
    else if (outcome === "FAIL") map[type].failed += 1;
    else if (outcome === "AUTOMATION_ERROR") map[type].automation += 1;
    else map[type].notVerified += 1;
  }
  return Object.entries(map);
}

const MAX_EMBEDDED_SCREENSHOTS = 25;
// Full-page screenshots of long pages can be several MB each; keep the HTML report a manageable size.
const MAX_EMBEDDED_BYTES = 8 * 1024 * 1024;

// Large site reports embed at most MAX_EMBEDDED_SCREENSHOTS images; the rest are referenced by path.
/**
 * Each screenshot is stored once in the report (in a script block) and
 * referenced by id wherever it is shown, so a screenshot used by both a defect
 * card and a test row does not double the report size.
 */
function createScreenshotEmbedder() {
  const ids = new Map();
  const shots = {};
  let bytes = 0;
  const embed = filePath => {
    if (!filePath) return null;
    if (ids.has(filePath)) return ids.get(filePath);
    let id = null;
    if (ids.size < MAX_EMBEDDED_SCREENSHOTS) {
      const uri = screenshotDataUri(filePath);
      if (uri && bytes + uri.length <= MAX_EMBEDDED_BYTES) {
        id = `shot-${Object.keys(shots).length + 1}`;
        shots[id] = uri;
        bytes += uri.length;
      }
    }
    ids.set(filePath, id);
    return id;
  };
  embed.script = () => `<script>const SHOTS=${JSON.stringify(shots)};document.querySelectorAll('[data-shot]').forEach(el=>{const uri=SHOTS[el.dataset.shot];if(!uri)return;if(el.tagName==='IMG')el.src=uri;else el.href=uri;});</script>`;
  return embed;
}

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return String(url || "");
  }
}

function pagesText(item) {
  const pages = item.occurrences || [];
  if (pages.length <= 1) return pages[0] ? pathOf(pages[0]) : "";
  const shown = pages.slice(0, 10).map(pathOf).join(", ");
  return `${pages.length} pages: ${shown}${pages.length > 10 ? `, … (+${pages.length - 10} more)` : ""}`;
}

/** Failures that point at the same broken URL are one defect found by several checks. */
function defectGroupKey(item) {
  const strip = value => String(value || "").split("#")[0].replace(/\/$/, "");
  // The same broken image on several pages (shared sidebar, header) is one defect.
  if (item.test.type === "broken_image" && item.imageCheck?.confirmedBrokenImages?.length) {
    return `images:${[...new Set(item.imageCheck.confirmedBrokenImages.map(image => strip(image.src || image.lazySrc)))].sort().join("|")}`;
  }
  if (item.test.type === "link" && item.afterUrl) return `url:${strip(item.afterUrl)}`;
  if (item.test.type === "page_load" && (item.test.page || item.beforeUrl)) return `url:${strip(item.test.page || item.beforeUrl)}`;
  return `check:${item.test.name}`;
}

function screenshotDataUri(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath).toString("base64");
    return `data:image/png;base64,${data}`;
  } catch {
    return null;
  }
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function formatDuration(durationMs) {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(Number(durationMs))) return "—";
  const totalSeconds = Math.max(0, Math.floor(Number(durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} min ${seconds} sec` : `${seconds} sec`;
}

const STATUS_LABELS = {
  PASS: { text: "PASS", icon: "✓" },
  FAIL: { text: "FAIL", icon: "✕" },
  PASS_WITH_WARNINGS: { text: "PASS WITH WARNINGS", icon: "!" },
  NOT_VERIFIED: { text: "NOT VERIFIED", icon: "?" }
};

function visibilityText(element) {
  if (!element) return "";
  const base = element.visible === false ? `Hidden — ${element.hiddenReason || "not visible"}` : "Visible";
  return `${base}${element.locatedBy ? ` · located by ${element.locatedBy}` : ""}${element.note ? ` · ${element.note}` : ""}`;
}

function yesNo(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "—";
}

function generateHtmlReport(result) {
  const executionResults = result.executionResults || [];
  // Always recomputed from the results so every number on the page agrees.
  const summary = summarize(executionResults);
  const { total, passed, failed, notVerified, automationErrors, validationPasses } = summary;
  const resolved = passed + failed;
  const passRate = summary.passRate.toFixed(1);
  const completionRate = total ? ((resolved / total) * 100).toFixed(1) : "0.0";
  const duration = formatDuration(result.metadata?.durationMs);
  const unresolvedCount = notVerified + automationErrors;
  const statusKey = overallStatus(summary);
  const status = STATUS_LABELS[statusKey].text;
  const statusIcon = STATUS_LABELS[statusKey].icon;
  const failedTests = executionResults.filter(x => outcomeFor(x) === "FAIL");
  const automationIssues = executionResults.filter(x => ["AUTOMATION_ERROR", "NOT_VERIFIED"].includes(outcomeFor(x)));
  const notVerifiedTests = executionResults.filter(x => outcomeFor(x) === "NOT_VERIFIED");
  const skippedElements = result.skippedElements || [];
  const categories = categoryStats(executionResults);
  const severityCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  failedTests.forEach(item => { const s = severityFor(item); if (s) severityCounts[s] += 1; });

  const discovery = result.discovery || {};
  const browser = result.metadata?.browser || discovery.browser || { name: "Chromium", version: "Unknown" };
  const viewport = result.metadata?.viewport || discovery.viewport || { width: 1280, height: 720 };
  const consoleErrors = result.consoleErrors || [];
  const networkErrors = result.networkErrors || [];
  const generatedAt = result.metadata?.finishedAt || new Date().toISOString();

  const categoryRows = categories.map(([name, stat]) => {
    const rate = stat.total ? Math.round((stat.passed / stat.total) * 100) : 0;
    return `<div class="category-row">
      <div class="category-top"><strong>${escapeHtml(name)}</strong><span>${rate}%</span></div>
      <div class="category-bar"><div class="category-fill" style="width:${rate}%"></div></div>
      <div class="category-meta">${stat.passed} pass · ${stat.failed} fail · ${stat.notVerified} not verified · ${stat.automation} automation error</div>
    </div>`;
  }).join("");

  const categoryChart = categories.map(([name, stat]) => {
    const rate = stat.total ? Math.round((stat.passed / stat.total) * 100) : 0;
    return `<div class="chart-row"><div class="chart-label"><span>${escapeHtml(name)}</span><b>${rate}%</b></div><div class="chart-track"><div class="chart-fill" style="width:${rate}%"></div></div></div>`;
  }).join("");

  const embed = createScreenshotEmbedder();
  const severityRank = { Critical: 4, High: 3, Medium: 2, Low: 1, "": 0 };
  const defectGroups = new Map();
  for (const item of failedTests) {
    const key = defectGroupKey(item);
    if (!defectGroups.has(key)) defectGroups.set(key, []);
    defectGroups.get(key).push(item);
  }

  const defectRows = failedTests.length ? [...defectGroups.values()].map((group, index) => {
    const item = [...group].sort((a, b) => severityRank[severityFor(b)] - severityRank[severityFor(a)])[0];
    const severity = severityFor(item);
    const image = embed(item.screenshot);
    const related = group.filter(other => other !== item);
    return `<article class="defect-card sev-${severity.toLowerCase()}">
      <div class="defect-head">
        <div><span class="issue-id">DEF-${String(index + 1).padStart(3, "0")}</span><strong>${escapeHtml(item.test.name)}</strong></div>
        <span class="severity ${severity.toLowerCase()}">${escapeHtml(severity)}</span>
      </div>
      <div class="defect-grid">
        <div><span class="label">Type</span><span>${escapeHtml(typeLabel(item.test.type))}${item.viewport ? ` · ${escapeHtml(item.viewport)}` : ""}</span></div>
        ${(item.occurrences || []).length ? `<div><span class="label">Found on</span><span>${escapeHtml(pagesText(item))}</span></div>` : ""}
        ${related.length ? `<div><span class="label">Also detected by</span><span>${related.map(other => escapeHtml(`${other.test.name} (${pagesText(other)})`)).join("<br>")}</span></div>` : ""}
        <div><span class="label">Finding</span><span>${escapeHtml(item.details || item.error || (item.imageCheck ? `Images checked: ${item.imageCheck.totalImages ?? 0} · Confirmed broken: ${item.imageCheck.confirmedBrokenCount ?? 0} · Not verifiable: ${item.imageCheck.loadIssueCount ?? 0}` : "No failure details available"))}</span></div>
        <div><span class="label">Before URL</span><span class="mono">${escapeHtml(item.beforeUrl || result.target)}</span></div>
        <div><span class="label">After URL</span><span class="mono">${escapeHtml(item.afterUrl || "—")}</span></div>
      </div>      ${item.imageCheck ? `
        <div class="image-check-summary">
          <div><span class="label">Images checked</span><strong>${escapeHtml(item.imageCheck.totalImages ?? 0)}</strong></div>
          <div><span class="label">Loaded successfully</span><strong>${escapeHtml(item.imageCheck.loadedImageCount ?? 0)}</strong></div>
          <div><span class="label">Confirmed broken</span><strong class="${(item.imageCheck.confirmedBrokenCount ?? 0) > 0 ? "red" : "green"}">${escapeHtml(item.imageCheck.confirmedBrokenCount ?? 0)}</strong></div>
          <div><span class="label">Lazy/hidden but loadable</span><strong>${escapeHtml(item.imageCheck.deferredLoadableCount ?? 0)}</strong></div>
          <div><span class="label">Not verifiable</span><strong class="${(item.imageCheck.loadIssueCount ?? 0) > 0 ? "amber" : "green"}">${escapeHtml(item.imageCheck.loadIssueCount ?? 0)}</strong></div>
        </div>
      ` : ""}

      ${image ? `<details class="evidence"><summary>View screenshot evidence</summary><a data-shot="${image}" target="_blank"><img data-shot="${image}" alt="Failure evidence"></a></details>` : ""}
    </article>`;
  }).join("") : unresolvedCount > 0
    ? `<div class="empty-state"><div class="empty-icon">!</div><strong>No confirmed defects; verification is incomplete</strong><span>${unresolvedCount} check(s) remain NOT VERIFIED or AUTOMATION ERROR. Review the Test Execution Details before treating this run as clean.</span></div>`
    : `<div class="empty-state"><div class="empty-icon">✓</div><strong>No confirmed defects detected</strong><span>All generated checks passed.</span></div>`;

  const testRows = executionResults.map((item, index) => {
    const outcome = outcomeFor(item);
    const cls = outcomeClass(outcome);
    const severity = severityFor(item);
    const image = embed(item.screenshot);

    const validationFields = item.validation?.fields || [];

    const validationDetails = validationFields.length
      ? `<div class="validation-details">
          <div class="validation-heading">Field-level results (form was not submitted)</div>
          <table class="validation-table">
            <thead>
              <tr><th>#</th><th>Field</th><th>Type</th><th>Required</th><th>Empty rejected</th><th>Invalid format rejected</th><th>Test value</th><th>Valid value accepted</th><th>Message</th></tr>
            </thead>
            <tbody>
              ${validationFields.map((field, fieldIndex) => `
                <tr>
                  <td>${fieldIndex + 1}</td>
                  <td><strong>${escapeHtml(field.label || field.name || field.id || "Unnamed field")}</strong></td>
                  <td>${escapeHtml(field.type || "—")}</td>
                  <td>${field.required ? "Yes" : "No"}</td>
                  <td>${field.required ? yesNo(field.emptyRejected) : "n/a"}</td>
                  <td>${field.invalidSample ? `${yesNo(field.invalidRejected)} <span class="muted">(${escapeHtml(field.invalidSample)})</span>` : "n/a"}</td>
                  <td class="mono">${escapeHtml(field.testValue ?? "—")}</td>
                  <td class="${field.accepted === false ? "red" : field.accepted ? "green" : ""}">${yesNo(field.accepted)}</td>
                  <td>${escapeHtml(field.validationMessage || "")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
          ${(item.validation.observations || []).length ? `<ul class="observations">${item.validation.observations.map(note => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : ""}
        </div>`
      : "";

    return `<tbody class="test-group" data-status="${escapeHtml(outcome)}" data-type="${escapeHtml(item.test.type)}" data-viewport="${escapeHtml(item.viewport || item.test.viewport || "desktop")}">
      <tr class="test-row">
        <td class="index">${index + 1}</td>
        <td><strong>${escapeHtml(item.test.name)}</strong><div class="muted">${escapeHtml(typeLabel(item.test.type))}</div></td>
        <td><span class="pill ${cls}">${escapeHtml(outcomeLabel(outcome))}</span></td>
        <td>${severity ? `<span class="severity-mini ${severity.toLowerCase()}">${escapeHtml(severity)}</span>` : "—"}</td>
        <td><button class="expand-btn" type="button" onclick="toggleTest(this)">Details</button></td>
      </tr>
      <tr class="detail-row"><td colspan="5"><div class="detail-content">
        <div class="detail-grid">
          <div><span class="label">Result</span><span>${escapeHtml(item.details || item.error || "—")}</span></div>
          <div><span class="label">Before URL</span><span class="mono">${escapeHtml(item.beforeUrl || result.target)}</span></div>
          <div><span class="label">After URL</span><span class="mono">${escapeHtml(item.afterUrl || "—")}</span></div>
          <div><span class="label">Evidence</span><span>${image ? "Screenshot available" : item.screenshot ? `Screenshot saved (not embedded): ${escapeHtml(item.screenshot)}` : "No screenshot captured"}</span></div>
          ${result.crawl && result.crawl.mode !== "single-page" ? `<div><span class="label">Applies to</span><span>${escapeHtml(pagesText(item))}</span></div>` : ""}
          ${item.element ? `<div><span class="label">Element</span><span>${escapeHtml(visibilityText(item.element))}</span></div>` : ""}
          ${item.destinationCheck ? `<div><span class="label">Direct HTTP check</span><span>${escapeHtml(item.destinationCheck.status ?? "no response")}${item.destinationCheck.error ? ` · ${escapeHtml(item.destinationCheck.error)}` : ""}</span></div>` : ""}
          ${item.safety?.mutatingRequestsBlocked ? `<div><span class="label">Safety guard</span><span>${item.safety.mutatingRequestsBlocked} state-changing request(s) blocked</span></div>` : ""}
        </div>
        ${validationDetails}
        ${image ? `<a class="evidence-link" data-shot="${image}" target="_blank"><img data-shot="${image}" alt="Test evidence screenshot"></a>` : ""}
      </div></td></tr>
    </tbody>`;
  }).join("");

  const breakdown = `${total} check(s): ${passed} passed (including ${validationPasses} form validation), ${failed} failed, ${notVerified} not verified, ${automationErrors} automation error(s).`;
  const aiSummary = statusKey === "FAIL"
    ? `Deterministic execution identified ${failed} confirmed application failure(s). ${breakdown} Review the defects and evidence below. Claude AI analysis will later classify root cause, likely impact and recommended next actions.`
    : statusKey === "PASS_WITH_WARNINGS"
      ? `No confirmed defects, but ${unresolvedCount} check(s) could not be fully verified. ${breakdown} This is not a clean PASS; review the verification issues below.`
      : statusKey === "NOT_VERIFIED"
        ? "No checks were executed, so nothing could be verified."
        : `All checks passed. ${breakdown}`;
  const safety = result.safety || {};
  const skippedRows = skippedElements.length
    ? `<table class="validation-table"><thead><tr><th>#</th><th>Kind</th><th>Element</th><th>Reason</th><th>Where</th></tr></thead><tbody>${skippedElements.map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.kind)}${item.viewport && item.viewport !== "desktop" ? ` <span class="muted">(${escapeHtml(item.viewport)})</span>` : ""}</td><td><strong>${escapeHtml(item.label || "—")}</strong>${item.href ? `<div class="mono muted">${escapeHtml(item.href)}</div>` : ""}</td><td>${escapeHtml(item.reason)}</td><td>${escapeHtml(item.pages ? pagesText({ occurrences: item.pages }) : "")}</td></tr>`).join("")}</tbody></table>`
    : '<div class="muted">Every discovered element was turned into a test.</div>';

  const crawl = result.crawl || null;
  const sitePages = result.pages || [];
  const siteMode = Boolean(crawl) && crawl.mode !== "single-page";
  const scopeText = crawl?.mode === "selected"
    ? `${sitePages.length} page(s) scanned, chosen by you${crawl.pagesFound ? ` from ${crawl.pagesFound} found by Find Pages` : ""}`
    : `${sitePages.length} page(s) scanned (limit ${crawl?.maxPages}, link depth ${crawl?.maxDepth})`;
  const statusPill = key => `<span class="pill ${key === "PASS" ? "pass" : key === "FAIL" ? "fail" : "not-verified"}">${escapeHtml((STATUS_LABELS[key] || { text: key }).text)}</span>`;
  const skippedUrls = crawl?.skippedUrls || [];
  const coverageNotes = [
    crawl?.timeLimitReached ? "The time limit was reached; some pages or checks were not run." : "",
    crawl?.robots?.found ? `robots.txt respected (${crawl.robots.rules} rule(s)).` : crawl?.robots ? "No robots.txt found." : "",
    crawl?.robots?.note || "",
    crawl?.rateLimit?.limited
      ? `The website rate-limited this scan (HTTP 429 Too Many Requests, ${crawl.rateLimit.events} time(s)). The agent paused ${crawl.rateLimit.pausedSeconds} s in total, continued one page at a time and retried throttled checks once; checks that were still throttled are NOT VERIFIED (RATE_LIMITED), not FAIL.`
      : ""
  ].filter(Boolean).join(" ");
  const pageRows = sitePages.map((pageInfo, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHtml(pageInfo.title || pageInfo.path)}</strong><div class="mono muted">${escapeHtml(pageInfo.path)}</div>${pageInfo.error ? `<div class="red">${escapeHtml(pageInfo.error)}</div>` : ""}</td><td>${pageInfo.depth}</td><td>${escapeHtml(pageInfo.httpStatus ?? "—")}</td><td>${statusPill(pageInfo.status)}</td><td>${pageInfo.summary.passed}</td><td>${pageInfo.summary.failed}</td><td>${pageInfo.summary.notVerified}</td><td>${pageInfo.summary.automationErrors}</td><td>${pageInfo.consoleErrorCount}</td></tr>`).join("");
  const skippedUrlRows = skippedUrls.length
    ? `<table class="validation-table" style="margin-top:10px"><thead><tr><th>#</th><th>URL</th><th>Reason</th><th>Found on</th></tr></thead><tbody>${skippedUrls.map((item, index) => `<tr><td>${index + 1}</td><td class="mono">${escapeHtml(item.url)}</td><td>${escapeHtml(item.reason)}</td><td class="mono">${escapeHtml(item.foundOn ? pathOf(item.foundOn) : "—")}</td></tr>`).join("")}</tbody></table>`
    : '<div class="muted">None.</div>';
  const coverageSection = siteMode ? `<section class="panel" id="coverage"><div class="panel-head"><h2>Site Coverage</h2><span class="count">${sitePages.length} page(s)</span></div>
<div class="panel-subtitle">${escapeHtml(scopeText)} in ${escapeHtml((crawl.viewports || []).join(" + "))} view. A check shared by several pages (header, footer) is run once and counted once. ${escapeHtml(coverageNotes)}</div>
<div class="table-wrap"><table class="validation-table"><thead><tr><th>#</th><th>Page</th><th>Depth</th><th>HTTP</th><th>Status</th><th>Pass</th><th>Fail</th><th>Not verified</th><th>Automation</th><th>Console errors</th></tr></thead><tbody>${pageRows}</tbody></table></div>
<details class="coverage-skipped"><summary><strong>${skippedUrls.length} discovered URL(s) not scanned</strong> (external sites, files, login/admin areas, robots.txt, limits)</summary>${skippedUrlRows}</details></section>` : "";

  const ringColor = statusKey === "PASS" ? "var(--green)" : statusKey === "FAIL" ? "var(--red)" : "var(--amber)";
  const share = count => (total ? (count / total) * 100 : 0).toFixed(2);
  const viewportText = (result.metadata?.viewports || []).length > 1
    ? result.metadata.viewports.map(item => `${item.name} ${item.width}×${item.height}`).join(" + ")
    : `${viewport.width} × ${viewport.height}`;
  const defectCount = failedTests.length ? defectGroups.size : 0;
  const navLinks = [
    ["summary", "Summary"],
    ["defects", `Defects${defectCount ? ` <b>${defectCount}</b>` : ""}`],
    ...(siteMode ? [["coverage", "Coverage"]] : []),
    ["issues", `Verification${automationIssues.length ? ` <b>${automationIssues.length}</b>` : ""}`],
    ["not-tested", "Not tested"],
    ["tests", "All checks"],
    ["meta", "Run info"]
  ].map(([id, label]) => `<a href="#${id}">${label}</a>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI QA Execution Report · ${escapeHtml(result.target)}</title>
<style>
:root{--bg:#f4f6fb;--panel:#ffffff;--panel-2:#f8fafd;--ink:#141b2d;--ink-2:#3b4558;--muted:#6b768a;--line:#e3e8f0;--blue:#3563e9;--blue-soft:#e9efff;--green:#13855b;--green-soft:#e4f6ee;--red:#c8364a;--red-soft:#fdebee;--amber:#a76b00;--amber-soft:#fff3d6;--purple:#6d4fd1;--purple-soft:#efeaff;--shadow:0 1px 2px rgba(16,24,40,.04),0 8px 24px rgba(16,24,40,.06);--radius:16px;--mono:ui-monospace,"Cascadia Code",Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0d1220;--panel:#151b2c;--panel-2:#1a2135;--ink:#e8ecf5;--ink-2:#c3cad8;--muted:#8d97ab;--line:#283149;--blue:#7d9cff;--blue-soft:#1e2a4d;--green:#43c48f;--green-soft:#123326;--red:#ff7486;--red-soft:#3a1a22;--amber:#f2b84b;--amber-soft:#36290f;--purple:#a991ff;--purple-soft:#2a2346;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.25)}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:76px}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 "Segoe UI Variable","Segoe UI",Inter,system-ui,-apple-system,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--blue)}.mono{font-family:var(--mono);font-size:12px;word-break:break-all}.muted{color:var(--muted);font-size:12.5px}.green{color:var(--green)}.red{color:var(--red)}.blue{color:var(--blue)}.amber{color:var(--amber)}.purple{color:var(--purple)}
.topbar{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--panel) 88%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.topbar-inner{max-width:1360px;margin:auto;padding:10px 24px;display:flex;align-items:center;gap:18px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;white-space:nowrap}.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--blue),var(--purple));display:grid;place-items:center;color:#fff;font-size:13px;font-weight:900}
.topnav{display:flex;gap:4px;overflow-x:auto;flex:1}.topnav a{color:var(--ink-2);text-decoration:none;font-weight:600;font-size:13px;padding:7px 11px;border-radius:9px;white-space:nowrap}.topnav a:hover{background:var(--panel-2);color:var(--ink)}.topnav a b{background:var(--red-soft);color:var(--red);border-radius:999px;padding:1px 7px;font-size:11px;margin-left:4px}
.shell{max-width:1360px;margin:auto;padding:24px}
.hero{display:grid;grid-template-columns:1fr auto;gap:28px;align-items:center;background:linear-gradient(135deg,#131b33 0%,#1f2f5c 55%,#33307a 100%);color:#fff;border-radius:22px;padding:30px 34px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.hero:after{content:"";position:absolute;right:-80px;top:-80px;width:280px;height:280px;border-radius:50%;background:radial-gradient(circle,rgba(125,156,255,.35),transparent 70%)}
.eyebrow{text-transform:uppercase;letter-spacing:1.6px;font-size:11px;font-weight:800;opacity:.72}.hero h1{margin:6px 0 6px;font-size:30px;letter-spacing:-.4px}.target{color:#c9d6ff;word-break:break-all;font-weight:600}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.chip{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:5px 12px;font-size:12px;color:#e2e8ff;white-space:nowrap}
.score{display:flex;align-items:center;gap:20px;position:relative;z-index:1}
.ring{width:132px;height:132px;border-radius:50%;background:conic-gradient(${ringColor} calc(${passRate} * 1%),rgba(255,255,255,.14) 0);display:grid;place-items:center}
.ring-inner{width:104px;height:104px;border-radius:50%;background:#18224a;display:flex;flex-direction:column;align-items:center;justify-content:center}.ring-inner strong{font-size:27px;line-height:1}.ring-inner span{font-size:11px;opacity:.75;margin-top:4px}
.status-badge{padding:9px 16px;border-radius:999px;font-weight:900;letter-spacing:.5px;white-space:nowrap;background:${statusKey === "PASS" ? "#dff8ec" : statusKey === "FAIL" ? "#ffe3e7" : "#fff2cf"};color:${statusKey === "PASS" ? "#0f6b47" : statusKey === "FAIL" ? "#a3263a" : "#8a5800"}}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin:20px 0 14px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.kpi:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--line)}.kpi.k-pass:before{background:var(--green)}.kpi.k-fail:before{background:var(--red)}.kpi.k-nv:before{background:var(--amber)}.kpi.k-auto:before{background:var(--purple)}.kpi.k-rate:before{background:var(--blue)}
.kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:.9px;color:var(--muted);font-weight:800}.kpi-value{font-size:30px;font-weight:850;margin-top:4px;letter-spacing:-.5px}
.distribution{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 18px;box-shadow:var(--shadow);margin-bottom:20px}
.dist-bar{display:flex;height:12px;border-radius:999px;overflow:hidden;background:var(--panel-2)}.dist-bar span{display:block;height:100%}.dist-legend{display:flex;gap:18px;flex-wrap:wrap;margin-top:10px;font-size:12.5px;color:var(--ink-2)}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
.bg-pass{background:var(--green)}.bg-fail{background:var(--red)}.bg-nv{background:var(--amber)}.bg-auto{background:var(--purple)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:22px;margin-bottom:20px}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}.panel h2{font-size:18px;margin:0;letter-spacing:-.2px}.panel-subtitle{color:var(--muted);font-size:13px;margin:4px 0 16px}
.count{background:var(--panel-2);border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700;color:var(--ink-2)}
.summary{display:grid;grid-template-columns:1.35fr .65fr;gap:20px}.summary .panel{margin-bottom:0}
.executive p{margin:0;color:var(--ink-2);font-size:14.5px}.summary-line{display:flex;justify-content:space-between;margin:18px 0 8px;color:var(--muted);font-size:13px}
.progress{height:10px;background:var(--panel-2);border-radius:999px;overflow:hidden}.progress>div{height:100%;background:${ringColor};border-radius:999px}
.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px}.fact{padding:12px 14px;background:var(--panel-2);border:1px solid var(--line);border-radius:12px}.fact .value{display:block;font-size:16px;font-weight:750;margin-top:3px;word-break:break-word}
.label{font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:800;display:block}
.severity-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.sev-card{border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--panel-2)}.sev-card strong{display:block;font-size:22px}.sev-critical strong{color:#a1172c}.sev-high strong{color:var(--red)}.sev-medium strong{color:var(--amber)}.sev-low strong{color:var(--blue)}
.env{margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}
.health-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.health-grid .panel{margin-bottom:20px}
.category-row{padding:11px 0;border-bottom:1px solid var(--line)}.category-row:last-child{border:0}.category-top{display:flex;justify-content:space-between;font-weight:650}
.category-bar,.chart-track{height:8px;background:var(--panel-2);border-radius:999px;margin:7px 0;overflow:hidden}.category-fill,.chart-fill{height:100%;background:linear-gradient(90deg,var(--blue),var(--purple));border-radius:999px}.category-meta{color:var(--muted);font-size:12px}
.chart-row{margin:13px 0}.chart-label{display:flex;justify-content:space-between;font-size:12.5px;font-weight:700}
.ai-panel{background:linear-gradient(135deg,var(--purple-soft),var(--panel));border-color:color-mix(in srgb,var(--purple) 30%,var(--line))}.ai-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ai-icon{width:32px;height:32px;border-radius:10px;background:var(--purple);color:#fff;display:grid;place-items:center;font-weight:900;font-size:12px}
.ai-note{padding:14px;background:var(--panel);border:1px dashed color-mix(in srgb,var(--purple) 40%,var(--line));border-radius:12px;color:var(--ink-2);margin-top:12px}
.defect-card{border:1px solid var(--line);border-left:4px solid var(--red);background:var(--panel);border-radius:14px;padding:16px 18px;margin:12px 0;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.defect-card.sev-medium{border-left-color:var(--amber)}.defect-card.sev-low{border-left-color:var(--blue)}.defect-card.auto{border-left-color:var(--amber)}
.defect-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px}.defect-head strong{font-size:15px}.issue-id{font-family:var(--mono);font-size:11.5px;font-weight:800;color:var(--muted);margin-right:10px}
.severity,.severity-mini,.pill{display:inline-block;border-radius:999px;padding:4px 10px;font-size:11px;font-weight:800;white-space:nowrap;letter-spacing:.2px}
.severity{background:var(--amber-soft);color:var(--amber)}.severity.high,.severity-mini.high{background:var(--red-soft);color:var(--red)}.severity.medium,.severity-mini.medium{background:var(--amber-soft);color:var(--amber)}.severity.low,.severity-mini.low{background:var(--blue-soft);color:var(--blue)}.severity.critical,.severity-mini.critical{background:#f9d5db;color:#8d1224}
.defect-grid,.detail-grid{display:grid;grid-template-columns:200px 1fr;gap:10px 18px;margin-top:14px}.defect-grid>div,.detail-grid>div{display:contents}.defect-grid>div>.label,.detail-grid>div>.label{padding-top:2px}
.evidence summary{cursor:pointer;color:var(--blue);font-weight:700;margin-top:12px}.evidence img,.evidence-link img{max-width:100%;border:1px solid var(--line);border-radius:12px;margin-top:12px;display:block}.evidence-link{display:block;max-width:760px}.evidence-link img{max-height:440px;object-fit:contain;object-position:left top}
.image-check-summary{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:14px;padding:12px;background:var(--panel-2);border:1px solid var(--line);border-radius:12px}.image-check-summary>div{display:flex;flex-direction:column;gap:2px}.image-check-summary strong{font-size:18px}
.empty-state{text-align:center;padding:30px;color:var(--muted);display:flex;flex-direction:column;gap:6px;align-items:center}.empty-state strong{color:var(--ink);font-size:15px}.empty-icon{width:46px;height:46px;border-radius:50%;background:var(--green-soft);color:var(--green);display:grid;place-items:center;font-size:22px;font-weight:900}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}.toolbar input,.toolbar select{border:1px solid var(--line);border-radius:10px;padding:9px 12px;background:var(--panel-2);color:var(--ink);font:inherit}.toolbar input{min-width:300px;flex:1}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}
table{width:100%;border-collapse:separate;border-spacing:0}th{position:sticky;top:0;text-align:left;background:var(--panel-2);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.7px;padding:11px 12px;border-bottom:1px solid var(--line);z-index:1}td{padding:12px;border-bottom:1px solid var(--line);vertical-align:top}
.test-group .test-row:hover{background:var(--panel-2)}.index{color:var(--muted);width:44px}
.pill.pass{background:var(--green-soft);color:var(--green)}.pill.fail{background:var(--red-soft);color:var(--red)}.pill.not-verified{background:var(--amber-soft);color:var(--amber)}.pill.automation-error{background:var(--purple-soft);color:var(--purple)}.pill.not-executed{background:var(--panel-2);color:var(--muted)}
.expand-btn{border:1px solid var(--line);background:var(--panel);color:var(--blue);border-radius:9px;padding:6px 11px;cursor:pointer;font-size:12px;font-weight:700}.expand-btn:hover{background:var(--blue-soft)}
.detail-row{display:none}.test-group.open .detail-row{display:table-row}.detail-content{background:var(--panel-2);border-left:3px solid var(--blue);padding:16px;border-radius:0 0 10px 10px}
.validation-details{margin-top:16px}.validation-heading{font-weight:800;margin-bottom:8px}.validation-table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}.validation-table th{position:static}.validation-table th,.validation-table td{padding:9px 10px;border-bottom:1px solid var(--line);font-size:12px;text-align:left}.validation-table tr:last-child td{border-bottom:0}.validation-table tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--panel-2) 60%,transparent)}
.observations{margin:10px 0 0;padding-left:18px;color:var(--ink-2);font-size:12.5px}
details>summary{cursor:pointer}.coverage-skipped summary{color:var(--ink-2);margin-top:14px}
.footer{text-align:center;color:var(--muted);font-size:12px;padding:6px 0 34px}
@media(max-width:1100px){.kpis{grid-template-columns:repeat(3,1fr)}.summary,.health-grid{grid-template-columns:1fr}.summary .panel{margin-bottom:20px}}
@media(max-width:760px){.shell{padding:14px}.hero{grid-template-columns:1fr;padding:24px}.score{justify-content:flex-start}.kpis{grid-template-columns:repeat(2,1fr)}.facts,.severity-grid{grid-template-columns:1fr 1fr}.defect-grid,.detail-grid{grid-template-columns:1fr}.toolbar input{min-width:100%}.brand span{display:none}.image-check-summary{grid-template-columns:1fr 1fr}}
@media print{.topbar,.toolbar,.expand-btn{display:none}body{background:#fff}.panel,.kpi,.distribution{box-shadow:none}.detail-row{display:table-row}.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<nav class="topbar"><div class="topbar-inner"><div class="brand"><div class="logo">QA</div><span>AI QA Agent</span></div><div class="topnav">${navLinks}</div></div></nav>
<main class="shell">
<header class="hero" id="summary">
  <div>
    <div class="eyebrow">Automated Web Quality Engineering</div>
    <h1>AI QA Execution Report</h1>
    <div class="target">${escapeHtml(result.target)}</div>
    <div class="chips"><span class="chip">Generated ${escapeHtml(formatDate(generatedAt))}</span><span class="chip">Duration ${escapeHtml(duration)}</span><span class="chip">${escapeHtml(browser.name)} ${escapeHtml(browser.version)}</span><span class="chip">${escapeHtml(viewportText)}</span>${siteMode ? `<span class="chip">${sitePages.length} page(s) scanned</span>` : ""}</div>
  </div>
  <div class="score">
    <div class="ring" title="Pass rate"><div class="ring-inner"><strong>${Math.round(summary.passRate)}%</strong><span>pass rate</span></div></div>
    <div class="status-badge">${statusIcon} ${escapeHtml(status)}</div>
  </div>
</header>
<section class="kpis">
<div class="kpi"><div class="kpi-label">Total Tests</div><div class="kpi-value">${total}</div></div>
<div class="kpi k-pass"><div class="kpi-label">Passed</div><div class="kpi-value green">${passed}</div>${validationPasses ? `<div class="muted">incl. ${validationPasses} form validation</div>` : ""}</div>
<div class="kpi k-fail"><div class="kpi-label">Failed</div><div class="kpi-value red">${failed}</div>${defectCount && defectCount !== failed ? `<div class="muted">${defectCount} distinct defect(s)</div>` : ""}</div>
<div class="kpi k-nv"><div class="kpi-label">Not Verified</div><div class="kpi-value amber">${notVerified}</div></div>
<div class="kpi k-auto"><div class="kpi-label">Automation Errors</div><div class="kpi-value purple">${automationErrors}</div></div>
<div class="kpi k-rate"><div class="kpi-label">Pass Rate</div><div class="kpi-value blue">${passRate}%</div></div>
</section>
<section class="distribution" aria-label="Outcome distribution">
  <div class="dist-bar">${passed ? `<span class="bg-pass" style="width:${share(passed)}%"></span>` : ""}${failed ? `<span class="bg-fail" style="width:${share(failed)}%"></span>` : ""}${notVerified ? `<span class="bg-nv" style="width:${share(notVerified)}%"></span>` : ""}${automationErrors ? `<span class="bg-auto" style="width:${share(automationErrors)}%"></span>` : ""}</div>
  <div class="dist-legend"><span><i class="dot bg-pass"></i>Passed ${passed}</span><span><i class="dot bg-fail"></i>Failed ${failed}</span><span><i class="dot bg-nv"></i>Not verified ${notVerified}</span><span><i class="dot bg-auto"></i>Automation errors ${automationErrors}</span></div>
</section>
<section class="summary">
<div class="panel executive"><div class="panel-head"><h2>Executive QA Summary</h2></div><p>${escapeHtml(aiSummary)}</p><div class="summary-line"><span>Resolved checks (pass or fail)</span><strong>${resolved}/${total}</strong></div><div class="progress"><div style="width:${completionRate}%"></div></div><div class="facts"><div class="fact"><span class="label">Page title</span><span class="value">${escapeHtml((discovery.title || "—").slice(0,45))}</span></div><div class="fact"><span class="label">Links discovered</span><span class="value">${discovery.links?.length || 0}${discovery.hiddenLinkCount ? ` <span class="muted">(${discovery.hiddenLinkCount} hidden)</span>` : ""}</span></div><div class="fact"><span class="label">Forms discovered</span><span class="value">${discovery.forms || 0}</span></div></div></div>
<div class="panel"><div class="panel-head"><h2>Defect Severity</h2></div><div class="panel-subtitle">Confirmed failures by impact</div><div class="severity-grid"><div class="sev-card sev-critical"><span class="label">Critical</span><strong>${severityCounts.Critical}</strong></div><div class="sev-card sev-high"><span class="label">High</span><strong>${severityCounts.High}</strong></div><div class="sev-card sev-medium"><span class="label">Medium</span><strong>${severityCounts.Medium}</strong></div><div class="sev-card sev-low"><span class="label">Low</span><strong>${severityCounts.Low}</strong></div></div><div class="env"><span class="label">Environment health</span><div style="margin-top:6px" class="${consoleErrors.length || networkErrors.length ? "red" : "green"}"><strong>${consoleErrors.length || networkErrors.length ? "Issues detected" : "Clean"}</strong></div><div class="category-meta" style="margin-top:4px">Console errors: ${consoleErrors.length} · Network failures: ${networkErrors.length}</div></div></div>
</section>
<div style="height:20px"></div>
<section class="panel" id="defects"><div class="panel-head"><h2>Defects & Evidence</h2>${defectCount ? `<span class="count">${defectCount} defect(s) · ${failed} failed check(s)</span>` : ""}</div><div class="panel-subtitle">Confirmed application failures. Checks that point at the same broken URL or image are grouped into one defect.</div>${defectRows}</section>
${coverageSection}
<section class="health-grid">
<div class="panel"><div class="panel-head"><h2>Category Health</h2></div><div class="panel-subtitle">Pass rate by test category</div>${categoryRows || '<div class="muted">No tests generated.</div>'}</div>
<div class="panel"><div class="panel-head"><h2>Category Chart</h2></div><div class="panel-subtitle">Visual health overview</div>${categoryChart || '<div class="muted">No category data.</div>'}</div>
</section>
<section class="panel ai-panel"><div class="ai-title"><div class="ai-icon">AI</div><h2 style="margin:0">AI Analysis</h2><span class="pill not-executed">Claude integration pending</span></div><div class="ai-note">${escapeHtml(aiSummary)}<br><br><strong>Planned Claude capabilities:</strong> root-cause analysis, risk prioritisation and recommended next actions.</div></section>
<section class="panel" id="issues">
<div class="panel-head"><h2>Automation & Verification Issues</h2>${automationIssues.length ? `<span class="count">${automationIssues.length}</span>` : ""}</div>
<div class="panel-subtitle">These are not confirmed application defects. They indicate that the current automation could not reliably verify the intended behavior.</div>
${automationIssues.length ? automationIssues.map((item, index) => `
  <article class="defect-card auto">
    <div class="defect-head">
      <div><span class="issue-id">AUTO-${String(index + 1).padStart(3, "0")}</span><strong>${escapeHtml(item.test.name)}</strong></div>
      <span class="severity">${escapeHtml(outcomeLabel(outcomeFor(item)))}</span>
    </div>
    <div class="defect-grid">
      <div><span class="label">Type</span><span>${escapeHtml(typeLabel(item.test.type))}</span></div>
      <div><span class="label">Finding</span><span>${escapeHtml(item.details || item.error || "Automation could not verify the result.")}</span></div>
      <div><span class="label">Classification</span><span>${escapeHtml(item.classification || "VERIFICATION INCOMPLETE")}</span></div>
      <div><span class="label">Before URL</span><span class="mono">${escapeHtml(item.beforeUrl || result.target)}</span></div>
    </div>
  </article>`).join("") : `<div class="empty-state"><div class="empty-icon">✓</div><strong>No unresolved verification issues</strong><span>All generated checks produced a resolved outcome.</span></div>`}
${notVerifiedTests.length ? `<div class="ai-note"><strong>${notVerifiedTests.length} test(s) were not verified.</strong> They are intentionally excluded from confirmed defect counts.</div>` : ""}
</section>
<section class="panel" id="not-tested"><div class="panel-head"><h2>Not Tested by Design</h2>${skippedElements.length ? `<span class="count">${skippedElements.length}</span>` : ""}</div><div class="panel-subtitle">Elements that were discovered but deliberately not turned into separate tests, and why. Safety: ${escapeHtml(safety.formsSubmitted ?? 0)} form(s) submitted · ${escapeHtml(safety.submitAttemptsBlocked ?? 0)} script submit attempt(s) cancelled · ${escapeHtml(safety.mutatingRequestsBlocked ?? 0)} state-changing request(s) blocked.</div><div class="table-wrap">${skippedRows}</div></section>
<section class="panel" id="tests"><div class="panel-head"><h2>Test Execution Details</h2><span class="count">${total} check(s)</span></div><div class="toolbar"><input id="search" placeholder="Search test cases or details…"><select id="status"><option value="ALL">All outcomes</option><option value="PASS">PASS</option><option value="FAIL">FAIL</option><option value="NOT_VERIFIED">NOT VERIFIED</option><option value="AUTOMATION_ERROR">AUTOMATION ERROR</option></select><select id="type"><option value="ALL">All types</option>${[...new Set(executionResults.map(x => x.test.type))].map(t => `<option value="${escapeHtml(t)}">${escapeHtml(typeLabel(t))}</option>`).join("")}</select>${(result.metadata?.viewports || []).length > 1 ? '<select id="viewport"><option value="ALL">All viewports</option><option value="desktop">Desktop</option><option value="mobile">Mobile</option></select>' : ""}</div><div class="table-wrap"><table><thead><tr><th>#</th><th>Test Case</th><th>Outcome</th><th>Severity</th><th>Details</th></tr></thead>${testRows}</table></div></section>
<section class="panel" id="meta"><div class="panel-head"><h2>Environment & Run Metadata</h2></div><div class="facts"><div class="fact"><span class="label">Target</span><span class="value mono">${escapeHtml(result.target)}</span></div><div class="fact"><span class="label">Browser</span><span class="value">${escapeHtml(browser.name)} ${escapeHtml(browser.version)}</span></div><div class="fact"><span class="label">Viewport</span><span class="value">${escapeHtml(viewportText)}</span></div><div class="fact"><span class="label">Started</span><span class="value">${escapeHtml(formatDate(result.metadata?.startedAt))}</span></div><div class="fact"><span class="label">Finished</span><span class="value">${escapeHtml(formatDate(result.metadata?.finishedAt))}</span></div><div class="fact"><span class="label">Run duration</span><span class="value">${escapeHtml(duration)}</span></div></div></section>
<div class="footer">AI QA Agent · Evidence-based Playwright web QA · Report generated locally · Forms are never submitted</div>
</main>
<script>
const groups=[...document.querySelectorAll('.test-group')];
const search=document.querySelector('#search');
const status=document.querySelector('#status');
const type=document.querySelector('#type');
const viewportSelect=document.querySelector('#viewport');
function filter(){const q=search.value.toLowerCase(),s=status.value,t=type.value,v=viewportSelect?viewportSelect.value:'ALL';groups.forEach(g=>{const text=g.innerText.toLowerCase();const okQ=!q||text.includes(q),okS=s==='ALL'||g.dataset.status===s,okT=t==='ALL'||g.dataset.type===t,okV=v==='ALL'||g.dataset.viewport===v;g.style.display=okQ&&okS&&okT&&okV?'':'none'})}
if(viewportSelect)viewportSelect.addEventListener('change',filter);
function toggleTest(btn){const group=btn.closest('.test-group');group.classList.toggle('open');btn.textContent=group.classList.contains('open')?'Hide':'Details'}
search.addEventListener('input',filter);status.addEventListener('change',filter);type.addEventListener('change',filter);
</script>${embed.script()}</body></html>`;
}

module.exports = { generateHtmlReport, severityFor, outcomeFor };
