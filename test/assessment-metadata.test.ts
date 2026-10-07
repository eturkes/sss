import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ScannerEngine } from "../src/core/engine.ts";
import type { ScanItem } from "../src/core/types.ts";
import { Store } from "../src/store/database.ts";

const at = "2026-10-07T09:00:00.000Z";
const negative = { suggestive: false, reason: "No reset hint.", evidence: [] };
const positive = { suggestive: true, reason: "The text may suggest replenished usage.", evidence: ["fresh tank tomorrow"] };
const original: ScanItem = { id: "one", title: "Original Å\nheading", url: "https://example.com/original", publishedAt: at, data: { text: "fresh tank tomorrow" } };
const config = (bootstrap = "evaluate_current") => ({ id: "watch", name: "Watch", enabled: true, source: { type: "fixture" },
  rules: [{ id: "hint", type: "llm_assessment", bootstrap, model: "gpt-6.1-sol", reasoningEffort: "xhigh", prompt: "Assess reset hints." }],
  notifications: [{ type: "inbox" }] } as never);
function setup() {
  const store = new Store(":memory:");
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, "{}", "ns", at);
  return store;
}

for (const [field, value] of [["title", "Changed Å\n\nheading"], ["url", "https://example.com/changed"], ["publishedAt", "2026-10-07T09:01:00.000Z"]] as const) {
  test(`legacy assessment revisits ${field}-only changes and caches the complete revised input`, async () => {
    const store = setup();
    try {
      let item = structuredClone(original);
      const calls: ScanItem[] = [];
      const engine = new ScannerEngine(store, async () => ({ items: [item], fetchedAt: at }), () => new Date(at), async input => { calls.push(input); return negative; });
      await engine.run(config(), "ns", { scheduledFor: "initial" });
      item = { ...item, [field]: value };
      await engine.run(config(), "ns", { scheduledFor: "metadata-change" });
      assert.deepEqual(calls, [original, item]);
      await engine.run(config(), "ns", { scheduledFor: "same-input" });
      assert.equal(calls.length, 2);
      delete item[field];
      await engine.run(config(), "ns", { scheduledFor: "removed-metadata" });
      assert.equal(calls.length, 3);
      assert.equal(calls[2]![field], undefined);
    } finally { store.close(); }
  });
}

test("assessment keys follow JSON omission, preserve empty strings, and ignore key order and acquisition time", async () => {
  const store = setup();
  try {
    let item: ScanItem = { id: "one", data: { text: "fresh tank tomorrow", nested: { b: "β", a: "α" } } };
    let fetchedAt = at;
    const calls: ScanItem[] = [];
    const engine = new ScannerEngine(store, async () => ({ items: [item], fetchedAt }), () => new Date(at), async input => { calls.push(input); return negative; });
    await engine.run(config(), "ns", { scheduledFor: "initial" });
    for (const key of ["title", "url", "publishedAt"]) Reflect.set(item, key, undefined);
    item.data = { nested: { a: "α", b: "β" }, text: "fresh tank tomorrow" };
    fetchedAt = "2026-10-07T09:05:00.000Z";
    await engine.run(config(), "ns", { scheduledFor: "same-json" });
    assert.equal(calls.length, 1);
    item.title = "";
    await engine.run(config(), "ns", { scheduledFor: "empty-title" });
    assert.equal(calls.length, 2);
    delete item.title;
    await engine.run(config(), "ns", { scheduledFor: "missing-title" });
    assert.equal(calls.length, 3);
    await engine.run(config(), "ns", { scheduledFor: "missing-again" });
    assert.equal(calls.length, 3);
  } finally { store.close(); }
});

test("failed metadata reassessment preserves accepted metadata and judgment until retry succeeds", async () => {
  const store = setup();
  try {
    let item = structuredClone(original);
    let fail = false;
    let calls = 0;
    const engine = new ScannerEngine(store, async () => ({ items: [item], fetchedAt: at }), () => new Date(at), async () => { calls++; if (fail) throw new Error("unavailable"); return negative; });
    await engine.run(config(), "ns", { scheduledFor: "initial" });
    const previous = store.ruleState("watch", "ns", "hint", "one");
    item.title = "Changed metadata";
    fail = true;
    assert.equal((await engine.run(config(), "ns", { scheduledFor: "failed" })).status, "degraded");
    assert.deepEqual(store.ruleState("watch", "ns", "hint", "one"), previous);
    assert.equal(store.existingItems("watch", "ns").get("one")!.title, original.title);
    fail = false;
    await engine.run(config(), "ns", { scheduledFor: "retry" });
    await engine.run(config(), "ns", { scheduledFor: "cached" });
    assert.equal(calls, 3);
    assert.equal(store.existingItems("watch", "ns").get("one")!.title, item.title);
  } finally { store.close(); }
});

for (const status of ["suppressed", "negative", "positive"] as const) {
  test(`legacy ${status} data-only cache refreshes once without resetting acquisition history`, async () => {
    const store = setup();
    try {
      let calls = 0;
      const engine = new ScannerEngine(store, async () => ({ items: [original], fetchedAt: at }), () => new Date(at), async () => { calls++; return positive; });
      await engine.run(config("suppress_existing"), "ns", { scheduledFor: "initial" });
      const before = store.existingItems("watch", "ns").get("one")!;
      store.setRuleState("watch", "ns", "hint", "one", { revision: createHash("sha256").update(JSON.stringify(original.data)).digest("hex"), status: status === "suppressed" ? status : "assessed",
        ...(status === "suppressed" ? {} : { suggestive: status === "positive", reason: "Old judgment", evidence: status === "positive" ? positive.evidence : [] }) }, at);
      const refreshed = await engine.run(config("suppress_existing"), "ns", { scheduledFor: "upgrade" });
      assert.equal(calls, 1);
      assert.equal(refreshed.events.length, 1);
      assert.equal((await engine.run(config("suppress_existing"), "ns", { scheduledFor: "cached" })).events.length, 0);
      assert.equal(calls, 1);
      assert.deepEqual(store.existingItems("watch", "ns").get("one"), before);
    } finally { store.close(); }
  });
}

test("complete-input revisions cannot alias a legacy data hash that looks like a full observation", async () => {
  const store = setup();
  try {
    const next: ScanItem = { id: "one", data: { text: "fresh tank tomorrow" } };
    const legacyData = { data: next.data, id: next.id };
    let item: ScanItem = { id: next.id, data: legacyData };
    let calls = 0;
    const engine = new ScannerEngine(store, async () => ({ items: [item], fetchedAt: at }), () => new Date(at), async () => { calls++; return positive; });
    await engine.run(config(), "ns", { scheduledFor: "legacy" });
    store.setRuleState("watch", "ns", "hint", "one", { ...store.ruleState("watch", "ns", "hint", "one"), revision: createHash("sha256").update(JSON.stringify(legacyData)).digest("hex") }, at);
    item = next;
    await engine.run(config(), "ns", { scheduledFor: "new-format" });
    assert.equal(calls, 2);
    await engine.run(config(), "ns", { scheduledFor: "same-input" });
    assert.equal(calls, 2);
  } finally { store.close(); }
});
