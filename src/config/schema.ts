import { createHash } from "node:crypto";

import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { isCurrencyCode } from "../core/money.ts";

export const SAFE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(SAFE_ID_PATTERN, "use lowercase letters, numbers, '-' or '_'; start with a letter");

export const fieldNameSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "use a field name/path without brackets or whitespace");

export const dottedPathSchema = z.string().min(1).max(500).superRefine((path, context) => {
  const segments = path.split(".");
  if (path.startsWith(".") || path.endsWith(".") || segments.some((segment) =>
    !/^[A-Za-z0-9_$-]+$/.test(segment) || segment === "$" || ["__proto__", "prototype", "constructor"].includes(segment)
  )) context.addIssue({ code: "custom", message: "use a safe dotted path", path: [] });
});

const comparableFieldSchema = fieldNameSchema.superRefine((path, context) => {
  if (path.split(".").some((segment) => ["__proto__", "prototype", "constructor"].includes(segment))) {
    context.addIssue({ code: "custom", message: "use a safe dotted field path" });
  }
});

export const durationSchema = z
  .string()
  .regex(/^[1-9]\d*(?:s|m|h|d|w)$/, "use a positive integer followed by s, m, h, d, or w");

export const httpUrlSchema = z
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "use an http or https URL")
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "URL credentials are forbidden; use a secret reference")
  .refine((value) => {
    try {
      return [...new URL(value).searchParams.keys()].every((name) => !/^(?:access[-_]?key|api[-_]?key|authorization|auth[-_]?token|credential|signature|token|secret|password)$/i.test(name));
    } catch { return true; }
  }, "URL query secrets are forbidden; use an environment-backed header");

export const secretRefSchema = z
  .object({
    env: z.string().regex(ENV_NAME_PATTERN, "use an environment variable name"),
  })
  .strict();

export type SecretRef = z.infer<typeof secretRefSchema>;

const sensitiveHeaderName = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-auth-token|.*(?:api[-_]?key|auth|credential|signature|token|secret|password).*)$/i;
const forbiddenHeaderName = /^(?:connection|content-length|host|proxy-connection|transfer-encoding|upgrade)$/i;
const validHeaderName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export const headersSchema = z
  .record(z.string().min(1), z.union([z.string(), secretRefSchema]))
  .superRefine((headers, context) => {
    for (const [name, value] of Object.entries(headers)) {
      if (!validHeaderName.test(name) || forbiddenHeaderName.test(name)) {
        context.addIssue({ code: "custom", message: `header '${name}' is forbidden`, path: [name] });
      }
      if (typeof value === "string" && /[\u0000-\u0008\u000A-\u001F\u007F]/u.test(value)) {
        context.addIssue({ code: "custom", message: `header '${name}' has an invalid value`, path: [name] });
      }
      if (sensitiveHeaderName.test(name) && typeof value === "string") {
        context.addIssue({
          code: "custom",
          message: `sensitive header '${name}' must use { env: ENV_NAME }`,
          path: [name],
        });
      }
    }
  });

function requireSecureSecrets(
  value: { url: string; headers?: Record<string, string | SecretRef> | undefined },
  context: z.RefinementCtx,
): void {
  let protocol: string;
  try { protocol = new URL(value.url).protocol; } catch { return; }
  if (protocol === "http:" && Object.values(value.headers ?? {}).some((header) => typeof header !== "string")) {
    context.addIssue({ code: "custom", message: "environment-backed credentials require HTTPS", path: ["url"] });
  }
}

export type HeadersConfig = z.infer<typeof headersSchema>;

export const headerEnvSchema = z.record(
  z.string().min(1),
  z.string().regex(ENV_NAME_PATTERN, "use an environment variable name"),
).superRefine((headers, context) => {
  for (const name of Object.keys(headers)) {
    if (!validHeaderName.test(name) || forbiddenHeaderName.test(name)) context.addIssue({ code: "custom", message: `header '${name}' is forbidden`, path: [name] });
  }
});

export const scheduleSchema = z.union([
  z.object({ every: durationSchema }).strict().superRefine((schedule, context) => {
    const match = /^(\d+)(s|m|h|d|w)$/.exec(schedule.every);
    const count = Number(match?.[1]);
    const multiplier = ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as Record<string, number>)[match?.[2] ?? ""];
    const milliseconds = count * (multiplier ?? 0);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 10_000 || milliseconds > 365 * 86_400_000) context.addIssue({ code: "custom", message: "interval must be between 10 seconds and 365 days", path: ["every"] });
  }),
  z
    .object({
      cron: z.string().trim().min(1).max(256),
      timezone: z.string().trim().min(1).max(100).optional(),
    })
    .strict()
    .superRefine((schedule, context) => {
      try {
        CronExpressionParser.parse(schedule.cron, { currentDate: new Date(), tz: schedule.timezone ?? "UTC" });
      } catch (error) {
        context.addIssue({ code: "custom", message: `invalid cron/timezone: ${error instanceof Error ? error.message : String(error)}`, path: ["cron"] });
      }
    }),
]);

export type Schedule = z.infer<typeof scheduleSchema>;
export type MonitorSchedule = Schedule;

export const scalarTypeSchema = z.enum(["string", "number", "integer", "boolean", "money"]);

const currencySchema = z.string().regex(/^[A-Z]{3}$/, "use an ISO 4217 currency code").refine(isCurrencyCode, "use a supported ISO 4217 currency code");

const typedFieldShape = {
  type: scalarTypeSchema.optional(),
  currency: currencySchema.optional(),
};

function validateCurrency(
  value: { type?: z.infer<typeof scalarTypeSchema> | undefined; currency?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (value.currency !== undefined && value.type !== "money") {
    context.addIssue({
      code: "custom",
      message: "currency is valid only when type is 'money'",
      path: ["currency"],
    });
  }
  if (value.type === "money" && value.currency === undefined) {
    context.addIssue({ code: "custom", message: "money fields require an explicit currency", path: ["currency"] });
  }
}

export const jsonFieldSchema = z.union([
  dottedPathSchema,
  z
    .object({
      path: dottedPathSchema,
      ...typedFieldShape,
    })
    .strict()
    .superRefine(validateCurrency),
]);

export const htmlFieldSchema = z
  .object({
    selector: z.string().trim().min(1).max(1_000).optional(),
    attribute: z.string().trim().min(1).max(200).optional(),
    ...typedFieldShape,
  })
  .strict()
  .superRefine(validateCurrency);

function nonEmptyFieldRecord<T extends z.ZodType>(valueSchema: T) {
  return z
    .record(fieldNameSchema, valueSchema)
    .refine((fields) => Object.keys(fields).length > 0, "define at least one field");
}

export const feedSourceSchema = z
  .object({
    type: z.literal("feed"),
    url: httpUrlSchema,
    headers: headersSchema.optional(),
    keywords: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    exclude: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    includeKeywords: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    excludeKeywords: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  })
  .strict()
  .superRefine((source, context) => {
    requireSecureSecrets(source, context);
    if (source.keywords !== undefined && source.includeKeywords !== undefined) {
      context.addIssue({
        code: "custom",
        message: "use keywords or includeKeywords, not both",
        path: ["keywords"],
      });
    }
    if (source.exclude !== undefined && source.excludeKeywords !== undefined) {
      context.addIssue({
        code: "custom",
        message: "use exclude or excludeKeywords, not both",
        path: ["exclude"],
      });
    }
  });

export const jsonSourceSchema = z
  .object({
    type: z.literal("json"),
    url: httpUrlSchema,
    headers: headersSchema.optional(),
    itemsPath: dottedPathSchema.optional(),
    fields: nonEmptyFieldRecord(jsonFieldSchema).optional(),
  })
  .strict()
  .superRefine((source, context) => {
    requireSecureSecrets(source, context);
    if (source.itemsPath && source.fields && !hasIdentityField(source.fields)) {
      context.addIssue({ code: "custom", message: "mapped JSON lists require an identity field (doi, arxivId, id, identifier, url, or link)", path: ["fields"] });
    }
  });

export const htmlSourceSchema = z
  .object({
    type: z.literal("html"),
    url: httpUrlSchema,
    headers: headersSchema.optional(),
    itemSelector: z.string().trim().min(1).max(1_000).optional(),
    fields: nonEmptyFieldRecord(htmlFieldSchema),
  })
  .strict()
  .superRefine((source, context) => {
    requireSecureSecrets(source, context);
    if (source.itemSelector && !hasIdentityField(source.fields)) {
      context.addIssue({ code: "custom", message: "HTML lists require an identity field (doi, arxivId, id, identifier, url, or link)", path: ["fields"] });
    }
  });

function hasIdentityField(fields: Record<string, unknown>): boolean {
  return Object.keys(fields).some((name) => ["doi", "arxivId", "arxiv", "id", "identifier", "url", "link"].includes(name));
}

const openAlexFilterValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
]);

export const openAlexSourceSchema = z
  .object({
    type: z.literal("openalex"),
    query: z.string().trim().min(1).max(1_000),
    filter: z.record(z.string().min(1), openAlexFilterValueSchema).optional(),
    filters: z.record(z.string().min(1), openAlexFilterValueSchema).optional(),
    perPage: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine((source) => source.filter === undefined || source.filters === undefined, {
    message: "use filter or filters, not both",
    path: ["filter"],
  });

export const browserOsSourceSchema = z
  .object({
    type: z.literal("browseros"),
    url: httpUrlSchema,
    selector: z.string().trim().min(1).max(1_000).optional(),
    mode: z.enum(["text", "links"]).optional(),
    fields: nonEmptyFieldRecord(z.object({
      selector: z.string().trim().min(1).max(1_000),
      ...typedFieldShape,
    }).strict().superRefine(validateCurrency)).optional(),
  })
  .strict()
  .refine((source) => source.fields === undefined || (source.selector === undefined && source.mode === undefined), {
    message: "use fields or selector/mode, not both",
    path: ["fields"],
  });

export const sourceSchema = z.discriminatedUnion("type", [
  feedSourceSchema,
  jsonSourceSchema,
  htmlSourceSchema,
  openAlexSourceSchema,
  browserOsSourceSchema,
  z.object({
    type: z.literal("x"),
    handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
    maxPages: z.number().int().min(1).max(100).default(30),
  }).strict(),
]);

export type FeedSource = z.infer<typeof feedSourceSchema>;
export type JsonSource = z.infer<typeof jsonSourceSchema>;
export type HtmlSource = z.infer<typeof htmlSourceSchema>;
export type OpenAlexSource = z.infer<typeof openAlexSourceSchema>;
export type BrowserOsSource = z.infer<typeof browserOsSourceSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type XSource = Extract<Source, { type: "x" }>;
export type SourceConfig = Source;

export const assertionsSchema = z
  .object({
    minItems: z.number().int().positive().optional(),
    allowEmpty: z.boolean().optional(),
    maxItems: z.number().int().positive().max(10_000).optional(),
    requiredFields: z.array(fieldNameSchema).max(100).optional(),
    invariantFields: z.array(comparableFieldSchema).max(100).optional(),
    uniqueBy: comparableFieldSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.allowEmpty === true && value.minItems !== undefined) {
      context.addIssue({ code: "custom", message: "use allowEmpty or minItems, not both", path: ["allowEmpty"] });
    }
    if (value.minItems !== undefined && value.maxItems !== undefined && value.minItems > value.maxItems) {
      context.addIssue({
        code: "custom",
        message: "minItems must not exceed maxItems",
        path: ["minItems"],
      });
    }
    const requiredFields = value.requiredFields ?? [];
    if (new Set(requiredFields).size !== requiredFields.length) {
      context.addIssue({
        code: "custom",
        message: "requiredFields must be unique",
        path: ["requiredFields"],
      });
    }
    const invariantFields = value.invariantFields ?? [];
    if (new Set(invariantFields).size !== invariantFields.length) {
      context.addIssue({ code: "custom", message: "invariantFields must be unique", path: ["invariantFields"] });
    }
  });

export type Assertions = z.infer<typeof assertionsSchema>;

const ruleBaseShape = {
  id: idSchema,
  enabled: z.boolean().optional(),
  bootstrap: z.enum(["suppress_existing", "evaluate_current"]).default("suppress_existing"),
};

export const newItemsRuleSchema = z
  .object({
    ...ruleBaseShape,
    type: z.literal("new_items"),
  })
  .strict();

export const fieldChangedRuleSchema = z
  .object({
    ...ruleBaseShape,
    type: z.literal("field_changed"),
    field: comparableFieldSchema,
  })
  .strict();

export const crossesBelowRuleSchema = z
  .object({
    ...ruleBaseShape,
    type: z.literal("crosses_below"),
    field: comparableFieldSchema,
    threshold: z.number().finite().nonnegative().optional(),
    thresholdMinor: z.number().int().safe().nonnegative().optional(),
    currency: currencySchema.optional(),
  })
  .strict()
  .refine((value) => (value.threshold === undefined) !== (value.thresholdMinor === undefined), {
    message: "set exactly one of threshold or thresholdMinor",
    path: ["threshold"],
  })
  .superRefine((value, context) => {
    if (value.thresholdMinor !== undefined && value.currency === undefined) context.addIssue({ code: "custom", message: "thresholdMinor requires currency", path: ["currency"] });
    if (value.threshold !== undefined && value.currency !== undefined) context.addIssue({ code: "custom", message: "use thresholdMinor for currency values", path: ["threshold"] });
  });

export const numericDeltaRuleSchema = z
  .object({
    ...ruleBaseShape,
    type: z.literal("numeric_delta"),
    field: comparableFieldSchema,
    absolute: z.number().finite().positive().optional(),
    percent: z.number().finite().positive().optional(),
    currency: currencySchema.optional(),
    direction: z.enum(["any", "increase", "decrease"]).optional(),
  })
  .strict()
  .refine((value) => value.absolute !== undefined || value.percent !== undefined, {
    message: "set absolute, percent, or both",
    path: ["absolute"],
  });

export const assessmentRuleSchema = z.object({
  ...ruleBaseShape,
  type: z.literal("llm_assessment"),
  trigger: z.enum(["new_item", "new_or_changed"]).optional(),
  model: z.literal("gpt-6.1-sol"),
  reasoningEffort: z.literal("xhigh"),
  prompt: z.string().trim().min(1).max(10_000),
}).strict();

export const ruleSchema = z.discriminatedUnion("type", [
  newItemsRuleSchema,
  fieldChangedRuleSchema,
  crossesBelowRuleSchema,
  numericDeltaRuleSchema,
  assessmentRuleSchema,
]);

export type NewItemsRule = z.infer<typeof newItemsRuleSchema>;
export type FieldChangedRule = z.infer<typeof fieldChangedRuleSchema>;
export type CrossesBelowRule = z.infer<typeof crossesBelowRuleSchema>;
export type NumericDeltaRule = z.infer<typeof numericDeltaRuleSchema>;
export type AssessmentRule = z.infer<typeof assessmentRuleSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type RuleConfig = Rule;

const notificationBaseShape = {
  id: idSchema.optional(),
  enabled: z.boolean().optional(),
  events: z.array(z.enum(["new_item", "field_changed", "crosses_below", "numeric_delta", "llm_assessment", "health_degraded", "health_recovered"])).min(1).optional(),
};

export const inboxNotificationSchema = z
  .object({
    ...notificationBaseShape,
    type: z.literal("inbox"),
  })
  .strict();

export const desktopNotificationSchema = z
  .object({
    ...notificationBaseShape,
    type: z.literal("desktop"),
  })
  .strict();

export const ntfyNotificationSchema = z
  .object({
    ...notificationBaseShape,
    type: z.literal("ntfy"),
    server: httpUrlSchema.optional(),
    url: httpUrlSchema.optional(),
    topic: z.string().trim().min(1).max(200),
    token: secretRefSchema.optional(),
    priority: z.number().int().min(1).max(5).optional(),
    headers: headersSchema.optional(),
    headerEnv: headerEnvSchema.optional(),
    allowPrivate: z.boolean().optional(),
  })
  .strict()
  .refine((notification) => notification.server === undefined || notification.url === undefined, {
    message: "use url or server, not both",
    path: ["url"],
  })
  .superRefine((notification, context) => requireSecureNotification(notification.url ?? notification.server ?? "https://ntfy.sh", notification, context));

export const webhookNotificationSchema = z
  .object({
    ...notificationBaseShape,
    type: z.literal("webhook"),
    url: httpUrlSchema,
    headers: headersSchema.optional(),
    headerEnv: headerEnvSchema.optional(),
    allowPrivate: z.boolean().optional(),
  })
  .strict()
  .superRefine((notification, context) => requireSecureNotification(notification.url, notification, context));

function requireSecureNotification(
  url: string,
  notification: { token?: SecretRef | undefined; headers?: HeadersConfig | undefined; headerEnv?: Record<string, string> | undefined },
  context: z.RefinementCtx,
): void {
  const hasSecrets = notification.token !== undefined || Object.keys(notification.headerEnv ?? {}).length > 0 ||
    Object.values(notification.headers ?? {}).some((value) => typeof value !== "string");
  let protocol: string;
  try { protocol = new URL(url).protocol; } catch { return; }
  if (protocol === "http:" && hasSecrets) {
    context.addIssue({ code: "custom", message: "notification credentials require HTTPS", path: ["url"] });
  }
}

const emailAddressSchema = z.email().max(254).regex(/^[^\s<>\u0000-\u001f\u007f]+$/);
export const emailNotificationSchema = z.object({
  ...notificationBaseShape,
  type: z.literal("email"),
  to: emailAddressSchema,
  from: emailAddressSchema.optional(),
  account: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/).optional(),
}).strict();

export const notificationSchema = z.discriminatedUnion("type", [
  inboxNotificationSchema,
  desktopNotificationSchema,
  ntfyNotificationSchema,
  webhookNotificationSchema,
  emailNotificationSchema,
]);

export type InboxNotification = z.infer<typeof inboxNotificationSchema>;
export type DesktopNotification = z.infer<typeof desktopNotificationSchema>;
export type NtfyNotification = z.infer<typeof ntfyNotificationSchema>;
export type WebhookNotification = z.infer<typeof webhookNotificationSchema>;
export type EmailNotification = z.infer<typeof emailNotificationSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type NotificationConfig = Notification;

export const healthSchema = z
  .object({
    failuresBeforeAlert: z.number().int().positive().optional(),
  })
  .strict();

export type Health = z.infer<typeof healthSchema>;
export type HealthConfig = Health;

export const monitorSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    name: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
    schedule: scheduleSchema,
    source: sourceSchema,
    assertions: assertionsSchema.optional(),
    rules: z.array(ruleSchema).min(1),
    notifications: z.array(notificationSchema).optional(),
    health: healthSchema.optional(),
  })
  .strict()
  .superRefine((monitor, context) => {
    const ruleIds = new Set<string>();
    for (const [index, rule] of monitor.rules.entries()) {
      if (ruleIds.has(rule.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate rule id '${rule.id}'`,
          path: ["rules", index, "id"],
        });
      }
      ruleIds.add(rule.id);
    }

    const notificationIds = monitor.notifications?.flatMap((notification) =>
      notification.id === undefined ? [] : [notification.id],
    ) ?? [];
    if (new Set(notificationIds).size !== notificationIds.length) {
      context.addIssue({
        code: "custom",
        message: "notification ids must be unique",
        path: ["notifications"],
      });
    }
  });

export type Monitor = z.infer<typeof monitorSchema>;
export type MonitorInput = z.input<typeof monitorSchema>;
export type MonitorConfig = Monitor;

export type SemanticMonitorValue = Record<string, unknown>;

export function semanticMonitorValue(monitor: Monitor): SemanticMonitorValue {
  const assertions = monitor.assertions ?? {};
  return {
    version: monitor.version,
    id: monitor.id,
    source: effectiveSource(monitor.source),
    assertions: {
      allowEmpty: assertions.allowEmpty ?? false,
      minItems: assertions.allowEmpty ? 0 : assertions.minItems ?? 1,
      maxItems: assertions.maxItems,
      requiredFields: sortedUnique(assertions.requiredFields ?? []),
      invariantFields: sortedUnique(assertions.invariantFields ?? []),
      uniqueBy: assertions.uniqueBy,
    },
    rules: monitor.rules.map((rule) => ({
      ...rule,
      ...(rule.type === "llm_assessment" ? { trigger: rule.trigger === "new_item" ? rule.trigger : undefined } : {}),
      enabled: rule.enabled ?? true,
      ...(rule.type === "numeric_delta" ? { direction: rule.direction ?? "any" } : {}),
    })).sort((left, right) => left.id.localeCompare(right.id, "en")),
  };
}

function effectiveSource(source: Source): Record<string, unknown> {
  if (source.type === "x") return { ...source, handle: source.handle.toLowerCase(), adapterVersion: 1 };
  if (source.type === "feed") {
    const { includeKeywords: _include, excludeKeywords: _exclude, keywords, exclude, ...rest } = source;
    return { ...rest, keywords: sortedUnique(keywords ?? source.includeKeywords ?? []), exclude: sortedUnique(exclude ?? source.excludeKeywords ?? []) };
  }
  if (source.type === "openalex") {
    const { filters: _filters, filter, perPage, ...rest } = source;
    const normalizedFilter = Object.fromEntries(Object.entries(filter ?? source.filters ?? {}).map(([name, value]) =>
      [name, Array.isArray(value) ? sortedUnique(value) : value],
    ));
    return { ...rest, filter: normalizedFilter, perPage: perPage ?? 50 };
  }
  return source;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter((entry) => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

export function semanticMonitorHash(input: unknown): string {
  const monitor = monitorSchema.parse(input);
  return createHash("sha256").update(stableJson(semanticMonitorValue(monitor))).digest("hex");
}
