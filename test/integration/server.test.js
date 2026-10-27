/**
 * HTTP API tests for server.js: validation, status, report routes and a
 * real /api/run against the local fixture site.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.QA_REPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qa-agent-server-"));

const { app } = require("../../server");
const { startFixtureServer } = require("../fixtures/server");

let server;
let base;
let fixture;

test.before(async () => {
  fixture = await startFixtureServer();
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await fixture.close();
});

const post = body => fetch(`${base}/api/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("dashboard is served", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Execution Time/);
  assert.match(html, /id="notVerified"/);
});

test("input validation", async () => {
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ url: "not a url" })).status, 400);
  assert.equal((await post({ url: "ftp://example.com" })).status, 400);
});

test("report routes return 404 JSON before any run", async () => {
  const response = await fetch(`${base}/api/report.json`);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /No report/);
});

test("a run returns a consistent summary and the reports become available", async () => {
  const original = console.log;
  console.log = () => {};
  let response;
  try {
    response = await post({ url: `${fixture.baseUrl}/clean.html` });
  } finally {
    console.log = original;
  }
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, "PASS");
  assert.equal(data.reportUrl, "/api/report");
  const s = data.summary;
  assert.equal(s.passed + s.failed + s.notVerified + s.automationErrors, s.total);

  assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), { running: false });

  const html = await fetch(`${base}/api/report`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /AI QA Execution Report/);
  const json = await (await fetch(`${base}/api/report.json`)).json();
  assert.equal(json.summary.total, s.total);
});

test("scan options are validated", async () => {
  for (const bad of [{ maxPages: 0 }, { maxPages: 101 }, { maxPages: "abc" }, { maxPages: 2.5 }, { maxDepth: 11 }]) {
    const response = await post({ url: `${fixture.baseUrl}/clean.html`, ...bad });
    assert.equal(response.status, 400, JSON.stringify(bad));
  }
});

test("a site scan reports live progress through /api/status", async () => {
  const original = console.log;
  console.log = () => {};
  const seen = [];
  let done = false;
  const run = post({ url: `${fixture.baseUrl}/multi/index.html`, maxPages: 3, mobile: false }).finally(() => { done = true; });
  try {
    while (!done) {
      const status = await (await fetch(`${base}/api/status`)).json();
      if (status.running && status.progress) seen.push(status.progress);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  } finally {
    console.log = original;
  }
  const data = await (await run).json();
  assert.equal(data.crawl.mode, "site");
  assert.equal(data.pages.length, 3);
  assert.ok(seen.length > 0, "progress was visible while running");
  assert.ok(seen.some(progress => progress.maxPages === 3 && progress.pagesScanned >= 1));
  assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), { running: false });
});
