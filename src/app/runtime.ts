import { chmod, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { Monitor } from "../config/schema.ts";
import { loadMonitorById, loadMonitorFiles, loadMonitorFile, readRecipe, saveRecipe as saveRecipeFile } from "../config/load.ts";
import { monitorSchema, semanticMonitorHash, X_ADAPTER_VERSION } from "../config/schema.ts";
import { ScannerEngine, type Collector, type RunResult } from "../core/engine.ts";
import { drainOutbox } from "../notifications/outbox.ts";
import { nextOccurrence } from "../scheduler/schedule.ts";
import { safeFetch } from "../security/network.ts";
import { safeErrorMessage } from "../security/text.ts";
import { createCollector } from "../sources/collect.ts";
import { Store } from "../store/database.ts";
import { ArtifactStore } from "../store/artifacts.ts";

export type RuntimeOptions = { stateDir?: string; monitorsDir?: string; now?: () => Date; ephemeral?: boolean; collector?: Collector };
const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
const MONITOR_LEASE_MS = 30 * 60_000;

export class Runtime {
  readonly stateDir: string;
  readonly monitorsDir: string;
  readonly store: Store;
  readonly engine: ScannerEngine;
  readonly now: () => Date;
  readonly artifacts: ArtifactStore;
  private nextMaintenanceAt = 0;
  private editingRecipe = false;
  private recipeRecoveryRequired = false;
  private recipeRevision = 0;

  constructor(options: RuntimeOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? process.env["SSS_STATE_DIR"] ?? ".sss");
    this.monitorsDir = resolve(options.monitorsDir ?? process.env["SSS_MONITORS_DIR"] ?? "monitors");
    this.now = options.now ?? (() => new Date());
    this.store = new Store(options.ephemeral ? ":memory:" : resolve(this.stateDir, "sss.db"));
    this.artifacts = new ArtifactStore(this.stateDir);
    this.engine = new ScannerEngine(this.store, options.collector ?? createCollector({ fetch: safeFetch, now: this.now }), this.now, undefined, this.artifacts);
  }

  async init(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(this.monitorsDir, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(this.stateDir, 0o700), chmod(this.monitorsDir, 0o700)]);
  }

  async sync(): Promise<Monitor[]> {
    if (this.editingRecipe) throw new Error("a recipe edit is in progress");
    const recipeRevision = this.recipeRevision;
    await this.init();
    const loaded = await loadMonitorFiles(this.monitorsDir);
    await Promise.all(loaded.map(({ filePath }) => chmod(filePath, 0o600)));
    if (this.editingRecipe || recipeRevision !== this.recipeRevision) throw new Error("a recipe edit changed the configuration; retry synchronization");
    const ids: string[] = [];
    for (const { config } of loaded) {
      ids.push(config.id);
      const namespace = semanticMonitorHash(config);
      this.syncMonitor(config, namespace, this.now().toISOString());
    }
    this.store.disableMissing(ids);
    this.recipeRecoveryRequired = false;
    return loaded.map(({ config }) => config);
  }

  async run(idOrPath: string, dryRun = false): Promise<RunResult> {
    if (this.recipeRecoveryRequired) throw new Error("recipes require reconciliation; run sss sync before scanning");
    if (this.editingRecipe) throw new Error("a recipe edit is in progress");
    const recipeRevision = this.recipeRevision;
    const config = await this.resolveMonitor(idOrPath);
    if (this.editingRecipe || recipeRevision !== this.recipeRevision) throw new Error("a recipe edit changed the configuration; retry the scan");
    const namespace = semanticMonitorHash(config);
    if (dryRun) return this.engine.run(config, namespace, { dryRun: true });
    const now = this.now();
    this.syncMonitor(config, namespace, now.toISOString());
    const claim = this.store.claimMonitor(config.id, now.toISOString(), new Date(now.getTime() + MONITOR_LEASE_MS).toISOString());
    if (!claim) return { status: "skipped", items: [], events: [], error: "monitor is already claimed", dryRun: false };
    let result: RunResult;
    try {
      result = await this.engine.run(config, namespace, { monitorLeaseToken: claim.leaseToken });
    } finally {
      this.store.completeClaim(config.id, nextOccurrence(config.schedule, this.now()).toISOString(), claim.leaseToken);
    }
    await drainOutbox(this.store, this.now);
    return result;
  }

  async runNow(id: string): Promise<RunResult> {
    return this.run(id);
  }

  async recipe(id: string) { return readRecipe(this.monitorsDir, id); }

  async saveRecipe(id: string, source: string, revision: string): Promise<Monitor> {
    if (this.editingRecipe) throw new Error("a recipe edit is in progress");
    this.editingRecipe = true;
    this.recipeRevision++;
    let fileReplaced = false;
    try {
      return await saveRecipeFile(this.monitorsDir, id, source, revision, (config, replace) => {
        this.store.transaction(() => {
          const running = this.store.db.prepare("SELECT 1 FROM runs WHERE monitor_id=? AND status='running'").get(id);
          const claimed = this.store.status().find(monitor => monitor.id === id)?.leaseUntil;
          if (running || claimed && claimed > this.now().toISOString()) throw new Error(`monitor ${id} has an active scan or claim`);
          this.syncMonitor(config, semanticMonitorHash(config), this.now().toISOString());
          replace();
          fileReplaced = true;
        });
      });
    } catch (error) {
      if (fileReplaced) {
        this.recipeRecoveryRequired = true;
        throw new Error("recipe file was saved but database synchronization failed; scans wait for recipe reconciliation", { cause: error });
      }
      throw error;
    } finally { this.editingRecipe = false; }
  }

  async tick(): Promise<{ runs: number; deliveries: { sent: number; failed: number } }> {
    if (this.editingRecipe) return { runs: 0, deliveries: { sent: 0, failed: 0 } };
    if (this.recipeRecoveryRequired) await this.sync();
    const now = this.now();
    const claimed = this.store.claimDue(now.toISOString(), new Date(now.getTime() + MONITOR_LEASE_MS).toISOString(), 1);
    let runs = 0;
    for (const claim of claimed) {
      const config = JSON.parse(claim.configJson) as Monitor;
      try {
        await this.engine.run(config, claim.namespace, { scheduledFor: claim.scheduledFor, monitorLeaseToken: claim.leaseToken });
      } catch (error) {
        process.stderr.write(`tick ${config.id}: ${safeRuntimeError(error)}\n`);
      } finally {
        this.store.completeClaim(config.id, nextOccurrence(config.schedule, this.now()).toISOString(), claim.leaseToken);
      }
      runs++;
    }
    if (now.getTime() >= this.nextMaintenanceAt) {
      this.store.pruneArtifacts(now.toISOString(), this.artifacts);
      this.store.prune(new Date(now.getTime() - 180 * 86_400_000).toISOString(), new Date(now.getTime() - 30 * 86_400_000).toISOString());
      this.nextMaintenanceAt = now.getTime() + RETENTION_INTERVAL_MS;
    }
    return { runs, deliveries: await drainOutbox(this.store, this.now) };
  }

  close(): void { this.store.close(); }

  private syncMonitor(config: Monitor, namespace: string, nextDueAt: string): void {
    const previous = this.store.monitor(config.id);
    const acquisitionFrom = previous && canInheritXAcquisition(previous.configJson, previous.namespace, config) ? previous : undefined;
    this.store.syncMonitor(config, JSON.stringify(config), namespace, nextDueAt, acquisitionFrom);
  }

  private async resolveMonitor(idOrPath: string): Promise<Monitor> {
    if (/\.ya?ml$/i.test(idOrPath) || idOrPath.includes("/")) return loadMonitorFile(resolve(idOrPath));
    return loadMonitorById(this.monitorsDir, idOrPath);
  }
}

function canInheritXAcquisition(configJson: string, namespace: string, next: Monitor): boolean {
  try {
    const previous = monitorSchema.parse(JSON.parse(configJson) as unknown);
    if (previous.source.type !== "x" || next.source.type !== "x" || previous.enabled !== next.enabled ||
        next.rules.some(rule => rule.type !== "llm_assessment" || rule.trigger !== "new_item")) return false;
    const adapterVersion = ([3, 2, 1] as const).find(version => semanticMonitorHash(previous, version) === namespace);
    if (adapterVersion === undefined) return false;
    const oldRules = new Map(previous.rules.map(rule => [rule.id, rule]));
    let narrowed = false;
    const rules = next.rules.map(rule => {
      const old = oldRules.get(rule.id);
      if (old?.type !== "llm_assessment" || rule.type !== "llm_assessment") return rule;
      if (old.trigger !== "new_item") narrowed = true;
      return { ...rule, trigger: old.trigger ?? "new_or_changed" };
    });
    return (narrowed || adapterVersion < X_ADAPTER_VERSION) && semanticMonitorHash({ ...next, rules }, adapterVersion) === namespace;
  } catch { return false; }
}

function safeRuntimeError(error: unknown): string {
  return safeErrorMessage(error, 500);
}

export async function hasMonitorFiles(directory: string): Promise<boolean> {
  try { return (await readdir(directory)).some((name) => /\.ya?ml$/i.test(name)); } catch { return false; }
}
