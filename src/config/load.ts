import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync } from "node:fs";
import { open, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { ZodError, z } from "zod";

import { idSchema, monitorSchema } from "./schema.ts";
import type { Monitor } from "./schema.ts";

export type MonitorConfigErrorKind = "directory" | "read" | "yaml" | "schema" | "duplicate_id" | "not_found" | "conflict" | "write";

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

export const MAX_RECIPE_BYTES = 1_048_576;
export type EditableRecipe = { config: Monitor; source: string; revision: string };
export type RecipeCommit = (config: Monitor, replace: () => void) => void;

export function parseMonitorSource(source: string, filePath = "<input>"): Monitor {
  if (Buffer.byteLength(source) > MAX_RECIPE_BYTES) throw new MonitorConfigError("read", filePath, "recipe is too large");
  let value: unknown;
  try {
    value = parseYaml(source, { maxAliasCount: 100, strict: true, uniqueKeys: true });
  } catch (error) {
    throw new MonitorConfigError("yaml", filePath, error instanceof Error ? error.message : "invalid YAML", error);
  }
  return parseMonitor(value, filePath);
}

function recipeDirectory(directory: string): { dev: number; ino: number } {
  const info = lstatSync(directory);
  if (!info.isDirectory() || realpathSync(directory) !== directory) {
    throw new MonitorConfigError("directory", directory, "recipe directory must be a real directory without symbolic links");
  }
  return { dev: info.dev, ino: info.ino };
}

function readRecipeBytes(path: string): { source: string; revision: string; dev: number; ino: number } {
  // O_NONBLOCK prevents a replaced FIFO from blocking before fstat rejects it.
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new MonitorConfigError("read", path, "recipe must be a regular file");
    const buffer = Buffer.alloc(MAX_RECIPE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_RECIPE_BYTES) throw new MonitorConfigError("read", path, "recipe is too large");
    const bytes = buffer.subarray(0, length);
    return { source: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), revision: createHash("sha256").update(bytes).digest("hex"), dev: info.dev, ino: info.ino };
  } finally { closeSync(descriptor); }
}

async function editableRecipe(directory: string, id: string): Promise<(EditableRecipe & { filePath: string; dev: number; ino: number }) | undefined> {
  if (!idSchema.safeParse(id).success) throw new MonitorConfigError("not_found", directory, "invalid monitor id");
  const originalDirectory = recipeDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  let match: (EditableRecipe & { filePath: string; dev: number; ino: number }) | undefined;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !/\.ya?ml$/i.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new MonitorConfigError("read", resolve(directory, entry.name), "symbolic link recipes cannot be edited");
    if (!entry.isFile()) continue;
    const filePath = resolve(directory, entry.name);
    const contents = readRecipeBytes(filePath);
    const config = parseMonitorSource(contents.source, filePath);
    if (ids.has(config.id)) throw new MonitorConfigError("duplicate_id", filePath, `duplicate monitor id '${config.id}'`);
    ids.add(config.id);
    if (config.id === id) match = { config, ...contents, filePath };
  }
  const currentDirectory = recipeDirectory(directory);
  if (currentDirectory.dev !== originalDirectory.dev || currentDirectory.ino !== originalDirectory.ino) {
    throw new MonitorConfigError("conflict", directory, "recipe directory changed; reload before editing");
  }
  return match;
}

export async function readRecipe(monitorsDirectory: string, id: string): Promise<EditableRecipe | undefined> {
  const recipe = await editableRecipe(resolve(monitorsDirectory), id);
  return recipe ? { config: recipe.config, source: recipe.source, revision: recipe.revision } : undefined;
}

export async function saveRecipe(monitorsDirectory: string, id: string, source: string, revision: string, commit?: RecipeCommit): Promise<Monitor> {
  const directory = resolve(monitorsDirectory);
  const config = parseMonitorSource(source);
  if (config.id !== id) throw new MonitorConfigError("schema", directory, "monitor id cannot change");
  const current = await editableRecipe(directory, id);
  if (!current) throw new MonitorConfigError("not_found", directory, "monitor was not found");
  const changed = () => new MonitorConfigError("conflict", current.filePath, "recipe changed; reload before saving");
  if (current.revision !== revision) throw changed();
  const originalDirectory = recipeDirectory(directory);
  const temporary = resolve(directory, `.sss-edit-${randomBytes(16).toString("hex")}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(source, "utf8"); await file.sync(); } finally { await file.close(); }
    let replaced = false;
    const replace = () => {
      if (replaced) throw new MonitorConfigError("write", current.filePath, "recipe replacement already completed");
      const actualDirectory = recipeDirectory(directory);
      if (actualDirectory.dev !== originalDirectory.dev || actualDirectory.ino !== originalDirectory.ino) throw changed();
      const actual = readRecipeBytes(current.filePath);
      if (actual.revision !== revision || actual.dev !== current.dev || actual.ino !== current.ino) throw changed();
      renameSync(temporary, current.filePath);
      replaced = true;
    };
    if (commit) commit(config, replace); else replace();
    if (!replaced) throw new MonitorConfigError("write", current.filePath, "recipe replacement did not complete");
    return config;
  } finally { await rm(temporary, { force: true }); }
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
