import { Runtime } from "../src/app/runtime.ts";
import { loadMonitorFiles } from "../src/config/load.ts";

// Live acquisition only: ephemeral state, no model calls, baseline writes, or alerts.
const runtime = new Runtime({ ephemeral: true });
let failures = 0;
try {
  const recipes = (await loadMonitorFiles(runtime.monitorsDir)).filter(({ config }) => config.id.startsWith("fv-"));
  if (recipes.length === 0) throw new Error("no formal-verification recipes found");
  for (const { config, filePath } of recipes) {
    const result = await runtime.run(filePath, true);
    const ok = result.status === "ok_unchanged" && result.dryRun;
    if (!ok) failures++;
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${config.id} · ${result.items.length} items${result.error ? ` · ${result.error}` : ""}\n`);
  }
  process.stdout.write(`${recipes.length - failures}/${recipes.length} complete acquisitions; no state or delivery\n`);
} finally { runtime.close(); }
if (failures) process.exitCode = 1;
