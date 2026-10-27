/**
 * Non-submitting form validation check.
 *
 * What it verifies, field by field, without ever submitting the form:
 *   1. required fields are rejected when empty
 *   2. email/url/pattern fields reject an obviously invalid value
 *   3. every user-fillable field accepts a realistic value that satisfies the
 *      field's own declared constraints (see form-values.js)
 *   4. the submit control is present and enabled once the form is valid
 *
 * The form is never submitted: no submit control is clicked, Enter is never
 * pressed, a capture-phase listener cancels any submit event, and the
 * request guard in browser.js aborts every non-GET request.
 *
 * Outcome rules:
 *   PASS             - all checks above hold for every tested field
 *   NOT_VERIFIED     - a field rejected every generated value, or the submit
 *                      control stayed disabled (custom rules / CAPTCHA)
 *   AUTOMATION_ERROR - the agent could not interact with one or more fields
 * Backend processing is out of scope and is stated as such in the details.
 */

const { OUTCOMES, setOutcome } = require("./outcomes");
const { candidateValues, invalidSampleFor, isEmailLike } = require("./form-values");

const FIELD_TIMEOUT = 3000;
const VALIDATION_SETTLE_MS = 60;
const NON_FILLABLE_TYPES = ["hidden", "submit", "button", "reset", "image"];

// Cancels submit events and neutralises form.submit()/requestSubmit(), which
// scripts call directly (e.g. <select onchange="this.form.submit()">) and which
// do not fire a submit event.
async function blockSubmitEvents(page) {
  await page.evaluate(() => {
    if (window.__qaSubmitGuard) return;
    window.__qaSubmitGuard = { blocked: 0 };
    document.addEventListener("submit", event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.__qaSubmitGuard.blocked += 1;
    }, true);
    HTMLFormElement.prototype.submit = function blockedSubmit() { window.__qaSubmitGuard.blocked += 1; };
    HTMLFormElement.prototype.requestSubmit = function blockedRequestSubmit() { window.__qaSubmitGuard.blocked += 1; };
  }).catch(() => {});
}

async function blockedSubmitCount(page) {
  return page.evaluate(() => window.__qaSubmitGuard?.blocked || 0).catch(() => 0);
}

async function locateForm(page, test) {
  const forms = page.locator("form");
  const count = await forms.count();

  if (test.formId) {
    const byId = page.locator(`form[id="${String(test.formId).replace(/"/g, '\\"')}"]`).first();
    if (await byId.count()) return { form: byId, strategy: "form id" };
  }
  if (Number.isInteger(test.formIndex) && test.formIndex < count) {
    return { form: forms.nth(test.formIndex), strategy: "form index" };
  }
  if (test.formSelector) {
    const bySelector = page.locator(test.formSelector).first();
    if (await bySelector.count().catch(() => 0)) return { form: bySelector, strategy: "form selector" };
  }
  if (test.text) {
    const button = page.getByRole("button", { name: test.text, exact: true }).first();
    if (await button.count().catch(() => 0)) {
      const parent = button.locator("xpath=ancestor::form").first();
      if (await parent.count()) return { form: parent, strategy: "submit control" };
    }
  }
  return null;
}

function describeControls(elements, nonFillableTypes) {
  const qa = window.__qa;
  return elements.map((el, index) => {
    const type = (el.type || "text").toLowerCase();
    const hiddenReason = qa ? qa.hiddenReason(el) : null;
    return {
      index,
      tag: el.tagName.toLowerCase(),
      type,
      name: el.name || "",
      id: el.id || "",
      label: qa ? qa.labelText(el) : "",
      placeholder: el.getAttribute("placeholder") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      required: Boolean(el.required),
      ariaRequired: el.getAttribute("aria-required") === "true",
      disabled: Boolean(el.disabled),
      readOnly: Boolean(el.readOnly),
      visible: !hiddenReason,
      hiddenReason,
      minLength: el.minLength,
      maxLength: el.maxLength,
      min: el.getAttribute("min") || "",
      max: el.getAttribute("max") || "",
      step: el.getAttribute("step") || "",
      pattern: el.getAttribute("pattern") || "",
      multiple: Boolean(el.multiple),
      fillableType: !nonFillableTypes.includes(type),
      options: el.tagName === "SELECT"
        ? [...el.options].map((option, optionIndex) => ({ index: optionIndex, value: option.value, text: option.text.trim(), disabled: option.disabled }))
        : []
    };
  });
}

function fieldLabel(meta) {
  return meta.label || meta.ariaLabel || meta.placeholder || meta.name || meta.id || meta.type;
}

async function readFieldState(control) {
  return control.evaluate(el => ({
    valid: el.checkValidity(),
    message: el.validationMessage || "",
    valueMissing: el.validity.valueMissing,
    ariaInvalid: el.getAttribute("aria-invalid"),
    value: el.type === "checkbox" || el.type === "radio" ? String(el.checked) : String(el.value ?? "")
  }));
}

async function blurField(control) {
  await control.evaluate(el => {
    if (document.activeElement === el) {
      el.blur();
    } else {
      el.dispatchEvent(new FocusEvent("blur"));
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
  }).catch(() => {});
}

// Native value setter + events: works for hidden inputs and framework-controlled inputs.
async function setValueProgrammatically(control, value) {
  await control.evaluate((el, newValue) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, newValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function setTextValue(control, meta, value) {
  if (meta.visible) {
    try {
      await control.fill(value, { timeout: FIELD_TIMEOUT });
      return "typed";
    } catch {}
  }
  await setValueProgrammatically(control, value);
  return "programmatic";
}

async function setChecked(control, checked) {
  try {
    await control.setChecked(checked, { timeout: FIELD_TIMEOUT });
    return "clicked";
  } catch {}
  // Custom-styled controls hide the real input; clicking its <label> is what a user does.
  const viaLabel = await control.evaluate((el, wanted) => {
    if (el.checked === wanted) return true;
    const label = el.labels && el.labels[0];
    if (label) label.click();
    return el.checked === wanted;
  }, checked).catch(() => false);
  if (viaLabel) return "label";
  await control.evaluate((el, wanted) => {
    if (el.type === "radio" && !wanted) {
      el.checked = false;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.checked !== wanted) {
      el.click();
    }
  }, checked);
  return "programmatic";
}

async function selectOption(control, meta, optionIndex) {
  try {
    await control.selectOption({ index: optionIndex }, { timeout: FIELD_TIMEOUT });
    return "selected";
  } catch {}
  await control.evaluate((el, index) => {
    el.selectedIndex = index;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, optionIndex);
  return "programmatic";
}

function chooseValidOption(meta) {
  const usable = meta.options.filter(option => !option.disabled && option.value !== "");
  const nonPlaceholder = usable.filter(option => !/^(select|choose|pick|please|--|—)/i.test(option.text));
  return (nonPlaceholder[0] || usable[0] || null)?.index ?? null;
}

function rejectedBy(state) {
  return !state.valid || state.ariaInvalid === "true";
}

async function submitControlState(form) {
  const controls = form.locator("button:not([type]), button[type='submit'], input[type='submit'], input[type='image']");
  const count = await controls.count().catch(() => 0);
  if (!count) return null;
  return controls.first().evaluate(el => ({
    text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 120),
    visible: window.__qa ? !window.__qa.hiddenReason(el) : true,
    disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true"
  })).catch(() => null);
}

async function runFormValidation(page, test, result, guard) {
  await blockSubmitEvents(page);
  // Any page navigation during a form test would mean data left the page; abort it.
  if (guard) guard.blockNavigationOf = page;

  const located = await locateForm(page, test);
  if (!located) {
    return setOutcome(result, OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR",
      `Form could not be located on the page (${test.text || `form ${Number(test.formIndex) + 1}`}). No data was submitted.`);
  }

  const { form } = located;
  const formHidden = await form.evaluate(el => window.__qa ? window.__qa.hiddenReason(el) : null).catch(() => null);
  if (formHidden) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
      `Form exists but is not visible (${formHidden}), e.g. inside a closed dialog; it was not interacted with. No data was submitted.`);
  }

  const allControls = form.locator("input, textarea, select");
  const descriptors = await allControls.evaluateAll(describeControls, NON_FILLABLE_TYPES);

  const fields = [];
  const skippedFields = [];
  const observations = [];
  const interactionErrors = [];

  for (const meta of descriptors) {
    const label = fieldLabel(meta);
    if (!meta.fillableType || meta.disabled) continue;
    if (meta.readOnly) { skippedFields.push({ label, reason: "read-only" }); continue; }
    if (meta.type === "file") {
      skippedFields.push({ label, reason: meta.required ? "required file upload (no file is uploaded by the agent)" : "file upload (not tested)" });
      continue;
    }
    if (!meta.visible && !meta.required && !["checkbox", "radio"].includes(meta.type)) {
      skippedFields.push({ label, reason: `hidden optional field (${meta.hiddenReason}); likely a honeypot, left empty` });
      continue;
    }
    fields.push(meta);
  }

  // Radio buttons are handled per group.
  const radioGroups = new Map();
  for (const meta of fields.filter(field => field.type === "radio")) {
    const key = meta.name || `radio-${meta.index}`;
    if (!radioGroups.has(key)) radioGroups.set(key, []);
    radioGroups.get(key).push(meta);
  }

  const fieldResults = new Map();
  const resultFor = meta => {
    const key = meta.type === "radio" ? `radio:${meta.name || meta.index}` : `field:${meta.index}`;
    if (!fieldResults.has(key)) {
      fieldResults.set(key, {
        label: fieldLabel(meta),
        name: meta.name || meta.id || "",
        type: meta.tag === "select" ? "select" : meta.type,
        required: meta.required || meta.ariaRequired,
        visible: meta.visible,
        emptyRejected: null,
        canBeEmpty: true,
        invalidSample: null,
        invalidRejected: null,
        testValue: null,
        accepted: null,
        attempts: 0,
        interaction: null,
        validationMessage: ""
      });
    }
    return fieldResults.get(key);
  };

  // Phase 1: empty state -> required fields must be rejected.
  for (const meta of fields) {
    const control = allControls.nth(meta.index);
    const record = resultFor(meta);
    try {
      if (meta.type === "checkbox" || meta.type === "radio") await setChecked(control, false);
      else if (meta.tag === "select") {
        const empty = meta.options.find(option => option.value === "" && !option.disabled);
        if (empty) await selectOption(control, meta, empty.index);
        // A select without an empty option always has a value, so "empty" cannot occur.
        else record.canBeEmpty = false;
      } else await setTextValue(control, meta, "");
      await blurField(control);
    } catch (error) {
      interactionErrors.push(`${record.label}: could not clear (${error.message.split("\n")[0]})`);
    }
  }
  await page.waitForTimeout(VALIDATION_SETTLE_MS);
  const submitWhenEmpty = await submitControlState(form);

  for (const meta of fields) {
    const record = resultFor(meta);
    if (!record.required || !record.canBeEmpty) continue;
    const state = await readFieldState(allControls.nth(meta.index)).catch(() => null);
    if (!state) continue;
    // For radio groups, one rejected member is enough.
    record.emptyRejected = record.emptyRejected === true || state.valueMissing || state.ariaInvalid === "true";
    if (state.valueMissing || state.ariaInvalid === "true") record.validationMessage = state.message;
  }

  // Phase 2: invalid formats must be rejected (email, url, declared patterns).
  for (const meta of fields) {
    if (meta.tag === "select" || ["checkbox", "radio", "number", "range", "date", "time", "datetime-local", "month", "week", "color"].includes(meta.type)) continue;
    const sample = invalidSampleFor(meta);
    if (!sample) continue;
    const control = allControls.nth(meta.index);
    const record = resultFor(meta);
    try {
      await setTextValue(control, meta, sample);
      await blurField(control);
      await page.waitForTimeout(VALIDATION_SETTLE_MS);
      const state = await readFieldState(control);
      record.invalidSample = sample;
      record.invalidRejected = rejectedBy(state);
      if (!record.invalidRejected && isEmailLike(meta) && meta.type !== "email") {
        observations.push(`"${record.label}" looks like an email field but has no client-side format validation (type="${meta.type}"); server-side validation was not tested.`);
      }
    } catch (error) {
      interactionErrors.push(`${record.label}: could not enter an invalid sample (${error.message.split("\n")[0]})`);
    }
  }

  // Phase 3: realistic values that satisfy each field's declared constraints.
  for (const meta of fields) {
    const control = allControls.nth(meta.index);
    const record = resultFor(meta);

    try {
      if (meta.type === "checkbox") {
        if (!record.required) { record.accepted = true; record.testValue = "(optional, left unchanged)"; continue; }
        record.interaction = await setChecked(control, true);
        record.testValue = "checked";
        record.attempts = 1;
        continue;
      }

      if (meta.type === "radio") {
        const group = radioGroups.get(meta.name || `radio-${meta.index}`) || [meta];
        if (group[0] !== meta) continue; // handle each group once
        const groupRequired = group.some(item => item.required);
        if (!groupRequired) { record.accepted = true; record.testValue = "(optional, left unchanged)"; continue; }
        const choice = group.find(item => !item.disabled) || group[0];
        record.interaction = await setChecked(allControls.nth(choice.index), true);
        record.testValue = "first option selected";
        record.attempts = 1;
        continue;
      }

      if (meta.tag === "select") {
        const optionIndex = chooseValidOption(meta);
        if (optionIndex === null) {
          record.accepted = !record.required;
          record.testValue = "(no selectable option)";
          continue;
        }
        record.interaction = await selectOption(control, meta, optionIndex);
        record.testValue = meta.options[optionIndex].text || meta.options[optionIndex].value;
        record.attempts = 1;
        continue;
      }

      const candidates = candidateValues(meta);
      if (!candidates.length) {
        record.accepted = false;
        record.validationMessage = "No synthetic value could satisfy the declared constraints (pattern/length).";
        continue;
      }
      for (const value of candidates) {
        record.attempts += 1;
        record.interaction = await setTextValue(control, meta, value);
        await blurField(control);
        await page.waitForTimeout(VALIDATION_SETTLE_MS);
        const state = await readFieldState(control);
        record.testValue = value;
        record.validationMessage = state.message;
        if (!rejectedBy(state)) {
          record.accepted = true;
          break;
        }
        record.accepted = false;
      }
    } catch (error) {
      interactionErrors.push(`${record.label}: ${error.message.split("\n")[0]}`);
      record.accepted = false;
      record.interaction = "failed";
    }
  }

  // Final re-check after all fields are filled (scripts may react to other fields).
  await page.waitForTimeout(150);
  for (const meta of fields) {
    const record = resultFor(meta);
    if (record.interaction === "failed") continue;
    if (meta.type === "radio" && radioGroups.get(meta.name || `radio-${meta.index}`)?.[0] !== meta) continue;
    if (record.testValue && record.testValue.startsWith("(optional")) continue;
    const state = await readFieldState(allControls.nth(meta.index)).catch(() => null);
    if (!state) continue;
    record.accepted = !rejectedBy(state);
    record.validationMessage = record.accepted ? "" : (state.message || (state.ariaInvalid === "true" ? "Marked aria-invalid by the page" : record.validationMessage));
  }

  const submitWhenValid = await submitControlState(form);
  const records = [...fieldResults.values()];
  const required = records.filter(record => record.required);
  const emptiableRequired = required.filter(record => record.canBeEmpty);
  const rejectedValid = records.filter(record => record.accepted === false && record.interaction !== "failed");
  const requiredNotRejected = required.filter(record => record.emptyRejected === false);
  const formatChecked = records.filter(record => record.invalidSample !== null);

  if (submitWhenEmpty?.disabled && submitWhenValid && !submitWhenValid.disabled) {
    observations.push("Submit control is disabled while the form is empty and enabled once valid values are entered.");
  }
  for (const record of requiredNotRejected) {
    observations.push(`Required field "${record.label}" was not flagged when empty (it may be validated only on submit).`);
  }
  for (const skipped of skippedFields) {
    observations.push(`"${skipped.label}" not tested: ${skipped.reason}.`);
  }

  const blockedSubmits = await blockedSubmitCount(page);

  result.validation = {
    formLocatedBy: located.strategy,
    controlCount: descriptors.length,
    testedFieldCount: records.length,
    requiredCount: required.length,
    emptiableRequiredCount: emptiableRequired.length,
    emptyRequiredRejected: emptiableRequired.filter(record => record.emptyRejected).length,
    formatChecks: formatChecked.length,
    formatChecksRejected: formatChecked.filter(record => record.invalidRejected).length,
    validInputAccepted: records.length > 0 && rejectedValid.length === 0 && interactionErrors.length === 0,
    submitControl: submitWhenValid,
    submitControlWhenEmpty: submitWhenEmpty,
    submitAttemptsBlocked: blockedSubmits,
    navigationsBlocked: guard ? guard.blockedNavigations.length : 0,
    formSubmitted: false,
    fields: records.map(record => ({
      ...record,
      validationMessage: record.validationMessage || ""
    })),
    skippedFields,
    observations,
    interactionErrors,
    nativeConstraintOnly: false
  };
  result.afterUrl = page.url();

  const scope = "The form was not submitted; backend processing and server-side validation were not tested.";
  const summaryLine = `Fields tested: ${records.length}; required fields rejected when empty: ${result.validation.emptyRequiredRejected}/${emptiableRequired.length}; invalid formats rejected: ${result.validation.formatChecksRejected}/${formatChecked.length}`;

  if (interactionErrors.length) {
    return setOutcome(result, OUTCOMES.AUTOMATION_ERROR, "AUTOMATION_ERROR",
      `The agent could not interact with ${interactionErrors.length} field(s): ${interactionErrors.join(" | ")}. ${scope}`);
  }

  if (records.length === 0) {
    if (submitWhenValid && submitWhenValid.visible && !submitWhenValid.disabled) {
      return setOutcome(result, OUTCOMES.PASS, "READY_NOT_SUBMITTED",
        `Form has no user-fillable fields. Its submit control "${submitWhenValid.text}" is visible and enabled; it was intentionally not clicked. ${scope}`);
    }
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
      `Form has no user-fillable fields and no usable submit control, so there was nothing to validate. ${scope}`);
  }

  if (rejectedValid.length) {
    const list = rejectedValid.map(record => `"${record.label}" (last value tried: ${JSON.stringify(record.testValue)}${record.validationMessage ? `; page said: ${record.validationMessage}` : ""})`).join("; ");
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
      `${rejectedValid.length} field(s) rejected every generated test value, so valid-input acceptance could not be confirmed: ${list}. This may be a stricter custom rule rather than a defect. ${summaryLine}. ${scope}`);
  }

  if (submitWhenValid && submitWhenValid.disabled) {
    return setOutcome(result, OUTCOMES.NOT_VERIFIED, "NOT_VERIFIED",
      `All fields accepted valid values, but the submit control "${submitWhenValid.text}" stayed disabled (custom rules, CAPTCHA or an unfilled file upload may be required). ${summaryLine}. ${scope}`);
  }

  const notes = observations.length ? ` Notes: ${observations.join(" ")}` : "";
  return setOutcome(result, OUTCOMES.PASS, "VALIDATION_PASS",
    `Client-side validation verified without submitting. ${summaryLine}; all ${records.length} tested field(s) accepted realistic values${submitWhenValid ? `; submit control "${submitWhenValid.text}" is ${submitWhenValid.visible ? "visible" : "present"} and enabled (not clicked)` : ""}. ${scope}${notes}`);
}

module.exports = { runFormValidation };
