import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadMonitorById,
  loadMonitorFile,
  loadMonitorFiles,
  MonitorConfigError,
} from "../src/config/load.ts";
import { monitorSchema, semanticMonitorHash } from "../src/config/schema.ts";

const validMonitor = {
  version: 1,
  id: "papers",
  name: "Fresh papers",
  enabled: true,
  schedule: { every: "30m" },
  source: {
    type: "openalex",
    query: "retrieval augmented generation",
    filter: { from_publication_date: "2026-01-01" },
  },
  assertions: { minItems: 1, requiredFields: ["id", "title"], uniqueBy: "id" },
  rules: [{ id: "new", type: "new_items" }],
  notifications: [{ type: "inbox" }],
  health: { failuresBeforeAlert: 3 },
} as const;

test("monitor schema accepts each schedule/source/rule/notification family", () => {
  assert.equal(monitorSchema.parse(validMonitor).source.type, "openalex");

  const parsed = monitorSchema.parse({
    ...validMonitor,
    schedule: { cron: "0 */2 * * *", timezone: "Asia/Tokyo" },
    source: {
      type: "html",
      url: "https://example.com/fares",
      itemSelector: ".fare",
      fields: { id: { attribute: "data-id" }, price: { selector: ".amount", type: "money", currency: "JPY" } },
      headers: { Accept: "text/html", Authorization: { env: "FARES_TOKEN" } },
    },
    rules: [
      { id: "changed", type: "field_changed", field: "status" },
      { id: "cheap", type: "crosses_below", field: "price", thresholdMinor: 50_000, currency: "JPY" },
      { id: "drop", type: "numeric_delta", field: "price", percent: 10, direction: "decrease" },
    ],
    notifications: [
      { type: "desktop" },
      {
        type: "ntfy",
        topic: "sss",
        url: "https://ntfy.example.com",
        token: { env: "NTFY_TOKEN" },
        headerEnv: { "X-Api-Key": "NTFY_API_KEY" },
      },
      {
        type: "webhook",
        url: "https://hooks.example.com/sss",
        headers: { "X-Api-Key": { env: "HOOK_API_KEY" } },
        allowPrivate: false,
      },
    ],
  });
  assert.equal(parsed.source.type, "html");

  assert.equal(
    monitorSchema.parse({
      ...validMonitor,
      source: {
        type: "feed",
        url: "https://example.com/feed.xml",
        includeKeywords: ["scanner"],
        excludeKeywords: ["survey"],
      },
    }).source.type,
    "feed",
  );
  assert.equal(
    monitorSchema.parse({
      ...validMonitor,
      source: {
        type: "json",
        url: "https://example.com/api/fares",
        itemsPath: "offers",
        fields: { id: "id", price: { path: "price", type: "number" } },
      },
    }).source.type,
    "json",
  );
  assert.equal(
    monitorSchema.parse({
      ...validMonitor,
      source: { type: "browseros", url: "https://example.com/account" },
    }).source.type,
    "browseros",
  );
});

test("monitor schema rejects unsafe ids, duplicate rule ids, malformed URLs, and literal secrets", () => {
  assert.equal(monitorSchema.safeParse({ ...validMonitor, id: "../papers" }).success, false);
  assert.equal(monitorSchema.safeParse({ ...validMonitor, schedule: { cron: "not cron", timezone: "Mars/Olympus" } }).success, false);
  assert.equal(
    monitorSchema.safeParse({
      ...validMonitor,
      rules: [
        { id: "same", type: "new_items" },
        { id: "same", type: "field_changed", field: "title" },
      ],
    }).success,
    false,
  );
  assert.equal(
    monitorSchema.safeParse({
      ...validMonitor,
      source: { type: "feed", url: "not a URL" },
    }).success,
    false,
  );
  assert.equal(
    monitorSchema.safeParse({
      ...validMonitor,
      source: {
        type: "feed",
        url: "https://example.com/feed.xml",
        headers: { Authorization: "Bearer literal-secret" },
      },
    }).success,
    false,
  );
  assert.equal(
    monitorSchema.safeParse({
      ...validMonitor,
      notifications: [{ type: "ntfy", topic: "sss", token: "literal-secret" }],
    }).success,
    false,
  );
});

test("semantic hash ignores presentation/operation delivery fields but covers semantics", () => {
  const baseline = semanticMonitorHash(validMonitor);
  assert.equal(
    semanticMonitorHash({
      ...validMonitor,
      name: "Renamed",
      enabled: false,
      schedule: { cron: "0 0 * * *" },
      notifications: [{ type: "desktop" }],
      health: { failuresBeforeAlert: 99 },
    }),
    baseline,
  );
  assert.notEqual(semanticMonitorHash({ ...validMonitor, rules: [{ ...validMonitor.rules[0], enabled: false }] }), baseline);
  assert.notEqual(
    semanticMonitorHash({ ...validMonitor, source: { ...validMonitor.source, query: "different query" } }),
    baseline,
  );
  assert.notEqual(
    semanticMonitorHash({ ...validMonitor, rules: [{ id: "changed", type: "field_changed", field: "doi" }] }),
    baseline,
  );
  assert.equal(
    semanticMonitorHash({
      ...validMonitor,
      assertions: {},
      source: { ...validMonitor.source, perPage: 50 },
      rules: [{ ...validMonitor.rules[0], enabled: true }],
    }),
    semanticMonitorHash({ ...validMonitor, assertions: undefined }),
  );
  assert.equal(
    semanticMonitorHash({
      ...validMonitor,
      source: { type: "feed", url: "https://example.com/feed", includeKeywords: ["beta", "alpha", "alpha"] },
    }),
    semanticMonitorHash({
      ...validMonitor,
      source: { type: "feed", url: "https://example.com/feed", keywords: ["alpha", "beta"] },
    }),
  );
});

test("schema rejects unsafe paths, fake currency, secret queries, and sub-poll schedules", () => {
  assert.equal(monitorSchema.safeParse({ ...validMonitor, source: { type: "json", url: "https://example.com/data", itemsPath: "$.rows" } }).success, false);
  assert.equal(monitorSchema.safeParse({ ...validMonitor, source: { type: "json", url: "https://example.com/data", itemsPath: "constructor.rows" } }).success, false);
  assert.equal(monitorSchema.safeParse({ ...validMonitor, source: { type: "feed", url: "https://example.com/feed?api_key=literal" } }).success, false);
  assert.equal(monitorSchema.safeParse({ ...validMonitor, schedule: { every: "1s" } }).success, false);
  assert.equal(monitorSchema.safeParse({ ...validMonitor, rules: [{ id: "cheap", type: "crosses_below", field: "price", thresholdMinor: -1, currency: "ZZZ" }] }).success, false);
});

test("loader reads deterministic YAML files and resolves a monitor by id or path", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sss-config-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const firstPath = join(directory, "10-papers.yaml");
  const secondPath = join(directory, "20-fares.yml");
  await writeFile(
    firstPath,
    `version: 1\nid: papers\nname: Papers\nenabled: true\nschedule:\n  every: 30m\nsource:\n  type: openalex\n  query: agent systems\nrules:\n  - id: new\n    type: new_items\n`,
  );
  await writeFile(
    secondPath,
    `version: 1\nid: fares\nname: Fares\nenabled: true\nschedule:\n  every: 1h\nsource:\n  type: html\n  url: https://example.com/fares\n  itemSelector: .fare\n  fields:\n    id:\n      attribute: data-id\n    price:\n      type: number\nrules:\n  - id: cheap\n    type: crosses_below\n    field: price\n    threshold: 500\n`,
  );

  assert.equal((await loadMonitorFile(firstPath)).id, "papers");
  assert.equal((await loadMonitorById(directory, "fares")).name, "Fares");
  assert.deepEqual(
    (await loadMonitorFiles(directory)).map((loaded) => loaded.config.id),
    ["papers", "fares"],
  );
});

test("loader reports YAML/schema/duplicate-id failures with file context", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sss-config-errors-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const invalidPath = join(directory, "invalid.yaml");
  await writeFile(invalidPath, "version: [\n");

  await assert.rejects(loadMonitorFile(invalidPath), (error) => {
    assert.ok(error instanceof MonitorConfigError);
    assert.equal(error.kind, "yaml");
    assert.match(error.message, /invalid\.yaml/);
    return true;
  });

  await writeFile(invalidPath, "version: 1\nid: Nope\n");
  await assert.rejects(loadMonitorFile(invalidPath), (error) => {
    assert.ok(error instanceof MonitorConfigError);
    assert.equal(error.kind, "schema");
    assert.match(error.message, /invalid\.yaml/);
    return true;
  });

  const yaml = `version: 1\nid: duplicate\nname: Duplicate\nenabled: true\nschedule:\n  every: 1h\nsource:\n  type: openalex\n  query: test\nrules:\n  - id: new\n    type: new_items\n`;
  await writeFile(join(directory, "a.yaml"), yaml);
  await writeFile(join(directory, "b.yaml"), yaml);
  await rm(invalidPath);
  await assert.rejects(loadMonitorFiles(directory), (error) => {
    assert.ok(error instanceof MonitorConfigError);
    assert.equal(error.kind, "duplicate_id");
    assert.match(error.message, /b\.yaml/);
    assert.match(error.message, /a\.yaml/);
    return true;
  });
});
