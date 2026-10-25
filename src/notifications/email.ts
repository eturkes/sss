import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { emailNotificationSchema, type EmailNotification } from "../config/schema.ts";
import type { ChangeEvent, MonitorStatus } from "../core/types.ts";
import { stripControlText } from "../security/text.ts";
import { displayTime, eventContent, readableText, sourceHealth } from "./readable.ts";

const HEADER_CONTROLS = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

export type EmailDigest = {
  id: string;
  scheduledFor: string;
  config: EmailNotification;
  events: ChangeEvent[];
  monitors: MonitorStatus[];
};

export function formatEmail(event: ChangeEvent, config: EmailNotification): string {
  if (HEADER_CONTROLS.test(event.monitorId)) throw new Error("invalid email subject");
  const observed = new Date(event.observedAt);
  if (Number.isNaN(observed.getTime())) throw new Error("invalid email observation timestamp");
  const body = [
    readableText(event.title ?? event.itemId, event.url),
    ...(event.url ? [`Source: ${stripControlText(event.url)}`] : []),
    `Observed: ${displayTime(event.observedAt)}`,
    "",
    ...(event.kind === "new_item" ? [stripControlText(event.reason)] : []),
    ...eventContent(event),
  ].join("\n");
  const encodedBody = Buffer.from(body.replaceAll("\n", "\r\n"), "utf8").toString("base64");
  const messageId = createHash("sha256").update(event.id).digest("hex");
  const headers = [
    ...(config.from ? [`From: <${config.from}>`] : []),
    `To: <${config.to}>`,
    `Date: ${observed.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${messageId}@super-smart-scanner.local>`,
    `Subject: ${encodeSubject(`SSS · ${event.monitorId}`)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${encodedBody.match(/.{1,76}/g)?.join("\r\n") ?? ""}\r\n`;
}

export async function sendEmail(event: ChangeEvent, raw: unknown): Promise<void> {
  const config = parseConfig(raw);
  if (config.digest) throw new Error("digest notifications require a scheduled batch");
  await sendMessage(formatEmail(event, config), config);
}

export function formatDigestEmail(digest: EmailDigest): string {
  const config = parseConfig(digest.config);
  if (!config.digest || HEADER_CONTROLS.test(digest.id)) throw new Error("invalid email digest");
  const at = new Date(digest.scheduledFor);
  if (Number.isNaN(at.getTime())) throw new Error("invalid email digest timestamp");
  const title = config.digest.id.replaceAll("-", " ");
  const timezone = config.digest.schedule.timezone ?? "UTC";
  const healthEvents = digest.events.filter(event => event.kind === "health_degraded" || event.kind === "health_recovered");
  const observations = digest.events.filter(event => event.kind !== "health_degraded" && event.kind !== "health_recovered");
  const body = [
    `${title.charAt(0).toUpperCase() + title.slice(1)} — digest`,
    displayTime(digest.scheduledFor, timezone),
    `${observations.length} new observation${observations.length === 1 ? "" : "s"}`,
    "",
    ...(observations.length ? observations.flatMap((event, index) => [
      `${index + 1}. ${readableText(event.title ?? event.itemId, event.url)}`,
      stripControlText(digest.monitors.find(monitor => monitor.id === event.monitorId)?.name ?? event.monitorId),
      ...(event.url ? [`Source: ${stripControlText(event.url)}`] : []),
      `Observed: ${displayTime(event.observedAt, timezone)}`,
      "",
      ...eventContent(event, timezone),
      "",
    ]) : ["No new observations in this digest period.", ""]),
    ...sourceHealth(digest.monitors, healthEvents, timezone),
    "",
    "These are observations from the configured sources. Source health and coverage limit what appears here.",
  ].join("\n");
  const headers = [
    ...(config.from ? [`From: <${config.from}>`] : []), `To: <${config.to}>`,
    `Date: ${at.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${createHash("sha256").update(digest.id).digest("hex")}@super-smart-scanner.local>`,
    `Subject: ${encodeSubject(`SSS · ${title} · ${at.toLocaleDateString("en-CA", { timeZone: config.digest.schedule.timezone ?? "UTC" })}`)}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64",
  ];
  const encoded = Buffer.from(body.replaceAll("\n", "\r\n"), "utf8").toString("base64");
  return `${headers.join("\r\n")}\r\n\r\n${encoded.match(/.{1,76}/g)?.join("\r\n") ?? ""}\r\n`;
}

export async function sendEmailDigest(digest: EmailDigest): Promise<void> {
  await sendMessage(formatDigestEmail(digest), parseConfig(digest.config));
}

function parseConfig(raw: unknown): EmailNotification {
  const parsed = emailNotificationSchema.safeParse(raw);
  if (!parsed.success || [parsed.data.to, parsed.data.from, parsed.data.account].some((value) => value !== undefined && HEADER_CONTROLS.test(value))) {
    throw new Error("invalid email notification");
  }
  return parsed.data;
}

async function sendMessage(message: string, config: EmailNotification): Promise<void> {
  const args = [
    "--timeout=30", "--set-from-header=auto",
    ...(config.account ? [`--account=${config.account}`] : []),
    ...(config.from ? [`--from=${config.from}`] : []),
    "--", config.to,
  ];
  await new Promise<void>((resolve, reject) => {
    // msmtp owns trusted account credentials; its diagnostics must never enter the outbox.
    const processGroup = process.platform !== "win32";
    const child = spawn("msmtp", args, { stdio: ["pipe", "ignore", "ignore"], env: process.env, detached: processGroup });
    let timedOut = false;
    let inputFailed = false;
    let terminationFailed = false;
    let closed = false;
    let closedCode: number | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (processGroup && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) terminationFailed = true;
      }
    };
    const finish = () => {
      if (killTimer || (!closed && !timedOut)) return;
      if (timedOut) reject(new Error(`email delivery timed out${terminationFailed ? "; process-group termination failed" : ""}`));
      else if (closedCode !== 0) reject(new Error(`msmtp exited ${closedCode ?? "by signal"}`));
      else if (inputFailed) reject(new Error("msmtp did not accept the complete message"));
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Keep escalation alive after msmtp exits: passwordeval descendants can ignore TERM.
      killTimer = setTimeout(() => {
        terminate("SIGKILL");
        killTimer = undefined;
        finish();
      }, 2_000);
      terminate("SIGTERM");
    }, 60_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("msmtp could not start"));
    });
    child.stdin.on("error", () => { inputFailed = true; });
    child.once("close", (code) => {
      clearTimeout(timer);
      closed = true;
      closedCode = code;
      finish();
    });
    child.stdin.end(message);
  });
}

function encodeSubject(value: string): string {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    // RFC 2047 encoded words <= 75 characters; UTF-8 code points stay intact.
    if (Buffer.byteLength(chunk + character, "utf8") > 42) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${Buffer.from(part, "utf8").toString("base64")}?=`).join("\r\n ");
}
