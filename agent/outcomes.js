/**
 * Single source of truth for test outcomes, HTTP-status interpretation and
 * run summaries. The pipeline, report generator and dashboard all use these
 * helpers so their counts can never disagree.
 *
 * Every executed test ends in exactly one of four outcomes:
 *   PASS             - the check's claim is supported by evidence
 *   FAIL             - evidence of a genuine application defect
 *   NOT_VERIFIED     - the check ran, but evidence was insufficient either way
 *   AUTOMATION_ERROR - the agent itself could not perform the check
 */

const OUTCOMES = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  NOT_VERIFIED: "NOT_VERIFIED",
  AUTOMATION_ERROR: "AUTOMATION_ERROR"
});

const OUTCOME_LIST = Object.values(OUTCOMES);

// Older reports used VALIDATION_PASS / NOT_EXECUTED; map them onto the four outcomes.
const LEGACY_OUTCOMES = {
  VALIDATION_PASS: OUTCOMES.PASS,
  NOT_EXECUTED: OUTCOMES.NOT_VERIFIED
};

function normalizeOutcome(value) {
  const key = String(value || "").toUpperCase();
  if (OUTCOME_LIST.includes(key)) return key;
  if (LEGACY_OUTCOMES[key]) return LEGACY_OUTCOMES[key];
  return OUTCOMES.NOT_VERIFIED;
}

/**
 * Record a test outcome. `status` mirrors `outcome` so that consumers reading
 * either field see the same value.
 */
function setOutcome(result, outcome, classification, details) {
  const normalized = normalizeOutcome(outcome);
  result.outcome = normalized;
  result.status = normalized;
  result.classification = classification || normalized;
  if (details !== undefined) result.details = details;
  return result;
}

/*
 * HTTP status interpretation.
 *
 * 999 is a non-standard status used by bot protection (e.g. LinkedIn).
 * 401/403/429 are frequently returned to automated clients or anonymous users
 * even when the page works for real visitors. None of these alone is proof
 * that a link is broken, so they are reported as NOT_VERIFIED.
 */
const RESTRICTED_STATUSES = new Set([401, 403, 429, 999]);

function isSuccessfulHttpStatus(status) {
  return Number.isFinite(status) && status >= 200 && status < 400;
}

function isRestrictedHttpStatus(status) {
  return Number.isFinite(status) && RESTRICTED_STATUSES.has(status);
}

function isDefinitiveHttpFailure(status) {
  return Number.isFinite(status) && status >= 400 && !RESTRICTED_STATUSES.has(status);
}

/** Returns "ok" | "restricted" | "failure" | "unknown". */
function classifyHttpStatus(status) {
  if (isSuccessfulHttpStatus(status)) return "ok";
  if (isRestrictedHttpStatus(status)) return "restricted";
  if (isDefinitiveHttpFailure(status)) return "failure";
  return "unknown";
}

function summarize(results = []) {
  const counts = { PASS: 0, FAIL: 0, NOT_VERIFIED: 0, AUTOMATION_ERROR: 0 };
  let validationPasses = 0;

  for (const result of results) {
    const outcome = normalizeOutcome(result.outcome ?? result.status);
    counts[outcome] += 1;
    if (outcome === OUTCOMES.PASS && result.test?.type === "form_submit") validationPasses += 1;
  }

  const total = results.length;
  const resolved = counts.PASS + counts.FAIL;

  return {
    total,
    passed: counts.PASS,
    failed: counts.FAIL,
    notVerified: counts.NOT_VERIFIED,
    automationErrors: counts.AUTOMATION_ERROR,
    // Subset of `passed`: form-validation checks that passed. Never add this to `passed`.
    validationPasses,
    // Kept for JSON compatibility; every planned test now resolves to one of the four outcomes.
    notExecuted: 0,
    passRate: total ? Number(((counts.PASS / total) * 100).toFixed(1)) : 0,
    verifiedPassRate: resolved ? Number(((counts.PASS / resolved) * 100).toFixed(1)) : 0
  };
}

/**
 * Overall run status.
 *   FAIL               - at least one confirmed defect
 *   PASS_WITH_WARNINGS - no defects, but some checks were not verified or errored
 *   PASS               - every check passed
 *   NOT_VERIFIED       - nothing was executed, so nothing can be claimed
 */
function overallStatus(summary) {
  if (!summary || !summary.total) return "NOT_VERIFIED";
  if (summary.failed > 0) return "FAIL";
  if (summary.notVerified > 0 || summary.automationErrors > 0) return "PASS_WITH_WARNINGS";
  return "PASS";
}

module.exports = {
  OUTCOMES,
  OUTCOME_LIST,
  normalizeOutcome,
  setOutcome,
  isSuccessfulHttpStatus,
  isRestrictedHttpStatus,
  isDefinitiveHttpFailure,
  classifyHttpStatus,
  summarize,
  overallStatus
};
