import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runtime } from "../src/app/runtime.ts";
import { monitorSchema, semanticMonitorHash } from "../src/config/schema.ts";

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "sss-runtime-editor-"));
  const runtime = new Runtime({ stateDir: join(root, "state"), monitorsDir: join(root, "monitors"),
    collector: async () => ({ items: [{ id: "one", data: { value: 1 } }], fetchedAt: new Date().toISOString() }) });
  await runtime.init();
  const config = monitorSchema.parse({ version: 1, id: "sample", name: "Sample", enabled: false,
    schedule: { every: "1h" }, source: { type: "json", url: "https://example.com/" }, rules: [{ type: "new_items", id: "new" }] });
  const file = join(runtime.monitorsDir, "sample.yaml");
  await writeFile(file, JSON.stringify(config));
  await runtime.sync();
  context.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { runtime, config, file };
}

test("runtime editor persists schema-valid recipes and syncs without acquisition", async context => {
  const { runtime, config } = await fixture(context);
  const recipe = await runtime.recipe("sample");
  assert.ok(recipe);
  Object.defineProperty(runtime.engine, "collect", { value: async () => { throw new Error("editor must not acquire"); } });
  const changed = { ...config, name: "Edited", source: { type: "json", url: "https://example.org/" } };
  await runtime.saveRecipe("sample", JSON.stringify(changed), recipe.revision);
  assert.equal(runtime.store.monitor("sample")?.namespace, semanticMonitorHash(changed));
  assert.equal((await runtime.recipe("sample"))?.config.name, "Edited");
  await assert.rejects(runtime.saveRecipe("sample", JSON.stringify(config), recipe.revision), /changed|revision|conflict/i);
  assert.equal(runtime.store.monitor("sample")?.namespace, semanticMonitorHash(changed));
});

test("runtime editor rejects another process's active scan without changing YAML or DB", async context => {
  const { runtime, config, file } = await fixture(context);
  const recipe = await runtime.recipe("sample");
  assert.ok(recipe);
  const peer = new Runtime({ stateDir: runtime.stateDir, monitorsDir: runtime.monitorsDir });
  try {
    const at = new Date().toISOString();
    const run = peer.store.beginRun(config.id, semanticMonitorHash(config), at, at, "2000-01-01T00:00:00Z");
    await assert.rejects(runtime.saveRecipe(config.id, JSON.stringify({ ...config, name: "Blocked" }), recipe.revision), /active|claimed|scan/i);
    assert.equal(await readFile(file, "utf8"), recipe.source);
    assert.equal(runtime.store.monitor(config.id)?.configJson, JSON.stringify(config));
    peer.store.finishRun(run.id, run.token, config.id, "ok_unchanged", at, 0, 0);
  } finally { peer.close(); }
});

test("X v3 history survives the v4 parser upgrade without copying judgments", async context => {
  const { runtime } = await fixture(context);
  const config = monitorSchema.parse({ version: 1, id: "sample", name: "Sample", enabled: false,
    schedule: { every: "5m" }, source: { type: "x", handle: "thsottiaux" },
    rules: [{ type: "llm_assessment", id: "reset", trigger: "new_item", model: "gpt-6.1-terra", reasoningEffort: "medium", prompt: "Reset hints." }] });
  const old = semanticMonitorHash(config, 3), next = semanticMonitorHash(config);
  assert.notEqual(old, next);
  runtime.store.syncMonitor(config, JSON.stringify(config), old, "2026-10-01T00:00:00Z");
  const run = runtime.store.beginRun(config.id, old, "original", "2026-10-01T00:00:00Z", "2000-01-01T00:00:00Z");
  runtime.store.acceptItems(run.id, config.id, old, [{ id: "x:100", hash: "exact", data: { text: " α\n" } }], "2026-10-01T00:00:00Z");
  runtime.store.setRuleState(config.id, old, "reset", "x:100", { suggestive: false }, "2026-10-01T00:00:00Z");
  runtime.store.finishRun(run.id, run.token, config.id, "ok_unchanged", "2026-10-01T00:00:00Z", 1, 0);
  await writeFile(join(runtime.monitorsDir, "sample.yaml"), JSON.stringify(config));
  await runtime.sync();
  assert.deepEqual(runtime.store.existingItems(config.id, next), runtime.store.existingItems(config.id, old));
  assert.deepEqual(runtime.store.bootstrapItemIds(config.id, next), ["x:100"]);
  assert.equal(runtime.store.ruleState(config.id, next, "reset", "x:100"), undefined);
  assert.equal(runtime.store.events().length, 0);
});

test("editor parser transitions use nested transactions without weakening rollback", async context => {
  const { runtime } = await fixture(context);
  const config = monitorSchema.parse({ version: 1, id: "sample", name: "Sample", enabled: false,
    schedule: { every: "5m" }, source: { type: "x", handle: "thsottiaux" },
    rules: [{ type: "llm_assessment", id: "reset", trigger: "new_item", model: "gpt-6.1-terra", reasoningEffort: "medium", prompt: "Reset hints." }] });
  const old = semanticMonitorHash(config, 3), next = semanticMonitorHash(config);
  runtime.store.syncMonitor(config, JSON.stringify(config), old, "2026-10-01T00:00:00Z");
  const run = runtime.store.beginRun(config.id, old, "original", "2026-10-01T00:00:00Z", "2000-01-01T00:00:00Z");
  runtime.store.acceptItems(run.id, config.id, old, [{ id: "x:100", hash: "exact", data: { text: " α\n" } }], "2026-10-01T00:00:00Z");
  runtime.store.finishRun(run.id, run.token, config.id, "ok_unchanged", "2026-10-01T00:00:00Z", 1, 0);
  await writeFile(join(runtime.monitorsDir, "sample.yaml"), JSON.stringify(config));
  const recipe = await runtime.recipe(config.id);
  assert.ok(recipe);
  await runtime.saveRecipe(config.id, JSON.stringify({ ...config, name: "Updated" }), recipe.revision);
  assert.deepEqual(runtime.store.existingItems(config.id, next), runtime.store.existingItems(config.id, old));
  runtime.store.transaction(() => {
    try { runtime.store.transaction(() => { runtime.store.db.prepare("UPDATE monitors SET name='rolled back' WHERE id=?").run(config.id); throw new Error("rollback"); }); } catch {}
    assert.equal(runtime.store.status().find(row => row.id === config.id)?.name, "Updated");
  });
});

test("a post-rename database failure blocks stale scans until recipe reconciliation", async context => {
  const { runtime, config, file } = await fixture(context);
  const recipe = await runtime.recipe(config.id);
  assert.ok(recipe);
  const exec = runtime.store.db.exec.bind(runtime.store.db);
  let failCommit = true;
  runtime.store.db.exec = sql => {
    if (sql === "COMMIT" && failCommit) { failCommit = false; throw new Error("injected commit failure"); }
    return exec(sql);
  };
  const changed = { ...config, name: "Recovered", source: { type: "json", url: "https://example.org/" } };
  await assert.rejects(runtime.saveRecipe(config.id, JSON.stringify(changed), recipe.revision), /file.*saved|reconcil|synchron/i);
  assert.equal(JSON.parse(await readFile(file, "utf8")).name, "Recovered");
  assert.equal(runtime.store.monitor(config.id)?.configJson, JSON.stringify(config));
  await assert.rejects(runtime.run(config.id), /reconcil|synchron/i);
  await runtime.tick();
  assert.equal(runtime.store.monitor(config.id)?.namespace, semanticMonitorHash(changed));
});
