import assert from "node:assert/strict";
import { test } from "node:test";
import { ScannerEngine } from "../src/core/engine.ts";
import type { ScanItem } from "../src/core/types.ts";
import { Store } from "../src/store/database.ts";

const at = "2026-11-16T10:00:00Z";
const item = (revision: number): ScanItem => ({ id: "thread:one", title: "An unrelated topic", data: { revision, summary: `discussion ${revision}` } });
const config = (bootstrap = "evaluate_current") => ({ version: 1, id: "watch", name: "Watch", enabled: true, schedule: { every: "1h" },
  source: { type: "json", url: "https://example.test", fields: { text: "text" } }, assertions: { allowEmpty: true },
  rules: [{ id: "discussion", type: "llm_assessment", mode: "semantic", target: "Substantial formal-verification discussion", trigger: "until_match", bootstrap, model: "gpt-6.1-terra", reasoningEffort: "medium", prompt: "Assess all comments, not just titles." }], notifications: [{ type: "inbox" }] });
function db() { const s = new Store(":memory:"); s.syncMonitor({ id: "watch", name: "Watch", enabled: true }, "{}", "ns", at); return s; }
const judgment = (suggestive: boolean) => ({ suggestive, reason: suggestive ? "Substantial discussion." : "Not yet substantial.", evidence: suggestive ? ["discussion"] : [] });

test("until-match revisits changed negatives but emits once per identity across edits and reappearance", async () => {
  const store = db();
  try {
    let items = [item(0)]; let calls = 0;
    const engine = new ScannerEngine(store, async () => ({ items, fetchedAt: at }), () => new Date(at), async post => { calls++; return judgment(Number(post.data["revision"]) >= 2); });
    const monitor = config() as never;
    assert.equal((await engine.run(monitor, "ns", { scheduledFor: "negative" })).events.length, 0);
    assert.equal((await engine.run(monitor, "ns", { scheduledFor: "unchanged" })).events.length, 0);
    assert.equal(calls, 1);
    items = [item(1)]; await engine.run(monitor, "ns", { scheduledFor: "changed-negative" });
    items = [item(2)]; assert.equal((await engine.run(monitor, "ns", { scheduledFor: "positive" })).events.length, 1);
    items = [item(3)]; assert.equal((await engine.run(monitor, "ns", { scheduledFor: "later-positive" })).events.length, 0);
    items = []; await engine.run(monitor, "ns", { scheduledFor: "absent" });
    items = [item(4)]; assert.equal((await engine.run(monitor, "ns", { scheduledFor: "returned" })).events.length, 0);
    assert.equal(calls, 3);
    assert.equal(store.ruleState("watch", "ns", "discussion", "thread:one")?.["suggestive"], true);
  } finally { store.close(); }
});

test("until-match assesses a changed suppressed baseline and retries an inference failure", async () => {
  const store = db();
  try {
    let items = [item(0)]; let calls = 0; let fail = true;
    const engine = new ScannerEngine(store, async () => ({ items, fetchedAt: at }), () => new Date(at), async () => { calls++; if (fail) throw new Error("inference unavailable"); return judgment(true); });
    const monitor = config("suppress_existing") as never;
    await engine.run(monitor, "ns", { scheduledFor: "prime" });
    await engine.run(monitor, "ns", { scheduledFor: "unchanged-baseline" });
    assert.equal(calls, 0);
    items = [item(1)];
    assert.equal((await engine.run(monitor, "ns", { scheduledFor: "failure" })).status, "degraded");
    assert.equal(store.ruleState("watch", "ns", "discussion", "thread:one")?.["status"], "suppressed");
    fail = false;
    assert.equal((await engine.run(monitor, "ns", { scheduledFor: "retry" })).events.filter(e => e.kind === "llm_assessment").length, 1);
    items = [item(2)];
    assert.equal((await engine.run(monitor, "ns", { scheduledFor: "after-match" })).events.length, 0);
    assert.equal(calls, 2);
  } finally { store.close(); }
});

test("until-match at-most-one alert invariant holds across generated revision/membership sequences", async () => {
  let seed = 14717;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let run = 0; run < 20; run++) {
    const store = db();
    try {
      let items: ScanItem[] = []; let calls = 0; let matched = false; let lastRevision: number | undefined; let expectedCalls = 0; let alerts = 0;
      const engine = new ScannerEngine(store, async () => ({ items, fetchedAt: at }), () => new Date(at), async post => { calls++; return judgment(Number(post.data["revision"]) % 5 === 0); });
      for (let step = 0; step < 30; step++) {
        const revision = random() % 19;
        const present = random() % 4 !== 0;
        items = present ? [item(revision)] : [];
        if (present && !matched && lastRevision !== revision) { expectedCalls++; lastRevision = revision; matched = revision % 5 === 0; }
        alerts += (await engine.run(config() as never, "ns", { scheduledFor: `${run}-${step}` })).events.filter(e => e.kind === "llm_assessment").length;
        assert.equal(calls, expectedCalls);
        assert.equal(alerts, Number(matched));
      }
    } finally { store.close(); }
  }
});

for (const type of ["discourse", "hn_discussions", "lobsters", "x_discussions", "reddit_discussions"]) test(`${type} preserves exact accepted discussion text and keeps its baseline on acquisition failure`, async () => {
  const store = db();
  try {
    const summary = "  λ\n\n proof\tＡ <a href='#exact  Unicode'>context</a>  ";
    let fail = false;
    const engine = new ScannerEngine(store, async () => { if (fail) throw new Error("incomplete comments"); return { items: [{ id: "thread:one", data: { summary } }], fetchedAt: at }; }, () => new Date(at), async () => judgment(false));
    const monitor = { ...config("suppress_existing"), source: { type } } as never;
    assert.equal((await engine.run(monitor, "ns", { scheduledFor: "prime" })).status, "ok_unchanged");
    const baseline = store.existingItems("watch", "ns").get("thread:one")!;
    assert.equal(JSON.parse(baseline.data_json)["summary"], summary);
    fail = true;
    assert.equal((await engine.run(monitor, "ns", { scheduledFor: "incomplete" })).status, "degraded");
    assert.deepEqual(store.existingItems("watch", "ns").get("thread:one"), baseline);
  } finally { store.close(); }
});
