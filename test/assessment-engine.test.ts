import assert from "node:assert/strict";
import { test } from "node:test";

import { ScannerEngine } from "../src/core/engine.ts";
import type { Collection, JsonObject, ScanItem } from "../src/core/types.ts";
import { Store } from "../src/store/database.ts";

const at = new Date("2026-01-01T00:00:00.000Z");
const positive = { suggestive: true, reason: "The joke suggests a coming usage-limit refresh.", evidence: ["fresh tank tomorrow"] };
const negative = { suggestive: false, reason: "No usage-limit reset is suggested.", evidence: [] };
type Assessment = typeof positive;

function rule(overrides: Record<string, unknown> = {}) {
  return { id: "reset", type: "llm_assessment", bootstrap: "evaluate_current", model: "gpt-6.1-sol", reasoningEffort: "xhigh", prompt: "Assess an incoming Codex usage-limit reset.", ...overrides };
}

function monitor(rules = [rule()], assertions?: Record<string, unknown>) {
  return {
    id: "watch", name: "Watch", enabled: true, source: { type: "fixture" }, rules,
    ...(assertions ? { assertions } : {}), notifications: [{ type: "webhook", url: "https://example.com/alert" }],
  } as never;
}

function post(id: string, text: string, extras: JsonObject = {}): ScanItem {
  return { id, title: text, url: `https://x.com/thsottiaux/status/${id}`, data: { text, author: "thsottiaux", ...extras } };
}

function syncedStore(namespace = "ns"): Store {
  const store = new Store(":memory:");
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, "{}", namespace, at.toISOString());
  return store;
}

function fixture(items: ScanItem[]): Collection { return { items, fetchedAt: at.toISOString() }; }

test("assessment evaluates new and edited revisions, caches negatives, and deduplicates positives", async () => {
  const store = syncedStore();
  let items = [post("1", "ordinary post")];
  const seen: string[] = [];
  const engine = new ScannerEngine(store, async () => fixture(items), () => at, async (item) => {
    // An assessor must run outside the SQLite transaction.
    store.transaction(() => undefined);
    seen.push(String(item.data["text"]));
    return item.data["text"] === "ordinary post" ? negative : positive;
  });
  const config = monitor();
  assert.equal((await engine.run(config, "ns", { scheduledFor: "initial-negative" })).status, "ok_unchanged");
  assert.equal((await engine.run(config, "ns", { scheduledFor: "negative-again" })).events.length, 0);
  items = [post("1", "fresh tank tomorrow"), post("2", "fresh tank tomorrow")];
  const changed = await engine.run(config, "ns", { scheduledFor: "edited-and-new" });
  assert.deepEqual(changed.events.map((event) => event.itemId), ["1", "2"]);
  assert.equal(changed.events[0]!.kind, "llm_assessment");
  assert.match(changed.events[0]!.reason, /model judgment.*gpt-6\.1-sol/i);
  assert.deepEqual(changed.events[0]!.after, {
    post: items[0], assessment: { ...positive, model: "gpt-6.1-sol", reasoningEffort: "xhigh" },
  });
  assert.equal((await engine.run(config, "ns", { scheduledFor: "positive-again" })).events.length, 0);
  items = [post("2", "fresh tank tomorrow")];
  await engine.run(config, "ns", { scheduledFor: "disappeared" });
  items = [post("1", "fresh tank tomorrow"), post("2", "fresh tank tomorrow")];
  assert.equal((await engine.run(config, "ns", { scheduledFor: "returned" })).events.length, 0);
  items = [post("1", "ordinary post"), post("2", "fresh tank tomorrow")];
  assert.equal((await engine.run(config, "ns", { scheduledFor: "edited-negative" })).events.length, 0);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "edited-negative-again" })).events.length, 0);
  assert.deepEqual(seen, ["ordinary post", "fresh tank tomorrow", "fresh tank tomorrow", "ordinary post"]);
  assert.equal(store.events().length, 2);
  assert.equal(store.deliveryHealth().pending, 2);
  store.close();
});

test("suppressed bootstrap marks the current revision and assesses only new or edited posts", async () => {
  const store = syncedStore();
  let items = [post("1", "fresh tank tomorrow")];
  let calls = 0;
  const engine = new ScannerEngine(store, async () => fixture(items), () => at, async () => { calls++; return positive; });
  const config = monitor([rule({ bootstrap: "suppress_existing" })]);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "prime" })).events.length, 0);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "same" })).events.length, 0);
  assert.equal(calls, 0);
  assert.equal(store.ruleState("watch", "ns", "reset", "1")?.["status"], "suppressed");
  items = [post("1", "fresh tank tomorrow, probably"), post("2", "fresh tank tomorrow")];
  assert.equal((await engine.run(config, "ns", { scheduledFor: "new-and-edit" })).events.length, 2);
  assert.equal(calls, 2);
  store.close();
});

test("empty suppressed bootstrap assesses its first future post", async () => {
  const store = syncedStore();
  let items: ScanItem[] = [];
  let calls = 0;
  const engine = new ScannerEngine(store, async () => fixture(items), () => at, async () => { calls++; return positive; });
  const config = monitor([rule({ bootstrap: "suppress_existing" })], { allowEmpty: true });
  assert.equal((await engine.run(config, "ns", { scheduledFor: "empty" })).status, "ok_unchanged");
  items = [post("1", "fresh tank tomorrow")];
  assert.equal((await engine.run(config, "ns", { scheduledFor: "first" })).events.length, 1);
  assert.equal(calls, 1);
  store.close();
});

test("assessment failure preserves all baselines and rule states and retries the complete batch", async () => {
  const store = syncedStore();
  let items = [post("1", "ordinary post")];
  let fail = false;
  let calls = 0;
  const engine = new ScannerEngine(store, async () => fixture(items), () => at, async (item) => {
    calls++;
    if (fail && item.id === "2") throw new Error("assessment unavailable");
    return item.data["text"] === "ordinary post" ? negative : positive;
  });
  const config = monitor();
  await engine.run(config, "ns", { scheduledFor: "baseline" });
  const priorState = store.ruleState("watch", "ns", "reset", "1");
  items = [post("1", "fresh tank tomorrow"), post("2", "fresh tank tomorrow")];
  fail = true;
  const failed = await engine.run(config, "ns", { scheduledFor: "failed" });
  assert.equal(failed.status, "degraded");
  assert.match(failed.error!, /assessment unavailable/);
  assert.deepEqual(store.ruleState("watch", "ns", "reset", "1"), priorState);
  assert.equal(store.ruleState("watch", "ns", "reset", "2"), undefined);
  assert.deepEqual([...store.existingItems("watch", "ns").keys()], ["1"]);
  assert.equal(JSON.parse(store.existingItems("watch", "ns").get("1")!.data_json).text, "ordinary post");
  assert.equal(store.observations("watch").length, 1);
  assert.equal(store.events().length, 0);
  fail = false;
  assert.equal((await engine.run(config, "ns", { scheduledFor: "recovered" })).events.length, 2);
  assert.equal(calls, 5);
  store.close();
});

test("invariant changes reject the complete scan before any assessment", async () => {
  const store = syncedStore();
  let items = [post("1", "ordinary post"), post("2", "ordinary post")];
  let calls = 0;
  const engine = new ScannerEngine(store, async () => fixture(items), () => at, async () => { calls++; return negative; });
  const config = monitor([rule()], { invariantFields: ["author"] });
  await engine.run(config, "ns", { scheduledFor: "base" });
  items = [post("1", "fresh tank tomorrow"), post("2", "fresh tank tomorrow", { author: "other" })];
  const changed = await engine.run(config, "ns", { scheduledFor: "bad-context" });
  assert.equal(changed.status, "degraded");
  assert.match(changed.error!, /invariant field author changed/);
  assert.equal(calls, 2);
  assert.equal(store.observations("watch").length, 2);
  assert.equal(store.events().length, 0);
  store.close();
});

test("assessment caches stay isolated by rule and semantic namespace", async () => {
  const store = syncedStore();
  let calls = 0;
  const engine = new ScannerEngine(store, async () => fixture([post("1", "fresh tank tomorrow")]), () => at, async () => { calls++; return positive; });
  const config = monitor([rule(), rule({ id: "second" })]);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "old" })).events.length, 2);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "same" })).events.length, 0);
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, "{}", "new-ns", at.toISOString());
  assert.equal((await engine.run(config, "new-ns", { scheduledFor: "new" })).events.length, 2);
  assert.equal(calls, 4);
  store.close();
});

test("disabled assessment and dry run never call a model or create alerts", async () => {
  const store = syncedStore();
  let calls = 0;
  const engine = new ScannerEngine(store, async () => fixture([post("1", "fresh tank tomorrow")]), () => at, async () => { calls++; return positive; });
  const dry = await engine.run(monitor(), "ns", { dryRun: true });
  assert.equal(dry.status, "ok_unchanged");
  assert.equal(dry.items.length, 1);
  assert.equal(store.recentRuns().length, 0);
  assert.equal(store.observations("watch").length, 0);
  const disabled = await engine.run(monitor([rule({ enabled: false })]), "ns", { scheduledFor: "disabled" });
  assert.equal(disabled.status, "ok_unchanged");
  assert.equal(store.ruleState("watch", "ns", "reset", "1"), undefined);
  assert.equal(store.events().length, 0);
  assert.equal(calls, 0);
  store.close();
});

test("malformed assessor output degrades without accepting the baseline", async () => {
  for (const result of [null, { ...positive, evidence: [] }, { ...negative, reason: " " }, { ...positive, suggestive: "yes" }, { ...positive, tool: "shell" }]) {
    const store = syncedStore();
    let calls = 0;
    const engine = new ScannerEngine(store, async () => fixture([post("1", "fresh tank tomorrow")]), () => at, async () => { calls++; return result as never; });
    assert.equal((await engine.run(monitor(), "ns", { scheduledFor: "malformed" })).status, "degraded");
    assert.equal(calls, 1);
    assert.equal(store.initialized("watch", "ns"), false);
    assert.equal(store.ruleState("watch", "ns", "reset", "1"), undefined);
    assert.equal(store.events().length, 0);
    store.close();
  }
});

test("superseded scan attempts cannot commit assessment results", async () => {
  const store = syncedStore();
  let clock = at;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { entered = resolve; });
  let release!: (result: Assessment) => void;
  const result = new Promise<Assessment>((resolve) => { release = resolve; });
  const engine = new ScannerEngine(store, async () => fixture([post("1", "fresh tank tomorrow")]), () => clock, async () => { entered(); return result; });
  const first = engine.run(monitor(), "ns", { scheduledFor: "same-slot" });
  await pending;
  clock = new Date(at.getTime() + 31 * 60_000);
  const replacement = new ScannerEngine(store, async () => fixture([post("1", "ordinary post")]), () => clock, async () => negative);
  assert.equal((await replacement.run(monitor(), "ns", { scheduledFor: "same-slot" })).status, "ok_unchanged");
  const acceptedState = store.ruleState("watch", "ns", "reset", "1");
  release(positive);
  assert.equal((await first).status, "skipped");
  assert.deepEqual(store.ruleState("watch", "ns", "reset", "1"), acceptedState);
  assert.equal(JSON.parse(store.existingItems("watch", "ns").get("1")!.data_json).text, "ordinary post");
  assert.equal(store.events().length, 0);
  store.close();
});

test("a changed monitor lease fences an assessment that finishes later", async () => {
  const store = syncedStore();
  const claim = store.claimMonitor("watch", at.toISOString(), new Date(at.getTime() + 30 * 60_000).toISOString())!;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { entered = resolve; });
  let release!: (result: Assessment) => void;
  const result = new Promise<Assessment>((resolve) => { release = resolve; });
  const engine = new ScannerEngine(store, async () => fixture([post("1", "fresh tank tomorrow")]), () => at, async () => { entered(); return result; });
  const run = engine.run(monitor(), "ns", { scheduledFor: "leased", monitorLeaseToken: claim.leaseToken });
  await pending;
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, "{\"changed\":true}", "ns", at.toISOString());
  release(positive);
  assert.equal((await run).status, "skipped");
  assert.equal(store.initialized("watch", "ns"), false);
  assert.equal(store.ruleState("watch", "ns", "reset", "1"), undefined);
  assert.equal(store.events().length, 0);
  store.close();
});

test("event-write failure rolls back assessment cache, event, and baseline together", async () => {
  const store = syncedStore();
  let calls = 0;
  const engine = new ScannerEngine(store, async () => fixture([post("1", "fresh tank tomorrow")]), () => at, async () => { calls++; return positive; });
  const insertEvent = store.insertEvent.bind(store);
  store.insertEvent = (event, targets) => { insertEvent(event, targets); throw new Error("event write rejected"); };
  assert.equal((await engine.run(monitor(), "ns", { scheduledFor: "rollback" })).status, "degraded");
  assert.equal(store.initialized("watch", "ns"), false);
  assert.equal(store.observations("watch").length, 0);
  assert.equal(store.ruleState("watch", "ns", "reset", "1"), undefined);
  assert.equal(store.events().length, 0);
  assert.equal(store.deliveryHealth().pending, 0);
  store.insertEvent = insertEvent;
  assert.equal((await engine.run(monitor(), "ns", { scheduledFor: "retry" })).events.length, 1);
  assert.equal(calls, 2);
  store.close();
});

test("collectors receive only previously accepted posts, including after a rejected scan", async () => {
  const store = syncedStore();
  const contexts: ScanItem[][] = [];
  const scans = [[post("1", "ordinary post")], [], [post("2", "fresh tank tomorrow")]];
  const engine = new ScannerEngine(store, async (_source, context) => {
    assert.ok(context);
    contexts.push(context.previousItems);
    return fixture(scans.shift()!);
  }, () => at, async () => negative);
  assert.equal((await engine.run(monitor(), "ns", { scheduledFor: "first" })).status, "ok_unchanged");
  assert.equal((await engine.run(monitor(), "ns", { scheduledFor: "rejected" })).status, "degraded");
  assert.equal((await engine.run(monitor(), "ns", { scheduledFor: "recovered" })).status, "ok_unchanged");
  assert.deepEqual(contexts, [[], [post("1", "ordinary post")], [post("1", "ordinary post")]]);
  store.close();
});

test("repeated assessment failures emit health degradation once and recovery after acceptance", async () => {
  const store = syncedStore();
  let calls = 0;
  const engine = new ScannerEngine(store, async () => fixture([post("1", "fresh tank tomorrow")]), () => at, async () => {
    if (++calls <= 3) throw new Error("assessment unavailable");
    return positive;
  });
  const config = { ...monitor() as unknown as Record<string, unknown>, health: { failuresBeforeAlert: 2 } } as never;
  assert.equal((await engine.run(config, "ns", { scheduledFor: "failure-1" })).events.length, 0);
  assert.deepEqual((await engine.run(config, "ns", { scheduledFor: "failure-2" })).events.map((event) => event.kind), ["health_degraded"]);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "failure-3" })).events.length, 0);
  assert.equal(store.initialized("watch", "ns"), false);
  const recovery = await engine.run(config, "ns", { scheduledFor: "recovery" });
  assert.deepEqual(recovery.events.map((event) => event.kind), ["llm_assessment", "health_recovered"]);
  assert.equal(store.healthAlerted("watch"), false);
  assert.equal(calls, 4);
  store.close();
});

test("long assessment batches renew the active monitor lease and reject superseded-token renewal", async () => {
  const store = syncedStore();
  let clock = at;
  const deadline = (minutes: number) => new Date(clock.getTime() + minutes * 60_000).toISOString();
  const claim = store.claimMonitor("watch", clock.toISOString(), deadline(30))!;
  const engine = new ScannerEngine(store, async () => fixture([post("1", "fresh tank tomorrow"), post("2", "fresh tank tomorrow"), post("3", "fresh tank tomorrow")]), () => clock, async () => {
    clock = new Date(clock.getTime() + 20 * 60_000);
    assert.equal(store.claimMonitor("watch", clock.toISOString(), deadline(30)), undefined);
    return positive;
  });
  const result = await engine.run(monitor(), "ns", { scheduledFor: "long-batch", monitorLeaseToken: claim.leaseToken });
  assert.equal(result.status, "ok_changed");
  assert.equal(result.events.length, 3);
  assert.equal(store.status()[0]!.leaseUntil, deadline(30));
  clock = new Date(at.getTime() + 91 * 60_000);
  const successor = store.claimMonitor("watch", clock.toISOString(), deadline(30))!;
  assert.throws(() => store.renewMonitorLease("watch", claim.leaseToken, clock.toISOString(), deadline(60)), { code: "SSS_LEASE_LOST" });
  store.renewMonitorLease("watch", successor.leaseToken, clock.toISOString(), deadline(60));
  assert.equal(store.status()[0]!.leaseUntil, deadline(60));
  store.close();
});

test("assessment preserves exact source strings and reassesses formatting or Unicode edits", async () => {
  const store = syncedStore();
  const text = "Å says:\n\nfresh tank tomorrow 😏";
  const quote = { text: "ＡＩ\nperhaps", by: "author" };
  const original = post("1", text, { quote });
  let item = original;
  const assessed: ScanItem[] = [];
  const engine = new ScannerEngine(store, async () => fixture([item]), () => at, async (input) => { assessed.push(input); return positive; });
  const config = monitor();
  const first = await engine.run(config, "ns", { scheduledFor: "raw" });
  assert.deepEqual(assessed, [original]);
  assert.deepEqual((first.events[0]!.after as JsonObject)["post"], original);
  item = { ...original, data: { quote: { by: quote.by, text: quote.text }, author: "thsottiaux", text } };
  assert.equal((await engine.run(config, "ns", { scheduledFor: "reordered-keys" })).events.length, 0);
  assert.equal(assessed.length, 1);
  item = post("1", text.replace(/\n+/g, " "), { quote });
  const formatting = await engine.run(config, "ns", { scheduledFor: "formatting" });
  assert.equal(formatting.events.length, 1);
  assert.deepEqual((formatting.events[0]!.after as JsonObject)["post"], item);
  item = post("1", text.replace(/\n+/g, " ").replace("Å", "Å"), { quote });
  assert.equal((await engine.run(config, "ns", { scheduledFor: "unicode" })).events.length, 1);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "unicode-again" })).events.length, 0);
  assert.equal(assessed.length, 3);
  assert.deepEqual(assessed[2], item);
  assert.equal(store.observations("watch")[0]!.data["text"], "Å says: fresh tank tomorrow 😏");
  store.close();
});

test("filtered email queues only suggestive judgments while the inbox retains health events", async () => {
  const store = syncedStore();
  let failing = true;
  const engine = new ScannerEngine(store, async () => fixture([post("1", "fresh tank tomorrow")]), () => at, async () => {
    if (failing) throw new Error("assessment unavailable");
    return positive;
  });
  const config = {
    ...monitor() as unknown as Record<string, unknown>, health: { failuresBeforeAlert: 1 },
    notifications: [{ type: "inbox" }, { type: "email", id: "matching", to: "receiver@example.com", events: ["llm_assessment"] }],
  } as never;
  const failure = await engine.run(config, "ns", { scheduledFor: "failure" });
  assert.deepEqual(failure.events.map((event) => event.kind), ["health_degraded"]);
  assert.equal(store.events().length, 1);
  assert.equal(store.deliveryHealth().pending, 0);
  failing = false;
  const recovery = await engine.run(config, "ns", { scheduledFor: "recovery" });
  assert.deepEqual(recovery.events.map((event) => event.kind), ["llm_assessment", "health_recovered"]);
  assert.equal(store.events().length, 3);
  assert.equal(store.deliveryHealth().pending, 1);
  const queued = store.failedDeliveries()[0]!;
  assert.equal(queued["channel"], "email:matching");
  assert.equal(store.event(String(queued["event_id"]))!.kind, "llm_assessment");
  assert.equal((await engine.run(config, "ns", { scheduledFor: "unchanged" })).events.length, 0);
  assert.equal(store.deliveryHealth().pending, 1);
  store.close();
});

test("X baselines retain raw parent context and return it unchanged to the next collector", async () => {
  const store = syncedStore();
  const context = { parent: { text: "Å says:\n\nfresh tank tomorrow 😏", quoted: "ＡＩ\nperhaps" } };
  const original = post("1", "a subtle joke", { context });
  const previous: ScanItem[][] = [];
  let calls = 0;
  const engine = new ScannerEngine(store, async (_source, acquisition) => {
    assert.ok(acquisition);
    previous.push(acquisition.previousItems);
    return fixture([post("1", "a subtle joke", { context: acquisition.previousItems[0]?.data["context"] ?? context })]);
  }, () => at, async () => { calls++; return positive; });
  const config = { ...monitor() as unknown as Record<string, unknown>, source: { type: "x", handle: "thsottiaux" } } as never;
  assert.equal((await engine.run(config, "ns", { scheduledFor: "initial" })).events.length, 1);
  assert.deepEqual(JSON.parse(store.existingItems("watch", "ns").get("1")!.data_json), original.data);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "same-context" })).events.length, 0);
  assert.deepEqual(previous, [[], [original]]);
  assert.equal(calls, 1);
  store.close();
});

test("collector bootstrap identities retain the first accepted batch after updates and pruning, isolated by namespace", async () => {
  const store = syncedStore();
  let clock = at;
  const xpost = (id: string) => ({ ...post(id, "ordinary post"), id: `x:${id}` });
  let items = [xpost("20"), xpost("10")];
  const contexts: Array<{ previous: string[]; bootstrap: string[] | undefined }> = [];
  const engine = new ScannerEngine(store, async (_source, context) => {
    assert.ok(context);
    contexts.push({ previous: context.previousItems.map((item) => item.id).sort(), bootstrap: context.bootstrapItemIds });
    return { items, fetchedAt: clock.toISOString() };
  }, () => clock, async () => negative);
  const config = monitor([rule({ bootstrap: "suppress_existing" })]);
  const first = await engine.run(config, "ns", { scheduledFor: "first" });
  assert.equal(first.status, "ok_unchanged");
  clock = new Date(at.getTime() + 60 * 60_000);
  items = [xpost("10"), xpost("20"), xpost("30")];
  assert.equal((await engine.run(config, "ns", { scheduledFor: "later" })).status, "ok_unchanged");
  store.prune("2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  assert.equal(store.recentRuns().some((run) => run["id"] === first.runId), false);
  clock = new Date(at.getTime() + 2 * 60 * 60_000);
  items = [xpost("30")];
  assert.equal((await engine.run(config, "ns", { scheduledFor: "after-prune" })).status, "ok_unchanged");
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, "{}", "new-ns", clock.toISOString());
  clock = new Date(at.getTime() + 3 * 60 * 60_000);
  items = [xpost("40")];
  assert.equal((await engine.run(config, "new-ns", { scheduledFor: "fresh-namespace" })).status, "ok_unchanged");
  clock = new Date(at.getTime() + 4 * 60 * 60_000);
  assert.equal((await engine.run(config, "new-ns", { scheduledFor: "fresh-again" })).status, "ok_unchanged");
  assert.deepEqual(contexts, [
    { previous: [], bootstrap: [] },
    { previous: ["x:10", "x:20"], bootstrap: ["x:10", "x:20"] },
    { previous: ["x:10", "x:20", "x:30"], bootstrap: ["x:10", "x:20"] },
    { previous: [], bootstrap: [] },
    { previous: ["x:40"], bootstrap: ["x:40"] },
  ]);
  assert.deepEqual(store.bootstrapItemIds("watch", "ns"), ["x:10", "x:20"]);
  assert.deepEqual(store.bootstrapItemIds("watch", "new-ns"), ["x:40"]);
  store.close();
});
