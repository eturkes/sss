import type { JsonObject } from "../core/types.ts";
import { fetchJson } from "./http.ts";
import { canonicalUrl, cleanText, extractDoi, normalizeDate, record, stableItemId } from "./normalize.ts";
import { assertSourceItemLimit, finish, type Item, type OpenAlexSource, type SourceDependencies } from "./types.ts";

export const OPENALEX_WORKS_ENDPOINT = "https://api.openalex.org/works";

export async function collectOpenAlex(source: OpenAlexSource, dependencies: SourceDependencies) {
  const apiKey = dependencies.env?.["OPENALEX_API_KEY"] ?? process.env["OPENALEX_API_KEY"];
  if (!apiKey) throw new Error("OpenAlex requires OPENALEX_API_KEY");
  const url = new URL(OPENALEX_WORKS_ENDPOINT);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("search", source.query);
  url.searchParams.set("per_page", String(source.perPage ?? 50));
  const filters = source.filter ?? source.filters;
  if (filters && Object.keys(filters).length > 0) url.searchParams.set("filter", openAlexFilters(filters));
  const payload = record(await fetchJson(url.href, dependencies));
  const results = payload?.["results"];
  if (!Array.isArray(results)) throw new Error("OpenAlex response lacks results");
  assertSourceItemLimit(results.length);
  const items = results.map(openAlexItem);
  return finish(items, dependencies);
}

function openAlexFilters(filters: Record<string, string | number | boolean | string[]>): string {
  return Object.entries(filters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${Array.isArray(value) ? value.join("|") : String(value)}`)
    .join(",");
}

function openAlexItem(value: unknown): Item {
  const work = record(value);
  if (!work) throw new Error("OpenAlex result must be an object");
  const openAlexUrl = canonicalUrl(work["id"]);
  const openAlexId = openAlexUrl?.split("/").pop() ?? cleanText(work["id"]);
  const doi = extractDoi(work["doi"]);
  const title = cleanText(work["display_name"] ?? work["title"]);
  const publishedAt = normalizeDate(work["publication_date"]);
  const primaryLocation = record(work["primary_location"]);
  const source = record(primaryLocation?.["source"]);
  const url = canonicalUrl(primaryLocation?.["landing_page_url"] ?? work["doi"] ?? openAlexUrl);
  const authors = Array.isArray(work["authorships"])
    ? work["authorships"].map((authorship) => cleanText(record(record(authorship)?.["author"])?.["display_name"])).filter((name): name is string => name !== undefined)
    : [];
  const data: JsonObject = {};
  if (openAlexId) data["openalexId"] = openAlexId;
  if (doi) data["doi"] = doi;
  if (title) data["title"] = title;
  if (publishedAt) data["publishedAt"] = publishedAt;
  if (url) data["url"] = url;
  if (authors.length > 0) data["authors"] = authors;
  const venue = cleanText(source?.["display_name"]);
  if (venue) data["venue"] = venue;
  const citedByCount = work["cited_by_count"];
  if (typeof citedByCount === "number" && Number.isFinite(citedByCount)) data["citedByCount"] = citedByCount;
  const abstract = reconstructAbstract(work["abstract_inverted_index"]);
  if (abstract) data["abstract"] = abstract;

  const id = doi
    ? `doi:${doi}`
    : openAlexId
      ? `openalex:${openAlexId.toLowerCase()}`
      : stableItemId({ url, fallback: data });
  return {
    id,
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    data,
  };
}

function reconstructAbstract(value: unknown): string | undefined {
  const inverted = record(value);
  if (!inverted) return undefined;
  const positioned: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === "number" && Number.isSafeInteger(position) && position >= 0) positioned.push([position, word]);
    }
  }
  return positioned.sort(([left], [right]) => left - right).map(([, word]) => word).join(" ") || undefined;
}
