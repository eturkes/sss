import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadMonitorById } from "../src/config/load.ts";
import { monitorSchema, semanticMonitorHash, type Monitor } from "../src/config/schema.ts";
import { Store } from "../src/store/database.ts";

const RESET_IDS = new Set(["thsottiaux-codex-reset", "claudedevs-claude-reset"]);

/** Explicit prompt-only transition; run while the scheduler is stopped. */
export function upgradeResetRubric(store: Store, supplied: Monitor): "upgraded" | "unchanged" {
  const next = monitorSchema.parse(supplied);
  if (!RESET_IDS.has(next.id)) throw new Error("only shipped reset monitors can upgrade");
  const current = store.monitor(next.id);
  if (!current) throw new Error(`monitor ${next.id} has no accepted baseline`);
  const previous = monitorSchema.parse(JSON.parse(current.configJson) as unknown);
  const strictNew = (config: Monitor) => config.source.type === "x" && config.rules.length > 0 &&
    config.rules.every(rule => rule.type === "llm_assessment" && rule.trigger === "new_item");
  if (!strictNew(previous) || !strictNew(next)) throw new Error("upgrade requires strict-new X assessment rules");
  if (previous.id !== next.id || semanticMonitorHash(previous) !== current.namespace) throw new Error("source namespace does not match its stored configuration");
  if (!store.initialized(next.id, current.namespace)) throw new Error("source baseline must be initialized");
  if (isDeepStrictEqual(previous, next)) return "unchanged";

  const restored = { ...next, rules: next.rules.map((rule, index) => {
    const old = previous.rules[index];
    return rule.type === "llm_assessment" && old?.type === "llm_assessment" ? { ...rule, prompt: old.prompt } : rule;
  }) };
  if (!isDeepStrictEqual(previous, restored)) throw new Error("upgrade permits prompt-only changes to existing rules");
  const namespace = semanticMonitorHash(next);
  if (namespace === current.namespace) throw new Error("upgrade requires a prompt change");
  const target = store.db.prepare("SELECT initialized FROM namespaces WHERE monitor_id=? AND namespace=?").get(next.id, namespace);
  if (target?.["initialized"] || store.db.prepare("SELECT 1 FROM items WHERE monitor_id=? AND namespace=?").get(next.id, namespace) ||
      store.db.prepare("SELECT 1 FROM rule_state WHERE monitor_id=? AND namespace=?").get(next.id, namespace)) {
    throw new Error("target namespace must be uninitialized and empty of items and judgments");
  }
  // Store owns transactional CAS, active-scan rejection, lease fencing and exact raw-history transfer.
  store.syncMonitor(next, JSON.stringify(next), namespace, new Date().toISOString(), current);
  return "upgraded";
}

if (import.meta.main) {
  try {
    const [id, ...extra] = process.argv.slice(2);
    if (!id || extra.length || !RESET_IDS.has(id)) throw new Error("Usage: node scripts/upgrade-reset-rubrics.ts thsottiaux-codex-reset|claudedevs-claude-reset. Stop the scheduler first.");
    const database = resolve(process.env["SSS_STATE_DIR"] ?? ".sss", "sss.db");
    if (!(await stat(database)).isFile()) throw new Error("existing SSS database required");
    const config = await loadMonitorById(resolve(process.env["SSS_MONITORS_DIR"] ?? "monitors"), id);
    const store = new Store(database);
    try { console.log(`${id}: ${upgradeResetRubric(store, config)}`); }
    finally { store.close(); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
