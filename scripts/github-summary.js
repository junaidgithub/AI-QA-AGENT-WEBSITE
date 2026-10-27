/**
 * Writes a short Markdown summary of the latest scan for the GitHub Actions
 * run page (the "Summary" tab). Outside GitHub it prints to the console.
 *
 * Usage:
 *   node scripts/github-summary.js           write the summary
 *   node scripts/github-summary.js --check   exit with code 1 if the scan found defects
 */
const fs = require("fs");
const path = require("path");
const { reportsDir } = require("../agent/paths");

const reportPath = path.join(reportsDir(), "ai-qa-report.json");

function minutes(ms) {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} sec` : `${seconds} sec`;
}

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "") // terminal colour codes from browser logs
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSummary(report) {
  const s = report.summary;
  const icon = { PASS: "✅", FAIL: "❌", PASS_WITH_WARNINGS: "⚠️", NOT_VERIFIED: "❔" }[report.status] || "";
  const lines = [
    `## ${icon} AI QA Scan: ${report.status.replace(/_/g, " ")}`,
    "",
    `**Website:** ${report.target}  `,
    `**Pages scanned:** ${report.pages ? report.pages.length : 1}${report.crawl?.viewports ? ` (${report.crawl.viewports.join(" + ")})` : ""}  `,
    `**Duration:** ${minutes(report.metadata?.durationMs)}`,
    "",
    "| Total | Passed | Failed | Not verified | Automation errors | Pass rate |",
    "|---:|---:|---:|---:|---:|---:|",
    `| ${s.total} | ${s.passed} | ${s.failed} | ${s.notVerified} | ${s.automationErrors} | ${s.passRate}% |`,
    ""
  ];

  const failures = (report.executionResults || []).filter(result => result.outcome === "FAIL");
  if (failures.length) {
    lines.push("### Failed checks", "", "| Check | Found on | Finding |", "|---|---|---|");
    for (const result of failures.slice(0, 25)) {
      const pages = result.occurrences?.length ? `${result.occurrences.length} page(s)` : "1 page";
      lines.push(`| ${escapeCell(result.test.name)} | ${pages} | ${escapeCell((result.details || "").slice(0, 160))} |`);
    }
    if (failures.length > 25) lines.push("", `…and ${failures.length - 25} more in the full report.`);
    lines.push("");
  }

  if (report.crawl?.rateLimit?.limited) {
    lines.push(`> The website rate-limited this scan (HTTP 429). Throttled checks are NOT VERIFIED, not FAIL.`, "");
  }
  lines.push("Download **qa-report** under *Artifacts* below and open `ai-qa-report.html` for the full report with evidence.");
  return lines.join("\n");
}

function main() {
  if (!fs.existsSync(reportPath)) {
    const message = "## ❔ AI QA Scan: no report\n\nThe scan did not produce a report. Open the \"Run QA scan\" step log for the error.";
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    console.log(message);
    process.exit(process.argv.includes("--check") ? 1 : 0);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  if (process.argv.includes("--check")) {
    if (report.status === "FAIL") {
      console.error(`The scan found ${report.summary.failed} failed check(s). See the run summary and the qa-report artifact.`);
      process.exit(1);
    }
    console.log(`Scan status: ${report.status}`);
    return;
  }

  const summary = buildSummary(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
}

if (require.main === module) main();

module.exports = { buildSummary };
