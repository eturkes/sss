import { load } from "cheerio";

import type { JsonObject } from "../core/types.ts";
import { fetchText } from "./http.ts";
import { canonicalUrl, coerce, normalizeDate, setPath, stableItemId, stringAt } from "./normalize.ts";
import { assertSourceItemLimit, finish, type HtmlSource, type Item, type SourceDependencies } from "./types.ts";

type HtmlFieldSpec = {
  selector?: string;
  attribute?: string;
  type?: "string" | "number" | "integer" | "boolean" | "money";
  currency?: string;
};

export async function collectHtml(source: HtmlSource, dependencies: SourceDependencies) {
  const response = await fetchText(source.url, dependencies, source.headers, "text/html, application/xhtml+xml;q=0.9");
  const $ = load(response.text);
  let nodes;
  try {
    nodes = source.itemSelector
      ? $(source.itemSelector).toArray()
      : [$("body").get(0) ?? $.root().get(0)].filter((node) => node !== undefined);
  } catch {
    throw new Error("invalid HTML item selector");
  }
  assertSourceItemLimit(nodes.length);

  const items = nodes.map((node) => {
    const root = $(node);
    const data: JsonObject = {};
    for (const [target, spec] of Object.entries(source.fields as Record<string, HtmlFieldSpec>)) {
      let element = root;
      try {
        if (spec.selector) element = root.is(spec.selector) ? root.first() : root.find(spec.selector).first();
      } catch {
        throw new Error(`invalid HTML selector for field ${target}`);
      }
      if (element.length === 0) throw new Error(`HTML selector for field ${target} matched nothing`);
      const raw = spec.attribute ? element.attr(spec.attribute) : element.text();
      if (raw === undefined) throw new Error(`HTML field ${target} is missing attribute ${spec.attribute}`);
      let value = raw === undefined ? null : coerce(raw, spec.type, spec.currency);
      if (typeof value === "string" && (spec.attribute === "href" || spec.attribute === "src" || /(?:^|\.)(?:url|link|href)$/.test(target))) {
        value = canonicalUrl(value, response.url) ?? value;
      }
      setPath(data, target, value);
    }
    return htmlItem(data, response.url, source.itemSelector === undefined);
  });
  return finish(items, dependencies);
}

function htmlItem(data: JsonObject, baseUrl: string, singleton: boolean): Item {
  const title = stringAt(data, "title", "name");
  const url = canonicalUrl(stringAt(data, "url", "link", "href"), baseUrl);
  const publishedAt = normalizeDate(stringAt(data, "publishedAt", "published", "date"));
  let id = stableItemId({
    doi: stringAt(data, "doi"),
    arxiv: stringAt(data, "arxivId", "arxiv"),
    url,
    explicit: stringAt(data, "id", "identifier"),
    fallback: data,
  });
  if (id.startsWith("sha256:")) {
    if (!singleton) throw new Error("HTML list item lacks a stable identity field");
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

export type { HtmlFieldSpec };
