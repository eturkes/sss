import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { Runtime } from "../src/app/runtime.ts";
import { monitorSchema, semanticMonitorHash } from "../src/config/schema.ts";

async function fixture(context: { after(fn: () => Promise<void>): void }, artifacts?: { retentionDays: number }) {
  const root = await mkdtemp(join(tmpdir(), "sss-artifacts-"));
  const monitorsDir = join(root, "monitors"), stateDir = join(root, "state");
  await mkdir(monitorsDir);
  let now = new Date("2026-10-01T00:00:00Z");
  const config = monitorSchema.parse({ version: 1, id: "sample", name: "Sample", enabled: false,
    schedule: { every: "1h" }, source: { type: "json", url: "https://example.com/" },
    rules: [{ type: "new_items", id: "new" }], ...(artifacts ? { artifacts } : {}) });
  await writeFile(join(monitorsDir, "sample.yaml"), stringify(config));
  const item = { id: "sample:1", title: " Exact α\n", data: { text: " a  b\nα ", value: 1 } };
  const runtime = new Runtime({ monitorsDir, stateDir, now: () => now, collector: async () => ({ items: [item], fetchedAt: now.toISOString() }) });
  context.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.sync();
  return { runtime, config, item, stateDir, advance: (days: number) => { now = new Date(now.getTime() + days * 86_400_000); } };
}

test("artifacts require explicit opt-in and dry runs never retain data", async context => {
  const f = await fixture(context);
  assert.equal((await f.runtime.run("sample")).status, "ok_unchanged");
  await assert.rejects(stat(join(f.stateDir, "artifacts")), { code: "ENOENT" });
  const enabled = await fixture(context, { retentionDays: 2 });
  assert.equal((await enabled.runtime.run("sample", true)).dryRun, true);
  await assert.rejects(stat(join(enabled.stateDir, "artifacts")), { code: "ENOENT" });
  assert.equal(semanticMonitorHash(f.config), semanticMonitorHash({ ...f.config, artifacts: { retentionDays: 5 } }));
});

test("accepted artifacts preserve exact observations, deduplicate bytes, and expire independently", async context => {
  const f = await fixture(context, { retentionDays: 2 });
  await f.runtime.run("sample");
  const directory = join(f.stateDir, "artifacts");
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  const content = await readFile(join(directory, names[0]!));
  assert.equal(names[0], `${createHash("sha256").update(content).digest("hex")}.json`);
  assert.deepEqual(JSON.parse(content.toString()), { version: 1, items: [f.item] });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, names[0]!))).mode & 0o777, 0o600);
  f.advance(1);
  await f.runtime.run("sample");
  assert.deepEqual(await readdir(directory), names);
  assert.equal(f.runtime.store.artifacts("sample").length, 2);
  f.advance(1);
  await f.runtime.tick();
  assert.equal(f.runtime.store.artifacts("sample").length, 1);
  assert.deepEqual(await readdir(directory), names);
  f.advance(1);
  await f.runtime.tick();
  assert.equal(f.runtime.store.artifacts("sample").length, 0);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(f.runtime.store.existingItems("sample", semanticMonitorHash(f.config)).size, 1);
});

test("artifact write failure preserves baseline and does not accept a reference", async context => {
  const f = await fixture(context, { retentionDays: 2 });
  await writeFile(join(f.stateDir, "artifacts"), "not a directory");
  const result = await f.runtime.run("sample");
  assert.equal(result.status, "degraded");
  assert.equal(f.runtime.store.existingItems("sample", semanticMonitorHash(f.config)).size, 0);
  assert.equal(f.runtime.store.artifacts("sample").length, 0);
});
