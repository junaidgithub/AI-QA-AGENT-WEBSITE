/**
 * Comprehensive deterministic QA test planner.
 *
 * The planner turns discovery data into executable tests. It does not decide
 * whether a website is broken; that decision belongs to the executor.
 *
 * planTestsWithNotes() also returns `skipped`: elements deliberately not
 * turned into tests (with the reason), so the report can show them instead of
 * silently dropping them.
 */

function cleanText(value, fallback = "") {
  return String(value ?? fallback).replace(/\s+/g, " ").trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const cleaned = cleanText(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

// Used only for discovery data from older versions that lacked submit metadata.
const LEGACY_SUBMIT_PATTERN = /\b(send message|submit|send|contact us|request demo|book now)\b/i;

/*
 * Buttons whose label suggests a real-world side effect. They are never
 * clicked; the executor only verifies that they are present and enabled.
 */
const SIDE_EFFECT_PATTERN = /\b(send|submit|buy|purchase|pay|checkout|check out|place order|order now|add to (cart|bag|basket|wishlist)|subscribe|unsubscribe|sign ?up|register|book|reserve|donate|delete|remove|confirm|apply|upload|log ?out|sign ?out|transfer|withdraw|deposit|request (a )?(demo|quote|call|callback)|save|post|publish|accept|agree|cancel|join|vote|follow|share|invite|reply|create|update|reset password)\b/i;

/*
 * Links are GET navigations and normally safe to follow, but some trigger
 * state changes through GET (log out, unsubscribe, add-to-cart URLs). Those
 * are neither clicked nor fetched.
 */
const SIDE_EFFECT_LINK_LABEL = /\b(log ?out|sign ?out|unsubscribe|delete|remove|add to (cart|bag|basket|wishlist)|buy|purchase|checkout|check out|pay now|place order|cancel (my )?(subscription|order|account))\b/i;
// Whole path segments or query keys only, so ordinary pages such as /blog-outreach or /delete-my-data-policy are not flagged.
const SIDE_EFFECT_LINK_URL = /((^|\/)(log-?out|sign-?out|unsubscribe)(\/|$|\?|\.)|[?&](delete|remove|add-to-cart|add_to_cart)=|(^|\/)(delete|remove)(\/|$|\?)|(^|\/)add-?to-?cart(\/|$|\?)|(^|\/)cart\/add(\/|$|\?)|(^|\/)checkout(\/|$|\?))/i;

function hasSideEffectLink(label, href) {
  let target = String(href || "");
  try { const url = new URL(target); target = url.pathname + url.search; } catch {}
  return SIDE_EFFECT_LINK_LABEL.test(cleanText(label)) || SIDE_EFFECT_LINK_URL.test(target);
}

const NON_FILLABLE_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

function hasSideEffectLabel(label) {
  return SIDE_EFFECT_PATTERN.test(cleanText(label));
}

function pathOf(href) {
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}${url.hash}` || href;
  } catch {
    return cleanText(href);
  }
}

function normalizeHref(href) {
  try {
    const url = new URL(href);
    url.hash = url.hash === "#" ? "" : url.hash;
    return url.href.replace(/\/$/, "");
  } catch {
    return cleanText(href);
  }
}

function isExternalTo(href, pageUrl) {
  try {
    const host = value => new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return Boolean(pageUrl) && host(href) !== host(pageUrl);
  } catch {
    return false;
  }
}

function linkLabel(link) {
  return firstNonEmpty(link.text, link.name, link.ariaLabel, link.label, link.title);
}

function buttonLabel(button) {
  return firstNonEmpty(button.text, button.name, button.ariaLabel, button.label, button.value, button.title);
}

// Ids/names such as "plyr-seek-5270" or "field_9f3a2c1b" are generated per page load and cannot
// be used to find the same input again; a label is stable.
function looksGenerated(value) {
  return /\d{3,}|[0-9a-f]{8,}/i.test(cleanText(value));
}

function inputIdentifier(input) {
  const stableName = looksGenerated(input.name) ? "" : input.name;
  const stableId = looksGenerated(input.id) ? "" : input.id;
  return firstNonEmpty(stableName, input.identifier, stableId, input.placeholder, input.ariaLabel, input.label, input.name, input.id);
}

function isVisible(element) {
  return element.visible !== false;
}

function planLinks(disc, tests, skipped, options = {}) {
  const all = (disc.links || []).filter(link => firstNonEmpty(link.href, linkLabel(link)));

  // Visible links first, so a hidden duplicate (e.g. a mobile-menu copy) never
  // stands in for the visible link a user would click.
  const ordered = [...all.filter(isVisible), ...all.filter(link => !isVisible(link))];
  const visibleDestinations = new Set(ordered.filter(isVisible).map(link => normalizeHref(link.href)));

  const seen = new Set();
  const planned = [];
  for (const link of ordered) {
    const label = linkLabel(link);
    if (link.inConsentBanner) {
      skipped.push({ kind: "link", label: label || pathOf(link.href), href: link.href, reason: "Cookie-consent control; clicking it records a consent choice, so it is not tested." });
      continue;
    }
    const key = `${label.toLowerCase()}|${normalizeHref(link.href)}`;
    if (seen.has(key)) {
      if (!isVisible(link)) {
        skipped.push({ kind: "link", label: label || pathOf(link.href), href: link.href, reason: `Hidden duplicate of a visible link (${link.hiddenReason || "hidden"}); the visible link is tested.` });
      }
      continue;
    }
    seen.add(key);

    // In the mobile layout hidden links are usually inside the collapsed menu;
    // their destinations are already checked by the desktop run.
    if (options.viewport === "mobile" && !isVisible(link)) {
      skipped.push({ kind: "link", label: label || pathOf(link.href), href: link.href, reason: `Hidden in the mobile layout (${link.hiddenReason || "hidden"}), e.g. inside the collapsed menu; its destination is checked in the desktop run.` });
      continue;
    }
    // Hidden links to other websites (cookie-consent widgets, collapsed share menus) are listed,
    // not requested: they are not user-facing and mostly hit third-party bot protection.
    if (!isVisible(link) && isExternalTo(link.href, disc.url)) {
      skipped.push({ kind: "link", label: label || pathOf(link.href), href: link.href, reason: `Hidden link to another website (${link.hiddenReason || "hidden"}); not checked. Hidden links within this site are checked.` });
      continue;
    }
    if (!isVisible(link) && visibleDestinations.has(normalizeHref(link.href))) {
      skipped.push({ kind: "link", label: label || pathOf(link.href), href: link.href, reason: `Hidden link (${link.hiddenReason || "hidden"}) with the same destination as a visible link that is tested.` });
      continue;
    }
    planned.push(link);
  }

  const labelCounts = {};
  for (const link of planned) {
    const label = linkLabel(link).toLowerCase();
    labelCounts[label] = (labelCounts[label] || 0) + 1;
  }

  for (const link of planned) {
    const label = linkLabel(link);
    const hidden = !isVisible(link);
    const display = label || `Unnamed link → ${pathOf(link.href)}`;
    // Disambiguate links that share a label but go to different places.
    const suffix = label && labelCounts[label.toLowerCase()] > 1 ? ` (${pathOf(link.href)})` : "";

    const sideEffectRisk = hasSideEffectLink(label, link.href);
    if (sideEffectRisk && hidden) {
      skipped.push({ kind: "link", label: display, href: link.href, reason: `Hidden action link (${link.hiddenReason || "hidden"}) such as checkout or log out; never followed.` });
      continue;
    }
    tests.push({
      name: sideEffectRisk ? `Action link present (not followed) - ${display}${suffix}` : `${hidden ? "Hidden link" : "Link works"} - ${display}${suffix}`,
      type: "link",
      sideEffectRisk,
      text: label || null,
      href: firstNonEmpty(link.href) || null,
      rawHref: firstNonEmpty(link.rawHref) || null,
      target: firstNonEmpty(link.target) || null,
      rel: firstNonEmpty(link.rel) || null,
      selector: firstNonEmpty(link.selector) || null,
      id: firstNonEmpty(link.id) || null,
      ariaLabel: firstNonEmpty(link.ariaLabel) || null,
      domIndex: Number.isInteger(link.domIndex) ? link.domIndex : null,
      expectedHidden: hidden,
      hiddenReason: link.hiddenReason || null
    });
  }
}

function planButtons(disc, tests, skipped, legacySubmitLabels, coveredFormIndexes, options = {}) {
  const candidates = [];
  let unnamedCount = 0;

  for (const button of disc.buttons || []) {
    const label = buttonLabel(button);
    const buttonType = cleanText(button.buttonType).toLowerCase();

    if (button.isSubmit === true) {
      const covered = coveredFormIndexes.has(button.formIndex);
      skipped.push({
        kind: "button",
        label: label || "Unnamed submit button",
        reason: covered
          ? `Form submit control; covered by the form validation test for form ${Number(button.formIndex) + 1}. Never clicked.`
          : `Submit control of form ${Number(button.formIndex) + 1}, which is not tested (see the form entry). Never clicked.`
      });
      continue;
    }
    if (button.inForm && buttonType === "reset") {
      skipped.push({ kind: "button", label: label || "Reset", reason: "Form reset control; it only clears local input and is not exercised." });
      continue;
    }
    // Older discovery data had no submit metadata; fall back to the legacy keyword match.
    if (button.isSubmit === undefined && legacySubmitLabels.has(label.toLowerCase())) continue;
    if (!isVisible(button)) {
      skipped.push({ kind: "button", label: label || "Unnamed button", reason: `Hidden at the tested viewport (${button.hiddenReason || "hidden"}); not actionable by a user.` });
      continue;
    }
    if (!label && !button.selector) continue;
    if (button.inConsentBanner) {
      skipped.push({ kind: "button", label: label || "Cookie button", reason: "Cookie-consent control; clicking it records a consent choice, so it is not tested." });
      continue;
    }
    if (button.disabled) {
      skipped.push({ kind: "button", label: label || "Unnamed button", reason: "Disabled when the page loads (usually enabled after earlier steps, e.g. choosing options); not clicked." });
      continue;
    }
    if (options.menuToggleSelector && button.selector === options.menuToggleSelector) {
      skipped.push({ kind: "button", label: label || "Menu", reason: "Mobile menu toggle; covered by the mobile menu test." });
      continue;
    }

    const text = label || `Unnamed button #${(unnamedCount += 1)}`;
    candidates.push({ button, label, text });
  }

  // Same label → same behaviour in practice (e.g. repeated "Learn more" buttons); test once.
  const unique = uniqueBy(candidates, item => (item.label ? item.label.toLowerCase() : `selector:${item.button.selector}`));

  for (const { button, label, text } of unique) {
    const sideEffectRisk = hasSideEffectLabel(label);
    tests.push({
      name: sideEffectRisk ? `Action button ready (not clicked) - ${text}` : `Button works - ${text}`,
      type: "button",
      text: label || null,
      selector: firstNonEmpty(button.selector) || null,
      id: firstNonEmpty(button.id) || null,
      ariaLabel: firstNonEmpty(button.ariaLabel) || null,
      sideEffectRisk
    });
  }
}

function formDisplayName(form, index) {
  return firstNonEmpty(form.ariaLabel, form.name, form.id, `Form ${index + 1}`);
}

function planForms(disc, tests, skipped) {
  const coveredFormIndexes = new Set();
  const details = Array.isArray(disc.formDetails) ? disc.formDetails : [];

  if (details.length) {
    const nameCounts = {};
    const planned = [];

    const seenShapes = new Map();
    for (const form of details) {
      const index = Number.isInteger(form.index) ? form.index : details.indexOf(form);
      const submit = (form.submitControls || []).find(control => control.visible !== false) || (form.submitControls || [])[0];
      const label = firstNonEmpty(submit?.text, formDisplayName(form, index));

      if (!isVisible(form)) {
        skipped.push({ kind: "form", label: formDisplayName(form, index), reason: `Form is hidden on page load (${form.hiddenReason || "hidden"}), e.g. inside a closed dialog or menu; not interacted with.` });
        continue;
      }
      if (!Number(form.fillableControlCount) && !(form.submitControls || []).length) {
        skipped.push({ kind: "form", label: formDisplayName(form, index), reason: "Form has no fillable fields and no submit control." });
        continue;
      }
      // Repeated identical forms (e.g. an "Add to basket" form per product) behave the same; test one.
      const shapeKey = `${label.toLowerCase()}|${(form.fieldNames || []).join(",")}|${Number(form.fillableControlCount) || 0}`;
      if (seenShapes.has(shapeKey)) {
        seenShapes.get(shapeKey).count += 1;
        continue;
      }
      seenShapes.set(shapeKey, { label, count: 1 });

      nameCounts[label.toLowerCase()] = (nameCounts[label.toLowerCase()] || 0) + 1;
      planned.push({ form, index, label, submit });
    }

    for (const shape of seenShapes.values()) {
      if (shape.count > 1) {
        skipped.push({ kind: "form", label: shape.label, reason: `${shape.count - 1} more identical form(s) on this page (same fields and button); one of them is tested.` });
      }
    }

    for (const { form, index, label, submit } of planned) {
      const suffix = nameCounts[label.toLowerCase()] > 1 ? ` (form ${index + 1})` : "";
      coveredFormIndexes.add(index);
      tests.push({
        name: `Form validation - ${label}${suffix}`,
        type: "form_submit",
        text: firstNonEmpty(submit?.text) || null,
        selector: firstNonEmpty(submit?.selector) || null,
        formSelector: firstNonEmpty(form.selector) || null,
        formId: firstNonEmpty(form.id) || null,
        formIndex: index,
        // Identifies the same form on several pages (e.g. a footer newsletter form).
        fieldSignature: Array.isArray(form.fieldNames) && form.fieldNames.length ? form.fieldNames.join(",") : null
      });
    }
    return coveredFormIndexes;
  }

  // Discovery versions before formDetails existed only returned forms: <count>
  // and a buttons array. Recover submit-like actions from that schema.
  const discoveredFormActions = (disc.formActions || disc.formSubmits || []).slice();
  if (!discoveredFormActions.length && Number(disc.forms) > 0) {
    for (const button of disc.buttons || []) {
      if (LEGACY_SUBMIT_PATTERN.test(buttonLabel(button))) discoveredFormActions.push({ ...button, formIndex: 0 });
    }
  }

  const formActions = uniqueBy(
    discoveredFormActions.filter(item => buttonLabel(item)),
    item => buttonLabel(item).toLowerCase()
  );

  for (const action of formActions) {
    const formIndex = Number.isInteger(action.formIndex) ? action.formIndex : null;
    if (formIndex !== null) coveredFormIndexes.add(formIndex);
    tests.push({
      name: `Form validation - ${buttonLabel(action)}`,
      type: "form_submit",
      text: buttonLabel(action),
      selector: firstNonEmpty(action.selector) || null,
      formIndex
    });
  }

  return coveredFormIndexes;
}

function planInputs(disc, tests, skipped, coveredFormIndexes, hasFormDetails) {
  const inputs = (disc.inputs || []).filter(input => inputIdentifier(input));

  const toTest = [];
  for (const input of inputs) {
    const type = cleanText(input.type).toLowerCase();
    const identifier = inputIdentifier(input);

    if (NON_FILLABLE_INPUT_TYPES.has(type)) continue; // hidden tokens, buttons: not user inputs
    if (hasFormDetails && input.inForm && coveredFormIndexes.has(input.formIndex)) continue; // checked field-by-field by the form test
    if (!isVisible(input)) {
      skipped.push({ kind: "input", label: identifier, reason: `Not visible (${input.hiddenReason || "hidden"}); hidden fields such as honeypots or custom-styled checkboxes are not user-facing.` });
      continue;
    }
    toTest.push(input);
  }

  const unique = uniqueBy(toTest, input => inputIdentifier(input).toLowerCase());

  for (const input of unique) {
    const identifier = inputIdentifier(input);
    tests.push({
      name: `Input exists - ${identifier}`,
      type: "input",
      identifier,
      nameAttr: looksGenerated(input.name) ? null : firstNonEmpty(input.name) || null,
      id: looksGenerated(input.id) ? null : firstNonEmpty(input.id) || null,
      placeholder: firstNonEmpty(input.placeholder) || null,
      ariaLabel: firstNonEmpty(input.ariaLabel) || null,
      label: firstNonEmpty(input.label) || null,
      // A discovery selector built on a generated id would not match on the next page load.
      selector: looksGenerated(input.id) || looksGenerated(input.name) ? null : firstNonEmpty(input.selector) || null
    });
  }
}

function planCarousels(disc, tests) {
  const carousels = uniqueBy(
    (disc.carousels || []).filter(item => firstNonEmpty(item.text, item.name, item.ariaLabel, item.label)),
    item => firstNonEmpty(item.text, item.name, item.ariaLabel, item.label).toLowerCase()
  );

  for (const carousel of carousels) {
    const text = firstNonEmpty(carousel.text, carousel.name, carousel.ariaLabel, carousel.label);
    tests.push({
      name: `Carousel works - ${text}`,
      type: "carousel",
      text,
      selector: firstNonEmpty(carousel.selector) || null
    });
  }
}

/**
 * options.viewport: "desktop" (default) or "mobile". In the mobile layout a
 * hamburger-menu test is added and hidden links are left to the desktop run.
 */
function planTestsWithNotes(disc = {}, options = {}) {
  const viewport = options.viewport || "desktop";
  const menuTest = viewport === "mobile" && disc.menuToggle && Number(disc.hiddenNavLinkCount) > 0
    ? { name: `Mobile menu opens - ${firstNonEmpty(disc.menuToggle.text, "Menu")}`, type: "mobile_menu", text: firstNonEmpty(disc.menuToggle.text) || null, selector: disc.menuToggle.selector || null }
    : null;
  const tests = [];
  const skipped = [];

  if (disc.title || disc.url || disc.pageUrl) {
    tests.push({
      name: `Page loads - ${firstNonEmpty(disc.title, "Untitled page")}`,
      type: "page_load"
    });
  }

  planLinks(disc, tests, skipped, { viewport });
  if (menuTest) tests.push(menuTest);

  const hasFormDetails = Array.isArray(disc.formDetails) && disc.formDetails.length > 0;
  const legacySubmitLabels = new Set(
    !hasFormDetails && Number(disc.forms) > 0
      ? (disc.buttons || []).map(buttonLabel).filter(label => LEGACY_SUBMIT_PATTERN.test(label)).map(label => label.toLowerCase())
      : []
  );

  // Forms are planned first so button notes know which forms are covered;
  // their tests are still listed after buttons, as before.
  const formTests = [];
  const formNotes = [];
  const coveredFormIndexes = planForms(disc, formTests, formNotes);

  planButtons(disc, tests, skipped, legacySubmitLabels, coveredFormIndexes, { menuToggleSelector: menuTest?.selector });
  planCarousels(disc, tests);
  tests.push(...formTests);
  skipped.push(...formNotes);
  planInputs(disc, tests, skipped, coveredFormIndexes, hasFormDetails);

  const imageCount = Number(disc.imageCount) || Number(disc.images?.length) || 0;
  if (imageCount > 0) {
    tests.push({
      name: `Images load correctly - ${imageCount} image(s)`,
      type: "broken_image"
    });
  }

  const uniqueTests = uniqueBy(
    tests,
    test => [
      test.type,
      test.text || "",
      test.identifier || "",
      test.formIndex ?? "",
      test.href || "",
      test.selector || ""
    ].join("|")
  );

  return { tests: uniqueTests, skipped };
}

function planTests(disc = {}, options = {}) {
  return planTestsWithNotes(disc, options).tests;
}

module.exports = { planTests, planTestsWithNotes, hasSideEffectLabel, hasSideEffectLink, SIDE_EFFECT_PATTERN };
