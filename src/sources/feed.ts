import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { isDeepStrictEqual } from "node:util";

import type { JsonObject } from "../core/types.ts";
import { fetchText } from "./http.ts";
import {
  array,
  itemUrl,
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
  trimValues: false,
});
const contentParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});
const contentBuilder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false });

export async function collectFeed(source: FeedSource, dependencies: SourceDependencies) {
  const response = await fetchText(
    source.url,
    dependencies,
    source.headers,
    "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
  );
  const xml = response.text;
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("feed returned invalid or unsafe XML");
  let parsed: unknown;
  try {
    parsed = (parser as { parse: (source: string) => unknown }).parse(xml);
  } catch {
    throw new Error("feed returned invalid XML");
  }
  const entries = feedEntries(parsed);
  assertSourceItemLimit(entries.length);
  // Ordered XML retains mixed text and links that the metadata parser groups by tag name.
  const orderedEntries = orderedFeedEntries(contentParser.parse(xml));
  if (orderedEntries.length !== entries.length) throw new Error("feed content entry count differs from declared entries");

  const includes = (source.keywords ?? source.includeKeywords ?? []).map(normalizeKeyword);
  const excludes = (source.exclude ?? source.excludeKeywords ?? []).map(normalizeKeyword);
  const items = deduplicate(entries.map((entry, index) => feedItem(entry, orderedEntries[index]!, response.url, source.identity)));
  return finish(items.filter(item => keywordMatch(item, includes, excludes)), dependencies);
}

function feedEntries(parsed: unknown): Record<string, unknown>[] {
  const root = record(parsed);
  if (!root) throw new Error("feed root must be an object");
  const roots = Object.keys(root).filter(key => !key.startsWith("?"));
  const kind = roots[0];
  if (roots.length !== 1 || kind !== "rss" && kind !== "feed" && kind !== "RDF") throw new Error("response is not an RSS or Atom feed");
  const value = root[kind];
  const container = value === "" ? {} : record(value);
  if (!container) throw new Error("response is not an RSS or Atom feed");
  const channel = container["channel"] === "" ? {} : record(container["channel"]);
  if (kind === "rss" && !channel) throw new Error("feed lacks a valid RSS channel");
  const entries = kind === "rss" ? channel?.["item"] : container[kind === "feed" ? "entry" : "item"];
  return array(entries).map(value => {
    const entry = record(value);
    if (!entry) throw new Error("feed entry must be a record");
    return entry;
  });
}

function feedItem(entry: Record<string, unknown>, ordered: unknown[], feedUrl: string, identity: FeedSource["identity"]): Item {
  const title = cleanText(entry["title"]);
  const contents = new Map<string, string>();
  for (const name of ["summary", "description", "encoded", "content"]) {
    const value = feedContent(ordered, name);
    if (value) contents.set(name, value);
  }
  const summary = contents.values().next().value;
  const link = itemUrl(feedLink(entry["link"]), feedUrl);
  const explicit = cleanText(entry["guid"] ?? entry["id"]);
  const provider = rawText(entry["guid"] ?? entry["id"]);
  if (identity === "provider" && !provider?.trim()) throw new Error("feed entry lacks a provider identity");
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
  const retainedContent = new Set(summary ? [summary] : []);
  for (const [name, value] of contents) {
    if (!retainedContent.has(value)) data[name] = value;
    retainedContent.add(value);
  }
  if (authors.length > 0) data["authors"] = authors;
  if (categories.length > 0) data["categories"] = categories;
  if (doi) data["doi"] = doi;
  if (arxiv) data["arxivId"] = arxiv;

  const id = identity === "provider" ? `id:${provider}` : stableItemId({ doi, arxiv, url: link, explicit, fallback: data });
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
    if (typeof candidate === "string") {
      if (candidate.trim()) return candidate;
      continue;
    }
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

function rawText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const text = record(value)?.["#text"];
  return typeof text === "string" ? text : undefined;
}

function orderedChildren(nodes: unknown[], name: string): unknown[][] {
  return nodes.flatMap(node => Object.entries(record(node) ?? {}).flatMap(([key, value]) =>
    key.split(":").at(-1) === name ? [array(value)] : []));
}

function orderedFeedEntries(parsed: unknown): unknown[][] {
  const nodes = array(parsed);
  const rss = orderedChildren(nodes, "rss")[0];
  if (rss) return orderedChildren(orderedChildren(rss, "channel")[0] ?? [], "item");
  const feed = orderedChildren(nodes, "feed")[0];
  if (feed) return orderedChildren(feed, "entry");
  return orderedChildren(orderedChildren(nodes, "RDF")[0] ?? [], "item");
}

function feedContent(ordered: unknown[], name: string): string | undefined {
  const children = orderedChildren(ordered, name)[0];
  if (children === undefined) return undefined;
  const pending = children.map(node => ({ node, depth: 1 }));
  let nodes = 0;
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (++nodes > 10_000 || depth > 64) throw new Error("feed content exceeds structural bounds");
    const object = record(node);
    if (!object) continue;
    for (const [name, child] of Object.entries(object)) {
      if (name === ":@" || name === "#text") continue;
      pending.push(...array(child).map(node => ({ node, depth: depth + 1 })));
    }
  }
  const textOnly = children.every(node => Object.keys(record(node) ?? {}).every(name => name === "#text"));
  const content = textOnly ? children.map(node => rawText(node) ?? "").join("") : contentBuilder.build(children) as string;
  return content.trim() || undefined;
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
    item.data["description"],
    item.data["content"],
    item.data["encoded"],
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
  const seen = new Map<string, Item>();
  return items.filter((item) => {
    const previous = seen.get(item.id);
    if (previous) {
      if (!isDeepStrictEqual(previous, item)) throw new Error(`feed has conflicting records for identity ${item.id}`);
      return false;
    }
    seen.set(item.id, item);
    return true;
  });
}
