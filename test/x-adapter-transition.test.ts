import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { Runtime } from "../src/app/runtime.ts";
import { monitorSchema, semanticMonitorHash } from "../src/config/schema.ts";

test("X author-parser upgrade preserves strict-new accepted identities and original startup cutoff", async context => {
  const directory = await mkdtemp(join(tmpdir(), "sss-adapter-upgrade-"));
  const monitorsDir = join(directory, "monitors");
  await mkdir(monitorsDir);
  const config = monitorSchema.parse({ version: 1, id: "watch", name: "Watch", enabled: true, source: { type: "x", handle: "thsottiaux" }, schedule: { every: "5m" },
    rules: [{ id: "reset", type: "llm_assessment", trigger: "new_item", bootstrap: "suppress_existing", model: "gpt-6.1-sol", reasoningEffort: "xhigh", prompt: "Assess reset hints." }], notifications: [{ type: "inbox" }] });
  await writeFile(join(monitorsDir, "watch.yaml"), stringify(config));
  const runtime = new Runtime({ ephemeral: true, monitorsDir, stateDir: join(directory, "state"), collector: async () => { throw new Error("must not acquire during sync"); } });
  context.after(async () => { runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const oldNamespace = semanticMonitorHash(config, 1), nextNamespace = semanticMonitorHash(config);
  assert.notEqual(oldNamespace, nextNamespace);
  runtime.store.syncMonitor(config, JSON.stringify(config), oldNamespace, "2026-10-07T09:00:00.000Z");
  for (const [id, at] of [["x:100", "2026-10-07T09:00:00.000Z"], ["x:200", "2026-10-07T09:05:00.000Z"]]) {
    const run = runtime.store.beginRun(config.id, oldNamespace, at!, at!, "2026-01-01T00:00:00.000Z");
    runtime.store.acceptItems(run.id, config.id, oldNamespace, [{ id: id!, data: { text: "Cached exact\nα" }, hash: id! }], at!);
    runtime.store.setRuleState(config.id, oldNamespace, "reset", id!, { revision: id!, status: "assessed", suggestive: false }, at!);
    runtime.store.finishRun(run.id, run.token, config.id, "ok_unchanged", at!, 1, 0);
  }
  const rows = (namespace: string) => runtime.store.db.prepare("SELECT item_key,content_hash,data_json,first_seen_at,last_seen_at,active FROM items WHERE monitor_id=? AND namespace=? ORDER BY item_key").all(config.id, namespace);
  const before = rows(oldNamespace);
  await runtime.sync();
  assert.equal(runtime.store.monitor(config.id)?.namespace, nextNamespace);
  assert.equal(runtime.store.initialized(config.id, nextNamespace), true);
  assert.deepEqual(rows(nextNamespace), before);
  assert.deepEqual(rows(oldNamespace), before);
  assert.deepEqual(runtime.store.bootstrapItemIds(config.id, nextNamespace), ["x:100"]);
  assert.equal(runtime.store.ruleState(config.id, nextNamespace, "reset", "x:100"), undefined);
  assert.equal(runtime.store.events().length, 0);
  await runtime.sync();
  assert.deepEqual(rows(nextNamespace), before);
});
