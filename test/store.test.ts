import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeEvent } from "../src/core/types.ts";
import { drainOutbox } from "../src/notifications/outbox.ts";
import { Store } from "../src/store/database.ts";

test("outbox reclaims a sending delivery after its lease expires", () => {
  const store = new Store(":memory:");
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, JSON.stringify({ schedule: { every: "1h" } }), "ns", "2026-01-01T00:00:00.000Z");
  const runId = store.beginRun("watch", "ns", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2025-12-31T23:50:00.000Z").id;
  const event: ChangeEvent = {
    id: "event", monitorId: "watch", runId, namespace: "ns", ruleId: "new", kind: "new_item", itemId: "item",
    reason: "newly observed by SSS", before: undefined, after: { value: 1 }, observedAt: "2026-01-01T00:00:00.000Z",
  };
  store.insertEvent(event, [{ channel: "webhook:0", config: { type: "webhook", url: "https://example.com/hook" } }]);
  assert.deepEqual(store.claimDeliveries("2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z").map((row) => row.id), ["event:webhook:0"]);
  assert.equal(store.claimDeliveries("2026-01-01T00:00:30.000Z", "2026-01-01T00:01:30.000Z").length, 0);
  assert.deepEqual(store.claimDeliveries("2026-01-01T00:01:01.000Z", "2026-01-01T00:02:01.000Z").map((row) => row.id), ["event:webhook:0"]);
  store.close();
});

test("outbox retries and completes against the caller's clock", async () => {
  const store = new Store(":memory:");
  const at = new Date("2026-01-01T00:00:00.000Z");
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, JSON.stringify({ schedule: { every: "1h" } }), "ns", at.toISOString());
  const runId = store.beginRun("watch", "ns", at.toISOString(), at.toISOString(), "2025-12-31T23:50:00.000Z").id;
  const event: ChangeEvent = {
    id: "retry-event", monitorId: "watch", runId, namespace: "ns", ruleId: "new", kind: "new_item", itemId: "item",
    reason: "newly observed by SSS", before: undefined, after: { value: 1 }, observedAt: at.toISOString(),
  };
  store.insertEvent(event, [{ channel: "webhook:0", config: { type: "webhook", url: "https://example.com/hook" } }]);

  assert.deepEqual(await drainOutbox(store, at, async () => { throw new Error("token=private-value"); }), { sent: 0, failed: 1 });
  const failed = store.db.prepare("SELECT status,attempts,next_attempt_at,last_error FROM deliveries WHERE id=?").get("retry-event:webhook:0") as Record<string, unknown>;
  assert.deepEqual({ status: failed["status"], attempts: failed["attempts"], next: failed["next_attempt_at"] }, {
    status: "failed", attempts: 1, next: "2026-01-01T00:00:30.000Z",
  });
  assert.equal(String(failed["last_error"]).includes("private-value"), false);

  const retryAt = new Date("2026-01-01T00:00:30.000Z");
  assert.deepEqual(await drainOutbox(store, retryAt, async () => {}), { sent: 1, failed: 0 });
  const sent = store.db.prepare("SELECT status,sent_at FROM deliveries WHERE id=?").get("retry-event:webhook:0") as Record<string, unknown>;
  assert.deepEqual({ status: sent["status"], sentAt: sent["sent_at"] }, { status: "sent", sentAt: retryAt.toISOString() });
  store.close();
});

test("one running attempt per monitor; stale takeover rotates its fencing token", () => {
  const store = new Store(":memory:");
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, JSON.stringify({ schedule: { every: "1h" } }), "ns", "2026-01-01T00:00:00.000Z");
  const first = store.beginRun("watch", "ns", "due", "2026-01-01T00:00:00.000Z", "2025-12-31T23:50:00.000Z");
  assert.throws(() => store.beginRun("watch", "ns", "other-due", "2026-01-01T00:00:01.000Z", "2025-12-31T23:50:01.000Z"), /UNIQUE constraint/);
  const second = store.beginRun("watch", "ns", "due", "2026-01-01T00:20:00.000Z", "2026-01-01T00:10:00.000Z");
  assert.equal(second.id, first.id);
  assert.notEqual(second.token, first.token);
  assert.throws(() => store.assertRunLease(first.id, first.token), { code: "SSS_LEASE_LOST" });
  store.assertRunLease(second.id, second.token);
  store.close();
});

test("stale monitor and delivery workers cannot overwrite newer owners", () => {
  const store = new Store(":memory:");
  store.syncMonitor({ id: "watch", name: "Watch", enabled: true }, JSON.stringify({ schedule: { every: "1h" } }), "ns", "2026-01-01T00:00:00.000Z");
  const firstClaim = store.claimMonitor("watch", "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z")!;
  const secondClaim = store.claimMonitor("watch", "2026-01-01T00:01:01.000Z", "2026-01-01T00:02:01.000Z")!;
  assert.equal(store.completeClaim("watch", "2026-01-01T03:00:00.000Z", firstClaim.leaseToken), false);
  assert.equal(store.completeClaim("watch", "2026-01-01T02:00:00.000Z", secondClaim.leaseToken), true);
  assert.equal(store.status()[0]?.nextDueAt, "2026-01-01T02:00:00.000Z");

  const run = store.beginRun("watch", "ns", "delivery", "2026-01-01T00:00:00.000Z", "2025-12-31T23:50:00.000Z");
  const event: ChangeEvent = {
    id: "fenced-event", monitorId: "watch", runId: run.id, namespace: "ns", ruleId: "new", kind: "new_item", itemId: "item",
    reason: "newly observed by SSS", before: undefined, after: { value: 1 }, observedAt: "2026-01-01T00:00:00.000Z",
  };
  store.insertEvent(event, [{ channel: "webhook:0", config: { type: "webhook", url: "https://example.com/hook" } }]);
  const firstDelivery = store.claimDeliveries("2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z")[0]!;
  const secondDelivery = store.claimDeliveries("2026-01-01T00:01:01.000Z", "2026-01-01T00:02:01.000Z")[0]!;
  assert.equal(store.finishDelivery(secondDelivery.id, secondDelivery.leaseToken, "2026-01-01T00:01:02.000Z"), true);
  assert.equal(store.failDelivery(firstDelivery.id, firstDelivery.leaseToken, "late failure", "2026-01-01T00:02:00.000Z"), false);
  const delivery = store.db.prepare("SELECT status,last_error FROM deliveries WHERE id=?").get(firstDelivery.id) as Record<string, unknown>;
  assert.deepEqual({ status: delivery["status"], error: delivery["last_error"] }, { status: "sent", error: null });
  store.close();
});

test("sync preserves next due for presentation changes and resets it for schedule changes", () => {
  const store = new Store(":memory:");
  store.syncMonitor({ id: "watch", name: "One", enabled: true }, JSON.stringify({ schedule: { every: "1h" } }), "ns", "2026-01-01T01:00:00.000Z");
  store.syncMonitor({ id: "watch", name: "Two", enabled: true }, JSON.stringify({ schedule: { every: "1h" } }), "ns", "2026-01-01T02:00:00.000Z");
  assert.equal(store.status()[0]!.nextDueAt, "2026-01-01T01:00:00.000Z");
  store.syncMonitor({ id: "watch", name: "Two", enabled: true }, JSON.stringify({ schedule: { every: "2h" } }), "ns", "2026-01-01T03:00:00.000Z");
  assert.equal(store.status()[0]!.nextDueAt, "2026-01-01T03:00:00.000Z");
  store.close();
});

test("config edits invalidate an in-flight monitor claim", () => {
  const store = new Store(":memory:");
  const firstConfig = JSON.stringify({ schedule: { every: "1h" }, name: "First" });
  store.syncMonitor({ id: "watch", name: "First", enabled: true }, firstConfig, "ns", "2026-01-01T00:00:00.000Z");
  const claim = store.claimMonitor("watch", "2026-01-01T00:00:00.000Z", "2026-01-01T00:10:00.000Z")!;
  store.syncMonitor({ id: "watch", name: "Second", enabled: true }, JSON.stringify({ schedule: { every: "24h" }, name: "Second" }), "ns-2", "2026-01-02T00:00:00.000Z");
  assert.throws(() => store.assertMonitorLease("watch", claim.leaseToken), { code: "SSS_LEASE_LOST" });
  assert.equal(store.completeClaim("watch", "2026-01-01T01:00:00.000Z", claim.leaseToken), false);
  assert.equal(store.status()[0]?.nextDueAt, "2026-01-02T00:00:00.000Z");
  store.close();
});
