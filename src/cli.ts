#!/usr/bin/env -S node
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { serve } from "@hono/node-server";
import { stringify as stringifyYaml } from "yaml";

import { Runtime, hasMonitorFiles } from "./app/runtime.ts";
import { draftMonitor } from "./codex/draft.ts";
import { loadMonitorById, loadMonitorFile, loadMonitorFiles } from "./config/load.ts";
import { semanticMonitorHash } from "./config/schema.ts";
import type { Monitor } from "./config/schema.ts";
import { safeErrorMessage, stripControlText } from "./security/text.ts";
import { BROWSEROS_MCP_ENDPOINT } from "./sources/browseros.ts";
import { createApp } from "./web/app.ts";

const [command = "help", ...args] = process.argv.slice(2);

try {
  await main(command, args);
} catch (error) {
  process.stderr.write(`sss: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}

async function main(command: string, args: string[]): Promise<void> {
  if (["help", "--help", "-h"].includes(command)) return usage();
  if (command === "init") return initCommand();
  if (command === "new") return newCommand(args);
  if (command === "validate") return validateCommand(args[0]);
  if (command === "draft") return draftCommand(args.join(" "));

  const runtime = new Runtime({ ephemeral: command === "test" || args.includes("--ephemeral") });
  try {
    if (command === "sync") {
      const monitors = await runtime.sync();
      process.stdout.write(`synced ${monitors.length} monitor${monitors.length === 1 ? "" : "s"}\n`);
      return;
    }
    if (command === "run" || command === "test") {
      if (!args[0]) throw new Error(`usage: sss ${command} ID|PATH`);
      if (command === "run") await runtime.sync();
      const result = await runtime.run(args[0], command === "test");
      process.stdout.write(`${result.status} · ${result.items.length} item(s) · ${result.events.length} event(s)${result.dryRun ? " · dry-run" : ""}\n`);
      for (const item of result.items.slice(0, 20)) process.stdout.write(`  ${stripControlText(item.id)}${item.title ? ` · ${stripControlText(item.title)}` : ""}\n`);
      if (result.error) process.stdout.write(`  error: ${stripControlText(result.error)}\n`);
      if (result.status === "degraded" || result.status === "skipped") process.exitCode = 1;
      return;
    }
    if (command === "status") {
      await runtime.sync();
      const statuses = runtime.store.status();
      const delivery = runtime.store.deliveryHealth();
      if (jsonFlag(args)) process.stdout.write(`${JSON.stringify({ monitors: statuses, delivery }, null, 2)}\n`);
      else {
        for (const entry of statuses) process.stdout.write(`${entry.enabled ? "●" : "○"} ${entry.id.padEnd(24)} ${entry.errorStreak ? `DEGRADED ×${entry.errorStreak}` : entry.lastSuccessAt ? "WATCHING" : "UNPRIMED"} · next ${entry.nextDueAt ?? "—"}${entry.lastError ? ` · ${stripControlText(entry.lastError)}` : ""}\n`);
        process.stdout.write(`alerts · ${delivery.failed} failed · ${delivery.pending} pending · ${delivery.sending} sending${delivery.lastError ? ` · ${stripControlText(delivery.lastError)}` : ""}\n`);
      }
      return;
    }
    if (command === "events") {
      const events = runtime.store.events(numberOption(args, "--limit", 100));
      if (jsonFlag(args)) process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
      else for (const event of events) process.stdout.write(`${event.observedAt} ${event.kind.padEnd(18)} ${event.monitorId}/${stripControlText(event.title ?? event.itemId)} · ${stripControlText(event.reason)} · ${event.id}\n`);
      return;
    }
    if (command === "history") {
      if (!args[0]) throw new Error("usage: sss history MONITOR [ITEM] [--json] [--limit N]");
      const item = args[1]?.startsWith("--") ? undefined : args[1];
      const observations = runtime.store.observations(args[0], item, numberOption(args, "--limit", 100));
      if (jsonFlag(args)) process.stdout.write(`${JSON.stringify(observations, null, 2)}\n`);
      else for (const observation of observations) process.stdout.write(`${observation.observedAt} ${stripControlText(observation.itemId)} · ${JSON.stringify(observation.data)}\n`);
      return;
    }
    if (command === "deliveries") {
      const deliveries = runtime.store.failedDeliveries(numberOption(args, "--limit", 100));
      if (jsonFlag(args)) process.stdout.write(`${JSON.stringify(deliveries, null, 2)}\n`);
      else for (const delivery of deliveries) process.stdout.write(`${delivery["status"]} ${delivery["channel"]} · attempts ${delivery["attempts"]} · next ${delivery["next_attempt_at"]}${delivery["last_error"] ? ` · ${stripControlText(String(delivery["last_error"]))}` : ""}\n`);
      return;
    }
    if (command === "doctor") {
      await doctor(runtime);
      return;
    }
    if (command === "daemon" || command === "serve") {
      await runtime.sync();
      const port = numberOption(args, "--port", 7337);
      const server = command === "serve"
        ? serve({ fetch: createApp(runtime.store, { run: (id) => runtime.runNow(id), sync: () => runtime.sync() }, { port }).fetch, hostname: "127.0.0.1", port })
        : undefined;
      if (command === "serve") {
        if (server && !server.listening) await new Promise<void>((resolveReady, rejectReady) => {
          const ready = () => { server.off("error", failed); resolveReady(); };
          const failed = (error: Error) => { server.off("listening", ready); rejectReady(error); };
          server.once("listening", ready);
          server.once("error", failed);
        });
        process.stdout.write(`SSS dashboard · http://127.0.0.1:${port}\n`);
      } else process.stdout.write("SSS scheduler running\n");
      let activeTick: Promise<void> | undefined;
      const tick = (): Promise<void> => {
        if (activeTick) return activeTick;
        const run = runtime.tick().then(
          () => undefined,
          (error: unknown) => { process.stderr.write(`tick: ${safeErrorMessage(error)}\n`); },
        );
        activeTick = run;
        void run.finally(() => { if (activeTick === run) activeTick = undefined; });
        return run;
      };
      let stop: (() => void) | undefined;
      const stopping = new Promise<void>((resolveStop) => {
        stop = resolveStop;
        process.once("SIGINT", resolveStop);
        process.once("SIGTERM", resolveStop);
      });
      let timer: NodeJS.Timeout | undefined;
      try {
        await tick();
        timer = setInterval(() => void tick(), 10_000);
        await stopping;
      } finally {
        if (timer) clearInterval(timer);
        process.off("SIGINT", stop!);
        process.off("SIGTERM", stop!);
        await activeTick;
        if (server) await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
      }
      return;
    }
    throw new Error(`unknown command '${command}'; run sss help`);
  } finally {
    runtime.close();
  }
}

async function initCommand(): Promise<void> {
  await mkdir(resolve(".sss"), { recursive: true, mode: 0o700 });
  await mkdir(resolve("monitors"), { recursive: true, mode: 0o700 });
  if (!(await hasMonitorFiles(resolve("monitors")))) process.stdout.write("initialized .sss/ + monitors/ · create a scanner with `sss new research papers`\n");
  else process.stdout.write("SSS directories ready\n");
}

async function newCommand(args: string[]): Promise<void> {
  const [kind, id] = args;
  if (!kind || !["research", "price", "page"].includes(kind) || !id) throw new Error("usage: sss new research|price|page ID");
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(id)) throw new Error("ID must use safe lowercase letters, digits, '-' or '_'");
  const source = resolve(fileURLToPath(new URL("..", import.meta.url)), "examples", `${kind === "research" ? "research" : kind}.yaml`);
  const target = resolve("monitors", `${id}.yaml`);
  await mkdir(resolve("monitors"), { recursive: true, mode: 0o700 });
  const template = await loadMonitorFile(source);
  const config = { ...template, id, name: id.replaceAll(/[-_]/g, " ").replace(/^./, (character) => character.toUpperCase()), enabled: false };
  await writeFile(target, stringifyYaml(config), { flag: "wx", mode: 0o600 });
  process.stdout.write(`created ${target} · edit, validate, test, then enable\n`);
}

async function validateCommand(idOrPath?: string): Promise<void> {
  if (idOrPath) {
    const config = /\.ya?ml$/i.test(idOrPath) || idOrPath.includes("/") ? await loadMonitorFile(idOrPath) : await loadMonitorById(resolve("monitors"), idOrPath);
    process.stdout.write(`valid ${config.id} · state ${semanticMonitorHash(config).slice(0, 12)}\n`);
    return;
  }
  const loaded = await loadMonitorFiles(resolve("monitors"));
  for (const { config, filePath } of loaded) process.stdout.write(`valid ${basename(filePath)} · ${config.id} · state ${semanticMonitorHash(config).slice(0, 12)}\n`);
  process.stdout.write(`${loaded.length} valid monitor${loaded.length === 1 ? "" : "s"}\n`);
}

async function draftCommand(request: string): Promise<void> {
  const config = await draftMonitor(request);
  process.stdout.write(stringifyYaml(config));
}

async function doctor(runtime: Runtime): Promise<void> {
  const checks: Array<[string, boolean, string]> = [];
  checks.push(["Node", /^v(?:24|25|26)\./.test(process.version), process.version]);
  let monitors: Monitor[] = [];
  try { monitors = await runtime.sync(); checks.push(["recipes", true, `${monitors.length} valid`]); } catch (error) { checks.push(["recipes", false, safeErrorMessage(error)]); }
  try { runtime.store.status(); checks.push(["SQLite", true, "read/write ready"]); } catch (error) { checks.push(["SQLite", false, safeErrorMessage(error)]); }
  const requiredEnv = environmentRequirements(monitors);
  const missingEnv = [...requiredEnv].filter((name) => !process.env[name]);
  checks.push(["secrets", missingEnv.length === 0, missingEnv.length ? `missing ${missingEnv.join(", ")}` : `${requiredEnv.size} required variable(s) ready`]);
  if (monitors.some((monitor) => monitor.source.type === "browseros")) {
    try {
      const response = await fetch(BROWSEROS_MCP_ENDPOINT, { method: "GET", signal: AbortSignal.timeout(2_000), headers: { accept: "text/event-stream" } });
      await response.body?.cancel();
      checks.push(["BrowserOS", response.ok, `HTTP ${response.status}`]);
    } catch (error) { checks.push(["BrowserOS", false, safeErrorMessage(error)]); }
  } else checks.push(["BrowserOS", true, "unused"]);
  const delivery = runtime.store.deliveryHealth();
  checks.push(["alerts", delivery.failed === 0, `${delivery.failed} failed · ${delivery.pending} pending`]);
  for (const [label, ok, detail] of checks) process.stdout.write(`${ok ? "✓" : "×"} ${label.padEnd(12)} ${stripControlText(detail)}\n`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

function environmentRequirements(monitors: Monitor[]): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record["env"] === "string") names.add(record["env"]);
    for (const child of Object.values(record)) visit(child);
  };
  for (const monitor of monitors) {
    visit(monitor);
    if (monitor.source.type === "openalex") names.add("OPENALEX_API_KEY");
    if (monitor.source.type === "browseros") names.add("SSS_BROWSEROS_ORIGINS");
  }
  return names;
}

function jsonFlag(args: string[]): boolean { return args.includes("--json"); }
function numberOption(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} requires an integer between 1 and 65535`);
  return value;
}

function usage(): void {
  process.stdout.write(`Super Smart Scanner\n\n  init\n  new research|price|page ID\n  validate [ID|PATH]\n  test ID\n  run ID\n  sync\n  status [--json]\n  events [--json] [--limit N]\n  history MONITOR [ITEM] [--json]\n  deliveries [--json] [--limit N]\n  doctor\n  draft 'watch …'\n  serve [--port 7337]\n  daemon\n`);
}
