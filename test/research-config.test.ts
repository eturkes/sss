import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { parseMonitor } from "../src/config/load.ts";
import { monitorSchema, semanticMonitorHash } from "../src/config/schema.ts";
import { ScannerEngine } from "../src/core/engine.ts";
import type { ScanItem } from "../src/core/types.ts";
import { Store } from "../src/store/database.ts";

const now = () => new Date("2026-10-23T01:02:03.000Z");
const config = {
  version: 1, id: "research", name: "Research", enabled: true, schedule: { every: "6h" },
  source: { type: "arxiv", query: "all:agents" }, assertions: { allowEmpty: true },
  rules: [{ id: "match", type: "llm_assessment", trigger: "new_item", mode: "semantic", target: "Coding agent evaluation", model: "gpt-6.1-sol", reasoningEffort: "xhigh", prompt: "Match evaluations of coding agents." }],
};

test("semantic assessment schema requires trusted target and isolates classifications from reset judgments", () => {
  const parsed = monitorSchema.parse(config);
  assert.equal(parsed.rules[0]?.type, "llm_assessment");
  assert.notEqual(semanticMonitorHash(config), semanticMonitorHash({ ...config, rules: [{ ...config.rules[0], target: "Biology" }] }));
  for (const rule of [{ ...config.rules[0], target: undefined }, { ...config.rules[0], product: "codex" }, { ...config.rules[0], mode: undefined }]) {
    assert.equal(monitorSchema.safeParse({ ...config, rules: [rule] }).success, false);
  }
  const legacy = { ...config, rules: [{ id: "reset", type: "llm_assessment", model: "gpt-6.1-sol", reasoningEffort: "xhigh", prompt: "Assess reset hints." }] };
  assert.equal(semanticMonitorHash(legacy), semanticMonitorHash({ ...legacy, rules: [{ ...legacy.rules[0], product: "codex" }] }));
});

test("research examples parse as disabled semantic-only alert gates", async () => {
  for (const name of ["research-arxiv", "research-crossref"]) {
    const monitor = parseMonitor(parseYaml(await readFile(new URL(`../examples/${name}.yaml`, import.meta.url), "utf8")));
    assert.equal(monitor.enabled, false);
    assert.equal(monitor.rules.length, 1);
    assert.equal(monitor.rules[0]?.type, "llm_assessment");
    assert.equal(monitor.rules[0]?.type === "llm_assessment" && monitor.rules[0].mode, "semantic");
  }
});

test("a semantic-only rule gates events, caches rejected candidates, and preserves its baseline on failure", async context => {
  const monitor = monitorSchema.parse(config);
  const namespace = semanticMonitorHash(monitor);
  const store = new Store(":memory:");
  context.after(() => { store.close(); });
  store.syncMonitor(monitor, JSON.stringify(monitor), namespace, now().toISOString());
  let items: ScanItem[] = [];
  let fail = false;
  const seen: string[] = [];
  const engine = new ScannerEngine(store, async () => ({ items, fetchedAt: now().toISOString() }), now, async item => {
    seen.push(item.id);
    if (fail) throw new Error("classification unavailable");
    const suggestive = item.data["abstract"] === "Coding agent evaluation";
    return { suggestive, reason: suggestive ? "The observed abstract matches the rubric." : "The abstract does not match.", evidence: suggestive ? ["Coding agent evaluation"] : [] };
  });
  assert.equal((await engine.run(monitor, namespace, { scheduledFor: "prime" })).status, "ok_unchanged");
  items = [{ id: "arxiv:2610.00001", data: { abstract: "Coding agent evaluation" } }, { id: "arxiv:2610.00002", data: { abstract: "Unrelated biology" } }];
  const result = await engine.run(monitor, namespace, { scheduledFor: "arrivals" });
  assert.deepEqual(result.events.map(event => [event.kind, event.itemId]), [["llm_assessment", "arxiv:2610.00001"]]);
  assert.equal((await engine.run(monitor, namespace, { scheduledFor: "same" })).events.length, 0);
  assert.deepEqual(seen, ["arxiv:2610.00001", "arxiv:2610.00002"]);
  assert.equal(store.ruleState(monitor.id, namespace, "match", "arxiv:2610.00002")?.["suggestive"], false);
  fail = true;
  items = [...items, { id: "arxiv:2610.00003", data: { abstract: "Coding agent evaluation" } }];
  assert.equal((await engine.run(monitor, namespace, { scheduledFor: "failure" })).status, "degraded");
  assert.equal(store.existingItems(monitor.id, namespace).size, 2);
  assert.equal(store.ruleState(monitor.id, namespace, "match", "arxiv:2610.00003"), undefined);
  assert.equal(store.events().length, 1);
});
