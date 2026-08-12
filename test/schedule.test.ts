import assert from "node:assert/strict";
import { test } from "node:test";
import { durationMs, nextOccurrence } from "../src/scheduler/schedule.ts";

test("interval and timezone-aware cron calculate next occurrence", () => {
  assert.equal(durationMs("15m"), 900_000);
  assert.equal(durationMs("10s"), 10_000);
  assert.equal(nextOccurrence({ every: "2h" }, new Date("2026-01-01T00:00:00Z")).toISOString(), "2026-01-01T02:00:00.000Z");
  assert.equal(nextOccurrence({ cron: "0 9 * * *", timezone: "Asia/Tokyo" }, new Date("2026-01-01T00:01:00Z")).toISOString(), "2026-01-02T00:00:00.000Z");
});
