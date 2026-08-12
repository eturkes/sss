import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { ZodError, z } from "zod";

import { idSchema, monitorSchema } from "./schema.ts";
import type { Monitor } from "./schema.ts";

export type MonitorConfigErrorKind = "directory" | "read" | "yaml" | "schema" | "duplicate_id" | "not_found";

export class MonitorConfigError extends Error {
  readonly kind: MonitorConfigErrorKind;
  readonly filePath: string;

  constructor(kind: MonitorConfigErrorKind, filePath: string, detail: string, cause?: unknown) {
    super(`${filePath}: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = "MonitorConfigError";
    this.kind = kind;
    this.filePath = filePath;
  }
}

export interface LoadedMonitor {
  config: Monitor;
  filePath: string;
}

function schemaErrorDetail(error: ZodError): string {
  return z.prettifyError(error);
}

export function parseMonitor(value: unknown, filePath = "<input>"): Monitor {
  const result = monitorSchema.safeParse(value);
  if (!result.success) {
    throw new MonitorConfigError("schema", filePath, schemaErrorDetail(result.error), result.error);
  }
  return result.data;
}

async function readMonitor(filePath: string): Promise<LoadedMonitor> {
  const absolutePath = resolve(filePath);
  let source: string;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new MonitorConfigError("read", absolutePath, "could not read monitor YAML", error);
  }

  let value: unknown;
  try {
    value = parseYaml(source, { maxAliasCount: 100, strict: true, uniqueKeys: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid YAML";
    throw new MonitorConfigError("yaml", absolutePath, detail, error);
  }

  return { config: parseMonitor(value, absolutePath), filePath: absolutePath };
}

export async function loadMonitorFile(filePath: string): Promise<Monitor> {
  return (await readMonitor(filePath)).config;
}

export const loadMonitorByPath = loadMonitorFile;

export async function loadMonitorFiles(monitorsDirectory: string): Promise<LoadedMonitor[]> {
  const directory = resolve(monitorsDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new MonitorConfigError("directory", directory, "could not read monitors directory", error);
  }

  const names = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && /\.ya?ml$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));

  const loaded: LoadedMonitor[] = [];
  const firstPathById = new Map<string, string>();
  for (const name of names) {
    const current = await readMonitor(resolve(directory, name));
    const firstPath = firstPathById.get(current.config.id);
    if (firstPath !== undefined) {
      throw new MonitorConfigError(
        "duplicate_id",
        current.filePath,
        `monitor id '${current.config.id}' is already defined by ${firstPath}`,
      );
    }
    firstPathById.set(current.config.id, current.filePath);
    loaded.push(current);
  }
  return loaded;
}

export async function loadMonitors(monitorsDirectory: string): Promise<Monitor[]> {
  return (await loadMonitorFiles(monitorsDirectory)).map((loaded) => loaded.config);
}

export async function loadMonitorById(monitorsDirectory: string, id: string): Promise<Monitor> {
  const parsedId = idSchema.safeParse(id);
  const directory = resolve(monitorsDirectory);
  if (!parsedId.success) {
    throw new MonitorConfigError("not_found", directory, `invalid monitor id '${id}'`, parsedId.error);
  }

  const loaded = await loadMonitorFiles(directory);
  const match = loaded.find((candidate) => candidate.config.id === parsedId.data);
  if (match === undefined) {
    throw new MonitorConfigError("not_found", directory, `monitor '${parsedId.data}' was not found`);
  }
  return match.config;
}
