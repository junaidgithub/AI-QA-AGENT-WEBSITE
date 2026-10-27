const test = require("node:test");
const assert = require("node:assert/strict");
const { planTests, planTestsWithNotes, hasSideEffectLabel } = require("../../agent/ai-test-planner");

const BASE = "https://site.test";

function link(text, path, extra = {}) {
  return { text, href: `${BASE}${path}`, rawHref: path, visible: true, hiddenReason: null, ...extra };
}

function discovery(extra = {}) {
  return { title: "Home", url: `${BASE}/`, links: [], buttons: [], inputs: [], forms: 0, formDetails: [], imageCount: 0, ...extra };
}

const names = tests => tests.map(t => t.name);

test("a hidden duplicate of a visible link is not tested twice and never replaces it", () => {
  const { tests, skipped } = planTestsWithNotes(discovery({
    links: [
      link("About", "/about", { visible: false, hiddenReason: "inside a container with display:none" }),
      link("About", "/about")
    ]
  }));
  const linkTests = tests.filter(t => t.type === "link");
  assert.equal(linkTests.length, 1);
  assert.equal(linkTests[0].expectedHidden, false);
  assert.equal(linkTests[0].name, "Link works - About");
  assert.ok(skipped.some(s => s.kind === "link" && /hidden duplicate/i.test(s.reason)));
});

test("hidden-only links are tested and labelled as hidden", () => {
  const tests = planTests(discovery({ links: [link("Secret", "/secret", { visible: false, hiddenReason: "display:none" })] }));
  const secret = tests.find(t => t.type === "link");
  assert.equal(secret.name, "Hidden link - Secret");
  assert.equal(secret.expectedHidden, true);
  assert.equal(secret.hiddenReason, "display:none");
});

test("links that share a label but not a destination are both tested and disambiguated", () => {
  const tests = planTests(discovery({ links: [link("Learn more", "/a"), link("Learn more", "/b")] }));
  assert.deepEqual(names(tests.filter(t => t.type === "link")), ["Link works - Learn more (/a)", "Link works - Learn more (/b)"]);
});

test("unnamed links are named after their destination", () => {
  const tests = planTests(discovery({ links: [link("", "/pricing")] }));
  assert.equal(tests.find(t => t.type === "link").name, "Link works - Unnamed link → /pricing");
});

test("every form gets a validation test, whatever its submit label says", () => {
  const { tests, skipped } = planTestsWithNotes(discovery({
    forms: 2,
    buttons: [
      { text: "Request callback", buttonType: "submit", isSubmit: true, inForm: true, formIndex: 0, visible: true },
      { text: "Subscribe", buttonType: "submit", isSubmit: true, inForm: true, formIndex: 1, visible: true }
    ],
    formDetails: [
      { index: 0, id: "contact", visible: true, fillableControlCount: 3, submitControls: [{ text: "Request callback", visible: true }] },
      { index: 1, id: "newsletter", visible: true, fillableControlCount: 1, submitControls: [{ text: "Subscribe", visible: true }] }
    ]
  }));
  assert.deepEqual(names(tests.filter(t => t.type === "form_submit")), ["Form validation - Request callback", "Form validation - Subscribe"]);
  // Regression: submit buttons used to become separate "Button works" tests stuck at NOT_VERIFIED.
  assert.equal(tests.filter(t => t.type === "button").length, 0);
  assert.equal(skipped.filter(s => s.kind === "button" && /covered by the form validation test/.test(s.reason)).length, 2);
});

test("a hidden form is not tested and its submit note says so", () => {
  const { tests, skipped } = planTestsWithNotes(discovery({
    forms: 1,
    buttons: [{ text: "Log in", buttonType: "submit", isSubmit: true, inForm: true, formIndex: 0, visible: false }],
    formDetails: [{ index: 0, id: "login", visible: false, hiddenReason: "display:none", fillableControlCount: 2, submitControls: [{ text: "Log in", visible: false }] }]
  }));
  assert.equal(tests.filter(t => t.type === "form_submit").length, 0);
  assert.ok(skipped.some(s => s.kind === "form" && /hidden on page load/.test(s.reason)));
  assert.ok(skipped.some(s => s.kind === "button" && /not tested/.test(s.reason)));
});

test("fields inside a validated form are not duplicated as input tests; hidden inputs are skipped", () => {
  const { tests, skipped } = planTestsWithNotes(discovery({
    forms: 1,
    formDetails: [{ index: 0, visible: true, fillableControlCount: 1, submitControls: [{ text: "Send", visible: true }] }],
    inputs: [
      { tag: "input", type: "email", name: "email", inForm: true, formIndex: 0, visible: true },
      { tag: "input", type: "hidden", name: "csrf_token", inForm: false, formIndex: -1, visible: false },
      { tag: "input", type: "text", name: "website", inForm: false, formIndex: -1, visible: false, hiddenReason: "display:none" },
      { tag: "input", type: "search", name: "q", inForm: false, formIndex: -1, visible: true }
    ]
  }));
  assert.deepEqual(names(tests.filter(t => t.type === "input")), ["Input exists - q"]);
  assert.ok(skipped.some(s => s.label === "website"));
  assert.ok(!skipped.some(s => s.label === "csrf_token"), "hidden-type inputs are not user inputs at all");
});

test("side-effect buttons are planned as 'not clicked' readiness checks", () => {
  const tests = planTests(discovery({
    buttons: [
      { text: "Buy now", buttonType: "button", isSubmit: false, inForm: false, formIndex: -1, visible: true, selector: "#buy" },
      { text: "Show details", buttonType: "button", isSubmit: false, inForm: false, formIndex: -1, visible: true, selector: "#show" }
    ]
  }));
  const buy = tests.find(t => t.text === "Buy now");
  assert.equal(buy.sideEffectRisk, true);
  assert.equal(buy.name, "Action button ready (not clicked) - Buy now");
  assert.equal(tests.find(t => t.text === "Show details").sideEffectRisk, false);
  for (const label of ["Send message", "Add to cart", "Checkout", "Delete account", "Subscribe", "Place order"]) {
    assert.ok(hasSideEffectLabel(label), label);
  }
  for (const label of ["Next slide", "Show details", "Menu", "Learn more"]) {
    assert.ok(!hasSideEffectLabel(label), label);
  }
});

test("state-changing links are planned as 'not followed'", () => {
  const tests = planTests(discovery({ links: [link("Log out", "/logout"), link("Shop", "/cart/add?id=1"), link("Sign up", "/register")] }));
  assert.deepEqual(tests.filter(t => t.type === "link").map(t => [t.name, t.sideEffectRisk]), [
    ["Action link present (not followed) - Log out", true],
    ["Action link present (not followed) - Shop", true],
    ["Link works - Sign up", false]
  ]);
});

test("hidden buttons are reported as skipped instead of producing NOT_VERIFIED noise", () => {
  const { tests, skipped } = planTestsWithNotes(discovery({
    buttons: [{ text: "Menu", buttonType: "button", isSubmit: false, inForm: false, visible: false, hiddenReason: "display:none" }]
  }));
  assert.equal(tests.filter(t => t.type === "button").length, 0);
  assert.ok(skipped.some(s => s.label === "Menu"));
});

test("legacy discovery data (forms as a count, no metadata) still produces form tests", () => {
  const tests = planTests({
    title: "Legacy",
    links: [{ text: "Home", href: `${BASE}/` }],
    buttons: [{ text: "Send Message", type: "button" }, { text: "Next slide", type: "button" }],
    inputs: [{ tag: "input", type: "text", name: "name" }],
    forms: 1,
    imageCount: 2
  });
  assert.deepEqual(names(tests), [
    "Page loads - Legacy",
    "Link works - Home",
    "Button works - Next slide",
    "Form validation - Send Message",
    "Input exists - name",
    "Images load correctly - 2 image(s)"
  ]);
});

test("identical repeated forms on one page are planned once, with a note", () => {
  const formDetails = [0, 1, 2].map(index => ({ index, visible: true, fillableControlCount: 0, fieldNames: [], submitControls: [{ text: "Add to basket", visible: true }] }));
  formDetails.push({ index: 3, id: "search", visible: true, fillableControlCount: 1, fieldNames: ["q"], submitControls: [{ text: "Search", visible: true }] });
  const { tests, skipped } = planTestsWithNotes(discovery({ forms: 4, formDetails }));
  assert.deepEqual(tests.filter(t => t.type === "form_submit").map(t => t.name), ["Form validation - Add to basket", "Form validation - Search"]);
  assert.ok(skipped.some(s => /2 more identical form/.test(s.reason)));
});

test("hidden links to other websites are listed, not checked; hidden internal links are still checked", () => {
  const { tests, skipped } = planTestsWithNotes(discovery({
    links: [
      link("_ga", "", { href: "https://cookiedatabase.org/cookie/ga/", visible: false, hiddenReason: "visibility:hidden" }),
      link("About Us", "/about-us", { visible: false, hiddenReason: "display:none" })
    ]
  }));
  assert.deepEqual(tests.filter(t => t.type === "link").map(t => t.name), ["Hidden link - About Us"]);
  assert.ok(skipped.some(s => s.label === "_ga" && /another website/.test(s.reason)));
});

test("inputs with generated ids are identified by their label, not the per-load id", () => {
  const tests = planTests(discovery({
    inputs: [
      { tag: "input", type: "range", id: "plyr-seek-5270", ariaLabel: "Seek", inForm: false, formIndex: -1, visible: true, selector: "#plyr-seek-5270" },
      { tag: "input", type: "text", name: "field_9f3a2c1b", label: "Promo code", inForm: false, formIndex: -1, visible: true, selector: "#x" }
    ]
  }));
  const inputs = tests.filter(t => t.type === "input");
  assert.deepEqual(inputs.map(t => t.name), ["Input exists - Seek", "Input exists - Promo code"]);
  assert.equal(inputs[0].id, null);
  assert.equal(inputs[0].selector, null);
  assert.equal(inputs[0].ariaLabel, "Seek");
});

test("disabled buttons and cookie-consent controls are listed, not tested", () => {
  const { tests, skipped } = planTestsWithNotes(discovery({
    buttons: [
      { text: "Check My Evaluation", buttonType: "button", isSubmit: false, inForm: false, visible: true, disabled: true, selector: "#check" },
      { text: "Functional only", buttonType: "button", isSubmit: false, inForm: false, visible: true, inConsentBanner: true, selector: "#cc" },
      { text: "Show details", buttonType: "button", isSubmit: false, inForm: false, visible: true, selector: "#show" }
    ],
    links: [link("Cookie policy", "/cookie-policy", { inConsentBanner: true })]
  }));
  assert.deepEqual(tests.filter(t => t.type === "button").map(t => t.text), ["Show details"]);
  assert.ok(!tests.some(t => t.type === "link" && t.text === "Cookie policy"));
  assert.ok(skipped.some(s => s.label === "Check My Evaluation" && /Disabled when the page loads/.test(s.reason)));
  assert.equal(skipped.filter(s => /Cookie-consent control/.test(s.reason)).length, 2);
});
