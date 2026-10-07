import { canonicalJson, comparableNumber, getPath, sha256, stableId } from "./canonical.ts";
import { formatMinorUnits } from "./money.ts";
import type { ChangeEvent, Collection, JsonObject, JsonValue, RunStatus, ScanItem } from "./types.ts";
import type { AssessmentRule, Assertions as AssertionConfig, MonitorConfig as Monitor, RuleConfig as Rule } from "../config/schema.ts";
import { assessItem, type AssessmentResult } from "../codex/assess.ts";
import { safeErrorMessage } from "../security/text.ts";
import { MAX_SOURCE_ITEMS } from "../sources/types.ts";
import { LeaseLostError, Store } from "../store/database.ts";

export type RunResult = {
  runId?: string;
  status: Exclude<RunStatus, "running"> | "skipped";
  items: ScanItem[];
  events: ChangeEvent[];
  error?: string;
  dryRun: boolean;
};

export type CollectorContext = { previousItems: ScanItem[]; bootstrapItemIds?: string[] };
export type Collector = (source: unknown, context?: CollectorContext) => Promise<Collection>;
export type ItemAssessor = (item: ScanItem, rule: AssessmentRule) => Promise<AssessmentResult>;
const MONITOR_LEASE_MS = 30 * 60_000;

export class ScannerEngine {
  readonly store: Store;
  readonly collect: Collector;
  readonly now: () => Date;
  readonly assess: ItemAssessor;

  constructor(store: Store, collect: Collector, now: () => Date = () => new Date(), assess: ItemAssessor = assessItem) {
    this.store = store;
    this.collect = collect;
    this.now = now;
    this.assess = assess;
  }

  async run(monitor: Monitor, namespace: string, options: { dryRun?: boolean; scheduledFor?: string; monitorLeaseToken?: string } = {}): Promise<RunResult> {
    const dryRun = options.dryRun ?? false;
    const startedAt = this.now().toISOString();
    const scheduledFor = options.scheduledFor ?? startedAt;
    let runId: string | undefined;
    let runToken: string | undefined;

    if (!dryRun) {
      try {
        if (options.monitorLeaseToken) this.store.assertMonitorLease(monitor.id, options.monitorLeaseToken);
        const lease = this.store.beginRun(
          monitor.id,
          namespace,
          scheduledFor,
          startedAt,
          new Date(this.now().getTime() - 30 * 60_000).toISOString(),
        );
        runId = lease.id;
        runToken = lease.token;
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          return { status: "skipped", items: [], events: [], dryRun, error: "monitor run already exists" };
        }
        throw error;
      }
    }

    let collection: Collection;
    try {
      const previousItems = [...this.store.existingItems(monitor.id, namespace)].map(([id, previous]) => ({
        id, data: JSON.parse(previous.data_json) as JsonObject,
        ...(previous.title ? { title: previous.title } : {}), ...(previous.url ? { url: previous.url } : {}),
      }));
      const bootstrapItemIds = this.store.bootstrapItemIds(monitor.id, namespace);
      collection = await this.collect(monitor.source, { previousItems, bootstrapItemIds });
      assertCollection(collection, monitor.assertions);
      assertRuleInputs(collection, monitor.rules);
    } catch (error) {
      return degraded(this.store, monitor, namespace, runId, runToken, options.monitorLeaseToken, dryRun, error, this.now());
    }

    const sourceItems = structuredClone(collection.items);
    const rawBaseline = monitor.source.type === "x";
    const items = rawBaseline ? sourceItems : sourceItems.map((item) => ({ ...item, data: JSON.parse(canonicalJson(item.data)) as JsonObject }));
    if (dryRun) return { status: "ok_unchanged", items, events: [], dryRun: true };
    if (!runId || !runToken) throw new Error("invariant: persisted run has no lease");

    const observedAt = collection.fetchedAt || this.now().toISOString();
    let events: ChangeEvent[];
    try {
      const assertLease = () => {
        if (options.monitorLeaseToken) this.store.assertMonitorLease(monitor.id, options.monitorLeaseToken);
        this.store.assertRunLease(runId, runToken);
      };
      assertLease();
      const baselineExists = this.store.initialized(monitor.id, namespace);
      const existing = this.store.existingItems(monitor.id, namespace);
      const beforeByItem = new Map(items.map((item) => {
        const previous = existing.get(item.id);
        const before = previous ? JSON.parse(previous.data_json) as JsonObject : undefined;
        assertInvariantFields(item, before, monitor.assertions?.invariantFields);
        return [item.id, before];
      }));
      const assessments: PreparedAssessment[] = [];
      for (const item of sourceItems) {
        for (const rule of monitor.rules) {
          if (rule.enabled === false || rule.type !== "llm_assessment") continue;
          const revision = sha256(assessmentJson(item.data));
          const previousState = this.store.ruleState(monitor.id, namespace, rule.id, item.id);
          if (previousState?.["revision"] === revision) continue;
          let result: AssessmentResult | undefined;
          if (baselineExists || rule.bootstrap === "evaluate_current") {
            assertLease();
            result = await this.assess(structuredClone(item), rule);
            assertAssessment(result);
            assertLease();
            if (options.monitorLeaseToken) {
              const at = this.now();
              this.store.renewMonitorLease(monitor.id, options.monitorLeaseToken, at.toISOString(), new Date(at.getTime() + MONITOR_LEASE_MS).toISOString());
            }
          }
          assessments.push({ item, rule, revision, result, previousState });
        }
      }

      events = this.store.transaction(() => {
        assertLease();
        if (this.store.initialized(monitor.id, namespace) !== baselineExists ||
            itemSnapshot(this.store.existingItems(monitor.id, namespace)) !== itemSnapshot(existing)) {
          throw new LeaseLostError(`baseline ${monitor.id}`);
        }
        const previousErrorStreak = this.store.status().find((entry) => entry.id === monitor.id)?.errorStreak ?? 0;
        const healthAlerted = this.store.healthAlerted(monitor.id);
        const created: ChangeEvent[] = [];

        for (const item of items) {
          const before = beforeByItem.get(item.id);
          for (const rule of monitor.rules) {
            if (rule.enabled === false || rule.type === "llm_assessment") continue;
            const event = evaluateRule({ monitor, namespace, runId, rule, item, before, baselineExists, observedAt, store: this.store });
            if (event) created.push(event);
          }
        }

        for (const prepared of assessments) {
          const { item, rule, revision, result, previousState } = prepared;
          const currentState = this.store.ruleState(monitor.id, namespace, rule.id, item.id);
          if (JSON.stringify(currentState) !== JSON.stringify(previousState)) throw new LeaseLostError(`assessment ${monitor.id}/${rule.id}/${item.id}`);
          this.store.setRuleState(monitor.id, namespace, rule.id, item.id, {
            revision, status: result ? "assessed" : "suppressed",
            ...(result ? { suggestive: result.suggestive, reason: result.reason, evidence: result.evidence } : {}),
          }, observedAt);
          if (result?.suggestive) {
            created.push({
              id: stableId(monitor.id, namespace, runId, rule.id, item.id, "llm_assessment"), monitorId: monitor.id, runId, namespace,
              ruleId: rule.id, kind: "llm_assessment", itemId: item.id,
              ...(item.title ? { title: item.title } : {}), ...(item.url ? { url: item.url } : {}),
              reason: `Model judgment (${rule.model}, ${rule.reasoningEffort}): ${result.reason}`,
              before: beforeByItem.get(item.id),
              after: { post: { ...item }, assessment: { ...result, model: rule.model, reasoningEffort: rule.reasoningEffort } }, observedAt,
            });
          }
        }

        if (healthAlerted) {
          created.push({
            id: stableId(monitor.id, namespace, runId, "health", "recovered"), monitorId: monitor.id, runId, namespace,
            ruleId: "health", kind: "health_recovered", itemId: "health", reason: "scanner recovered",
            before: previousErrorStreak, after: 0, observedAt,
          });
          this.store.setHealthAlerted(monitor.id, false);
        }

        const accepted = items.map((item) => ({ ...item, hash: sha256(rawBaseline ? assessmentJson(item.data) : canonicalJson(item.data)) }));
        this.store.acceptItems(runId, monitor.id, namespace, accepted, observedAt);
        for (const event of created) this.store.insertEvent(event, notificationTargets(monitor, event.kind));
        const status = created.length > 0 ? "ok_changed" : "ok_unchanged";
        this.store.finishRun(runId, runToken, monitor.id, status, this.now().toISOString(), items.length, created.length);
        return created;
      });
    } catch (error) {
      if (error instanceof LeaseLostError) return superseded(this.store, runId, runToken, dryRun, this.now());
      return degraded(this.store, monitor, namespace, runId, runToken, options.monitorLeaseToken, dryRun, error, this.now());
    }

    return { runId, status: events.length > 0 ? "ok_changed" : "ok_unchanged", items, events, dryRun: false };
  }
}

type PreparedAssessment = {
  item: ScanItem;
  rule: AssessmentRule;
  revision: string;
  result: AssessmentResult | undefined;
  previousState: JsonObject | undefined;
};

function itemSnapshot(items: ReturnType<Store["existingItems"]>): string {
  return JSON.stringify([...items].map(([id, item]) => [id, item.content_hash]).sort(([left], [right]) => left!.localeCompare(right!)));
}

function assessmentJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(assessmentJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${assessmentJson(value[key]!)}`).join(",")}}`;
}

function assertAssessment(value: AssessmentResult): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "evidence,reason,suggestive" ||
      typeof value.suggestive !== "boolean" || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 4000 ||
      !Array.isArray(value.evidence) || value.evidence.length > 16 ||
      value.evidence.some((snippet) => typeof snippet !== "string" || !snippet.trim() || snippet.length > 1000) ||
      value.suggestive && value.evidence.length === 0) {
    throw new Error("assessment returned an invalid judgment");
  }
}

function superseded(store: Store, runId: string, runToken: string, dryRun: boolean, at: Date): RunResult {
  store.abandonRun(runId, runToken, at.toISOString(), "scan attempt superseded by a newer lease");
  return { runId, status: "skipped", items: [], events: [], error: "scan attempt superseded by a newer lease", dryRun };
}

function degraded(store: Store, monitor: Monitor, namespace: string, runId: string | undefined, runToken: string | undefined,
  monitorLeaseToken: string | undefined, dryRun: boolean, error: unknown, at: Date): RunResult {
  const message = safeMessage(error);
  let events: ChangeEvent[] = [];
  if (runId && runToken) {
    try {
      events = store.transaction(() => {
        if (monitorLeaseToken) store.assertMonitorLease(monitor.id, monitorLeaseToken);
        store.assertRunLease(runId, runToken);
        const previousStreak = store.status().find((entry) => entry.id === monitor.id)?.errorStreak ?? 0;
        const threshold = monitor.health?.failuresBeforeAlert;
        const alertNow = Boolean(threshold && previousStreak + 1 >= threshold && !store.healthAlerted(monitor.id));
        store.finishRun(runId, runToken, monitor.id, "degraded", at.toISOString(), 0, alertNow ? 1 : 0, message);
        if (!alertNow) return [];
        const event: ChangeEvent = {
          id: stableId(monitor.id, namespace, runId, "health", "degraded"), monitorId: monitor.id, runId, namespace,
          ruleId: "health", kind: "health_degraded", itemId: "health", reason: `${threshold} consecutive scan failures`,
          before: previousStreak, after: previousStreak + 1, observedAt: at.toISOString(),
        };
        store.insertEvent(event, notificationTargets(monitor, event.kind));
        store.setHealthAlerted(monitor.id, true);
        return [event];
      });
    } catch (leaseError) {
      if (leaseError instanceof LeaseLostError) return superseded(store, runId, runToken, dryRun, at);
      throw leaseError;
    }
  }
  return { ...(runId ? { runId } : {}), status: "degraded", items: [], events, error: message, dryRun };
}

function assertInvariantFields(item: ScanItem, before: JsonObject | undefined, fields: string[] | undefined): void {
  if (!before) return;
  for (const field of fields ?? []) {
    const previous = getPath(before, field);
    const current = itemValue(item, field);
    if (previous === undefined || current === undefined || canonicalJson(previous) !== canonicalJson(current)) {
      throw new Error(`item ${item.id} invariant field ${field} changed; quote/context is incomparable`);
    }
  }
}

function assertRuleInputs(collection: Collection, rules: Rule[]): void {
  for (const rule of rules) {
    if (rule.enabled === false || rule.type === "new_items" || rule.type === "llm_assessment") continue;
    for (const item of collection.items) {
      const value = getPath(item.data, rule.field);
      if (value === undefined || value === null) throw new Error(`item ${item.id} lacks rule field ${rule.field}`);
      if (rule.type === "field_changed") continue;
      const numeric = comparableNumber(value);
      if (!numeric) throw new Error(`item ${item.id} field ${rule.field} is not comparable numeric data`);
      if (rule.type === "crosses_below" && numeric.value < 0) throw new Error(`item ${item.id} field ${rule.field} must be non-negative`);
      if (rule.currency && numeric.currency !== rule.currency) throw new Error(`item ${item.id} field ${rule.field} currency ${numeric.currency ?? "missing"} does not match ${rule.currency}`);
    }
  }
}

function notificationTargets(monitor: Monitor, kind: ChangeEvent["kind"]): Array<{ channel: string; config: unknown }> {
  return (monitor.notifications ?? [{ type: "inbox" }])
    .filter((config) => config.enabled !== false)
    .map((config, index) => ({ channel: `${config.type}:${config.id ?? index}`, config }))
    .filter(({ config }) => config.events === undefined || config.events.includes(kind));
}

function evaluateRule(input: {
  monitor: Monitor; namespace: string; runId: string; rule: Exclude<Rule, AssessmentRule>; item: ScanItem; before: JsonObject | undefined;
  baselineExists: boolean; observedAt: string; store: Store;
}): ChangeEvent | undefined {
  const { monitor, namespace, runId, rule, item, before, baselineExists, observedAt, store } = input;
  const bootstrap = rule.bootstrap ?? "suppress_existing";
  const base = (kind: ChangeEvent["kind"], reason: string, oldValue: JsonValue | undefined, newValue: JsonValue): ChangeEvent => ({
    id: stableId(monitor.id, namespace, runId, rule.id, item.id, kind), monitorId: monitor.id, runId, namespace,
    ruleId: rule.id, kind, itemId: item.id, ...(item.title ? { title: item.title } : {}), ...(item.url ? { url: item.url } : {}),
    reason, before: oldValue, after: newValue, observedAt,
  });

  if (rule.type === "new_items") {
    if (before !== undefined || (!baselineExists && bootstrap === "suppress_existing")) return undefined;
    return base("new_item", "newly observed by SSS", undefined, item.data);
  }

  const field = rule.field;
  if (!field) return undefined;
  const afterValue = getPath(item.data, field);
  const beforeValue = before ? getPath(before, field) : undefined;
  if (afterValue === undefined) return undefined;

  if (rule.type === "field_changed") {
    if (beforeValue === undefined) {
      return !baselineExists && bootstrap === "evaluate_current" ? base("field_changed", `${field} observed`, undefined, afterValue) : undefined;
    }
    if (canonicalJson(beforeValue) === canonicalJson(afterValue)) return undefined;
    return base("field_changed", `${field} changed`, beforeValue, afterValue);
  }

  const current = comparableNumber(afterValue);
  if (!current || rule.type === "crosses_below" && current.value < 0) return undefined;
  if (rule.currency && current.currency !== rule.currency) return undefined;

  if (rule.type === "crosses_below") {
    const threshold = rule.thresholdMinor ?? rule.threshold;
    if (threshold === undefined) return undefined;
    const persisted = store.ruleState(monitor.id, namespace, rule.id, item.id);
    const wasArmed = typeof persisted?.["armed"] === "boolean" ? persisted["armed"] : true;
    const below = current.value < threshold;
    const emit = below && wasArmed && (baselineExists || bootstrap === "evaluate_current");
    store.setRuleState(monitor.id, namespace, rule.id, item.id, { armed: !below, last: current.value }, observedAt);
    const renderedThreshold = rule.thresholdMinor !== undefined && rule.currency ? formatMinorUnits(threshold, rule.currency) : String(threshold);
    return emit ? base("crosses_below", `${field} crossed below ${renderedThreshold}`, beforeValue, afterValue) : undefined;
  }

  if (beforeValue === undefined) return undefined;
  const previous = comparableNumber(beforeValue);
  if (!previous || previous.currency !== current.currency) return undefined;
  const absolute = Math.abs(current.value - previous.value);
  const percent = previous.value === 0 ? current.value === 0 ? 0 : Infinity : (absolute / Math.abs(previous.value)) * 100;
  const delta = current.value - previous.value;
  const directionMatches = rule.direction === undefined || rule.direction === "any" || (rule.direction === "increase" && delta > 0) || (rule.direction === "decrease" && delta < 0);
  const matches = directionMatches && ((rule.absolute !== undefined && absolute >= rule.absolute) || (rule.percent !== undefined && percent >= rule.percent));
  return matches ? base("numeric_delta", `${field} moved ${current.value - previous.value} (${percent.toFixed(1)}%)`, beforeValue, afterValue) : undefined;
}

export function assertCollection(collection: Collection, assertions: AssertionConfig = {}): void {
  if (!collection || !Array.isArray(collection.items)) throw new Error("source returned no item list");
  if (collection.items.length > MAX_SOURCE_ITEMS) throw new Error(`source exceeded the hard limit of ${MAX_SOURCE_ITEMS} items`);
  const min = assertions.allowEmpty ? 0 : assertions.minItems ?? 1;
  if (collection.items.length < min) throw new Error(`extracted ${collection.items.length} items; require at least ${min}`);
  if (assertions.maxItems !== undefined && collection.items.length > assertions.maxItems) throw new Error(`extracted ${collection.items.length} items; maximum ${assertions.maxItems}`);
  const ids = new Set<string>();
  const configuredKeys = new Set<string>();
  for (const item of collection.items) {
    if (!item.id.trim()) throw new Error("item has an empty identity");
    if (ids.has(item.id)) throw new Error(`duplicate item identity: ${item.id}`);
    ids.add(item.id);
    if (assertions.uniqueBy) {
      const value = itemValue(item, assertions.uniqueBy);
      if (value === undefined || value === null) throw new Error(`item ${item.id} lacks unique field ${assertions.uniqueBy}`);
      const key = canonicalJson(value);
      if (configuredKeys.has(key)) throw new Error(`duplicate ${assertions.uniqueBy}: ${key}`);
      configuredKeys.add(key);
    }
    for (const field of assertions.requiredFields ?? []) {
      const value = itemValue(item, field);
      if (value === undefined || value === null || typeof value === "string" && value.trim() === "") throw new Error(`item ${item.id} lacks required field ${field}`);
    }
  }
}

function itemValue(item: ScanItem, field: string): JsonValue | undefined {
  if (field === "id") return item.id;
  if (field === "title") return item.title;
  if (field === "url") return item.url;
  if (field === "publishedAt") return item.publishedAt;
  return getPath(item.data, field);
}

function safeMessage(error: unknown): string { return safeErrorMessage(error, 500); }
