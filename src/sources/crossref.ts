import { crossrefSourceSchema, type CrossrefSource } from "../config/research.ts";
import type { JsonObject } from "../core/types.ts";
import { fetchJson } from "./http.ts";
import { cleanText, record } from "./normalize.ts";
import { assertSourceItemLimit, finish, MAX_SOURCE_ITEMS, type Item, type SourceDependencies } from "./types.ts";

export const CROSSREF_WORKS_ENDPOINT = "https://api.crossref.org/works";

export async function collectCrossref(input: CrossrefSource, dependencies: SourceDependencies) {
  const source = crossrefSourceSchema.parse(input);
  const perPage = source.perPage ?? 100;
  const maxPages = source.maxPages ?? 100;
  // Crossref accepts UTC seconds without a zone/fraction; exclude the still-open second.
  const frozenAt = new Date((dependencies.now ?? (() => new Date()))().getTime() - 1_000).toISOString().slice(0, 19);
  const filters = { ...source.filter, "until-index-date": frozenAt };
  const url = new URL(CROSSREF_WORKS_ENDPOINT);
  url.searchParams.set("query", source.query);
  url.searchParams.set("rows", String(perPage));
  url.searchParams.set("filter", Object.entries(filters).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, value]) => `${key}:${value}`).join(","));
  let cursor = "*";
  let total: number | undefined;
  const items: Item[] = [];
  const identities = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    url.searchParams.set("cursor", cursor);
    const payload = record(await fetchJson(url.href, dependencies));
    const message = record(payload?.["message"]);
    if (payload?.["status"] !== "ok" || payload["message-type"] !== "work-list" || !message || !Array.isArray(message["items"])) throw new Error("Crossref response is not a work list");
    const count = message["total-results"];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("Crossref response lacks a valid total-results count");
    if (total !== undefined && count !== total) throw new Error("Crossref result count changed during pagination");
    total = count;
    if (total > Math.min(MAX_SOURCE_ITEMS, perPage * maxPages)) throw new Error("Crossref result exceeds the complete acquisition limit; narrow the query");
    const rows = message["items"];
    if (rows.length !== Math.min(perPage, total - items.length)) throw new Error("Crossref response is incomplete or exceeds its declared result count");
    for (const row of rows) {
      const item = crossrefItem(row);
      if (identities.has(item.id)) throw new Error("Crossref pagination repeated a DOI");
      identities.add(item.id);
      items.push(item);
    }
    assertSourceItemLimit(items.length);
    if (items.length === total) return finish(items, dependencies);
    const next = message["next-cursor"];
    if (typeof next !== "string" || next.length === 0 || next.length > 65_536) throw new Error("Crossref response lacks the next cursor for complete pagination");
    // The provider can reuse an opaque cursor token; DOI overlap detects repeated pages.
    cursor = next;
  }
  throw new Error("Crossref pagination reached its limit before complete acquisition");
}

function crossrefItem(value: unknown): Item {
  const work = record(value);
  const rawDoi = work?.["DOI"];
  if (!work || typeof rawDoi !== "string" || !/^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/u.test(rawDoi) || rawDoi.length > 2_048) throw new Error("Crossref result lacks a valid DOI");
  const doi = rawDoi.toLowerCase();
  const title = textList(work["title"], "title")[0];
  if (!title) throw new Error("Crossref result lacks a title");
  const url = `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`;
  const data: JsonObject = { doi, title, url };
  const date = crossrefDate(work["published"] ?? work["published-print"] ?? work["published-online"] ?? work["issued"]);
  if (date) data["publishedDate"] = date;
  const publishedAt = date?.length === 10 ? `${date}T00:00:00.000Z` : undefined;
  if (publishedAt) data["publishedAt"] = publishedAt;
  for (const field of ["abstract", "publisher", "type"] as const) {
    if (work[field] === undefined) continue;
    if (typeof work[field] !== "string") throw new Error(`Crossref ${field} must be text`);
    const text = cleanText(work[field]);
    if (text) data[field] = text;
  }
  const venues = textList(work["container-title"], "container-title");
  if (venues.length > 0) data["venue"] = venues.join("; ");
  if (work["author"] !== undefined) {
    if (!Array.isArray(work["author"])) throw new Error("Crossref author list is malformed");
    data["authors"] = work["author"].map(value => {
      const author = record(value);
      const name = cleanText(author?.["name"]) ?? [cleanText(author?.["given"]), cleanText(author?.["family"])].filter(Boolean).join(" ");
      if (!name) throw new Error("Crossref author lacks a name");
      return name;
    });
  }
  const citations = work["is-referenced-by-count"];
  if (citations !== undefined) {
    if (typeof citations !== "number" || !Number.isSafeInteger(citations) || citations < 0) throw new Error("Crossref citation count is malformed");
    data["citedByCount"] = citations;
  }
  return { id: `doi:${doi}`, title, url, ...(publishedAt ? { publishedAt } : {}), data };
}

function textList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(part => typeof part !== "string" || !cleanText(part))) throw new Error(`Crossref ${name} must contain nonempty text`);
  return value.map(part => cleanText(part)!);
}

function crossrefDate(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parts = record(value)?.["date-parts"];
  if (!Array.isArray(parts) || parts.length !== 1 || !Array.isArray(parts[0]) || parts[0].length < 1 || parts[0].length > 3) throw new Error("Crossref publication date is malformed");
  const [year, month, day] = parts[0] as unknown[];
  if (typeof year !== "number" || !Number.isSafeInteger(year) || year < 1 || year > 9_999 ||
    (month !== undefined && (typeof month !== "number" || !Number.isSafeInteger(month) || month < 1 || month > 12)) ||
    (day !== undefined && (typeof day !== "number" || !Number.isSafeInteger(day) || day < 1 || day > 31))) throw new Error("Crossref publication date is malformed");
  const date = [String(year).padStart(4, "0"), ...(month === undefined ? [] : [String(month).padStart(2, "0")]), ...(day === undefined ? [] : [String(day).padStart(2, "0")])].join("-");
  if (day !== undefined && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) throw new Error("Crossref publication date is invalid");
  return date;
}
