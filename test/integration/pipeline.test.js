/**
 * End-to-end regression tests: real Chromium, real pipeline, local fixture
 * site (test/fixtures). Requires `npx playwright install chromium`.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.QA_REPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qa-agent-it-"));

const { startFixtureServer } = require("../fixtures/server");
const { runPipeline } = require("../../agent/ai-qa-pipeine");

let fixture;
let main;
let forms;

function byName(run, name) {
  const found = run.executionResults.find(result => result.test.name === name);
  assert.ok(found, `test "${name}" should exist. Got: ${run.executionResults.map(r => r.test.name).join(" | ")}`);
  return found;
}

function quiet(fn) {
  const original = console.log;
  console.log = () => {};
  return fn().finally(() => { console.log = original; });
}

test.before(async () => {
  fixture = await startFixtureServer();
  main = await quiet(() => runPipeline(`${fixture.baseUrl}/`));
  forms = await quiet(() => runPipeline(`${fixture.baseUrl}/forms.html`));
});

test.after(async () => {
  if (fixture) await fixture.close();
});

test("safety: the agent never submits forms or sends state-changing requests", () => {
  assert.deepEqual(fixture.mutatingRequests, [], "the fixture server must not receive any POST/PUT/DELETE");
  const autosave = byName(forms, "Form validation - Save profile");
  assert.ok(autosave.safety.mutatingRequestsBlocked >= 1, "an autosave POST fired by the page is blocked by the guard");
  assert.equal(forms.safety.formsSubmitted, 0);
});

test("issue 1: valid values are accepted when they satisfy each field's declared constraints", () => {
  const contact = byName(main, "Form validation - Send Message");
  assert.equal(contact.outcome, "PASS", contact.details);
  const fields = Object.fromEntries(contact.validation.fields.map(field => [field.name, field]));
  assert.match(fields.phone.testValue, /^[0-9]{10}$/, "phone value honours pattern");
  assert.ok(fields.visit.testValue >= "2030-01-01", "date honours min");
  assert.equal(fields.guests.testValue, "2", "number honours min/step");
  assert.equal(fields.terms.accepted, true, "custom-styled hidden checkbox is ticked via its label");
  assert.ok(contact.validation.fields.every(field => field.accepted), JSON.stringify(contact.validation.fields));
  assert.ok(contact.validation.skippedFields.some(field => /file upload/.test(field.reason)), "required file upload is reported, not counted as rejection");
  assert.ok(contact.validation.skippedFields.some(field => /honeypot/.test(field.reason)), "hidden honeypot left empty");
  assert.equal(contact.validation.emptyRequiredRejected, contact.validation.requiredCount);
});

test("issue 1: JavaScript-only validation (aria-invalid) and disabled-until-valid submit are recognised", () => {
  const signup = byName(forms, "Form validation - Create account");
  assert.equal(signup.outcome, "PASS", signup.details);
  const email = signup.validation.fields.find(field => field.name === "work_email");
  assert.equal(email.invalidRejected, true, "aria-invalid after blur counts as rejection");
  assert.equal(signup.validation.submitControlWhenEmpty.disabled, true);
  assert.equal(signup.validation.submitControl.disabled, false);
});

test("issue 1: a field whose rule cannot be satisfied is NOT_VERIFIED with the page's message, never PASS or FAIL", () => {
  const join = byName(forms, "Form validation - Join");
  assert.equal(join.outcome, "NOT_VERIFIED");
  assert.match(join.details, /Unknown invitation code/);
});

test("issue 2: form submission checks resolve without submitting, including forms whose label is not a keyword", () => {
  assert.equal(byName(main, "Form validation - Subscribe").outcome, "PASS");
  const cart = byName(forms, "Form validation - Add to cart");
  assert.equal(cart.outcome, "PASS");
  assert.equal(cart.classification, "READY_NOT_SUBMITTED");
  assert.ok(!main.executionResults.some(result => result.test.type === "button" && /Subscribe|Send Message/.test(result.test.name)),
    "submit buttons are not duplicated as button tests");
  assert.ok(forms.skippedElements.some(item => item.kind === "form" && /hidden on page load/.test(item.reason)), "dialog form reported as not tested");
});

test("safety: state-changing GET links are neither followed nor fetched", () => {
  const logout = byName(main, "Action link present (not followed) - Log out");
  assert.equal(logout.outcome, "PASS");
  assert.equal(logout.classification, "READY_NOT_CLICKED");
  assert.deepEqual(fixture.sensitiveGets, [], "no request to /account/logout or /results");
});

test("safety: a script calling form.submit() on change is cancelled and counted", () => {
  const filter = byName(forms, "Form validation - filter");
  assert.equal(filter.outcome, "PASS", filter.details);
  assert.ok(filter.validation.submitAttemptsBlocked >= 1, JSON.stringify(filter.validation));
  assert.ok(forms.safety.submitAttemptsBlocked >= 1);
  assert.match(filter.afterUrl, /forms.html/);
});

test("issue 2: side-effect buttons are verified as ready but never clicked", () => {
  const buy = byName(main, "Action button ready (not clicked) - Buy now");
  assert.equal(buy.outcome, "PASS");
  assert.equal(buy.classification, "READY_NOT_CLICKED");
  assert.ok(!fixture.mutatingRequests.some(request => request.path === "/api/purchase"));
});

test("issue 3: hidden links are reported accurately, with the reason, and the visible copy wins", () => {
  const about = byName(main, "Link works - About");
  assert.equal(about.outcome, "PASS");
  assert.equal(about.element.visible, true, "the visible link is tested, not the hidden mobile-menu copy");

  const team = byName(main, "Hidden link - Team");
  assert.equal(team.outcome, "PASS");
  assert.equal(team.element.visible, false);
  assert.match(team.element.hiddenReason, /display:none/);
  assert.match(team.details, /hidden .*not clicked/i);

  const old = byName(main, "Hidden link - Old hidden page");
  assert.equal(old.outcome, "FAIL", "a hidden link to a 404 is a real (Medium) defect");
  assert.match(old.element.hiddenReason, /visibility:hidden/);

  assert.ok(main.skippedElements.some(item => item.kind === "link" && /Hidden duplicate/.test(item.reason)));
});

test("a new tab is judged by what the real browser received, not by a re-request that bots get rejected on", () => {
  const social = byName(main, "Link works - Social profile");
  assert.equal(social.outcome, "PASS", social.details);
  assert.equal(social.navigationStatus, 200);
});

test("auto-scrolling to a button is not mistaken for the button doing something", () => {
  const inert = byName(forms, "Button works - Show more");
  assert.equal(inert.outcome, "NOT_VERIFIED", inert.details);
});

test("a required select with no empty option is not reported as 'not rejected when empty'", () => {
  const autosave = byName(forms, "Form validation - Save profile");
  const region = autosave.validation.fields.find(field => field.name === "region");
  assert.equal(region.canBeEmpty, false);
  assert.equal(region.emptyRejected, null);
  assert.equal(autosave.validation.emptiableRequiredCount, 0);
  assert.ok(!autosave.validation.observations.some(note => /Region.*not flagged/.test(note)));
});

test("links with the same label are each tested against their own destination", () => {
  assert.equal(byName(main, "Link works - Learn more (/learn-a.html)").outcome, "PASS");
  const missing = byName(main, "Link works - Learn more (/learn-b-missing.html)");
  assert.equal(missing.outcome, "FAIL", "the second link used to be skipped in favour of the first");
  assert.match(missing.details, /404/);
});

test("HTTP 999 is NOT_VERIFIED, also when returned to an in-browser navigation", () => {
  const partner = byName(main, "Link works - Partner profile");
  assert.equal(partner.outcome, "NOT_VERIFIED", partner.details);
  assert.match(partner.details, /999/);
});

test("issue 4/5: background animation is not evidence; misleading PASSes are gone", () => {
  assert.equal(byName(main, "Link works - Placeholder").outcome, "NOT_VERIFIED", "href=\"#\" with no handler is not a PASS");
  assert.equal(byName(main, "Button works - Open menu").outcome, "NOT_VERIFIED", "a button with no handler is not a PASS on an autoplay page");
  assert.equal(byName(main, "Button works - Show details").outcome, "PASS");
  assert.equal(byName(main, "Button works - Next slide").outcome, "PASS");
  const mailto = byName(main, "Link works - hello@example.com");
  assert.equal(mailto.classification, "LINK_TARGET_WELL_FORMED");
  assert.equal(byName(main, "Link works - Features").outcome, "PASS");
});

test("issue 5: hidden inputs and in-form fields do not create misleading input tests", () => {
  const inputNames = main.executionResults.filter(result => result.test.type === "input").map(result => result.test.name);
  assert.deepEqual(inputNames, ["Input exists - q"]);
  assert.ok(!main.executionResults.some(result => result.outcome === "AUTOMATION_ERROR"), "no automation errors on the fixture");
});

test("images: 404 and corrupt files fail; lazy-loaded and SVG images do not", () => {
  const images = byName(main, "Images load correctly - 7 image(s)");
  assert.equal(images.outcome, "FAIL");
  const broken = images.imageCheck.confirmedBrokenImages.map(image => path.basename(new URL(image.src).pathname)).sort();
  assert.deepEqual(broken, ["missing-photo.png", "not-an-image.png"]);
});

test("issue 4: summary, status and HTML report counts agree", () => {
  for (const run of [main, forms]) {
    const s = run.summary;
    assert.equal(s.passed + s.failed + s.notVerified + s.automationErrors, s.total);
    assert.equal(s.total, run.executionResults.length);
    for (const result of run.executionResults) {
      assert.ok(["PASS", "FAIL", "NOT_VERIFIED", "AUTOMATION_ERROR"].includes(result.outcome), result.outcome);
      assert.equal(result.status, result.outcome);
    }
  }
  assert.equal(main.status, "FAIL");
  assert.equal(forms.status, "PASS_WITH_WARNINGS");

  const html = fs.readFileSync(path.join(process.env.QA_REPORTS_DIR, "ai-qa-report.html"), "utf8");
  const total = /<div class="kpi-label">Total Tests<\/div><div class="kpi-value[^"]*">(\d+)</.exec(html)[1];
  assert.equal(Number(total), forms.summary.total);
  assert.ok(Number(main.metadata.durationMs) > 0, "report duration is recorded");
});

test("a page that cannot be loaded is a FAIL, never 'PASS with 0 tests'", async () => {
  const unreachable = await quiet(() => runPipeline("http://127.0.0.1:9/"));
  assert.equal(unreachable.status, "FAIL");
  assert.equal(unreachable.summary.total, 1);
  assert.equal(unreachable.executionResults[0].classification, "PAGE_UNREACHABLE");
});

test("a page that responds with an HTTP error fails its page-load check", async () => {
  const run = await quiet(() => runPipeline(`${fixture.baseUrl}/server-error`));
  assert.equal(byName(run, "Page loads - Error").outcome, "FAIL");
});

test("a clean page can reach an overall PASS", async () => {
  const clean = await quiet(() => runPipeline(`${fixture.baseUrl}/clean.html`));
  assert.equal(clean.status, "PASS", JSON.stringify(clean.executionResults.map(r => [r.test.name, r.outcome, r.details])));
  assert.deepEqual(fixture.mutatingRequests, []);
});

test("a valid but very slow image is reported as slow, never as broken; a corrupt file still fails", async () => {
  const run = await quiet(() => runPipeline(`${fixture.baseUrl}/media.html`));
  const images = run.executionResults.find(result => result.test.type === "broken_image");
  assert.equal(images.outcome, "FAIL", images.details);
  const broken = images.imageCheck.confirmedBrokenImages.map(image => path.basename(new URL(image.src).pathname));
  assert.deepEqual(broken, ["not-an-image.png"]);
  assert.deepEqual(images.imageCheck.slowImages.map(image => path.basename(new URL(image.src).pathname)), ["slow-ok.png"]);
  assert.match(images.details, /very slow/);
  // Hidden images with src="" are not downloaded as if the page itself were an image.
  assert.ok(!images.imageCheck.confirmedBrokenImages.some(image => !image.src || image.src.endsWith("/media.html")));
  assert.equal(images.imageCheck.totalImages, 4);

  // A full-screen cookie overlay blocked the FAQ button: it is hidden (not accepted), then the click works.
  const faq = run.executionResults.find(result => result.test.type === "button" && /Which plan/.test(result.test.name));
  assert.equal(faq.outcome, "PASS", faq.details);
  assert.ok(faq.overlaysHidden.some(overlay => /cookie-overlay/.test(overlay)), JSON.stringify(faq.overlaysHidden));
  assert.match(faq.details, /overlay covering the element/);
});

test("an FAQ disclosure button is not mistaken for the mobile menu toggle", async () => {
  const { launchBrowser } = require("../../agent/browser");
  const { discoverPage } = require("../../agent/runner");
  const { MOBILE } = require("../../agent/viewports");
  const browser = await launchBrowser();
  try {
    const mobile = await discoverPage(browser, `${fixture.baseUrl}/media.html`, { viewport: MOBILE });
    assert.ok(mobile.discovery.hiddenNavLinkCount > 0, "the page does hide its navigation on mobile");
    assert.equal(mobile.discovery.menuToggle, null);
  } finally {
    await browser.close();
  }
});
