const fs = require("fs");
const path = require("path");
const { reportsDir: getReportsDir } = require("./paths");
const { launchBrowser, newQaContext, installMutationGuard } = require("./browser");
const { ensureDomHelpers } = require("./dom-helpers");
const { runFormValidation } = require("./form-validator");
const { hasSideEffectLabel, hasSideEffectLink } = require("./ai-test-planner");
const { OUTCOMES, setOutcome, classifyHttpStatus } = require("./outcomes");
const { DESKTOP } = require("./viewports");

const ACTION_TIMEOUT = 8000;
const OBSERVATION_TIMEOUT = 5000;
const DESTINATION_CHECK_TIMEOUT = 10000;
const NOISE_SAMPLES = 5;
const NOISE_INTERVAL_MS = 500;
const QUICK_OBSERVATION_MS = 250;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return String(value || "").replace(/\/$/, "");
  }
}

function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function resolveUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

async function checkHttpDestination(context, destination) {
  if (!isHttpUrl(destination)) return { checked: false, status: null, url: destination, error: null };
  try {
    const response = await context.request.get(destination, {
      timeout: DESTINATION_CHECK_TIMEOUT,
      maxRedirects: 5,
      failOnStatusCode: false
    });
    return {
      checked: true,
      status: response.status(),
      url: response.url() || destination,
      error: null
    };
  } catch (error) {
    return { checked: true, status: null, url: destination, error: cleanText(error.message).slice(0, 200) };
  }
}

function describeHttp(check) {
  if (!check) return "HTTP check unavailable";
  if (check.status !== null) return `HTTP ${check.status}`;
  return `request failed${check.error ? `: ${check.error}` : ""}`;
}

/**
 * Apply the outcome implied by a direct HTTP check of a destination.
 * `how` explains why a direct request was used (hidden link, click blocked...).
 */
// Statuses that other websites commonly return to automated requests (but not to browsers).
const BOT_REJECTION_STATUSES = new Set([400, 405, 406]);

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/**
 * Outcome of a direct (non-browser) request to a destination. On other websites,
 * 400/405/406 to an automated request is treated like bot protection: not proof of a broken link.
 */
function applyDestinationOutcome(result, check, how) {
  result.destinationCheck = check;
  let verdict = classifyHttpStatus(check?.status);
  const external = hostOf(check?.url) && hostOf(check?.url) !== hostOf(result.beforeUrl);
  if (verdict === "failure" && external && BOT_REJECTION_STATUSES.has(check.status)) verdict = "restricted";
  const where = check?.url || "unknown destination";
  if (verdict === "ok") {
    return setOutcome(result, OUTCOMES.PASS, "DESTINATION_REACHABLE", `${how} Destination responded with HTTP ${check.status}: ${where}.`);
  }
  if (verdict === "failure") {
    return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE", `${how} Destination returned HTTP ${check.status}: ${where}.`);
  }
  if (verdict === "restricted") {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `${how} Destination returned HTTP ${check.status} (access restriction or bot protection, e.g. 999), which is not proof that the link is broken: ${where}.`);
  }
  return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `${how} Destination could not be confirmed (${describeHttp(check)}): ${where}.`);
}

async function safeScreenshot(page, prefix) {
  try {
    const reportsDir = getReportsDir();
    fs.mkdirSync(reportsDir, { recursive: true });
    const screenshotPath = path.join(
      reportsDir,
      `${prefix}-${Date.now()}.png`
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  } catch {
    return null;
  }
}

/** Visibility as a user would experience it: Playwright's check plus our own reasons. */
async function elementState(locator) {
  const playwrightVisible = await locator.isVisible().catch(() => false);
  const details = await locator.evaluate(el => ({
    hiddenReason: window.__qa ? window.__qa.hiddenReason(el) : null,
    name: window.__qa ? window.__qa.elementName(el) : (el.innerText || "").trim(),
    href: el.href || null,
    rawHref: el.getAttribute("href"),
    disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true"
  })).catch(() => ({ hiddenReason: "not attached to the page", name: "", href: null, rawHref: null, disabled: false }));
  const hiddenReason = details.hiddenReason || (playwrightVisible ? null : "not visible");
  return { ...details, visible: !hiddenReason, hiddenReason };
}

let markerCounter = 0;

/**
 * Locate a specific link. Matching by destination (plus label) avoids
 * the old behaviour of always picking the first link with a given label, and
 * visible matches win over hidden duplicates.
 */
async function findLink(page, test) {
  const marker = `qa-link-${process.pid}-${(markerCounter += 1)}`;
  const strategy = await page.evaluate(({ href, text, marker }) => {
    const qa = window.__qa;
    const normalize = value => {
      try {
        const url = new URL(value, location.href);
        if (url.hash === "#") url.hash = "";
        return url.href.replace(/\/$/, "");
      } catch {
        return String(value || "");
      }
    };
    const wanted = href ? normalize(href) : null;
    const wantedText = (text || "").toLowerCase();
    const candidates = [...document.querySelectorAll("a[href]")].map(anchor => ({
      anchor,
      hrefMatch: Boolean(wanted) && normalize(anchor.href) === wanted,
      textMatch: Boolean(wantedText) && qa.elementName(anchor).toLowerCase() === wantedText,
      visible: !qa.hiddenReason(anchor)
    }));
    const score = c => (c.hrefMatch ? 4 : 0) + (c.textMatch ? 2 : 0) + (c.visible ? 1 : 0);
    const ranked = candidates.filter(c => c.hrefMatch || (!wanted && c.textMatch)).sort((a, b) => score(b) - score(a));
    if (!ranked.length) return null;
    ranked[0].anchor.setAttribute("data-qa-target", marker);
    return ranked[0].hrefMatch ? (ranked[0].textMatch ? "href+label" : "href") : "label";
  }, { href: test.href, text: test.text, marker }).catch(() => null);

  if (strategy) return { locator: page.locator(`[data-qa-target="${marker}"]`).first(), strategy };

  // The discovery selector is only trusted if the element still has the expected label.
  if (test.selector && test.text) {
    try {
      const bySelector = page.locator(test.selector).first();
      if (await bySelector.count()) {
        const name = cleanText(await bySelector.evaluate(el => window.__qa ? window.__qa.elementName(el) : el.innerText).catch(() => ""));
        if (name.toLowerCase() === cleanText(test.text).toLowerCase()) return { locator: bySelector, strategy: "discovery-selector (href changed)" };
      }
    } catch {}
  }

  for (const name of [test.text, test.ariaLabel].filter(Boolean)) {
    try {
      const byRole = page.getByRole("link", { name, exact: true }).first();
      if (await byRole.count()) return { locator: byRole, strategy: "role:exact" };
    } catch {}
  }

  return null;
}

async function findButton(page, test) {
  if (test.selector) {
    try {
      const bySelector = page.locator(test.selector).first();
      if (await bySelector.count()) {
        const name = cleanText(await bySelector.evaluate(el => window.__qa ? window.__qa.elementName(el) : el.innerText).catch(() => ""));
        if (!test.text || name.toLowerCase() === cleanText(test.text).toLowerCase()) {
          return { locator: bySelector, strategy: "discovery-selector" };
        }
      }
    } catch {}
  }

  for (const name of [test.text, test.ariaLabel].filter(Boolean)) {
    try {
      const byRole = page.getByRole("button", { name, exact: true }).first();
      if (await byRole.count()) return { locator: byRole, strategy: "role:exact" };
    } catch {}
  }

  if (test.text) {
    try {
      const generic = page.locator(
        "button, input[type='button'], input[type='submit'], [role='button']"
      ).filter({ hasText: test.text }).first();

      if (await generic.count()) {
        return { locator: generic, strategy: "button-text-substring" };
      }
    } catch {}
  }

  return null;
}

async function findInput(page, test) {
  const selectors = [];

  if (test.nameAttr) selectors.push(`[name="${test.nameAttr.replace(/"/g, '\\"')}"]`);
  if (test.id) selectors.push(`[id="${test.id.replace(/"/g, '\\"')}"]`);
  if (test.placeholder) selectors.push(`[placeholder="${test.placeholder.replace(/"/g, '\\"')}"]`);
  if (test.ariaLabel) selectors.push(`:is(input, textarea, select)[aria-label="${test.ariaLabel.replace(/"/g, '\\"')}"]`);
  if (test.selector) selectors.push(test.selector);

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count()) return { locator, strategy: selector };
    } catch {}
  }

  for (const label of [test.label, test.identifier].filter(Boolean)) {
    try {
      const byLabel = page.getByLabel(label, { exact: true }).first();
      if (await byLabel.count()) return { locator: byLabel, strategy: "label" };
    } catch {}
  }

  return null;
}

async function snapshotInteractiveState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const isShown = element => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    };

    return {
      url: location.href,
      hash: location.hash,
      title: document.title,
      scrollY: Math.round(window.scrollY),
      bodyText: text.slice(0, 50000),
      buttons: [...document.querySelectorAll(
        "button, input[type='button'], input[type='submit'], [role='button']"
      )].map(element => ({
        text: (element.innerText || element.value || element.getAttribute("aria-label") || "").trim(),
        disabled: Boolean(element.disabled)
      })),
      expanded: [...document.querySelectorAll("[aria-expanded]")].map(element => element.getAttribute("aria-expanded")),
      inputs: [...document.querySelectorAll("input, textarea, select")].map(element => ({
        name: element.getAttribute("name"),
        value: element.value || "",
        disabled: Boolean(element.disabled)
      })),
      dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog')].filter(element => isShown(element) && (element.tagName !== "DIALOG" || element.open)).length,
      activeElements: [...document.querySelectorAll('[aria-current="true"], [aria-selected="true"], [aria-pressed="true"], .active, .slick-active, .swiper-slide-active, [data-state="active"]')]
        .filter(isShown)
        .map(element => ({
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || element.getAttribute("aria-label") || "").trim().slice(0, 160),
          cls: typeof element.className === "string" ? element.className : "",
          current: element.getAttribute("aria-current"),
          selected: element.getAttribute("aria-selected"),
          pressed: element.getAttribute("aria-pressed"),
          state: element.getAttribute("data-state")
        })),
      carouselState: [...document.querySelectorAll('[class*="carousel"], [class*="slider"], [class*="swiper"], [class*="slick"], [data-testid*="carousel"], [data-testid*="slider"]')]
        .filter(element => {
          const rect = element.getBoundingClientRect();
          return isShown(element) && rect.width > 0 && rect.height > 0;
        })
        .slice(0, 80)
        .map(element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            cls: typeof element.className === "string" ? element.className : "",
            id: element.id || "",
            index: element.getAttribute("data-index") || element.getAttribute("aria-label") || "",
            transform: style.transform,
            translate: style.translate,
            scrollLeft: element.scrollLeft,
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            images: [...element.querySelectorAll("img")].slice(0, 8).map(img => img.currentSrc || img.src || img.getAttribute("src") || ""),
            text: (element.innerText || "").trim().slice(0, 100)
          };
        }),
      visibleImages: [...document.images].filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && isShown(img);
      }).map(img => ({ src: img.currentSrc || img.src || "", alt: img.alt || "", left: Math.round(img.getBoundingClientRect().left) })).slice(0, 100),
      visibleTextLength: text.length
    };
  });
}

function compareSnapshots(before, after) {
  const changes = [];

  if (normalizeUrl(before.url) !== normalizeUrl(after.url)) changes.push("URL changed");
  if (before.hash !== after.hash) changes.push("URL fragment changed");
  if (before.title !== after.title) changes.push("page title changed");
  if (Math.abs((before.scrollY || 0) - (after.scrollY || 0)) > 20) changes.push("scroll position changed");
  if (before.bodyText !== after.bodyText) changes.push("page content changed");
  if (JSON.stringify(before.buttons) !== JSON.stringify(after.buttons)) changes.push("button state changed");
  if (JSON.stringify(before.expanded || []) !== JSON.stringify(after.expanded || [])) changes.push("expanded/collapsed state changed");
  if (JSON.stringify(before.inputs) !== JSON.stringify(after.inputs)) changes.push("input state changed");
  if (JSON.stringify(before.activeElements || []) !== JSON.stringify(after.activeElements || [])) changes.push("active/selected UI state changed");
  if (JSON.stringify(before.carouselState || []) !== JSON.stringify(after.carouselState || [])) changes.push("carousel/slider visual state changed");
  if (JSON.stringify(before.visibleImages || []) !== JSON.stringify(after.visibleImages || [])) changes.push("visible image state changed");
  if (before.dialogs !== after.dialogs) changes.push("dialog state changed");
  if (before.visibleTextLength !== after.visibleTextLength) changes.push("visible content size changed");

  return changes;
}

/**
 * Watch the page without interacting to learn which kinds of change happen
 * on their own (autoplaying carousels, tickers, animations). Such changes are
 * not evidence that a click did anything. Previously they were, which made
 * mailto/tel/placeholder links "PASS" on any page with a carousel.
 */
async function sampleBackgroundChanges(page, samples = NOISE_SAMPLES) {
  const counts = new Map();
  let previous = await snapshotInteractiveState(page);
  for (let i = 1; i < samples; i += 1) {
    await page.waitForTimeout(NOISE_INTERVAL_MS);
    const current = await snapshotInteractiveState(page);
    for (const change of compareSnapshots(previous, current)) counts.set(change, (counts.get(change) || 0) + 1);
    previous = current;
  }
  return { categories: new Set(counts.keys()), counts, intervals: samples - 1, last: previous };
}

function mergeBackground(...samples) {
  const counts = new Map();
  let intervals = 0;
  for (const sample of samples) {
    intervals += sample.intervals;
    for (const [change, count] of sample.counts) counts.set(change, (counts.get(change) || 0) + count);
  }
  return { categories: new Set(counts.keys()), counts, intervals };
}

function withoutBackground(changes, background) {
  return changes.filter(change => !background.categories.has(change));
}

async function waitForSettledPage(page) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 4000 });
  } catch {}

  try {
    await page.waitForLoadState("networkidle", { timeout: 1500 });
  } catch {}
}

/**
 * Click an element and decide whether the click itself caused an observable
 * change, discounting background changes sampled both before and after the
 * click (about 6 s of observation in total). When the only change is of a kind that also
 * happens on its own but rarely (e.g. a slow autoplay carousel), the click is
 * repeated: a change that reproduces within 250 ms of two separate clicks is
 * attributed to the clicks.
 */
/**
 * If a fixed or sticky overlay (typically a cookie-consent banner or popup)
 * covers the element, hide it, without accepting or rejecting anything, so the
 * element can be clicked like a user would after dismissing the banner. Hidden
 * overlays are recorded and reported with the test result.
 */
async function hideCoveringOverlay(page, locator) {
  const hidden = await locator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!top || top === el || el.contains(top) || top.contains(el)) return null;
    let node = top;
    while (node && node !== document.body && node !== document.documentElement) {
      const position = getComputedStyle(node).position;
      if (position === "fixed" || position === "sticky") break;
      node = node.parentElement;
    }
    if (!node || node === document.body || node === document.documentElement || node.contains(el)) return null;
    const classes = typeof node.className === "string" ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    const description = `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${classes.length ? `.${classes.join(".")}` : ""}`;
    node.style.setProperty("display", "none", "important");
    return description;
  }).catch(() => null);
  if (hidden) {
    page.__qaHiddenOverlays = [...(page.__qaHiddenOverlays || []), hidden];
    await page.waitForTimeout(150);
  }
  return hidden;
}

async function scrollIntoViewBeforeBaseline(page, locator) {
  await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(150);
  // Up to two stacked overlays (e.g. a consent banner over a newsletter popup).
  if (await hideCoveringOverlay(page, locator)) await hideCoveringOverlay(page, locator);
}

async function clickAndObserve(page, locator) {
  await scrollIntoViewBeforeBaseline(page, locator);
  const preBackground = await sampleBackgroundChanges(page);
  const before = preBackground.last;
  const beforePages = page.context().pages();
  const popupPromise = page.context().waitForEvent("page", { timeout: OBSERVATION_TIMEOUT }).catch(() => null);

  await locator.click({ timeout: ACTION_TIMEOUT });
  await page.waitForTimeout(QUICK_OBSERVATION_MS);
  const quick = await snapshotInteractiveState(page).catch(() => null);
  await waitForSettledPage(page);

  let newPage = page.context().pages().find(candidate => !beforePages.includes(candidate)) || null;
  if (!newPage) {
    newPage = await Promise.race([popupPromise, page.waitForTimeout(1000).then(() => null)]);
  }
  if (newPage) return { newPage, changes: [], background: preBackground };

  const after = await snapshotInteractiveState(page);
  const quickChanges = quick ? compareSnapshots(before, quick) : [];
  const allChanges = [...new Set([...compareSnapshots(before, after), ...quickChanges])];
  if (!allChanges.length) return { changes: [], background: preBackground, allChanges };

  const background = mergeBackground(preBackground, await sampleBackgroundChanges(page, NOISE_SAMPLES * 2 - 1));
  const attributable = withoutBackground(allChanges, background);
  if (attributable.length) return { changes: attributable, background, allChanges };

  // At most one spontaneous change per ~2 s of observation counts as "rare".
  const rareLimit = Math.max(1, Math.floor(background.intervals / 4));
  const quickBackground = quickChanges.filter(change => (background.counts.get(change) || 0) <= rareLimit);

  if (quickBackground.length && (await locator.isVisible().catch(() => false))) {
    const beforeRepeat = await snapshotInteractiveState(page);
    await locator.click({ timeout: ACTION_TIMEOUT });
    await page.waitForTimeout(QUICK_OBSERVATION_MS);
    const afterRepeat = await snapshotInteractiveState(page);
    const reproduced = compareSnapshots(beforeRepeat, afterRepeat).filter(change => quickBackground.includes(change));
    if (reproduced.length) return { changes: reproduced, background, allChanges, reproducedByRepeatClick: true };
  }

  return { changes: [], background, allChanges };
}

function backgroundNote(observation) {
  const ignored = (observation.allChanges || []).filter(change => observation.background.categories.has(change));
  return ignored.length ? ` Changes ignored because the page also does them on its own (e.g. autoplay/animation): ${ignored.join(", ")}.` : "";
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

function safeDecode(value) {
  try {
    return { ok: true, value: decodeURIComponent(value) };
  } catch {
    return { ok: false, value };
  }
}

function validateMailto(href) {
  const decoded = safeDecode(String(href).replace(/^mailto:/i, "").split("?")[0]);
  if (!decoded.ok) return { addresses: [], invalid: [`${decoded.value} (malformed percent-encoding)`] };
  const raw = decoded.value;
  const addresses = raw.split(",").map(address => address.trim()).filter(Boolean);
  const invalid = addresses.filter(address => !/^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(address));
  return { addresses, invalid };
}

function validateTel(href) {
  const decoded = safeDecode(String(href).replace(/^(tel|sms):/i, "").split("?")[0]);
  if (!decoded.ok) return { raw: decoded.value, valid: false };
  const raw = decoded.value;
  const digits = raw.replace(/\D/g, "");
  const allowed = /^[+\d\s().\-#*,;pw]*$/i.test(raw);
  return { raw, valid: allowed && digits.length >= 3 };
}

function hiddenHow(state) {
  return `Link is hidden (${state.hiddenReason}), so it was not clicked.`;
}

async function executeLinkTest(context, page, test, result) {
  const found = await findLink(page, test);

  if (!found) {
    return setOutcome(result, OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR",
      `Link could not be located on the page at test time: ${test.text || test.href}`);
  }

  const link = found.locator;
  const state = await elementState(link);
  const rawHref = state.rawHref ?? test.rawHref ?? "";
  const href = state.href || resolveUrl(rawHref, page.url()) || test.href;
  result.element = { locatedBy: found.strategy, visible: state.visible, hiddenReason: state.hiddenReason, href };
  if (test.expectedHidden && state.visible) result.element.note = "Hidden at discovery but visible at test time.";
  if (!test.expectedHidden && !state.visible) result.element.note = "Visible at discovery but hidden at test time.";

  const scheme = (() => { try { return new URL(href).protocol; } catch { return ""; } })();

  if (test.robotsDisallowed) {
    result.afterUrl = href;
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
      `The site's robots.txt asks automated agents not to visit ${href}, so the link was neither followed nor requested.`);
  }

  if (test.sideEffectRisk || hasSideEffectLink(state.name || test.text, href)) {
    const name = state.name || test.text;
    result.afterUrl = href;
    if (!state.visible) {
      return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Link "${name}" is hidden (${state.hiddenReason}) and looks like a state-changing action (log out, unsubscribe, delete, cart...); it was neither followed nor fetched.`);
    }
    return setOutcome(result, OUTCOMES.PASS, "READY_NOT_CLICKED",
      `Link "${name}" is visible and points to ${href}. It looks like a state-changing action (log out, unsubscribe, delete, cart...), so it was intentionally neither followed nor fetched; its destination was not tested.`);
  }

  if (scheme === "mailto:") {
    const { addresses, invalid } = validateMailto(href);
    result.afterUrl = href;
    if (invalid.length) {
      return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE", `mailto: link contains an invalid email address: ${invalid.join(", ")}.`);
    }
    return setOutcome(result, OUTCOMES.PASS, "LINK_TARGET_WELL_FORMED",
      `mailto: link is well-formed (${addresses.join(", ") || "no preset recipient"}). It was not clicked: opening an email client cannot be observed in a headless browser.${state.visible ? "" : ` Note: the link is hidden (${state.hiddenReason}).`}`);
  }

  if (scheme === "tel:" || scheme === "sms:") {
    const { raw, valid } = validateTel(href);
    result.afterUrl = href;
    if (!valid) return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE", `${scheme} link has an invalid phone number: "${raw}".`);
    return setOutcome(result, OUTCOMES.PASS, "LINK_TARGET_WELL_FORMED",
      `${scheme} link is well-formed (${raw}). It was not clicked: dialling cannot be observed in a headless browser.${state.visible ? "" : ` Note: the link is hidden (${state.hiddenReason}).`}`);
  }

  if (scheme === "javascript:") {
    if (!state.visible) return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `${hiddenHow(state)} It is a javascript: link, so there is no destination to check.`);
    return observeScriptedLink(page, link, result, "javascript: link");
  }

  if (!isHttpUrl(href)) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Link uses a scheme that cannot be verified automatically: ${href}`);
  }

  // In-page links: "#section", "#", or hash routes on the current page.
  const samePage = normalizeUrl(href) === normalizeUrl(page.url());
  if (samePage) {
    // URL parsing drops an empty "#", so a bare href="#" placeholder must be read from the raw attribute.
    const trimmedRaw = cleanText(rawHref);
    const hash = trimmedRaw.startsWith("#") ? trimmedRaw : (() => { try { return new URL(href).hash; } catch { return ""; } })();
    if (!hash) {
      const verdict = classifyHttpStatus(result.httpStatus);
      const hiddenNote = state.visible ? "" : ` Note: the link is hidden (${state.hiddenReason}).`;
      if (verdict === "failure") return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE", `Link points to the current page, which returned HTTP ${result.httpStatus}: ${href}.${hiddenNote}`);
      if (verdict === "restricted") return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Link points to the current page, which returned HTTP ${result.httpStatus} (access restriction or bot protection): ${href}.${hiddenNote}`);
      return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS",
        `Link points to the current page, which loaded successfully${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}: ${href}.${hiddenNote}`);
    }
    return executeInPageLink(page, link, state, hash, result);
  }

  if (!state.visible) {
    const check = await checkHttpDestination(context, href);
    result.afterUrl = check.url || href;
    applyDestinationOutcome(result, check, hiddenHow(state));
    if (result.outcome !== OUTCOMES.PASS) result.screenshot = await safeScreenshot(page, "hidden-link");
    return result;
  }

  return executeHttpLinkClick(context, page, link, href, test, result);
}

async function observeScriptedLink(page, link, result, kind) {
  const observation = await clickAndObserve(page, link);
  result.afterUrl = observation.newPage ? observation.newPage.url() : page.url();
  if (observation.newPage) {
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS", `${kind} opened a new page/window: ${result.afterUrl}`);
  }
  if (observation.changes.length) {
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS",
      `${kind} produced observable behaviour: ${observation.changes.join(", ")}.${observation.reproducedByRepeatClick ? " (Reproduced on a second click despite background animation.)" : ""}`);
  }
  return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
    `${kind} was clicked, but no change attributable to the click was observed.${backgroundNote(observation)}`);
}

async function executeInPageLink(page, link, state, hash, result) {
  const fragment = (() => { try { return decodeURIComponent(hash.slice(1)); } catch { return hash.slice(1); } })();
  const isRoute = /^[!/]/.test(fragment);
  const isPlaceholder = fragment === "" || fragment === "!";

  if (isPlaceholder || isRoute) {
    const kind = isPlaceholder ? `Placeholder link (href="${hash}")` : `Hash-route link (${hash})`;
    if (!state.visible) return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `${hiddenHow(state)} ${kind} has no destination to check.`);
    return observeScriptedLink(page, link, result, kind);
  }

  const targetExists = await page.evaluate(id => Boolean(document.getElementById(id) || document.getElementsByName(id)[0]) || id.toLowerCase() === "top", fragment).catch(() => false);
  result.afterUrl = page.url().split("#")[0] + hash;

  if (targetExists) {
    let clickNote = "";
    if (state.visible) {
      try {
        await link.click({ timeout: ACTION_TIMEOUT });
        await page.waitForTimeout(400);
        clickNote = ` Clicked; page URL is now ${page.url()}.`;
      } catch (error) {
        clickNote = ` Click could not be performed (${cleanText(error.message).slice(0, 120)}).`;
      }
    } else {
      clickNote = ` Link is hidden (${state.hiddenReason}), so it was not clicked.`;
    }
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS", `In-page anchor target "#${fragment}" exists on the page.${clickNote}`);
  }

  if (!state.visible) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `${hiddenHow(state)} Its in-page target "#${fragment}" does not exist.`);
  }

  // Missing target: a script may still handle the click (tabs, modals).
  const observation = await clickAndObserve(page, link);
  if (observation.newPage || observation.changes.length) {
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS",
      `No element with id "${fragment}" exists, but the click was handled by the page: ${observation.newPage ? "opened a new page" : observation.changes.join(", ")}.`);
  }
  result.screenshot = await safeScreenshot(page, "test-broken-anchor");
  return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE",
    `In-page link points to "#${fragment}", but no element with that id or name exists and the click had no observable effect.${backgroundNote(observation)}`);
}

async function verifyNewTab(context, newPage, href, result, prefix, tabStatuses) {
  await waitForSettledPage(newPage);
  result.afterUrl = newPage.url();
  const title = cleanText(await newPage.title().catch(() => ""));
  const browserStatus = tabStatuses ? tabStatuses.get(normalizeUrl(newPage.url())) ?? null : null;
  result.navigationStatus = browserStatus;
  const browserVerdict = classifyHttpStatus(browserStatus);

  // What the real browser tab received is stronger evidence than a re-request,
  // which some sites (e.g. social networks) answer with 400/403 for automated clients.
  if (browserVerdict === "failure") {
    return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE", `${prefix} opened a new tab, but the page returned HTTP ${browserStatus}: ${result.afterUrl}`);
  }
  if (browserVerdict === "restricted") {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `${prefix} opened a new tab, but the page returned HTTP ${browserStatus} (access restriction or bot protection, e.g. 999). Not treated as a broken link. URL: ${result.afterUrl}`);
  }
  if (browserVerdict === "ok" && isHttpUrl(result.afterUrl)) {
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS", title
      ? `${prefix} opened a new tab that loaded with HTTP ${browserStatus} and rendered a titled page ("${title}"). URL: ${result.afterUrl}`
      : `${prefix} opened a new tab that loaded with HTTP ${browserStatus} (the page has no title). URL: ${result.afterUrl}`);
  }

  const destination = isHttpUrl(result.afterUrl) ? result.afterUrl : href;
  const check = await checkHttpDestination(context, destination);
  result.destinationCheck = check;
  const verdict = classifyHttpStatus(check.status);

  if (verdict === "failure") {
    return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE", `${prefix} opened a new tab, but the destination returned HTTP ${check.status}: ${check.url}`);
  }
  if (verdict === "ok" && !title) {
    // Files such as PDFs often open as a download or a viewer tab without a title.
    return setOutcome(result, OUTCOMES.PASS, "DESTINATION_REACHABLE",
      `${prefix} opened a new tab; the destination responded with HTTP ${check.status} (no page title, e.g. a PDF or file). URL: ${check.url || destination}`);
  }
  if (isHttpUrl(result.afterUrl) && title) {
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS",
      verdict === "restricted"
        ? `${prefix} opened a new tab that rendered a titled page ("${title}"). A direct HTTP check returned ${check.status} (likely bot protection), so it was not treated as broken. URL: ${result.afterUrl}`
        : `${prefix} opened a new tab that rendered a titled page ("${title}"). Destination ${describeHttp(check)}. URL: ${result.afterUrl}`);
  }
  return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `${prefix} opened a new tab, but its content or destination could not be verified (${describeHttp(check)}). URL: ${result.afterUrl}`);
}

async function executeHttpLinkClick(context, page, link, href, test, result) {
  await scrollIntoViewBeforeBaseline(page, link);
  const beforeUrl = page.url();
  const beforeSnapshot = await snapshotInteractiveState(page);
  const beforePages = context.pages();
  let navigationResponse = null;

  const responseHandler = response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) navigationResponse = response;
  };
  page.on("response", responseHandler);
  // Document status received by any tab opened by the click, keyed by URL:
  // Playwright cannot report the frame of a popup's first navigation.
  const tabStatuses = new Map();
  const tabResponseHandler = response => {
    if (response.request().isNavigationRequest()) tabStatuses.set(normalizeUrl(response.url()), response.status());
  };
  context.on("response", tabResponseHandler);
  const stopTracking = () => {
    page.off("response", responseHandler);
    context.off("response", tabResponseHandler);
  };

  const downloadPromise = page.waitForEvent("download", { timeout: OBSERVATION_TIMEOUT }).catch(() => null);
  const popupPromise = context.waitForEvent("page", { timeout: OBSERVATION_TIMEOUT }).catch(() => null);
  const label = test.text || href;

  try {
    await link.click({ timeout: ACTION_TIMEOUT });
  } catch (error) {
    const newPage = context.pages().find(candidate => !beforePages.includes(candidate));
    if (newPage) {
      const outcome = await verifyNewTab(context, newPage, href, result, "Link", tabStatuses);
      stopTracking();
      return outcome;
    }
    stopTracking();
    const check = await checkHttpDestination(context, href);
    result.afterUrl = check.url || href;
    return applyDestinationOutcome(result, check, `Click could not be performed (${cleanText(error.message).split(" Call log")[0].slice(0, 160)}).`);
  }

  await waitForSettledPage(page);
  const navigated = normalizeUrl(page.url()) !== normalizeUrl(beforeUrl);

  let newPage = context.pages().find(candidate => !beforePages.includes(candidate)) || null;
  if (!newPage && !navigated) newPage = await Promise.race([popupPromise, page.waitForTimeout(3000).then(() => null)]);
  if (newPage) {
    const outcome = await verifyNewTab(context, newPage, href, result, "Link", tabStatuses);
    stopTracking();
    return outcome;
  }

  if (!navigated) {
    const download = await Promise.race([downloadPromise, page.waitForTimeout(500).then(() => null)]);
    if (download) {
      stopTracking();
      result.afterUrl = href;
      return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS",
        `Link triggered a download: ${label}. Suggested filename: ${download.suggestedFilename()}`);
    }
  }

  stopTracking();
  const afterUrl = page.url();
  result.afterUrl = afterUrl;
  const responseStatus = navigationResponse?.status?.() ?? null;

  if (navigated) {
    result.navigationStatus = responseStatus;
    const verdict = classifyHttpStatus(responseStatus);
    if (verdict === "failure") {
      result.screenshot = await safeScreenshot(page, "test-failure");
      return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE", `Link navigation returned HTTP ${responseStatus}: ${afterUrl}`);
    }
    if (verdict === "restricted") {
      return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
        `Link navigated to ${afterUrl}, which returned HTTP ${responseStatus} (access restriction or bot protection, e.g. 999). Not treated as a broken link.`);
    }
    if (verdict === "ok") {
      return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS", `Link navigation succeeded with HTTP ${responseStatus}. URL: ${afterUrl}.`);
    }
    // URL changed without a navigation response (client-side routing): check the URL directly.
    const check = await checkHttpDestination(context, afterUrl);
    return applyDestinationOutcome(result, check, `URL changed to ${afterUrl} without a full page load (client-side navigation).`);
  }

  // No navigation, popup or download. Did the page visibly react?
  const afterSnapshot = await snapshotInteractiveState(page);
  const rawChanges = compareSnapshots(beforeSnapshot, afterSnapshot);
  // Only when something changed: watch ~4 s to learn which changes happen on their own.
  const changes = rawChanges.length
    ? withoutBackground(rawChanges, await sampleBackgroundChanges(page, NOISE_SAMPLES * 2 - 1))
    : [];
  if (changes.length) {
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS", `Link action produced observable behaviour without a URL change: ${changes.join(", ")}.`);
  }

  const check = await checkHttpDestination(context, href);
  result.afterUrl = check.url || afterUrl;
  return applyDestinationOutcome(result, check, "The click produced no observable navigation, so the destination was checked with a direct HTTP request.");
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

async function executeButtonTest(page, test, result) {
  const found = await findButton(page, test);

  if (!found) {
    return setOutcome(result, OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR", `Button could not be located on the page at test time: ${test.text || test.selector}`);
  }

  const state = await elementState(found.locator);
  result.element = { locatedBy: found.strategy, visible: state.visible, hiddenReason: state.hiddenReason, disabled: state.disabled };

  if (!state.visible) {
    result.screenshot = await safeScreenshot(page, "hidden-button");
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Button exists but is hidden (${state.hiddenReason}); it was not clicked: ${test.text}`);
  }

  // Never click a submit control: the form validation test covers it without submitting.
  const isSubmit = await found.locator.evaluate(el => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || (tag === "button" ? "submit" : "")).toLowerCase();
    return Boolean(el.form) && (type === "submit" || type === "image");
  }).catch(() => false);

  const label = test.text || state.name;
  // Check the element actually found as well as the planned label (substring matches can differ).
  if (test.sideEffectRisk || isSubmit || hasSideEffectLabel(label) || hasSideEffectLabel(state.name)) {
    const actual = state.name && state.name !== label ? ` (element found: "${state.name}")` : "";
    const why = isSubmit ? "it submits a form" : "its label suggests a real-world side effect (sending, buying, subscribing, deleting...)";
    if (state.disabled) {
      return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Button "${label}"${actual} is visible but disabled. It was not clicked because ${why}.`);
    }
    return setOutcome(result, OUTCOMES.PASS, "READY_NOT_CLICKED",
      `Button "${label}"${actual} is visible and enabled. It was intentionally not clicked because ${why}; what happens after clicking was not tested.`);
  }

  if (state.disabled) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
      `Button "${label}" is visible but disabled, so it cannot be clicked (it is usually enabled after earlier steps, e.g. choosing options).`);
  }

  let observation;
  try {
    observation = await clickAndObserve(page, found.locator);
  } catch (error) {
    return setOutcome(result, OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR", `Button interaction could not be completed: ${label}. ${cleanText(error.message).split(" Call log")[0]}`);
  }

  if (observation.newPage) {
    result.afterUrl = observation.newPage.url();
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS", `Button click opened a new page/window: ${result.afterUrl}`);
  }

  result.afterUrl = page.url();
  if (observation.changes.length) {
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS",
      `Button click produced observable behaviour: ${observation.changes.join(", ")}.${observation.reproducedByRepeatClick ? " (Reproduced on a second click despite background animation.)" : ""}`);
  }

  return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
    `Button was clicked, but no change attributable to the click was observed: ${label}.${backgroundNote(observation)}`);
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

async function scrollThroughPage(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    const limit = Math.min(document.documentElement.scrollHeight, 40000);
    for (let y = 0; y <= limit; y += step) {
      window.scrollTo(0, y);
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
}

const IMAGE_DECODE_TIMEOUT = 8000;

const IMAGE_SIGNATURES = [
  ["JPEG", bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ["PNG", bytes => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47],
  ["GIF", bytes => bytes.subarray(0, 3).toString("latin1") === "GIF"],
  ["WebP", bytes => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"],
  ["AVIF", bytes => /^ftyp(avif|avis)/.test(bytes.subarray(4, 12).toString("latin1"))],
  ["ICO", bytes => bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0],
  ["BMP", bytes => bytes.subarray(0, 2).toString("latin1") === "BM"],
  ["SVG", bytes => /<svg[\s>]/i.test(bytes.subarray(0, 2048).toString("utf8"))]
];

function formatBytes(size) {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
}

/** Download an image and identify it by its file signature, not just its HTTP status. */
async function fetchImageInfo(context, source) {
  if (!isHttpUrl(source)) return { checked: false, status: null, error: null };
  try {
    const response = await context.request.get(source, { timeout: 30000, maxRedirects: 5, failOnStatusCode: false });
    const body = await response.body().catch(() => Buffer.alloc(0));
    const match = IMAGE_SIGNATURES.find(([, test]) => body.length >= 4 && test(body));
    return {
      checked: true,
      status: response.status(),
      contentType: response.headers()["content-type"] || null,
      size: body.length,
      signatureOk: Boolean(match),
      format: match ? match[0] : null,
      error: null
    };
  } catch (error) {
    return { checked: true, status: null, error: cleanText(error.message).slice(0, 200) };
  }
}

async function executeImageTest(context, page, result) {
  const images = page.locator("img");
  const imageCount = await images.count();

  if (imageCount === 0) {
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS", "No images found on the page.");
  }

  // Scroll step by step so lazy-loaded images are actually requested.
  await scrollThroughPage(page);

  const imageResults = await images.evaluateAll(elements => elements.map((image, index) => {
    // An empty src="" resolves to the page's own URL; that is "no source", not an image to download.
    const pageUrl = location.href.split("#")[0];
    const rawSrc = (image.getAttribute("src") || "").trim();
    const resolved = image.currentSrc || (rawSrc ? image.src : "");
    const src = resolved && resolved.split("#")[0] !== pageUrl ? resolved : "";
    const srcsetFirst = (image.getAttribute("data-srcset") || "").split(",")[0].trim().split(/\s+/)[0] || "";
    const lazySrc = image.getAttribute("data-src") || image.getAttribute("data-lazy-src") || image.getAttribute("data-original") || srcsetFirst || "";
    return {
      index: index + 1,
      src,
      lazySrc,
      alt: image.getAttribute("alt") || "",
      loading: image.getAttribute("loading") || "",
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      visible: window.__qa ? !window.__qa.hiddenReason(image) : true,
      hiddenReason: window.__qa ? window.__qa.hiddenReason(image) : null,
      loaded: image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
    };
  }));

  const confirmedBrokenImages = [];
  const unverifiedImages = [];
  const deferredImages = [];
  const slowImages = [];

  for (const image of imageResults) {
    if (image.loaded) continue;

    const source = image.src || (image.lazySrc ? resolveUrl(image.lazySrc, page.url()) : "");
    if (!source) {
      if (image.visible) confirmedBrokenImages.push({ ...image, reason: "Visible image has no source" });
      else deferredImages.push({ ...image, reason: `Hidden image (${image.hiddenReason}) without a source yet` });
      continue;
    }

    // Can the browser decode the file? This separates "not rendered yet"
    // (lazy/hidden) from genuinely broken files.
    const decoded = await page.evaluate(async ({ src, timeoutMs }) => {
      const probe = new Image();
      probe.src = src;
      try {
        await Promise.race([probe.decode(), new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs))]);
        return { ok: true, width: probe.naturalWidth, height: probe.naturalHeight };
      } catch (error) {
        return { ok: false, timedOut: error && error.name === "TimeoutError", error: String(error && error.message || error) };
      }
    }, { src: source, timeoutMs: IMAGE_DECODE_TIMEOUT }).catch(error => ({ ok: false, timedOut: false, error: error.message }));

    if (decoded.ok) {
      deferredImages.push({ ...image, reason: image.visible ? "Not rendered in place (lazy-loading or still loading), but the file loads and decodes correctly" : `Hidden image (${image.hiddenReason}); the file loads and decodes correctly` });
      continue;
    }

    if (source.startsWith("data:")) {
      confirmedBrokenImages.push({ ...image, reason: "Inline data: image could not be decoded" });
      continue;
    }

    const check = await fetchImageInfo(context, source);
    const verdict = classifyHttpStatus(check.status);
    const sizeNote = check.size ? ` (${formatBytes(check.size)})` : "";
    if (verdict === "failure") {
      confirmedBrokenImages.push({ ...image, httpStatus: check.status, reason: `HTTP ${check.status}` });
    } else if (verdict === "ok" && check.signatureOk && decoded.timedOut) {
      // A valid image file that the browser was still decoding when we stopped waiting is slow, not broken.
      slowImages.push({ ...image, httpStatus: check.status, size: check.size, reason: `Valid ${check.format} file${sizeNote}, but it took longer than ${IMAGE_DECODE_TIMEOUT / 1000} s to load and decode` });
    } else if (verdict === "ok" && !check.signatureOk) {
      confirmedBrokenImages.push({ ...image, httpStatus: check.status, reason: `HTTP ${check.status}, but the response is not an image (content-type: ${check.contentType || "unknown"})` });
    } else if (verdict === "ok") {
      confirmedBrokenImages.push({ ...image, httpStatus: check.status, reason: `HTTP ${check.status}: the file starts like a ${check.format} image${sizeNote}, but the browser could not decode it (corrupt file)` });
    } else if (verdict === "restricted") {
      unverifiedImages.push({ ...image, httpStatus: check.status, reason: `HTTP ${check.status} (access restriction or bot protection)` });
    } else if (!check.checked || /timeout|timed out/i.test(check.error || "")) {
      unverifiedImages.push({ ...image, reason: check.checked ? `Request timed out: ${check.error}` : "Source is not an http(s) URL and could not be decoded" });
    } else {
      confirmedBrokenImages.push({ ...image, reason: `Request failed: ${check.error || "unknown error"}` });
    }
  }

  const loadedImageCount = imageResults.length - confirmedBrokenImages.length - unverifiedImages.length - deferredImages.length - slowImages.length;
  result.imageCheck = {
    totalImages: imageResults.length,
    loadedImageCount,
    deferredLoadableCount: deferredImages.length,
    slowImageCount: slowImages.length,
    slowImages,
    confirmedBrokenCount: confirmedBrokenImages.length,
    loadIssueCount: unverifiedImages.length,
    images: imageResults,
    confirmedBrokenImages,
    deferredImages,
    loadIssueImages: unverifiedImages
  };
  result.afterUrl = page.url();

  const deferredNote = (deferredImages.length ? ` ${deferredImages.length} image(s) were not rendered in place (lazy-loaded or hidden) but load and decode correctly.` : "") +
    (slowImages.length ? ` ${slowImages.length} valid image(s) are very slow to load: ${slowImages.slice(0, 3).map(image => `${image.src.split("/").pop()} — ${image.reason}`).join("; ")}.` : "");

  if (confirmedBrokenImages.length > 0) {
    result.screenshot = await safeScreenshot(page, "test-broken-image");
    const examples = confirmedBrokenImages.slice(0, 5).map(image => `${image.src || image.lazySrc || "(no src)"} — ${image.reason}`).join("; ");
    return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE",
      `Confirmed broken image(s): ${confirmedBrokenImages.length} of ${imageResults.length}. ${examples}.${deferredNote}`);
  }
  if (unverifiedImages.length > 0) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
      `${unverifiedImages.length} of ${imageResults.length} image(s) could not be verified (access restricted); none were confirmed broken.${deferredNote}`);
  }
  return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS",
    `All ${imageResults.length} image(s) load correctly: ${loadedImageCount} rendered on the page.${deferredNote}`);
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

async function executePageLoadTest(page, result) {
  const title = cleanText(await page.title());
  const verdict = classifyHttpStatus(result.httpStatus);
  const httpNote = result.httpStatus ? ` (HTTP ${result.httpStatus})` : "";

  if (verdict === "failure") {
    result.screenshot = await safeScreenshot(page, "test-failure");
    return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE", `Page responded with HTTP ${result.httpStatus}${title ? ` ("${title}")` : ""}.`);
  }
  if (verdict === "restricted") {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Page responded with HTTP ${result.httpStatus} (access restriction or bot protection); its content could not be verified.`);
  }
  if (!title) {
    result.error = "Page loaded but title is empty";
    return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE", `Page loaded${httpNote}, but its <title> is empty.`);
  }
  return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS", `Page loaded successfully${httpNote}: ${title}`);
}

async function executeInputTest(page, test, result) {
  const found = await findInput(page, test);
  if (!found) {
    return setOutcome(result, OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR", `Input could not be located on the page at test time: ${test.identifier}`);
  }
  const state = await elementState(found.locator);
  result.element = { locatedBy: found.strategy, visible: state.visible, hiddenReason: state.hiddenReason, disabled: state.disabled };
  if (!state.visible) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Input exists but is not visible (${state.hiddenReason}): ${test.identifier}`);
  }
  const editable = await found.locator.isEditable().catch(() => false);
  return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS",
    `Input exists and is visible: ${test.identifier}${editable ? " (editable)" : " (not editable: disabled or read-only)"}.`);
}

async function executeFormExistsTest(page, test, result) {
  const forms = page.locator("form");
  const count = await forms.count();
  const index = Number.isInteger(test.formIndex) ? test.formIndex : 0;

  if (count <= index) {
    return setOutcome(result, OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR", `Expected form index ${index + 1}, but only ${count} form(s) were found.`);
  }
  const form = forms.nth(index);
  const state = await elementState(form);
  const inputCount = await form.locator("input, textarea, select").count();

  if (!state.visible) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Form ${index + 1} exists but is not visible (${state.hiddenReason}).`);
  }
  if (inputCount === 0) {
    return setOutcome(result, OUTCOMES.FAIL, "APPLICATION_FAILURE", `Form ${index + 1} is visible but contains no input controls.`);
  }
  return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS", `Form ${index + 1} found and contains ${inputCount} input field(s).`);
}

async function executeCarouselTest(page, test, result) {
  const found = await findButton(page, test);
  if (!found) {
    return setOutcome(result, OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR", `Carousel control could not be located: ${test.text}`);
  }
  const state = await elementState(found.locator);
  if (!state.visible) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Carousel control is hidden (${state.hiddenReason}); it was not clicked: ${test.text}`);
  }
  if (hasSideEffectLabel(state.name) || hasSideEffectLabel(test.text)) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Control "${state.name}" looks like a side-effect action, so it was not clicked.`);
  }
  const observation = await clickAndObserve(page, found.locator);
  if (observation.changes.length) {
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS", `Carousel control produced observable behaviour: ${observation.changes.join(", ")}.`);
  }
  return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Carousel control was clicked, but no change attributable to the click was observed: ${test.text}.${backgroundNote(observation)}`);
}

async function executeMobileMenuTest(page, test, result) {
  let found = await findButton(page, test);
  if (!found && test.selector) {
    const bySelector = page.locator(test.selector).first();
    if (await bySelector.count().catch(() => 0)) found = { locator: bySelector, strategy: "discovery-selector" };
  }
  if (!found) {
    return setOutcome(result, OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR", `Mobile menu toggle could not be located: ${test.text || test.selector}`);
  }
  const state = await elementState(found.locator);
  result.element = { locatedBy: found.strategy, visible: state.visible, hiddenReason: state.hiddenReason };
  if (!state.visible) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Mobile menu toggle exists but is hidden (${state.hiddenReason}).`);
  }
  if (hasSideEffectLabel(state.name)) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED", `Control "${state.name}" looks like a side-effect action, so it was not clicked.`);
  }

  const visibleLinkCount = () => page.evaluate(() => [...document.querySelectorAll("a[href]")].filter(anchor => !window.__qa.hiddenReason(anchor)).length);
  await scrollIntoViewBeforeBaseline(page, found.locator);
  const before = await visibleLinkCount();
  const expandedBefore = await found.locator.getAttribute("aria-expanded").catch(() => null);

  await found.locator.click({ timeout: ACTION_TIMEOUT });
  let after = before;
  for (let waited = 0; waited < 2000 && after <= before; waited += 200) {
    await page.waitForTimeout(200);
    after = await visibleLinkCount();
  }
  const expandedAfter = await found.locator.getAttribute("aria-expanded").catch(() => null);
  const expandedNote = expandedBefore !== null || expandedAfter !== null ? ` aria-expanded: ${expandedBefore ?? "none"} → ${expandedAfter ?? "none"}.` : "";
  result.menuCheck = { visibleLinksBefore: before, visibleLinksAfter: after, expandedBefore, expandedAfter };

  if (after > before) {
    return setOutcome(result, OUTCOMES.PASS, "APPLICATION_SUCCESS",
      `Tapping "${state.name || test.text}" opened the menu: visible links went from ${before} to ${after}.${expandedNote}`);
  }
  result.screenshot = await safeScreenshot(page, "test-mobile-menu");
  if (expandedAfter === "true" && expandedBefore !== "true") {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
      `The toggle reports the menu as expanded, but no additional links became visible within 2 seconds.${expandedNote}`);
  }
  return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
    `Tapping "${state.name || test.text}" did not reveal any additional links; the menu could not be confirmed (the detected toggle may not be the menu button).${expandedNote}`);
}

/**
 * Execute one planned test in a fresh browser context.
 * options.browser: reuse an already launched browser (the pipeline does this);
 * otherwise a browser is launched and closed for this test.
 * options.viewport: DESKTOP (default) or MOBILE from viewports.js.
 */
async function executeTest(url, test, options = {}) {
  const ownsBrowser = !options.browser;
  let browser = options.browser || null;
  let context = null;
  let page = null;
  let guard = null;

  const result = {
    test,
    status: OUTCOMES.NOT_VERIFIED,
    outcome: OUTCOMES.NOT_VERIFIED,
    classification: "NOT_VERIFIED",
    error: null,
    screenshot: null,
    details: null,
    beforeUrl: url,
    afterUrl: null,
    httpStatus: null,
    viewport: (options.viewport || DESKTOP).name,
    durationMs: null
  };
  const startedMs = Date.now();

  try {
    if (!browser) browser = await launchBrowser();
    context = await newQaContext(browser, options.viewport || DESKTOP);
    page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    result.httpStatus = response ? response.status() : null;
    result.retryAfter = response ? response.headers()["retry-after"] || null : null;
    await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});

    result.beforeUrl = page.url();
    await ensureDomHelpers(page);
    // Installed after the initial load so the page itself loads normally.
    guard = await installMutationGuard(context);

    if (test.type === "page_load") await executePageLoadTest(page, result);
    else if (test.type === "link") await executeLinkTest(context, page, test, result);
    else if (test.type === "button") await executeButtonTest(page, test, result);
    else if (test.type === "carousel") await executeCarouselTest(page, test, result);
    else if (test.type === "form_submit") await runFormValidation(page, test, result, guard);
    else if (test.type === "broken_image") await executeImageTest(context, page, result);
    else if (test.type === "input") await executeInputTest(page, test, result);
    else if (test.type === "form") await executeFormExistsTest(page, test, result);
    else if (test.type === "mobile_menu") await executeMobileMenuTest(page, test, result);
    else setOutcome(result, OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR", `Unknown test type: ${test.type}`);
  } catch (error) {
    result.error = cleanText(error.message).slice(0, 500);
    result.afterUrl = page ? page.url() : null;

    if (result.outcome !== OUTCOMES.FAIL) {
      setOutcome(result, OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR", `Automation could not complete the test: ${result.error}`);
    }

    if (page) result.screenshot = result.screenshot || await safeScreenshot(page, "test-automation-error");
  } finally {
    if (guard) {
      result.safety = {
        mutatingRequestGuard: guard.enabled,
        mutatingRequestsBlocked: guard.blocked.length,
        navigationsBlocked: guard.blockedNavigations.length,
        blockedRequests: guard.blocked.slice(0, 10)
      };
    }
    if (page && page.__qaHiddenOverlays?.length) {
      result.overlaysHidden = [...new Set(page.__qaHiddenOverlays)];
      result.details = `${result.details || ""} Note: an overlay covering the element (e.g. a cookie banner) was hidden to reach it: ${result.overlaysHidden.join(", ")}.`.trim();
    }
    result.durationMs = Date.now() - startedMs;
    if (context) await context.close().catch(() => {});
    if (ownsBrowser && browser) await browser.close().catch(() => {});
  }

  return result;
}

module.exports = {
  executeTest,
  // Exported for unit tests.
  compareSnapshots,
  validateMailto,
  validateTel,
  normalizeUrl
};
