import { spawn } from "node:child_process";
import type { ChangeEvent } from "../core/types.ts";
import { formatMinorUnits } from "../core/money.ts";
import { Store } from "../store/database.ts";
import { safeRequest } from "../security/network.ts";
import { safeErrorMessage, stripControlText } from "../security/text.ts";
import { sendEmail } from "./email.ts";

type Notification = {
  type: string;
  url?: string;
  server?: string;
  topic?: string;
  allowPrivate?: boolean;
  headers?: Record<string, string | { env: string }>;
  headerEnv?: Record<string, string>;
  token?: { env: string };
  priority?: number;
};

export function formatAlert(event: ChangeEvent): { title: string; body: string } {
  const title = `SSS · ${stripControlText(event.monitorId)}`;
  const label = event.title ? `${stripControlText(event.title)} — ` : "";
  const values = event.before === undefined ? display(event.after) : `${display(event.before)} → ${display(event.after)}`;
  const body = `${label}${stripControlText(event.reason)}\n${values}\nObserved ${event.observedAt}\nEvent ${event.id}`;
  return { title, body: body.slice(0, 2_000) };
}

export async function deliver(event: ChangeEvent, channel: string, rawConfig: string): Promise<void> {
  const config = JSON.parse(rawConfig) as Notification;
  const kind = channel.split(":", 1)[0];
  if (kind === "email") {
    await sendEmail(event, config);
    return;
  }
  const message = formatAlert(event);
  if (kind === "desktop") {
    await spawnChecked("notify-send", ["--app-name=Super Smart Scanner", "--urgency=normal", escapeMarkup(message.title), escapeMarkup(message.body)]);
    return;
  }
  if (kind !== "ntfy" && kind !== "webhook") throw new Error(`unknown notification channel ${kind}`);
  const baseUrl = config.url ?? config.server ?? (kind === "ntfy" ? "https://ntfy.sh" : undefined);
  if (!baseUrl) throw new Error(`${kind} notification requires url`);
  const destination = kind === "ntfy" && config.topic
    ? `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(config.topic)}`
    : baseUrl;
  const envHeaders = Object.fromEntries(Object.entries(config.headerEnv ?? {}).map(([header, variable]) => {
    const value = process.env[variable];
    if (!value) throw new Error(`notification secret environment variable ${variable} is unset`);
    return [header, value];
  }));
  const configuredHeaders = resolveHeaders(config.headers ?? {});
  const tokenHeaders = config.token ? { authorization: `Bearer ${requiredEnv(config.token.env)}` } : {};
  const body = kind === "ntfy"
    ? new TextEncoder().encode(message.body)
    : new TextEncoder().encode(JSON.stringify({ event, message }));
  const headers = kind === "ntfy"
    ? { "content-type": "text/plain; charset=utf-8", title: message.title, ...(config.priority ? { priority: String(config.priority) } : {}), ...configuredHeaders, ...tokenHeaders, ...envHeaders }
    : { "content-type": "application/json", ...configuredHeaders, ...envHeaders };
  const response = await safeRequest(destination, {
    method: "POST", body, headers, trustedSink: true, allowPrivate: config.allowPrivate ?? false,
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`${kind} returned HTTP ${response.status}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`notification secret environment variable ${name} is unset`);
  return value;
}

function resolveHeaders(headers: Record<string, string | { env: string }>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, typeof value === "string" ? value : requiredEnv(value.env)]));
}

export async function drainOutbox(
  store: Store,
  time: Date | (() => Date) = () => new Date(),
  deliverOne: typeof deliver = deliver,
): Promise<{ sent: number; failed: number }> {
  const clock = typeof time === "function" ? time : () => time;
  const now = clock();
  const leaseUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
  const rows = store.claimDeliveries(now.toISOString(), leaseUntil, 1);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const event = store.event(row.eventId);
    if (!event) {
      const outcomeAt = clock();
      if (store.failDelivery(row.id, row.leaseToken, "event missing", new Date(outcomeAt.getTime() + 86_400_000).toISOString())) failed++;
      continue;
    }
    try {
      await deliverOne(event, row.channel, row.configJson);
      if (store.finishDelivery(row.id, row.leaseToken, clock().toISOString())) sent++;
    } catch (error) {
      const delay = Math.min(86_400_000, 30_000 * 2 ** Math.min(row.attempts, 11));
      const outcomeAt = clock();
      if (store.failDelivery(row.id, row.leaseToken, safeErrorMessage(error), new Date(outcomeAt.getTime() + delay).toISOString())) failed++;
    }
  }
  return { sent, failed };
}

function spawnChecked(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", env: process.env });
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, 10_000);
    child.once("error", (error) => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? "by signal"}`));
    });
  });
}

function display(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value) && "minor" in value) {
    const money = value as { minor: number; currency?: string };
    return money.currency ? formatMinorUnits(money.minor, money.currency) : (money.minor / 100).toFixed(2);
  }
  return stripControlText(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 500);
}

function escapeMarkup(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&apos;").replaceAll('"', "&quot;");
}
