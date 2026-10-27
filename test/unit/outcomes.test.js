const test = require("node:test");
const assert = require("node:assert/strict");
const {
  OUTCOMES,
  normalizeOutcome,
  setOutcome,
  classifyHttpStatus,
  isDefinitiveHttpFailure,
  summarize,
  overallStatus
} = require("../../agent/outcomes");

const result = (outcome, type = "link") => ({ outcome, test: { type } });

test("only four outcomes exist; legacy values are mapped", () => {
  assert.deepEqual(Object.values(OUTCOMES), ["PASS", "FAIL", "NOT_VERIFIED", "AUTOMATION_ERROR"]);
  assert.equal(normalizeOutcome("VALIDATION_PASS"), "PASS");
  assert.equal(normalizeOutcome("NOT_EXECUTED"), "NOT_VERIFIED");
  // Unknown or missing outcomes must never be counted as PASS.
  assert.equal(normalizeOutcome(undefined), "NOT_VERIFIED");
  assert.equal(normalizeOutcome("weird"), "NOT_VERIFIED");
});

test("setOutcome keeps status and outcome identical", () => {
  const r = setOutcome({}, "NOT_VERIFIED", "NOT_VERIFIED", "why");
  assert.equal(r.status, r.outcome);
  assert.equal(r.details, "why");
});

test("HTTP 999 and access restrictions are not definitive failures", () => {
  for (const status of [999, 401, 403, 429]) {
    assert.equal(classifyHttpStatus(status), "restricted", `status ${status}`);
    assert.equal(isDefinitiveHttpFailure(status), false);
  }
  assert.equal(classifyHttpStatus(404), "failure");
  assert.equal(classifyHttpStatus(500), "failure");
  assert.equal(classifyHttpStatus(200), "ok");
  assert.equal(classifyHttpStatus(301), "ok");
  assert.equal(classifyHttpStatus(null), "unknown");
});

test("summary counts always add up to the total", () => {
  const results = [
    result("PASS"), result("PASS", "form_submit"), result("FAIL"),
    result("NOT_VERIFIED"), result("AUTOMATION_ERROR"), result("VALIDATION_PASS", "form_submit")
  ];
  const summary = summarize(results);
  assert.equal(summary.total, 6);
  assert.equal(summary.passed + summary.failed + summary.notVerified + summary.automationErrors, summary.total);
  assert.equal(summary.passed, 3);
  assert.equal(summary.validationPasses, 2, "validation passes are a subset of passed");
  assert.equal(summary.passRate, 50);
  assert.equal(summary.verifiedPassRate, 75);
});

test("overall status reflects defects and unresolved checks", () => {
  assert.equal(overallStatus(summarize([])), "NOT_VERIFIED", "zero tests is never a PASS");
  assert.equal(overallStatus(summarize([result("PASS")])), "PASS");
  assert.equal(overallStatus(summarize([result("PASS"), result("NOT_VERIFIED")])), "PASS_WITH_WARNINGS");
  assert.equal(overallStatus(summarize([result("PASS"), result("AUTOMATION_ERROR")])), "PASS_WITH_WARNINGS");
  assert.equal(overallStatus(summarize([result("PASS"), result("NOT_VERIFIED"), result("FAIL")])), "FAIL");
});
