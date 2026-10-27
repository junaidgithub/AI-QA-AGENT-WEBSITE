/**
 * Synthetic test-value generation for form validation checks.
 *
 * Values are generic placeholders (example.com addresses, 555 phone numbers)
 * and are chosen to satisfy each field's own declared constraints: pattern,
 * minlength/maxlength, min/max/step and date ranges. The previous fixed
 * values ("+923001234567", "2026-10-09"...) violated such constraints and made
 * valid input look rejected.
 *
 * Every candidate is re-checked in the browser; this module only proposes
 * values in a sensible order.
 */

const currentDate = () => new Date();

function cleanLower(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function fieldText(meta) {
  return cleanLower([meta.label, meta.name, meta.id, meta.placeholder, meta.ariaLabel, meta.autocomplete].filter(Boolean).join(" "));
}

const SEMANTIC_RULES = [
  ["email", text => /e-?mail/.test(text)],
  ["otp", text => /\botp\b|one.?time|verification.?code|security.?code/.test(text)],
  ["tel", text => /phone|mobile|\btel\b|telephone|whatsapp|cell|contact.?(no|number)/.test(text)],
  ["url", text => /\burl\b|website|web.?site|homepage|portfolio/.test(text)],
  ["zip", text => /\bzip|postal|post.?code|postcode|pin.?code/.test(text)],
  ["dob", text => /birth|\bdob\b|bday/.test(text)],
  ["age", text => /\bage\b/.test(text)],
  ["quantity", text => /\bqty\b|quantity|guests|people|attendees|seats/.test(text)],
  ["amount", text => /amount|price|budget|salary|income/.test(text)],
  ["company", text => /company|organi[sz]ation|business|employer/.test(text)],
  ["first-name", text => /first.?name|\bfname\b|given.?name/.test(text)],
  ["last-name", text => /last.?name|\blname\b|surname|family.?name/.test(text)],
  ["full-name", text => /name/.test(text)],
  ["city", text => /\bcity\b|\btown\b/.test(text)],
  ["country", text => /country/.test(text)],
  ["address", text => /address|street/.test(text)],
  ["search", text => /search|query/.test(text)],
  ["subject", text => /subject|title|topic/.test(text)],
  ["message", text => /message|comment|description|details|enquiry|inquiry|question|feedback|note/.test(text)]
];

/** Best-guess meaning of a field, used to choose realistic values. */
function fieldSemantics(meta = {}) {
  const type = cleanLower(meta.type || "text");
  if (type === "email") return "email";
  if (type === "tel") return "tel";
  if (type === "url") return "url";
  if (type === "password") return "password";
  if (type === "search") return "search";
  if (["number", "range", "date", "time", "datetime-local", "month", "week", "color", "checkbox", "radio", "file"].includes(type)) return type;
  if (meta.tag === "select") return "select";

  const autocomplete = cleanLower(meta.autocomplete);
  if (autocomplete.includes("email")) return "email";
  if (autocomplete.includes("tel")) return "tel";
  if (autocomplete === "url") return "url";
  if (autocomplete.includes("postal-code")) return "zip";
  if (autocomplete.includes("given-name")) return "first-name";
  if (autocomplete.includes("family-name")) return "last-name";
  if (autocomplete === "name") return "full-name";
  if (autocomplete.includes("organization")) return "company";
  if (autocomplete.includes("bday")) return "dob";

  const text = fieldText(meta);
  for (const [semantic, test] of SEMANTIC_RULES) {
    if (test(text)) return semantic;
  }
  if (meta.tag === "textarea") return "message";
  return "text";
}

function isEmailLike(meta) {
  return fieldSemantics(meta) === "email";
}

const TEXT_POOLS = {
  email: ["qa.agent@example.com", "qa@example.com", "a@b.co"],
  tel: ["+15555550123", "5555550123", "+923001234567", "03001234567", "555-555-0123", "(555) 555-0123", "+44 20 7946 0958"],
  url: ["https://example.com", "https://www.example.com", "http://example.com"],
  password: ["QaTest#2026pass", "QaTest2026!", "qatest2026"],
  otp: ["123456", "1234"],
  zip: ["10001", "12345", "54000", "SW1A 1AA"],
  age: ["30"],
  quantity: ["2", "1"],
  amount: ["100", "1000"],
  company: ["Example Ltd", "Example"],
  "first-name": ["Alex", "QA"],
  "last-name": ["Tester", "Test"],
  "full-name": ["QA Test User", "Alex Tester", "QA"],
  city: ["Springfield", "London"],
  country: ["United States", "Pakistan"],
  address: ["123 Test Street", "123 Test Street, Springfield"],
  search: ["test", "QA test"],
  subject: ["QA validation test", "Test"],
  message: ["Automated QA validation test message. Please ignore."],
  text: ["QA Test", "QATest", "Test"]
};

// Broad generic pool tried for any text field with a pattern, so that unusual
// formats (digit-only codes, uppercase IDs, dates in text fields) can still be met.
function genericPatternPool() {
  const digits = [];
  for (let length = 1; length <= 16; length += 1) {
    digits.push("1234567890123456".slice(0, length));
  }
  return [
    "QA Test", "QATest", "qatest", "QATEST", "Test", "test", "Qa",
    ...digits,
    "A1B2C3", "AB123", "ABC123", "ABCDE1234F", "AB-1234", "A1",
    "2026-01-15", "15/01/2026", "01/15/2026", "15-01-2026", "12:00",
    "qa.agent@example.com", "https://example.com", "+15555550123", "555-555-0123"
  ];
}

function compilePattern(pattern) {
  if (!pattern) return null;
  for (const flags of ["v", "u", ""]) {
    try {
      return new RegExp(`^(?:${pattern})$`, flags);
    } catch {}
  }
  return null; // Browsers ignore an invalid pattern, so do we.
}

/**
 * Build one string that matches a simple regular expression: literals,
 * character classes, \d \w \s, ".", groups, alternation and quantifiers.
 * Returns null for constructs it does not understand (lookarounds,
 * back-references); the result is always re-validated by the caller.
 */
function exampleFromPattern(pattern) {
  if (!pattern) return null;
  let pos = 0;

  const escapeChar = char => ({ d: "1", D: "a", w: "a", W: "-", s: " ", S: "a", n: "\n", t: "\t" })[char];

  function parseClass() {
    pos += 1; // [
    let negated = false;
    if (pattern[pos] === "^") { negated = true; pos += 1; }
    const members = [];
    let first = true;
    while (pos < pattern.length && (pattern[pos] !== "]" || first)) {
      first = false;
      let char = pattern[pos];
      if (char === "\\") {
        const next = pattern[pos + 1];
        pos += 2;
        if (next === "p" && pattern[pos] === "{") {
          const end = pattern.indexOf("}", pos);
          const name = pattern.slice(pos + 1, end);
          pos = end + 1;
          members.push(/^N/.test(name) ? "1" : "a");
          continue;
        }
        members.push(escapeChar(next) ?? next);
        continue;
      }
      pos += 1;
      if (pattern[pos] === "-" && pattern[pos + 1] && pattern[pos + 1] !== "]") {
        pos += 2; // range: the start character is a valid member
      }
      members.push(char);
    }
    if (pattern[pos] !== "]") throw new Error("unterminated class");
    pos += 1;
    if (!negated) return members[0] ?? null;
    return ["a", "A", "1", "_", "-", " "].find(char => !members.includes(char)) ?? null;
  }

  function parseAtom() {
    const char = pattern[pos];
    if (char === "(") {
      pos += 1;
      if (pattern[pos] === "?") {
        if (pattern[pos + 1] === ":") pos += 2;
        else if (pattern[pos + 1] === "<" && /[A-Za-z]/.test(pattern[pos + 2] || "")) pos = pattern.indexOf(">", pos) + 1;
        else throw new Error("unsupported group");
      }
      const inner = parseAlternation();
      if (pattern[pos] !== ")") throw new Error("unterminated group");
      pos += 1;
      return inner;
    }
    if (char === "[") return parseClass();
    if (char === "\\") {
      const next = pattern[pos + 1];
      pos += 2;
      if (/[1-9]/.test(next)) throw new Error("back-reference");
      if (next === "b" || next === "B") return "";
      if (next === "p" && pattern[pos] === "{") {
        const end = pattern.indexOf("}", pos);
        const name = pattern.slice(pos + 1, end);
        pos = end + 1;
        return /^N/.test(name) ? "1" : "a";
      }
      return escapeChar(next) ?? next;
    }
    pos += 1;
    if (char === ".") return "a";
    if (char === "^" || char === "$") return "";
    return char;
  }

  function parseQuantifier() {
    const char = pattern[pos];
    let count = 1;
    if (char === "*" || char === "?") { pos += 1; count = 0; }
    else if (char === "+") { pos += 1; count = 1; }
    else if (char === "{") {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(pos));
      if (!match) return 1;
      pos += match[0].length;
      count = Number(match[1]);
    } else {
      return 1;
    }
    if (pattern[pos] === "?") pos += 1; // lazy modifier
    return count;
  }

  function parseSequence() {
    let output = "";
    while (pos < pattern.length && pattern[pos] !== "|" && pattern[pos] !== ")") {
      const atom = parseAtom();
      if (atom === null) throw new Error("unsatisfiable atom");
      output += atom.repeat(parseQuantifier());
    }
    return output;
  }

  function parseAlternation() {
    const first = parseSequence();
    while (pattern[pos] === "|") {
      pos += 1;
      parseSequence(); // the first alternative is enough
    }
    return first;
  }

  try {
    const result = parseAlternation();
    return pos === pattern.length ? result : null;
  } catch {
    return null;
  }
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function lengthOk(value, meta) {
  const length = String(value).length;
  if (toNumber(meta.minLength) > 0 && length < Number(meta.minLength)) return false;
  if (toNumber(meta.maxLength) >= 0 && meta.maxLength !== -1 && length > Number(meta.maxLength)) return false;
  return true;
}

/** Node-side approximation of the browser's constraint checks for text values. */
function matchesConstraints(value, meta = {}) {
  if (!lengthOk(value, meta)) return false;
  const regex = compilePattern(meta.pattern);
  if (regex && !regex.test(String(value))) return false;
  return true;
}

function padToMinLength(value, meta, semantic) {
  const min = toNumber(meta.minLength);
  if (!min || value.length >= min) return value;
  const filler = semantic === "message" || semantic === "subject" ? " QA validation test" : "x";
  let padded = value;
  while (padded.length < min) padded += filler;
  const max = toNumber(meta.maxLength);
  return max > 0 ? padded.slice(0, Math.max(min, Math.min(max, padded.length))) : padded;
}

function numericCandidate(meta, preferred) {
  const min = toNumber(meta.min);
  const max = toNumber(meta.max);
  const stepRaw = cleanLower(meta.step);
  const step = stepRaw === "any" ? null : (toNumber(meta.step) > 0 ? toNumber(meta.step) : 1);

  let value = preferred;
  if (min !== null && value < min) value = min;
  if (max !== null && value > max) value = max;

  if (step) {
    const base = min !== null ? min : 0;
    value = base + Math.ceil((value - base) / step - 1e-9) * step;
    if (max !== null && value > max) value = base + Math.floor((max - base) / step + 1e-9) * step;
  }
  return String(Number(value.toFixed(10)));
}

function pad2(number) {
  return String(number).padStart(2, "0");
}

function isoDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function isoWeek(date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${pad2(week)}`;
}

// ISO-formatted date/time strings compare correctly as plain strings.
function clampIso(value, meta) {
  if (meta.min && value < meta.min) return meta.min;
  if (meta.max && value > meta.max) return meta.max;
  return value;
}

function temporalCandidate(type, semantic, now = currentDate()) {
  const base = semantic === "dob" ? new Date(1990, 0, 15) : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30);
  if (type === "date") return isoDate(base);
  if (type === "month") return isoDate(base).slice(0, 7);
  if (type === "week") return isoWeek(base);
  if (type === "time") return "12:00";
  if (type === "datetime-local") return `${isoDate(base)}T12:00`;
  return null;
}

function unique(values) {
  return [...new Set(values.filter(value => value !== null && value !== undefined))];
}

/**
 * Ordered list of synthetic values to try for a text-like or numeric/date
 * control. Returns [] for checkbox/radio/select/file, which are handled by
 * dedicated interactions.
 */
function candidateValues(meta = {}, options = {}) {
  const type = cleanLower(meta.type || "text");
  const semantic = fieldSemantics(meta);

  if (["checkbox", "radio", "file", "select"].includes(semantic) || meta.tag === "select") return [];

  if (type === "number" || type === "range") {
    const preferred = { age: 30, quantity: 2, amount: 100 }[fieldSemanticsFromText(meta)] ?? 1;
    return unique([numericCandidate(meta, preferred), numericCandidate(meta, 1), numericCandidate(meta, toNumber(meta.min) ?? 0)]);
  }

  if (["date", "month", "week", "time", "datetime-local"].includes(type)) {
    const textSemantic = fieldSemanticsFromText(meta);
    const value = temporalCandidate(type, textSemantic, options.now);
    return unique([clampIso(value, meta), meta.min || null, meta.max || null]);
  }

  if (type === "color") return ["#336699"];

  const pool = TEXT_POOLS[semantic] || TEXT_POOLS.text;
  const fromPattern = meta.pattern ? exampleFromPattern(meta.pattern) : null;
  // Strictly typed fields (email/url/tel) only get generic values when a pattern demands them.
  const generic = meta.pattern ? genericPatternPool() : (["email", "url", "tel"].includes(type) ? [] : TEXT_POOLS.text);
  const ordered = unique([...pool, fromPattern, ...generic]);
  const expanded = [];
  for (const value of ordered) {
    expanded.push(value);
    const padded = padToMinLength(value, meta, semantic);
    if (padded !== value) expanded.push(padded);
  }

  // Digit-only codes of an exact required length (e.g. pattern="\d{11}") when the pool lacks one.
  const min = toNumber(meta.minLength);
  if (min > 0) expanded.push("1".repeat(min));

  return unique(expanded).filter(value => matchesConstraints(value, meta)).slice(0, 12);
}

// Semantics from the field's wording only, ignoring its input type.
function fieldSemanticsFromText(meta) {
  return fieldSemantics({ ...meta, type: "text", tag: "input" });
}

/** A value that the field should reject if format validation exists, or null. */
function invalidSampleFor(meta = {}) {
  const type = cleanLower(meta.type || "text");
  if (type === "email" || (type === "text" && isEmailLike(meta))) return "not-an-email";
  if (type === "url") return "not a url";
  const regex = compilePattern(meta.pattern);
  if (regex) {
    return ["@@@", "!", "x y z ~", "0"].find(sample => !regex.test(sample)) ?? null;
  }
  return null;
}

module.exports = {
  fieldSemantics,
  isEmailLike,
  candidateValues,
  matchesConstraints,
  invalidSampleFor,
  compilePattern,
  exampleFromPattern
};
