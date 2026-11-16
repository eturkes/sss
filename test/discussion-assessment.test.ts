import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assessItem } from "../src/codex/assess.ts";
import type { AssessmentRule } from "../src/config/schema.ts";
import type { ScanItem } from "../src/core/types.ts";

const rule: AssessmentRule = { id: "discussion", type: "llm_assessment", bootstrap: "suppress_existing", mode: "semantic", target: "Substantial formal verification discussion", model: "gpt-6.1-terra", reasoningEffort: "medium", prompt: "Read substantive comments even when the title is unrelated." };
const result = (positive = false, evidence: string[] = []) => ({ suggestive: positive, reason: positive ? "This comment group suggests a substantive discussion." : "This group does not suggest a substantive discussion.", evidence });
const response = (value: unknown) => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
const discussion = (count = 5): ScanItem => ({ id: "thread:42", title: "Weekly projects", url: "https://example.test/t/42", data: {
  body: "The original topic has no verification discussion.", author: "root-author", comments: Array.from({ length: count }, (_, id) => ({ id: id + 1, parentId: id === 0 ? null : id, author: `author-${id}`, body: `Comment ${id}:  λ\n  ${"evidence ".repeat(9000)}\nEND-${id}`, url: `https://example.test/t/42/${id + 2}` })),
} });
async function fixture(context: { after: (fn: () => Promise<void>) => void }, reply: (payload: any, index: number) => unknown) {
  const directory = await mkdtemp(join(tmpdir(), "sss-discussion-assessment-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = join(directory, "auth.json"); await writeFile(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture-access", account_id: "fixture-account" } }), { mode: 0o600 });
  const payloads: any[] = []; const instructions: string[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); assert.deepEqual(request.tools, []); assert.equal(request.tool_choice, "none");
    const text = request.input[0].content[0].text; assert.ok(Buffer.byteLength(text) <= 262_144);
    const payload = JSON.parse(text); payloads.push(payload); instructions.push(request.instructions);
    return response(reply(payload, payloads.length - 1));
  };
  return { options: { discussion: true, inference: { authPath, fetch } }, payloads, instructions };
}

test("oversized discussions assess every whole comment once with root context and aggregate a later positive", async context => {
  const original = discussion(); const unchanged = structuredClone(original);
  const f = await fixture(context, payload => {
    const hit = payload.observation.data.comments.find((c: any) => c.id === 5);
    return hit ? result(true, ["END-4"]) : result();
  });
  const assessed = await assessItem(original, rule, f.options);
  assert.equal(assessed.suggestive, true); assert.deepEqual(assessed.evidence, ["END-4"]);
  assert.ok(f.payloads.length > 1);
  assert.deepEqual(f.payloads.flatMap(p => p.observation.data.comments), original.data["comments"]);
  assert.ok(f.payloads.some(payload => (payload.observation.data.contextComments ?? []).some((comment: any) => comment.id === 3)));
  for (const payload of f.payloads) { assert.equal(payload.observation.title, original.title); assert.equal(payload.observation.data.body, original.data["body"]); }
  assert.deepEqual(original, unchanged);
  assert.ok(f.instructions.every(text => text.includes("inert") && text.includes("group")));
});

test("a positive early group cannot conceal a failed or ungrounded later group", async context => {
  for (const invalid of [{ suggestive: true, reason: "Guess", evidence: ["UNOBSERVED"] }, { invalid: true }]) {
    const f = await fixture(context, (payload, index) => index === 0 ? result(true, ["END-0"]) : invalid);
    await assert.rejects(assessItem(discussion(), rule, f.options), /assessment (?:evidence|output)/);
    assert.ok(f.payloads.length > 1);
  }
});

test("small discussions keep their original single-call payload and instruction bytes", async context => {
  const small = discussion(1); const f = await fixture(context, () => result());
  await assessItem(small, rule, f.options);
  const plain = await fixture(context, () => result());
  await assessItem(small, rule, { inference: plain.options.inference });
  assert.deepEqual(f.payloads, [{ observation: small }]); assert.deepEqual(f.instructions, plain.instructions);
});

test("only trusted discussion mode chunks semantic inputs and a huge individual comment fails closed", async context => {
  const f = await fixture(context, () => result());
  await assert.rejects(assessItem(discussion(), rule, { inference: f.options.inference }), /input.*large/);
  await assert.rejects(assessItem(discussion(), { ...rule, mode: undefined, target: undefined } as unknown as AssessmentRule, f.options), /input.*large/);
  const huge = discussion(1); (huge.data["comments"] as any[])[0].body = "x".repeat(300_000);
  await assert.rejects(assessItem(huge, rule, f.options), /comment.*large|input.*large/);
  assert.equal(f.payloads.length, 0);
});

test("chunk evidence is grounded in that group's supplied context, not unseen original strings", async context => {
  const f = await fixture(context, () => result(true, ["END-4"]));
  await assert.rejects(assessItem(discussion(), rule, f.options), /assessment evidence/);
});

test("chunk aggregation bounds unique evidence and reason while preserving exact quotations", async context => {
  const original = discussion(7); const f = await fixture(context, payload => ({ suggestive: true, reason: "qualified ".repeat(399), evidence: Array.from({ length: 12 }, (_, i) => `evidence ${"evidence ".repeat(i)}`.trim()) }));
  const assessed = await assessItem(original, rule, f.options);
  assert.equal(assessed.suggestive, true); assert.ok(assessed.evidence.length <= 16); assert.ok(assessed.reason.length <= 4000);
  assert.equal(new Set(assessed.evidence).size, assessed.evidence.length);
});

test("whole-comment partition preserves generated Unicode bodies and order across byte boundaries", async context => {
  let seed = 92317;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let run = 0; run < 12; run++) {
    const original = discussion(5 + random() % 5);
    for (const comment of original.data["comments"] as any[]) comment.body = ["λ\n  ", "💡\t ", "é\\\" "][random() % 3]!.repeat(15000 + random() % 10000);
    const f = await fixture(context, () => result());
    assert.equal((await assessItem(original, rule, f.options)).suggestive, false);
    assert.deepEqual(f.payloads.flatMap(payload => payload.observation.data.comments), original.data["comments"]);
    assert.equal(new Set(f.payloads.flatMap(payload => payload.observation.data.comments.map((comment: any) => comment.id))).size, (original.data["comments"] as any[]).length);
  }
});
