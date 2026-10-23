import { load } from "cheerio";

import type { Sel4NewsSource } from "../config/sel4.ts";
import { fetchText } from "./http.ts";
import { assertSourceItemLimit, finish, type Item, type SourceDependencies } from "./types.ts";

const ORIGIN = "https://sel4.systems";
const INDEX = `${ORIGIN}/news/index.html`;
const MAX_ARCHIVE_PAGES = 256;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

type Page = { year: number; years: number[]; items: Item[] };

export async function collectSel4News(_source: Sel4NewsSource, dependencies: SourceDependencies) {
  const current = await readPage(INDEX, dependencies);
  if (current.years.some(year => year > current.year)) throw new Error("seL4 current navigation lists a newer archive");
  const items = [...current.items];
  for (const year of current.years.filter(value => value !== current.year)) {
    const page = await readPage(`${ORIGIN}/news/${year}.html`, dependencies);
    if (page.year !== year) throw new Error("seL4 archive year does not match its requested URL");
    if (page.years.join() !== current.years.join()) throw new Error("seL4 archive navigation changed during traversal");
    items.push(...page.items);
    assertSourceItemLimit(items.length);
  }
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("seL4 news has duplicate item identities");
  return finish(items, dependencies);
}

async function readPage(url: string, dependencies: SourceDependencies): Promise<Page> {
  const response = await fetchText(url, dependencies, undefined, "text/html, application/xhtml+xml;q=0.9");
  if (response.url !== url) throw new Error("seL4 news source redirected from its fixed archive URL");
  if (Buffer.byteLength(response.text, "utf8") > MAX_PAGE_BYTES) throw new Error("seL4 news page exceeded its byte limit");
  const $ = load(response.text, { sourceCodeLocationInfo: true });
  const main = $("main");
  const navigation = main.find("nav");
  if (main.length !== 1 || main.find("h1").text().trim() !== "seL4 News" || navigation.length !== 1) {
    throw new Error("seL4 news lacks its complete page/navigation structure");
  }
  requireExplicitEnd(main.get(0), response.text, "main");
  requireExplicitEnd(navigation.get(0), response.text, "navigation");
  if (navigation.children().not("a,span").length !== 0 || navigation.find("a").length !== navigation.children("a").length) {
    throw new Error("seL4 archive navigation has an unsupported structure");
  }
  const selected = navigation.children("span");
  if (selected.length !== 1 || !/^\d{4}$/.test(selected.text().trim())) throw new Error("seL4 navigation lacks one selected year");
  requireExplicitEnd(selected.get(0), response.text, "selected year");
  const year = Number(selected.text().trim());
  const years = [year];
  for (const anchor of navigation.children("a").toArray()) {
    const link = $(anchor);
    requireExplicitEnd(anchor, response.text, "archive link");
    const match = /^\/news\/(\d{4})\.html$/.exec(link.attr("href") ?? "");
    if (!match?.[1] || link.text().trim() !== match[1]) throw new Error("seL4 navigation has an invalid archive link");
    years.push(Number(match[1]));
  }
  if (years.length > MAX_ARCHIVE_PAGES) throw new Error("seL4 news exceeded its archive page limit");
  if (new Set(years).size !== years.length) throw new Error("seL4 navigation has duplicate archive years");
  years.sort((left, right) => left - right);

  const articles = main.find("article").toArray();
  assertSourceItemLimit(articles.length);
  if (articles.length === 0) throw new Error("seL4 news archive has no articles");
  const anchors = new Set<string>();
  const items = articles.map(node => {
    const article = $(node);
    requireExplicitEnd(node, response.text, "article");
    const heading = article.children("h2");
    const title = heading.text().trim();
    if (heading.length !== 1 || !title) throw new Error("seL4 news article lacks one nonempty title");
    requireExplicitEnd(heading.get(0), response.text, "article title");
    const articleBody = article.children("div.theprose");
    if (articleBody.length !== 1) throw new Error("seL4 news article lacks one complete nonempty body");
    requireExplicitEnd(articleBody.get(0), response.text, "article body");
    const body = articleBody.clone();
    body.find("script,style,template").remove();
    const metadata = article.children("a").filter((_, element) => $(element).children("time").length > 0);
    const time = metadata.children("time");
    const date = time.attr("datetime") ?? "";
    const publishedAt = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : undefined;
    if (metadata.length !== 1 || time.length !== 1 || !publishedAt || !Number.isFinite(publishedAt.getTime()) || publishedAt.toISOString().slice(0, 10) !== date || publishedAt.getUTCFullYear() !== year) {
      throw new Error("seL4 news article date does not match its archive year");
    }
    requireExplicitEnd(metadata.get(0), response.text, "article date link");
    requireExplicitEnd(time.get(0), response.text, "article date");
    const anchor = time.attr("id");
    if (!anchor || /[\u0000-\u0020\u007f]/.test(anchor) || metadata.attr("href") !== `#${anchor}`) throw new Error("seL4 news article lacks a matching publisher anchor");
    if (anchors.has(anchor)) throw new Error("seL4 news archive has duplicate article anchors");
    anchors.add(anchor);
    // The current-year alias reuses anchors; the publisher's year archive owns their stable namespace.
    const itemUrl = new URL(`/news/${year}.html#${anchor}`, ORIGIN).href;
    const links = new Set<string>();
    for (const link of body.find("a[href]").toArray()) {
      const target = inertHttpUrl($(link).attr("href"), itemUrl);
      if (target) links.add(target);
    }
    const media = body.find("img[src]").toArray().flatMap(image => {
      const target = inertHttpUrl($(image).attr("src"), itemUrl);
      return target ? [{ type: "image" as const, url: target, alt: $(image).attr("alt") ?? "" }] : [];
    });
    const summary = body.text().trim() || media.map(image => image.alt.trim() || `Image: ${image.url}`).join("\n");
    if (!summary) throw new Error("seL4 news article lacks one complete nonempty body");
    const published = publishedAt.toISOString();
    return { id: `url:${itemUrl}`, url: itemUrl, title, publishedAt: published, data: { title, url: itemUrl, publishedAt: published, summary, links: [...links], media } };
  });
  return { year, years, items };
}

function requireExplicitEnd(node: unknown, html: string, label: string): void {
  const element = node as { name: string; sourceCodeLocation?: { startTag?: { endOffset: number }; endTag?: { startOffset: number; endOffset: number } } } | undefined;
  const location = element?.sourceCodeLocation;
  const end = location?.endTag;
  const token = end ? html.slice(end.startOffset, end.endOffset) : "";
  const closingName = token.startsWith("</") && token.endsWith(">") ? token.slice(2, -1).trim().toLowerCase() : undefined;
  if (!location?.startTag || !end || location.startTag.endOffset > end.startOffset || closingName !== element?.name) {
    throw new Error(`seL4 news has an incomplete or unclosed ${label}`);
  }
}

function inertHttpUrl(value: string | undefined, base: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value, base);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return url.href;
  } catch {
    // References are inert observations; malformed or non-web references never cause retrieval.
  }
  return undefined;
}
