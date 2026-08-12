import type { JsonObject } from "../core/types.ts";
import { fetchJson } from "./http.ts";
import { canonicalUrl, coerce, getPath, normalizeDate, record, setPath, stableItemId, stringAt, toJson } from "./normalize.ts";
import { assertSourceItemLimit, finish, type Item, type JsonSource, type SourceDependencies } from "./types.ts";

type JsonFieldSpec = string | {
  path: string;
  type?: "string" | "number" | "integer" | "boolean" | "money" | undefined;
  currency?: string | undefined;
};

export async function collectJson(source: JsonSource, dependencies: SourceDependencies) {
  const payload = await fetchJson(source.url, dependencies, source.headers);
  const selected = source.itemsPath ? getPath(payload, source.itemsPath) : payload;
  const records = Array.isArray(selected) ? selected : selected === undefined || selected === null ? [] : [selected];
  assertSourceItemLimit(records.length);
  const singleton = !Array.isArray(selected);
  const items = records.map((value) => jsonItem(value, source.fields as Record<string, JsonFieldSpec> | undefined, source.url, singleton));
  return finish(items, dependencies);
}

function jsonItem(value: unknown, fields: Record<string, JsonFieldSpec> | undefined, baseUrl: string, singleton: boolean): Item {
  const data = fields ? mapFields(value, fields) : objectData(value);
  const title = stringAt(data, "title", "name");
  const rawUrl = stringAt(data, "url", "link", "landingPageUrl");
  const url = canonicalUrl(rawUrl, baseUrl);
  if (url && rawUrl !== url) {
    if (stringAt(data, "url") !== undefined) setPath(data, "url", url);
    else if (stringAt(data, "link") !== undefined) setPath(data, "link", url);
  }
  const published = stringAt(data, "publishedAt", "published", "date");
  const publishedAt = normalizeDate(published);
  if (publishedAt && stringAt(data, "publishedAt") !== undefined) setPath(data, "publishedAt", publishedAt);
  let id = stableItemId({
    doi: stringAt(data, "doi"),
    arxiv: stringAt(data, "arxivId", "arxiv"),
    url,
    explicit: stringAt(data, "id", "identifier"),
    fallback: data,
  });
  if (id.startsWith("sha256:")) {
    if (!singleton) throw new Error("JSON list item lacks a stable identity field");
    id = `source:${canonicalUrl(baseUrl) ?? baseUrl}`;
  }
  return {
    id,
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    data,
  };
}

function mapFields(value: unknown, fields: Record<string, JsonFieldSpec>): JsonObject {
  const result: JsonObject = {};
  for (const [target, config] of Object.entries(fields)) {
    const spec = typeof config === "string" ? { path: config } : config;
    const raw = getPath(value, spec.path);
    setPath(result, target, raw === undefined ? null : coerce(raw, spec.type, spec.currency));
  }
  return result;
}

function objectData(value: unknown): JsonObject {
  const converted = toJson(value);
  if (converted !== null && typeof converted === "object" && !Array.isArray(converted)) return converted;
  return { value: converted };
}

// Keeps declaration emit and editor navigation useful without coupling runtime logic to Zod.
export type { JsonFieldSpec as JsonFieldSchema };
