import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeEvent, JsonObject } from "../src/core/types.ts";
import { eventContent } from "../src/notifications/readable.ts";

function event(data: JsonObject): ChangeEvent {
  return { id: "event", monitorId: "discussion", runId: "run", namespace: "namespace", ruleId: "relevant", kind: "llm_assessment", itemId: "thread", title: "An unrelated original topic", url: "https://example.org/thread", reason: "Substantial formal-verification discussion", before: undefined, after: {
    post: { data }, assessment: { reason: "Substantial formal-verification discussion", evidence: ["A concrete correctness argument"], model: "gpt-6.1-terra", reasoningEffort: "medium" },
  }, observedAt: "2026-11-16T12:00:00Z" };
}

test("discussion email renders complete HTML comment bodies once without internal identifiers", () => {
  const ending = "The complete final proof obligation.";
  const long = `${"Substantive proof reasoning. ".repeat(1000)}${ending}`;
  const data: JsonObject = { threadId: 777001, author: "Thread author", text: 'Original context &amp; question.<p>Second root paragraph.', commentCount: 2, coverage: "Public comment window only.", comments: [
    { id: 888001, author: "Ada", publishedAt: "2026-11-16T10:00:00Z", url: "https://example.org/comment/a", text: `<p>${long}</p><p>Read the <a href="/proof#α">proof</a>.</p>`, parent: 777001, dead: false, deleted: false },
    { id: 888002, author: "Grace", publishedAt: "2026-11-16T11:00:00Z", url: "https://example.org/comment/b", body: '<p>A distinct reply.</p><script>active-marker()</script>', parent: 888001, dead: false, deleted: false },
  ] };
  const input = event(data), original = structuredClone(input);
  const text = eventContent(input, "Asia/Tokyo").join("\n");
  for (const expected of ["Original context & question.", "Second root paragraph.", long, "A distinct reply.", "Ada", "Grace", "19:00", "20:00", "Asia/Tokyo", "https://example.org/proof#α", "https://example.org/comment/a", "https://example.org/comment/b", "Public comment window only.", "Comments (2)"]) assert.ok(text.includes(expected), expected.slice(0, 100));
  assert.equal(text.split(long).length - 1, 1);
  assert.equal(text.split("A distinct reply.").length - 1, 1);
  assert.match(text, /In reply to: https:\/\/example\.org\/comment\/a/);
  assert.doesNotMatch(text, /777001|888001|888002|Thread id:|Parent(?: id| number)?:|Dead:|Deleted: false|<\/?(?:p|a|script)\b|&amp;|active-marker/);
  assert.deepEqual(input, original, "presentation preserves exact stored observations");
});

test("discussion parent links support provider IDs and post numbers without exposing them", () => {
  for (const parentField of ["parentId", "parentNumber"] as const) {
    const input = event({ body: "Original topic", postCount: 3, comments: [
      { id: "internal-parent", postNumber: 2, author: "First", url: "https://example.org/thread/2", body: "A first argument." },
      { id: "internal-child", postNumber: 3, author: "Second", url: "https://example.org/thread/3", [parentField]: parentField === "parentId" ? "internal-parent" : 2, body: "A second argument." },
    ] });
    const text = eventContent(input).join("\n");
    assert.match(text, /In reply to: https:\/\/example\.org\/thread\/2/);
    assert.doesNotMatch(text, /internal-parent|internal-child|Post number:|Parent(?: id| number)?:/);
    assert.equal(text.split("A first argument.").length - 1, 1);
    assert.equal(text.split("A second argument.").length - 1, 1);
  }
});

test("discussion rendering retains deleted-comment status and safe links without inventing parent links", () => {
  const input = event({ body: "Original topic", comments: [
    { id: "deleted-internal", parentId: "missing-internal", deleted: true, url: "https://example.org/comment/deleted" },
    { id: "moderated-internal", moderated: true, author: "Reader", body: '<p>Retained authored evidence <a href="javascript:bad()">label</a>.</p>', url: "https://example.org/comment/moderated", parentUrl: "javascript:bad()" },
  ] });
  const text = eventContent(input).join("\n");
  assert.match(text, /Deleted comment/);
  assert.match(text, /Moderated comment/);
  assert.match(text, /Retained authored evidence label/);
  assert.doesNotMatch(text, /missing-internal|deleted-internal|moderated-internal|javascript:|In reply to:/);
});

test("discussion presentation preserves each generated comment and source order without a count cap", () => {
  let state = 1794835;
  for (let trial = 0; trial < 16; trial++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const count = 1 + state % 200;
    const comments = Array.from({ length: count }, (_, i) => ({ id: `private-${i}`, author: `Reader ${i}`, body: `<p>Unique proof argument ${i} → complete.</p>`, url: `https://example.org/comment/${i}` }));
    const input = event({ body: "Root", comments });
    const text = eventContent(input).join("\n");
    let previous = -1;
    for (let i = 0; i < count; i++) {
      const marker = `Unique proof argument ${i} → complete.`;
      const position = text.indexOf(marker);
      assert.ok(position > previous);
      assert.equal(text.split(marker).length - 1, 1);
      previous = position;
    }
    assert.doesNotMatch(text, /private-\d+/);
  }
});
test('discussion email marks explicitly unavailable comments without inventing a body',()=>{
 const input=event({body:'Available root',comments:[{id:23,author:'Reader',body:'',unavailable:true,url:'https://example.org/23'}]});
 const text=eventContent(input).join('\n');
 assert.match(text,/Unavailable comment by Reader/);
 assert.deepEqual(input.after && (input.after as any).post.data.comments[0].body,'');
});
test('discussion formatting preserves extra substantive comment fields from generic JSON sources',()=>{
 for(const comment of [{id:'internal',note:'A retained technical note.',score:7},{id:'internal',body:'A complete comment.',note:'A retained technical note.'}]){
  const text=eventContent(event({comments:[comment]})).join('\n');
  assert.match(text,/A retained technical note\./);
 }
});
