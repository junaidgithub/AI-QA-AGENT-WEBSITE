/**
 * Polite rate-limit handling shared by all workers of one scan.
 *
 * When a site answers HTTP 429 (Too Many Requests), every worker pauses for
 * the time the site asks for (Retry-After, capped), and the scan continues
 * one page at a time. Throttled checks are retried once by the pipeline.
 */

const DEFAULT_PAUSE_MS = 30 * 1000;
const MAX_PAUSE_MS = 60 * 1000;
const TIMEOUT_PAUSE_MS = 10 * 1000;

/** Retry-After is either seconds or an HTTP date. Returns milliseconds or null. */
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function isPageLoadTimeout(result) {
  return /page\.goto: Timeout|Navigation timeout|net::ERR_TIMED_OUT/i.test(`${result?.error || ""} ${result?.details || ""}`);
}

class SiteThrottle {
  constructor(options = {}) {
    this.defaultPauseMs = options.defaultPauseMs ?? DEFAULT_PAUSE_MS;
    this.maxPauseMs = options.maxPauseMs ?? MAX_PAUSE_MS;
    this.timeoutPauseMs = options.timeoutPauseMs ?? TIMEOUT_PAUSE_MS;
    this.pausedUntil = 0;
    this.limited = false;
    this.events = 0;
    this.pausedMs = 0;
    this.retries = 0;
  }

  pauseFor(ms) {
    const until = Date.now() + Math.max(0, Math.min(this.maxPauseMs, ms));
    if (until > this.pausedUntil) {
      this.pausedMs += until - Math.max(this.pausedUntil, Date.now());
      this.pausedUntil = until;
    }
  }

  /** Record an HTTP status (and Retry-After header). Returns true when it was a rate-limit response. */
  noteResponse(status, retryAfter) {
    if (status !== 429) return false;
    this.limited = true;
    this.events += 1;
    this.pauseFor(parseRetryAfter(retryAfter) ?? this.defaultPauseMs);
    return true;
  }

  /** A page that did not load in time while the site is throttling us is treated the same way. */
  noteTimeout() {
    if (!this.limited) return false;
    this.events += 1;
    this.pauseFor(this.timeoutPauseMs);
    return true;
  }

  async wait() {
    const ms = this.pausedUntil - Date.now();
    if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
  }

  concurrency(base) {
    return this.limited ? 1 : base;
  }

  summary() {
    return { limited: this.limited, events: this.events, pausedSeconds: Math.round(this.pausedMs / 1000), retries: this.retries };
  }
}

module.exports = { SiteThrottle, parseRetryAfter, isPageLoadTimeout };
