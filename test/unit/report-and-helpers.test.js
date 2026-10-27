const test = require("node:test");
const assert = require("node:assert/strict");
const { generateHtmlReport, severityFor } = require("../../agent/report-generator");
const { compareSnapshots, validateMailto, validateTel } = require("../../agent/test-executor");
const { summarize, overallStatus } = require("../../agent/outcomes");

function kpi(html, label) {
  const match = new RegExp(`<div class="kpi-label">${label}</div><div class="kpi-value[^"]*">([^<]+)</div>`).exec(html);
  return match ? match[1] : null;
}

const results = [
  { test: { name: "Page loads - Home", type: "page_load" }, outcome: "PASS", details: "ok" },
  { test: { name: "Form validation - Send", type: "form_submit" }, outcome: "PASS", details: "ok", validation: { fields: [{ label: "Email", type: "email", required: true, emptyRejected: true, invalidSample: "not-an-email", invalidRejected: true, testValue: "qa@example.com", accepted: true }], observations: ["note <b>"] } },
  { test: { name: "Link works - Broken", type: "link" }, outcome: "FAIL", details: "HTTP 404", element: { visible: true } },
  { test: { name: "Hidden link - Old", type: "link" }, outcome: "FAIL", details: "HTTP 404", element: { visible: false, hiddenReason: "display:none" } },
  { test: { name: "Link works - Partner", type: "link" }, outcome: "NOT_VERIFIED", details: "HTTP 999" },
  { test: { name: "Button works - X", type: "button" }, outcome: "AUTOMATION_ERROR", details: "could not click" },
  // Legacy report row: must be counted as PASS, never as a separate bucket.
  { test: { name: "Legacy form", type: "form_submit" }, outcome: "VALIDATION_PASS", status: "PASS" }
];

test("report KPIs match the shared summary exactly", () => {
  const html = generateHtmlReport({ target: "https://site.test", executionResults: results, summary: { total: 999, passed: 999 } });
  const summary = summarize(results);
  assert.equal(kpi(html, "Total Tests"), String(summary.total), "stale summary objects are ignored");
  assert.equal(kpi(html, "Passed"), String(summary.passed));
  assert.equal(kpi(html, "Failed"), String(summary.failed));
  assert.equal(kpi(html, "Not Verified"), String(summary.notVerified));
  assert.equal(kpi(html, "Automation Errors"), String(summary.automationErrors));
  assert.equal(kpi(html, "Pass Rate"), `${summary.passRate.toFixed(1)}%`);
  assert.equal(summary.passed + summary.failed + summary.notVerified + summary.automationErrors, summary.total);
});

test("report status badge matches the overall status and is never a check mark on FAIL", () => {
  const html = generateHtmlReport({ target: "https://site.test", executionResults: results });
  assert.equal(overallStatus(summarize(results)), "FAIL");
  assert.match(html, /<div class="status-badge">✕ FAIL<\/div>/);

  const clean = generateHtmlReport({ target: "https://site.test", executionResults: [results[0]] });
  assert.match(clean, /<div class="status-badge">✓ PASS<\/div>/);

  const warn = generateHtmlReport({ target: "https://site.test", executionResults: [results[0], results[4]] });
  assert.match(warn, /<div class="status-badge">! PASS WITH WARNINGS<\/div>/);
});

test("report renders field-level form results, hidden-element details and skipped elements, escaped", () => {
  const html = generateHtmlReport({
    target: "https://site.test",
    executionResults: results,
    skippedElements: [{ kind: "input", label: "<honeypot>", reason: "Not visible" }]
  });
  assert.match(html, /Field-level results \(form was not submitted\)/);
  assert.match(html, /qa@example\.com/);
  assert.match(html, /Hidden — display:none/);
  assert.match(html, /Not Tested by Design/);
  assert.ok(html.includes("&lt;honeypot&gt;"));
  assert.ok(html.includes("note &lt;b&gt;"));
  assert.ok(!html.includes("<honeypot>"));
});

test("severity: hidden broken links are Medium, visible broken links High, non-failures none", () => {
  assert.equal(severityFor(results[2]), "High");
  assert.equal(severityFor(results[3]), "Medium");
  assert.equal(severityFor(results[4]), "");
  assert.equal(severityFor(results[5]), "");
});

test("mailto and tel links are validated by format", () => {
  assert.deepEqual(validateMailto("mailto:hello@example.com?subject=Hi").invalid, []);
  assert.deepEqual(validateMailto("mailto:not-an-address").invalid, ["not-an-address"]);
  assert.equal(validateMailto("mailto:a%@x.com").invalid.length, 1, "malformed escapes are a FAIL, not an exception");
  assert.equal(validateTel("tel:%").valid, false);
  assert.equal(validateTel("tel:+1 (555) 555-0123").valid, true);
  assert.equal(validateTel("tel:call-us").valid, false);
});

test("snapshot comparison reports each kind of change separately", () => {
  const base = { url: "https://a.test/", hash: "", title: "A", scrollY: 0, bodyText: "x", buttons: [], expanded: [], inputs: [], dialogs: 0, activeElements: [], carouselState: [], visibleImages: [], visibleTextLength: 1 };
  assert.deepEqual(compareSnapshots(base, { ...base }), []);
  assert.deepEqual(compareSnapshots(base, { ...base, expanded: ["true"] }), ["expanded/collapsed state changed"]);
  assert.deepEqual(compareSnapshots(base, { ...base, hash: "#x", scrollY: 400 }), ["URL fragment changed", "scroll position changed"]);
});
