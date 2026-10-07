import assert from "node:assert/strict";
import { test } from "node:test";

import { Store } from "../src/store/database.ts";

const at = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T01:00:00.000Z";
const config = { id: "watch", name: "Watch", enabled: true };

function acceptedStore(): Store {
  const store = new Store(":memory:");
  store.syncMonitor(config, "old-config", "old", at);
  const first = store.beginRun("watch", "old", "first", at, at);
  store.acceptItems(first.id, "watch", "old", [{ id: "x:10", hash: "original-hash", title: "Original", url: "https://x.com/thsottiaux/status/10", data: { text: "Å\n\nraw", context: "ＡＩ\nparent" } }], at);
  store.setRuleState("watch", "old", "hint", "x:10", { status: "suppressed", revision: "original-hash" }, at);
  store.finishRun(first.id, first.token, "watch", "ok_unchanged", at, 1, 0);
  const second = store.beginRun("watch", "old", "second", later, at);
  store.acceptItems(second.id, "watch", "old", [{ id: "x:20", hash: "later-hash", title: "Later", url: "https://x.com/thsottiaux/status/20", data: { text: "Later post" } }], later);
  store.setRuleState("watch", "old", "hint", "x:20", { status: "assessed", suggestive: true, revision: "later-hash" }, later);
  store.insertEvent({ id: "old-event", monitorId: "watch", runId: second.id, namespace: "old", ruleId: "hint", kind: "llm_assessment", itemId: "x:20", reason: "Old judgment", before: undefined, after: {}, observedAt: later }, [{ channel: "email:old", config: {} }]);
  store.finishRun(second.id, second.token, "watch", "ok_changed", later, 1, 1);
  return store;
}

function items(store: Store, namespace: string) {
  return store.db.prepare("SELECT item_key,content_hash,data_json,title,url,first_seen_at,last_seen_at,active FROM items WHERE namespace=? ORDER BY item_key").all(namespace);
}

test("strict-new transition inherits exact acquisition history without judgments or notifications", () => {
  const store = acceptedStore();
  try {
    const previous = items(store, "old");
    const namespace = store.db.prepare("SELECT initialized,accepted_at FROM namespaces WHERE namespace='old'").get();
    store.syncMonitor(config, "new-config", "new", later, { namespace: "old", configJson: "old-config" });
    assert.deepEqual(items(store, "new"), previous);
    assert.deepEqual(items(store, "old"), previous);
    assert.deepEqual(store.bootstrapItemIds("watch", "new"), ["x:10"]);
    assert.deepEqual(store.db.prepare("SELECT initialized,accepted_at FROM namespaces WHERE namespace='new'").get(), namespace);
    assert.equal(store.ruleState("watch", "new", "hint", "x:10"), undefined);
    assert.equal(store.ruleState("watch", "new", "hint", "x:20"), undefined);
    assert.equal(store.ruleState("watch", "old", "hint", "x:20")?.["suggestive"], true);
    assert.deepEqual(store.events().map(event => event.namespace), ["old"]);
    assert.equal(store.deliveryHealth().pending, 1);
    assert.equal(store.observations("watch").every(observation => observation.namespace === "old"), true);
    store.syncMonitor(config, "new-config", "new", later);
    assert.deepEqual(items(store, "new"), previous);
  } finally { store.close(); }
});

test("strict-new transition rejects a stale source config and an active scan before changing state", () => {
  const store = acceptedStore();
  try {
    assert.throws(() => store.syncMonitor(config, "new-config", "new", later, { namespace: "old", configJson: "stale-config" }), { code: "SSS_LEASE_LOST" });
    assert.deepEqual(store.monitor("watch"), { namespace: "old", configJson: "old-config" });
    assert.equal(store.initialized("watch", "new"), false);
    const pending = store.beginRun("watch", "old", "pending", later, at);
    assert.throws(() => store.syncMonitor(config, "new-config", "new", later, { namespace: "old", configJson: "old-config" }), /active scan/);
    assert.deepEqual(store.monitor("watch"), { namespace: "old", configJson: "old-config" });
    store.assertRunLease(pending.id, pending.token);
    store.finishRun(pending.id, pending.token, "watch", "ok_unchanged", later, 0, 0);
    const claim = store.claimMonitor("watch", later, "2026-01-01T02:00:00.000Z")!;
    store.syncMonitor(config, "new-config", "new", later, { namespace: "old", configJson: "old-config" });
    assert.throws(() => store.assertMonitorLease("watch", claim.leaseToken), { code: "SSS_LEASE_LOST" });
  } finally { store.close(); }
});

test("strict-new transition leaves initialized targets intact and rolls back copy failures", () => {
  const store = acceptedStore();
  try {
    store.db.exec("CREATE TRIGGER reject_transfer BEFORE INSERT ON items WHEN NEW.namespace='new' BEGIN SELECT RAISE(ABORT,'copy rejected'); END");
    assert.throws(() => store.syncMonitor(config, "new-config", "new", later, { namespace: "old", configJson: "old-config" }), /copy rejected/);
    assert.deepEqual(store.monitor("watch"), { namespace: "old", configJson: "old-config" });
    assert.equal(store.db.prepare("SELECT 1 FROM namespaces WHERE namespace='new'").get(), undefined);
    store.db.exec("DROP TRIGGER reject_transfer");
    store.db.prepare("INSERT INTO namespaces(monitor_id,namespace,initialized,accepted_at) VALUES('watch','new',1,?)").run(at);
    store.syncMonitor(config, "new-config", "new", later, { namespace: "old", configJson: "old-config" });
    assert.equal(items(store, "new").length, 0);
    assert.equal(store.db.prepare("SELECT accepted_at FROM namespaces WHERE namespace='new'").get()?.["accepted_at"], at);
  } finally { store.close(); }
});

test("strict-new transition preserves initialized-empty and absent acquisition baselines", () => {
  for (const initialized of [false, true]) {
    const store = new Store(":memory:");
    try {
      store.syncMonitor(config, "old-config", "old", at);
      if (initialized) {
        const run = store.beginRun("watch", "old", "empty", at, at);
        store.acceptItems(run.id, "watch", "old", [], at);
        store.finishRun(run.id, run.token, "watch", "ok_unchanged", at, 0, 0);
      }
      store.syncMonitor(config, "new-config", "new", later, { namespace: "old", configJson: "old-config" });
      assert.equal(store.initialized("watch", "new"), initialized);
      assert.equal(items(store, "new").length, 0);
    } finally { store.close(); }
  }
});
