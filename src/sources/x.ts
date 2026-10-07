import type { XSource } from "../config/schema.ts";
import type { CollectorContext } from "../core/engine.ts";
import type { ScanItem } from "../core/types.ts";
import { assertAllowedOrigin, checkedCall, createBrowserOsNeoClient, pageId, verifiedReadText, verifyTools } from "./browseros.ts";
import { finish, type BrowserOsMcpClient, type SourceDependencies } from "./types.ts";

const STATUS_LINK = /\[[^\]]*\]\(https:\/\/x\.com\/([A-Za-z0-9_]+)\/status\/(\d+)\)/g;

export async function collectX(source: XSource, dependencies: SourceDependencies, context?: CollectorContext) {
  const handle = source.handle.toLowerCase();
  assertAllowedOrigin("https://x.com/", dependencies.env);
  const client = await (dependencies.createBrowserOsClient ?? createBrowserOsNeoClient)(dependencies.fetch);
  let page: number | undefined;
  try {
    await verifyTools(client);
    await checkedCall(client, "tabs", { action: "list" });
    page = pageId(await checkedCall(client, "tabs", { action: "new", url: "about:blank" }));
    if (page === undefined) throw new Error("BrowserOS did not return a page id");
    const previous = new Map((context?.previousItems ?? []).map(item => [item.id, item]));
    const firstScanIds = (context?.bootstrapItemIds ?? []).flatMap(id => /^x:\d+$/.test(id) ? [BigInt(id.slice(2))] : []);
    const bootstrapCutoff = firstScanIds.length ? firstScanIds.reduce((maximum, id) => id > maximum ? id : maximum) : undefined;
    const found = new Map<string, ScanItem>();
    let boundary: bigint | undefined;
    let overlap = false;
    for (let index = 0; index < source.maxPages; index++) {
      const query = `from:${handle}${boundary === undefined ? "" : ` max_id:${boundary}`}`;
      const search = new URL("https://x.com/search");
      search.searchParams.set("q", query);
      search.searchParams.set("src", "typed_query");
      search.searchParams.set("f", "live");
      await checkedCall(client, "navigate", { action: "url", page, url: search.href });
      const timeline = await readReady(client, page, "main", text => text.includes("# Search timeline") && (timelineIds(text, handle).length > 0 || noResults(text)));
      const candidates = timelineIds(timeline, handle);
      const ids: string[] = [];
      for (const id of candidates) {
        const metadata = verifiedReadText(await checkedCall(client, "read", { page, format: "markdown", selector: `${selector(handle, id)} [data-testid="User-Name"]`, includeLinks: true }), "https://x.com");
        const primary = timelineIds(metadata, handle);
        if (metadata === "(empty)" || primary.length === 1 && primary[0] !== id) continue;
        if (primary.length !== 1 || primary[0] !== id) throw new Error("X primary post identity is incomplete");
        if (boundary === undefined || BigInt(id) <= boundary) ids.push(id);
      }
      if (ids.length === 0) {
        if (!noResults(timeline)) throw new Error("X pagination did not advance; coverage is incomplete");
        if (previous.size > 0) throw new Error("X coverage lacks an accepted overlap; baseline preserved");
        throw new Error("X search returned no posts; establish a nonempty baseline");
      }
      for (const id of ids) {
        const key = `x:${id}`;
        if (found.has(key)) continue;
        if (!previous.has(key) && bootstrapCutoff !== undefined && BigInt(id) <= bootstrapCutoff) continue;
        if (context?.newItemsOnly && previous.has(key)) {
          overlap = true;
          found.set(key, previous.get(key)!);
          continue;
        }
        const markdown = await readReady(client, page, selector(handle, id), text => [...text.matchAll(STATUS_LINK)].length > 0);
        const item = parseXPost(markdown, handle, id, true);
        if (previous.has(key)) overlap = true;
        found.set(key, item);
      }
      if (previous.size === 0 || overlap) break;
      const minimum = ids.reduce((a, id) => BigInt(id) < a ? BigInt(id) : a, BigInt(ids[0]!));
      if (boundary !== undefined && minimum >= boundary) throw new Error("X pagination stalled; coverage is incomplete");
      boundary = minimum - 1n;
      if (index + 1 === source.maxPages) throw new Error("X page limit reached before accepted overlap; coverage is incomplete");
    }
    for (const [key, item] of found) {
      if (context?.newItemsOnly && previous.has(key)) continue;
      // Keep the search snapshot open while each complete post loads in a separate, short-lived tab.
      const detailPage = pageId(await checkedCall(client, "tabs", { action: "new", url: item.url! }));
      if (detailPage === undefined) throw new Error("BrowserOS did not return a detail page id");
      try {
        const id = String(item.data["postId"]);
        let detail = await readReady(client, detailPage, "main", text => postIds(text, handle).includes(id));
        const full = await readReady(client, detailPage, selector(handle, id, true), text => postIds(text, handle).includes(id));
        const expansion = verifiedReadText(await checkedCall(client, "read", { page: detailPage, format: "text", selector: `${selector(handle, id, true)} [data-testid="tweet-text-show-more-link"]` }), "https://x.com");
        if (expansion && expansion !== "(empty)") throw new Error("X full post remains truncated");
        const parsed = parseXPost(full, handle, id);
        const own = verifiedReadText(await checkedCall(client, "read", { page: detailPage, format: "markdown", selector: `${selector(handle, id, true)} [data-testid="tweetText"]:not([role="link"] [data-testid="tweetText"])`, includeImages: true, includeLinks: true }), "https://x.com");
        const quoted = verifiedReadText(await checkedCall(client, "read", { page: detailPage, format: "markdown", selector: `${selector(handle, id, true)} [role="link"] [data-testid="tweetText"]`, includeImages: true, includeLinks: true }), "https://x.com");
        const quotedText = quoted === "(empty)" ? "" : quoted;
        if (quotedText) parsed.data["quotedText"] = quotedText;
        const prior = previous.get(key);
        const quoteStable = (prior?.data["quotedText"] ?? "") === quotedText && JSON.stringify(prior?.data["media"] ?? []) === JSON.stringify(parsed.data["media"] ?? []);
        const oldQuote = previous.get(key)?.data["quotedContext"];
        if (own && own !== "(empty)") {
          const whole = String(parsed.data["text"]);
          parsed.data["text"] = own;
          if (whole !== own) parsed.data["quotedContext"] = quoteStable && typeof oldQuote === "string" ? oldQuote : whole.startsWith(own) ? whole.slice(own.length) : whole;
        } else if (quoteStable && typeof oldQuote === "string") {
          parsed.data["text"] = previous.get(key)!.data["text"]!;
          parsed.data["quotedContext"] = oldQuote;
        } else if (String(parsed.data["text"]).includes("Quote")) {
          parsed.data["quotedContext"] = parsed.data["text"]!;
        }
        delete parsed.data["snippet"];
        parsed.title = `@${handle}: ${String(parsed.data["text"]).replace(/\s+/g, " ").slice(0, 160)}`;
        const frozen = previous.get(key)?.data["context"];
        if (typeof frozen === "string") parsed.data["context"] = frozen;
        else {
          const prefix = full.slice(0, analyticsMarker(full, handle, id)!.index);
          if (!detail.includes(prefix)) detail = await readReady(client, detailPage, "main", text => text.includes(prefix));
          const position = detail.indexOf(prefix);
          if (position < 0) throw new Error("X parent context attribution is incomplete");
          const parent = detail.slice(detail.indexOf("# Post") >= 0 ? detail.indexOf("# Post") + 6 : 0, position).replace(/^# Conversation\s*/, "").trim();
          if (parent) {
            if (parent.length > 20_000) throw new Error("X parent conversation exceeds the context limit");
            parsed.data["context"] = parent;
          }
        }
        found.set(key, parsed);
      } finally {
        try { await checkedCall(client, "tabs", { action: "close", page: detailPage }); } catch { /* Acquisition outcome owns the error. */ }
      }
    }
    return finish([...found.values()], dependencies);
  } finally {
    if (page !== undefined) {
      try { await checkedCall(client, "tabs", { action: "close", page }); } catch { /* Acquisition outcome owns the error. */ }
    }
    await client.close();
  }
}

function selector(handle: string, id: string, detail = false): string {
  return `article[data-testid="tweet"]:has(${detail ? "" : '[data-testid="User-Name"] '}a[href="/${handle}/status/${id}" i])`;
}

export function timelineIds(text: string, handle: string): string[] {
  const pattern = new RegExp(`\\[@${handle}\\]\\(https://x\\.com/${handle}\\)\\[[^\\]]*\\]\\(https://x\\.com/${handle}/status/(\\d+)\\)`, "ig");
  return [...new Set([...text.matchAll(pattern)].map(match => match[1]!))];
}

function postIds(text: string, handle: string): string[] {
  return [...new Set([...text.matchAll(STATUS_LINK)].filter(match => match[1]!.toLowerCase() === handle).map(match => match[2]!))];
}

function primaryHeader(text: string, handle: string, id: string): string | undefined {
  const profile = `https://x.com/${handle.toLowerCase()}`;
  if (!text.toLowerCase().includes(`](${profile}/status/${id})`)) return undefined;
  let offset = 0;
  // Read leading profile links rather than treating nested avatar/name brackets as the author boundary.
  while (text[offset] === "[") {
    const start = offset++;
    let depth = 1;
    while (offset < text.length && depth > 0) {
      if (text[offset] === "\\") { offset += 2; continue; }
      if (text[offset] === "[") depth++;
      if (text[offset] === "]") depth--;
      offset++;
    }
    if (depth || text[offset] !== "(") return undefined;
    const closing = text.indexOf(")", offset);
    if (closing < 0 || text.slice(offset + 1, closing).toLowerCase() !== profile) return undefined;
    const label = text.slice(start + 1, offset - 1);
    offset = closing + 1;
    if (label.toLowerCase() === `@${handle.toLowerCase()}`) return text.slice(0, offset);
    while (/\s/.test(text[offset] ?? "")) offset++;
  }
  return undefined;
}

function analyticsMarker(text: string, handle: string, id: string): RegExpExecArray | null {
  return new RegExp(`\\[[^\\]]*\\]\\(https://x\\.com/${handle}/status/${id}/analytics\\)`, "i").exec(text);
}

export function parseXPost(markdown: string, handle: string, id: string, allowTruncated = false): ScanItem {
  if (!allowTruncated && /\[Show more\]\(/i.test(markdown)) throw new Error("X full post remains truncated");
  const header = primaryHeader(markdown, handle, id);
  if (!header) throw new Error("X post author/identity could not be verified");
  const analytics = analyticsMarker(markdown, handle, id);
  if (!analytics) throw new Error("X post lacks its completion marker");
  const timestamp = new RegExp(`\\[[^\\]]*\\]\\(https://x\\.com/${handle}/status/${id}\\)`, "i");
  const text = markdown.slice(header.length, analytics.index).replace(timestamp, "").trim();
  if (!text) throw new Error("X post has no accessible text or media description");
  const url = `https://x.com/${handle}/status/${id}`;
  const media = [...text.matchAll(/!\[[^\]]*\]\((https:\/\/pbs\.twimg\.com\/media\/[^\s)]+)\)/g)].map(match => match[1]!);
  return { id: `x:${id}`, url, title: `@${handle}: ${text.replace(/\s+/g, " ").slice(0, 160)}`,
    publishedAt: new Date(Number((BigInt(id) >> 22n) + 1288834974657n)).toISOString(),
    data: { author: handle, postId: id, url, text, snippet: text, ...(media.length ? { media } : {}) } };
}

function noResults(text: string): boolean { return /No results for|No results found/i.test(text); }

async function readReady(client: BrowserOsMcpClient, page: number, selector: string, ready: (text: string) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await checkedCall(client, "read", { page, format: "markdown", selector, includeImages: true, includeLinks: true, viewportOnly: false });
    const text = verifiedReadText(result, "https://x.com");
    if (/Something went wrong|Rate limit exceeded|Sign in to X|Log in to X|Verify you are human|Account suspended/i.test(text)) throw new Error("X login/rate-limit/error page; acquisition is incomplete");
    if (ready(text)) return text;
    if (attempt + 1 < 12) await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("X timeline/post did not load completely");
}
