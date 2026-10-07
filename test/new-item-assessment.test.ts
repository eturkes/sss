import assert from "node:assert/strict";
import { test } from "node:test";
import { monitorSchema, semanticMonitorHash } from "../src/config/schema.ts";
import { ScannerEngine, type CollectorContext } from "../src/core/engine.ts";
import type { ScanItem } from "../src/core/types.ts";
import { Store } from "../src/store/database.ts";

const config = (trigger: string | undefined = "new_item") => ({ version: 1, id: "watch", name: "Watch", enabled: true,
  schedule: { every: "5m" }, source: { type: "x", handle: "thsottiaux", maxPages: 30 },
  rules: [{ id: "reset", type: "llm_assessment", bootstrap: "suppress_existing", model: "gpt-6.1-sol", reasoningEffort: "xhigh", prompt: "Assess reset hints.", ...(trigger ? { trigger } : {}) }],
  notifications: [{ type: "inbox" }] });
const at = "2026-10-07T08:00:00.000Z";
const post = (id: string, text: string): ScanItem => ({ id, data: { author: "thsottiaux", text } });
const judgment = { suggestive: false, reason: "No reset hint.", evidence: [] };
function store() { const result = new Store(":memory:"); result.syncMonitor({ id: "watch", name: "Watch", enabled: true }, "{}", "ns", at); return result; }

test("assessment trigger schema preserves legacy hashes and isolates strict-new semantics", () => {
  const legacy = config("new_or_changed");
  delete legacy.rules[0]!.trigger;
  const strict = monitorSchema.parse(config());
  const rule = strict.rules[0]!;
  assert.equal(rule.type === "llm_assessment" && rule.trigger, "new_item");
  assert.equal(semanticMonitorHash(legacy), semanticMonitorHash(config("new_or_changed")));
  assert.notEqual(semanticMonitorHash(config()), semanticMonitorHash(legacy));
  assert.equal(monitorSchema.safeParse(config("anything")).success, false);
});

test("strict-new judgments ignore accepted edits, quote changes, and returning IDs but assess new IDs", async () => {
  const db = store();
  try {
    let items = [post("one", "old post")];
    const calls: string[] = [];
    let context: CollectorContext | undefined;
    const engine = new ScannerEngine(db, async (_source, supplied) => { context = supplied; return { items, fetchedAt: at }; }, () => new Date(at), async item => { calls.push(item.id); return judgment; });
    const monitor = config() as never;
    await engine.run(monitor, "ns", { scheduledFor: "prime" });
    assert.equal(context?.newItemsOnly, true);
    items = [{ ...post("one", "edited reset hint"), data: { text: "edited reset hint", quotedText: "new quote", media: ["https://pbs.twimg.com/media/new.png"] } }];
    await engine.run(monitor, "ns", { scheduledFor: "edit" });
    assert.deepEqual(calls, []);
    items.push(post("two", "new post"));
    await engine.run(monitor, "ns", { scheduledFor: "new" });
    assert.deepEqual(calls, ["two"]);
    items = [post("two", "changed new post")];
    await engine.run(monitor, "ns", { scheduledFor: "absent" });
    items.push(post("one", "returned edited post"));
    await engine.run(monitor, "ns", { scheduledFor: "returned" });
    assert.deepEqual(calls, ["two"]);
  } finally { db.close(); }
});

test("strict-new skips inherited accepted identities without a judgment state", async () => {
  const db = store();
  try {
    let items = [post("one", "old post")];
    const calls: string[] = [];
    const engine = new ScannerEngine(db, async () => ({ items, fetchedAt: at }), () => new Date(at), async item => { calls.push(item.id); return judgment; });
    await engine.run({ ...config(), rules: [{ id: "seen", type: "new_items", bootstrap: "suppress_existing" }] } as never, "ns", { scheduledFor: "inherited" });
    assert.equal(db.ruleState("watch", "ns", "reset", "one"), undefined);
    items = [post("one", "edited old post"), post("two", "new post")];
    await engine.run(config() as never, "ns", { scheduledFor: "strict" });
    assert.deepEqual(calls, ["two"]);
  } finally { db.close(); }
});

test("strict-new retries failed pending posts without assessing accepted identities", async () => {
  const db = store();
  try {
    let items = [post("one", "old post")];
    const calls: string[] = [];
    let fail = true;
    const engine = new ScannerEngine(db, async () => ({ items, fetchedAt: at }), () => new Date(at), async item => { calls.push(item.id); if (fail) throw new Error("offline"); return judgment; });
    await engine.run(config() as never, "ns", { scheduledFor: "prime" });
    items = [post("one", "edited accepted post"), post("two", "new post")];
    assert.equal((await engine.run(config() as never, "ns", { scheduledFor: "failed" })).status, "degraded");
    fail = false;
    assert.equal((await engine.run(config() as never, "ns", { scheduledFor: "retry" })).status, "ok_unchanged");
    assert.deepEqual(calls, ["two", "two"]);
    await engine.run(config() as never, "ns", { scheduledFor: "accepted" });
    assert.deepEqual(calls, ["two", "two"]);
  } finally { db.close(); }
});
