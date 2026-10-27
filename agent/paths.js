const path = require("path");

/** Where reports and screenshots are written. Defaults to <project>/reports. */
function reportsDir() {
  return process.env.QA_REPORTS_DIR
    ? path.resolve(process.env.QA_REPORTS_DIR)
    : path.join(__dirname, "..", "reports");
}

module.exports = { reportsDir };
