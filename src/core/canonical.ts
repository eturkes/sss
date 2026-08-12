import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "./types.ts";
import { stripControlText } from "../security/text.ts";

export function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  if (typeof value === "string") return stripControlText(value).normalize("NFKC").replace(/\s+/g, " ").trim();
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(...parts: string[]): string {
  return sha256(parts.join("\u001f")).slice(0, 32);
}

export function getPath(object: JsonObject, path: string): JsonValue | undefined {
  let cursor: JsonValue | undefined = object;
  for (const segment of path.split(".")) {
    if (cursor === null || Array.isArray(cursor) || typeof cursor !== "object") return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

export function comparableNumber(value: JsonValue | undefined): { value: number; currency?: string } | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return { value };
  if (value && !Array.isArray(value) && typeof value === "object") {
    const minor = value["minor"];
    const currency = value["currency"];
    if (typeof minor === "number" && Number.isSafeInteger(minor) && minor >= 0) {
      if (currency !== undefined && typeof currency !== "string") return undefined;
      return currency === undefined ? { value: minor } : { value: minor, currency };
    }
  }
  return undefined;
}
