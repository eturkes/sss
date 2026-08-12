import assert from "node:assert/strict";
import { test } from "node:test";

import { ScannerEngine } from "../src/core/engine.ts";
import type { Collection, JsonObject } from "../src/core/types.ts";
import { Store } from "../src/store/database.ts";

function monitor(rules: Array<Record<string, unknown>>, assertions?: Record<string, unknown>) {
  return {
    id: "watch", name: "Watch", enabled: true, source: { type: "fixture" },
    rules, ...(assertions ? { assertions } : {}), notifications: [{ type: "inbox" }],
  } as never;
}

function fixture(items: Array<{ id: string; data: JsonObject }>, fetchedAt: string): Collection {
  return { items, fetchedAt };
}

function syncedStore(namespace = "ns"): Store {
  const store = new Store(":memory:");
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, "{}", namespace, new Date().toISOString());
  return store;
}

test("new item corpus primes silently, then emits only unseen identities", async () => {
  const store = syncedStore();
  const scans = [
    fixture([{ id: "doi:a", data: { title: "A" } }, { id: "doi:b", data: { title: "B" } }], "2026-01-01T00:00:00.000Z"),
    fixture([{ id: "doi:b", data: { title: "B" } }, { id: "doi:c", data: { title: "C" } }], "2026-01-01T01:00:00.000Z"),
  ];
  let index = 0;
  const engine = new ScannerEngine(store, async () => scans[index++]!);
  const config = monitor([{ id: "new", type: "new_items", bootstrap: "suppress_existing" }]);
  const first = await engine.run(config, "ns", { scheduledFor: "first" });
  const second = await engine.run(config, "ns", { scheduledFor: "second" });
  assert.equal(first.events.length, 0);
  assert.deepEqual(second.events.map((event) => event.itemId), ["doi:c"]);
  assert.match(second.events[0]!.reason, /newly observed/);
  assert.equal(store.observations("watch").length, 4);
  store.close();
});

test("explicitly complete empty corpus primes so its first future item alerts", async () => {
  const store = syncedStore();
  const scans = [
    fixture([], "2026-01-01T00:00:00.000Z"),
    fixture([{ id: "doi:first", data: { title: "First match" } }], "2026-01-01T01:00:00.000Z"),
  ];
  let index = 0;
  const engine = new ScannerEngine(store, async () => scans[index++]!);
  const config = monitor([{ id: "new", type: "new_items" }], { allowEmpty: true, maxItems: 50 });
  assert.equal((await engine.run(config, "ns", { scheduledFor: "empty" })).status, "ok_unchanged");
  const first = await engine.run(config, "ns", { scheduledFor: "first-match" });
  assert.deepEqual(first.events.map((event) => event.itemId), ["doi:first"]);
  store.close();
});

test("price threshold alerts on edges, rearms, and evaluates current bootstrap", async () => {
  const store = syncedStore();
  const values = [55000, 49900, 48000, 51000, 49500];
  let index = 0;
  const engine = new ScannerEngine(store, async () => fixture([{ id: "fare", data: { price: { minor: values[index++]!, currency: "USD" } } }], new Date(1_700_000_000_000 + index * 1000).toISOString()));
  const config = monitor([{ id: "cheap", type: "crosses_below", field: "price", thresholdMinor: 50000, currency: "USD", bootstrap: "evaluate_current" }]);
  const counts: number[] = [];
  for (let attempt = 0; attempt < values.length; attempt++) counts.push((await engine.run(config, "ns", { scheduledFor: `p${attempt}` })).events.length);
  assert.deepEqual(counts, [0, 1, 0, 0, 1]);
  store.close();
});

test("first below-target quote alerts; incomparable currency degrades without replacing it", async () => {
  const store = syncedStore();
  const quotes = [
    { minor: 49000, currency: "USD" },
    { minor: 100, currency: "JPY" },
    { minor: 51000, currency: "USD" },
  ];
  let index = 0;
  const engine = new ScannerEngine(store, async () => fixture([{ id: "fare", data: { price: quotes[index++]! } }], new Date(1_700_000_000_000 + index * 1000).toISOString()));
  const config = monitor([{ id: "cheap", type: "crosses_below", field: "price", thresholdMinor: 50000, currency: "USD", bootstrap: "evaluate_current" }]);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "currency-1" })).events.length, 1);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "currency-2" })).status, "degraded");
  assert.equal((await engine.run(config, "ns", { scheduledFor: "currency-3" })).events.length, 0);
  store.close();
});

test("invalid extraction degrades and preserves last accepted baseline", async () => {
  const store = syncedStore();
  let attempt = 0;
  const engine = new ScannerEngine(store, async () => {
    attempt++;
    if (attempt === 2) return fixture([], "2026-01-01T01:00:00.000Z");
    return fixture([{ id: "x", data: { value: attempt === 1 ? "old" : "new" } }], `2026-01-01T0${attempt}:00:00.000Z`);
  });
  const config = monitor([{ id: "changed", type: "field_changed", field: "value" }]);
  await engine.run(config, "ns", { scheduledFor: "a" });
  const failed = await engine.run(config, "ns", { scheduledFor: "b" });
  const recovered = await engine.run(config, "ns", { scheduledFor: "c" });
  assert.equal(failed.status, "degraded");
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.events[0]!.before, "old");
  assert.equal(store.observations("watch").length, 2);
  store.close();
});

test("dry-run performs no state writes", async () => {
  const store = syncedStore();
  const engine = new ScannerEngine(store, async () => fixture([{ id: "x", data: { value: 1 } }], "2026-01-01T00:00:00.000Z"));
  const result = await engine.run(monitor([{ id: "new", type: "new_items" }]), "ns", { dryRun: true });
  assert.equal(result.items.length, 1);
  assert.equal(store.recentRuns().length, 0);
  assert.equal(store.events().length, 0);
  assert.equal(store.observations("watch").length, 0);
  store.close();
});

test("semantic namespaces isolate incompatible state", async () => {
  const store = syncedStore("old-ns");
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, "{}", "new-ns", new Date().toISOString());
  let value = "A";
  const engine = new ScannerEngine(store, async () => fixture([{ id: "x", data: { value } }], new Date().toISOString()));
  const config = monitor([{ id: "changed", type: "field_changed", field: "value" }]);
  await engine.run(config, "old-ns", { scheduledFor: "old" });
  value = "B";
  const fresh = await engine.run(config, "new-ns", { scheduledFor: "new" });
  assert.equal(fresh.events.length, 0);
  store.close();
});

test("health emits once at failure threshold and recovery separately", async () => {
  const store = new Store(":memory:");
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, "{}", "ns", new Date().toISOString());
  let attempt = 0;
  const engine = new ScannerEngine(store, async () => {
    attempt++;
    if (attempt <= 2) throw new Error("captcha/login page");
    return fixture([{ id: "x", data: { value: "ok" } }], new Date().toISOString());
  });
  const baseConfig = monitor([{ id: "new", type: "new_items" }]) as unknown as Record<string, unknown>;
  const config = { ...baseConfig, health: { failuresBeforeAlert: 2 } } as never;
  assert.equal((await engine.run(config, "ns", { scheduledFor: "h1" })).events.length, 0);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "h2" })).events[0]!.kind, "health_degraded");
  assert.equal((await engine.run(config, "ns", { scheduledFor: "h3" })).events[0]!.kind, "health_recovered");
  store.close();
});

test("health alert state survives threshold edits without orphan transitions", async () => {
  const store = syncedStore();
  let failing = true;
  const engine = new ScannerEngine(store, async () => {
    if (failing) throw new Error("source unavailable");
    return fixture([{ id: "x", data: { value: "ok" } }], new Date().toISOString());
  });
  const base = monitor([{ id: "new", type: "new_items" }]) as unknown as Record<string, unknown>;
  const high = { ...base, health: { failuresBeforeAlert: 5 } } as never;
  const low = { ...base, health: { failuresBeforeAlert: 2 } } as never;
  assert.equal((await engine.run(high, "ns", { scheduledFor: "threshold-1" })).events.length, 0);
  assert.equal((await engine.run(high, "ns", { scheduledFor: "threshold-2" })).events.length, 0);
  assert.equal((await engine.run(low, "ns", { scheduledFor: "threshold-3" })).events[0]?.kind, "health_degraded");
  failing = false;
  assert.equal((await engine.run(high, "ns", { scheduledFor: "threshold-4" })).events[0]?.kind, "health_recovered");
  store.close();
});

test("invariant quote context change degrades without emitting a price alert", async () => {
  const store = syncedStore();
  const quotes = [
    { price: { minor: 120_000, currency: "USD" }, itinerary: "HND-SFO 2026-09-01 1 adult" },
    { price: { minor: 80_000, currency: "USD" }, itinerary: "HND-SFO 2026-12-01 1 adult" },
  ];
  let index = 0;
  const engine = new ScannerEngine(store, async () => fixture([{ id: "fare", data: quotes[index++]! }], new Date().toISOString()));
  const config = monitor(
    [{ id: "cheap", type: "crosses_below", field: "price", thresholdMinor: 90_000, currency: "USD" }],
    { invariantFields: ["itinerary"], requiredFields: ["price", "itinerary"] },
  );
  assert.equal((await engine.run(config, "ns", { scheduledFor: "context-1" })).status, "ok_unchanged");
  const changed = await engine.run(config, "ns", { scheduledFor: "context-2" });
  assert.equal(changed.status, "degraded");
  assert.equal(changed.events.length, 0);
  store.close();
});

test("zero-to-zero percent delta stays quiet and negative numeric deltas remain comparable", async () => {
  const store = syncedStore();
  const values = [0, 0, -5];
  let index = 0;
  const engine = new ScannerEngine(store, async () => fixture([{ id: "metric", data: { value: values[index++]! } }], new Date().toISOString()));
  const config = monitor([{ id: "move", type: "numeric_delta", field: "value", percent: 10 }]);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "delta-1" })).events.length, 0);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "delta-2" })).events.length, 0);
  assert.equal((await engine.run(config, "ns", { scheduledFor: "delta-3" })).events.length, 1);
  store.close();
});
