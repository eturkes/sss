import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runtime } from "../src/app/runtime.ts";

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
