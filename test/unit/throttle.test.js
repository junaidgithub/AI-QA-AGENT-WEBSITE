const test = require("node:test");
const assert = require("node:assert/strict");
const { SiteThrottle, parseRetryAfter, isPageLoadTimeout } = require("../../agent/throttle");

test("Retry-After accepts seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("5"), 5000);
  assert.equal(parseRetryAfter("1.5"), 1500);
  const now = Date.parse("2026-10-16T10:00:00Z");
  assert.equal(parseRetryAfter("Fri, 16 Oct 2026 10:00:20 GMT", now), 20000);
  assert.equal(parseRetryAfter(""), null);
  assert.equal(parseRetryAfter("soon"), null);
});

test("a 429 pauses the scan (capped) and drops to one page at a time", () => {
  const throttle = new SiteThrottle({ maxPauseMs: 60000 });
  assert.equal(throttle.concurrency(3), 3);
  assert.equal(throttle.noteResponse(200, null), false);
  assert.equal(throttle.noteResponse(429, "3600"), true);
  assert.equal(throttle.limited, true);
  assert.equal(throttle.concurrency(3), 1);
  const pause = throttle.pausedUntil - Date.now();
  assert.ok(pause > 55000 && pause <= 60000, `pause ${pause} is capped at 60 s`);
  assert.equal(throttle.summary().events, 1);
});

test("timeouts only count as throttling once the site has rate-limited us", () => {
  const throttle = new SiteThrottle({ timeoutPauseMs: 10 });
  assert.equal(throttle.noteTimeout(), false, "a slow page alone is not rate limiting");
  throttle.noteResponse(429, "0");
  assert.equal(throttle.noteTimeout(), true);
  assert.ok(isPageLoadTimeout({ error: "page.goto: Timeout 30000ms exceeded." }));
  assert.ok(!isPageLoadTimeout({ error: "locator.click: Timeout 8000ms exceeded." }));
});

test("wait() resolves after the pause", async () => {
  const throttle = new SiteThrottle();
  throttle.noteResponse(429, "0.2");
  const started = Date.now();
  await throttle.wait();
  assert.ok(Date.now() - started >= 150);
});
