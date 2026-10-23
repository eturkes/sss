import { setTimeout } from "node:timers/promises";
import { performance } from "node:perf_hooks";

import { XMLParser, XMLValidator } from "fast-xml-parser";

import { arxivSourceSchema, type ArxivSource } from "../config/research.ts";
import type { JsonObject } from "../core/types.ts";
import { fetchText } from "./http.ts";
import { array, cleanText, normalizeDate, record } from "./normalize.ts";
import { assertSourceItemLimit, finish, MAX_SOURCE_ITEMS, type Item, type SourceDependencies } from "./types.ts";

export const ARXIV_QUERY_ENDPOINT = "https://export.arxiv.org/api/query";
export type ArxivDependencies = SourceDependencies & { sleep?: (milliseconds: number) => Promise<void> };
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: true });
let requests: Promise<void> = Promise.resolve();
let lastRequestAt = Number.NEGATIVE_INFINITY;

export async function collectArxiv(input: ArxivSource, dependencies: ArxivDependencies) {
  const source = arxivSourceSchema.parse(input);
  const perPage = source.perPage ?? 100;
  const maxPages = source.maxPages ?? 100;
  const frozen = new Date((dependencies.now ?? (() => new Date()))().getTime() - 60_000);
  const upperBound = frozen.toISOString().slice(0, 16).replace(/[-T:]/g, "");
  const upperTime = Date.parse(`${frozen.toISOString().slice(0, 16)}:59.999Z`);
  const url = new URL(ARXIV_QUERY_ENDPOINT);
  url.searchParams.set("search_query", `(${source.query}) AND submittedDate:[199001010000 TO ${upperBound}]`);
  url.searchParams.set("max_results", String(perPage));
  url.searchParams.set("sortBy", "submittedDate");
  url.searchParams.set("sortOrder", "ascending");
  const items: Item[] = [];
  const identities = new Set<string>();
  let total: number | undefined;
  let priorPublished = "";
  for (let page = 0; page < maxPages; page++) {
    url.searchParams.set("start", String(items.length));
    const response = await arxivRequest(url.href, dependencies);
    if (/<!DOCTYPE|<!ENTITY/i.test(response.text) || XMLValidator.validate(response.text) !== true) throw new Error("arXiv returned invalid or unsafe XML");
    const feed = record(record(parser.parse(response.text) as unknown)?.["feed"]);
    if (!feed || feed["@_xmlns"] !== "http://www.w3.org/2005/Atom") throw new Error("arXiv response is not an Atom feed");
    const count = integer(feed["opensearch:totalResults"], "totalResults");
    const start = integer(feed["opensearch:startIndex"], "startIndex");
    const size = integer(feed["opensearch:itemsPerPage"], "itemsPerPage");
    if (start !== items.length || size !== perPage) throw new Error("arXiv response pagination does not match the request");
    if (total !== undefined && total !== count) throw new Error("arXiv result count changed during pagination");
    total = count;
    if (total > Math.min(MAX_SOURCE_ITEMS, perPage * maxPages)) throw new Error("arXiv result exceeds the complete acquisition limit; narrow the query");
    const entries = array(feed["entry"]);
    if (entries.length !== Math.min(perPage, total - start)) throw new Error("arXiv response is incomplete or exceeds its declared result count");
    for (const entry of entries) {
      const item = arxivItem(entry);
      if (identities.has(item.id)) throw new Error("arXiv pagination repeated an article identity");
      if (item.publishedAt! < priorPublished || Date.parse(item.publishedAt!) > upperTime) throw new Error("arXiv result violates the frozen submission order/bound");
      priorPublished = item.publishedAt!;
      identities.add(item.id);
      items.push(item);
    }
    assertSourceItemLimit(items.length);
    if (items.length === total) return finish(items, dependencies);
  }
  throw new Error("arXiv pagination reached its limit before complete acquisition");
}

async function arxivRequest(url: string, dependencies: ArxivDependencies) {
  const request = requests.then(async () => {
    const delay = 3_000 - (performance.now() - lastRequestAt);
    if (delay > 0) await (dependencies.sleep ?? setTimeout)(delay);
    lastRequestAt = performance.now();
    return fetchText(url, dependencies, undefined, "application/atom+xml");
  });
  // Hold the slot through body consumption; failed requests still own their rate-limit interval.
  requests = request.then(() => {}, () => {});
  return request;
}

function arxivItem(value: unknown): Item {
  const entry = record(value);
  const rawId = cleanText(entry?.["id"]);
  const identity = typeof rawId === "string" ? /^https?:\/\/arxiv\.org\/abs\/((?:[a-z][a-z0-9.-]*\/\d{7}|\d{4}\.\d{4,5}))(v[1-9]\d*)?$/i.exec(rawId) : null;
  if (!entry || !identity) throw new Error("arXiv entry lacks a valid article identity");
  const arxivId = identity[1]!.toLowerCase();
  const url = `https://arxiv.org/abs/${arxivId}${identity[2] ?? ""}`;
  const title = cleanText(entry["title"]);
  const abstract = cleanText(entry["summary"]);
  const publishedAt = timestamp(entry["published"]);
  const updatedAt = timestamp(entry["updated"]);
  if (!title || !abstract || !publishedAt || !updatedAt) throw new Error("arXiv entry lacks a title, abstract, or publication/update time");
  if (updatedAt < publishedAt) throw new Error("arXiv update time precedes publication");
  const authors = array(entry["author"]).map(value => cleanText(record(value)?.["name"]));
  if (authors.length === 0 || authors.some(name => !name)) throw new Error("arXiv entry lacks valid authors");
  const categories = array(entry["category"]).map(value => cleanText(record(value)?.["@_term"]));
  if (categories.some(name => !name)) throw new Error("arXiv category is malformed");
  const data: JsonObject = { arxivId, title, url, abstract, publishedAt, updatedAt, authors: authors as string[], categories: categories as string[] };
  for (const [xml, name] of [["arxiv:doi", "doi"], ["arxiv:journal_ref", "venue"], ["arxiv:comment", "comment"]] as const) {
    const text = cleanText(entry[xml]);
    if (text) data[name] = text;
  }
  return { id: `arxiv:${arxivId}`, title, url, publishedAt, data };
}

function integer(value: unknown, name: string): number {
  const text = typeof value === "string" ? value : record(value)?.["#text"];
  if (typeof text !== "string" || !/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`arXiv response lacks a valid ${name}`);
  return Number(text);
}

function timestamp(value: unknown): string {
  const text = cleanText(value);
  const match = text ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(text) : null;
  if (!text || !match) throw new Error("arXiv timestamp is malformed");
  const expected = `${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  if (normalizeDate(expected) !== expected) throw new Error("arXiv timestamp is invalid");
  return normalizeDate(text)!;
}
