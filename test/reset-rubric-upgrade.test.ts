import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradeResetRubric } from "../scripts/upgrade-reset-rubrics.ts";
import { monitorSchema, semanticMonitorHash, type Monitor } from "../src/config/schema.ts";
import { ScannerEngine } from "../src/core/engine.ts";
import { Store } from "../src/store/database.ts";

const at = "2026-10-22T00:00:00.000Z";
const later = "2026-10-22T01:00:00.000Z";
const id = "thsottiaux-codex-reset";
const config = (prompt = "Old rubric", monitorId = id): Monitor => monitorSchema.parse({
  version: 1, id: monitorId, name: "Reset hints", enabled: true, schedule: { every: "5m" },
  source: { type: "x", handle: monitorId === "claudedevs-claude-reset" ? "ClaudeDevs" : "thsottiaux", maxPages: 30 },
  rules: [{ id: "reset-hint", type: "llm_assessment", trigger: "new_item", bootstrap: "suppress_existing", model: "gpt-6.1-sol", reasoningEffort: "xhigh", prompt, ...(monitorId === "claudedevs-claude-reset" ? { product: "claude" } : {}) }],
  notifications: [{ type: "inbox" }],
});
const next = () => config("High-recall rubric");
function rows(store: Store, namespace: string) {
  return store.db.prepare("SELECT item_key,content_hash,data_json,title,url,first_seen_at,last_seen_at,active FROM items WHERE monitor_id=? AND namespace=? ORDER BY item_key").all(id, namespace);
}
function snapshot(store: Store) {
  return JSON.stringify(["monitors", "namespaces", "items", "rule_state", "runs", "events", "deliveries", "observations"].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}
function seeded() {
  const store = new Store(":memory:");
  const previous = config();
  const namespace = semanticMonitorHash(previous);
  store.syncMonitor(previous, JSON.stringify(previous), namespace, at);
  for (const [key, when] of [["x:10", at], ["x:20", later]] as const) {
    const run = store.beginRun(id, namespace, key, when, at);
    store.acceptItems(run.id, id, namespace, [{ id: key, hash: `raw-${key}`, title: "Å\n title", url: `https://x.com/thsottiaux/status/${key.slice(2)}`, data: { text: "ＡＩ\n\nraw", context: "Frozen parent" } }], when);
    store.setRuleState(id, namespace, "reset-hint", key, { status: "assessed", suggestive: false, reason: "Old negative" }, when);
    store.finishRun(run.id, run.token, id, "ok_unchanged", when, 1, 0);
  }
  return { store, namespace };
}

test("rubric upgrade preserves exact accepted history and cutoff without copying judgments", () => {
  const { store, namespace } = seeded();
  try {
    const before = rows(store, namespace);
    const cutoff = store.bootstrapItemIds(id, namespace);
    const judgments = store.db.prepare("SELECT * FROM rule_state WHERE namespace=? ORDER BY item_key").all(namespace);
    const source = store.db.prepare("SELECT initialized,accepted_at FROM namespaces WHERE monitor_id=? AND namespace=?").get(id, namespace);
    const target = semanticMonitorHash(next());
    assert.equal(upgradeResetRubric(store, next()), "upgraded");
    assert.deepEqual(rows(store, target), before);
    assert.deepEqual(rows(store, namespace), before);
    assert.deepEqual(store.db.prepare("SELECT * FROM rule_state WHERE namespace=? ORDER BY item_key").all(namespace), judgments);
    assert.deepEqual(store.bootstrapItemIds(id, target), cutoff);
    assert.deepEqual(store.db.prepare("SELECT initialized,accepted_at FROM namespaces WHERE monitor_id=? AND namespace=?").get(id, target), source);
    assert.equal(store.ruleState(id, target, "reset-hint", "x:10"), undefined);
    assert.equal(store.ruleState(id, namespace, "reset-hint", "x:10")?.["reason"], "Old negative");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM rule_state WHERE namespace=?").get(target)?.["n"], 0);
    assert.equal(store.events().length, 0);
    const state = snapshot(store);
    assert.equal(upgradeResetRubric(store, next()), "unchanged");
    assert.equal(snapshot(store), state);
  } finally { store.close(); }
});

test("rubric upgrade rejects non-prompt config changes and untrusted monitor IDs without mutation", () => {
  const changes: Array<(value: Monitor) => Monitor> = [
    value => ({ ...value, enabled: false }),
    value => ({ ...value, name: "Changed" }),
    value => ({ ...value, schedule: { every: "10m" } }),
    value => ({ ...value, source: { type: "x", handle: "other", maxPages: 30 } }),
    value => ({ ...value, notifications: [] }),
    value => ({ ...value, assertions: { minItems: 2 } }),
    value => ({ ...value, rules: value.rules.map(rule => ({ ...rule, trigger: "new_or_changed" })) } as Monitor),
    value => ({ ...value, rules: value.rules.map(rule => ({ ...rule, product: "claude" })) } as Monitor),
    value => ({ ...value, rules: [...value.rules, { id: "other", type: "new_items", bootstrap: "suppress_existing" }] }),
  ];
  for (const change of changes) {
    const { store } = seeded();
    try {
      const before = snapshot(store);
      assert.throws(() => upgradeResetRubric(store, change(next())), /prompt|strict-new/);
      assert.equal(snapshot(store), before);
    } finally { store.close(); }
  }
  const store = new Store(":memory:");
  try { assert.throws(() => upgradeResetRubric(store, config("New", "other")), /shipped reset/); }
  finally { store.close(); }
});

test("rubric upgrade rejects active scans, stale namespaces, missing baselines and occupied targets", () => {
  for (const mode of ["active", "stale", "uninitialized", "target-initialized", "target-item", "target-judgment"] as const) {
    const { store, namespace } = seeded();
    try {
      const target = semanticMonitorHash(next());
      if (mode === "active") store.beginRun(id, namespace, "pending", later, at);
      if (mode === "stale") store.db.prepare("UPDATE monitors SET namespace='stale' WHERE id=?").run(id);
      if (mode === "uninitialized") store.db.prepare("UPDATE namespaces SET initialized=0 WHERE monitor_id=? AND namespace=?").run(id, namespace);
      if (mode.startsWith("target")) {
        store.db.prepare("INSERT INTO namespaces(monitor_id,namespace,initialized) VALUES(?,?,?)").run(id, target, mode === "target-initialized" ? 1 : 0);
        if (mode === "target-item") store.db.prepare("INSERT INTO items SELECT monitor_id,?,item_key,content_hash,data_json,title,url,first_seen_at,last_seen_at,active FROM items WHERE namespace=?").run(target, namespace);
        if (mode === "target-judgment") store.setRuleState(id, target, "reset-hint", "unaccepted", { status: "suppressed" }, at);
      }
      const before = snapshot(store);
      assert.throws(() => upgradeResetRubric(store, next()), /active scan|namespace|baseline|target/);
      assert.equal(snapshot(store), before);
    } finally { store.close(); }
  }
});

test("rubric upgrade permits an empty uninitialized target and fences a previous monitor claim", () => {
  const { store, namespace } = seeded();
  try {
    const target = semanticMonitorHash(next());
    store.db.prepare("INSERT INTO namespaces(monitor_id,namespace,initialized) VALUES(?,?,0)").run(id, target);
    const claim = store.claimMonitor(id, later, "2026-10-22T02:00:00.000Z")!;
    assert.equal(upgradeResetRubric(store, next()), "upgraded");
    assert.deepEqual(rows(store, target), rows(store, namespace));
    assert.throws(() => store.assertMonitorLease(id, claim.leaseToken), { code: "SSS_LEASE_LOST" });
  } finally { store.close(); }
});

test("after rubric upgrade accepted IDs stay quiet while posts arriving during deployment assess", async () => {
  const { store } = seeded();
  try {
    const monitor = next();
    const target = semanticMonitorHash(monitor);
    upgradeResetRubric(store, monitor);
    const assessed: string[] = [];
    const engine = new ScannerEngine(store, async (_source, context) => {
      assert.deepEqual(context?.bootstrapItemIds, ["x:10"]);
      return { fetchedAt: later, items: [...context!.previousItems, { id: "x:30", data: { text: "New reset announcement" } }] };
    }, () => new Date(later), async item => {
      assessed.push(item.id);
      return { suggestive: true, reason: "Plausible allowance reset", evidence: ["New reset announcement"] };
    });
    const result = await engine.run(monitor, target, { scheduledFor: "after-upgrade" });
    assert.equal(result.status, "ok_changed");
    assert.deepEqual(assessed, ["x:30"]);
    assert.deepEqual(result.events.map(event => event.itemId), ["x:30"]);
    const state = snapshot(store);
    assert.equal(upgradeResetRubric(store, monitor), "unchanged");
    assert.equal(snapshot(store), state);
  } finally { store.close(); }
});


test("rubric upgrade supports the Claude monitor without changing its product scope", () => {
  const store = new Store(":memory:");
  try {
    const monitorId = "claudedevs-claude-reset";
    const previous = config("Old Claude rubric", monitorId);
    const namespace = semanticMonitorHash(previous);
    store.syncMonitor(previous, JSON.stringify(previous), namespace, at);
    const run = store.beginRun(monitorId, namespace, "prime", at, at);
    store.acceptItems(run.id, monitorId, namespace, [{ id: "x:10", hash: "raw", data: { text: "Claude original" } }], at);
    store.finishRun(run.id, run.token, monitorId, "ok_unchanged", at, 1, 0);
    const next = config("High-recall Claude rubric", monitorId);
    assert.equal(upgradeResetRubric(store, next), "upgraded");
    assert.deepEqual(store.existingItems(monitorId, semanticMonitorHash(next)), store.existingItems(monitorId, namespace));
    assert.equal(store.initialized(monitorId, semanticMonitorHash(next)), true);
  } finally { store.close(); }
});

test("rubric upgrade rejects missing or non-strict-new sources without changing state", () => {
  const store = new Store(":memory:");
  try {
    const empty = snapshot(store);
    assert.throws(() => upgradeResetRubric(store, next()), /baseline/);
    assert.equal(snapshot(store), empty);
    const legacy = monitorSchema.parse({ ...config(), rules: [{ ...config().rules[0], trigger: "new_or_changed" }] });
    const namespace = semanticMonitorHash(legacy);
    store.syncMonitor(legacy, JSON.stringify(legacy), namespace, at);
    const before = snapshot(store);
    assert.throws(() => upgradeResetRubric(store, next()), /strict-new/);
    assert.equal(snapshot(store), before);
  } finally { store.close(); }
});
