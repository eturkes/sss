import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runtime } from "../src/app/runtime.ts";
import { monitorSchema, semanticMonitorHash } from "../src/config/schema.ts";
import type { Collector } from "../src/core/engine.ts";

test("dry-run runtime leaves an existing state file byte-identical", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sss-runtime-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const monitorsDir = join(root, "monitors");
  const stateDir = join(root, "state");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(monitorsDir), mkdir(stateDir)]));
  const sentinel = join(stateDir, "sss.db");
  await writeFile(sentinel, Buffer.from("persistent-state-sentinel"));
  await writeFile(join(monitorsDir, "watch.yaml"), `version: 1\nid: watch\nname: Watch\nenabled: true\nschedule: { every: 1h }\nsource:\n  type: html\n  url: https://example.com\n  fields:\n    value: {}\nrules:\n  - { id: changed, type: field_changed, field: value }\n`);
  const before = await readFile(sentinel);
  const runtime = new Runtime({ stateDir, monitorsDir, ephemeral: true, collector: async () => ({ items: [{ id: "source", data: { value: "ok" } }], fetchedAt: "2026-01-01T00:00:00.000Z" }) });
  try {
    const result = await runtime.run("watch", true);
    assert.equal(result.dryRun, true);
  } finally { runtime.close(); }
  assert.deepEqual(await readFile(sentinel), before);
});

const transitionAt = "2026-01-01T00:00:00.000Z";
const transitionConfig = {
  version: 1, id: "watch", name: "Watch", enabled: true, schedule: { every: "5m" },
  source: { type: "x", handle: "thsottiaux", maxPages: 30 },
  rules: [{ id: "hint", type: "llm_assessment", model: "gpt-6.1-sol", reasoningEffort: "xhigh", prompt: "Assess incoming usage-reset hints." }],
};

async function transitionRuntime(context: { after: (cleanup: () => Promise<void>) => void }, collector?: Collector) {
  const root = await mkdtemp(join(tmpdir(), "sss-runtime-transition-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const runtime = new Runtime({ stateDir: join(root, "state"), monitorsDir: join(root, "monitors"), ephemeral: true, now: () => new Date(transitionAt), ...(collector ? { collector } : {}) });
  await runtime.init();
  const old = monitorSchema.parse(transitionConfig);
  const namespace = semanticMonitorHash(old);
  runtime.store.syncMonitor(old, JSON.stringify(old), namespace, transitionAt);
  const run = runtime.store.beginRun(old.id, namespace, "baseline", transitionAt, transitionAt);
  runtime.store.acceptItems(run.id, old.id, namespace, [{ id: "x:10", hash: "raw-hash", data: { text: "Å\n\nraw", author: "thsottiaux" } }], transitionAt);
  runtime.store.setRuleState(old.id, namespace, "hint", "x:10", { revision: "raw-hash", status: "suppressed" }, transitionAt);
  runtime.store.finishRun(run.id, run.token, old.id, "ok_unchanged", transitionAt, 1, 0);
  return { runtime, namespace, file: join(runtime.monitorsDir, "watch.yaml") };
}

test("runtime inherits accepted X identities when assessment only narrows to new items", async (context) => {
  const { runtime, namespace, file } = await transitionRuntime(context);
  try {
    await writeFile(file, JSON.stringify({ ...transitionConfig, rules: [{ ...transitionConfig.rules[0], trigger: "new_item" }] }));
    const [changed] = await runtime.sync();
    const target = semanticMonitorHash(changed);
    assert.notEqual(target, namespace);
    assert.equal(runtime.store.initialized("watch", target), true);
    assert.deepEqual(runtime.store.existingItems("watch", target), runtime.store.existingItems("watch", namespace));
    assert.equal(runtime.store.ruleState("watch", target, "hint", "x:10"), undefined);
    await runtime.sync();
    assert.equal(runtime.store.existingItems("watch", target).size, 1);
    assert.equal(runtime.store.events().length, 0);
  } finally { runtime.close(); }
});

test("runtime isolates acquisition for other semantic changes during a strict-new transition", async (context) => {
  const changes = [
    { source: { ...transitionConfig.source, handle: "other" } },
    { source: { ...transitionConfig.source, maxPages: 10 } },
    { assertions: { minItems: 2 } },
    { enabled: false },
    { rules: [{ ...transitionConfig.rules[0], trigger: "new_item", prompt: "A different rubric." }] },
    { rules: [{ ...transitionConfig.rules[0], trigger: "new_item", enabled: false }] },
    { rules: [{ ...transitionConfig.rules[0], trigger: "new_item" }, { id: "another", type: "new_items" }] },
  ];
  for (const change of changes) {
    const { runtime, namespace, file } = await transitionRuntime(context);
    try {
      await writeFile(file, JSON.stringify({ ...transitionConfig, rules: [{ ...transitionConfig.rules[0], trigger: "new_item" }], ...change }));
      const [changed] = await runtime.sync();
      const target = semanticMonitorHash(changed);
      assert.notEqual(target, namespace);
      assert.equal(runtime.store.initialized("watch", target), false);
      assert.equal(runtime.store.existingItems("watch", target).size, 0);
      assert.equal(runtime.store.existingItems("watch", namespace).size, 1);
    } finally { runtime.close(); }
  }
});

test("manual runtime runs inherit the baseline before collecting and never assess known identities", async (context) => {
  let collected = false;
  const { runtime, file } = await transitionRuntime(context, async (_source, acquisition) => {
    assert.deepEqual(acquisition?.previousItems.map(item => item.id), ["x:10"]);
    assert.deepEqual(acquisition?.bootstrapItemIds, ["x:10"]);
    collected = true;
    return { items: acquisition!.previousItems, fetchedAt: transitionAt };
  });
  try {
    Object.defineProperty(runtime.engine, "assess", { value: async () => { throw new Error("known identities must never call inference"); } });
    await writeFile(file, JSON.stringify({ ...transitionConfig, rules: [{ ...transitionConfig.rules[0], trigger: "new_item" }] }));
    const result = await runtime.run("watch");
    assert.equal(result.status, "ok_unchanged");
    assert.equal(collected, true);
    assert.equal(result.events.length, 0);
  } finally { runtime.close(); }
});
