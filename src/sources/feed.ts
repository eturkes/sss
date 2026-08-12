import { XMLParser } from "fast-xml-parser";

import type { JsonObject } from "../core/types.ts";
import { fetchText } from "./http.ts";
import {
  array,
  canonicalUrl,
  cleanText,
  extractArxiv,
  extractDoi,
  normalizeDate,
  record,
  stableItemId,
} from "./normalize.ts";
import { assertSourceItemLimit, finish, type FeedSource, type Item, type SourceDependencies } from "./types.ts";

const parser: XMLParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

export async function collectFeed(source: FeedSource, dependencies: SourceDependencies) {
  const response = await fetchText(
    source.url,
    dependencies,
    source.headers,
    "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
  );
  const xml = response.text;
  let parsed: unknown;
  try {
    parsed = (parser as { parse: (source: string) => unknown }).parse(xml);
  } catch {
    throw new Error("feed returned invalid XML");
  }
  const entries = feedEntries(parsed);
  assertSourceItemLimit(entries.length);

  const includes = (source.keywords ?? source.includeKeywords ?? []).map(normalizeKeyword);
  const excludes = (source.exclude ?? source.excludeKeywords ?? []).map(normalizeKeyword);
  const items = entries.map((entry) => feedItem(entry, response.url)).filter((item) => keywordMatch(item, includes, excludes));
  return finish(deduplicate(items), dependencies);
}

function feedEntries(parsed: unknown): Record<string, unknown>[] {
  const root = record(parsed);
  if (!root) throw new Error("feed root must be an object");
  const rss = record(root["rss"]);
  const channel = record(rss?.["channel"] ?? root["channel"]);
  const atom = record(root["feed"]);
  const rdf = record(root["RDF"]);
  if (!channel && !atom && !rdf) throw new Error("response is not an RSS or Atom feed");
  const entries = channel?.["item"] ?? atom?.["entry"] ?? rdf?.["item"];
  return array(entries).map(record).filter((entry): entry is Record<string, unknown> => entry !== undefined);
}

function feedItem(entry: Record<string, unknown>, feedUrl: string): Item {
  const title = cleanText(entry["title"]);
  const summary = cleanText(entry["summary"] ?? entry["description"] ?? entry["encoded"] ?? entry["content"]);
  const link = canonicalUrl(feedLink(entry["link"]), feedUrl);
  const explicit = cleanText(entry["guid"] ?? entry["id"]);
  const doi = extractDoi(entry["doi"], entry["identifier"], explicit, link);
  const arxiv = extractArxiv(entry["arxiv"], entry["identifier"], explicit, link);
  const publishedAt = normalizeDate(entry["published"] ?? entry["pubDate"] ?? entry["issued"] ?? entry["date"] ?? entry["updated"]);
  const authors = feedAuthors(entry["author"] ?? entry["creator"]);
  const categories = array(entry["category"]).map(categoryText).filter((value): value is string => value !== undefined);
  const data: JsonObject = {};
  if (title) data["title"] = title;
  if (link) data["url"] = link;
  if (publishedAt) data["publishedAt"] = publishedAt;
  if (summary) data["summary"] = summary;
  if (authors.length > 0) data["authors"] = authors;
  if (categories.length > 0) data["categories"] = categories;
  if (doi) data["doi"] = doi;
  if (arxiv) data["arxivId"] = arxiv;

  const id = stableItemId({ doi, arxiv, url: link, explicit, fallback: data });
  if (id.startsWith("sha256:")) throw new Error("feed entry lacks a stable DOI, arXiv ID, URL, or provider ID");
  return {
    id,
    ...(link ? { url: link } : {}),
    ...(title ? { title } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    data,
  };
}

function feedLink(value: unknown): unknown {
  for (const candidate of array(value)) {
    const object = record(candidate);
    if (!object) {
      const text = cleanText(candidate);
      if (text) return text;
      continue;
    }
    const href = object["@_href"] ?? object["href"] ?? object["#text"];
    const relation = cleanText(object["@_rel"] ?? object["rel"]);
    if (href !== undefined && (relation === undefined || relation === "alternate")) return href;
  }
  return undefined;
}

function feedAuthors(value: unknown): string[] {
  return array(value)
    .map((author) => {
      const object = record(author);
      return cleanText(object?.["name"] ?? author);
    })
    .filter((author): author is string => author !== undefined);
}

function categoryText(value: unknown): string | undefined {
  const object = record(value);
  return cleanText(object?.["@_term"] ?? object?.["term"] ?? value);
}

function normalizeKeyword(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function keywordMatch(item: Item, includes: string[], excludes: string[]): boolean {
  const values: unknown[] = [
    item.title,
    item.data["summary"],
    item.data["authors"],
    item.data["categories"],
  ];
  const strings: string[] = [];
  while (values.length > 0) {
    const value = values.pop();
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) values.push(...value);
  }
  const haystack = normalizeKeyword(strings.join(" "));
  if (excludes.some((keyword) => haystack.includes(keyword))) return false;
  return includes.length === 0 || includes.some((keyword) => haystack.includes(keyword));
}

function deduplicate(items: Item[]): Item[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
