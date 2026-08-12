import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { draftMonitor } from "../src/codex/draft.ts";

test("Codex compiler validates a structured envelope and monitor payload", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sss-fake-codex-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "codex");
  const monitor = {
    version: 1,
    id: "compiled-page",
    name: "Compiled page",
    enabled: false,
    schedule: { every: "30m" },
    source: { type: "html", url: "https://example.com/", fields: { heading: { selector: "h1" } } },
    assertions: { minItems: 1, maxItems: 1, requiredFields: ["heading"] },
    rules: [{ id: "heading-change", type: "field_changed", field: "heading" }],
    notifications: [{ type: "inbox" }],
  };
  const envelope = JSON.stringify({ monitor_json: JSON.stringify(monitor) });
  await writeFile(executable, `#!/bin/sh
schema=
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-schema" ]; then shift; schema=$1
  elif [ "$1" = "--output-last-message" ]; then shift; output=$1
  fi
  shift
done
while IFS= read -r line; do :; done
/usr/bin/grep -q '"monitor_json"' "$schema" || exit 4
/usr/bin/printf '%s' '${envelope}' > "$output"
`, { mode: 0o700 });

  const originalPath = process.env["PATH"];
  process.env["PATH"] = `${directory}${delimiter}${originalPath ?? ""}`;
  try {
    const result = await draftMonitor("watch the example heading", { timeoutMs: 5_000 });
    assert.equal(result.id, "compiled-page");
    assert.equal(result.enabled, false);
    assert.equal(result.rules[0]?.type, "field_changed");
  } finally {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
  }
});
