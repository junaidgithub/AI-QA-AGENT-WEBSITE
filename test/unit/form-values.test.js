const test = require("node:test");
const assert = require("node:assert/strict");
const {
  candidateValues,
  fieldSemantics,
  matchesConstraints,
  invalidSampleFor,
  exampleFromPattern,
  compilePattern
} = require("../../agent/form-values");

function firstValid(meta) {
  const values = candidateValues(meta);
  assert.ok(values.length > 0, `expected candidates for ${JSON.stringify(meta)}`);
  return values[0];
}

test("regression: phone with a digits-only pattern gets a matching value", () => {
  // The old generator always typed "+923001234567", which this pattern rejects.
  const meta = { type: "tel", name: "phone", pattern: "[0-9]{10}" };
  const value = firstValid(meta);
  assert.match(value, /^[0-9]{10}$/);
});

test("regression: date respects min and max", () => {
  assert.ok(firstValid({ type: "date", name: "visit", min: "2030-01-01" }) >= "2030-01-01");
  const dob = firstValid({ type: "date", name: "date_of_birth", max: "2008-01-01" });
  assert.ok(dob <= "2008-01-01");
});

test("number values respect min, max and step", () => {
  assert.equal(firstValid({ type: "number", name: "guests", min: "2", max: "10", step: "2" }), "2");
  assert.equal(firstValid({ type: "number", name: "n", min: "5", max: "100", step: "5" }), "5");
  assert.equal(firstValid({ type: "number", name: "ratio", max: "0.5", step: "0.25" }), "0.5");
  const stepped = Number(firstValid({ type: "number", name: "n", min: "1", step: "3" }));
  assert.equal((stepped - 1) % 3, 0);
});

test("length constraints are honoured", () => {
  const message = firstValid({ tag: "textarea", type: "textarea", name: "message", minLength: 60, maxLength: -1 });
  assert.ok(message.length >= 60);
  const email = firstValid({ type: "email", name: "email", maxLength: 12 });
  assert.ok(email.length <= 12);
  assert.match(email, /@/);
});

test("arbitrary declared patterns can be satisfied", () => {
  for (const pattern of [String.raw`\d{5}-\d{7}-\d`, String.raw`[A-Z]{2}\d{4}`, "(INV|PO)-[0-9]{3,6}", "[A-Za-z ]{2,40}"]) {
    const value = firstValid({ type: "text", name: "code", pattern });
    assert.ok(compilePattern(pattern).test(value), `${value} should match ${pattern}`);
  }
});

test("password-strength pattern with lookaheads is satisfied by the password pool", () => {
  const pattern = String.raw`(?=.*\d)(?=.*[A-Z]).{8,}`;
  const value = firstValid({ type: "password", name: "password", pattern });
  assert.ok(compilePattern(pattern).test(value));
});

test("exampleFromPattern declines unsupported constructs instead of guessing", () => {
  assert.equal(exampleFromPattern("(a)\\1"), null);
  assert.equal(exampleFromPattern("(?=x)a"), null);
  assert.equal(exampleFromPattern("[0-9]{3}"), "000");
});

test("candidates never violate constraints", () => {
  const metas = [
    { type: "text", name: "zip", pattern: "[0-9]{5}" },
    { type: "text", name: "first_name", minLength: 3, maxLength: 5 },
    { type: "url", name: "website" },
    { type: "email", name: "contact" }
  ];
  for (const meta of metas) {
    for (const value of candidateValues(meta)) assert.ok(matchesConstraints(value, meta), `${value} vs ${JSON.stringify(meta)}`);
  }
});

test("semantics come from label, name, autocomplete and type", () => {
  assert.equal(fieldSemantics({ type: "text", label: "Email address" }), "email");
  assert.equal(fieldSemantics({ type: "text", autocomplete: "tel" }), "tel");
  assert.equal(fieldSemantics({ type: "text", name: "fullname" }), "full-name");
  assert.equal(fieldSemantics({ tag: "textarea", type: "textarea", name: "x" }), "message");
  assert.equal(fieldSemantics({ type: "checkbox", name: "terms" }), "checkbox");
});

test("invalid samples exist for formats that can be validated", () => {
  assert.equal(invalidSampleFor({ type: "email" }), "not-an-email");
  assert.equal(invalidSampleFor({ type: "text", label: "Work email" }), "not-an-email");
  assert.ok(!compilePattern("[0-9]{10}").test(invalidSampleFor({ type: "tel", pattern: "[0-9]{10}" })));
  assert.equal(invalidSampleFor({ type: "text", name: "city" }), null);
});

test("checkbox, radio, select and file controls get no text candidates", () => {
  for (const meta of [{ type: "checkbox" }, { type: "radio" }, { type: "file" }, { tag: "select", type: "select-one" }]) {
    assert.deepEqual(candidateValues(meta), []);
  }
});
