import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emailNotificationSchema } from "../src/config/schema.ts";
import type { ChangeEvent } from "../src/core/types.ts";
import * as email from "../src/notifications/email.ts";
import { drainOutbox } from "../src/notifications/outbox.ts";
import { Store } from "../src/store/database.ts";

const start = "2026-10-22T01:00:00.000Z";
const due = "2026-10-23T00:00:00.000Z";
const config = {
  type: "email" as const, to: "reader@example.com", account: "gmail",
  digest: { id: "formal-verification", schedule: { cron: "0 9 * * *", timezone: "Asia/Tokyo" } },
};

function monitor(store: Store, id: string, notification = config): void {
  store.syncMonitor({ id, name: id, enabled: true }, JSON.stringify({ notifications: [notification] }), "ns", start);
}

function event(store: Store, id: string, monitorId = "papers", at = start, notification = config): ChangeEvent {
  const run = store.beginRun(monitorId, "ns", id, at, start);
  const item: ChangeEvent = {
    id, monitorId, runId: run.id, namespace: "ns", ruleId: "new", kind: "new_item", itemId: id,
    title: `Result ${id}`, url: `https://example.com/${id}`, reason: "newly observed by SSS", before: undefined,
    after: { abstract: `Proof details ${id} ${"λ".repeat(3_000)}`, publishedAt: "2026-10-21" }, observedAt: at,
  };
  store.insertEvent(item, [{ channel: "email:daily", config: notification }]);
  store.db.prepare("UPDATE runs SET status='ok_changed' WHERE id=?").run(run.id);
  return item;
}

test("digest schema accepts cron/timezone only and rejects unsafe identities", () => {
  assert.equal(emailNotificationSchema.safeParse(config).success, true);
  for (const digest of [
    { ...config.digest, id: "bad\nBcc" },
    { id: "daily", schedule: { every: "1d" } },
    { id: "daily", schedule: { cron: "bad", timezone: "Asia/Tokyo" } },
  ]) assert.equal(emailNotificationSchema.safeParse({ ...config, digest }).success, false);
});

test("daily digest groups all matching routes, never sends immediately and preserves every event", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  monitor(store, "papers");
  monitor(store, "releases");
  const expected = Array.from({ length: 151 }, (_, index) => event(store, `item-${index}`, index % 2 ? "releases" : "papers"));
  let immediate = 0;
  const sent: email.EmailDigest[] = [];
  const deliverDigest = async (digest: email.EmailDigest) => { sent.push(digest); };
  assert.deepEqual(await drainOutbox(store, new Date(start), async () => { immediate++; }, deliverDigest), { sent: 0, failed: 0 });
  assert.equal(store.claimDeliveries(due, "2026-10-23T00:05:00.000Z").length, 0);
  assert.deepEqual(await drainOutbox(store, new Date(due), async () => { immediate++; }, deliverDigest), { sent: 1, failed: 0 });
  assert.equal(immediate, 0);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.events, expected);
  const wire = email.formatDigestEmail(sent[0]!);
  const body = Buffer.from(wire.split("\r\n\r\n")[1]!, "base64").toString("utf8");
  for (const item of expected) {
    assert.ok(body.includes(item.title!));
    assert.ok(body.includes(item.url!));
    assert.ok(body.includes(String((item.after as { abstract: string }).abstract)));
  }
  assert.ok(body.includes("Source health"));
  assert.ok(body.includes("papers") && body.includes("releases"));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE status='sent'").get()?.["count"], 151);
  assert.deepEqual(await drainOutbox(store, new Date(due), async () => { immediate++; }, deliverDigest), { sent: 0, failed: 0 });
});

test("digest retries freeze membership, content and message identity across restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sss-digest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = new Store(join(directory, "state.db"));
  monitor(store, "papers");
  const first = event(store, "first");
  await drainOutbox(store, new Date(start), async () => { throw new Error("immediate digest delivery"); }, async () => {});
  const attempted: email.EmailDigest[] = [];
  assert.deepEqual(await drainOutbox(store, new Date(due), async () => {}, async (digest) => {
    attempted.push(digest);
    throw new Error("token=secret retry me");
  }), { sent: 0, failed: 1 });
  assert.equal(store.db.prepare("SELECT status FROM deliveries WHERE event_id='first'").get()?.["status"], "failed");
  event(store, "later", "papers", "2026-10-23T00:00:01.000Z");
  store.db.prepare("UPDATE events SET after_json='{}',title='changed' WHERE id='first'").run();
  store.prune("2027-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
  assert.ok(store.event("later"));
  store.close();
  store = new Store(join(directory, "state.db"));
  t.after(() => store.close());
  assert.deepEqual(await drainOutbox(store, new Date("2026-10-23T00:00:30.000Z"), async () => {}, async (digest) => { attempted.push(digest); }), { sent: 1, failed: 0 });
  assert.deepEqual(attempted[0], attempted[1]);
  assert.deepEqual(attempted[1]!.events, [first]);
  assert.equal(email.formatDigestEmail(attempted[0]!), email.formatDigestEmail(attempted[1]!));
  const following: email.EmailDigest[] = [];
  await drainOutbox(store, new Date("2026-10-24T00:00:00.000Z"), async () => {}, async (digest) => { following.push(digest); });
  assert.deepEqual(following[0]!.events.map(item => item.id), ["later"]);
});

test("digest leases fence stale workers and reclaimed batches keep their original snapshot", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  monitor(store, "papers");
  event(store, "first");
  store.syncEmailDigests(start);
  const first = store.claimEmailDigests(due, "2026-10-23T00:01:00.000Z")[0]!;
  assert.ok(first);
  assert.equal(store.claimEmailDigests("2026-10-23T00:00:01.000Z", "2026-10-23T00:02:00.000Z").length, 0);
  store.db.prepare("DELETE FROM events WHERE id='first'").run();
  const successor = store.claimEmailDigests("2026-10-23T00:01:01.000Z", "2026-10-23T00:02:00.000Z")[0]!;
  assert.equal(first.id, successor.id);
  assert.notEqual(first.leaseToken, successor.leaseToken);
  assert.deepEqual(first.events, successor.events);
  assert.equal(store.finishEmailDigest(first.id, first.leaseToken, due), false);
  assert.equal(store.failEmailDigest(first.id, first.leaseToken, "late", due), false);
  assert.equal(store.finishEmailDigest(successor.id, successor.leaseToken, due), true);
});

test("route changes isolate queued recipients, and daily empty digests expose source health", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  monitor(store, "papers");
  event(store, "old-recipient");
  await drainOutbox(store, new Date(start), async () => {}, async () => {});
  const changed = { ...config, to: "other@example.com" };
  monitor(store, "papers", changed);
  event(store, "new-recipient", "papers", "2026-10-22T02:00:00.000Z", changed);
  await drainOutbox(store, new Date("2026-10-22T02:00:00.000Z"), async () => {}, async () => {});
  const sent: email.EmailDigest[] = [];
  for (let index = 0; index < 2; index++) await drainOutbox(store, new Date(due), async () => {}, async digest => { sent.push(digest); });
  assert.deepEqual(sent.map(digest => [digest.config.to, digest.events.map(item => item.id)]).sort(), [
    ["other@example.com", ["new-recipient"]], ["reader@example.com", ["old-recipient"]],
  ]);
  store.db.prepare("UPDATE monitors SET error_streak=2,last_error='source unavailable' WHERE id='papers'").run();
  assert.deepEqual(await drainOutbox(store, new Date("2026-10-24T00:00:00.000Z"), async () => {}, async () => { throw new Error("empty digest failed"); }), { sent: 0, failed: 1 });
  assert.equal(store.deliveryHealth().failed, 1);
  assert.match(store.deliveryHealth().lastError ?? "", /empty digest failed/);
  assert.equal(store.failedDeliveries().length, 1);
  await drainOutbox(store, new Date("2026-10-24T00:00:30.000Z"), async () => {}, async digest => { sent.push(digest); });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2]!.events, []);
  const body = Buffer.from(email.formatDigestEmail(sent[2]!).split("\r\n\r\n")[1]!, "base64").toString("utf8");
  assert.match(body, /No new observations/);
  assert.match(body, /source unavailable/);
  assert.equal(store.deliveryHealth().failed, 0);
});
