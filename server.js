const express = require("express");
const fs = require("fs");
const path = require("path");
const { runPipeline } = require("./agent/ai-qa-pipeine");
const { reportsDir } = require("./agent/paths");
const { mapSite } = require("./agent/site-map");
const { isSameSite } = require("./agent/crawl-rules");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let runInProgress = false;
let runProgress = null;

/**
 * Optional scan settings from the request body. Without them the run is a
 * single-page desktop scan, exactly as before. Returns an error string or the options.
 */
function readScanOptions(body) {
  const options = {};
  if (body.maxPages !== undefined) {
    const maxPages = Number(body.maxPages);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) return { error: "maxPages must be a whole number between 1 and 100" };
    options.maxPages = maxPages;
  }
  if (body.maxDepth !== undefined) {
    const maxDepth = Number(body.maxDepth);
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) return { error: "maxDepth must be a whole number between 0 and 10" };
    options.maxDepth = maxDepth;
  }
  if (body.mobile !== undefined) options.mobile = body.mobile === true || body.mobile === "true";
  if (body.singlePage === true || body.singlePage === "true") options.singlePage = true;
  if (body.pages !== undefined) {
    if (!Array.isArray(body.pages) || !body.pages.length || body.pages.length > 200) return { error: "pages must be a list of 1 to 200 URLs" };
    for (const page of body.pages) {
      let parsed;
      try { parsed = new URL(page); } catch { return { error: `Not a valid page URL: ${page}` }; }
      if (!["http:", "https:"].includes(parsed.protocol) || !isSameSite(page, body.url)) return { error: `Page is not on the scanned website: ${page}` };
    }
    options.pages = body.pages;
    if (Array.isArray(body.notSelected)) options.notSelected = body.notSelected.filter(page => typeof page === "string").slice(0, 1000);
    if (Number.isInteger(body.pagesFound)) options.pagesFound = body.pagesFound;
  }
  if (body.maxMinutes !== undefined) {
    const maxMinutes = Number(body.maxMinutes);
    if (!Number.isFinite(maxMinutes) || maxMinutes < 1 || maxMinutes > 120) return { error: "maxMinutes must be between 1 and 120" };
    options.maxDurationMs = Math.round(maxMinutes * 60 * 1000);
  }
  return { options };
}

function validateUrl(url) {
  if (!url) return "URL is required";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "Only HTTP and HTTPS URLs are supported";
  } catch {
    return "Please enter a valid URL";
  }
  return null;
}

// "Find Pages": discover the site's pages without testing, so the user can choose what to test.
app.post("/api/map", async (req, res) => {
  const { url } = req.body || {};
  const urlError = validateUrl(url);
  if (urlError) return res.status(400).json({ error: urlError });
  if (runInProgress) {
    return res.status(409).json({ error: "A QA run is already in progress. Please wait for it to finish." });
  }

  runInProgress = true;
  runProgress = { phase: "finding", pagesFound: 0, maxPages: 200, currentUrl: url };
  try {
    const map = await mapSite(url, { onProgress: update => { runProgress = update; } });
    if (map.error && !map.totalFound) return res.status(502).json({ error: `The website could not be loaded: ${map.error}` });
    res.json(map);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    runInProgress = false;
    runProgress = null;
  }
});

app.post("/api/run", async (req, res) => {
  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "Only HTTP and HTTPS URLs are supported" });
    }
  } catch {
    return res.status(400).json({ error: "Please enter a valid URL" });
  }

  const { error: optionsError, options } = readScanOptions(req.body || {});
  if (optionsError) {
    return res.status(400).json({ error: optionsError });
  }

  if (runInProgress) {
    return res.status(409).json({ error: "A QA run is already in progress. Please wait for it to finish." });
  }

  runInProgress = true;
  runProgress = { phase: "starting", pagesScanned: 0, maxPages: options.singlePage ? 1 : options.maxPages || 1, testsRun: 0, currentUrl: url };

  try {
    const result = await runPipeline(url, {
      ...options,
      onProgress: update => { runProgress = update; }
    });
    res.json({
      ...result,
      reportUrl: "/api/report",
      jsonReportUrl: "/api/report.json"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    runInProgress = false;
    runProgress = null;
  }
});

app.get("/api/status", (req, res) => {
  res.json(runInProgress ? { running: true, progress: runProgress } : { running: false });
});

function sendReport(fileName) {
  return (req, res) => {
    const filePath = path.join(reportsDir(), fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "No report has been generated yet. Run a QA scan first." });
    }
    res.sendFile(filePath);
  };
}

app.get("/api/report", sendReport("ai-qa-report.html"));

app.get("/api/report.json", sendReport("ai-qa-report.json"));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI QA Agent running at http://localhost:${PORT}`);
  });
}

module.exports = { app };
