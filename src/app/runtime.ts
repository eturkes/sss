import { chmod, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { Monitor } from "../config/schema.ts";
import { loadMonitorById, loadMonitorFiles, loadMonitorFile } from "../config/load.ts";
import { monitorSchema, semanticMonitorHash } from "../config/schema.ts";
import { ScannerEngine, type Collector, type RunResult } from "../core/engine.ts";
import { drainOutbox } from "../notifications/outbox.ts";
import { nextOccurrence } from "../scheduler/schedule.ts";
import { safeFetch } from "../security/network.ts";
import { safeErrorMessage } from "../security/text.ts";
import { createCollector } from "../sources/index.ts";
import { Store } from "../store/database.ts";

export type RuntimeOptions = { stateDir?: string; monitorsDir?: string; now?: () => Date; ephemeral?: boolean; collector?: Collector };
const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
const MONITOR_LEASE_MS = 30 * 60_000;

export class Runtime {
  readonly stateDir: string;
  readonly monitorsDir: string;
  readonly store: Store;
  readonly engine: ScannerEngine;
  readonly now: () => Date;
  private nextMaintenanceAt = 0;

  constructor(options: RuntimeOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? process.env["SSS_STATE_DIR"] ?? ".sss");
    this.monitorsDir = resolve(options.monitorsDir ?? process.env["SSS_MONITORS_DIR"] ?? "monitors");
    this.now = options.now ?? (() => new Date());
    this.store = new Store(options.ephemeral ? ":memory:" : resolve(this.stateDir, "sss.db"));
    this.engine = new ScannerEngine(this.store, options.collector ?? createCollector({ fetch: safeFetch, now: this.now }), this.now);
  }

  async init(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(this.monitorsDir, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(this.stateDir, 0o700), chmod(this.monitorsDir, 0o700)]);
  }

  async sync(): Promise<Monitor[]> {
    await this.init();
    const loaded = await loadMonitorFiles(this.monitorsDir);
    await Promise.all(loaded.map(({ filePath }) => chmod(filePath, 0o600)));
    const ids: string[] = [];
    for (const { config } of loaded) {
      ids.push(config.id);
      const namespace = semanticMonitorHash(config);
      this.syncMonitor(config, namespace, this.now().toISOString());
    }
    this.store.disableMissing(ids);
    return loaded.map(({ config }) => config);
  }

  async run(idOrPath: string, dryRun = false): Promise<RunResult> {
    const config = await this.resolveMonitor(idOrPath);
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

  async tick(): Promise<{ runs: number; deliveries: { sent: number; failed: number } }> {
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
    const adapterVersion = ([2, 1] as const).find(version => semanticMonitorHash(previous, version) === namespace);
    if (adapterVersion === undefined) return false;
    const oldRules = new Map(previous.rules.map(rule => [rule.id, rule]));
    let narrowed = false;
    const rules = next.rules.map(rule => {
      const old = oldRules.get(rule.id);
      if (old?.type !== "llm_assessment" || rule.type !== "llm_assessment") return rule;
      if (old.trigger !== "new_item") narrowed = true;
      return { ...rule, trigger: old.trigger ?? "new_or_changed" };
    });
    return (narrowed || adapterVersion === 1) && semanticMonitorHash({ ...next, rules }, adapterVersion) === namespace;
  } catch { return false; }
}

function safeRuntimeError(error: unknown): string {
  return safeErrorMessage(error, 500);
}

export async function hasMonitorFiles(directory: string): Promise<boolean> {
  try { return (await readdir(directory)).some((name) => /\.ya?ml$/i.test(name)); } catch { return false; }
}
