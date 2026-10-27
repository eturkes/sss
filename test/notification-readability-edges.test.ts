import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeEvent } from "../src/core/types.ts";
import { eventContent, readableText } from "../src/notifications/readable.ts";

function event(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    id: "event", monitorId: "source", runId: "run", namespace: "namespace", ruleId: "change", kind: "field_changed",
    itemId: "item", title: "Changed record", reason: "Record changed", before: undefined, after: {},
    observedAt: "2026-10-25T00:00:00.000Z", ...overrides,
  };
}

test("reader text preserves explicit superscript, subscript and fraction semantics", () => {
  const powers = readableText("<p>Bound: x<sup>2</sup> + y<sub>0</sub>.</p>");
  assert.match(powers, /x(?:\s*(?:\^|\*\*)\s*[({]?2[)}]?|²)/, "superscript remains exponentiation");
  assert.match(powers, /y(?:\s*_\s*[({]?0[)}]?|₀)/, "subscript remains a subscript");
  const fraction = readableText("<math><mfrac><mi>a</mi><mi>b</mi></mfrac></math>");
  assert.match(fraction, /a\s*[)}]?\s*(?:\/|÷)\s*[({]?\s*b/, "fraction retains its division operator");
});

test("reader text preserves plain generic notation in content and model evidence", () => {
  const statement = "Parametric List<i> preserves values.";
  assert.equal(readableText(statement), statement);
  const rendered = eventContent(event({ kind: "llm_assessment", after: {
    post: { data: { text: statement } },
    assessment: { suggestive: true, reason: "Potential reset", evidence: [statement], model: "gpt-6.1-terra", reasoningEffort: "medium" },
  } })).join("\n");
  assert.equal(rendered.split(statement).length - 1, 2, "post and quoted evidence preserve the same wording");
});

test("reader text preserves preformatted leading indentation and blank lines", () => {
  const code = "  first\n    second\n\n\n  third";
  assert.ok(readableText(`<p>Code:</p><pre>${code}</pre>`).includes(code), "preformatted code retains meaningful whitespace");
});

test("reader text removes controls after entity decoding and from generic field labels", () => {
  const decoded = readableText("<p>safe&#x202e;reversed&#x1b;unsafe</p>");
  assert.ok(decoded.includes("safe") && decoded.includes("reversed") && decoded.includes("unsafe"));
  assert.equal(/[\u001b\u202e]/u.test(decoded), false, "decoded controls do not cross the display boundary");
  const rendered = eventContent(event({ after: { ["value\u202e\u001b"]: "payload" } })).join("\n");
  assert.ok(rendered.includes("Value") && rendered.includes("payload"));
  assert.equal(/[\u001b\u202e]/u.test(rendered), false, "source-controlled keys cannot introduce display controls");
});

test("generic observations retain structured content fields instead of silently consuming them", () => {
  const rendered = eventContent(event({ after: {
    content: ["First paragraph", "Second paragraph"], summary: { text: "Summary conclusion" },
    links: { documentation: "https://example.com/documentation" },
  } })).join("\n");
  for (const expected of ["First paragraph", "Second paragraph", "Summary conclusion", "https://example.com/documentation"]) assert.ok(rendered.includes(expected), expected);
});

test("new-item presentation retains structured content and nonstandard metadata", () => {
  const rendered = eventContent(event({ kind: "new_item", after: {
    content: ["First paragraph", "Second paragraph"], summary: { text: "Summary conclusion" },
    links: { documentation: "https://example.com/documentation" }, media: { caption: "Media description" },
    context: { details: "Context details" }, publishedAt: { year: 2026 },
  } })).join("\n");
  for (const expected of ["First paragraph", "Second paragraph", "Summary conclusion", "https://example.com/documentation", "Media description", "Context details", "2026"]) assert.ok(rendered.includes(expected), expected);
});

test("generic before and after records retain nested identities and domain assessments", () => {
  const rendered = eventContent(event({
    before: { record: { id: "old-id", title: "Old title", url: "https://old.example/" }, assessment: { status: "pending", score: 0 } },
    after: { record: { id: "new-id", title: "New title", url: "https://new.example/" }, assessment: { status: "accepted", score: 99 } },
  })).join("\n");
  for (const expected of ["Before", "After", "old-id", "Old title", "https://old.example/", "new-id", "New title", "https://new.example/", "pending", "accepted", "99"]) assert.ok(rendered.includes(expected), expected);
  assert.doesNotMatch(rendered, /model interpretation|Assessed by/);
});

test("reader text decodes entities without tags and removes namespaced article labels", () => {
  assert.equal(readableText("Proof &amp; verification"), "Proof & verification");
  const rendered = readableText("<jats:p><jats:label>Theorem 1.</jats:label> Statement.</jats:p>");
  assert.ok(rendered.includes("Theorem 1.") && rendered.includes("Statement."));
  assert.doesNotMatch(rendered, /<\/?jats:/);
});
