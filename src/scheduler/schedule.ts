import { CronExpressionParser } from "cron-parser";

type Schedule = { every: string } | { cron: string; timezone?: string | undefined };

export function durationMs(expression: string): number {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(expression);
  if (!match) throw new Error(`invalid interval ${expression}; use 30s, 15m, 2h, or 1d`);
  const count = Number(match[1]);
  const unit = match[2];
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("interval must be a safe positive integer");
  const result = count * ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit!] ?? 0);
  if (!Number.isSafeInteger(result) || result < 10_000 || result > 365 * 86_400_000) throw new Error("interval must be between 10 seconds and 365 days");
  return result;
}

export function nextOccurrence(schedule: Schedule, after = new Date()): Date {
  if ("every" in schedule) return new Date(after.getTime() + durationMs(schedule.every));
  return CronExpressionParser.parse(schedule.cron, { currentDate: after, tz: schedule.timezone ?? "UTC" }).next().toDate();
}
