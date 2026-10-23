import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as configFiles from "../src/config/load.ts";

const { readRecipe, saveRecipe } = configFiles;

const source = `# preserve this comment\nversion: 1\nid: papers\nname: Papers\nenabled: false\nschedule: { every: 30m }\nsource: { type: feed, url: https://example.com/feed }\nrules: [{ id: fresh, type: new_items }]\n`;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sss-web-recipes-"));
  const path = join(directory, "custom-name.yaml");
  await writeFile(path, source);
  return { directory, path };
}

test("editable recipes preserve raw YAML and atomically replace the existing private path", async () => {
  const { directory, path } = await fixture();
  try {
    const recipe = await readRecipe(directory, "papers");
    assert.ok(recipe);
    assert.equal(recipe.source, source);
    assert.equal(recipe.revision, createHash("sha256").update(source).digest("hex"));
    const next = source.replace("name: Papers", "name: Updated");
    let commits = 0;
    const config = await saveRecipe(directory, "papers", next, recipe.revision, (monitor, replace) => {
      commits++;
      assert.equal(monitor.name, "Updated");
      replace();
    });
    assert.equal(config.name, "Updated");
    assert.equal(commits, 1);
    assert.equal(await readFile(path, "utf8"), next);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["custom-name.yaml"]);
    assert.equal(await readRecipe(directory, "missing"), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recipe saves preserve current bytes on validation, ID, conflict, and commit failures", async () => {
  const { directory, path } = await fixture();
  try {
    const recipe = await readRecipe(directory, "papers");
    assert.ok(recipe);
    for (const next of ["version: [", source.replace("id: papers", "id: moved"), `${source}id: duplicate\n`, source.replace("every: 30m", "every: 0s")]) {
      await assert.rejects(saveRecipe(directory, "papers", next, recipe.revision));
      assert.equal(await readFile(path, "utf8"), source);
    }
    await assert.rejects(saveRecipe(directory, "papers", source, "stale"), /changed|reload/i);
    await assert.rejects(saveRecipe(directory, "papers", source, recipe.revision, () => { throw new Error("active scan"); }), /active scan/);
    assert.equal(await readFile(path, "utf8"), source);
    assert.deepEqual(await readdir(directory), ["custom-name.yaml"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recipe replacement rechecks the revision inside the commit fence", async () => {
  const { directory, path } = await fixture();
  try {
    const recipe = await readRecipe(directory, "papers");
    assert.ok(recipe);
    const external = source.replace("name: Papers", "name: External");
    await assert.rejects(saveRecipe(directory, "papers", source, recipe.revision, (_monitor, replace) => {
      writeFileSync(path, external);
      replace();
    }), /changed|reload/i);
    assert.equal(await readFile(path, "utf8"), external);
    assert.deepEqual(await readdir(directory), ["custom-name.yaml"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recipe editing rejects symlink targets, path IDs, and oversized source", async () => {
  const { directory, path } = await fixture();
  try {
    const recipe = await readRecipe(directory, "papers");
    assert.ok(recipe);
    await assert.rejects(readRecipe(directory, "../papers"));
    await assert.rejects(saveRecipe(directory, "papers", "x".repeat(1_048_577), recipe.revision), /large/i);
    await rm(path);
    await writeFile(join(directory, "outside"), source);
    await symlink(join(directory, "outside"), path);
    await assert.rejects(readRecipe(directory, "papers"), /symbolic|symlink|regular/i);
    await assert.rejects(saveRecipe(directory, "papers", source, recipe.revision));
    assert.equal(await readFile(join(directory, "outside"), "utf8"), source);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
