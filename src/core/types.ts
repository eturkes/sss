export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ScanItem = {
  id: string;
  url?: string;
  title?: string;
  publishedAt?: string;
  data: JsonObject;
};

export type Collection = {
  items: ScanItem[];
  fetchedAt: string;
  diagnostics?: string[];
};

export type RunStatus = "running" | "ok_changed" | "ok_unchanged" | "degraded";

export type EventKind = "new_item" | "field_changed" | "crosses_below" | "numeric_delta" | "llm_assessment" | "health_degraded" | "health_recovered";

export type ChangeEvent = {
  id: string;
  monitorId: string;
  runId: string;
  namespace: string;
  ruleId: string;
  kind: EventKind;
  itemId: string;
  title?: string;
  url?: string;
  reason: string;
  before: JsonValue | undefined;
  after: JsonValue;
  observedAt: string;
};

export type MonitorStatus = {
  id: string;
  name: string;
  enabled: boolean;
  namespace: string;
  nextDueAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  errorStreak: number;
  healthAlerted: boolean;
  lastError: string | null;
  leaseUntil: string | null;
};
