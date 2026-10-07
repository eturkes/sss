import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChangeEvent, JsonObject, MonitorStatus, RunStatus, ScanItem } from "../core/types.ts";

type SqlValue = string | number | bigint | null | Uint8Array;
type ExistingItem = { item_key: string; content_hash: string; data_json: string; title: string | null; url: string | null };

export type ClaimedMonitor = { id: string; configJson: string; namespace: string; scheduledFor: string; leaseToken: string };
export type RunLease = { id: string; token: string };
export type DeliveryRow = { id: string; eventId: string; channel: string; configJson: string; attempts: number; leaseToken: string };
export type ObservationRow = { runId: string; monitorId: string; namespace: string; itemId: string; hash: string; data: JsonObject; title: string | null; url: string | null; observedAt: string };
export type DeliveryHealth = { pending: number; sending: number; failed: number; lastError: string | null };

export class LeaseLostError extends Error {
  readonly code = "SSS_LEASE_LOST";

  constructor(resource: string) {
    super(`${resource} lease was superseded`);
    this.name = "LeaseLostError";
  }
}

const MIGRATION = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  namespace TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_due_at TEXT,
  lease_until TEXT,
  lease_token TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  error_streak INTEGER NOT NULL DEFAULT 0,
  health_alerted INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS monitors_due ON monitors(enabled, next_due_at);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  item_count INTEGER,
  event_count INTEGER,
  error TEXT,
  attempt_token TEXT,
  UNIQUE(monitor_id, scheduled_for)
) STRICT;
CREATE INDEX IF NOT EXISTS runs_monitor_started ON runs(monitor_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_running ON runs(monitor_id) WHERE status='running';
CREATE TABLE IF NOT EXISTS namespaces (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  initialized INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT,
  PRIMARY KEY(monitor_id, namespace)
) STRICT;
CREATE TABLE IF NOT EXISTS items (
  monitor_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  item_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  data_json TEXT NOT NULL,
  title TEXT,
  url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(monitor_id, namespace, item_key),
  FOREIGN KEY(monitor_id, namespace) REFERENCES namespaces(monitor_id, namespace) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  item_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  data_json TEXT NOT NULL,
  title TEXT,
  url TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE(run_id, item_key)
) STRICT;
CREATE INDEX IF NOT EXISTS observations_item_time ON observations(monitor_id,item_key,observed_at DESC);
CREATE INDEX IF NOT EXISTS observations_monitor_time ON observations(monitor_id,observed_at DESC);
CREATE TABLE IF NOT EXISTS rule_state (
  monitor_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(monitor_id, namespace, rule_id, item_key),
  FOREIGN KEY(monitor_id, namespace) REFERENCES namespaces(monitor_id, namespace) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_key TEXT NOT NULL,
  title TEXT,
  url TEXT,
  reason TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS events_observed ON events(observed_at DESC);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  lease_token TEXT,
  sent_at TEXT,
  last_error TEXT,
  UNIQUE(event_id, channel)
) STRICT;
CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(status, next_attempt_at);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ".sss/sss.db") {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    this.db = new DatabaseSync(path, { timeout: 5_000, defensive: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(MIGRATION);
    this.migrate();
    if (path !== ":memory:") chmodSync(path, 0o600);
  }

  private migrate(): void {
    const versionRow = this.db.prepare("PRAGMA user_version").get() as Record<string, SqlValue>;
    const version = Number(versionRow["user_version"]);
    if (version > 3) throw new Error(`SSS database schema ${version} is newer than supported schema 3`);
    this.transaction(() => {
      addColumn(this.db, "runs", "attempt_token", "TEXT");
      addColumn(this.db, "deliveries", "lease_token", "TEXT");
      addColumn(this.db, "monitors", "health_alerted", "INTEGER NOT NULL DEFAULT 0");
      this.db.exec("PRAGMA user_version = 3");
    });
  }

  close(): void { this.db.close(); }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  syncMonitor(
    config: { id: string; name: string; enabled: boolean }, configJson: string, namespace: string, nextDueAt: string,
    acquisitionFrom?: { namespace: string; configJson: string },
  ): void {
    if (acquisitionFrom) {
      this.transaction(() => {
        const previous = this.monitor(config.id);
        if (previous?.namespace !== acquisitionFrom.namespace || previous.configJson !== acquisitionFrom.configJson) {
          throw new LeaseLostError(`configuration ${config.id}`);
        }
        if (this.db.prepare("SELECT 1 FROM runs WHERE monitor_id=? AND status='running'").get(config.id)) {
          throw new Error(`monitor ${config.id} has an active scan; retry the policy transition after it finishes`);
        }
        this.syncMonitor(config, configJson, namespace, nextDueAt);
        if (namespace === acquisitionFrom.namespace || this.initialized(config.id, namespace) || !this.initialized(config.id, acquisitionFrom.namespace)) return;
        if (this.db.prepare("SELECT 1 FROM items WHERE monitor_id=? AND namespace=?").get(config.id, namespace) ||
            this.db.prepare("SELECT 1 FROM rule_state WHERE monitor_id=? AND namespace=?").get(config.id, namespace)) {
          throw new Error(`acquisition target ${config.id}/${namespace} must be empty`);
        }
        // Identical acquisition semantics permit raw history reuse; judgments always stay in their original namespace.
        this.db.prepare(`INSERT INTO items(monitor_id,namespace,item_key,content_hash,data_json,title,url,first_seen_at,last_seen_at,active)
          SELECT monitor_id,?,item_key,content_hash,data_json,title,url,first_seen_at,last_seen_at,active
          FROM items WHERE monitor_id=? AND namespace=?`).run(namespace, config.id, acquisitionFrom.namespace);
        this.db.prepare(`UPDATE namespaces SET initialized=1,accepted_at=(
          SELECT accepted_at FROM namespaces WHERE monitor_id=? AND namespace=?
        ) WHERE monitor_id=? AND namespace=?`).run(config.id, acquisitionFrom.namespace, config.id, namespace);
      });
      return;
    }
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT config_json,namespace,next_due_at FROM monitors WHERE id=?").get(config.id) as Record<string, SqlValue> | undefined;
    const configUnchanged = existing?.["config_json"] === configJson;
    const scheduleUnchanged = existing !== undefined && sameSchedule(String(existing["config_json"]), configJson);
    const namespaceUnchanged = existing?.["namespace"] === namespace;
    let effectiveNextDue = nextDueAt;
    if (existing?.["next_due_at"] && scheduleUnchanged) effectiveNextDue = String(existing["next_due_at"]);
    this.db.prepare(`INSERT INTO monitors(id,name,config_json,namespace,enabled,next_due_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config_json=excluded.config_json,
      namespace=excluded.namespace,enabled=excluded.enabled,updated_at=excluded.updated_at,
      next_due_at=excluded.next_due_at,
      lease_until=CASE WHEN ? THEN monitors.lease_until ELSE NULL END,
      lease_token=CASE WHEN ? THEN monitors.lease_token ELSE NULL END`)
      .run(config.id, config.name, configJson, namespace, config.enabled ? 1 : 0, effectiveNextDue, now, now,
        configUnchanged && namespaceUnchanged ? 1 : 0, configUnchanged && namespaceUnchanged ? 1 : 0);
    this.db.prepare("INSERT OR IGNORE INTO namespaces(monitor_id,namespace) VALUES(?,?)").run(config.id, namespace);
  }

  disableMissing(ids: string[]): void {
    if (ids.length === 0) {
      this.db.exec("UPDATE monitors SET enabled=0,lease_until=NULL,lease_token=NULL");
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(`UPDATE monitors SET enabled=0,lease_until=NULL,lease_token=NULL WHERE id NOT IN (${placeholders})`).run(...ids);
  }

  deleteMonitor(id: string): void {
    this.db.prepare("DELETE FROM monitors WHERE id=?").run(id);
  }

  status(): MonitorStatus[] {
    return this.db.prepare(`SELECT id,name,enabled,namespace,next_due_at,last_attempt_at,last_success_at,error_streak,health_alerted,last_error,lease_until
      FROM monitors ORDER BY id`).all().map((raw) => {
      const row = raw as Record<string, SqlValue>;
      return {
        id: String(row["id"]), name: String(row["name"]), enabled: Number(row["enabled"]) === 1,
        namespace: String(row["namespace"]), nextDueAt: nullableString(row["next_due_at"]),
        lastAttemptAt: nullableString(row["last_attempt_at"]), lastSuccessAt: nullableString(row["last_success_at"]),
        errorStreak: Number(row["error_streak"]), healthAlerted: Number(row["health_alerted"]) === 1,
        lastError: nullableString(row["last_error"]), leaseUntil: nullableString(row["lease_until"]),
      };
    });
  }

  monitor(id: string): { configJson: string; namespace: string } | undefined {
    const row = this.db.prepare("SELECT config_json,namespace FROM monitors WHERE id=?").get(id) as Record<string, SqlValue> | undefined;
    return row ? { configJson: String(row["config_json"]), namespace: String(row["namespace"]) } : undefined;
  }

  beginRun(monitorId: string, namespace: string, scheduledFor: string, now: string, staleBefore: string): RunLease {
    return this.transaction(() => {
      const stale = this.db.prepare(`UPDATE runs SET ended_at=?,status='degraded',error='stale running attempt superseded'
        WHERE monitor_id=? AND status='running' AND started_at<?`).run(now, monitorId, staleBefore);
      if (stale.changes > 0) this.db.prepare("UPDATE monitors SET error_streak=error_streak+?,last_error='stale running attempt superseded' WHERE id=?")
        .run(stale.changes, monitorId);
      const existing = this.db.prepare("SELECT id,status,error FROM runs WHERE monitor_id=? AND scheduled_for=?")
        .get(monitorId, scheduledFor) as Record<string, SqlValue> | undefined;
      const token = randomUUID();
      let id: string;
      if (existing?.["status"] === "degraded" && existing["error"] === "stale running attempt superseded") {
        id = String(existing["id"]);
        const revived = this.db.prepare(`UPDATE runs SET namespace=?,started_at=?,ended_at=NULL,status='running',item_count=NULL,event_count=NULL,error=NULL,attempt_token=?
          WHERE id=? AND status='degraded' AND error='stale running attempt superseded'`).run(namespace, now, token, id);
        if (revived.changes !== 1) throw new LeaseLostError(`run ${id}`);
      } else {
        id = randomUUID();
        this.db.prepare("INSERT INTO runs(id,monitor_id,namespace,scheduled_for,started_at,status,attempt_token) VALUES(?,?,?,?,?,'running',?)")
          .run(id, monitorId, namespace, scheduledFor, now, token);
      }
      this.db.prepare("UPDATE monitors SET last_attempt_at=? WHERE id=?").run(now, monitorId);
      return { id, token };
    });
  }

  assertRunLease(runId: string, token: string): void {
    const row = this.db.prepare("SELECT 1 AS active FROM runs WHERE id=? AND attempt_token=? AND status='running'").get(runId, token) as Record<string, SqlValue> | undefined;
    if (!row) throw new LeaseLostError(`run ${runId}`);
  }

  assertMonitorLease(monitorId: string, token: string): void {
    const row = this.db.prepare("SELECT 1 AS active FROM monitors WHERE id=? AND lease_token=?").get(monitorId, token) as Record<string, SqlValue> | undefined;
    if (!row) throw new LeaseLostError(`monitor ${monitorId}`);
  }

  renewMonitorLease(monitorId: string, token: string, now: string, leaseUntil: string): void {
    const renewed = this.db.prepare("UPDATE monitors SET lease_until=? WHERE id=? AND lease_token=? AND lease_until>=?")
      .run(leaseUntil, monitorId, token, now);
    if (renewed.changes !== 1) throw new LeaseLostError(`monitor ${monitorId}`);
  }

  abandonRun(runId: string, token: string, at: string, error: string): boolean {
    return this.db.prepare("UPDATE runs SET ended_at=?,status='degraded',error=? WHERE id=? AND attempt_token=? AND status='running'")
      .run(at, error, runId, token).changes === 1;
  }

  finishRun(runId: string, token: string, monitorId: string, status: RunStatus, at: string, itemCount: number, eventCount: number, error?: string): void {
    const finished = this.db.prepare("UPDATE runs SET ended_at=?,status=?,item_count=?,event_count=?,error=? WHERE id=? AND attempt_token=? AND status='running'")
      .run(at, status, itemCount, eventCount, error ?? null, runId, token);
    if (finished.changes !== 1) throw new LeaseLostError(`run ${runId}`);
    if (status === "degraded") {
      this.db.prepare("UPDATE monitors SET error_streak=error_streak+1,last_error=? WHERE id=?").run(error ?? "scan degraded", monitorId);
    } else {
      this.db.prepare("UPDATE monitors SET last_success_at=?,error_streak=0,last_error=NULL WHERE id=?").run(at, monitorId);
    }
  }

  setHealthAlerted(monitorId: string, alerted: boolean): void {
    this.db.prepare("UPDATE monitors SET health_alerted=? WHERE id=?").run(alerted ? 1 : 0, monitorId);
  }

  healthAlerted(monitorId: string): boolean {
    const row = this.db.prepare("SELECT health_alerted FROM monitors WHERE id=?").get(monitorId) as Record<string, SqlValue> | undefined;
    return Number(row?.["health_alerted"] ?? 0) === 1;
  }

  initialized(monitorId: string, namespace: string): boolean {
    const row = this.db.prepare("SELECT initialized FROM namespaces WHERE monitor_id=? AND namespace=?").get(monitorId, namespace) as Record<string, SqlValue> | undefined;
    return Number(row?.["initialized"] ?? 0) === 1;
  }

  existingItems(monitorId: string, namespace: string): Map<string, ExistingItem> {
    const rows = this.db.prepare("SELECT item_key,content_hash,data_json,title,url FROM items WHERE monitor_id=? AND namespace=?")
      .all(monitorId, namespace) as unknown as ExistingItem[];
    return new Map(rows.map((row) => [row.item_key, row]));
  }

  bootstrapItemIds(monitorId: string, namespace: string): string[] {
    return this.db.prepare(`SELECT item_key FROM items WHERE monitor_id=? AND namespace=?
      AND first_seen_at=(SELECT MIN(first_seen_at) FROM items WHERE monitor_id=? AND namespace=?) ORDER BY item_key`)
      .all(monitorId, namespace, monitorId, namespace).map((row) => String(row["item_key"]));
  }

  ruleState(monitorId: string, namespace: string, ruleId: string, itemId: string): JsonObject | undefined {
    const row = this.db.prepare("SELECT state_json FROM rule_state WHERE monitor_id=? AND namespace=? AND rule_id=? AND item_key=?")
      .get(monitorId, namespace, ruleId, itemId) as Record<string, SqlValue> | undefined;
    return row ? JSON.parse(String(row["state_json"])) as JsonObject : undefined;
  }

  setRuleState(monitorId: string, namespace: string, ruleId: string, itemId: string, state: JsonObject, at: string): void {
    this.db.prepare(`INSERT INTO rule_state(monitor_id,namespace,rule_id,item_key,state_json,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(monitor_id,namespace,rule_id,item_key) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at`)
      .run(monitorId, namespace, ruleId, itemId, JSON.stringify(state), at);
  }

  acceptItems(runId: string, monitorId: string, namespace: string, items: Array<ScanItem & { hash: string }>, at: string): void {
    this.db.prepare("UPDATE items SET active=0 WHERE monitor_id=? AND namespace=?").run(monitorId, namespace);
    const observe = this.db.prepare(`INSERT OR IGNORE INTO observations(run_id,monitor_id,namespace,item_key,content_hash,data_json,title,url,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    const statement = this.db.prepare(`INSERT INTO items(monitor_id,namespace,item_key,content_hash,data_json,title,url,first_seen_at,last_seen_at,active)
      VALUES(?,?,?,?,?,?,?,?,?,1) ON CONFLICT(monitor_id,namespace,item_key) DO UPDATE SET content_hash=excluded.content_hash,
      data_json=excluded.data_json,title=excluded.title,url=excluded.url,last_seen_at=excluded.last_seen_at,active=1`);
    for (const item of items) {
      observe.run(runId, monitorId, namespace, item.id, item.hash, JSON.stringify(item.data), item.title ?? null, item.url ?? null, at);
      statement.run(monitorId, namespace, item.id, item.hash, JSON.stringify(item.data), item.title ?? null, item.url ?? null, at, at);
    }
    this.db.prepare("UPDATE namespaces SET initialized=1,accepted_at=? WHERE monitor_id=? AND namespace=?").run(at, monitorId, namespace);
  }

  observations(monitorId: string, itemId?: string, limit = 100): ObservationRow[] {
    const rows = itemId
      ? this.db.prepare(`SELECT run_id,monitor_id,namespace,item_key,content_hash,data_json,title,url,observed_at
          FROM observations WHERE monitor_id=? AND item_key=? ORDER BY observed_at DESC LIMIT ?`).all(monitorId,itemId,limit)
      : this.db.prepare(`SELECT run_id,monitor_id,namespace,item_key,content_hash,data_json,title,url,observed_at
          FROM observations WHERE monitor_id=? ORDER BY observed_at DESC LIMIT ?`).all(monitorId,limit);
    return (rows as Array<Record<string, SqlValue>>).map((row) => ({
      runId:String(row["run_id"]),monitorId:String(row["monitor_id"]),namespace:String(row["namespace"]),itemId:String(row["item_key"]),
      hash:String(row["content_hash"]),data:JSON.parse(String(row["data_json"])) as JsonObject,title:nullableString(row["title"]),
      url:nullableString(row["url"]),observedAt:String(row["observed_at"]),
    }));
  }

  insertEvent(event: ChangeEvent, notifications: Array<{ channel: string; config: unknown }>): void {
    this.db.prepare(`INSERT OR IGNORE INTO events(id,monitor_id,run_id,namespace,rule_id,kind,item_key,title,url,reason,before_json,after_json,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.id,event.monitorId,event.runId,event.namespace,event.ruleId,event.kind,event.itemId,
      event.title ?? null,event.url ?? null,event.reason,event.before === undefined ? null : JSON.stringify(event.before),JSON.stringify(event.after),event.observedAt);
    const delivery = this.db.prepare(`INSERT OR IGNORE INTO deliveries(id,event_id,channel,config_json,next_attempt_at) VALUES(?,?,?,?,?)`);
    for (const notification of notifications) {
      if (notification.channel === "inbox" || notification.channel.startsWith("inbox:")) continue;
      delivery.run(`${event.id}:${notification.channel}`, event.id, notification.channel, JSON.stringify(notification.config), event.observedAt);
    }
  }

  events(limit = 100): ChangeEvent[] {
    const rows = this.db.prepare(`SELECT id,monitor_id,run_id,namespace,rule_id,kind,item_key,title,url,reason,before_json,after_json,observed_at
      FROM events ORDER BY observed_at DESC LIMIT ?`).all(limit) as Array<Record<string, SqlValue>>;
    return rows.map((row) => ({
      id:String(row["id"]),monitorId:String(row["monitor_id"]),runId:String(row["run_id"]),namespace:String(row["namespace"]),
      ruleId:String(row["rule_id"]),kind:String(row["kind"]) as ChangeEvent["kind"],itemId:String(row["item_key"]),
      ...(row["title"] === null ? {} : {title:String(row["title"])}), ...(row["url"] === null ? {} : {url:String(row["url"])}),
      reason:String(row["reason"]), before:row["before_json"] === null ? undefined : JSON.parse(String(row["before_json"])),
      after:JSON.parse(String(row["after_json"])), observedAt:String(row["observed_at"]),
    }));
  }

  claimDeliveries(now: string, leaseUntil: string, limit = 20): DeliveryRow[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT id,event_id,channel,config_json,attempts FROM deliveries
        WHERE next_attempt_at<=? AND ((status IN ('pending','failed') AND (lease_until IS NULL OR lease_until<?))
          OR (status='sending' AND lease_until<?)) ORDER BY next_attempt_at LIMIT ?`)
        .all(now, now, now, limit) as Array<Record<string, SqlValue>>;
      const claim = this.db.prepare("UPDATE deliveries SET status='sending',lease_until=?,lease_token=? WHERE id=?");
      return rows.map((row) => {
        const leaseToken = randomUUID();
        claim.run(leaseUntil, leaseToken, row["id"] as string);
        return { id:String(row["id"]),eventId:String(row["event_id"]),channel:String(row["channel"]),configJson:String(row["config_json"]),attempts:Number(row["attempts"]),leaseToken };
      });
    });
  }

  deliveryHealth(): DeliveryHealth {
    const rows = this.db.prepare("SELECT status,COUNT(*) AS count FROM deliveries WHERE status!='sent' GROUP BY status").all() as Array<Record<string, SqlValue>>;
    const counts = Object.fromEntries(rows.map((row) => [String(row["status"]), Number(row["count"])]));
    const error = this.db.prepare("SELECT last_error FROM deliveries WHERE status='failed' ORDER BY next_attempt_at DESC LIMIT 1").get() as Record<string, SqlValue> | undefined;
    return { pending: counts["pending"] ?? 0, sending: counts["sending"] ?? 0, failed: counts["failed"] ?? 0, lastError: nullableString(error?.["last_error"]) };
  }

  failedDeliveries(limit = 100): Array<Record<string, SqlValue>> {
    return this.db.prepare(`SELECT id,event_id,channel,status,attempts,next_attempt_at,last_error
      FROM deliveries WHERE status!='sent' ORDER BY next_attempt_at LIMIT ?`).all(limit) as Array<Record<string, SqlValue>>;
  }

  event(id: string): ChangeEvent | undefined {
    const all = this.db.prepare(`SELECT id,monitor_id,run_id,namespace,rule_id,kind,item_key,title,url,reason,before_json,after_json,observed_at FROM events WHERE id=?`).get(id) as Record<string, SqlValue> | undefined;
    if (!all) return undefined;
    return {id:String(all["id"]),monitorId:String(all["monitor_id"]),runId:String(all["run_id"]),namespace:String(all["namespace"]),ruleId:String(all["rule_id"]),kind:String(all["kind"]) as ChangeEvent["kind"],itemId:String(all["item_key"]),...(all["title"]===null?{}:{title:String(all["title"])}),...(all["url"]===null?{}:{url:String(all["url"])}),reason:String(all["reason"]),before:all["before_json"]===null?undefined:JSON.parse(String(all["before_json"])),after:JSON.parse(String(all["after_json"])),observedAt:String(all["observed_at"])};
  }

  finishDelivery(id: string, leaseToken: string, at: string): boolean {
    return this.db.prepare("UPDATE deliveries SET status='sent',sent_at=?,lease_until=NULL,lease_token=NULL,last_error=NULL WHERE id=? AND status='sending' AND lease_token=?")
      .run(at,id,leaseToken).changes === 1;
  }

  failDelivery(id: string, leaseToken: string, error: string, nextAttemptAt: string): boolean {
    return this.db.prepare("UPDATE deliveries SET status='failed',attempts=attempts+1,last_error=?,next_attempt_at=?,lease_until=NULL,lease_token=NULL WHERE id=? AND status='sending' AND lease_token=?")
      .run(error,nextAttemptAt,id,leaseToken).changes === 1;
  }

  claimMonitor(monitorId: string, now: string, leaseUntil: string): ClaimedMonitor | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT id,config_json,namespace,next_due_at FROM monitors WHERE id=? AND (lease_until IS NULL OR lease_until<?)")
        .get(monitorId, now) as Record<string, SqlValue> | undefined;
      if (!row) return undefined;
      const token = randomUUID();
      const claimed = this.db.prepare("UPDATE monitors SET lease_until=?,lease_token=? WHERE id=? AND (lease_until IS NULL OR lease_until<?)")
        .run(leaseUntil, token, monitorId, now);
      if (claimed.changes !== 1) return undefined;
      return { id:String(row["id"]),configJson:String(row["config_json"]),namespace:String(row["namespace"]),scheduledFor:String(row["next_due_at"]),leaseToken:token };
    });
  }

  completeClaim(monitorId: string, nextDueAt: string, leaseToken: string): boolean {
    return this.db.prepare("UPDATE monitors SET next_due_at=?,lease_until=NULL,lease_token=NULL WHERE id=? AND lease_token=?")
      .run(nextDueAt, monitorId, leaseToken).changes === 1;
  }

  claimDue(now: string, leaseUntil: string, limit = 8): ClaimedMonitor[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT id,config_json,namespace,next_due_at FROM monitors WHERE enabled=1 AND next_due_at<=?
        AND (lease_until IS NULL OR lease_until<?) ORDER BY next_due_at LIMIT ?`).all(now,now,limit) as Array<Record<string, SqlValue>>;
      const update = this.db.prepare("UPDATE monitors SET lease_until=?,lease_token=? WHERE id=? AND (lease_until IS NULL OR lease_until<?)");
      const claimed: ClaimedMonitor[] = [];
      for (const row of rows) {
        const token = randomUUID();
        const result = update.run(leaseUntil,token,row["id"] as string,now);
        if (result.changes === 1) claimed.push({id:String(row["id"]),configJson:String(row["config_json"]),namespace:String(row["namespace"]),scheduledFor:String(row["next_due_at"]),leaseToken:token});
      }
      return claimed;
    });
  }

  recentRuns(limit = 50): Array<Record<string, SqlValue>> {
    return this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as Array<Record<string, SqlValue>>;
  }

  prune(observationsBefore: string, runsBefore: string): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM observations WHERE observed_at<? AND id NOT IN (
        SELECT MAX(id) FROM observations GROUP BY monitor_id,namespace,item_key
      )`).run(observationsBefore);
      this.db.prepare(`DELETE FROM runs WHERE started_at<? AND status!='running'
        AND id NOT IN (SELECT DISTINCT run_id FROM events)
        AND id NOT IN (SELECT DISTINCT run_id FROM observations)`)
        .run(runsBefore);
      this.db.prepare("DELETE FROM deliveries WHERE status='sent' AND sent_at<?").run(runsBefore);
    });
  }
}

function nullableString(value: SqlValue | undefined): string | null { return value === null || value === undefined ? null : String(value); }

function sameSchedule(leftJson: string, rightJson: string): boolean {
  try {
    const left = JSON.parse(leftJson) as { schedule?: unknown };
    const right = JSON.parse(rightJson) as { schedule?: unknown };
    return JSON.stringify(left.schedule) === JSON.stringify(right.schedule);
  } catch { return false; }
}

function addColumn(database: DatabaseSync, table: string, name: string, declaration: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, SqlValue>>;
  if (!columns.some((column) => column["name"] === name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
}
