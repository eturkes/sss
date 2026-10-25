import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeEvent, MonitorStatus } from "../src/core/types.ts";
import { formatDigestEmail, formatEmail, type EmailDigest } from "../src/notifications/email.ts";

const at = "2026-10-25T00:00:00.000Z";
const config = { type: "email" as const, to: "reader@example.com" };

function event(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    id: "event-internal", monitorId: "fv-news", runId: "run-internal", namespace: "namespace-internal", ruleId: "new",
    kind: "new_item", itemId: "item-internal", title: "Proof news", url: "https://example.com/news",
    reason: "newly observed by SSS", before: undefined, after: {}, observedAt: at, ...overrides,
  };
}

function monitor(overrides: Partial<MonitorStatus> = {}): MonitorStatus {
  return {
    id: "fv-news", name: "Verification news", enabled: true, namespace: "namespace-internal", nextDueAt: at,
    lastAttemptAt: at, lastSuccessAt: at, errorStreak: 0, healthAlerted: false, lastError: null, leaseUntil: null,
    ...overrides,
  };
}

function digest(events: ChangeEvent[], monitors = [monitor()]): EmailDigest {
  return {
    id: "digest-internal", scheduledFor: at, events, monitors,
    config: { ...config, digest: { id: "formal-verification", schedule: { cron: "0 9 * * *", timezone: "Asia/Tokyo" } } },
  };
}

function body(wire: string): string {
  const boundary = wire.indexOf("\r\n\r\n");
  assert.ok(boundary > 0, "RFC headers/body separator");
  assert.match(wire.slice(0, boundary), /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.match(wire.slice(0, boundary), /^Content-Transfer-Encoding: base64$/m);
  assert.equal(/(?<!\r)\n/.test(wire), false, "wire line endings are CRLF");
  const encoded = wire.slice(boundary + 4);
  assert.ok(encoded.split("\r\n").every(line => line.length <= 76), "base64 lines fit MIME bounds");
  return Buffer.from(encoded, "base64").toString("utf8").replaceAll("\r\n", "\n");
}

test("digest converts feed HTML and JATS into complete readable paragraphs, lists and source links", () => {
  const longText = `${"A complete proof argument. ".repeat(800)}Final substantive conclusion.`;
  const source = event({ after: {
    title: "Proof news", url: "https://example.com/news", publishedAt: "2026-10-24T03:00:00.000Z",
    authors: ["Ada Example", "Grace Example"],
    summary: `<p>Proof &amp; practice.</p><p>${longText}</p><ul><li>First result</li><li>Second result</li></ul><p>Read the <a href="https://example.com/paper#proof">full paper</a>.</p>`,
    content: "<jats:abstract><jats:p>Distinct abstract with λ-calculus.</jats:p><jats:p>Another paragraph.</jats:p></jats:abstract>",
  } });
  const text = body(formatDigestEmail(digest([source])));
  for (const expected of ["Proof & practice.", longText, "First result", "Second result", "full paper", "https://example.com/paper#proof", "Distinct abstract with λ-calculus.", "Another paragraph.", "Ada Example", "Grace Example"]) {
    assert.ok(text.includes(expected), `complete reader content: ${expected.slice(0, 80)}`);
  }
  assert.doesNotMatch(text, /<\/?(?:p|ul|li|a|jats:abstract|jats:p)\b|&amp;|"summary"\s*:|authors\[1\]|Complete observation and assessment/);
  assert.equal(text.split(longText).length - 1, 1, "content is not repeated as a JSON dump");
});

test("digest removes active source markup and keeps safe text, links and code inert", () => {
  const text = body(formatDigestEmail(digest([event({ after: {
    summary: '<p>Visible result <a href="javascript:alert(1)">unsafe link label</a>.</p><script>script-leak-marker()</script><style>.style-leak-marker{display:none}</style><template>template-leak-marker</template><p><a href="/details#proof">details</a></p><pre>lemma step:\n  x &lt; 3 &amp;&amp; y &gt; 1</pre>',
  } })])));
  for (const expected of ["Visible result", "unsafe link label", "details", "https://example.com/details#proof", "lemma step:\n  x < 3 && y > 1"]) assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /<\/?(?:script|style|template|p|pre|a)\b|javascript:|script-leak-marker|style-leak-marker|template-leak-marker/);
});

test("digest keeps mathematical prose and every ordered observation without an editorial cap", () => {
  const items = Array.from({ length: 151 }, (_, index) => event({
    id: `event-${index}`, itemId: `item-${index}`, title: `Observation number ${index}`,
    after: { abstract: `Article ${index}: x < 3 && y > 1; List<T> and λ → ∀. Unique ending ${index}.` },
  }));
  const original = structuredClone(items);
  const batch = digest(items);
  const wire = formatDigestEmail(batch);
  const text = body(wire);
  let position = -1;
  for (const item of items) {
    const next = text.indexOf(item.title!);
    assert.ok(next > position, "observation ordering stays frozen");
    position = next;
    assert.ok(text.includes(String((item.after as { abstract: string }).abstract)), "mathematical content stays complete");
  }
  assert.equal(formatDigestEmail(batch), wire, "retry rendering is deterministic");
  assert.deepEqual(items, original, "presentation does not change stored observations");
  assert.doesNotMatch(text, /"abstract"\s*:|Complete observation and assessment/);
});

test("reset alerts show assessment, quoted evidence and full post context without object notation", () => {
  const postText = "Fresh tank tomorrow? 🥳\nKeep x < 3 and List<T> in the proof.";
  const reset = event({ monitorId: "codex-reset", kind: "llm_assessment", title: "A possible usage reset", url: "https://x.com/thsottiaux/status/123", after: {
    post: { id: "123", title: "A possible usage reset", url: "https://x.com/thsottiaux/status/123", publishedAt: "2026-10-24T23:00:00.000Z", data: {
      author: "thsottiaux", postId: "123", text: postText, context: "Parent: your allowance is nearly empty.", quotedText: "Quoted post: more tokens soon.",
    } },
    assessment: { suggestive: true, reason: "The joke may suggest a replenished allowance.", evidence: ["Fresh tank tomorrow?"], model: "gpt-6.1-sol", reasoningEffort: "xhigh" },
  } });
  const original = structuredClone(reset);
  const wire = formatEmail(reset, config);
  const text = body(wire);
  for (const expected of [postText, "The joke may suggest a replenished allowance.", "Fresh tank tomorrow?", "Parent: your allowance is nearly empty.", "Quoted post: more tokens soon.", "https://x.com/thsottiaux/status/123", "gpt-6.1-sol", "xhigh"]) assert.ok(text.includes(expected), expected);
  assert.match(text, /evidence/i);
  assert.doesNotMatch(text, /"(?:post|data|assessment|suggestive|reasoningEffort)"\s*:|post\.data\.|assessment\.evidence\[|Event: event-internal/);
  assert.equal(formatEmail(reset, config), wire);
  assert.deepEqual(reset, original);
});

test("digest keeps source failure summaries readable without traceback and HTML dumps", () => {
  const error = "HTTP 502: upstream unavailable\n    at fetchSource (/private/scanner/source.ts:42:7)\n<html><body>proxy-log-marker</body></html>";
  const source = monitor({ errorStreak: 2, healthAlerted: true, lastError: error });
  const batch = digest([], [source]);
  const original = structuredClone(batch);
  const text = body(formatDigestEmail(batch));
  assert.match(text, /No new observations/);
  assert.match(text, /Source health/);
  assert.match(text, /Verification news/);
  assert.match(text, /(?:degraded|unavailable|failed)/i);
  assert.match(text, /HTTP 502|upstream unavailable/);
  assert.doesNotMatch(text, /fetchSource|\/private\/scanner|proxy-log-marker|<html>|<body>/);
  assert.deepEqual(batch, original, "full diagnostic snapshot remains unchanged");
});

test("digest extracts a short message from structured and inline HTML diagnostics", () => {
  for (const lastError of [
    'Error: {"message":"upstream unavailable","stack":"trace-marker","debug":{"headers":"debug-marker"}}',
    'HTTP 502: upstream unavailable <html><body>proxy-log-marker</body></html>',
  ]) {
    const text = body(formatDigestEmail(digest([], [monitor({ errorStreak: 2, lastError })])));
    assert.match(text, /upstream unavailable/);
    assert.doesNotMatch(text, /trace-marker|debug-marker|proxy-log-marker|"message"|"stack"|<html>/);
  }
});
